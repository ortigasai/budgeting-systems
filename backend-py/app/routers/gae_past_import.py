"""Admin Console - lets the Budget Officer load the GAE past-years workbook
(closed years' actuals and budgets) instead of running a script by hand.
Same role check and upload pattern as the NPC Monitoring import.
"""

from __future__ import annotations

import io

import openpyxl
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import AuthedUser, get_current_user
from ..db import get_session
from ..import_gae_past import run_gae_past_import
from ..models_sap_raw import SapGaePastActualRaw, SapKssbV2Raw

router = APIRouter(prefix="/admin/gae-past", tags=["admin-gae-past"])


def _require_budget_officer(user: AuthedUser) -> None:
    if not user.has_role("BUDGET_OFFICER"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You do not hold a role permitted to perform this action.")


class GaePastYearOut(BaseModel):
    fiscalYear: int
    actualRows: int
    actualTotal: float
    budgetRows: int
    budgetTotal: float


class GaePastStatusOut(BaseModel):
    currentYear: int
    years: list[GaePastYearOut]


class GaePastUploadOut(BaseModel):
    sourceFile: str
    currentYear: int
    skippedCurrentYearColumns: int
    skippedRepeatedColumns: int
    actualYears: dict[int, dict[str, float]]
    budgetYears: dict[int, dict[str, float]]


@router.get("/status", response_model=GaePastStatusOut)
def gae_past_status(
    currentYear: int,
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Rows and totals currently loaded for each closed year - shown above the
    upload control so the Budget Officer can see what a re-upload will replace.
    """
    _require_budget_officer(user)
    years: dict[int, dict[str, float]] = {}
    for r in session.exec(select(SapGaePastActualRaw)).all():
        if r.fiscal_year >= currentYear:
            continue
        y = years.setdefault(r.fiscal_year, {"actualRows": 0, "actualTotal": 0.0, "budgetRows": 0, "budgetTotal": 0.0})
        y["actualRows"] += 1
        y["actualTotal"] += r.amount
    for r in session.exec(select(SapKssbV2Raw)).all():
        if r.fiscal_year >= currentYear:
            continue
        y = years.setdefault(r.fiscal_year, {"actualRows": 0, "actualTotal": 0.0, "budgetRows": 0, "budgetTotal": 0.0})
        y["budgetRows"] += 1
        y["budgetTotal"] += r.plan
    return GaePastStatusOut(
        currentYear=currentYear,
        years=[GaePastYearOut(fiscalYear=fy, **{k: round(v, 2) if isinstance(v, float) else v for k, v in vals.items()}) for fy, vals in sorted(years.items())],
    )


@router.post("/upload", response_model=GaePastUploadOut)
async def gae_past_upload(
    file: UploadFile = File(...),
    currentYear: int = Form(...),
    user: AuthedUser = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Loads the workbook's closed years (before `currentYear`). Each year the
    file covers is replaced; the current year is never touched.
    """
    _require_budget_officer(user)
    contents = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(contents), read_only=True, data_only=True)
    except Exception:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Could not read this file as an .xlsx workbook.")
    try:
        summary = run_gae_past_import(wb, session, file.filename or "uploaded.xlsx", currentYear)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return GaePastUploadOut(**summary)
