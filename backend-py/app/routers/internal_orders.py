"""Phase 3 — Internal Order Requests (Functional Spec update, items 8/9).

A parallel request type to TransferRequest: requesting the creation of an
Internal Order in SAP, optionally alongside a request to fund it (additional
budget / reallocation from an existing NPC or IO budget code) when it isn't
already NPC-budgeted. "The approval flow is same as in budget reallocation" -
this file has its own copy of the classification-routed DOE/GAE stage
machine transfers.py originally used (STAGE_ROLE/RETURN_TARGET/
_is_eligible_for_stage below), since classification here is derived from the
chosen SBU rather than picked by a Budget Officer decision (see IO_SBU_INFO
below) - IO doesn't need a classification input in its decision body the way
TransferRequest's used to.

Not shared with transfers.py's own STAGE_ROLE any more: the Budget Transfer &
Reallocation workflow was revised to a different, amount-gated chain (see
routers/transfers.py's module docstring) that no longer matches this file's
DOE/GAE-branching one, so each keeps its own independent copy of the stage
machine even though the two happened to be identical before that revision.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import AuthedUser, get_current_user, require_role
from ..db import enum_eq, get_session
from ..models_phase1 import BudgetRequest, Department, User
from ..models_phase3 import InternalOrderRequest, IoLocation, IoReviewDecision
from ..models_sap_raw import SapSalrRaw

router = APIRouter(prefix="/internal-orders", tags=["internal-orders"])

# BU_* roles are SBU-scoped; CFO/BUDGET_OFFICER are unscoped, matching how
# CFO is already used company-wide in Phase 1.
STAGE_ROLE = {
    "DEPT_HEAD_REVIEW": "DEPARTMENT_HEAD",
    "BUDGET_OFFICER_VALIDATION": "BUDGET_OFFICER",
    "BU_FINANCE_HEAD_REVIEW": "BU_FINANCE_HEAD",
    "BU_HEAD_AUTHORIZATION": "BU_HEAD",
    "BU_FINANCE_OFFICER_VERIFICATION": "BU_FINANCE_OFFICER",
    "CFO_REVIEW": "CFO",
    "CFO_AUTHORIZATION": "CFO",
    "BUDGET_OFFICER_SAP_UPLOAD": "BUDGET_OFFICER",
}

# The stage each stream's decision RETURNs to (one step back within its own
# stream); DEPT_HEAD_REVIEW returns to DRAFT (handled separately in decide()).
RETURN_TARGET = {
    "BUDGET_OFFICER_VALIDATION": "DEPT_HEAD_REVIEW",
    "BU_FINANCE_HEAD_REVIEW": "BUDGET_OFFICER_VALIDATION",
    "BU_HEAD_AUTHORIZATION": "BU_FINANCE_HEAD_REVIEW",
    "BU_FINANCE_OFFICER_VERIFICATION": "BU_HEAD_AUTHORIZATION",
    "CFO_REVIEW": "BUDGET_OFFICER_VALIDATION",
    "CFO_AUTHORIZATION": "CFO_REVIEW",
    "BUDGET_OFFICER_SAP_UPLOAD": None,  # set per-stream once classification is known, see decide()
}

REVIEW_STAGES = set(STAGE_ROLE.keys())


def _is_eligible_for_stage(user: AuthedUser, io: InternalOrderRequest, stage: str) -> bool:
    role = STAGE_ROLE.get(stage)
    if role is None:
        return False
    if role == "DEPARTMENT_HEAD":
        return user.has_role(role, io.department_id)
    if role in ("BU_FINANCE_HEAD", "BU_HEAD", "BU_FINANCE_OFFICER"):
        return user.has_sbu_role(role, io.sbu)
    # CFO / BUDGET_OFFICER are unscoped.
    return user.has_role(role)

# Spec item 9's fixed 8-value SBU list for Internal Order Requests - distinct
# from the admin-configurable NPC_HEAD BudgetCodePrefix list (which splits
# Malls into GH/NonGH and isn't a 1:1 match), so kept as its own small fixed
# set rather than reused from there. The 5 regional entries route DOE (BU
# Finance stream), the 3 Corporate entries route GAE (CFO stream) - mirrors
# TransferRequest's classification concept, just derived instead of chosen.
IO_SBU_INFO: dict[str, tuple[str, str]] = {
    "MALLS": ("Malls", "DOE"),
    "OFFICES": ("Offices", "DOE"),
    "ESTATES": ("Estates", "DOE"),
    "RESIDENTIAL": ("Residential", "DOE"),
    "LEISURE": ("Leisure", "DOE"),
    "CORPORATE_IT": ("Corporate IT", "GAE"),
    "CORPORATE_HR": ("Corporate HR", "GAE"),
    "CORPORATE_ADMIN": ("Corporate Admin", "GAE"),
}


class IoLocationIn(BaseModel):
    code: str
    label: str
    sortOrder: int = 0


class IoLocationOut(BaseModel):
    id: int
    code: str
    label: str
    sortOrder: int


@router.get("/locations", response_model=list[IoLocationOut])
def list_locations(session: Session = Depends(get_session)):
    rows = session.exec(select(IoLocation).order_by(IoLocation.sort_order.asc())).all()
    return [IoLocationOut(id=r.id, code=r.code, label=r.label, sortOrder=r.sort_order) for r in rows]


@router.post("/locations", response_model=IoLocationOut, status_code=status.HTTP_201_CREATED)
def create_location(
    body: IoLocationIn,
    user: AuthedUser = Depends(require_role("BUDGET_OFFICER")),
    session: Session = Depends(get_session),
):
    existing = session.exec(select(IoLocation).where(IoLocation.code == body.code)).first()
    if existing is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A location with this code already exists.")
    loc = IoLocation(code=body.code, label=body.label, sort_order=body.sortOrder)
    session.add(loc)
    session.commit()
    session.refresh(loc)
    return IoLocationOut(id=loc.id, code=loc.code, label=loc.label, sortOrder=loc.sort_order)


@router.delete("/locations/{location_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_location(
    location_id: int,
    user: AuthedUser = Depends(require_role("BUDGET_OFFICER")),
    session: Session = Depends(get_session),
):
    loc = session.get(IoLocation, location_id)
    if loc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Location not found.")
    session.delete(loc)
    session.commit()


class InternalOrderRequestIn(BaseModel):
    fiscalYear: int
    sbu: str
    location: str
    projectTitle: str
    projectStart: date
    projectEnd: date
    amount: float
    costCenter: str
    isBudgeted: bool
    npcBudgetCode: str | None = None
    requestType: str | None = None  # "REALLOCATION" | "SUPPLEMENT"
    reallocationSourceType: str | None = None  # "NPC_BUDGET" | "IO_BUDGET"
    reallocationNpcBudgetCode: str | None = None
    reallocationIoBudgetCode: str | None = None


class IoReviewDecisionOut(BaseModel):
    id: int
    stage: str
    decision: str
    comment: str | None
    timestamp: datetime
    decidedByName: str


class InternalOrderRequestOut(BaseModel):
    id: int
    requestorId: str
    requestorName: str
    departmentId: str
    departmentName: str
    fiscalYear: int
    sbu: str
    sbuLabel: str
    classification: str
    routingStream: str | None
    location: str
    projectTitle: str
    projectStart: date
    projectEnd: date
    amount: float
    costCenter: str
    isBudgeted: bool
    npcBudgetCode: str | None
    requestType: str | None
    reallocationSourceType: str | None
    reallocationNpcBudgetCode: str | None
    reallocationIoBudgetCode: str | None
    currentStage: str
    status: str
    sapDocumentNumber: str | None
    createdAt: datetime
    updatedAt: datetime
    reviewDecisions: list[IoReviewDecisionOut] = []


def _to_out(session: Session, io: InternalOrderRequest, *, with_detail: bool = False) -> InternalOrderRequestOut:
    requestor = session.get(User, io.requestor_id)
    department = session.get(Department, io.department_id)
    sbu_label = IO_SBU_INFO.get(io.sbu, (io.sbu, io.classification))[0]

    decisions_out: list[IoReviewDecisionOut] = []
    if with_detail:
        decisions = session.exec(
            select(IoReviewDecision)
            .where(IoReviewDecision.internal_order_request_id == io.id)
            .order_by(IoReviewDecision.timestamp.asc())
        ).all()
        for d in decisions:
            decider = session.get(User, d.decided_by_id)
            decisions_out.append(
                IoReviewDecisionOut(
                    id=d.id,
                    stage=d.stage,
                    decision=d.decision,
                    comment=d.comment,
                    timestamp=d.timestamp,
                    decidedByName=decider.name if decider else "—",
                )
            )

    return InternalOrderRequestOut(
        id=io.id,
        requestorId=io.requestor_id,
        requestorName=requestor.name if requestor else "—",
        departmentId=io.department_id,
        departmentName=department.name if department else "—",
        fiscalYear=io.fiscal_year,
        sbu=io.sbu,
        sbuLabel=sbu_label,
        classification=io.classification,
        routingStream=io.routing_stream,
        location=io.location,
        projectTitle=io.project_title,
        projectStart=io.project_start.date() if isinstance(io.project_start, datetime) else io.project_start,
        projectEnd=io.project_end.date() if isinstance(io.project_end, datetime) else io.project_end,
        amount=io.amount,
        costCenter=io.cost_center,
        isBudgeted=io.is_budgeted,
        npcBudgetCode=io.npc_budget_code,
        requestType=io.request_type,
        reallocationSourceType=io.reallocation_source_type,
        reallocationNpcBudgetCode=io.reallocation_npc_budget_code,
        reallocationIoBudgetCode=io.reallocation_io_budget_code,
        currentStage=io.current_stage,
        status=io.status,
        sapDocumentNumber=io.sap_document_number,
        createdAt=io.created_at,
        updatedAt=io.updated_at,
        reviewDecisions=decisions_out,
    )


def _get_or_404(session: Session, io_id: int) -> InternalOrderRequest:
    io = session.get(InternalOrderRequest, io_id)
    if io is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Internal Order request not found.")
    return io


def _assert_io_access(user: AuthedUser, io: InternalOrderRequest) -> None:
    if io.requestor_id == user.id:
        return
    if _is_eligible_for_stage(user, io, io.current_stage):  # type: ignore[arg-type]
        return
    if any(_is_eligible_for_stage(user, io, stage) for stage in REVIEW_STAGES):  # type: ignore[arg-type]
        return
    raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have access to this Internal Order request.")


def _assert_approved_npc_code(session: Session, code: str) -> None:
    row = session.exec(
        select(BudgetRequest).where(
            enum_eq(BudgetRequest.requestCategory, "NPC"),
            enum_eq(BudgetRequest.currentStage, "APPROVED"),
            BudgetRequest.budgetCode == code,
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f'"{code}" is not an approved NPC budget code.')


class SalrOptionOut(BaseModel):
    aufnr: str
    description: str
    budget: float
    available: float


@router.get("/salr-options", response_model=list[SalrOptionOut])
def salr_options(fiscalYear: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    """S_ALR_87013019-backed options for the "IO Budget" reallocation source
    (spec: "IO Budget should have a dropdown list of the created IO in
    SAP... This needs an automatic pull of data from SAP") - each Internal
    Order's own Budget/Available, one row per AUFNR, read from the local
    SapSalrRaw cache (sap_raw_sync_service.py keeps it fresh) instead of
    hitting the broker on every request.

    `fiscalYear` is the current calendar year Internal Order Request is
    scoped to (Module 3 - reallocating already-in-force budget, not next
    year's ask), which is also the only year real SALR postings can exist for.
    """
    rows = session.exec(select(SapSalrRaw).where(SapSalrRaw.fiscal_year == fiscalYear)).all()
    options = [
        SalrOptionOut(
            aufnr=row.aufnr,
            description=row.aufnr,
            budget=row.budget,
            available=row.available,
        )
        for row in rows
    ]
    return sorted(options, key=lambda o: o.description)


def _find_salr_row(session: Session, fiscal_year: int, aufnr: str) -> SapSalrRaw | None:
    """`fiscal_year` is the IO's own current-year scope, same as
    salr_options() above.
    """
    rows = session.exec(select(SapSalrRaw).where(SapSalrRaw.fiscal_year == fiscal_year)).all()
    stripped = aufnr.lstrip("0") or "0"
    for row in rows:
        if row.aufnr == aufnr or (row.aufnr.lstrip("0") or "0") == stripped:
            return row
    return None


def _assert_salr_available(session: Session, fiscal_year: int, aufnr: str, amount: float) -> None:
    """Mirrors _assert_approved_npc_code's existence-check shape, plus a
    balance check against the cached SALR Available (see salr_options above
    for why this reads the local cache instead of the broker directly).
    """
    row = _find_salr_row(session, fiscal_year, aufnr)
    if row is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f'"{aufnr}" is not a recognized Internal Order in SAP for {fiscal_year}.')
    if amount > row.available:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f'Internal Order "{aufnr}" only has {row.available:,.0f} available in SAP, less than the requested {amount:,.0f}.',
        )


@router.post("", response_model=InternalOrderRequestOut, status_code=status.HTTP_201_CREATED)
def create_internal_order(
    body: InternalOrderRequestIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not user.departmentId:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Your account has no department on file.")
    if body.sbu not in IO_SBU_INFO:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unrecognized SBU.")
    # NPC-group members (User Management workbook) may only raise IOs for their own NPC SBU(s).
    if not user.has_role("BUDGET_OFFICER"):
        from .utilization import _my_npc_sbus

        own = [g for g, _ in user.groups if g == "NPC"] and _my_npc_sbus(user, session)
        if own and body.sbu not in own:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only request Internal Orders for your own NPC SBU.")
    if session.exec(select(IoLocation).where(IoLocation.code == body.location)).first() is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unrecognized Location.")

    if body.isBudgeted:
        if not body.npcBudgetCode:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "npcBudgetCode is required when the IO is already budgeted.")
        _assert_approved_npc_code(session, body.npcBudgetCode)
    else:
        if body.requestType not in ("REALLOCATION", "SUPPLEMENT"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, 'requestType must be "REALLOCATION" or "SUPPLEMENT" when not already budgeted.')
        if body.requestType == "REALLOCATION":
            if body.reallocationSourceType not in ("NPC_BUDGET", "IO_BUDGET"):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, 'reallocationSourceType must be "NPC_BUDGET" or "IO_BUDGET".')
            if body.reallocationSourceType == "NPC_BUDGET":
                if not body.reallocationNpcBudgetCode:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, "reallocationNpcBudgetCode is required for an NPC Budget reallocation source.")
                _assert_approved_npc_code(session, body.reallocationNpcBudgetCode)
            elif body.reallocationSourceType == "IO_BUDGET":
                if not body.reallocationIoBudgetCode:
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, "reallocationIoBudgetCode is required for an IO Budget reallocation source.")
                _assert_salr_available(session, body.fiscalYear, body.reallocationIoBudgetCode, body.amount)

    _, classification = IO_SBU_INFO[body.sbu]
    io = InternalOrderRequest(
        requestor_id=user.id,
        department_id=user.departmentId,
        fiscal_year=body.fiscalYear,
        sbu=body.sbu,
        classification=classification,
        location=body.location,
        project_title=body.projectTitle,
        project_start=datetime.combine(body.projectStart, datetime.min.time()),
        project_end=datetime.combine(body.projectEnd, datetime.min.time()),
        amount=body.amount,
        cost_center=body.costCenter,
        is_budgeted=body.isBudgeted,
        npc_budget_code=body.npcBudgetCode if body.isBudgeted else None,
        request_type=None if body.isBudgeted else body.requestType,
        reallocation_source_type=body.reallocationSourceType if not body.isBudgeted and body.requestType == "REALLOCATION" else None,
        reallocation_npc_budget_code=body.reallocationNpcBudgetCode if not body.isBudgeted and body.reallocationSourceType == "NPC_BUDGET" else None,
        reallocation_io_budget_code=body.reallocationIoBudgetCode if not body.isBudgeted and body.reallocationSourceType == "IO_BUDGET" else None,
    )
    session.add(io)
    session.commit()
    session.refresh(io)
    return _to_out(session, io)


@router.post("/{io_id}/submit", response_model=InternalOrderRequestOut)
def submit_internal_order(
    io_id: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    io = _get_or_404(session, io_id)
    if io.requestor_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only submit your own requests.")
    if io.current_stage != "DRAFT" or io.status not in ("DRAFT", "RETURNED"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This request has already been submitted.")

    # Re-check the live SALR balance at submit time too (mirrors Transfer's
    # own submit-time re-check, transfers.py's submit_transfer) - the
    # Available balance can move between draft and submit.
    if io.reallocation_source_type == "IO_BUDGET" and io.reallocation_io_budget_code:
        _assert_salr_available(session, io.fiscal_year, io.reallocation_io_budget_code, io.amount)

    io.current_stage = "DEPT_HEAD_REVIEW"
    io.status = "IN_REVIEW"
    io.updated_at = datetime.utcnow()
    session.add(io)
    session.commit()
    session.refresh(io)
    return _to_out(session, io)


@router.get("/mine", response_model=list[InternalOrderRequestOut])
def my_internal_orders(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.exec(
        select(InternalOrderRequest).where(InternalOrderRequest.requestor_id == user.id).order_by(InternalOrderRequest.updated_at.desc())
    ).all()
    return [_to_out(session, io) for io in rows]


@router.get("/inbox", response_model=list[InternalOrderRequestOut])
def inbox(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    all_pending = session.exec(select(InternalOrderRequest).where(InternalOrderRequest.current_stage.in_(REVIEW_STAGES))).all()
    matches = [io for io in all_pending if io.status == "IN_REVIEW" and _is_eligible_for_stage(user, io, io.current_stage)]  # type: ignore[arg-type]
    matches.sort(key=lambda io: io.updated_at)
    return [_to_out(session, io) for io in matches]


@router.get("/reviewed-by-me", response_model=list[InternalOrderRequestOut])
def reviewed_by_me(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    decisions = session.exec(
        select(IoReviewDecision).where(IoReviewDecision.decided_by_id == user.id).order_by(IoReviewDecision.timestamp.desc())
    ).all()
    seen: set[int] = set()
    out: list[InternalOrderRequestOut] = []
    for d in decisions:
        if d.internal_order_request_id in seen:
            continue
        seen.add(d.internal_order_request_id)
        io = session.get(InternalOrderRequest, d.internal_order_request_id)
        if io:
            out.append(_to_out(session, io))
        if len(out) >= 20:
            break
    return out


@router.get("/{io_id}", response_model=InternalOrderRequestOut)
def get_internal_order(io_id: int, user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    io = _get_or_404(session, io_id)
    _assert_io_access(user, io)
    return _to_out(session, io, with_detail=True)


class DecisionIn(BaseModel):
    decision: str  # "APPROVE" | "REJECT" | "RETURN"
    comment: str | None = None


@router.post("/{io_id}/decision", response_model=InternalOrderRequestOut)
def decide(
    io_id: int,
    body: DecisionIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    io = _get_or_404(session, io_id)
    stage = io.current_stage
    if stage not in REVIEW_STAGES or io.status != "IN_REVIEW":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This request isn't awaiting a decision right now.")
    if not _is_eligible_for_stage(user, io, stage):  # type: ignore[arg-type]
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not permitted to act on this request at its current stage.")
    if body.decision not in ("APPROVE", "REJECT", "RETURN"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, 'decision must be "APPROVE", "REJECT", or "RETURN".')

    session.add(IoReviewDecision(internal_order_request_id=io.id, stage=stage, decision=body.decision, decided_by_id=user.id, comment=body.comment))

    if body.decision == "REJECT":
        io.status = "REJECTED"
    elif body.decision == "RETURN":
        if stage == "DEPT_HEAD_REVIEW":
            io.current_stage = "DRAFT"
            io.status = "RETURNED"
        else:
            target = RETURN_TARGET.get(stage)
            if stage == "BUDGET_OFFICER_SAP_UPLOAD":
                target = "BU_FINANCE_OFFICER_VERIFICATION" if io.classification == "DOE" else "CFO_AUTHORIZATION"
            io.current_stage = target
    else:  # APPROVE
        if stage == "BUDGET_OFFICER_VALIDATION":
            # Classification is already known (derived from sbu at creation),
            # so validation here just decides routing_stream and advances -
            # no classification input needed, unlike TransferRequest's.
            if io.classification == "DOE":
                io.routing_stream = "BU_FINANCE"
                io.current_stage = "BU_FINANCE_HEAD_REVIEW"
            else:
                io.routing_stream = "CORPORATE_FINANCE"
                io.current_stage = "CFO_REVIEW"
        elif stage == "BUDGET_OFFICER_SAP_UPLOAD":
            io.status = "UPLOADED_TO_SAP"
            io.current_stage = "APPROVED"
            io.sap_document_number = f"IO-{io.fiscal_year}-{uuid.uuid4().hex[:8].upper()}"
        else:
            next_stage = {
                "DEPT_HEAD_REVIEW": "BUDGET_OFFICER_VALIDATION",
                "BU_FINANCE_HEAD_REVIEW": "BU_HEAD_AUTHORIZATION",
                "BU_HEAD_AUTHORIZATION": "BU_FINANCE_OFFICER_VERIFICATION",
                "BU_FINANCE_OFFICER_VERIFICATION": "BUDGET_OFFICER_SAP_UPLOAD",
                "CFO_REVIEW": "CFO_AUTHORIZATION",
                "CFO_AUTHORIZATION": "BUDGET_OFFICER_SAP_UPLOAD",
            }[stage]
            io.current_stage = next_stage

    io.updated_at = datetime.utcnow()
    session.add(io)
    session.commit()
    session.refresh(io)
    return _to_out(session, io, with_detail=True)
