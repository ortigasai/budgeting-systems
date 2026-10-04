"""Read-only shadow models for tables owned by the Node/Prisma backend
(`backend/prisma/schema.prisma`). Never written to from here, and never part
of Alembic's autogenerate scope (see alembic/env.py) - Prisma's own migration
history is the only thing that ever changes these tables' shape.

Field names deliberately mirror Prisma's exact camelCase column names (e.g.
`departmentId`, not `department_id`) rather than following PEP8, since these
are 1:1 mirrors of an externally-owned schema, not idiomatic Python domain
models. Table/column casing was confirmed against the live dev database
(`\\d "BudgetRequest"`) - Prisma quotes every identifier, so Postgres
preserves exact case; SQLAlchemy auto-quotes any non-lowercase identifier the
same way, so no explicit name overrides are needed except where noted below.
"""

# Python 3.14 made annotations lazy by default (PEP 649), which the
# pydantic/SQLModel versions available at build time don't yet handle -
# every field raises "requires a type annotation" without this. Needed in
# every module that defines a SQLModel/pydantic class; drop it once
# pydantic ships real 3.14 support.
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Column, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import registry as sa_registry
from sqlmodel import Field, SQLModel

# Separate registry/metadata from the Phase 2 models (app/models_phase2.py) -
# this is what keeps these tables structurally invisible to Alembic, which is
# only ever pointed at the Phase 2 registry's metadata.
phase1_registry = sa_registry()

# Prisma-created Postgres enum columns (currentStage, roleType, etc.) read
# back fine as plain strings (Postgres serializes enums as text over the
# wire), so these fields are declared as bare `str` below - no custom column
# type needed for SELECT. WHERE-clause comparisons need one extra step
# though: Postgres won't compare a native enum column against a plain
# varchar bind param. Query call sites handle that with
# `sqlalchemy.cast(Model.col, String) == "VALUE"` (see enum_eq() in
# app/db.py) rather than this file hardcoding every enum's member list,
# which would just be a second copy of schema.prisma to keep in sync.


class Phase1Model(SQLModel, registry=phase1_registry):
    pass


class Department(Phase1Model, table=True):
    __tablename__ = "Department"

    id: str = Field(primary_key=True)
    name: str
    # `type` shadows the Python builtin - renamed on the Python side only,
    # still maps to the real "type" column.
    type_: str = Field(sa_column=Column("type", String))
    createdAt: datetime
    # Spec item 13: which NPC SBU this department belongs to (Node-owned,
    # admin-assigned - see backend/src/routes/admin.ts's PATCH
    # /admin/departments/:id). Drives Budget Utilization Tracking's NPC view
    # scoping (routers/utilization.py).
    sbu: Optional[str] = None


class User(Phase1Model, table=True):
    __tablename__ = "User"

    id: str = Field(primary_key=True)
    name: str
    email: str
    passwordHash: Optional[str] = None
    employeeIdNumber: Optional[int] = None
    departmentId: Optional[str] = None
    createdAt: datetime


class RoleAssignment(Phase1Model, table=True):
    __tablename__ = "RoleAssignment"

    id: str = Field(primary_key=True)
    departmentId: str
    roleType: str
    userId: str
    assignedById: Optional[str] = None
    effectiveDate: datetime
    createdAt: datetime


class SbuRoleAssignment(Phase1Model, table=True):
    __tablename__ = "SbuRoleAssignment"

    id: str = Field(primary_key=True)
    sbu: str
    roleType: str
    userId: str
    assignedById: Optional[str] = None
    effectiveDate: datetime
    createdAt: datetime


class Company(Phase1Model, table=True):
    __tablename__ = "Company"

    id: str = Field(primary_key=True)
    code: str
    name: str
    # SAP Requirements integration - admin-mapped SAP Cost Center that funds
    # this company's KSSB V1 pull (see sap_raw_sync_service.py's
    # sync_kssb_v1_raw). Null until mapped, same as the Node side.
    costCenter: Optional[str] = None


class UserGroupMembership(Phase1Model, table=True):
    """Read-only mirror of the Node-owned access-group membership table (User
    Management workbook) - only read here, to scope NPC views by the NPC SBU
    the person belongs to."""

    __tablename__ = "UserGroupMembership"

    id: str = Field(primary_key=True)
    userId: str
    group: str
    scope: str


class PayComponent(Phase1Model, table=True):
    __tablename__ = "PayComponent"

    id: str = Field(primary_key=True)
    name: str
    # SAP Requirements integration - admin-mapped SAP GL Account that funds
    # this pay component's KSSB V1 pull (see sap_raw_sync_service.py's
    # sync_kssb_v1_raw). Null until mapped, same as the Node side.
    glAccount: Optional[str] = None


class FiscalCycleConfig(Phase1Model, table=True):
    """Singleton row (id="singleton") - the Budget Officer's Target Calendar
    Year/cycle-open switch and the two "YTD Actual through" cutoffs (see
    backend/src/lib/fiscalCycle.ts). Read here only to derive the current
    forecastYear (targetCalendarYear - 1) for the automatic SAP sync
    schedule (see services/sap_sync_service.py) - never written to from
    this side.
    """

    __tablename__ = "FiscalCycleConfig"

    id: str = Field(primary_key=True)
    asOfMonth2026: int
    npcAsOfMonth2026: int
    targetCalendarYear: int
    cycleOpen: bool
    updatedBy: Optional[str] = None
    updatedAt: datetime


class SapSyncLock(Phase1Model, table=True):
    """DELIBERATE EXCEPTION to this file's own "read-only shadow model" rule
    (see the module docstring above) - unlike every other model in this
    file, this one IS written to from here. It's a single global mutex (one
    row, id "global") shared with the Node backend's own SapSyncStatus/
    SapSyncLock (backend/prisma/schema.prisma, migrated there - Python's
    copy here stays outside Alembic's autogenerate scope the same way every
    other table in this file already does), claimed by whichever of the
    three scheduled sync jobs (Node's "historicalActuals"/"manpower",
    Python's combined "sap" job here) starts first and released when it
    finishes - see services/sap_sync_service.py's run_scheduled_sync. Not
    owned by either backend individually, which is exactly why it needs to
    be genuinely dual-write instead of a one-directional mirror.
    """

    __tablename__ = "SapSyncLock"

    id: str = Field(primary_key=True, default="global")
    heldBy: Optional[str] = None
    heldAt: Optional[datetime] = None


class ExpenseLineItem(Phase1Model, table=True):
    __tablename__ = "ExpenseLineItem"

    id: str = Field(primary_key=True)
    name: str
    category: str
    description: Optional[str] = None
    glAccount: str
    costCenter: str
    ownerDepartmentId: str
    companyId: Optional[str] = None
    requiresMobilePolicy: bool
    sampleCharges: Optional[str] = None
    spendGridComputation: Optional[str] = None
    spendGridFrequency: Optional[str] = None
    visibleToDepartmentId: Optional[str] = None
    isCustom: bool
    status: str
    extraFieldsConfig: list = Field(sa_column=Column("extraFieldsConfig", JSONB))
    # GAE's pre-computed "CD-YY-Num" Budget Code (see lib/budgetCode.ts on
    # the Node side) - the reconciliation matching key, along with GL-CC.
    budgetCode: Optional[str] = None
    managedBy: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime


class HistoricalActuals(Phase1Model, table=True):
    """Forecast module's per-line-item reference row (Node-owned). Field
    names are frozen to whichever Target Calendar Year the cycle was built
    for (e.g. `ytdActuals2026`) rather than being genuinely year-keyed -
    Phase 4's report treats these as "this row's current-cycle forecast",
    not a real point in a multi-year series (see routers/reports.py).
    """

    __tablename__ = "HistoricalActuals"

    id: str = Field(primary_key=True)
    departmentId: str
    fiscalYear: int
    expenseLineItemId: Optional[str] = None
    glAccount: str
    costCenter: str
    glDescription: str
    budgetCode: Optional[str] = None
    expenseCategory: Optional[str] = None
    requestCategory: str
    actuals2025: float
    approvedBudget2026: float
    ytdActuals2026: float
    monthlyRemainingForecast2026: dict = Field(sa_column=Column("monthlyRemainingForecast2026", JSONB))
    forecastCompletedAt: Optional[datetime] = None
    updatedAt: datetime


class BudgetRequest(Phase1Model, table=True):
    __tablename__ = "BudgetRequest"

    id: str = Field(primary_key=True)
    departmentId: str
    fiscalYear: int
    expenseLineItemId: str
    monthlyAmounts: list = Field(sa_column=Column("monthlyAmounts", JSONB))
    proposedAmount: float
    businessJustification: str
    otherRequiredFields: dict = Field(sa_column=Column("otherRequiredFields", JSONB))
    currentStage: str
    status: str
    budgetCutAmount: float
    isOverBudget: bool
    requiresCfoApproval: bool
    requestCategory: str
    sbu: Optional[str] = None
    npcHeadCode: Optional[str] = None
    # NPC (spec item 12 revision) fields - see backend/prisma/schema.prisma.
    npcSbu: Optional[str] = None
    npcLocation: Optional[str] = None
    projectTitle: Optional[str] = None
    projectStartDate: Optional[datetime] = None
    projectEndDate: Optional[datetime] = None
    # DOE/NPC's generated "SBU-YY-Num" Budget Code - null for GAE (use the
    # line item's own budgetCode instead) and Revenue.
    budgetCode: Optional[str] = None
    reasonCode: Optional[str] = None
    sapDocumentNumber: Optional[str] = None
    createdById: str
    bulkUploadBatchId: Optional[str] = None
    createdAt: datetime
    updatedAt: datetime


class FinalizedBudgetLine(Phase1Model, table=True):
    """Note 11 - the one place every 'what's the approved/current budget for
    this CC-GL' reader in this service now queries (see
    services/budget_balance.py, routers/utilization.py, routers/reports.py),
    replacing the old BudgetRequest(currentStage=APPROVED) + ExpenseLineItem
    join. Node-owned (written by workflowService.ts's finalizeAtStep5 /
    revenueBatchDecision), mirrored read-only here like every other
    Phase-1 table.
    """

    __tablename__ = "FinalizedBudgetLine"

    id: str = Field(primary_key=True)
    budgetRequestId: str
    fiscalYear: int
    requestCategory: str
    sbu: Optional[str] = None
    npcSbu: Optional[str] = None
    glAccount: str
    costCenter: str
    amount: float
    sapDocumentNumber: Optional[str] = None
    finalizedAt: datetime
    finalizedById: str


class NpcForecastEntry(Phase1Model, table=True):
    """NPC Forecast module's per-budget-code remaining-month forecast (Node-owned,
    read-only here). Keyed by calendar month (1-12), like HistoricalActuals.
    """

    __tablename__ = "NpcForecastEntry"

    id: str = Field(primary_key=True)
    budgetCode: str
    fiscalYear: int
    monthlyRemainingForecast: dict = Field(sa_column=Column("monthlyRemainingForecast", JSONB))
