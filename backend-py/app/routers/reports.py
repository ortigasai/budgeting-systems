"""Phase 4 — Budget Report & Analysis (Functional Spec §6, FR-4.1-4.8).

Reports are computed live from data owned by other phases (Phase 1's
BudgetRequest/HistoricalActuals, Phase 2's SapActualTransaction/
SapCommitment) - this router only owns the report-specific overlay: access
grants (FR-4.5/4.6), notes (FR-4.4), and period locks (FR-4.8). "Actuals"
reuses Phase 2's existing SAP mock feed rather than a separate integration
(the real "financial closing system" contract is unspecified per the spec's
own open item).

Comparisons are aggregated per Expense Category, not per CC-GL: every CC-GL
maps to an ExpenseLineItem, and every ExpenseLineItem carries a category -
that chain is resolved once (_group_by_cc_gl) and used to roll raw CC-GL
figures up into one row per category. Cost Center / GL Account stay
available as narrowing *filters* (restrict which CC-GLs feed into the
categories before rolling up), they just aren't the report's row grain
anymore.
"""

from __future__ import annotations

import io
from datetime import datetime

import openpyxl
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import AuthedUser, get_current_user, require_role
from ..db import enum_eq, get_session
from ..models_phase1 import BudgetRequest, Department, ExpenseLineItem, FinalizedBudgetLine, HistoricalActuals, User
from ..models_phase2 import SapActualTransaction
from ..models_phase3 import CostCenter, GlAccount
from ..models_phase4 import PeriodLock, ReportAccessGrant, ReportNote
from ..models_sap_raw import GaeCcGlMapping, SapGaePastActualRaw, SapKssbV2Raw

router = APIRouter(prefix="/reports", tags=["reports"])


def require_report_access(
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AuthedUser:
    """FR-4.5: Budget-Officer-only by default. FR-4.6: the Budget Officer
    can grant individual users access - checked as a plain existence query
    rather than folded into the RoleType system, since this is "can view
    this one module," not a role with its own approval powers.
    """
    if user.has_role("BUDGET_OFFICER") or (user.access is not None and user.can("reports", False)):
        return user
    grant = session.exec(select(ReportAccessGrant).where(ReportAccessGrant.user_id == user.id)).first()
    if grant is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have access to the reporting module.")
    return user


class MyAccessOut(BaseModel):
    hasAccess: bool


@router.get("/my-access", response_model=MyAccessOut)
def my_access(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    if user.has_role("BUDGET_OFFICER") or (user.access is not None and user.can("reports", False)):
        return MyAccessOut(hasAccess=True)
    grant = session.exec(select(ReportAccessGrant).where(ReportAccessGrant.user_id == user.id)).first()
    return MyAccessOut(hasAccess=grant is not None)


class ReportAccessGrantOut(BaseModel):
    id: int
    userId: str
    userName: str
    userEmail: str
    createdAt: datetime


class ReportAccessGrantIn(BaseModel):
    userId: str


@router.get("/access", response_model=list[ReportAccessGrantOut])
def list_access(user: AuthedUser = Depends(require_role("BUDGET_OFFICER")), session: Session = Depends(get_session)):
    grants = session.exec(select(ReportAccessGrant).order_by(ReportAccessGrant.created_at.desc())).all()
    out = []
    for g in grants:
        u = session.get(User, g.user_id)
        out.append(ReportAccessGrantOut(id=g.id, userId=g.user_id, userName=u.name if u else "—", userEmail=u.email if u else "—", createdAt=g.created_at))
    return out


@router.post("/access", response_model=ReportAccessGrantOut, status_code=status.HTTP_201_CREATED)
def grant_access(body: ReportAccessGrantIn, user: AuthedUser = Depends(require_role("BUDGET_OFFICER")), session: Session = Depends(get_session)):
    target = session.get(User, body.userId)
    if target is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "User not found.")
    existing = session.exec(select(ReportAccessGrant).where(ReportAccessGrant.user_id == body.userId)).first()
    if existing is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This user already has report access.")
    grant = ReportAccessGrant(user_id=body.userId, granted_by_id=user.id)
    session.add(grant)
    session.commit()
    session.refresh(grant)
    return ReportAccessGrantOut(id=grant.id, userId=grant.user_id, userName=target.name, userEmail=target.email, createdAt=grant.created_at)


@router.delete("/access/{grant_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_access(grant_id: int, user: AuthedUser = Depends(require_role("BUDGET_OFFICER")), session: Session = Depends(get_session)):
    grant = session.get(ReportAccessGrant, grant_id)
    if grant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Grant not found.")
    session.delete(grant)
    session.commit()


# ---------------------------------------------------------------------------
# FR-4.1/4.2/4.3 — the report itself, aggregated per Expense Category
# ---------------------------------------------------------------------------

MONTHS_BY_PERIOD = {
    "ANNUAL": set(range(1, 13)),
    "Q1": {1, 2, 3},
    "Q2": {4, 5, 6},
    "Q3": {7, 8, 9},
    "Q4": {10, 11, 12},
}

UNMAPPED = "Unmapped"


def _months_for(period: str, month: int | None, latest_actual_month: int | None = None) -> set[int]:
    if period == "MONTHLY":
        return {month} if month else set(range(1, 13))
    # Note 12 - "YTD" granularity: everything through the latest month any
    # Actuals have actually posted for, same cutoff the page's own "Current
    # YTD Reporting Period" banner already shows (_latest_actual_month) -
    # falls back to the full year if nothing has posted yet.
    if period == "YTD":
        return set(range(1, latest_actual_month + 1)) if latest_actual_month else set(range(1, 13))
    return MONTHS_BY_PERIOD.get(period, set(range(1, 13)))


def _approved_budget_by_cc_gl(session: Session, fiscal_year: int) -> dict[tuple[str, str], float]:
    """Note 11: reads the finalized/uploaded budget snapshot directly - no
    more join through BudgetRequest+ExpenseLineItem by currentStage=APPROVED,
    since FinalizedBudgetLine already carries costCenter/glAccount/amount.
    """
    rows = session.exec(
        select(FinalizedBudgetLine).where(FinalizedBudgetLine.fiscalYear == fiscal_year)
    ).all()
    out: dict[tuple[str, str], float] = {}
    for line in rows:
        key = (line.costCenter, line.glAccount)
        out[key] = out.get(key, 0.0) + line.amount
    return out


def _actuals_by_cc_gl(session: Session, fiscal_year: int, months: set[int]) -> dict[tuple[str, str], float]:
    rows = session.exec(select(SapActualTransaction).where(SapActualTransaction.fiscal_year == fiscal_year)).all()
    out: dict[tuple[str, str], float] = {}
    for r in rows:
        if r.month not in months:
            continue
        key = (r.cost_center, r.gl_account)
        out[key] = out.get(key, 0.0) + r.amount
    return out


def _only_gae(m: dict[tuple[str, str], float], gae_pairs: set[tuple[str, str]]) -> dict[tuple[str, str], float]:
    return {k: v for k, v in m.items() if k in gae_pairs}


def _sap_plan_by_cc_gl(session: Session, fiscal_year: int) -> dict[tuple[str, str], float]:
    """Full-year budget (SAP's plan) per (cost center, GL), from sap_kssb_v2_raw -
    the same figure the Utilization Overview's Approved Budget uses.
    """
    out: dict[tuple[str, str], float] = {}
    for r in session.exec(select(SapKssbV2Raw).where(SapKssbV2Raw.fiscal_year == fiscal_year)).all():
        key = (r.cost_center, r.gl_account)
        out[key] = out.get(key, 0.0) + r.plan
    return out


def _past_actuals_by_cc_gl(session: Session, fiscal_year: int) -> dict[tuple[str, str], float]:
    """Full-year actuals for a closed year, from the GAE past-years workbook
    (sap_gae_past_actual_raw) - the live SAP table only holds the current year.
    """
    out: dict[tuple[str, str], float] = {}
    for r in session.exec(select(SapGaePastActualRaw).where(SapGaePastActualRaw.fiscal_year == fiscal_year)).all():
        key = (r.cost_center, r.gl_account)
        out[key] = out.get(key, 0.0) + r.amount
    return out


def _actuals_by_cc_gl_by_month(session: Session, fiscal_year: int) -> dict[int, dict[tuple[str, str], float]]:
    """Every actual for `fiscal_year`, fetched once and pre-bucketed by month
    (1-12). Callers that need several different month-subsets of the same
    year (a per-period grid or chart, one bucket per month/quarter) should
    use this instead of calling `_actuals_by_cc_gl` once per bucket - that
    re-queries and re-deserializes the *entire* table every time, which is
    fine for a single call but was measured to hang for several minutes once
    this table held real synced SAP data (180K+ rows) and a caller needed it
    12 times over (one per month).
    """
    rows = session.exec(select(SapActualTransaction).where(SapActualTransaction.fiscal_year == fiscal_year)).all()
    out: dict[int, dict[tuple[str, str], float]] = {m: {} for m in range(1, 13)}
    for r in rows:
        bucket = out.setdefault(r.month, {})
        key = (r.cost_center, r.gl_account)
        bucket[key] = bucket.get(key, 0.0) + r.amount
    return out


def _rolled_actuals_for_months(actuals_by_month: dict[int, dict[tuple[str, str], float]], months: set[int]) -> dict[tuple[str, str], float]:
    combined: dict[tuple[str, str], float] = {}
    for m in months:
        for key, amt in actuals_by_month.get(m, {}).items():
            combined[key] = combined.get(key, 0.0) + amt
    return combined


def _forecast_by_cc_gl(session: Session, fiscal_year: int) -> dict[tuple[str, str], float]:
    """Current-cycle-only (see spec decision) - HistoricalActuals' value
    columns are frozen to whichever Target Calendar Year the row was built
    for, not genuinely re-keyed per fiscal_year, so this is only meaningful
    for the report's "current year" column, never the multi-year trend.
    """
    rows = session.exec(select(HistoricalActuals).where(HistoricalActuals.fiscalYear == fiscal_year)).all()
    out: dict[tuple[str, str], float] = {}
    for r in rows:
        remaining = sum(float(v) for v in (r.monthlyRemainingForecast2026 or {}).values())
        total = r.ytdActuals2026 + remaining
        key = (r.costCenter, r.glAccount)
        out[key] = out.get(key, 0.0) + total
    return out


def _group_by_cc_gl(session: Session) -> dict[tuple[str, str], str]:
    """Every CC-GL's Expense Category, via whichever ExpenseLineItem
    carries that CC-GL (a CC-GL can back more than one line item - e.g.
    Driver/Messenger/Operator - they're picked to share one category in the
    real catalog, so the first match is representative).
    """
    line_items = session.exec(select(ExpenseLineItem)).all()
    group_by_cc_gl: dict[tuple[str, str], str] = {}
    for li in line_items:
        group_by_cc_gl.setdefault((li.costCenter, li.glAccount), li.category)
    return group_by_cc_gl


def _filter_cc_gl_map(
    m: dict[tuple[str, str], float],
    cost_center: str | None,
    gl_account: str | None,
    sbu: str | None = None,
    sbu_by_cc_gl: dict[tuple[str, str], str] | None = None,
    financial_scope: list[str] | None = None,
    financial_scope_by_cc_gl: dict[tuple[str, str], str] | None = None,
) -> dict[tuple[str, str], float]:
    if not cost_center and not gl_account and not sbu and not financial_scope:
        return m
    return {
        k: v
        for k, v in m.items()
        if (not cost_center or k[0] == cost_center)
        and (not gl_account or k[1] == gl_account)
        and (not sbu or (sbu_by_cc_gl or {}).get(k) == sbu)
        and (not financial_scope or (financial_scope_by_cc_gl or {}).get(k) in financial_scope)
    }


# Spec item 15 - report-only SBU filter, distinct from every other SBU list
# in this app: the 4 real-estate SBUs (Malls/Offices/Estates/Residential -
# no Leisure) plus one "Corporate-GAE" catch-all for every other department
# (Leisure, the 3 Corporate_* NPC buckets, and any department with no SBU
# set at all - GAE spend is inherently centralized/corporate overhead, so
# collapsing all of that into one bucket gives a clean 5-way partition of
# every department rather than a long tail of near-empty buckets). Derived
# from Department.sbu (spec item 13's admin-assigned field) via each
# ExpenseLineItem's owning department - reuses that field rather than
# introducing a second, competing department->SBU mapping.
SBU_REPORT_OPTIONS = ["Malls", "Offices", "Estates", "Residential", "Corporate-GAE"]
_DEPT_SBU_TO_REPORT_BUCKET = {
    "MALLS": "Malls",
    "OFFICES": "Offices",
    "ESTATES": "Estates",
    "RESIDENTIAL": "Residential",
}


def _sbu_bucket(dept_sbu: str | None) -> str:
    return _DEPT_SBU_TO_REPORT_BUCKET.get(dept_sbu or "", "Corporate-GAE")


def _sbu_by_cc_gl(session: Session) -> dict[tuple[str, str], str]:
    line_items = session.exec(select(ExpenseLineItem)).all()
    dept_ids = {li.ownerDepartmentId for li in line_items}
    depts = {d.id: d for d in session.exec(select(Department).where(Department.id.in_(dept_ids))).all()} if dept_ids else {}
    out: dict[tuple[str, str], str] = {}
    for li in line_items:
        dept = depts.get(li.ownerDepartmentId)
        out.setdefault((li.costCenter, li.glAccount), _sbu_bucket(dept.sbu if dept else None))
    return out


# Note 12 - "Financial Scope" filter (Operating Expense / Revenue / Non-
# Project Capex). Operating Expense folds GAE+DOE together - the spec's own
# 3-way split doesn't distinguish them, and every other "Financial Scope"-
# adjacent concept in this app (SBU_REPORT_OPTIONS above) already collapses
# multiple RequestCategory values into one bucket the same way.
FINANCIAL_SCOPE_OPTIONS = ["GAE"]
_REQUEST_CATEGORY_TO_SCOPE = {"GAE": "GAE", "DOE": "DOE", "NPC": "NPC", "REVENUE": "REVENUE_COS", "COST_OF_SALES": "REVENUE_COS", "COMMISSION": "COMMISSION", "DEPRECIATION_AMORTIZATION": "DA", "INTEREST_EXPENSE": "INTEREST"}


def _financial_scope_by_cc_gl(session: Session, fiscal_year: int) -> dict[tuple[str, str], str]:
    """FinalizedBudgetLine.requestCategory is the most authoritative source
    (it's literally what category the finalized budget request was) -
    HistoricalActuals.requestCategory (itself ForecastCategoryMapping-
    derived, defaulting to GAE) fills in any CC-GL not yet finalized for the
    year; anything left over defaults to GAE/OPEX, matching the default this
    whole app already uses wherever a CC-GL has no explicit category mapping.
    """
    out: dict[tuple[str, str], str] = {}
    for line in session.exec(select(FinalizedBudgetLine).where(FinalizedBudgetLine.fiscalYear == fiscal_year)).all():
        out.setdefault((line.costCenter, line.glAccount), _REQUEST_CATEGORY_TO_SCOPE.get(line.requestCategory, "GAE"))
    for r in session.exec(select(HistoricalActuals).where(HistoricalActuals.fiscalYear == fiscal_year)).all():
        out.setdefault((r.costCenter, r.glAccount), _REQUEST_CATEGORY_TO_SCOPE.get(r.requestCategory, "GAE"))
    return out


def _roll_up_by_group(m: dict[tuple[str, str], float], group_by_cc_gl: dict[tuple[str, str], str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for (cc, gl), v in m.items():
        group = group_by_cc_gl.get((cc, gl), UNMAPPED)
        out[group] = out.get(group, 0.0) + v
    return out


class ReportLineItemOut(BaseModel):
    """Note 12's folder-style table's child rows. No noteCount - comments
    stay category-only (see ReportNote's own grain, unchanged by this note).
    """

    id: str
    name: str
    budgetCurrent: float
    actualCurrent: float
    forecastCurrent: float | None
    variance: float
    variancePct: float | None


class ReportRowOut(BaseModel):
    expenseGroup: str
    # Note 12 - which of the 3 Financial Scope buckets this category's CC-GLs
    # dominantly belong to (same first-CC-GL-wins convention as expenseGroup
    # itself) - drives the donut chart's client-side aggregation and the
    # Financial Scope filter chips.
    financialScope: str
    budgetCurrent: float
    actualCurrent: float
    forecastCurrent: float | None
    budgetPrior: float
    actualPrior: float
    # FR-4.1's "budgets vs actuals" / "budgets vs forecasts" side by side -
    # a third (Actual vs Forecast) added on top since both other pairs are
    # already computed. `variance`/`variancePct` kept as the Budget vs
    # Actual pair for backward compatibility with existing call sites.
    variance: float
    variancePct: float | None
    varianceBudgetForecast: float | None
    varianceActualForecast: float | None
    noteCount: int
    lineItems: list[ReportLineItemOut]


class ReportSummaryOut(BaseModel):
    fiscalYear: int
    priorFiscalYear: int
    period: str
    # Spec item 15 - "what the current YTD reporting period is": the latest
    # month (1-12) any SapActualTransaction row exists for in fiscalYear,
    # i.e. how far this year's Actuals data actually reaches right now -
    # computed live from the data itself rather than reusing Forecast's own
    # (differently-scoped) as-of-month config, and always reflects the whole
    # year's data regardless of the Period/Month filter in effect.
    latestActualMonth: int | None
    rows: list[ReportRowOut]
    totals: ReportRowOut


def _latest_actual_month(session: Session, fiscal_year: int) -> int | None:
    rows = session.exec(select(SapActualTransaction).where(SapActualTransaction.fiscal_year == fiscal_year)).all()
    months = [r.month for r in rows]
    return max(months) if months else None


def _budget_by_line_item(session: Session, fiscal_year: int) -> dict[str, float]:
    """True per-ExpenseLineItem budget - unlike the CC-GL-keyed dicts above,
    this doesn't collapse when several line items share one CC-GL (e.g.
    Driver/Messenger/Operator), since FinalizedBudgetLine.budgetRequestId
    joins back to BudgetRequest.expenseLineItemId directly (no FK - cross-
    registry join, same pattern npc_utilization already uses).
    """
    rows = session.exec(
        select(FinalizedBudgetLine, BudgetRequest)
        .join(BudgetRequest, FinalizedBudgetLine.budgetRequestId == BudgetRequest.id)
        .where(FinalizedBudgetLine.fiscalYear == fiscal_year)
    ).all()
    out: dict[str, float] = {}
    for line, req in rows:
        out[req.expenseLineItemId] = out.get(req.expenseLineItemId, 0.0) + line.amount
    return out


def _line_items_by_category(session: Session) -> dict[str, list[ExpenseLineItem]]:
    out: dict[str, list[ExpenseLineItem]] = {}
    for li in session.exec(select(ExpenseLineItem)).all():
        out.setdefault(li.category, []).append(li)
    return out


def _line_item_breakdown(
    category: str,
    line_items_by_category: dict[str, list[ExpenseLineItem]],
    budget_by_line_item: dict[str, float],
    actual_cc_gl: dict[tuple[str, str], float],
    forecast_cc_gl: dict[tuple[str, str], float],
    surviving_cc_gl: set[tuple[str, str]],
) -> list[ReportLineItemOut]:
    """Budget is attributed exactly per line item. Actual/Forecast are only
    ever known per CC-GL (SAP postings/Forecast reference rows have no
    concept of "which catalog line item"), so when several line items in
    this category share one CC-GL, that CC-GL's actual/forecast is split
    across them proportional to their own budget share (falling back to an
    even split if none of them have a budget yet) - shares always sum to 1,
    so the line items' totals always reconcile back to the parent category's
    own actual/forecast figures.
    """
    by_cc_gl: dict[tuple[str, str], list[ExpenseLineItem]] = {}
    for li in line_items_by_category.get(category, []):
        key = (li.costCenter, li.glAccount)
        if key not in surviving_cc_gl:
            continue  # filtered out by cost center / GL / SBU / financial scope
        by_cc_gl.setdefault(key, []).append(li)

    out: list[ReportLineItemOut] = []
    for cc_gl, group in by_cc_gl.items():
        cc_gl_actual = actual_cc_gl.get(cc_gl, 0.0)
        cc_gl_forecast = forecast_cc_gl.get(cc_gl)
        total_budget = sum(budget_by_line_item.get(li.id, 0.0) for li in group)
        for li in group:
            li_budget = budget_by_line_item.get(li.id, 0.0)
            share = (li_budget / total_budget) if total_budget else (1.0 / len(group))
            li_actual = cc_gl_actual * share
            li_forecast = (cc_gl_forecast * share) if cc_gl_forecast is not None else None
            variance = li_budget - li_actual
            out.append(
                ReportLineItemOut(
                    id=li.id,
                    name=li.name,
                    budgetCurrent=li_budget,
                    actualCurrent=li_actual,
                    forecastCurrent=li_forecast,
                    variance=variance,
                    variancePct=(variance / li_budget * 100) if li_budget else None,
                )
            )
    return sorted(out, key=lambda r: r.name)


def _build_rows(
    session: Session,
    fiscal_year: int,
    prior_fiscal_year: int,
    period: str,
    month: int | None,
    cost_center: str | None,
    gl_account: str | None,
    expense_group: str | None,
    sbu: str | None = None,
    financial_scope: list[str] | None = None,
    latest_actual_month: int | None = None,
) -> list[ReportRowOut]:
    months = _months_for(period, month, latest_actual_month)
    group_by_cc_gl = _group_by_cc_gl(session)
    financial_scope_by_cc_gl = _financial_scope_by_cc_gl(session, fiscal_year)
    sbu_by_cc_gl = _sbu_by_cc_gl(session) if sbu else None

    def filt(m: dict[tuple[str, str], float]) -> dict[tuple[str, str], float]:
        return _filter_cc_gl_map(m, cost_center, gl_account, sbu, sbu_by_cc_gl, financial_scope, financial_scope_by_cc_gl)

    budget_cur_cc_gl = filt(_approved_budget_by_cc_gl(session, fiscal_year))
    actual_cur_cc_gl = filt(_actuals_by_cc_gl(session, fiscal_year, months))
    forecast_cur_cc_gl = filt(_forecast_by_cc_gl(session, fiscal_year))
    budget_cur = _roll_up_by_group(budget_cur_cc_gl, group_by_cc_gl)
    actual_cur = _roll_up_by_group(actual_cur_cc_gl, group_by_cc_gl)
    forecast_cur = _roll_up_by_group(forecast_cur_cc_gl, group_by_cc_gl)
    budget_prior = _roll_up_by_group(filt(_approved_budget_by_cc_gl(session, prior_fiscal_year)), group_by_cc_gl)
    actual_prior = _roll_up_by_group(filt(_actuals_by_cc_gl(session, prior_fiscal_year, months)), group_by_cc_gl)

    note_counts: dict[str, int] = {}
    for n in session.exec(select(ReportNote).where(ReportNote.fiscal_year == fiscal_year)).all():
        note_counts[n.expense_group] = note_counts.get(n.expense_group, 0) + 1

    groups = set(budget_cur) | set(actual_cur) | set(forecast_cur) | set(budget_prior) | set(actual_prior)
    if expense_group:
        groups &= {expense_group}

    budget_by_line_item = _budget_by_line_item(session, fiscal_year)
    line_items_by_category = _line_items_by_category(session)
    surviving_cc_gl = set(budget_cur_cc_gl) | set(actual_cur_cc_gl) | set(forecast_cur_cc_gl)

    financial_scope_by_group: dict[str, str] = {}
    for (cc, gl), scope in financial_scope_by_cc_gl.items():
        group = group_by_cc_gl.get((cc, gl))
        if group is not None:
            financial_scope_by_group.setdefault(group, scope)

    rows: list[ReportRowOut] = []
    for group in sorted(groups):
        b = budget_cur.get(group, 0.0)
        a = actual_cur.get(group, 0.0)
        f = forecast_cur.get(group)
        variance = b - a
        rows.append(
            ReportRowOut(
                expenseGroup=group,
                financialScope=financial_scope_by_group.get(group, "GAE"),
                budgetCurrent=b,
                actualCurrent=a,
                forecastCurrent=f,
                budgetPrior=budget_prior.get(group, 0.0),
                actualPrior=actual_prior.get(group, 0.0),
                variance=variance,
                variancePct=(variance / b * 100) if b else None,
                varianceBudgetForecast=(b - f) if f is not None else None,
                varianceActualForecast=(a - f) if f is not None else None,
                noteCount=note_counts.get(group, 0),
                lineItems=_line_item_breakdown(group, line_items_by_category, budget_by_line_item, actual_cur_cc_gl, forecast_cur_cc_gl, surviving_cc_gl),
            )
        )
    return rows


def _totals(rows: list[ReportRowOut]) -> ReportRowOut:
    b = sum(r.budgetCurrent for r in rows)
    a = sum(r.actualCurrent for r in rows)
    forecasts = [r.forecastCurrent for r in rows if r.forecastCurrent is not None]
    f = sum(forecasts) if forecasts else None
    variance = b - a
    return ReportRowOut(
        expenseGroup="",
        financialScope="",
        budgetCurrent=b,
        actualCurrent=a,
        forecastCurrent=f,
        budgetPrior=sum(r.budgetPrior for r in rows),
        actualPrior=sum(r.actualPrior for r in rows),
        variance=variance,
        variancePct=(variance / b * 100) if b else None,
        varianceBudgetForecast=(b - f) if f is not None else None,
        varianceActualForecast=(a - f) if f is not None else None,
        noteCount=sum(r.noteCount for r in rows),
        lineItems=[],
    )


@router.get("/cc-gl-summary", response_model=ReportSummaryOut)
def cc_gl_summary(
    fiscalYear: int,
    priorFiscalYear: int | None = None,
    costCenter: str | None = None,
    glAccount: str | None = None,
    expenseGroup: str | None = None,
    sbu: str | None = None,
    period: str = "ANNUAL",
    month: int | None = None,
    financialScope: str | None = None,
    user: AuthedUser = Depends(require_report_access),
    session: Session = Depends(get_session),
):
    prior_year = priorFiscalYear if priorFiscalYear is not None else fiscalYear - 1
    latest_actual_month = _latest_actual_month(session, fiscalYear)
    scope_list = financialScope.split(",") if financialScope else None
    rows = _build_rows(session, fiscalYear, prior_year, period, month, costCenter, glAccount, expenseGroup, sbu, scope_list, latest_actual_month)
    return ReportSummaryOut(
        fiscalYear=fiscalYear,
        priorFiscalYear=prior_year,
        period=period,
        latestActualMonth=latest_actual_month,
        rows=rows,
        totals=_totals(rows),
    )


class FilterOptionsOut(BaseModel):
    costCenters: list[dict]
    glAccounts: list[dict]
    expenseGroups: list[str]
    sbus: list[str]
    financialScopes: list[str]


@router.get("/filter-options", response_model=FilterOptionsOut)
def filter_options(user: AuthedUser = Depends(require_report_access), session: Session = Depends(get_session)):
    cost_centers = session.exec(select(CostCenter).order_by(CostCenter.code.asc())).all()
    gl_accounts = session.exec(select(GlAccount).order_by(GlAccount.code.asc())).all()
    categories = sorted({li.category for li in session.exec(select(ExpenseLineItem)).all()})
    return FilterOptionsOut(
        costCenters=[{"code": c.code, "name": c.name} for c in cost_centers],
        glAccounts=[{"code": g.code, "name": g.name} for g in gl_accounts],
        expenseGroups=categories,
        sbus=SBU_REPORT_OPTIONS,
        financialScopes=FINANCIAL_SCOPE_OPTIONS,
    )


class TrendPointOut(BaseModel):
    fiscalYear: int
    budget: float
    actual: float


@router.get("/trend", response_model=list[TrendPointOut])
def trend(
    currentYear: int,
    costCenter: str | None = None,
    glAccount: str | None = None,
    expenseGroup: str | None = None,
    sbu: str | None = None,
    financialScope: str | None = None,
    user: AuthedUser = Depends(require_report_access),
    session: Session = Depends(get_session),
):
    """FR-4.3 (Note 12 revision): "5-Year Trend" - a fixed, predictable
    5-point window (`currentYear` and the 4 years before it), Budget vs
    Actual per Expense Category (same roll-up as the main report). Unlike
    the old "5/10-year, whichever years happen to have data" behavior, every
    point in this window is always returned even if a given year has no
    data yet (0, not omitted) - a stable x-axis the accompanying data table
    can rely on, not one that silently reshapes around whatever's in the
    database. Note 12: this is also what the dashboard renders when Primary
    Comparison = "5-Year Trend" (reachable only via that Saved View, not the
    Primary Comparison dropdown - see ReportsPage.tsx).
    """
    scope_list = financialScope.split(",") if financialScope else None
    all_years = list(range(currentYear - 4, currentYear + 1))
    group_by_cc_gl = _group_by_cc_gl(session)
    sbu_by_cc_gl = _sbu_by_cc_gl(session) if sbu else None

    def _grouped_total(m: dict[tuple[str, str], float], financial_scope_by_cc_gl: dict[tuple[str, str], str]) -> float:
        rolled = _roll_up_by_group(_filter_cc_gl_map(m, costCenter, glAccount, sbu, sbu_by_cc_gl, scope_list, financial_scope_by_cc_gl), group_by_cc_gl)
        if expenseGroup:
            return rolled.get(expenseGroup, 0.0)
        return sum(rolled.values())

    # GAE only: the same CC-GL pairs the GAE report uses (gae_cc_gl_mapping).
    gae_pairs = {(m.cost_center, m.gl_account) for m in session.exec(select(GaeCcGlMapping)).all()}

    points: list[TrendPointOut] = []
    for fy in sorted(all_years):
        scope_map = _financial_scope_by_cc_gl(session, fy) if scope_list else {}
        # Budget is SAP's plan per year (live for 2026, loaded from the past-years workbook for earlier years).
        budget_total = _grouped_total(_only_gae(_sap_plan_by_cc_gl(session, fy), gae_pairs), scope_map)
        # Closed years come from the past-years workbook; the current year from the live SAP table.
        actuals = _past_actuals_by_cc_gl(session, fy) if fy < currentYear else _actuals_by_cc_gl(session, fy, set(range(1, 13)))
        actual_total = _grouped_total(_only_gae(actuals, gae_pairs), scope_map)
        points.append(TrendPointOut(fiscalYear=fy, budget=budget_total, actual=actual_total))
    return points


class TrendTypePointOut(BaseModel):
    fiscalYear: int
    budget: float
    actual: float


class TrendTypeOut(BaseModel):
    key: str
    label: str
    points: list[TrendTypePointOut]


@router.get("/trend-by-type", response_model=list[TrendTypeOut])
def trend_by_type(
    currentYear: int,
    user: AuthedUser = Depends(require_report_access),
    session: Session = Depends(get_session),
):
    """The 5-Year Trend split by GAE Main Report type (Salaries, PB, ... Others) -
    the same 5-point window, GAE pairs and budget/actual sources as /trend.
    """
    from .gae_report import MAIN_MANPOWER, MAIN_NON_MANPOWER, _norm

    type_by_pair = {(m.cost_center, m.gl_account): _norm(m.type) for m in session.exec(select(GaeCcGlMapping)).all()}
    gae_pairs = set(type_by_pair)
    years = list(range(currentYear - 4, currentYear + 1))
    totals: dict[str, dict[int, list[float]]] = {}

    for fy in years:
        budgets = _only_gae(_sap_plan_by_cc_gl(session, fy), gae_pairs)
        actuals = _only_gae(
            _past_actuals_by_cc_gl(session, fy) if fy < currentYear else _actuals_by_cc_gl(session, fy, set(range(1, 13))),
            gae_pairs,
        )
        for key, value in budgets.items():
            totals.setdefault(type_by_pair[key], {}).setdefault(fy, [0.0, 0.0])[0] += value
        for key, value in actuals.items():
            totals.setdefault(type_by_pair[key], {}).setdefault(fy, [0.0, 0.0])[1] += value

    out: list[TrendTypeOut] = []
    for label, norm in MAIN_MANPOWER + MAIN_NON_MANPOWER:
        per_year = totals.get(norm, {})
        out.append(
            TrendTypeOut(
                key=norm,
                label=label,
                points=[TrendTypePointOut(fiscalYear=fy, budget=per_year.get(fy, [0.0, 0.0])[0], actual=per_year.get(fy, [0.0, 0.0])[1]) for fy in years],
            )
        )
    return out


class SeriesPointOut(BaseModel):
    period: str
    budget: float
    actual: float
    forecast: float | None
    variancePct: float | None


@router.get("/series", response_model=list[SeriesPointOut])
def series(
    fiscalYear: int,
    granularity: str = "MONTHLY",
    costCenter: str | None = None,
    glAccount: str | None = None,
    expenseGroup: str | None = None,
    sbu: str | None = None,
    financialScope: str | None = None,
    user: AuthedUser = Depends(require_report_access),
    session: Session = Depends(get_session),
):
    """Note 12's Comparison Chart data - Monthly or Quarterly buckets of
    Baseline (Budget) vs Target (Actual) plus a variance % per bucket.
    Rendered as two stacked panels (bars on Budget/Actual, a thin line below
    on variance %) rather than one dual-axis plot - see the dataviz skill's
    #1 anti-pattern. Budget/Forecast don't carry a real monthly phasing
    anywhere in this app (BudgetRequest.monthlyAmounts is per-request, not
    per-CC-GL-aggregate, and HistoricalActuals is annual-only), so each
    bucket gets an even share of the annual total - a documented
    simplification, not a real monthly budget split.
    """
    if granularity not in ("MONTHLY", "QUARTERLY"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "granularity must be MONTHLY or QUARTERLY.")

    scope_list = financialScope.split(",") if financialScope else None
    group_by_cc_gl = _group_by_cc_gl(session)
    sbu_by_cc_gl = _sbu_by_cc_gl(session) if sbu else None
    financial_scope_by_cc_gl = _financial_scope_by_cc_gl(session, fiscalYear) if scope_list else {}

    def _grouped_total(m: dict[tuple[str, str], float]) -> float:
        rolled = _roll_up_by_group(_filter_cc_gl_map(m, costCenter, glAccount, sbu, sbu_by_cc_gl, scope_list, financial_scope_by_cc_gl), group_by_cc_gl)
        if expenseGroup:
            return rolled.get(expenseGroup, 0.0)
        return sum(rolled.values())

    annual_budget = _grouped_total(_approved_budget_by_cc_gl(session, fiscalYear))
    annual_forecast = _grouped_total(_forecast_by_cc_gl(session, fiscalYear))

    if granularity == "MONTHLY":
        buckets = [("Jan", {1}), ("Feb", {2}), ("Mar", {3}), ("Apr", {4}), ("May", {5}), ("Jun", {6}), ("Jul", {7}), ("Aug", {8}), ("Sep", {9}), ("Oct", {10}), ("Nov", {11}), ("Dec", {12})]
    else:
        buckets = [("Q1", MONTHS_BY_PERIOD["Q1"]), ("Q2", MONTHS_BY_PERIOD["Q2"]), ("Q3", MONTHS_BY_PERIOD["Q3"]), ("Q4", MONTHS_BY_PERIOD["Q4"])]

    budget_share = annual_budget / len(buckets)
    forecast_share = (annual_forecast / len(buckets)) if annual_forecast else None

    # Fetch SapActualTransaction once for the year and slice it per bucket in
    # memory, rather than re-querying/re-deserializing the whole (possibly
    # very large - confirmed live: 180K+ rows once real SAP data is synced)
    # table once per bucket (12x for Monthly) - see
    # _actuals_by_cc_gl_by_month's own docstring for why that matters.
    actuals_by_month = _actuals_by_cc_gl_by_month(session, fiscalYear)

    points: list[SeriesPointOut] = []
    for label, months in buckets:
        actual = _grouped_total(_rolled_actuals_for_months(actuals_by_month, months))
        variance = budget_share - actual
        points.append(
            SeriesPointOut(
                period=label,
                budget=budget_share,
                actual=actual,
                forecast=forecast_share,
                variancePct=(variance / budget_share * 100) if budget_share else None,
            )
        )
    return points


class PeriodGridCellOut(BaseModel):
    budget: float
    actual: float
    variance: float
    variancePct: float | None


class PeriodGridRowOut(BaseModel):
    expenseGroup: str
    financialScope: str
    cells: list[PeriodGridCellOut]  # one per period, same order as `periods`
    total: PeriodGridCellOut


class PeriodGridOut(BaseModel):
    periods: list[str]
    rows: list[PeriodGridRowOut]
    totals: PeriodGridRowOut


def _period_grid_cell(budget: float, actual: float) -> PeriodGridCellOut:
    variance = budget - actual
    return PeriodGridCellOut(budget=budget, actual=actual, variance=variance, variancePct=(variance / budget * 100) if budget else None)


@router.get("/period-grid", response_model=PeriodGridOut)
def period_grid(
    fiscalYear: int,
    granularity: str = "MONTHLY",
    costCenter: str | None = None,
    glAccount: str | None = None,
    expenseGroup: str | None = None,
    sbu: str | None = None,
    financialScope: str | None = None,
    user: AuthedUser = Depends(require_report_access),
    session: Session = Depends(get_session),
):
    """"Monthly Comparison" / "Quarterly Comparison" (Note 12 revision) - the
    full Expense Category x period grid, not a company-wide total: Budget vs
    Actual (+ variance $/%) for every category, broken out per month or
    quarter instead of collapsed to one annual figure. Same even-split
    simplification /series already uses for Budget (no real monthly phasing
    anywhere in this app) - each period gets an even share of that
    category's annual budget.
    """
    if granularity not in ("MONTHLY", "QUARTERLY"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "granularity must be MONTHLY or QUARTERLY.")

    scope_list = financialScope.split(",") if financialScope else None
    group_by_cc_gl = _group_by_cc_gl(session)
    sbu_by_cc_gl = _sbu_by_cc_gl(session) if sbu else None
    financial_scope_by_cc_gl = _financial_scope_by_cc_gl(session, fiscalYear)

    def filt(m: dict[tuple[str, str], float]) -> dict[tuple[str, str], float]:
        return _filter_cc_gl_map(m, costCenter, glAccount, sbu, sbu_by_cc_gl, scope_list, financial_scope_by_cc_gl)

    budget_annual_by_group = _roll_up_by_group(filt(_approved_budget_by_cc_gl(session, fiscalYear)), group_by_cc_gl)

    if granularity == "MONTHLY":
        buckets = [("Jan", {1}), ("Feb", {2}), ("Mar", {3}), ("Apr", {4}), ("May", {5}), ("Jun", {6}), ("Jul", {7}), ("Aug", {8}), ("Sep", {9}), ("Oct", {10}), ("Nov", {11}), ("Dec", {12})]
    else:
        buckets = [("Q1", MONTHS_BY_PERIOD["Q1"]), ("Q2", MONTHS_BY_PERIOD["Q2"]), ("Q3", MONTHS_BY_PERIOD["Q3"]), ("Q4", MONTHS_BY_PERIOD["Q4"])]

    actuals_by_month = _actuals_by_cc_gl_by_month(session, fiscalYear)
    actual_by_bucket = [_roll_up_by_group(filt(_rolled_actuals_for_months(actuals_by_month, months)), group_by_cc_gl) for _, months in buckets]

    financial_scope_by_group: dict[str, str] = {}
    for (cc, gl), scope in financial_scope_by_cc_gl.items():
        group = group_by_cc_gl.get((cc, gl))
        if group is not None:
            financial_scope_by_group.setdefault(group, scope)

    groups = set(budget_annual_by_group)
    for m in actual_by_bucket:
        groups |= set(m)
    if expenseGroup:
        groups &= {expenseGroup}

    rows: list[PeriodGridRowOut] = []
    for group in sorted(groups):
        annual_budget = budget_annual_by_group.get(group, 0.0)
        budget_share = annual_budget / len(buckets)
        cells = [_period_grid_cell(budget_share, actual_by_bucket[i].get(group, 0.0)) for i in range(len(buckets))]
        total_actual = sum(c.actual for c in cells)
        rows.append(
            PeriodGridRowOut(
                expenseGroup=group,
                financialScope=financial_scope_by_group.get(group, "GAE"),
                cells=cells,
                total=_period_grid_cell(annual_budget, total_actual),
            )
        )

    totals_cells = [_period_grid_cell(sum(r.cells[i].budget for r in rows), sum(r.cells[i].actual for r in rows)) for i in range(len(buckets))]
    totals_total = _period_grid_cell(sum(r.total.budget for r in rows), sum(r.total.actual for r in rows))

    return PeriodGridOut(
        periods=[label for label, _ in buckets],
        rows=rows,
        totals=PeriodGridRowOut(expenseGroup="TOTAL", financialScope="", cells=totals_cells, total=totals_total),
    )


# ---------------------------------------------------------------------------
# FR-4.4 — notes, per Expense Category
# ---------------------------------------------------------------------------


class ReportNoteIn(BaseModel):
    fiscalYear: int
    expenseGroup: str
    month: int | None = None
    text: str


class ReportNoteOut(BaseModel):
    id: int
    fiscalYear: int
    expenseGroup: str
    month: int | None
    text: str
    authorName: str
    createdAt: datetime


@router.get("/notes", response_model=list[ReportNoteOut])
def list_notes(
    fiscalYear: int,
    expenseGroup: str,
    user: AuthedUser = Depends(require_report_access),
    session: Session = Depends(get_session),
):
    notes = session.exec(
        select(ReportNote)
        .where(ReportNote.fiscal_year == fiscalYear, ReportNote.expense_group == expenseGroup)
        .order_by(ReportNote.created_at.desc())
    ).all()
    out = []
    for n in notes:
        author = session.get(User, n.author_id)
        out.append(ReportNoteOut(id=n.id, fiscalYear=n.fiscal_year, expenseGroup=n.expense_group, month=n.month, text=n.text, authorName=author.name if author else "—", createdAt=n.created_at))
    return out


@router.post("/notes", response_model=ReportNoteOut, status_code=status.HTTP_201_CREATED)
def create_note(body: ReportNoteIn, user: AuthedUser = Depends(require_report_access), session: Session = Depends(get_session)):
    note = ReportNote(fiscal_year=body.fiscalYear, expense_group=body.expenseGroup, month=body.month, text=body.text, author_id=user.id)
    session.add(note)
    session.commit()
    session.refresh(note)
    author = session.get(User, user.id)
    return ReportNoteOut(id=note.id, fiscalYear=note.fiscal_year, expenseGroup=note.expense_group, month=note.month, text=note.text, authorName=author.name if author else "—", createdAt=note.created_at)


# ---------------------------------------------------------------------------
# FR-4.8 — period lock
# ---------------------------------------------------------------------------


class PeriodLockOut(BaseModel):
    id: int
    fiscalYear: int
    month: int
    lockedByName: str
    lockedAt: datetime


class PeriodLockIn(BaseModel):
    fiscalYear: int
    month: int


@router.get("/period-locks", response_model=list[PeriodLockOut])
def list_period_locks(fiscalYear: int, user: AuthedUser = Depends(require_report_access), session: Session = Depends(get_session)):
    locks = session.exec(select(PeriodLock).where(PeriodLock.fiscal_year == fiscalYear).order_by(PeriodLock.month.asc())).all()
    out = []
    for l in locks:
        u = session.get(User, l.locked_by_id)
        out.append(PeriodLockOut(id=l.id, fiscalYear=l.fiscal_year, month=l.month, lockedByName=u.name if u else "—", lockedAt=l.locked_at))
    return out


@router.post("/period-locks", response_model=PeriodLockOut, status_code=status.HTTP_201_CREATED)
def lock_period(body: PeriodLockIn, user: AuthedUser = Depends(require_role("BUDGET_OFFICER")), session: Session = Depends(get_session)):
    if not (1 <= body.month <= 12):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "month must be 1-12.")
    existing = session.exec(select(PeriodLock).where(PeriodLock.fiscal_year == body.fiscalYear, PeriodLock.month == body.month)).first()
    if existing is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This period is already locked.")
    lock = PeriodLock(fiscal_year=body.fiscalYear, month=body.month, locked_by_id=user.id)
    session.add(lock)
    session.commit()
    session.refresh(lock)
    return PeriodLockOut(id=lock.id, fiscalYear=lock.fiscal_year, month=lock.month, lockedByName=user.name, lockedAt=lock.locked_at)


# ---------------------------------------------------------------------------
# FR-4.7 — Excel extraction
# ---------------------------------------------------------------------------


@router.get("/export")
def export_excel(
    fiscalYear: int,
    priorFiscalYear: int | None = None,
    costCenter: str | None = None,
    glAccount: str | None = None,
    expenseGroup: str | None = None,
    sbu: str | None = None,
    period: str = "ANNUAL",
    month: int | None = None,
    financialScope: str | None = None,
    user: AuthedUser = Depends(require_report_access),
    session: Session = Depends(get_session),
):
    prior_year = priorFiscalYear if priorFiscalYear is not None else fiscalYear - 1
    latest_actual_month = _latest_actual_month(session, fiscalYear)
    scope_list = financialScope.split(",") if financialScope else None
    rows = _build_rows(session, fiscalYear, prior_year, period, month, costCenter, glAccount, expenseGroup, sbu, scope_list, latest_actual_month)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Budget Report"
    headers = [
        "Expense Category",
        f"Budget {fiscalYear}", f"Actual {fiscalYear}", f"Forecast {fiscalYear}",
        f"Budget {prior_year}", f"Actual {prior_year}",
        "Budget vs Actual", "Budget vs Actual %", "Budget vs Forecast", "Actual vs Forecast", "Notes",
    ]
    ws.append(headers)
    for r in rows:
        ws.append([
            r.expenseGroup,
            r.budgetCurrent, r.actualCurrent, r.forecastCurrent,
            r.budgetPrior, r.actualPrior,
            r.variance, r.variancePct, r.varianceBudgetForecast, r.varianceActualForecast, r.noteCount,
        ])
    totals = _totals(rows)
    ws.append([
        "TOTAL",
        totals.budgetCurrent, totals.actualCurrent, totals.forecastCurrent,
        totals.budgetPrior, totals.actualPrior,
        totals.variance, totals.variancePct, totals.varianceBudgetForecast, totals.varianceActualForecast, totals.noteCount,
    ])

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    filename = f"budget-report-{fiscalYear}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
