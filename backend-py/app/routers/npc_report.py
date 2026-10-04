"""NPC report - per NPC SBU, from the NPC Budget Utilization and NPC Forecast
modules' own data (no separate mapping): budget and SAP actuals come from the
NPC Monitoring import rows for each SBU, and the remaining-month forecast from
NpcForecastEntry keyed by budget code.

Only YTD and Annual views - the NPC sources carry no monthly budget and no
prior-year actuals, so Last Year and monthly/quarterly comparisons don't apply.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import AuthedUser, get_current_user
from ..db import get_session
from ..models_phase1 import NpcForecastEntry

from ..models_phase4 import ReportAccessGrant
from ..models_npc_monitoring import NpcMonitoringIo
from ..models_sap_raw import SapFbl3nRaw, SapSalrRaw
from .utilization import _npc_utilization_from_monitoring_import

router = APIRouter(prefix="/reports", tags=["reports"])

NPC_SBUS = ["MALLS", "OFFICES", "ESTATES", "RESIDENTIAL", "LEISURE", "CORPORATE_IT", "CORPORATE_HR", "CORPORATE_ADMIN"]


class NpcSbuRowOut(BaseModel):
    sbu: str
    budget: float  # ORIGINAL BOARD - the NPC approved amount
    committed: float  # open PR/PO - SAP's S_ALR Committed, summed per SBU
    actual: float  # SAP's S_ALR Actual, summed per SBU
    forecastAnnual: float  # Actual + the remaining-month forecast


class NpcReportOut(BaseModel):
    fiscalYear: int
    asOfMonth: int
    rows: list[NpcSbuRowOut]


def _can_view(user: AuthedUser, session: Session) -> bool:
    if user.has_role("BUDGET_OFFICER") or (user.access is not None and user.can("reports", False)):
        return True
    return session.exec(select(ReportAccessGrant).where(ReportAccessGrant.user_id == user.id)).first() is not None


@router.get("/npc-report", response_model=NpcReportOut)
def npc_report(
    fiscalYear: int = 2026,
    asOfMonth: int | None = None,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from fastapi import HTTPException, status

    if not _can_view(user, session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You don't have access to reports.")

    if asOfMonth is None:
        # Default: the latest month with posted FBL3N actuals for the year (same rule as the GAE report).
        months = [r.month for r in session.exec(select(SapFbl3nRaw).where(SapFbl3nRaw.fiscal_year == fiscalYear)).all() if r.amount]
        asOfMonth = max(months) if months else 12
    as_of = max(1, min(12, asOfMonth))
    remaining_by_code: dict[str, float] = {}
    for entry in session.exec(select(NpcForecastEntry).where(NpcForecastEntry.fiscalYear == fiscalYear)).all():
        remaining_by_code[entry.budgetCode] = sum(
            float(v or 0) for m, v in (entry.monthlyRemainingForecast or {}).items() if str(m).isdigit() and int(m) > as_of
        )

    salr_by_aufnr = {(r.aufnr.lstrip("0") or "0"): r for r in session.exec(select(SapSalrRaw).where(SapSalrRaw.fiscal_year == fiscalYear)).all()}

    rows: list[NpcSbuRowOut] = []
    for sbu in NPC_SBUS:
        imported = _npc_utilization_from_monitoring_import(session, fiscalYear, sbu, as_of) or []
        budget = sum(r.amount for r in imported)
        actual = sum(r.actual or 0 for r in imported)
        remaining = sum(remaining_by_code.get(r.budgetCode, 0) for r in imported)
        # Committed comes from the same S_ALR cache as the table's IO figures,
        # falling back to the Monitoring workbook's own value per IO.
        committed = 0.0
        for io in session.exec(select(NpcMonitoringIo).where(NpcMonitoringIo.fiscal_year == fiscalYear, NpcMonitoringIo.npc_sbu == sbu)).all():
            row = salr_by_aufnr.get(io.aufnr.lstrip("0") or "0")
            committed += row.committed if row is not None else io.committed
        rows.append(
            NpcSbuRowOut(
                sbu=sbu,
                budget=round(budget, 2),
                committed=round(committed, 2),
                actual=round(actual, 2),
                forecastAnnual=round(actual + remaining, 2),
            )
        )
    return NpcReportOut(fiscalYear=fiscalYear, asOfMonth=as_of, rows=rows)
