import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SortableHeader } from "../components/SortableHeader";
import { useTableSort } from "../lib/useTableSort";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, downloadFile, type Department, type RequestCategory } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { StatusBadge } from "../components/StatusBadge";
import { PageHeader } from "../components/PageHeader";
import { SBU_BATCH_TYPES, SbuTypeSwitch } from "../components/SbuTypeSwitch";
import { SbuBatchUploadTab } from "./newRequest/SbuBatchUploadTab";
import { SectionLabel } from "../components/TabBar";
import { ExpandableSection, ExpandButton } from "../components/ExpandableSection";
import { useFiscalYear, type FiscalCycleConfig } from "../lib/fiscalCycle";
import { timeAgo } from "../lib/timeAgo";
import { NpcForecastView } from "./NpcForecastView";
import { RevenueRequestTab } from "./newRequest/RevenueRequestTab";

interface ForecastUploadResult {
  ok: boolean;
  created?: number;
  updated?: number;
  errors?: { row: number; error: string }[];
}

interface SapSyncResult {
  ok: true;
  created: number;
  updated: number;
  unmatchedCostCenters: number;
  ambiguous: { glAccount: string; costCenter: string; itemNames: string[] }[];
}

// The persisted status row a background sync writes to (see
// lib/backgroundSync.ts) - `status`/`startedAt`/`finishedAt`/`error`
// describe the most recent attempt, which may have failed;
// `lastSuccessAt`/`resultJson` only ever update on a real success, so "last
// synced at <x>" keeps showing the last success even right after a later
// attempt errors out.
interface SapSyncStatus {
  status: "idle" | "running" | "success" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  lastSuccessAt: string | null;
  resultJson: SapSyncResult | null;
  error: string | null;
}


interface HistoricalActualsBreakdownRow {
  id: string;
  glAccount: string;
  costCenter: string;
  glDescription: string;
  budgetCode: string | null;
  approvedBudget2026: number;
  ytdActuals2026: number;
  monthlyRemainingForecast2026: Record<string, number>;
  remainingMonthsForecast: number;
  availableBudget2026: number;
  totalActualForecast: number;
  remainingBudget2026: number;
  forecastCompletedAt: string | null;
}

// CC/GL are SAP-matching detail, not something the main table shows anymore
// (see GaeForecastTable) - the same Expense Category + Expense Line Item can
// span several catalog rows (one per company sharing that name), which the
// backend now merges into one row here, summing every numeric column and
// carrying the underlying per-CC-GL rows in `breakdown` for the details
// popup. A row with only one underlying catalog item still has `id` equal
// to that item's own HistoricalActuals id (so inline month editing keeps
// hitting PATCH /forecast/entries/:id exactly as before); a merged row's id
// is synthetic ("group:...") and not itself PATCH-able - editing a merged
// row happens per underlying item, inside the popup.
interface HistoricalActualsRow extends HistoricalActualsBreakdownRow {
  expenseCategory: string | null;
  requestCategory: RequestCategory;
  breakdown: HistoricalActualsBreakdownRow[];
}

interface ForecastSubmission {
  stage: "DRAFT" | "HEAD_REVIEW" | "BUDGET_OFFICER_REVIEW" | "APPROVED" | "RETURNED";
  reviewDecisions: { decision: string; stage: string; comment: string | null; timestamp: string; decidedBy: { name: string } }[];
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Wide enough that a 7-figure peso amount ("2,500,000") never wraps.
const COL_WIDTH_PX = 100;
// Expense Category is a short label - a bit wider than the numeric columns
// so 2 lines is normally enough, but nowhere near Expense Line Item's width.
const CATEGORY_COL_WIDTH_PX = 130;
// Expense Line Item carries the longest prose (name + qualifier) of any
// column - wide enough that 2 lines is normally enough on its own, without
// clamping/hiding anything that doesn't fit.
const LINE_ITEM_COL_WIDTH_PX = 190;
// Per-column widths for the 3 frozen columns (Budget Code / Expense Category
// / Expense Line Item), and their cumulative left offsets so the sticky
// cells line up with the colgroup's own widths below rather than drifting
// out of alignment.
const FROZEN_COL_WIDTHS_PX = [COL_WIDTH_PX, CATEGORY_COL_WIDTH_PX, LINE_ITEM_COL_WIDTH_PX];
const FROZEN_LEFT_PX = [0, FROZEN_COL_WIDTHS_PX[0], FROZEN_COL_WIDTHS_PX[0] + FROZEN_COL_WIDTHS_PX[1]];
// The Budget Officer's consolidated "All Departments" table (see
// ForecastPage below) prepends a Department column ahead of Budget Code -
// same width tier as Expense Category, wide enough for a department name
// without needing its own fitText treatment.
const DEPARTMENT_COL_WIDTH_PX = 140;
// Every cell that could overflow its fixed column width (Department/
// Category/Line Item text, or a large peso total) is a single line, clipped
// with an ellipsis rather than wrapped or shrunk - `title` carries the full
// text/number so hovering shows it, same as a native tooltip. Replaces an
// earlier shrink-the-font-to-fit-2-lines approach that made long Category/
// Line Item text hard to scan and didn't help the numeric columns at all
// (a Totals row's summed figures run wider than any single row's own
// values, so they were the ones actually overflowing into their neighbor).

// Budget Code is "PREFIX-YY-Num" (e.g. "HR-27-101") - sorting the string
// itself puts "101" before "50" (lexicographic, not numeric), so this pulls
// out the trailing number and sorts on that instead. A row with no Budget
// Code yet (not assigned) sorts last, by Expense Line Item name. Shared by
// the single-department view and the Budget Officer's "All Departments"
// view (one sorted table per department there).
function budgetCodeNum(code: string | null) {
  const match = code?.match(/-(\d+)$/);
  return match ? Number(match[1]) : null;
}
function sortHistoricalActualsRows(rows: HistoricalActualsRow[]): HistoricalActualsRow[] {
  return rows.slice().sort((a, b) => {
    const numA = budgetCodeNum(a.budgetCode);
    const numB = budgetCodeNum(b.budgetCode);
    if (numA !== null && numB !== null) return numA - numB;
    if (numA !== null) return -1;
    if (numB !== null) return 1;
    return a.glDescription.localeCompare(b.glDescription);
  });
}

// A peso amount, right-aligned, single line, clipped with an ellipsis if
// the column's too narrow for it - `title` always carries the full,
// non-abbreviated peso figure so hovering shows the exact number. `value`
// of null/undefined renders as "—" (a Remaining Months Forecast cell with
// nothing entered yet) rather than a misleading 0. `thousands` shows the
// value divided by 1,000 instead (see the Total row's own "(PHP '000)" label
// below) - those are already the widest figures in the table (a sum of
// every row), so abbreviating just that row is what actually keeps it from
// overflowing its column, rather than shrinking every row's own figures too.
function AmountTd({
  value,
  className = "",
  padding = "px-2 py-1",
  thousands = false,
}: {
  value: number | null | undefined;
  className?: string;
  padding?: string;
  thousands?: boolean;
}) {
  if (value === null || value === undefined) {
    return (
      <td className={`truncate ${padding} text-right align-top ${className}`} title="—">
        —
      </td>
    );
  }
  const displayText = thousands ? (value / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toLocaleString();
  return (
    <td className={`truncate tabular-nums ${padding} text-right align-top ${className}`} title={value.toLocaleString()}>
      {displayText}
    </td>
  );
}

// Extracted so the Budget Officer's "All Departments" view (see
// ForecastPage below) can render one consolidated table, read-only, without
// duplicating this whole frozen-column/sticky-header table. `consolidated`
// prepends a Department column (rows must then carry departmentName) and a
// bold totals row pinned under the header, summing every numeric column
// across whatever rows are passed in.
//
// CC/GL are no longer shown as their own columns here - they're a SAP-
// matching detail, not something a reviewer needs at a glance. Clicking an
// Expense Line Item opens ForecastBreakdownModal instead, showing each
// underlying catalog row's own CC/GL/Budget Code/amounts (there can be more
// than one - see HistoricalActualsRow's own comment on `breakdown`).
function GaeForecastTable({
  rows,
  remainingMonths,
  forecastYear,
  canEditValues,
  onUpdateMonth,
  consolidated,
}: {
  rows: (HistoricalActualsRow & { departmentName?: string })[];
  remainingMonths: number[];
  forecastYear: number;
  canEditValues: boolean;
  onUpdateMonth: (id: string, month: number, value: number) => void;
  consolidated?: boolean;
}) {
  const [detailRow, setDetailRow] = useState<(HistoricalActualsRow & { departmentName?: string }) | null>(null);
  const [searchText, setSearchText] = useState("");
  const visibleRows = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!q ||
          r.glDescription.toLowerCase().includes(q) ||
          (r.budgetCode ?? "").toLowerCase().includes(q) ||
          (r.expenseCategory ?? "").toLowerCase().includes(q))
    );
  }, [rows, searchText]);
  const filtersActive = !!searchText.trim();
  const getSortValue = useCallback((r: HistoricalActualsRow & { departmentName?: string }, key: string): string | number | null => {
    switch (key) {
      case "budgetCode":
        return r.budgetCode ?? null;
      case "category":
        return r.expenseCategory ?? null;
      case "lineItem":
        return r.glDescription;
      case "approved":
        return r.approvedBudget2026;
      case "ytd":
        return r.ytdActuals2026;
      case "available":
        return r.availableBudget2026;
      case "totalForecast":
        return r.totalActualForecast;
      case "remaining":
        return r.remainingBudget2026;
      default:
        return null;
    }
  }, []);
  const { sorted, sortKey, sortDir, toggle } = useTableSort(visibleRows, getSortValue);

  // Same 3 frozen columns as always, plus a leading Department column when
  // consolidated - computed locally (not the module-level FROZEN_LEFT_PX/
  // colWidthPx) so the single-department table above is untouched.
  const frozenWidths = consolidated ? [DEPARTMENT_COL_WIDTH_PX, ...FROZEN_COL_WIDTHS_PX] : FROZEN_COL_WIDTHS_PX;
  const frozenLeft = frozenWidths.reduce<number[]>((acc, _w, i) => [...acc, i === 0 ? 0 : acc[i - 1] + frozenWidths[i - 1]], []);
  const localColWidthPx = (i: number): number => (i < frozenWidths.length ? frozenWidths[i] : COL_WIDTH_PX);
  const columnCount = frozenWidths.length + 3 + remainingMonths.length + 1 + 2;

  const totals = visibleRows.reduce(
    (acc, r) => {
      acc.approvedBudget2026 += r.approvedBudget2026;
      acc.ytdActuals2026 += r.ytdActuals2026;
      acc.availableBudget2026 += r.availableBudget2026;
      acc.remainingMonthsForecast += r.remainingMonthsForecast;
      acc.totalActualForecast += r.totalActualForecast;
      acc.remainingBudget2026 += r.remainingBudget2026;
      for (const m of remainingMonths) {
        acc.monthly[m] = (acc.monthly[m] ?? 0) + (r.monthlyRemainingForecast2026[String(m)] ?? 0);
      }
      return acc;
    },
    { approvedBudget2026: 0, ytdActuals2026: 0, availableBudget2026: 0, remainingMonthsForecast: 0, totalActualForecast: 0, remainingBudget2026: 0, monthly: {} as Record<number, number> }
  );

  return (
    <>
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
      <input
        type="search"
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        placeholder="Filter by Budget Code, Expense Category, or Expense Line Item…"
        className="w-96 rounded border border-slate-300 px-2 py-1"
      />
      {filtersActive && (
        <button
          type="button"
          onClick={() => {
            setSearchText("");
          }}
          className="text-emerald-700 hover:underline"
        >
          Clear filters
        </button>
      )}
    </div>
    <div className="mb-1 flex items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs italic text-slate-500">All amounts are in PHP.</p>
        <span className="text-xs text-slate-500">Showing {visibleRows.length} of {rows.length} line item(s)</span>
      </div>
      <ExpandButton />
    </div>
    <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table
        className="table-fixed text-xs"
        style={{ width: "100%", minWidth: Array.from({ length: columnCount }, (_, i) => localColWidthPx(i)).reduce((a, b) => a + b, 0) }}
      >
        <colgroup>
          {Array.from({ length: columnCount }).map((_, i) => (
            <col key={i} style={{ width: localColWidthPx(i) }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-20 bg-[#edf6f1] text-left text-[12px] font-semibold text-[#164b33]">
          <tr>
            {consolidated && (
              <th rowSpan={2} className="sticky z-30 bg-emerald-50 px-2 py-2 text-left align-middle leading-tight" style={{ left: frozenLeft[0] }}>
                Department
              </th>
            )}
            <SortableHeader rowSpan={2} label="Budget Code" sortKey="budgetCode" activeKey={sortKey} dir={sortDir} onToggle={toggle} className="sticky z-30 bg-[#edf6f1] px-2 py-2 align-middle leading-tight" style={{ left: frozenLeft[consolidated ? 1 : 0] }} />
            <SortableHeader rowSpan={2} label="Expense Category" sortKey="category" activeKey={sortKey} dir={sortDir} onToggle={toggle} className="sticky z-30 bg-[#edf6f1] px-2 py-2 align-middle leading-tight" style={{ left: frozenLeft[consolidated ? 2 : 1] }} />
            <SortableHeader rowSpan={2} label="Expense Line Item" sortKey="lineItem" activeKey={sortKey} dir={sortDir} onToggle={toggle} className="sticky z-30 bg-[#edf6f1] px-2 py-2 align-middle leading-tight" style={{ left: frozenLeft[consolidated ? 3 : 2] }} />
            <SortableHeader rowSpan={2} label="Approved Budget" sortKey="approved" activeKey={sortKey} dir={sortDir} onToggle={toggle} align="right" className="px-2 py-2 align-middle leading-tight" />
            <SortableHeader rowSpan={2} label="YTD Actuals" sortKey="ytd" activeKey={sortKey} dir={sortDir} onToggle={toggle} align="right" className="px-2 py-2 align-middle leading-tight" />
            <SortableHeader rowSpan={2} label="Available Budget" sortKey="available" activeKey={sortKey} dir={sortDir} onToggle={toggle} align="right" className="px-2 py-2 align-middle leading-tight" />
            <th colSpan={remainingMonths.length + 1} className="px-2 py-2 text-center border-l border-emerald-200">
              Remaining Months Forecast
            </th>
            <SortableHeader rowSpan={2} label="Total Actual + Forecast" sortKey="totalForecast" activeKey={sortKey} dir={sortDir} onToggle={toggle} align="right" className="px-2 py-2 align-middle leading-tight" />
            <SortableHeader rowSpan={2} label="Remaining Budget" sortKey="remaining" activeKey={sortKey} dir={sortDir} onToggle={toggle} align="right" className="px-2 py-2 align-middle leading-tight" />
          </tr>
          <tr>
            {remainingMonths.map((m) => (
              <th key={m} className="whitespace-nowrap px-2 py-2 text-right align-middle">
                {MONTH_NAMES[m - 1]}
              </th>
            ))}
            <th className="whitespace-nowrap px-2 py-2 text-right align-middle">Total</th>
          </tr>
          <tr className="font-semibold text-[#164b33]">
            {frozenWidths.map((_w, i) => {
              const style = { left: frozenLeft[i] };
              if (i === 0) return <td key={i} className="sticky z-10 truncate bg-[#edf6f1] px-1.5 py-1" style={style}>Total</td>;
              if (i === frozenWidths.length - 1)
                return (
                  <td key={i} className="sticky z-10 truncate bg-[#edf6f1] px-1.5 py-1 text-[10px] font-normal text-emerald-700" style={style} title="Total row figures are shown in thousands of pesos - hover a number for its exact value.">
                    (figures in PHP &apos;000)
                  </td>
                );
              return <td key={i} className="sticky z-10 truncate bg-[#edf6f1] px-1.5 py-1" style={style}></td>;
            })}
            <AmountTd value={totals.approvedBudget2026} thousands />
            <AmountTd value={totals.ytdActuals2026} thousands />
            <AmountTd value={totals.availableBudget2026} thousands />
            {remainingMonths.map((m) => (
              <AmountTd key={m} value={totals.monthly[m] ?? 0} thousands />
            ))}
            <AmountTd value={totals.remainingMonthsForecast} thousands />
            <AmountTd value={totals.totalActualForecast} thousands />
            <AmountTd value={totals.remainingBudget2026} thousands />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const rowBg = i % 2 === 1 ? "bg-slate-50/60" : "bg-white";
            const stickyBg = i % 2 === 1 ? "bg-slate-50" : "bg-white";
            return (
              <tr key={r.id} className={`border-t border-slate-100 ${rowBg}`}>
                {consolidated && (
                  <td className={`sticky z-10 truncate px-2 py-1 align-top ${stickyBg}`} style={{ left: frozenLeft[0] }} title={r.departmentName}>
                    {r.departmentName}
                  </td>
                )}
                <td className={`sticky z-10 truncate px-2 py-1 align-top ${stickyBg}`} style={{ left: frozenLeft[consolidated ? 1 : 0] }} title={r.budgetCode ?? undefined}>
                  {r.budgetCode ?? "—"}
                </td>
                <td className={`sticky z-10 truncate px-2 py-1 align-top ${stickyBg}`} style={{ left: frozenLeft[consolidated ? 2 : 1] }} title={r.expenseCategory ?? undefined}>
                  {r.expenseCategory ?? "—"}
                </td>
                <td className={`sticky z-10 truncate px-2 py-1 align-top ${stickyBg}`} style={{ left: frozenLeft[consolidated ? 3 : 2] }} title={r.glDescription}>
                  <button type="button" onClick={() => setDetailRow(r)} className="text-left underline decoration-dotted underline-offset-2 hover:text-emerald-700">
                    {r.glDescription}
                  </button>
                </td>
                <AmountTd value={r.approvedBudget2026} />
                <AmountTd value={r.ytdActuals2026} />
                <AmountTd value={r.availableBudget2026} />
                {remainingMonths.map((m) =>
                  canEditValues && r.breakdown.length === 1 ? (
                    <td key={m} className="px-2 py-1 text-right align-top">
                      <input
                        // Keyed on the row's own current value (not just
                        // m/r.id) - defaultValue only ever applies on mount
                        // for an uncontrolled input like this one, so an
                        // Upload Completed Template / Sync Now that changes
                        // this cell's stored value elsewhere wouldn't
                        // otherwise be reflected here at all (the input
                        // would just keep showing whatever it had before,
                        // even after the underlying data refetches). This
                        // key forces React to remount (not just re-render)
                        // the input whenever the stored value itself
                        // changes, which re-applies the fresh defaultValue.
                        key={r.monthlyRemainingForecast2026[String(m)] ?? "empty"}
                        type="number"
                        className="w-full rounded border border-slate-300 px-1 py-0.5 text-right text-xs"
                        defaultValue={r.monthlyRemainingForecast2026[String(m)] ?? ""}
                        onBlur={(e) => {
                          const value = Number(e.target.value) || 0;
                          if (value !== r.monthlyRemainingForecast2026[String(m)]) {
                            onUpdateMonth(r.id, m, value);
                          }
                        }}
                      />
                    </td>
                  ) : (
                    <AmountTd key={m} value={r.monthlyRemainingForecast2026[String(m)]} />
                  )
                )}
                <AmountTd value={r.remainingMonthsForecast} className="font-medium text-slate-700" />
                <AmountTd value={r.totalActualForecast} />
                <AmountTd value={r.remainingBudget2026} className="font-semibold text-emerald-800" />
              </tr>
            );
          })}
        </tbody>
      </table>
      {detailRow && (
        <ForecastBreakdownModal
          row={detailRow}
          remainingMonths={remainingMonths}
          forecastYear={forecastYear}
          canEditValues={canEditValues && !consolidated}
          onUpdateMonth={onUpdateMonth}
          onClose={() => setDetailRow(null)}
        />
      )}
    </div>
    </>
  );
}

// Popup with the CC-GL-level detail behind one merged Expense Line Item row
// - opened by clicking that row's name in GaeForecastTable above. Shown for
// every row (not just merged ones) so there's always a way to see the
// underlying CC/GL/Budget Code without cluttering the main table; a row
// backed by a single catalog item just shows one line here. Editing a
// remaining month here (only offered when the underlying group has more
// than one row - a single-row group already edits inline in the main
// table) targets that specific underlying row's own id, same
// PATCH /forecast/entries/:id the main table's inline inputs use.
function ForecastBreakdownModal({
  row,
  remainingMonths,
  forecastYear,
  canEditValues,
  onUpdateMonth,
  onClose,
}: {
  row: HistoricalActualsRow & { departmentName?: string };
  remainingMonths: number[];
  forecastYear: number;
  canEditValues: boolean;
  onUpdateMonth: (id: string, month: number, value: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canEditRows = canEditValues && row.breakdown.length > 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-4xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold tracking-wide text-slate-500">{row.expenseCategory ?? "Expense Line Item"}</div>
            <div className="text-lg font-semibold text-emerald-800">{row.glDescription}</div>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            ✕
          </button>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[700px] text-xs">
            <thead className="bg-emerald-50 text-left text-[11px] tracking-wide text-emerald-800">
              <tr>
                <th className="px-2 py-1.5">Budget Code</th>
                <th className="px-2 py-1.5">CC</th>
                <th className="px-2 py-1.5">GL</th>
                <th className="px-2 py-1.5 text-right">Approved Budget</th>
                <th className="px-2 py-1.5 text-right">YTD Actuals</th>
                <th className="px-2 py-1.5 text-right">Available Budget</th>
                {remainingMonths.map((m) => (
                  <th key={m} className="px-2 py-1.5 text-right">
                    {MONTH_NAMES[m - 1]}
                  </th>
                ))}
                <th className="px-2 py-1.5 text-right">Total Actual + Forecast</th>
                <th className="px-2 py-1.5 text-right">Remaining Budget</th>
              </tr>
            </thead>
            <tbody>
              {row.breakdown.map((b, i) => (
                <tr key={b.id} className={`border-t border-slate-100 ${i % 2 === 1 ? "bg-slate-50/60" : "bg-white"}`}>
                  <td className="truncate px-2 py-1" title={b.budgetCode ?? undefined}>
                    {b.budgetCode ?? "—"}
                  </td>
                  <td className="truncate px-2 py-1">{b.costCenter}</td>
                  <td className="truncate px-2 py-1">{b.glAccount}</td>
                  <AmountTd value={b.approvedBudget2026} padding="px-2 py-1" />
                  <AmountTd value={b.ytdActuals2026} padding="px-2 py-1" />
                  <AmountTd value={b.availableBudget2026} padding="px-2 py-1" />
                  {remainingMonths.map((m) =>
                    canEditRows ? (
                      <td key={m} className="px-2 py-1 text-right">
                        <input
                          key={b.monthlyRemainingForecast2026[String(m)] ?? "empty"}
                          type="number"
                          className="w-20 rounded border border-slate-300 px-1 py-0.5 text-right text-xs"
                          defaultValue={b.monthlyRemainingForecast2026[String(m)] ?? ""}
                          onBlur={(e) => {
                            const value = Number(e.target.value) || 0;
                            if (value !== b.monthlyRemainingForecast2026[String(m)]) {
                              onUpdateMonth(b.id, m, value);
                            }
                          }}
                        />
                      </td>
                    ) : (
                      <AmountTd key={m} value={b.monthlyRemainingForecast2026[String(m)]} padding="px-2 py-1" />
                    )
                  )}
                  <AmountTd value={b.totalActualForecast} padding="px-2 py-1" />
                  <AmountTd value={b.remainingBudget2026} padding="px-2 py-1" className="font-semibold text-emerald-800" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function ForecastPage() {
  const { currentUser, hasRole } = useAuth();
  const isBudgetOfficer = hasRole("BUDGET_OFFICER");
  const { forecastYear, targetYear } = useFiscalYear();

  // No ?category= at all means "haven't picked a category yet" - shows a
  // picker prompt below instead of silently defaulting to GAE, same as New
  // Request. GAE is only shown once explicitly chosen (?category=GAE, same
  // as every other category).
  const [searchParams] = useSearchParams();
  const categoryParam = searchParams.get("category");
  const category: RequestCategory | null = categoryParam === "GAE" || categoryParam === "DOE" || categoryParam === "NPC" || categoryParam === "REVENUE" ? categoryParam : null;
  // Lets a link from elsewhere (e.g. Home's per-department "View Forecast →")
  // land straight on that department's own forecast instead of whatever the
  // viewer's own default would otherwise be.
  const deptParam = searchParams.get("departmentId");

  // Notes_6 (Forecast section): "Forecast is for Centralized Departments
  // only which are – Human Resources, Administrative Services Department,
  // Corporate Marketing, Legal Department, Corporate Finance, Tax, OMD
  // Operations." /forecast/eligible-departments is the backend's own
  // authoritative allowlist (also enforced server-side on every route), so
  // the picker here can't drift from what the API actually accepts.
  const { data: eligibleDepts = [] } = useQuery({
    queryKey: ["forecast", "eligible-departments"],
    queryFn: async () => (await api.get<Department[]>("/forecast/eligible-departments")).data,
  });
  // Notes item 7(4): a centralized department cannot view another
  // centralized department's forecast — only the Budget Officer sees all.
  const { data: myDeptIds = [] } = useQuery({
    queryKey: ["forecast", "my-departments"],
    queryFn: async () => (await api.get<string[]>("/forecast/my-departments")).data,
  });
  const viewableDepts = isBudgetOfficer ? eligibleDepts : eligibleDepts.filter((d) => myDeptIds.includes(d.id));

  const [departmentId, setDepartmentId] = useState(() => deptParam || (isBudgetOfficer ? "ALL" : viewableDepts[0]?.id ?? ""));
  const effectiveDeptId = departmentId || deptParam || (isBudgetOfficer ? "ALL" : viewableDepts[0]?.id || "");
  // Budget Officer only - "All Departments" shows every viewable
  // department's forecast at once, read-only (no single ForecastSubmission
  // to gate Submit/editing against when several are combined).
  const isAllMode = isBudgetOfficer && effectiveDeptId === "ALL";

  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["forecast", effectiveDeptId] });
    queryClient.invalidateQueries({ queryKey: ["forecast-submission", effectiveDeptId] });
  };

  const { data, isError } = useQuery({
    queryKey: ["forecast", effectiveDeptId],
    queryFn: async () => (await api.get<{ asOfMonth: number; rows: HistoricalActualsRow[] }>(`/forecast/${effectiveDeptId}`)).data,
    enabled: !!effectiveDeptId && !isAllMode,
  });
  // One query per viewable department, only fetched in "All Departments" mode.
  const allDeptQueries = useQueries({
    queries: isAllMode
      ? viewableDepts.map((d) => ({
          queryKey: ["forecast", d.id],
          queryFn: async () => (await api.get<{ asOfMonth: number; rows: HistoricalActualsRow[] }>(`/forecast/${d.id}`)).data,
        }))
      : [],
  });
  const { data: submission } = useQuery({
    queryKey: ["forecast-submission", effectiveDeptId],
    queryFn: async () => (await api.get<ForecastSubmission>(`/forecast/${effectiveDeptId}/submission`)).data,
    enabled: !!effectiveDeptId && !isAllMode,
  });
  const rows = data?.rows ?? [];
  const categoryRows = sortHistoricalActualsRows(category ? rows.filter((r) => r.requestCategory === category) : []);
  const asOfMonth = data?.asOfMonth ?? 9;
  const remainingMonths = Array.from({ length: 12 - asOfMonth }, (_, i) => asOfMonth + 1 + i);

  const updateMutation = useMutation({
    mutationFn: async ({ id, month, value }: { id: string; month: number; value: number }) => (await api.patch(`/forecast/entries/${id}`, { month, value })).data,
    onSuccess: invalidate,
  });

  const [submitError, setSubmitError] = useState<string | null>(null);
  const submitMutation = useMutation({
    mutationFn: async () => (await api.post(`/forecast/${effectiveDeptId}/submit`)).data,
    onSuccess: () => {
      invalidate();
      setSubmitError(null);
    },
    onError: (err: any) => setSubmitError(err.response?.data?.error ?? "Could not submit forecast."),
  });

  // Notes_6 (Forecast section): Budget-Officer-only controls - change the
  // as-of-month cutoff (which months count as YTD Actuals vs. remaining
  // forecast), and bulk-upload Approved Budget/YTD Actuals from an Excel
  // file instead of editing rows one by one.
  const { data: fiscalCycle } = useQuery({
    queryKey: ["fiscal-cycle"],
    queryFn: async () => (await api.get<FiscalCycleConfig>("/admin/fiscal-cycle")).data,
    enabled: isBudgetOfficer,
  });
  const asOfMonthMutation = useMutation({
    mutationFn: async (month: number) => (await api.put("/admin/fiscal-cycle", { asOfMonth2026: month })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fiscal-cycle"] });
      queryClient.invalidateQueries({ queryKey: ["forecast"] });
    },
  });

  const [uploadStatus, setUploadStatus] = useState<{ ok: boolean; message: string; errors?: { row: number; error: string }[] } | null>(null);
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return (await api.post<ForecastUploadResult>("/admin/historical-actuals/upload", form)).data;
    },
    // Every row that validates is imported even when others don't (see
    // parseForecastTemplate's own comment) - a real upload can run to
    // hundreds of rows, so a handful of blank/uncatalogued ones no longer
    // block the rest. `errors` here is informational (what got skipped and
    // why), not a rejection of the whole file.
    onSuccess: (data) => {
      const skipped = data.errors?.length ?? 0;
      setUploadStatus({
        ok: true,
        message: `Uploaded: ${data.created} created, ${data.updated} updated.${skipped > 0 ? ` ${skipped} row(s) skipped.` : ""}`,
        errors: data.errors,
      });
      queryClient.invalidateQueries({ queryKey: ["forecast"] });
    },
  });

  // The sync itself now also runs automatically every 10 minutes (see
  // backend/src/index.ts's startup scheduler) - this button is a
  // supplementary on-demand refresh, not the only way this data ever
  // updates. It always runs in the background (a full pull can take longer
  // than a normal request should sit open for), so this polls GET
  // .../sync-sap/status for the result instead of awaiting the POST -
  // continuously (not just right after a manual click), both so an
  // automatic tick's progress shows up too and so "last synced" stays fresh
  // on its own.
  const [syncStatus, setSyncStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const startSyncMutation = useMutation({
    mutationFn: async () => (await api.post("/admin/historical-actuals/sync-sap")).data,
    onError: (err: any) => setSyncStatus({ ok: false, message: err.response?.data?.error ?? "Could not start sync." }),
  });

  const { data: syncPollData } = useQuery({
    queryKey: ["forecast", "sync-sap-status"],
    queryFn: async () => (await api.get<SapSyncStatus>("/admin/historical-actuals/sync-sap/status")).data,
    enabled: isBudgetOfficer && category !== "NPC",
    refetchInterval: (query) => (query.state.data?.status === "running" ? 5000 : 60000),
  });

  const previousSyncStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!syncPollData) return;
    const previous = previousSyncStatusRef.current;
    previousSyncStatusRef.current = syncPollData.status;
    // Only react to a *transition* into success/error, not every poll tick
    // that happens to still read the same terminal status.
    if (previous === syncPollData.status) return;
    if (syncPollData.status === "success") {
      // No success banner - the ambiguous-GL-CC-pairs list this used to
      // spell out inline could run to dozens of items (a full screen's
      // worth of text) for a purely informational "it worked" message;
      // "Last synced" below already covers that. Only a real failure is
      // worth interrupting the page for.
      setSyncStatus(null);
      queryClient.invalidateQueries({ queryKey: ["forecast"] });
    } else if (syncPollData.status === "error") {
      setSyncStatus({ ok: false, message: syncPollData.error ?? "Sync failed." });
    }
  }, [syncPollData, queryClient]);

  const syncInProgress = syncPollData?.status === "running";
  const lastSyncedLabel = syncPollData?.lastSuccessAt ? `Last synced ${timeAgo(syncPollData.lastSuccessAt)}` : syncPollData && syncPollData.status !== "idle" ? "Never synced successfully yet" : null;

  const stage = submission?.stage ?? "DRAFT";
  const isOwnDept = currentUser?.department?.id === effectiveDeptId;
  // 2026's Remaining Months Forecast is Budget-Officer-only (bulk Upload
  // Completed Template only) - every other Centralized Dept Requestor/
  // Reviewer/Head's own manual per-cell entry and Submit for Approval are
  // disabled for this cycle (enforced server-side too - see PATCH
  // /forecast/entries/:id and POST /:departmentId/submit). Keyed off
  // forecastYear, not hardcoded, so it lifts on its own once the cycle
  // rolls to forecastYear 2027 - the normal collaborative process resumes
  // there without needing another code change.
  const is2026RestrictedToBudgetOfficer = forecastYear === 2026 && !isBudgetOfficer;
  const canEditValues = !isAllMode && !is2026RestrictedToBudgetOfficer && (isOwnDept || isBudgetOfficer) && (stage === "DRAFT" || stage === "RETURNED");
  const allComplete = rows.length > 0 && rows.every((r) => r.forecastCompletedAt);
  const anyIncomplete = rows.some((r) => remainingMonths.some((m) => r.monthlyRemainingForecast2026[String(m)] === undefined));

  // DOE, Commission, Cost of Sales, Depreciation & Amortization, and
  // Interest Expense all share the same SBU+Company upload/review flow (see
  // SbuBatchUploadTab.tsx and backend's approvalChain.ts SBU_BATCH_CATEGORIES)
  // - SBU-scoped, not department-scoped, so this comes before the
  // eligibility gate below, same as NPC/Revenue.
  const batchType = SBU_BATCH_TYPES.find((t) => t.key === categoryParam);
  if (batchType) {
    return (
      <div className="space-y-4">
        <SbuTypeSwitch mode="forecast" current={categoryParam} />
        <SbuBatchUploadTab category={batchType.category} apiPath={batchType.apiPath} subtitle={`Submit a ${batchType.label} forecast.`} forecast />
      </div>
    );
  }

  if (category === null) {
    return (
      <div className="space-y-4">
        <PageHeader subtitle="Choose a category to get started." />
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
          Select a category from the menu on the left to begin.
        </div>
      </div>
    );
  }

  // Note 11 §8 - NPC is SBU-scoped, not department-scoped like GAE - a user
  // whose only NPC access is via Department.sbu may not be in the core
  // centralized department list at all, so this branch must come before the
  // viewableDepts eligibility gate below (which is irrelevant to NPC).
  if (category === "NPC") {
    return <NpcForecastView />;
  }

  // Note 11 §16 follow-up - "Forecast - Revenue: Make this identical with
  // 'New Request'." Revenue isn't a per-CC-GL forecast grid like GAE
  // (nothing here to carry an asOfMonth/remaining-months split) - it's the
  // same SBU+Company template upload/review flow New Request's Revenue tab
  // already has, so this reuses that exact component rather than forcing
  // Revenue through the GAE grid below. Same SBU scoping as NPC above, so
  // it comes before the department eligibility gate too.
  if (category === "REVENUE") {
    return (
      <div className="space-y-4">
        <SbuTypeSwitch mode="forecast" current="REVENUE" />
        <RevenueRequestTab subtitle="Submit a revenue forecast." />
      </div>
    );
  }

  if (viewableDepts.length === 0) {
    return <div className="text-sm text-slate-500">You don't have a centralized department to view a forecast for.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-30 -mb-4 space-y-2 bg-slate-100 pb-1 pt-1">
        {is2026RestrictedToBudgetOfficer && (
          <div className="text-sm text-slate-500">{forecastYear} Remaining Months Forecast is entered by the Budget Officer only, via Upload Completed Template — the normal per-department process resumes for the next cycle.</div>
        )}
      <PageHeader
        subtitle={`Months through ${MONTH_NAMES[(fiscalCycle?.asOfMonth2026 ?? asOfMonth) - 1]} are already in Actuals — only remaining months are editable.`}
        actions={
          <div className="flex items-center gap-3">
            {isBudgetOfficer && (
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-slate-600">YTD Actual through</label>
                <select className="rounded border border-slate-300 bg-white px-2 py-1 text-sm" value={fiscalCycle?.asOfMonth2026 ?? 9} onChange={(e) => asOfMonthMutation.mutate(Number(e.target.value))}>
                  {MONTH_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {forecastYear !== 2026 && <StatusBadge stage={stage} />}
            {canEditValues && forecastYear !== 2026 && (
              <button onClick={() => submitMutation.mutate()} disabled={rows.length === 0 || anyIncomplete || submitMutation.isPending} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
                Submit for Approval
              </button>
            )}
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-4 rounded-lg border border-emerald-200 border-l-4 border-l-lime-600 bg-emerald-50 p-4 text-sm shadow-sm sm:grid-cols-2">
        <div>
          <label className="block font-medium text-emerald-800">Department</label>
          <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{isAllMode ? "All Departments" : (eligibleDepts.find((d) => d.id === effectiveDeptId)?.name ?? "—")}</div>
        </div>
        <div>
          <label className="block font-medium text-emerald-800">Forecast Year</label>
          <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{forecastYear}</div>
        </div>
      </div>
      </div>
      {forecastYear !== 2026 && (
        <p className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-800">Completing this per CC-GL unblocks Centralized First-Level Review (Step 3A). Submission routes to the Centralized Department Head, then the Budget Officer, either of whom can return it.</p>
      )}

      {isBudgetOfficer && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          {/* Note 11 §9 - live-generated, pre-populated version of the same
              template the plain upload below expects (NPC has its own
              distinct shape/page - see NpcForecastView.tsx). Gated to fiscal
              year 2027+, same cycle this reference data belongs to; 2026
              keeps only the plain upload flow. */}
          {targetYear >= 2027 && (
            <button
              type="button"
              onClick={() =>
                downloadFile(`/forecast/${effectiveDeptId}/template?category=${category}`, `forecast-template-${String(category).toLowerCase()}.xlsx`).catch(() =>
                  setUploadStatus({ ok: false, message: "Failed to download the template." })
                )
              }
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
            >
              Open Template
            </button>
          )}
          {/* Real SAP pull (FBL3N), replacing the manual upload below for
              whatever CC-GL pairs it can match unambiguously - see
              historicalActualsService.ts's syncHistoricalActualsFromSap. The
              upload stays as a fallback/override for anything it can't
              (a GL-CC pair shared by more than one catalog item, or a CC not
              in SAP at all). Sync Now / Last synced moved down next to the
              department selector (see below) - kept separate from this
              template download/upload toolbar since it's a different kind
              of action (SAP refresh vs. spreadsheet round-trip). */}
          <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
            {uploadMutation.isPending ? "Uploading…" : "Upload Completed Template"}
            <input
              type="file"
              accept=".xlsx"
              className="hidden"
              disabled={uploadMutation.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setUploadStatus(null);
                uploadMutation.mutate(file);
              }}
            />
          </label>
          {uploadStatus && (
            <div className="text-xs">
              <span className={uploadStatus.ok ? "text-emerald-700" : "text-red-600"}>{uploadStatus.message}</span>
              {uploadStatus.errors && uploadStatus.errors.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-slate-500">See skipped rows</summary>
                  <ul className="mt-1 max-h-40 max-w-md list-disc space-y-0.5 overflow-auto pl-4 text-slate-600">
                    {uploadStatus.errors.map((e, i) => (
                      <li key={i}>
                        Row {e.row}: {e.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {viewableDepts.length > 1 ? (
          <select className="rounded border border-slate-300 px-2 py-1.5 text-sm" value={effectiveDeptId} onChange={(e) => setDepartmentId(e.target.value)}>
            {isBudgetOfficer && <option value="ALL">All Departments</option>}
            {viewableDepts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        ) : (
          <span />
        )}
        {isBudgetOfficer && (
          <div className="flex items-center gap-3">
            {lastSyncedLabel && (
              <span className="text-xs text-slate-500" title="SAP data refreshes automatically every 10 minutes.">
                {lastSyncedLabel}
              </span>
            )}
            <button
              onClick={() => {
                setSyncStatus(null);
                startSyncMutation.mutate();
              }}
              disabled={startSyncMutation.isPending || syncInProgress}
              title="Data refreshes automatically every 10 minutes - use this for an on-demand refresh instead of waiting."
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              {startSyncMutation.isPending || syncInProgress ? "Syncing…" : "Sync Now"}
            </button>
            {syncStatus && <span className={`text-xs ${syncStatus.ok ? "text-emerald-700" : "text-red-600"}`}>{syncStatus.message}</span>}
          </div>
        )}
      </div>
      {isError && <div className="text-sm text-red-700">You can only view your own department's forecast.</div>}

      {/* Notes_9: column layout matches "Budgeting System_Forecast
          Template.xlsx" exactly — Budget Code / Expense Category leading,
          then Expense Line Item / CC / GL split into their own columns
          (not a combined "GL Description"), the month
          columns grouped under a merged "Remaining Months Forecast" header
          alongside their Total, and "2026 Total Actual + Forecast" shown as
          its own column before the final Remaining Budget. The template has
          no 2025 Actuals column, so it's dropped here too.
          Notes_9 (follow-up 1): "arrange the width of the columns... make it
          uniform in size" — table-fixed with every column pinned to the same
          width.
          Notes_9 (follow-up 2): "reflect the numbers in one line only, don't
          wrap the numbers" — a percentage-of-container width squeezed
          numbers like "2,500,000" into a wrapped mess on a 13-column table.
          Fixed pixel width per column instead (COL_WIDTH_PX, wide enough for
          the numbers) with the table free to grow past 100% — the wrapper's
          overflow-x-auto below turns that into a horizontal scroll rather
          than compressed, wrapping cells. Uniform width and single-line
          numbers can't both fit under 100% width on this many columns. */}
      {/* The sticky header/frozen columns below need their OWN scrolling box
          on both axes - a lone `overflow-x-auto` here would get silently
          upgraded to `overflow-y: auto` too per the CSS spec (visible can't
          pair with a non-visible sibling axis), making this div the sticky
          containment boundary without ever actually scrolling vertically
          itself (no height cap), which left `position: sticky; top: 0`
          inert. An explicit max-height turns this into a real 2-axis scroll
          pane instead, so both freezes have something to stick against. */}
      {/* GAE only from here down - NPC/REVENUE/DOE all return earlier above. */}
      {isAllMode ? (
        // Budget Officer's company-wide view - one consolidated, read-only
        // table (Department column first, a Total row under the header)
        // instead of a separate table per department. Editing/Submit are
        // inherently per-department, so there's no single "stage" to gate
        // them against when several departments are combined like this -
        // see the single-department branch below for the normal editable
        // flow.
        (() => {
          const allModeLoading = allDeptQueries.some((q) => q.isLoading);
          const allModeAsOfMonth = allDeptQueries.find((q) => q.data)?.data?.asOfMonth ?? 9;
          const allModeRemainingMonths = Array.from({ length: 12 - allModeAsOfMonth }, (_, m) => allModeAsOfMonth + 1 + m);
          const combinedRows = viewableDepts.flatMap((d, i) => {
            const deptRows = sortHistoricalActualsRows((allDeptQueries[i]?.data?.rows ?? []).filter((r) => r.requestCategory === category));
            return deptRows.map((r) => ({ ...r, departmentName: d.name }));
          });
          if (allModeLoading) return <div className="text-sm text-slate-400">Loading…</div>;
          if (combinedRows.length === 0) return <div className="text-sm text-slate-500">No line items in this category yet.</div>;
          return (
            <ExpandableSection title="GAE Forecast — All Departments" inlineExpand>
              <GaeForecastTable rows={combinedRows} remainingMonths={allModeRemainingMonths} forecastYear={forecastYear} canEditValues={false} onUpdateMonth={() => {}} consolidated />
            </ExpandableSection>
          );
        })()
      ) : (
        <>
          <ExpandableSection title="GAE Forecast" inlineExpand>
            <GaeForecastTable
              rows={categoryRows}
              remainingMonths={remainingMonths}
              forecastYear={forecastYear}
              canEditValues={canEditValues}
              onUpdateMonth={(id, month, value) => updateMutation.mutate({ id, month, value })}
            />
          </ExpandableSection>
          {categoryRows.length === 0 && <div className="text-sm text-slate-500">No line items in this category yet.</div>}

          {!is2026RestrictedToBudgetOfficer && !canEditValues && stage !== "APPROVED" && (isOwnDept || isBudgetOfficer) && (
            <div className="text-sm text-slate-500">Waiting on review — editing is locked while a submission is pending.</div>
          )}
          {allComplete && stage === "APPROVED" && <div className="inline-block rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">Forecast Approved ✓</div>}
          {submitError && <div className="text-sm text-red-700">{submitError}</div>}
        </>
      )}

      {submission && submission.reviewDecisions.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <SectionLabel>Review History</SectionLabel>
          <ul className="space-y-1">
            {submission.reviewDecisions.map((d, i) => (
              <li key={i} className="border-l-2 border-emerald-200 pl-3 py-0.5">
                {d.decision} at {d.stage} — {d.decidedBy.name}
                {d.comment && <span className="text-slate-600"> — {d.comment}</span>}
                <span className="ml-1 text-xs text-slate-400">{new Date(d.timestamp).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
