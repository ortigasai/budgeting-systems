"""Access check for the Admin Console's GAE past-years upload.

Calls the real FastAPI routes with the current user and the database session
replaced, so the role check is exercised without a database.
"""

import io

import openpyxl
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth import AuthedRole, AuthedUser, get_current_user
from app.db import get_session
from app.routers.gae_past_import import router


class FakeSession:
    def exec(self, statement):
        return _Result()

    def add_all(self, rows):
        pass

    def commit(self):
        pass


class _Result:
    def all(self):
        return []

    def first(self):
        return None


def make_user(roles):
    return AuthedUser(id="u1", name="Test User", email="test@example.com", departmentId=None, roles=roles)


def make_client(user):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_session] = lambda: FakeSession()
    return TestClient(app)


def small_workbook_bytes():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Source", "Remarks", "PC", "GL", "2022-01"])
    ws.append(["GAE", "x", 80111201, 61731102, 100])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_status_is_forbidden_without_budget_officer_role():
    client = make_client(make_user(roles=[AuthedRole(roleType="CFO", departmentId="d1")]))
    response = client.get("/admin/gae-past/status", params={"currentYear": 2026})
    assert response.status_code == 403


def test_upload_is_forbidden_without_budget_officer_role():
    client = make_client(make_user(roles=[]))
    response = client.post(
        "/admin/gae-past/upload",
        files={"file": ("w.xlsx", small_workbook_bytes(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        data={"currentYear": "2026"},
    )
    assert response.status_code == 403


def test_upload_is_allowed_for_budget_officer():
    client = make_client(make_user(roles=[AuthedRole(roleType="BUDGET_OFFICER", departmentId="d1")]))
    response = client.post(
        "/admin/gae-past/upload",
        files={"file": ("w.xlsx", small_workbook_bytes(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        data={"currentYear": "2026"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["actualYears"]["2022"]["rows"] == 1


def test_upload_rejects_a_file_that_is_not_a_workbook():
    client = make_client(make_user(roles=[AuthedRole(roleType="BUDGET_OFFICER", departmentId="d1")]))
    response = client.post(
        "/admin/gae-past/upload",
        files={"file": ("w.xlsx", b"not an excel file", "application/octet-stream")},
        data={"currentYear": "2026"},
    )
    assert response.status_code == 400
