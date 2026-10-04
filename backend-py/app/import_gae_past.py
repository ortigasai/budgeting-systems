"""GAE past-years workbook import - loads closed years' GAE actuals and budgets
from "Budgeting System_GAE Past Years Actual and Budget.xlsx" (one sheet, the
same CC/GL layout as the GAE CC-GL mapping).

- Actual columns: "2022-01" .. "2022-12" and "2023A-01" .. (year-month). Stored
  in sap_gae_past_actual_raw, the table the GAE report's Last Year comparisons
  and the 5-Year Trend's closed-year actuals read.
- Budget columns: "2023B-01" .. (year-month). Stored in sap_kssb_v2_raw as the
  SAP plan rows for that year, the same table the live 2026 plan lives in.

Only years before `current_year` are imported. The current year's live SAP
data is never overwritten by a workbook upload.
"""

from __future__ import annotations

import re
from collections import defaultdict

from sqlmodel import Session, delete

from .models_sap_raw import SapGaePastActualRaw, SapKssbV2Raw

PC_COL = 2  # column C - cost center
GL_COL = 3  # column D - GL account


def _year_month(header: object) -> tuple[str, int, int] | None:
    """(kind, year, month) for an actual or budget header, else None."""
    s = str(header).strip()
    m = re.match(r"^(\d{4})A?-(\d{2})$", s)
    if m:
        return "actual", int(m.group(1)), int(m.group(2))
    m = re.match(r"^(\d{4})B-(\d{2})$", s)
    if m:
        return "budget", int(m.group(1)), int(m.group(2))
    return None


def run_gae_past_import(wb, session: Session, source_file: str, current_year: int) -> dict:
    ws = wb.worksheets[0]
    hdr = next(ws.iter_rows(min_row=1, max_row=1, values_only=True))
    if str(hdr[PC_COL]).strip().upper() != "PC" or str(hdr[GL_COL]).strip().upper() != "GL":
        raise ValueError("Column C must be 'PC' and column D must be 'GL'. This doesn't look like the GAE past-years workbook.")

    actual_cols: list[tuple[int, int, int]] = []
    budget_cols: list[tuple[int, int, int]] = []
    skipped_current = 0
    skipped_repeat = 0
    seen: set[tuple[str, int, int]] = set()
    for j, h in enumerate(hdr):
        if h is None:
            continue
        parsed = _year_month(h)
        if parsed is None:
            continue
        kind, fy, mo = parsed
        if not 1 <= mo <= 12:
            continue
        if fy >= current_year:
            skipped_current += 1
            continue
        # The workbook can repeat a block of months (2023A/2024A appear twice); each
        # year-month is counted once, from its first column.
        if (kind, fy, mo) in seen:
            skipped_repeat += 1
            continue
        seen.add((kind, fy, mo))
        (actual_cols if kind == "actual" else budget_cols).append((j, fy, mo))
    if not actual_cols and not budget_cols:
        raise ValueError("No past-year actual or budget columns found (for example 2022-01, 2023A-01 or 2023B-01).")

    actuals: dict[tuple[str, str, int, int], float] = defaultdict(float)
    budgets: dict[tuple[str, str, int, int], float] = defaultdict(float)
    for row in ws.iter_rows(min_row=2, values_only=True):
        pc, gl = row[PC_COL], row[GL_COL]
        if pc is None or gl is None:
            continue
        try:
            cc = str(int(pc))
            gla = str(int(gl))
        except (TypeError, ValueError):
            continue
        for j, fy, mo in actual_cols:
            if row[j]:
                actuals[(cc, gla, fy, mo)] += float(row[j])
        for j, fy, mo in budget_cols:
            if row[j]:
                budgets[(cc, gla, fy, mo)] += float(row[j])

    actual_years = sorted({fy for _, fy, _ in actual_cols})
    budget_years = sorted({fy for _, fy, _ in budget_cols})

    # Replace each year the file covers - a re-upload overrides that year's rows only.
    session.exec(delete(SapGaePastActualRaw).where(SapGaePastActualRaw.fiscal_year.in_(actual_years)))
    session.exec(delete(SapKssbV2Raw).where(SapKssbV2Raw.fiscal_year.in_(budget_years)))

    actual_rows = [
        SapGaePastActualRaw(cost_center=cc, gl_account=gla, fiscal_year=fy, month=mo, amount=round(v, 2))
        for (cc, gla, fy, mo), v in actuals.items()
        if abs(v) >= 0.005
    ]
    budget_rows = [
        SapKssbV2Raw(cost_center=cc, gl_account=gla, fiscal_year=fy, month=mo, plan=round(v, 2), commitment=0.0)
        for (cc, gla, fy, mo), v in budgets.items()
        if abs(v) >= 0.005
    ]
    session.add_all(actual_rows)
    session.add_all(budget_rows)
    session.commit()

    def _summary(rows, years, value_attr):
        return {fy: {"rows": sum(1 for r in rows if r.fiscal_year == fy), "total": round(sum(getattr(r, value_attr) for r in rows if r.fiscal_year == fy), 2)} for fy in years}

    return {
        "sourceFile": source_file,
        "currentYear": current_year,
        "skippedCurrentYearColumns": skipped_current,
        "skippedRepeatedColumns": skipped_repeat,
        "actualYears": _summary(actual_rows, actual_years, "amount"),
        "budgetYears": _summary(budget_rows, budget_years, "plan"),
    }
