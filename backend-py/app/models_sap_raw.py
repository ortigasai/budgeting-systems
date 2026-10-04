"""Local cache of the SAP broker's own raw reports (FBL3N, KSSB V1, KSSB V2,
SALR) - one row per broker row, close to as-received (padding stripped, per
the same convention every existing consumer already applies), not yet
aggregated/mapped to any particular module's own shape.

Why this exists: before this, three separate places independently called the
broker for overlapping data - Utilization's own sync (FBL3N + KSSB V2, all
admin Cost Centers), Forecast GAE/DOE's own sync (FBL3N again, just a
narrower Cost Center subset - the STANDARD catalog's own), and NPC
Forecast/Internal Order Requests both pulling SALR live on every request.
Now there's one scheduled job (services/sap_raw_sync_service.py) that pulls
each report ONCE, for the widest Cost Center/GL Account set any consumer
needs, into these tables - every consumer's own "mapping" step (turning raw
rows into SapActualTransaction/HistoricalActuals/ManpowerEntry/etc.) reads
from here instead, which is both faster (no broker round-trip) and no longer
subject to the broker's own rate limit at read time.

Fetched by Python only (this backend already touched more of these reports
than Node did, and it's simpler to have one owner) - Node's own mapping
functions (historicalActualsService.ts, manpowerService.ts) read this cache
over HTTP instead (see routers/sap_cache.py), the same cross-backend-read
pattern app/models_phase1.py's shadow models already use in the other
direction.

Phase2-owned (same registry as SapActualTransaction/SapCommitment/
SapSyncStatus) - genuinely this backend's own tables, Alembic-managed.
"""

from __future__ import annotations

from typing import Optional

from sqlmodel import Field

from .models_phase2 import Phase2Model


class SapFbl3nRaw(Phase2Model, table=True):
    """budget_fbl3n - one row per real G/L posting. Replaces
    SapActualTransaction's/HistoricalActuals' own direct broker calls.
    """

    __tablename__ = "sap_fbl3n_raw"

    id: Optional[int] = Field(default=None, primary_key=True)
    gl_account: str = Field(index=True)
    cost_center: str = Field(index=True)
    fiscal_year: int = Field(index=True)
    month: int  # 1-12
    item_text: str
    amount: float


class SapKssbV1Raw(Phase2Model, table=True):
    """budget_kssb_v1 - Actual-only, per (KSTAR, ProfitCenter, PostingPeriod).
    Replaces Manpower's own direct broker call. Scoped the same way
    manpowerService.ts's own fetch already was (admin-mapped PayComponent GL
    Accounts x Company Cost Centers) - KSSB V1 has only ever had this one
    consumer, so there's no wider set another consumer would need.
    """

    __tablename__ = "sap_kssb_v1_raw"

    id: Optional[int] = Field(default=None, primary_key=True)
    gl_account: str = Field(index=True)
    cost_center: str = Field(index=True)
    fiscal_year: int = Field(index=True)
    month: int
    amount: float


class SapKssbV2Raw(Phase2Model, table=True):
    """budget_kssb_v2 - per (KOSTL, CostElements, PostingPeriod), Commitment
    field only (the only field any consumer reads). Replaces
    SapCommitment's own direct broker call.
    """

    __tablename__ = "sap_kssb_v2_raw"

    id: Optional[int] = Field(default=None, primary_key=True)
    gl_account: str = Field(index=True)
    cost_center: str = Field(index=True)
    fiscal_year: int = Field(index=True)
    month: int
    commitment: float
    # SAP's own approved budget (Plan) for this period - summed across the
    # year it is the approved annual budget per GL-CC (Utilization Overview).
    plan: float = 0.0


class SapSalrRaw(Phase2Model, table=True):
    """S_ALR_87013019 - one row per Internal Order (AUFNR), already fully
    computed by SAP. Replaces NPC Forecast's and Internal Order Requests'
    own live-per-request broker calls (both used to hit the broker inline on
    every single page load/request - this is the one report where that was
    especially wasteful, since it's the same ~174-row table every time).
    """

    __tablename__ = "sap_salr_raw"

    id: Optional[int] = Field(default=None, primary_key=True)
    aufnr: str = Field(index=True)
    fiscal_year: int = Field(index=True)
    budget: float
    actual: float
    committed: float
    allotted: float
    available: float


class SapGaePastActualRaw(Phase2Model, table=True):
    """sap_gae_past_actual_raw - prior-year GAE actuals per (cost center, GL,
    month), loaded from "Budgeting System_GAE Past Years Actual.xlsx" (its
    2025A-01..12 columns). Used by the GAE report's Last Year comparisons.
    """

    __tablename__ = "sap_gae_past_actual_raw"

    id: Optional[int] = Field(default=None, primary_key=True)
    cost_center: str = Field(index=True)
    gl_account: str = Field(index=True)
    fiscal_year: int = Field(index=True)
    month: int  # 1-12
    amount: float


class GaeCcGlMapping(Phase2Model, table=True):
    """gae_cc_gl_mapping - the GAE report's CC-GL Mapping tab, one row per
    (cost center, GL account): Manpower/Non-Manpower flag, Main Report type
    and Detailed Report sub type.
    """

    __tablename__ = "gae_cc_gl_mapping"

    id: Optional[int] = Field(default=None, primary_key=True)
    cost_center: str = Field(index=True)
    gl_account: str = Field(index=True)
    manpower: str  # "Manpower" | "Non-Manpower"
    type: str
    sub_type: str = ""
