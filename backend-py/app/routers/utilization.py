"""Budget Utilization Tracking (Functional Spec §4). View A (FR-2.2) is the
per-department/GL-CC Approved/Actual/Commitments/Available rollup; View B
(FR-2.3-2.6) is the per-expense-line-item reconciliation against mock SAP
actuals, plus the Unmapped SAP Actuals exception queue.

Response models use camelCase field names (not idiomatic Python) to match
the rest of this app's API surface - the frontend consumes one JSON
convention across both backends.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, select

from ..auth import AuthedUser, get_current_user, require_role
from ..db import enum_eq, get_session
from ..models_sap_raw import SapKssbV2Raw, SapSalrRaw
from ..models_phase1 import BudgetRequest, Department, ExpenseLineItem, FinalizedBudgetLine, UserGroupMembership
from ..models_phase2 import SapActualTransaction, SapCommitment
from ..models_phase3 import CostCenter, GlAccount, InternalOrderRequest
from ..models_npc_monitoring import NpcMonitoringIo, NpcMonitoringProject
from ..npc_sbu import NPC_GROUP_SCOPE_TO_SBU, NPC_SBU_LABELS
from ..services.sap_sync_service import get_sync_status, start_sync_in_background

router = APIRouter(prefix="/utilization", tags=["utilization"])

# Same list as backend/src/lib/coreDepartments.ts's CORE_CENTRALIZED_DEPARTMENT_NAMES
# - the "real", budget-cap-tracked centralized departments, not every
# CENTRALIZED-typed Department row (most of those are employee-roster
# bookkeeping noise). Keep in sync with the TS source if it changes.
CORE_CENTRALIZED_DEPARTMENT_NAMES = [
    "Admin Services",
    "Corporate Finance",
    "External Affairs",
    "Human Resources",
    "IS & IT",
    "Legal",
    "Office of the CFO",
    "Tax",
]

OPEN_COMMITMENT_STATUSES = ["OPEN", "APPROVED_PR"]

# The three role types this codebase names as "centralized department"
# roles (see RoleSwitcher.tsx's ROLE_LABELS: Centralized Department
# Preparer/Reviewer/Approver). Utilization Tracking is open to all of them,
# not just Preparers/Heads as FR-2.1 originally stated - widened per request.
CENTRALIZED_ROLE_TYPES = ("CENTRALIZED_BUDGET_PREPARER", "CENTRALIZED_DEPARTMENT_HEAD", "CENTRALIZED_FIRST_LEVEL_REVIEWER")


class DepartmentOut(BaseModel):
    id: str
    name: str


class OverviewRow(BaseModel):
    glAccount: str
    costCenter: str
    glAccountName: str | None = None
    costCenterName: str | None = None
    approvedBudget: float
    actualExpenditures: float
    commitments: float
    totalAllotted: float
    available: float


class ReconciliationRow(BaseModel):
    # None for a DOE row (see below) - DOE has no Expense Line Item catalog,
    # just a raw GL-CC pair, so there's no id to carry and nothing to "Map
    # to" (its SAP actuals are already matched by GL-CC directly, not by a
    # Budget Code or manual mapping).
    expenseLineItemId: str | None
    expenseLineItemName: str
    glAccount: str | None = None
    costCenter: str | None = None
    approvedBudget: float
    sapActual: float
    statusText: str


class UnmappedRow(BaseModel):
    id: int
    itemText: str
    amount: float
    glAccount: str
    costCenter: str
    postedAt: datetime


class LineItemOut(BaseModel):
    id: str
    name: str


class ReconciliationOut(BaseModel):
    rows: list[ReconciliationRow]
    unmapped: list[UnmappedRow]
    # This department's expense line items, for the Budget Officer's "map to"
    # picker on an unmapped row - saves the frontend a second cross-backend
    # call to Node's catalog endpoint.
    lineItems: list[LineItemOut]


class MapUnmappedIn(BaseModel):
    expenseLineItemId: str


class NpcSbuOut(BaseModel):
    value: str
    label: str


class NpcIoDetail(BaseModel):
    """One row's worth of per-IO figures - a Budget Code can fund more than
    one Internal Order, and the frontend shows each one on its own line
    (not lumped into a single summed figure) - see NpcForecastView.tsx.
    """

    aufnr: str
    description: str
    budget: float
    # None when no live/imported Actual exists yet for this specific IO -
    # same "unknown, not zero" semantics as NpcUtilizationRow.actual below.
    actual: float | None = None


class NpcUtilizationRow(BaseModel):
    budgetCode: str
    projectTitle: str
    amount: float  # NPC's approved amount (VAT exclusive), net of any budget cut
    location: str | None
    # The Monitoring tab's Group for this budget code's IOs (distinct values
    # joined with ", ") - shown in the NPC table in place of location.
    group: str | None = None
    sbu: str
    # A budget code can fund more than one Internal Order Request, so this is
    # a list rather than a single value - each entry is that IO's SAP
    # document number (blank until BUDGET_OFFICER_SAP_UPLOAD - see
    # routers/internal_orders.py), joined for display on the frontend.
    ioCodes: list[str]
    # Per-IO breakdown backing ioCodes above - same list, but with each IO's
    # own description/budget/actual instead of only the summed totals below.
    ios: list[NpcIoDetail] = []
    ioAmount: float
    balance: float  # amount - ioAmount
    # Live SAP Actual, summed across this budget code's IOs - only populated
    # when sourced from the NPC Monitoring import (models_npc_monitoring.py);
    # None for the live-workflow path below, which still gets its own Actual
    # via a direct SALR broker pull (see npcForecastService.ts on the Node
    # side) rather than through this field.
    actual: float | None = None
    # True only for a standalone "Carry-over" IO row (no Budget Code, no
    # NPC-approved project behind it - see
    # _npc_utilization_from_monitoring_import). amount is set equal to
    # ioAmount for these (there's no real NPC budget ask to show instead),
    # so balance nets to 0 rather than reading as a fabricated deficit.
    isCarryOver: bool = False


def _is_utilization_eligible(user: AuthedUser) -> bool:
    """Open to all centralized department roles (Preparer, Head, Reviewer),
    plus the Budget Officer, matching this app's existing pattern of
    Budget-Officer-always-has-oversight (e.g. Forecast's own eligibility
    rule) - FR-2.6 explicitly gives the Budget Officer an action on this same
    dashboard, which only makes sense if they can also see it.
    """
    legacy = user.has_role("BUDGET_OFFICER") or any(r.roleType in CENTRALIZED_ROLE_TYPES for r in user.roles)
    # Group-based access (User Management workbook): a grouped user is
    # eligible if their groups grant any Module 2 page.
    return legacy or any(user.can(k, False) for k in ("util.overview", "util.reconciliation", "util.npc"))


def _require_utilization_access(user: AuthedUser = Depends(get_current_user)) -> AuthedUser:
    if not _is_utilization_eligible(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have access to Budget Utilization Tracking.")
    return user


def _utilization_department_names(session: Session) -> list[str]:
    """Departments Utilization can show: the fixed core list plus every
    department the CC-GL workbook assigns cost centers to (Corporate
    Marketing, Procurement, Internal Audit, ...), under the core list's own
    spelling where the two differ.
    """
    names = set(CORE_CENTRALIZED_DEPARTMENT_NAMES)
    for dept in session.exec(select(CostCenter.department).where(CostCenter.department != None).distinct()).all():  # noqa: E711
        names.add(CC_DEPARTMENT_ALIASES.get(dept, dept))
    return sorted(names)


SBU_SCOPE_PREFIX = "SBU:"
ALL_SCOPE_ID = "ALL"


def _sf_sbus(user: AuthedUser) -> list[str]:
    """SBUs (uppercase, e.g. MALLS) an SBU Finance member's SF memberships name."""
    return list(dict.fromkeys(scope.upper() for g, scope in user.groups if g == "SF" and scope))


def _sbu_cost_center_codes(session: Session, sbu: str) -> set[str]:
    """Cost centers the CC-GL workbook maps to this SBU."""
    return {c.code for c in session.exec(select(CostCenter).where(CostCenter.sbu == sbu)).all()}


def _scope_from_id(user: AuthedUser, scope_id: str, session: Session):
    """Resolves the Overview/Reconciliation scope id: "ALL" (every department
    this user can already view, combined), a core department id, or
    "SBU:<CODE>" for an SBU Finance member's own SBU (all cost centers
    mapped to it, across departments). Returns (name, cost center codes, the
    ExpenseLineItem condition for that scope).
    """
    if scope_id == ALL_SCOPE_ID:
        viewable_ids = _viewable_department_ids(user, session)
        if not viewable_ids:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have access to any department's utilization data.")
        if _is_bca(user):
            # BCA's "All" means every real SAP cost center (the full CC-GL
            # master, per user direction), not just the ones the CC-GL
            # workbook has tagged to one of the ~12 "core" department names -
            # most of the company's 546 cost centers have no such tag, so the
            # per-department-name lookup below would otherwise silently drop
            # them even though BCA can now see every Department row.
            ccs = {c.code for c in session.exec(select(CostCenter)).all()}
        else:
            dept_names = {d.name for d in session.exec(select(Department).where(Department.id.in_(viewable_ids))).all()}
            ccs = set()
            for name in dept_names:
                ccs |= _department_cost_center_codes(session, name)
        return "All Departments", ccs, ExpenseLineItem.ownerDepartmentId.in_(viewable_ids)
    if scope_id.startswith(SBU_SCOPE_PREFIX):
        sbu = scope_id[len(SBU_SCOPE_PREFIX) :].upper()
        if not user.has_role("BUDGET_OFFICER") and not (user.can("util.overview", False) and sbu in _sf_sbus(user)):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have access to this SBU's utilization data.")
        ccs = _sbu_cost_center_codes(session, sbu)
        return sbu.title(), ccs, ExpenseLineItem.costCenter.in_(ccs or {""})
    dept = _assert_department_access(user, scope_id, session)
    return dept.name, _department_cost_center_codes(session, dept.name), ExpenseLineItem.ownerDepartmentId == dept.id


# The User Management workbook's CD scope names -> the core department list's
# names (same map as backend/src/lib/forecastDepartments.ts).
CD_SCOPE_TO_CORE_DEPARTMENT = {
    "Administrative Services": "Admin Services",
    "Corporate Finance": "Corporate Finance",
    "Tax": "Tax",
    "Legal": "Legal",
    "Office of the CFO": "Office of the CFO",
    "Human Resources": "Human Resources",
    "External Affairs": "External Affairs",
    "Information System & Information Technology": "IS & IT",
}


def _is_bca(user: AuthedUser) -> bool:
    return any(g == "BCA" for g, _ in user.groups)


def _viewable_department_ids(user: AuthedUser, session: Session) -> set[str]:
    """Core departments whose utilization this user may view: everything for
    the Budget Officer; literally every department in the system for BCA
    (per user direction - BCA isn't limited to the CC-GL-mapped "core"
    departments like Budget Officer is, since most of the other 72 have no
    Expense Line Item catalog, so their Overview/Reconciliation will simply
    read empty until the CC-GL master is extended to them); otherwise their
    centralized roles' departments, plus - for group members granted
    Departmental Overview/Live Reconciliation - the departments their CD
    memberships name, or every core department for SBU Finance/Mancom
    members (no department of their own to be scoped to).
    """
    if _is_bca(user):
        return {d.id for d in session.exec(select(Department)).all()}
    core = session.exec(select(Department).where(Department.name.in_(_utilization_department_names(session)))).all()
    if user.has_role("BUDGET_OFFICER"):
        return {d.id for d in core}
    ids = {r.departmentId for r in user.roles if r.roleType in CENTRALIZED_ROLE_TYPES and r.departmentId}
    if user.access is not None and (user.can("util.overview", False) or user.can("util.reconciliation", False)):
        cd_names = {CD_SCOPE_TO_CORE_DEPARTMENT.get(sc, CC_DEPARTMENT_ALIASES.get(sc, sc)) for g, sc in user.groups if g == "CD" and sc}
        if cd_names:
            ids |= {d.id for d in core if d.name in cd_names}
        elif any(g == "MC" for g, _ in user.groups):
            ids |= {d.id for d in core}
    return ids


def _assert_department_access(user: AuthedUser, department_id: str, session: Session) -> Department:
    dept = session.get(Department, department_id)
    if dept is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Department not found.")
    if not _is_bca(user) and dept.name not in _utilization_department_names(session):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Department not found.")
    if department_id in _viewable_department_ids(user, session):
        return dept
    raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have access to this department's utilization data.")


@router.get("/departments", response_model=list[DepartmentOut])
def list_departments(
    user: AuthedUser = Depends(_require_utilization_access),
    session: Session = Depends(get_session),
):
    pool = (
        session.exec(select(Department).order_by(Department.name)).all()
        if _is_bca(user)
        else session.exec(select(Department).where(Department.name.in_(_utilization_department_names(session))).order_by(Department.name)).all()
    )
    viewable = _viewable_department_ids(user, session)
    eligible = [d for d in pool if d.id in viewable]
    out = [DepartmentOut(id=d.id, name=d.name) for d in eligible]
    # SBU Finance members see their own SBU (every cost center mapped to it),
    # not a department.
    if user.has_role("BUDGET_OFFICER") is False and (user.can("util.overview", False) or user.can("util.reconciliation", False)):
        out += [DepartmentOut(id=f"{SBU_SCOPE_PREFIX}{sbu}", name=f"{sbu.title()} (SBU)") for sbu in _sf_sbus(user)]
    return out


def _approved_budget_by_gl_cc(session: Session, department_id: str, fiscal_year: int, cond=None) -> dict[tuple[str, str], float]:
    """Sum(FinalizedBudgetLine.amount) for this department's catalog, grouped
    by (glAccount, costCenter) - Note 11: reads the finalized/uploaded budget
    snapshot instead of live-joining BudgetRequest+ExpenseLineItem by
    currentStage=APPROVED (the snapshot is written once, at Budget Officer
    finalize time, so this is no longer computed fresh from request status).
    Still joined through BudgetRequest/ExpenseLineItem (via the snapshot's
    informational budgetRequestId) only to resolve which catalog department
    owns each line - not for the amount itself.
    """
    rows = session.exec(
        select(FinalizedBudgetLine, ExpenseLineItem)
        .join(BudgetRequest, FinalizedBudgetLine.budgetRequestId == BudgetRequest.id)
        .join(ExpenseLineItem, BudgetRequest.expenseLineItemId == ExpenseLineItem.id)
        .where(
            cond if cond is not None else ExpenseLineItem.ownerDepartmentId == department_id,
            FinalizedBudgetLine.fiscalYear == fiscal_year,
        )
    ).all()
    totals: dict[tuple[str, str], float] = {}
    for line, _ in rows:
        key = (line.glAccount, line.costCenter)
        totals[key] = totals.get(key, 0.0) + line.amount
    return totals


def _approved_budget_by_line_item(session: Session, department_id: str, fiscal_year: int, cond=None) -> dict[str, float]:
    rows = session.exec(
        select(FinalizedBudgetLine, ExpenseLineItem)
        .join(BudgetRequest, FinalizedBudgetLine.budgetRequestId == BudgetRequest.id)
        .join(ExpenseLineItem, BudgetRequest.expenseLineItemId == ExpenseLineItem.id)
        .where(
            cond if cond is not None else ExpenseLineItem.ownerDepartmentId == department_id,
            FinalizedBudgetLine.fiscalYear == fiscal_year,
        )
    ).all()
    totals: dict[str, float] = {}
    for line, line_item in rows:
        totals[line_item.id] = totals.get(line_item.id, 0.0) + line.amount
    return totals


def _utc_iso(dt: datetime | None) -> str | None:
    """Every datetime this app stores is written via datetime.utcnow() -
    naive, no tzinfo (Postgres' own TIMESTAMP WITHOUT TIME ZONE column type
    strips any tzinfo on the way in regardless, so there's no fix at the
    storage layer). A naive .isoformat() therefore produces a string with
    no UTC marker ("2026-09-17T00:20:53" instead of "...+00:00") - a
    browser parsing that via `new Date(...)` reads it as ITS OWN local
    time, not UTC, which (confirmed live from a UTC+8 browser reading the
    Admin Console's SAP Sync Status tab) showed a 3-minute-old sync as
    having happened 8 hours ago. This stamps the UTC offset back on at the
    one point it actually reaches JSON.
    """
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).isoformat()


class SapSyncStartOut(BaseModel):
    status: str  # "started"


class SapSyncStatusOut(BaseModel):
    status: str  # "idle" | "running" | "success" | "error"
    fiscalYear: int
    startedAt: str | None
    finishedAt: str | None
    # Only ever set by a successful run - stays put through a later failed
    # attempt, so the UI can keep showing "last synced at <x>" even right
    # after `status`/`error` above flip to a failed attempt's outcome.
    lastSuccessAt: str | None = None
    actualsSynced: int | None = None
    commitmentsSynced: int | None = None
    error: str | None = None


@router.post("/sync-sap", response_model=SapSyncStartOut, status_code=status.HTTP_202_ACCEPTED)
def sync_sap_route(
    fiscalYear: int,
    user: AuthedUser = Depends(require_role("BUDGET_OFFICER")),
):
    """Real-SAP-data replacement for app/seed_mock_sap.py's manual CLI seed -
    see services/sap_sync_service.py. Populates SapActualTransaction (from
    FBL3N) and SapCommitment (from KSSB V2's Commitment field) for
    `fiscalYear`; Overview, Reconciliation, Transfer's balance check, Dash
    Flow's budget check, and Reports' Budget vs Actual all read those tables
    live and pick up the synced figures once it finishes.

    This now also runs automatically every 10 minutes (see main.py's startup
    hook) - this route is for an on-demand refresh (e.g. right after a known
    SAP update), not the only way the data ever changes anymore. A full sync
    easily takes several minutes (hundreds of paginated broker requests,
    deliberately paced under the broker's own rate limit) - too long to run
    inline on this request without sitting past IIS/ARR's reverse-proxy
    timeout, so this only starts the sync in the background and returns
    immediately. Poll GET /sync-sap/status for the result.
    """
    started = start_sync_in_background(fiscalYear)
    if not started:
        raise HTTPException(status.HTTP_409_CONFLICT, "A SAP sync is already in progress.")
    return SapSyncStartOut(status="started")


@router.get("/sync-sap/status", response_model=SapSyncStatusOut)
def sync_sap_status_route(fiscalYear: int, user: AuthedUser = Depends(_require_utilization_access)):
    row = get_sync_status(fiscalYear)
    if row is None:
        return SapSyncStatusOut(status="idle", fiscalYear=fiscalYear, startedAt=None, finishedAt=None)
    return SapSyncStatusOut(
        status=row.status,
        fiscalYear=row.fiscal_year,
        startedAt=_utc_iso(row.started_at),
        finishedAt=_utc_iso(row.finished_at),
        lastSuccessAt=_utc_iso(row.last_success_at),
        actualsSynced=row.actuals_synced,
        commitmentsSynced=row.commitments_synced,
        error=row.error,
    )


# Department names as the CC-GL workbook spells them -> the core department
# list's names.
CC_DEPARTMENT_ALIASES = {
    "Administrative Services": "Admin Services",
    "Legal Department": "Legal",
    "Information System & Information Technology": "IS & IT",
}


def _department_cost_center_codes(session: Session, dept_name: str) -> set[str]:
    """Cost center codes the CC-GL workbook assigns to this (core) department."""
    codes = set()
    for cc in session.exec(select(CostCenter).where(CostCenter.department != None)).all():  # noqa: E711
        if CC_DEPARTMENT_ALIASES.get(cc.department, cc.department) == dept_name:
            codes.add(cc.code)
    return codes


@router.get("/overview", response_model=list[OverviewRow])
def overview(
    departmentId: str,
    fiscalYear: int,
    user: AuthedUser = Depends(_require_utilization_access),
    session: Session = Depends(get_session),
):
    _, dept_ccs, scope_cond = _scope_from_id(user, departmentId, session)
    finalized = _approved_budget_by_gl_cc(session, departmentId, fiscalYear, scope_cond)

    # Every Cost Center the CC-GL workbook maps to this department, with SAP's
    # own approved budget (KSSB V2 Plan, summed over the year's periods) per
    # GL-CC - the approved budget shown here. A GL-CC with no SAP plan falls
    # back to whatever finalized budget this app holds for it.
    plan_totals: dict[tuple[str, str], float] = {}
    if dept_ccs:
        for gl, cc, total in session.exec(
            select(SapKssbV2Raw.gl_account, SapKssbV2Raw.cost_center, func.sum(SapKssbV2Raw.plan))
            .where(SapKssbV2Raw.fiscal_year == fiscalYear, SapKssbV2Raw.cost_center.in_(dept_ccs))
            .group_by(SapKssbV2Raw.gl_account, SapKssbV2Raw.cost_center)
        ).all():
            plan_totals[(gl, cc)] = float(total or 0)
    approved = dict(finalized)
    for key, plan in plan_totals.items():
        if plan != 0:
            approved[key] = plan

    actuals = session.exec(
        select(SapActualTransaction).where(SapActualTransaction.fiscal_year == fiscalYear)
    ).all()
    commitments = session.exec(
        select(SapCommitment).where(SapCommitment.fiscal_year == fiscalYear)
    ).all()

    actual_totals: dict[tuple[str, str], float] = {}
    for a in actuals:
        if a.cost_center not in dept_ccs and (a.gl_account, a.cost_center) not in approved:
            continue
        key = (a.gl_account, a.cost_center)
        actual_totals[key] = actual_totals.get(key, 0.0) + a.amount
    commitment_totals: dict[tuple[str, str], float] = {}
    for c in commitments:
        if c.status not in OPEN_COMMITMENT_STATUSES:
            continue
        if c.cost_center not in dept_ccs and (c.gl_account, c.cost_center) not in approved:
            continue
        key = (c.gl_account, c.cost_center)
        commitment_totals[key] = commitment_totals.get(key, 0.0) + c.amount

    # Rows: every GL-CC with an approved budget, or with any actual/commitment
    # posted against one of the department's own cost centers.
    gl_cc_keys = set(approved.keys()) | {k for k, v in actual_totals.items() if v} | {k for k, v in commitment_totals.items() if v}
    gl_names = {g.code: g.name for g in session.exec(select(GlAccount)).all()}
    cc_names = {c.code: c.name for c in session.exec(select(CostCenter)).all()}

    rows: list[OverviewRow] = []
    for gl_account, cost_center in sorted(gl_cc_keys):
        approved_amount = approved.get((gl_account, cost_center), 0.0)
        actual_amount = actual_totals.get((gl_account, cost_center), 0.0)
        commitment_amount = commitment_totals.get((gl_account, cost_center), 0.0)
        total_allotted = actual_amount + commitment_amount
        rows.append(
            OverviewRow(
                glAccount=gl_account,
                costCenter=cost_center,
                glAccountName=gl_names.get(gl_account),
                costCenterName=cc_names.get(cost_center),
                approvedBudget=round(approved_amount, 2),
                actualExpenditures=round(actual_amount, 2),
                commitments=round(commitment_amount, 2),
                totalAllotted=round(total_allotted, 2),
                available=round(approved_amount - total_allotted, 2),
            )
        )
    return rows


@router.get("/overview/export")
def overview_export(
    departmentId: str,
    fiscalYear: int,
    user: AuthedUser = Depends(_require_utilization_access),
    session: Session = Depends(get_session),
):
    """The Overview table (whole scope, unfiltered) as an .xlsx download."""
    from io import BytesIO

    from fastapi.responses import Response
    from openpyxl import Workbook
    from openpyxl.styles import Font

    rows = overview(departmentId=departmentId, fiscalYear=fiscalYear, user=user, session=session)
    scope_name, _, _ = _scope_from_id(user, departmentId, session)
    wb = Workbook()
    ws = wb.active
    ws.title = "Overview"
    ws.append(["GL Account", "Cost Center", "GL Account Name", "Cost Center Name", "Approved Budget", "Actual Expenditures", "Commitments", "Total Allotted", "Available"])
    for r in rows:
        ws.append([r.glAccount, r.costCenter, r.glAccountName or "", r.costCenterName or "", r.approvedBudget, r.actualExpenditures, r.commitments, r.totalAllotted, r.available])
    ws.append([])
    ws.append(["Total", None, None, None] + [sum(getattr(r, f) for r in rows) for f in ("approvedBudget", "actualExpenditures", "commitments", "totalAllotted", "available")])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)
    for i, w in enumerate([14, 14, 40, 30, 18, 20, 16, 16, 16]):
        ws.column_dimensions[chr(65 + i)].width = w
    for col in "EFGHI":
        for c in ws[col][1:]:
            c.number_format = "#,##0.00"
    ws.freeze_panes = "A2"
    buf = BytesIO()
    wb.save(buf)
    safe = "".join(ch if ch.isalnum() else "-" for ch in scope_name).strip("-").lower()
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="utilization-overview-{safe}-{fiscalYear}.xlsx"'},
    )


def _reconciliation_status_text(approved_amount: float, actual_amount: float) -> str:
    if actual_amount <= 0:
        return "No Activity"
    if actual_amount >= approved_amount:
        return "Fully Utilized"
    return f"Partially Utilized ({round(actual_amount / approved_amount * 100)}%)"


@router.get("/reconciliation", response_model=ReconciliationOut)
def reconciliation(
    departmentId: str,
    fiscalYear: int,
    user: AuthedUser = Depends(_require_utilization_access),
    session: Session = Depends(get_session),
):
    # Temporary kill-switch (see accessControl.ts's util.reconciliationEnabled
    # row) - blocks the actual data, not just the frontend tab, until the
    # Budget Officer says to lift it. legacy=False: an ungrouped user gets no
    # benefit of the doubt here either.
    if not user.can("util.reconciliationEnabled", False):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Live Reconciliation is temporarily unavailable.")

    _, dept_ccs, scope_cond = _scope_from_id(user, departmentId, session)

    line_items = session.exec(select(ExpenseLineItem).where(scope_cond)).all()
    line_items_by_id = {li.id: li for li in line_items}
    dept_gl_cc = {(li.glAccount, li.costCenter) for li in line_items}
    # GAE's Budget Code is on the catalog item itself.
    line_item_id_by_budget_code = {li.budgetCode: li.id for li in line_items if li.budgetCode}
    # DOE/NPC's Budget Code is per-request instead (generated at creation,
    # not pre-computed on the catalog item) - resolve it through this
    # department's own approved requests for the year.
    doe_npc_requests = session.exec(
        select(BudgetRequest)
        .join(ExpenseLineItem, BudgetRequest.expenseLineItemId == ExpenseLineItem.id)
        .where(
            scope_cond,
            BudgetRequest.fiscalYear == fiscalYear,
            BudgetRequest.budgetCode.is_not(None),
        )
    ).all()
    line_item_id_by_request_budget_code = {r.budgetCode: r.expenseLineItemId for r in doe_npc_requests}

    approved_by_item = _approved_budget_by_line_item(session, departmentId, fiscalYear, scope_cond)

    # DOE (this module's own "GAE & DOE" scope, see the Operating Expenses
    # sidebar label) has no Expense Line Item catalog - its BudgetRequests
    # carry a raw Cost Center + GL Account pair directly instead (see
    # BudgetRequest.expenseLineItemId's own schema comment). FinalizedBudgetLine
    # already denormalizes glAccount/costCenter onto itself (Note 11), so DOE
    # is reconciled by GL-CC pair here, the same way Overview already does,
    # rather than through the GAE-only expenseLineItemId path above. Same
    # SAP Plan fallback as overview()'s own `approved` dict too, for a GL-CC
    # whose Plan figure is nonzero but has no FinalizedBudgetLine snapshot
    # yet this cycle.
    doe_approved: dict[tuple[str, str], float] = {}
    if dept_ccs:
        for line in session.exec(
            select(FinalizedBudgetLine).where(
                FinalizedBudgetLine.fiscalYear == fiscalYear,
                enum_eq(FinalizedBudgetLine.requestCategory, "DOE"),
                FinalizedBudgetLine.costCenter.in_(dept_ccs),
            )
        ).all():
            key = (line.glAccount, line.costCenter)
            doe_approved[key] = doe_approved.get(key, 0.0) + line.amount
        for gl, cc, total in session.exec(
            select(SapKssbV2Raw.gl_account, SapKssbV2Raw.cost_center, func.sum(SapKssbV2Raw.plan))
            .where(SapKssbV2Raw.fiscal_year == fiscalYear, SapKssbV2Raw.cost_center.in_(dept_ccs))
            .group_by(SapKssbV2Raw.gl_account, SapKssbV2Raw.cost_center)
        ).all():
            # Skip anything already a GAE catalog item (dept_gl_cc, computed
            # above) - this fallback is for DOE's own GL-CC pairs only, not a
            # second copy of rows the catalog loop already covers.
            if (gl, cc) in dept_gl_cc:
                continue
            plan = float(total or 0)
            if plan != 0:
                doe_approved[(gl, cc)] = plan

    actuals = session.exec(
        select(SapActualTransaction).where(SapActualTransaction.fiscal_year == fiscalYear)
    ).all()

    matched_by_item: dict[str, float] = {}
    doe_actual_totals: dict[tuple[str, str], float] = {}
    unmapped: list[UnmappedRow] = []
    for a in actuals:
        # Budget Code (GL-CC + code) is the primary match now - what SAP PR
        # creators/accounting staff will actually post against. A manually
        # mapped expense_line_item_id (Budget Officer's "Map to" action on a
        # previously-unmapped row) still takes effect as a fallback so that
        # override path keeps working even without a Budget Code.
        target_id = (
            line_item_id_by_budget_code.get(a.budget_code)
            or line_item_id_by_request_budget_code.get(a.budget_code)
            or a.expense_line_item_id
        )
        if target_id and target_id in line_items_by_id:
            matched_by_item[target_id] = matched_by_item.get(target_id, 0.0) + a.amount
            continue
        doe_key = (a.gl_account, a.cost_center)
        if doe_key in doe_approved:
            doe_actual_totals[doe_key] = doe_actual_totals.get(doe_key, 0.0) + a.amount
        elif target_id is None and (a.gl_account, a.cost_center) in dept_gl_cc:
            unmapped.append(
                UnmappedRow(
                    id=a.id,
                    itemText=a.item_text,
                    amount=a.amount,
                    glAccount=a.gl_account,
                    costCenter=a.cost_center,
                    postedAt=a.posted_at,
                )
            )

    rows: list[ReconciliationRow] = []
    for li in sorted(line_items, key=lambda x: x.name):
        approved_amount = approved_by_item.get(li.id, 0.0)
        actual_amount = matched_by_item.get(li.id, 0.0)
        if approved_amount <= 0:
            continue  # nothing approved this cycle - not part of the reconciliation view
        rows.append(
            ReconciliationRow(
                expenseLineItemId=li.id,
                expenseLineItemName=li.name,
                approvedBudget=round(approved_amount, 2),
                sapActual=round(actual_amount, 2),
                statusText=_reconciliation_status_text(approved_amount, actual_amount),
            )
        )

    gl_names = {g.code: g.name for g in session.exec(select(GlAccount)).all()}
    cc_names = {c.code: c.name for c in session.exec(select(CostCenter)).all()}
    for (gl, cc), approved_amount in sorted(doe_approved.items()):
        if approved_amount <= 0:
            continue
        actual_amount = doe_actual_totals.get((gl, cc), 0.0)
        rows.append(
            ReconciliationRow(
                expenseLineItemId=None,
                expenseLineItemName=f"{gl_names.get(gl, gl)} — {cc_names.get(cc, cc)}",
                glAccount=gl,
                costCenter=cc,
                approvedBudget=round(approved_amount, 2),
                sapActual=round(actual_amount, 2),
                statusText=_reconciliation_status_text(approved_amount, actual_amount),
            )
        )

    return ReconciliationOut(
        rows=rows,
        unmapped=unmapped,
        lineItems=[LineItemOut(id=li.id, name=li.name) for li in sorted(line_items, key=lambda x: x.name)],
    )


@router.patch("/reconciliation/unmapped/{transaction_id}", response_model=UnmappedRow)
def map_unmapped(
    transaction_id: int,
    body: MapUnmappedIn,
    user: AuthedUser = Depends(require_role("BUDGET_OFFICER")),
    session: Session = Depends(get_session),
):
    txn = session.get(SapActualTransaction, transaction_id)
    if txn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transaction not found.")
    line_item = session.get(ExpenseLineItem, body.expenseLineItemId)
    if line_item is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Expense line item not found.")

    txn.expense_line_item_id = line_item.id
    session.add(txn)
    session.commit()
    session.refresh(txn)

    return UnmappedRow(
        id=txn.id,
        itemText=txn.item_text,
        amount=txn.amount,
        glAccount=txn.gl_account,
        costCenter=txn.cost_center,
        postedAt=txn.posted_at,
    )


# ---- NPC Utilization (spec item 13) ----
# Only counts IOs actually committed against an NPC budget - a DRAFT/
# IN_REVIEW/RETURNED IO hasn't cleared review yet, so it shouldn't reduce the
# NPC balance shown here (mirrors this app's existing convention of only
# counting APPROVED BudgetRequests as consuming budget).
ACTIVE_IO_STATUSES = ["APPROVED", "UPLOADED_TO_SAP"]


def _my_department(user: AuthedUser, session: Session) -> Department | None:
    return session.get(Department, user.departmentId) if user.departmentId else None


def _my_npc_sbus(user: AuthedUser, session: Session) -> list[str]:
    """The NPC SBUs this person may see: their NPC-group memberships (User
    Management workbook, scope e.g. "Corporate - HR") if any, otherwise their
    own department's Department.sbu.
    """
    scopes = session.exec(select(UserGroupMembership.scope).where(UserGroupMembership.userId == user.id, UserGroupMembership.group == "NPC")).all()
    sbus = [NPC_GROUP_SCOPE_TO_SBU[s] for s in scopes if s in NPC_GROUP_SCOPE_TO_SBU]
    if sbus:
        return list(dict.fromkeys(sbus))
    dept = _my_department(user, session)
    return [dept.sbu] if dept is not None and dept.sbu else []


def _resolve_npc_sbu_scope(user: AuthedUser, requested_sbu: str | None, session: Session) -> str:
    """Budget Officer may pick any SBU; everyone else is limited to their own
    NPC SBU(s) (spec: "users can only view the NPC approved for the SBU they
    belong to") - same shape as _assert_department_access above, just keyed
    by SBU instead of department id.
    """
    if user.has_role("BUDGET_OFFICER"):
        if not requested_sbu:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "sbu is required.")
        if requested_sbu not in NPC_SBU_LABELS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unrecognized SBU.")
        return requested_sbu
    if not user.can("util.npc", True):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your access group does not permit Utilization - NPC.")
    mine = _my_npc_sbus(user, session)
    if not mine:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You have no NPC SBU assigned - ask the Budget Officer to add you to an NPC SBU group or set your department's SBU in the Admin Console.")
    if requested_sbu and requested_sbu in mine:
        return requested_sbu
    return mine[0]


@router.get("/npc/sbus", response_model=list[NpcSbuOut])
def npc_sbu_options(
    user: AuthedUser = Depends(_require_utilization_access),
    session: Session = Depends(get_session),
):
    if user.has_role("BUDGET_OFFICER"):
        return [NpcSbuOut(value=v, label=l) for v, l in NPC_SBU_LABELS.items()]
    return [NpcSbuOut(value=v, label=NPC_SBU_LABELS.get(v, v)) for v in _my_npc_sbus(user, session)]


class NpcIoDetailOut(BaseModel):
    aufnr: str
    description: str | None
    budgetCode: str | None
    sbu: str | None
    # Live SAP (S_ALR_87013019, local cache) figures - null if this IO isn't in the cache.
    sapBudget: float | None
    sapActual: float | None
    sapCommitted: float | None
    sapAllotted: float | None
    sapAvailable: float | None
    # NPC Monitoring workbook figures, when the IO came from that import.
    monitoringBudget: float | None
    monitoringActual: float | None
    monitoringCommitted: float | None
    monitoringAvailable: float | None
    ytdActualByMonth: dict | None
    # The Internal Order Request that created it in this app, if any.
    requestProjectTitle: str | None
    requestLocation: str | None
    requestProjectStart: str | None
    requestProjectEnd: str | None
    requestAmount: float | None
    requestStatus: str | None
    requestCostCenter: str | None


def _short_aufnr(code: str) -> str:
    """Drop the 12-digit AUFNR's leading "0000" padding, for display/export only."""
    return code[4:] if code.startswith("0000") else code


def _build_io_detail(aufnr: str, fiscal_year: int, user: AuthedUser, session: Session) -> NpcIoDetailOut:
    """Details of one Internal Order for the NPC table's clickable IO Code.
    Scoped like the table itself: the Budget Officer sees any IO, everyone
    else only IOs belonging to one of their own NPC SBUs.
    """
    fiscalYear = fiscal_year
    stripped = aufnr.lstrip("0") or "0"
    mon = next(
        (r for r in session.exec(select(NpcMonitoringIo).where(NpcMonitoringIo.fiscal_year == fiscalYear)).all() if (r.aufnr.lstrip("0") or "0") == stripped),
        None,
    )
    salr = next(
        (r for r in session.exec(select(SapSalrRaw).where(SapSalrRaw.fiscal_year == fiscalYear)).all() if (r.aufnr.lstrip("0") or "0") == stripped),
        None,
    )
    req = next(
        (r for r in session.exec(select(InternalOrderRequest).where(InternalOrderRequest.fiscal_year == fiscalYear)).all() if r.sap_document_number and (r.sap_document_number.lstrip("0") or "0") == stripped),
        None,
    )
    sbu = mon.npc_sbu if mon else (req.sbu if req else None)
    if mon is None and req is None and salr is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Internal Order not found.")
    if not user.has_role("BUDGET_OFFICER") and sbu not in _my_npc_sbus(user, session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This Internal Order is outside your NPC SBU.")
    return NpcIoDetailOut(
        aufnr=(mon.aufnr if mon else salr.aufnr if salr else aufnr),
        description=mon.io_description if mon else (req.project_title if req else None),
        budgetCode=mon.budget_code if mon else (req.npc_budget_code if req else None),
        sbu=sbu,
        sapBudget=salr.budget if salr else None,
        sapActual=salr.actual if salr else None,
        sapCommitted=salr.committed if salr else None,
        sapAllotted=salr.allotted if salr else None,
        sapAvailable=salr.available if salr else None,
        monitoringBudget=mon.budget if mon else None,
        monitoringActual=mon.actual if mon else None,
        monitoringCommitted=mon.committed if mon else None,
        monitoringAvailable=mon.available if mon else None,
        ytdActualByMonth=mon.ytd_actual_by_month if mon else None,
        requestProjectTitle=req.project_title if req else None,
        requestLocation=req.location if req else None,
        requestProjectStart=req.project_start.date().isoformat() if req else None,
        requestProjectEnd=req.project_end.date().isoformat() if req else None,
        requestAmount=req.amount if req else None,
        requestStatus=req.status if req else None,
        requestCostCenter=req.cost_center if req else None,
    )


@router.get("/npc/io/{aufnr}", response_model=NpcIoDetailOut)
def npc_io_detail(
    aufnr: str,
    fiscalYear: int,
    user: AuthedUser = Depends(_require_utilization_access),
    session: Session = Depends(get_session),
):
    return _build_io_detail(aufnr, fiscalYear, user, session)


@router.get("/npc/io/{aufnr}/export")
def npc_io_export(
    aufnr: str,
    fiscalYear: int,
    user: AuthedUser = Depends(_require_utilization_access),
    session: Session = Depends(get_session),
):
    """The same details the IO pop-up shows, as an .xlsx download."""
    from io import BytesIO

    from fastapi.responses import Response
    from openpyxl import Workbook
    from openpyxl.styles import Font

    d = _build_io_detail(aufnr, fiscalYear, user, session)
    wb = Workbook()
    ws = wb.active
    ws.title = "Internal Order"
    rows = [
        ("Internal Order", _short_aufnr(d.aufnr)),
        ("Description", d.description or ""),
        ("Budget Code", d.budgetCode or ""),
        ("NPC SBU", d.sbu or ""),
        (None, None),
        ("SAP figures (S_ALR_87013019)", None),
        ("Budget", d.sapBudget),
        ("Actual", d.sapActual),
        ("Commitment", d.sapCommitted),
        ("Allotted", d.sapAllotted),
        ("Available", d.sapAvailable),
    ]
    for label, value in rows:
        ws.append([label, value])
    for cell in ws["A"]:
        cell.font = Font(bold=True)
    for r in range(7, 12):
        ws.cell(row=r, column=2).number_format = "#,##0.00"
    ws.column_dimensions["A"].width = 30
    ws.column_dimensions["B"].width = 40
    buf = BytesIO()
    wb.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="io-{_short_aufnr(d.aufnr)}.xlsx"'},
    )


def _effective_actual(io: NpcMonitoringIo, as_of_month: int | None) -> float:
    """IO Actual as of the Budget Officer's own "YTD Actual through" month
    (NPC Forecast's own cutoff, independent of GAE/DOE's - see
    fiscalCycle.ts's npcAsOfMonth) - prefers that month's own entry in
    ytd_actual_by_month (the Monitoring tab's "YTD Forecast" block; despite
    the name, its value for an already-elapsed month matches this row's
    single `actual` figure exactly, per the field's own docstring), falling
    back to `actual` when there's no month selected or no data for it.
    """
    if as_of_month is not None and io.ytd_actual_by_month:
        value = io.ytd_actual_by_month.get(str(as_of_month))
        if value is not None:
            return value
    return io.actual


def _io_sap_figures(
    io: NpcMonitoringIo, salr_by_aufnr: dict[str, SapSalrRaw], as_of_month: int | None
) -> tuple[float, float]:
    """(budget, actual) for one IO from SAP's S_ALR_87013019 cache. Falls back
    to the Monitoring workbook's own figures only for an IO the cache doesn't
    have yet, so it still shows up in the table instead of as zeros.
    """
    row = salr_by_aufnr.get(io.aufnr.lstrip("0") or "0")
    if row is not None:
        return row.budget, row.actual
    return io.budget, _effective_actual(io, as_of_month)


def _npc_utilization_from_monitoring_import(
    session: Session, fiscal_year: int, effective_sbu: str, as_of_month: int | None
) -> list[NpcUtilizationRow] | None:
    """The temporary 2026-only path (see models_npc_monitoring.py) - real
    NPC Budget/IO Budget/IO Actual imported from the user's own NPC
    Monitoring workbook, used only for whatever fiscal year(s) an import
    actually covers. Returns None (not an empty list) when nothing's been
    imported for this fiscal year, so the caller can tell "no import for
    this year - use the live workflow tables" apart from "imported, but
    genuinely zero rows for this SBU".
    """
    projects = session.exec(
        select(NpcMonitoringProject).where(
            NpcMonitoringProject.fiscal_year == fiscal_year,
            NpcMonitoringProject.npc_sbu == effective_sbu,
        )
    ).all()
    ios = session.exec(
        select(NpcMonitoringIo).where(
            NpcMonitoringIo.fiscal_year == fiscal_year,
            NpcMonitoringIo.npc_sbu == effective_sbu,
        )
    ).all()
    # An SBU can have imported IOs but no Budget-Code project at all (e.g.
    # Corporate Admin: the workbook has no Budget Code for it, only a
    # code-less IO) - those still surface as Carry-over rows below, instead
    # of falling through to the live-workflow tables and showing nothing.
    if not projects and not ios:
        return None
    ios_by_budget_code: dict[str, list[NpcMonitoringIo]] = {}
    for io in ios:
        if io.budget_code:
            ios_by_budget_code.setdefault(io.budget_code, []).append(io)

    # IO Budget and Actual come from SAP's S_ALR_87013019 cache (see
    # _io_sap_figures), keyed by AUFNR with leading zeros dropped.
    salr_by_aufnr = {(r.aufnr.lstrip("0") or "0"): r for r in session.exec(select(SapSalrRaw).where(SapSalrRaw.fiscal_year == fiscal_year)).all()}
    figures = {io.aufnr: _io_sap_figures(io, salr_by_aufnr, as_of_month) for io in ios}

    rows: list[NpcUtilizationRow] = []
    for project in projects:
        matched = ios_by_budget_code.get(project.budget_code, [])
        io_amount = sum(figures[io.aufnr][0] for io in matched)
        io_actual = sum(figures[io.aufnr][1] for io in matched) if matched else None
        rows.append(
            NpcUtilizationRow(
                budgetCode=project.budget_code,
                projectTitle=project.project_title,
                amount=round(project.revised_amount, 2),
                location=None,
                group=", ".join(sorted({io.group_name for io in matched if io.group_name})) or None,
                sbu=project.npc_sbu,
                # AUFNRs, not sap_document_number values - the live-workflow
                # path's ioCodes are IO document numbers for the same
                # display purpose (a list the frontend just joins/shows).
                ioCodes=sorted(io.aufnr for io in matched),
                ios=[
                    NpcIoDetail(aufnr=io.aufnr, description=io.io_description, budget=round(figures[io.aufnr][0], 2), actual=round(figures[io.aufnr][1], 2))
                    for io in sorted(matched, key=lambda io: io.aufnr)
                ],
                ioAmount=round(io_amount, 2),
                balance=round(project.revised_amount - io_amount, 2),
                actual=round(io_actual, 2) if io_actual is not None else None,
            )
        )
    rows.sort(key=lambda r: r.budgetCode)

    # "Carry-over" rows - one per IO that either (a) has a blank Budget
    # Source Code in the Monitoring tab (a prior-cycle project with no
    # current-year Budget Code), or (b) still has its own numeric-code
    # "Carryover" line in an SBU tab (carry_over_revised_amount is set)
    # even though the Monitoring tab has since linked that same AUFNR to a
    # real Budget Code. (b) means a handful of IOs are deliberately double-
    # counted - once here, once under their real project's own row below -
    # because the source workbook's own SBU tab total does exactly that
    # (confirmed against AUFNR 10001296: still listed as a PHP 48,435.32
    # "Carryover" line in the Malls tab, i.e. not yet reconciled away there,
    # even though the Monitoring tab now attributes it to JLC-2026B-NPC003)
    # - matching that total exactly (per the user's explicit request) takes
    # priority over de-duplicating what the source file itself hasn't.
    # Each becomes its own standalone row instead of being dropped -
    # appended after every real project row, per the user's request.
    # budgetCode there is a stable per-IO placeholder (unique, so it still
    # works as a React key/sort key on the frontend), not a real Budget
    # Code. amount (NPC Budget) prefers carry_over_revised_amount - that
    # IO's own SBU-tab row's Revised (Amount - Cut) figure, computed the
    # same way as every other project's NPC Budget - falling back to the
    # IO's own live SAP budget only when no SBU tab has a matching row for
    # it. ioAmount/balance keep using the live SAP budget regardless (the
    # same NPC-Budget-can-differ-from-IO-Budget relationship every other
    # project row already has), so balance is a real npcBudget minus
    # ioBudget delta instead of hardcoded to 0 once the two can differ.
    carry_over_rows = [
        NpcUtilizationRow(
            budgetCode=f"Carry-over ({_short_aufnr(io.aufnr)})",
            projectTitle=io.io_description,
            amount=round(io.carry_over_revised_amount if io.carry_over_revised_amount is not None else figures[io.aufnr][0], 2),
            location=None,
            group=io.group_name,
            sbu=io.npc_sbu,
            ioCodes=[io.aufnr],
            ios=[NpcIoDetail(aufnr=io.aufnr, description=io.io_description, budget=round(figures[io.aufnr][0], 2), actual=round(figures[io.aufnr][1], 2))],
            ioAmount=round(figures[io.aufnr][0], 2),
            balance=round((io.carry_over_revised_amount if io.carry_over_revised_amount is not None else figures[io.aufnr][0]) - figures[io.aufnr][0], 2),
            actual=round(figures[io.aufnr][1], 2),
            isCarryOver=True,
        )
        for io in ios
        if io.budget_code is None or io.carry_over_revised_amount is not None
    ]
    carry_over_rows.sort(key=lambda r: r.ioCodes[0])

    return rows + carry_over_rows


@router.get("/npc/export")
def npc_utilization_export(
    fiscalYear: int,
    sbu: str | None = None,
    user: AuthedUser = Depends(_require_utilization_access),
    session: Session = Depends(get_session),
):
    """The whole NPC Utilization table (same rows, same SBU scoping) as an
    .xlsx download, plus a second sheet with one row per Internal Order.
    """
    from io import BytesIO

    from fastapi.responses import Response
    from openpyxl import Workbook
    from openpyxl.styles import Font

    rows = npc_utilization(fiscalYear=fiscalYear, sbu=sbu, asOfMonth=None, user=user, session=session)
    effective_sbu = _resolve_npc_sbu_scope(user, sbu, session)

    wb = Workbook()
    ws = wb.active
    ws.title = "NPC Utilization"
    ws.append(["Budget Code", "Project Title", "Amount (VAT excl.)", "Group", "SBU", "IO Code", "IO Amount", "Balance"])
    for r in rows:
        ws.append([r.budgetCode, r.projectTitle, r.amount, r.group or "", r.sbu, ", ".join(_short_aufnr(c) for c in r.ioCodes), r.ioAmount, r.balance])
    ws.append([])
    ws.append(["Total", None, sum(r.amount for r in rows), None, None, None, sum(r.ioAmount for r in rows), sum(r.balance for r in rows)])

    ios = wb.create_sheet("IO Details")
    ios.append(["Budget Code", "Project Title", "IO Code", "IO Description", "IO Budget", "IO Actual", "Commitment", "Allotted", "Available"])
    salr_by_aufnr = {(r.aufnr.lstrip("0") or "0"): r for r in session.exec(select(SapSalrRaw).where(SapSalrRaw.fiscal_year == fiscalYear)).all()}
    for r in rows:
        for io in r.ios:
            salr = salr_by_aufnr.get(io.aufnr.lstrip("0") or "0")
            ios.append([
                r.budgetCode, r.projectTitle, _short_aufnr(io.aufnr), io.description, io.budget, io.actual,
                salr.committed if salr else None, salr.allotted if salr else None, salr.available if salr else None,
            ])

    for sheet, money_cols, widths in ((ws, "CGH", [18, 40, 20, 14, 18, 40, 16, 16]), (ios, "EFGHI", [18, 40, 16, 40, 16, 16, 16, 16, 16])):
        for cell in sheet[1]:
            cell.font = Font(bold=True)
        for i, w in enumerate(widths):
            sheet.column_dimensions[chr(65 + i)].width = w
        for col in money_cols:
            for c in sheet[col][1:]:
                c.number_format = "#,##0.00"
    for c in ws[ws.max_row]:
        c.font = Font(bold=True)

    buf = BytesIO()
    wb.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="npc-utilization-{effective_sbu.lower()}-{fiscalYear}.xlsx"'},
    )


@router.get("/npc", response_model=list[NpcUtilizationRow])
def npc_utilization(
    fiscalYear: int,
    sbu: str | None = None,
    # NPC Forecast's own "YTD Actual through" cutoff (independent of
    # GAE/DOE's) - only meaningful for the monitoring-import path below,
    # which is the only source with a monthly Actual breakdown.
    asOfMonth: int | None = None,
    user: AuthedUser = Depends(_require_utilization_access),
    session: Session = Depends(get_session),
):
    effective_sbu = _resolve_npc_sbu_scope(user, sbu, session)

    imported_rows = _npc_utilization_from_monitoring_import(session, fiscalYear, effective_sbu, asOfMonth)
    if imported_rows is not None:
        return imported_rows

    # Note 11 - reads the finalized/uploaded budget snapshot instead of
    # live-joining BudgetRequest by currentStage=APPROVED (this function
    # predated the Note 11 switch and was missed in the first pass - the
    # snapshot is the one place every "approved budget" reader should query).
    # projectTitle/npcLocation/budgetCode aren't duplicated onto the
    # snapshot - they're stable once approved, so still read from the live
    # BudgetRequest row via the snapshot's informational budgetRequestId.
    finalized_lines = session.exec(
        select(FinalizedBudgetLine, BudgetRequest).join(
            BudgetRequest, FinalizedBudgetLine.budgetRequestId == BudgetRequest.id
        ).where(
            enum_eq(FinalizedBudgetLine.requestCategory, "NPC"),
            FinalizedBudgetLine.fiscalYear == fiscalYear,
            FinalizedBudgetLine.npcSbu == effective_sbu,
        )
    ).all()

    ios = session.exec(
        select(InternalOrderRequest).where(
            InternalOrderRequest.fiscal_year == fiscalYear,
            InternalOrderRequest.is_budgeted == True,  # noqa: E712 - SQLAlchemy comparison, not a truthiness check
            InternalOrderRequest.status.in_(ACTIVE_IO_STATUSES),
        )
    ).all()
    ios_by_npc_code: dict[str, list[InternalOrderRequest]] = {}
    for io in ios:
        if io.npc_budget_code:
            ios_by_npc_code.setdefault(io.npc_budget_code, []).append(io)

    rows: list[NpcUtilizationRow] = []
    for line, req in finalized_lines:
        if not req.budgetCode:
            continue
        matched = ios_by_npc_code.get(req.budgetCode, [])
        io_amount = sum(io.amount for io in matched)
        npc_amount = line.amount
        rows.append(
            NpcUtilizationRow(
                budgetCode=req.budgetCode,
                projectTitle=req.projectTitle or "",
                amount=round(npc_amount, 2),
                location=req.npcLocation,
                sbu=req.npcSbu or effective_sbu,
                ioCodes=sorted(io.sap_document_number for io in matched if io.sap_document_number),
                ios=[
                    NpcIoDetail(aufnr=io.sap_document_number, description=io.project_title, budget=round(io.amount, 2))
                    for io in sorted(matched, key=lambda io: io.sap_document_number or "")
                    if io.sap_document_number
                ],
                ioAmount=round(io_amount, 2),
                balance=round(npc_amount - io_amount, 2),
            )
        )
    return sorted(rows, key=lambda r: r.budgetCode)
