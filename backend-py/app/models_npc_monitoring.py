"""NPC Forecast's temporary 2026-only data source (see
app/import_npc_monitoring.py). Confirmed with the user: fiscal year 2026's
real NPC Budget/IO Budget/IO Actual never went through this app's own New
Request/Internal Order Request workflow (that data predates/runs outside
this system for 2026), and the SAP broker key we have only covers one
Controlling Area (OCLP) - not enough to cover every SBU's real IOs. The
user's own NPC Monitoring workbook (refreshed monthly, re-imported by
re-running the script against that month's file) is the real source of
truth for 2026 instead.

Deliberately NOT modeled as BudgetRequest/FinalizedBudgetLine/
InternalOrderRequest rows - those need a real requestor, cost center,
project dates, and review stage that these already-approved external
projects never had, and backdating fake ones would pollute Module 3's live
Inbox/reporting with entries that never went through review. This is a
separate, clearly-external snapshot instead; routers/utilization.py's
npc_utilization prefers it over the live workflow tables only for the
fiscal year(s) it actually covers, so 2027 onward (once real workflow data
exists) falls straight back to the normal path with no code change needed.

Same registry as the rest of Phase 3 (TransferRequest/InternalOrderRequest)
since this is NPC/IO-adjacent reference data, not a new domain of its own.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import JSON, Column
from sqlmodel import Field

from .models_phase3 import Phase3Model


class NpcMonitoringProject(Phase3Model, table=True):
    """One row per approved NPC project (one per Budget Code), imported from
    the workbook's per-SBU tabs. `revised_amount` is Amount minus Cut -
    confirmed with the user as the correct "NPC Budget" figure (matches this
    app's own proposedAmount-minus-budgetCutAmount convention elsewhere).
    """

    __tablename__ = "npc_monitoring_project"

    id: Optional[int] = Field(default=None, primary_key=True)
    fiscal_year: int = Field(index=True)
    # The existing 8-value NPC SBU code (see npc_sbu.py) - MALLS/OFFICES/
    # ESTATES/RESIDENTIAL/LEISURE/CORPORATE_IT/CORPORATE_HR/CORPORATE_ADMIN.
    npc_sbu: str = Field(index=True)
    budget_code: str = Field(index=True)
    project_title: str
    revised_amount: float
    source_file: str
    imported_at: datetime = Field(default_factory=datetime.utcnow)


class NpcMonitoringIo(Phase3Model, table=True):
    """One row per real SAP Internal Order, imported from the workbook's
    Monitoring tab. A Budget Code can fund more than one IO (same convention
    as InternalOrderRequest.npc_budget_code), so ioBudget/ioActual are
    summed across every row sharing one budget_code - see
    routers/utilization.py's npc_utilization.
    """

    __tablename__ = "npc_monitoring_io"

    id: Optional[int] = Field(default=None, primary_key=True)
    fiscal_year: int = Field(index=True)
    npc_sbu: str = Field(index=True)
    # 12-digit zero-padded, matching SalrRow.AUFNR's own convention (see
    # backend/src/lib/sapBroker.ts) even though this row didn't come from
    # the broker - keeps the shape consistent for any future direct
    # comparison against a live SALR pull.
    aufnr: str = Field(index=True)
    # Null for "Carry-over" IOs with no current-cycle Budget Code - these
    # can't be attributed to any project's IO Budget/Actual, so
    # import_npc_monitoring.py skips creating a row for them entirely
    # (this field is never actually null in practice; kept Optional only
    # because the underlying workbook column can be blank).
    budget_code: Optional[str] = Field(default=None, index=True)
    io_description: str
    budget: float
    actual: float
    committed: float
    allotted: float
    available: float
    # Only set for a Carry-over IO (budget_code is None) that also has its
    # own row in an SBU tab (keyed there by its own AUFNR instead of a real
    # Budget Code, since it never got one) - that row's own Revised (Amount
    # minus Cut) figure, the same source every other project's NPC Budget
    # comes from. Preferred over `budget` (the Monitoring tab's live SAP
    # figure) for a Carry-over row's NPC Budget, so it's computed the same
    # way as every other project's instead of substituting a live SAP
    # release amount that can genuinely differ from the approved figure
    # (confirmed against AUFNR 10001294: SBU tab Revised PHP 3,660,714.29
    # vs Monitoring tab Budget PHP 4,560,714.29, same project) - `budget`
    # remains the row's own IO Budget for its own column, unaffected.
    carry_over_revised_amount: Optional[float] = Field(default=None)
    # The Monitoring tab's own "Group" column (e.g. "Malls Improvements",
    # "Parking") - shown in the NPC table where Location used to be.
    group_name: Optional[str] = Field(default=None)
    # The Monitoring tab's own "YTD Forecast" block (one cumulative-through-
    # that-month figure per month, columns 48-59) - despite the "Forecast"
    # label, its value for an already-elapsed month matches this same row's
    # single `actual` figure exactly (confirmed against several rows: e.g.
    # AUFNR 10001294's YTD Forecast through Aug/Sep both equal PHP
    # 4,253,567.60, the same as its own `actual`), so it's used as "IO
    # Actual through month X" per the user's request that IO Actual track
    # the Budget Officer's own "YTD Actual through" selection - keyed "1".."12"
    # (string, JSON-serialized), None for a fiscal year/file where this
    # block wasn't present. Falls back to `actual` when the requested month
    # has no entry here.
    ytd_actual_by_month: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    source_file: str
    imported_at: datetime = Field(default_factory=datetime.utcnow)
