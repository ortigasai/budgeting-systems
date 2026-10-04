"""Tests for the GAE past-years workbook import (app/import_gae_past.py).

Uses a small in-memory workbook and a fake database session, so nothing here
touches the real database.
"""

import io

import openpyxl
import pytest

from app.import_gae_past import _year_month, run_gae_past_import
from app.models_sap_raw import SapGaePastActualRaw, SapKssbV2Raw


class FakeSession:
    """Records what the import asks for, without a database."""

    def __init__(self):
        self.statements = []
        self.added = []
        self.committed = False

    def exec(self, statement):
        self.statements.append(statement)

    def add_all(self, rows):
        self.added.extend(rows)

    def commit(self):
        self.committed = True


def make_workbook(header, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(header)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return openpyxl.load_workbook(buf, read_only=True, data_only=True)


BASE_HEADER = ["Source", "Remarks", "PC", "GL"]


def test_year_month_reads_actual_and_budget_headers():
    assert _year_month("2022-01") == ("actual", 2022, 1)
    assert _year_month(" 2023A-02 ") == ("actual", 2023, 2)
    assert _year_month("2024B-12") == ("budget", 2024, 12)
    assert _year_month("2024F-03") is None
    assert _year_month("Total") is None


def test_rejects_a_workbook_without_pc_and_gl_columns():
    wb = make_workbook(["Source", "Remarks", "Cost Center", "Account", "2022-01"], [])
    with pytest.raises(ValueError, match="PC"):
        run_gae_past_import(wb, FakeSession(), "bad.xlsx", 2026)


def test_current_year_columns_are_skipped():
    header = BASE_HEADER + ["2025A-01", "2026A-01", "2026B-01"]
    wb = make_workbook(header, [["GAE", "x", 80111201, 61731102, 100, 999, 50]])
    session = FakeSession()
    summary = run_gae_past_import(wb, session, "w.xlsx", 2026)

    assert summary["skippedCurrentYearColumns"] == 2
    assert all(row.fiscal_year < 2026 for row in session.added)
    assert {row.fiscal_year for row in session.added if isinstance(row, SapGaePastActualRaw)} == {2025}


def test_repeated_month_is_counted_once():
    # 2023A-01 appears twice with the same value, as in the real workbook.
    header = BASE_HEADER + ["2023A-01", "2023A-01"]
    wb = make_workbook(header, [["GAE", "x", 80111201, 61731102, 10, 10]])
    session = FakeSession()
    summary = run_gae_past_import(wb, session, "w.xlsx", 2026)

    actuals = [r for r in session.added if isinstance(r, SapGaePastActualRaw)]
    assert len(actuals) == 1
    assert actuals[0].amount == 10
    assert summary["skippedRepeatedColumns"] == 1


def test_actuals_and_budgets_are_summed_per_cost_center_gl_and_month():
    header = BASE_HEADER + ["2022-01", "2022-02", "2023B-01"]
    rows = [
        ["GAE", "x", 80111201, 61731102, 100, 200, 5],
        ["GAE", "x", 80111201, 61731102, 50, 0, 7],  # same key again - should add up
        ["GAE", "x", 80314101, 61731102, 0, 0, 0],  # all zero - no row written
    ]
    wb = make_workbook(header, rows)
    session = FakeSession()
    run_gae_past_import(wb, session, "w.xlsx", 2026)

    actuals = {(r.cost_center, r.gl_account, r.fiscal_year, r.month): r.amount for r in session.added if isinstance(r, SapGaePastActualRaw)}
    budgets = {(r.cost_center, r.gl_account, r.fiscal_year, r.month): r.plan for r in session.added if isinstance(r, SapKssbV2Raw)}

    assert actuals == {("80111201", "61731102", 2022, 1): 150, ("80111201", "61731102", 2022, 2): 200}
    assert budgets == {("80111201", "61731102", 2023, 1): 12}


def test_rows_with_blank_or_non_numeric_codes_are_skipped():
    header = BASE_HEADER + ["2022-01"]
    rows = [
        [None, "x", None, None, 100],
        ["GAE", "x", "n/a", "x", 100],
        ["GAE", "x", 80111201, 61731102, 25],
    ]
    wb = make_workbook(header, rows)
    session = FakeSession()
    run_gae_past_import(wb, session, "w.xlsx", 2026)

    actuals = [r for r in session.added if isinstance(r, SapGaePastActualRaw)]
    assert [(r.cost_center, r.amount) for r in actuals] == [("80111201", 25)]


def test_upload_replaces_only_the_years_in_the_file_and_commits():
    header = BASE_HEADER + ["2022-01"]
    wb = make_workbook(header, [["GAE", "x", 80111201, 61731102, 100]])
    session = FakeSession()
    run_gae_past_import(wb, session, "w.xlsx", 2026)

    assert session.committed is True
    # Two deletes: one for the actual years, one for the budget years (none here).
    assert len(session.statements) == 2
