"""Phase 3 — Budget Transfer & Reallocation (workflow revision).

Linear approval chain, amount-gated at the top (no more DOE/GAE
classification split — the requestor picks the SBU directly at creation, so
routing is known up front):

  DRAFT -> DEPT_HEAD_REVIEW (the specific Dept Head the requestor chose at
  submit) -> SBU_FINANCE_OFFICER_REVIEW -> SBU_FINANCE_HEAD_APPROVAL ->
  SBU_HEAD_APPROVAL -> [amount <=1M: skip straight to Completion]
  [1M< amount <=5M: CFO_APPROVAL] [amount >5M: CFO_APPROVAL then
  CEO_APPROVAL] -> SBU_FINANCE_OFFICER_COMPLETION ->
  BUDGET_OFFICER_SAP_UPLOAD -> APPROVED.

RETURN from any review stage sends the ticket straight back to the requestor
(DRAFT/RETURNED) rather than one stage back. REJECT is a hard terminal from
any review stage. CANCEL is requestor-only, any time before a terminal
status. REASSIGN lets whoever is currently eligible for a stage hand the
pending decision to any named user for that ticket only (an ad hoc, one-off
delegate — it does not touch who holds the role generally); the override is
cleared the moment the stage advances. Response models use camelCase to
match the rest of this app's API surface.
"""

from __future__ import annotations

import io
import os
import uuid
from datetime import datetime

import openpyxl
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import AuthedUser, get_current_user
from ..db import enum_eq, get_session
from ..models_phase1 import Department, RoleAssignment, User
from ..models_phase3 import CostCenter, GlAccount, IoLocation, TransferAttachment, TransferRequest, TransferReviewDecision
from ..services.budget_balance import compute_gl_cc_available, compute_gl_cc_breakdown

router = APIRouter(prefix="/transfers", tags=["transfers"])

# Spec item 11's fixed 3-value Company list for New Transfer.
COMPANY_CODES = {"OLC", "OCC", "OCLP"}

CFO_THRESHOLD = 1_000_000
CEO_THRESHOLD = 5_000_000

# BU_* roles are SBU-scoped; CFO/CEO/BUDGET_OFFICER are unscoped, matching
# how CFO is already used company-wide elsewhere (has_role("CFO") call sites
# never pass a department id). DEPT_HEAD_REVIEW's "role" is only used for
# display/labels below — actual eligibility there is the specific user the
# requestor picked at submit, not "any Department Head".
STAGE_ROLE = {
    "DEPT_HEAD_REVIEW": "DEPARTMENT_HEAD",
    "SBU_FINANCE_OFFICER_REVIEW": "BU_FINANCE_OFFICER",
    "SBU_FINANCE_HEAD_APPROVAL": "BU_FINANCE_HEAD",
    "SBU_HEAD_APPROVAL": "BU_HEAD",
    "CFO_APPROVAL": "CFO",
    "CEO_APPROVAL": "CEO",
    "SBU_FINANCE_OFFICER_COMPLETION": "BU_FINANCE_OFFICER",
    "BUDGET_OFFICER_SAP_UPLOAD": "BUDGET_OFFICER",
}
SBU_SCOPED_STAGES = {"SBU_FINANCE_OFFICER_REVIEW", "SBU_FINANCE_HEAD_APPROVAL", "SBU_HEAD_APPROVAL", "SBU_FINANCE_OFFICER_COMPLETION"}
REVIEW_STAGES = set(STAGE_ROLE.keys())
TERMINAL_STATUSES = {"REJECTED", "CANCELLED", "UPLOADED_TO_SAP"}


def _stage_after_sbu_head(amount: float) -> str:
    return "CFO_APPROVAL" if amount > CFO_THRESHOLD else "SBU_FINANCE_OFFICER_COMPLETION"


def _stage_after_cfo(amount: float) -> str:
    return "CEO_APPROVAL" if amount > CEO_THRESHOLD else "SBU_FINANCE_OFFICER_COMPLETION"


def _next_stage(t: TransferRequest, stage: str) -> str:
    return {
        "DEPT_HEAD_REVIEW": "SBU_FINANCE_OFFICER_REVIEW",
        "SBU_FINANCE_OFFICER_REVIEW": "SBU_FINANCE_HEAD_APPROVAL",
        "SBU_FINANCE_HEAD_APPROVAL": "SBU_HEAD_APPROVAL",
        "SBU_HEAD_APPROVAL": _stage_after_sbu_head(t.amount),
        "CFO_APPROVAL": _stage_after_cfo(t.amount),
        "CEO_APPROVAL": "SBU_FINANCE_OFFICER_COMPLETION",
        "SBU_FINANCE_OFFICER_COMPLETION": "BUDGET_OFFICER_SAP_UPLOAD",
    }[stage]


class TransferRequestIn(BaseModel):
    fiscalYear: int
    type: str  # "REALLOCATION" | "SUPPLEMENTAL"
    amount: float
    details: str
    # "To" - where the funds go, picked as 2 independent CC/GL dropdowns
    # (spec item 8: "per CC-GL, not per Expense Line Item").
    targetCostCenter: str
    targetGlAccount: str
    # "From" - required only for type=REALLOCATION.
    budgetSourceCostCenter: str | None = None
    budgetSourceGlAccount: str | None = None
    # Spec item 11: required Company selection.
    companyCode: str  # "OLC" | "OCC" | "OCLP"
    # Chosen directly by the requestor - routing is now known up front, no
    # separate Budget Officer classification stage.
    sbu: str
    location: str  # IoLocation.code


class SubmitIn(BaseModel):
    assignedDepartmentHeadId: str


class DecisionIn(BaseModel):
    decision: str  # "APPROVE" | "REJECT" | "RETURN"
    comment: str | None = None


class ReassignIn(BaseModel):
    assigneeUserId: str
    comment: str | None = None


class TransferReviewDecisionOut(BaseModel):
    id: int
    stage: str
    decision: str
    comment: str | None
    timestamp: datetime
    decidedByName: str


class TransferAttachmentOut(BaseModel):
    id: int
    fileName: str


class TransferRequestOut(BaseModel):
    id: int
    ticketNumber: str
    requestorId: str
    requestorName: str
    departmentId: str
    departmentName: str
    assignedDepartmentHeadId: str | None
    assignedDepartmentHeadName: str | None
    fiscalYear: int
    type: str
    amount: float
    details: str
    budgetSourceCostCenter: str | None
    budgetSourceCostCenterName: str | None
    budgetSourceGlAccount: str | None
    budgetSourceGlAccountName: str | None
    targetCostCenter: str | None
    targetCostCenterName: str | None
    targetGlAccount: str | None
    targetGlAccountName: str | None
    companyCode: str | None
    sbu: str | None
    location: str | None
    stageAssigneeOverrideId: str | None
    stageAssigneeOverrideName: str | None
    currentStage: str
    status: str
    sapDocumentNumber: str | None
    createdAt: datetime
    updatedAt: datetime
    reviewDecisions: list[TransferReviewDecisionOut] = []
    attachments: list[TransferAttachmentOut] = []


def _cost_center_name(session: Session, code: str | None) -> str | None:
    if not code:
        return None
    row = session.exec(select(CostCenter).where(CostCenter.code == code)).first()
    return row.name if row else None


def _gl_account_name(session: Session, code: str | None) -> str | None:
    if not code:
        return None
    row = session.exec(select(GlAccount).where(GlAccount.code == code)).first()
    return row.name if row else None


def _user_name(session: Session, user_id: str | None) -> str | None:
    if not user_id:
        return None
    u = session.get(User, user_id)
    return u.name if u else None


def _to_out(session: Session, t: TransferRequest, *, with_detail: bool = False) -> TransferRequestOut:
    requestor = session.get(User, t.requestor_id)
    department = session.get(Department, t.department_id)

    decisions_out: list[TransferReviewDecisionOut] = []
    attachments_out: list[TransferAttachmentOut] = []
    if with_detail:
        decisions = session.exec(
            select(TransferReviewDecision)
            .where(TransferReviewDecision.transfer_request_id == t.id)
            .order_by(TransferReviewDecision.timestamp.asc())
        ).all()
        for d in decisions:
            decider = session.get(User, d.decided_by_id)
            decisions_out.append(
                TransferReviewDecisionOut(
                    id=d.id,
                    stage=d.stage,
                    decision=d.decision,
                    comment=d.comment,
                    timestamp=d.timestamp,
                    decidedByName=decider.name if decider else "—",
                )
            )
        attachments = session.exec(
            select(TransferAttachment).where(TransferAttachment.transfer_request_id == t.id)
        ).all()
        attachments_out = [TransferAttachmentOut(id=a.id, fileName=a.file_name) for a in attachments]

    return TransferRequestOut(
        id=t.id,
        ticketNumber=t.ticket_number,
        requestorId=t.requestor_id,
        requestorName=requestor.name if requestor else "—",
        departmentId=t.department_id,
        departmentName=department.name if department else "—",
        assignedDepartmentHeadId=t.assigned_department_head_id,
        assignedDepartmentHeadName=_user_name(session, t.assigned_department_head_id),
        fiscalYear=t.fiscal_year,
        type=t.type,
        amount=t.amount,
        details=t.details,
        budgetSourceCostCenter=t.budget_source_cost_center,
        budgetSourceCostCenterName=_cost_center_name(session, t.budget_source_cost_center),
        budgetSourceGlAccount=t.budget_source_gl_account,
        budgetSourceGlAccountName=_gl_account_name(session, t.budget_source_gl_account),
        targetCostCenter=t.target_cost_center,
        targetCostCenterName=_cost_center_name(session, t.target_cost_center),
        targetGlAccount=t.target_gl_account,
        targetGlAccountName=_gl_account_name(session, t.target_gl_account),
        companyCode=t.company_code,
        sbu=t.sbu,
        location=t.location,
        stageAssigneeOverrideId=t.stage_assignee_override_id,
        stageAssigneeOverrideName=_user_name(session, t.stage_assignee_override_id),
        currentStage=t.current_stage,
        status=t.status,
        sapDocumentNumber=t.sap_document_number,
        createdAt=t.created_at,
        updatedAt=t.updated_at,
        reviewDecisions=decisions_out,
        attachments=attachments_out,
    )


def _assert_known_cost_center(session: Session, code: str, *, field: str) -> None:
    if session.exec(select(CostCenter).where(CostCenter.code == code)).first() is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f'"{field}" Cost Center "{code}" is not a recognized code.')


def _assert_known_gl_account(session: Session, code: str, *, field: str) -> None:
    if session.exec(select(GlAccount).where(GlAccount.code == code)).first() is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f'"{field}" GL Account "{code}" is not a recognized code.')


class CcGlEntryOut(BaseModel):
    id: int
    code: str
    name: str


class CostCenterEntryOut(CcGlEntryOut):
    # Note 11 §5 - which SBU's Dash Flow queue this Cost Center's tickets
    # route to. Absent from GlAccount, which has no such concept.
    sbu: str | None = None


class CcGlOptionsOut(BaseModel):
    costCenters: list[CostCenterEntryOut]
    glAccounts: list[CcGlEntryOut]


@router.get("/cc-gl-options", response_model=CcGlOptionsOut)
def cc_gl_options(session: Session = Depends(get_session)):
    """Cost Center / GL Account master lists (spec item 11) - admin-
    maintained, seeded from the "Budgeting System_CC-GL" file's PCCC/COA
    sheets. Populates the "To"/"From" pickers (each CC/GL is independently
    selectable, not a specific catalog item, per spec item 8) and doubles as
    the Admin Console tab's listing.
    """
    cost_centers = session.exec(select(CostCenter).order_by(CostCenter.code.asc())).all()
    gl_accounts = session.exec(select(GlAccount).order_by(GlAccount.code.asc())).all()
    return CcGlOptionsOut(
        costCenters=[CostCenterEntryOut(id=c.id, code=c.code, name=c.name, sbu=c.sbu) for c in cost_centers],
        glAccounts=[CcGlEntryOut(id=g.id, code=g.code, name=g.name) for g in gl_accounts],
    )


class SetCostCenterSbuBody(BaseModel):
    sbu: str | None = None


@router.patch("/cost-centers/{cost_center_id}/sbu", response_model=CostCenterEntryOut)
def set_cost_center_sbu(
    cost_center_id: int,
    body: SetCostCenterSbuBody,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Note 11 §5 - admin-editable mapping used to resolve which SBU's Dash
    Flow queue a ticket routes to (a ticket only carries CC/GL, not an SBU).
    """
    if not user.has_role("BUDGET_OFFICER"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not hold a role permitted to perform this action.")
    row = session.get(CostCenter, cost_center_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cost Center not found.")
    row.sbu = body.sbu
    session.add(row)
    session.commit()
    session.refresh(row)
    return CostCenterEntryOut(id=row.id, code=row.code, name=row.name, sbu=row.sbu)


class TransferBalanceOut(BaseModel):
    budget: float
    actual: float
    commitment: float
    allotted: float  # actual + commitment
    available: float  # budget - allotted


@router.get("/cc-gl-balance", response_model=TransferBalanceOut)
def cc_gl_balance(costCenter: str, glAccount: str, fiscalYear: int, session: Session = Depends(get_session)):
    """The CC-GL pair's current Budget/Actual/Commitment breakdown - used by
    the New Transfer form to show, for a picked To or From CC-GL pair, the
    "Current Amount" balance before this transfer (the frontend derives the
    "Planned Amount" after-transfer figures from this plus the requested
    amount, since only Budget/Available move - Actual/Commitment don't
    change until SAP activity actually posts).
    """
    b = compute_gl_cc_breakdown(session, glAccount, costCenter, fiscalYear)
    allotted = b["actual"] + b["commitment"]
    return TransferBalanceOut(budget=b["budget"], actual=b["actual"], commitment=b["commitment"], allotted=allotted, available=b["budget"] - allotted)


@router.post("/cc-gl-upload", response_model=CcGlOptionsOut)
async def cc_gl_upload(
    file: UploadFile = File(...),
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Re-upload the Cost Center / GL Account master lists (spec item 11:
    "Allow this to be edited by the Budget Officer in the Admin Console").
    Expects the same 2-sheet shape as the source "Budgeting System_CC-GL"
    file - a "PCCC" sheet (Cost Center, Name) and a "COA" sheet (GL Account
    Code, Account Name), each with a header row. Added/changed rows are
    applied and rows missing from the file are removed, same "upload
    replaces the list" convention as the Node side's Expense Line Items
    catalog.
    """
    if not user.has_role("BUDGET_OFFICER"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not hold a role permitted to perform this action.")
    contents = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(contents), read_only=True, data_only=True)
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Could not read this file as an .xlsx workbook.")

    if "PCCC" not in wb.sheetnames or "COA" not in wb.sheetnames:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, 'The workbook must have a "PCCC" sheet (Cost Center, Name) and a "COA" sheet (GL Account Code, Account Name).')

    def read_rows(sheet_name: str) -> dict[str, str]:
        ws = wb[sheet_name]
        out: dict[str, str] = {}
        for row in ws.iter_rows(min_row=2, max_col=2, values_only=True):
            code, name = row[0], row[1]
            if code is None or name is None:
                continue
            out[str(code).strip()] = str(name).strip()
        return out

    cc_rows = read_rows("PCCC")
    gl_rows = read_rows("COA")
    if not cc_rows or not gl_rows:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No data rows found in the PCCC/COA sheets.")

    existing_cc = {c.code: c for c in session.exec(select(CostCenter)).all()}
    for code, name in cc_rows.items():
        if code in existing_cc:
            existing_cc[code].name = name
            session.add(existing_cc[code])
        else:
            session.add(CostCenter(code=code, name=name))
    for code, row in existing_cc.items():
        if code not in cc_rows:
            session.delete(row)

    existing_gl = {g.code: g for g in session.exec(select(GlAccount)).all()}
    for code, name in gl_rows.items():
        if code in existing_gl:
            existing_gl[code].name = name
            session.add(existing_gl[code])
        else:
            session.add(GlAccount(code=code, name=name))
    for code, row in existing_gl.items():
        if code not in gl_rows:
            session.delete(row)

    session.commit()
    return cc_gl_options(session)


@router.delete("/cost-centers/{cost_center_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cost_center(
    cost_center_id: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not user.has_role("BUDGET_OFFICER"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not hold a role permitted to perform this action.")
    row = session.get(CostCenter, cost_center_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Cost Center not found.")
    session.delete(row)
    session.commit()


@router.delete("/gl-accounts/{gl_account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_gl_account(
    gl_account_id: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not user.has_role("BUDGET_OFFICER"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not hold a role permitted to perform this action.")
    row = session.get(GlAccount, gl_account_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "GL Account not found.")
    session.delete(row)
    session.commit()


def _department_heads(session: Session, department_id: str) -> list[User]:
    rows = session.exec(
        select(RoleAssignment).where(RoleAssignment.departmentId == department_id, enum_eq(RoleAssignment.roleType, "DEPARTMENT_HEAD"))
    ).all()
    users = [session.get(User, r.userId) for r in rows]
    return [u for u in users if u is not None]


class DepartmentHeadOut(BaseModel):
    id: str
    name: str


@router.get("/department-heads", response_model=list[DepartmentHeadOut])
def department_heads(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    """Powers the Submit-time "which Department Head should review this"
    picker - scoped to the requestor's own department only.
    """
    if not user.departmentId:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Your account has no department on file.")
    heads = _department_heads(session, user.departmentId)
    return [DepartmentHeadOut(id=u.id, name=u.name) for u in heads]


def _get_or_404(session: Session, transfer_id: int) -> TransferRequest:
    t = session.get(TransferRequest, transfer_id)
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Transfer request not found.")
    return t


def _is_eligible_for_stage(user: AuthedUser, t: TransferRequest, stage: str) -> bool:
    role = STAGE_ROLE.get(stage)
    if role is None:
        return False
    if stage == "DEPT_HEAD_REVIEW":
        base = user.id == t.assigned_department_head_id
    elif stage in SBU_SCOPED_STAGES:
        base = user.has_sbu_role(role, t.sbu)
    else:
        base = user.has_role(role)
    if t.stage_assignee_override_id:
        return user.id == t.stage_assignee_override_id
    return base


def _assert_transfer_access(user: AuthedUser, t: TransferRequest) -> None:
    if t.requestor_id == user.id:
        return
    if _is_eligible_for_stage(user, t, t.current_stage):
        return
    # Anyone who could plausibly act on it at any stage of its own chain can
    # also just view it (e.g. the Dept Head who already approved it, now
    # sitting with the SBU Finance Officer - matches Phase 1's own
    # already-decided-but-still-visible convention).
    if any(_is_eligible_for_stage(user, t, stage) for stage in REVIEW_STAGES):
        return
    raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not have access to this transfer request.")


def _generate_ticket_number(session: Session, fiscal_year: int) -> str:
    existing = session.exec(select(TransferRequest).where(TransferRequest.fiscal_year == fiscal_year)).all()
    return f"TR-{fiscal_year}-{len(existing) + 1}"


@router.post("", response_model=TransferRequestOut, status_code=status.HTTP_201_CREATED)
def create_transfer(
    body: TransferRequestIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if body.type not in ("REALLOCATION", "SUPPLEMENTAL"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, 'type must be "REALLOCATION" or "SUPPLEMENTAL".')
    if body.companyCode not in COMPANY_CODES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, 'companyCode must be "OLC", "OCC", or "OCLP".')
    if not user.departmentId:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Your account has no department on file.")
    if not body.sbu:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "sbu is required.")
    if session.exec(select(IoLocation).where(IoLocation.code == body.location)).first() is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f'"{body.location}" is not a recognized Location.')

    _assert_known_cost_center(session, body.targetCostCenter, field="To")
    _assert_known_gl_account(session, body.targetGlAccount, field="To")

    source_cc = source_gl = None
    if body.type == "REALLOCATION":
        if not body.budgetSourceCostCenter or not body.budgetSourceGlAccount:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "A budget source (From) CC and GL are required for a reallocation.")
        _assert_known_cost_center(session, body.budgetSourceCostCenter, field="From")
        _assert_known_gl_account(session, body.budgetSourceGlAccount, field="From")
        source_cc, source_gl = body.budgetSourceCostCenter, body.budgetSourceGlAccount

    t = TransferRequest(
        ticket_number=_generate_ticket_number(session, body.fiscalYear),
        requestor_id=user.id,
        department_id=user.departmentId,
        fiscal_year=body.fiscalYear,
        type=body.type,
        amount=body.amount,
        details=body.details,
        budget_source_cost_center=source_cc,
        budget_source_gl_account=source_gl,
        target_cost_center=body.targetCostCenter,
        target_gl_account=body.targetGlAccount,
        company_code=body.companyCode,
        sbu=body.sbu,
        location=body.location,
    )
    session.add(t)
    session.commit()
    session.refresh(t)
    return _to_out(session, t)


@router.post("/{transfer_id}/submit", response_model=TransferRequestOut)
def submit_transfer(
    transfer_id: int,
    body: SubmitIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = _get_or_404(session, transfer_id)
    if t.requestor_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only submit your own requests.")
    if t.current_stage not in ("DRAFT",) or t.status not in ("DRAFT", "RETURNED"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This request has already been submitted.")

    eligible_heads = {u.id for u in _department_heads(session, t.department_id)}
    if body.assignedDepartmentHeadId not in eligible_heads:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose one of your department's Department Heads to review this request.")

    existing_attachments = session.exec(
        select(TransferAttachment).where(TransferAttachment.transfer_request_id == t.id)
    ).all()
    if not existing_attachments:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one supporting document must be attached before submitting.")

    if t.type == "REALLOCATION":
        available = compute_gl_cc_available(session, t.budget_source_gl_account, t.budget_source_cost_center, t.fiscal_year)
        if available < t.amount:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"The budget source ({t.budget_source_gl_account}/{t.budget_source_cost_center}) only has "
                f"{available:,.0f} available, less than the requested {t.amount:,.0f}.",
            )

    t.assigned_department_head_id = body.assignedDepartmentHeadId
    t.current_stage = "DEPT_HEAD_REVIEW"
    t.status = "IN_REVIEW"
    t.updated_at = datetime.utcnow()
    session.add(t)
    session.commit()
    session.refresh(t)
    return _to_out(session, t)


@router.get("/mine", response_model=list[TransferRequestOut])
def my_transfers(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.exec(
        select(TransferRequest).where(TransferRequest.requestor_id == user.id).order_by(TransferRequest.updated_at.desc())
    ).all()
    return [_to_out(session, t) for t in rows]


@router.get("/inbox", response_model=list[TransferRequestOut])
def inbox(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    all_pending = session.exec(select(TransferRequest).where(TransferRequest.current_stage.in_(REVIEW_STAGES))).all()
    matches = [t for t in all_pending if t.status == "IN_REVIEW" and _is_eligible_for_stage(user, t, t.current_stage)]
    matches.sort(key=lambda t: t.updated_at)
    return [_to_out(session, t) for t in matches]


@router.get("/reviewed-by-me", response_model=list[TransferRequestOut])
def reviewed_by_me(user: AuthedUser = Depends(get_current_user), session: Session = Depends(get_session)):
    decisions = session.exec(
        select(TransferReviewDecision)
        .where(TransferReviewDecision.decided_by_id == user.id)
        .order_by(TransferReviewDecision.timestamp.desc())
    ).all()
    seen: set[int] = set()
    out: list[TransferRequestOut] = []
    for d in decisions:
        if d.transfer_request_id in seen:
            continue
        seen.add(d.transfer_request_id)
        t = session.get(TransferRequest, d.transfer_request_id)
        if t:
            out.append(_to_out(session, t))
        if len(out) >= 20:
            break
    return out


@router.get("/{transfer_id}", response_model=TransferRequestOut)
def get_transfer(
    transfer_id: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = _get_or_404(session, transfer_id)
    _assert_transfer_access(user, t)
    return _to_out(session, t, with_detail=True)


@router.post("/{transfer_id}/decision", response_model=TransferRequestOut)
def decide(
    transfer_id: int,
    body: DecisionIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = _get_or_404(session, transfer_id)
    stage = t.current_stage
    if stage not in REVIEW_STAGES or t.status != "IN_REVIEW":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This request isn't awaiting a decision right now.")
    if not _is_eligible_for_stage(user, t, stage):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not permitted to act on this request at its current stage.")
    if body.decision not in ("APPROVE", "REJECT", "RETURN"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, 'decision must be "APPROVE", "REJECT", or "RETURN".')

    session.add(TransferReviewDecision(transfer_request_id=t.id, stage=stage, decision=body.decision, decided_by_id=user.id, comment=body.comment))
    # An override is a one-shot delegation for this stage only - clear it
    # whenever a decision moves the ticket off this stage (or terminates it).
    t.stage_assignee_override_id = None

    if body.decision == "REJECT":
        t.status = "REJECTED"
    elif body.decision == "RETURN":
        t.current_stage = "DRAFT"
        t.status = "RETURNED"
    else:  # APPROVE
        if stage == "BUDGET_OFFICER_SAP_UPLOAD":
            t.status = "UPLOADED_TO_SAP"
            t.current_stage = "APPROVED"
            t.sap_document_number = f"KP06-{t.fiscal_year}-{uuid.uuid4().hex[:8].upper()}"
        else:
            t.current_stage = _next_stage(t, stage)

    t.updated_at = datetime.utcnow()
    session.add(t)
    session.commit()
    session.refresh(t)
    return _to_out(session, t, with_detail=True)


@router.post("/{transfer_id}/reassign", response_model=TransferRequestOut)
def reassign(
    transfer_id: int,
    body: ReassignIn,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = _get_or_404(session, transfer_id)
    stage = t.current_stage
    if stage not in REVIEW_STAGES or t.status != "IN_REVIEW":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This request isn't awaiting a decision right now.")
    if not _is_eligible_for_stage(user, t, stage):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not permitted to reassign this request at its current stage.")

    target = session.get(User, body.assigneeUserId)
    if target is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "That user does not exist.")

    t.stage_assignee_override_id = target.id
    t.updated_at = datetime.utcnow()
    note = f"Reassigned to {target.name}"
    if body.comment:
        note += f": {body.comment}"
    session.add(TransferReviewDecision(transfer_request_id=t.id, stage=stage, decision="REASSIGN", decided_by_id=user.id, comment=note))
    session.add(t)
    session.commit()
    session.refresh(t)
    return _to_out(session, t, with_detail=True)


@router.post("/{transfer_id}/cancel", response_model=TransferRequestOut)
def cancel_transfer(
    transfer_id: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = _get_or_404(session, transfer_id)
    if t.requestor_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requestor can cancel this request.")
    if t.status in TERMINAL_STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This request is already finalized and cannot be cancelled.")

    t.status = "CANCELLED"
    t.updated_at = datetime.utcnow()
    session.add(t)
    session.commit()
    session.refresh(t)
    return _to_out(session, t, with_detail=True)


@router.post("/{transfer_id}/attachments", response_model=TransferAttachmentOut, status_code=status.HTTP_201_CREATED)
async def upload_attachment(
    transfer_id: int,
    file: UploadFile = File(...),
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from ..settings import settings

    t = _get_or_404(session, transfer_id)
    if t.requestor_id != user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requestor can attach files.")
    if t.status not in ("DRAFT", "RETURNED"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Attachments can only be added while the request is a draft.")

    os.makedirs(settings.upload_dir, exist_ok=True)
    contents = await file.read()
    stored_name = f"{uuid.uuid4().hex}_{file.filename}"
    with open(os.path.join(settings.upload_dir, stored_name), "wb") as f:
        f.write(contents)

    attachment = TransferAttachment(
        transfer_request_id=t.id,
        file_name=file.filename or stored_name,
        storage_path=stored_name,
        content_type=file.content_type,
        size_bytes=len(contents),
        uploaded_by_id=user.id,
    )
    session.add(attachment)
    session.commit()
    session.refresh(attachment)
    return TransferAttachmentOut(id=attachment.id, fileName=attachment.file_name)


@router.get("/attachments/{attachment_id}")
def download_attachment(
    attachment_id: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from ..settings import settings

    attachment = session.get(TransferAttachment, attachment_id)
    if attachment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found.")
    t = _get_or_404(session, attachment.transfer_request_id)
    _assert_transfer_access(user, t)
    path = os.path.join(settings.upload_dir, attachment.storage_path)
    if not os.path.isfile(path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File no longer exists on disk.")
    return FileResponse(path, filename=attachment.file_name, media_type=attachment.content_type or "application/octet-stream")
