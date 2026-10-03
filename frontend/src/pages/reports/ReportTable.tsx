import { Fragment, useMemo, useState } from "react";
import type { ReportLineItem, ReportRow } from "../../api/client";

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function pesoOrDash(n: number | null) {
  return n != null ? peso(n) : "—";
}
function pctOrDash(n: number | null) {
  return n != null ? `${n.toFixed(1)}%` : "—";
}

export type MetricKey =
  | "budgetCurrent"
  | "actualCurrent"
  | "forecastCurrent"
  | "actualPrior"
  | "variance"
  | "varianceBudgetForecast"
  | "varianceActualForecast"
  | "varianceActualYoY"
  | "varianceLYActualCYForecast"
  | "varianceLYActualCYBudget";

// budgetCurrent/actualCurrent/forecastCurrent/actualPrior/variance exist on
// both ReportRow and its nested lineItems; the derived variances only exist
// on ReportRow from the backend - cheap to derive client-side from figures
// every row already has, so there's no need to widen the line-item response
// shape for them. Sign convention: the two "Last Year Actual vs Current
// Year X" variants mirror varianceActualYoY's own established direction
// (current-year figure minus last-year actual, not the other way around) -
// they're the same "LY vs CY" family, so they share its convention rather
// than the Budget/Forecast family's "first-named-quantity-minus-second" one.
function metricValue(row: ReportRow | ReportLineItem, key: MetricKey): number | null {
  if (key === "varianceBudgetForecast") return row.forecastCurrent != null ? row.budgetCurrent - row.forecastCurrent : null;
  if (key === "varianceActualForecast") return row.forecastCurrent != null ? row.actualCurrent - row.forecastCurrent : null;
  if (key === "varianceActualYoY") return "actualPrior" in row ? row.actualCurrent - row.actualPrior : null;
  if (key === "varianceLYActualCYForecast") return "actualPrior" in row && row.forecastCurrent != null ? row.forecastCurrent - row.actualPrior : null;
  if (key === "varianceLYActualCYBudget") return "actualPrior" in row ? row.budgetCurrent - row.actualPrior : null;
  if (key === "actualPrior") return "actualPrior" in row ? row.actualPrior : null;
  return row[key];
}

export interface ComparisonMeta {
  leftLabel: string;
  leftKey: MetricKey;
  rightLabel: string;
  rightKey: MetricKey;
  varianceLabel: string;
  varianceKey: MetricKey;
}

// Note 12's "heatmap": a variance beyond +-10% (of the left/baseline figure)
// gets a soft background - over budget in soft red, under budget in soft
// green. Same +-10% default the Variance Alert View preset pre-expands on;
// its own % and ₱ threshold fields (ReportsPage) override this per-session.
export const HEATMAP_THRESHOLD_PCT = 10;
function variancePctFor(row: ReportRow | ReportLineItem, meta: ComparisonMeta): number | null {
  const left = metricValue(row, meta.leftKey);
  const varianceVal = metricValue(row, meta.varianceKey);
  return left && varianceVal != null ? (varianceVal / left) * 100 : null;
}
// A row is flagged when EITHER threshold is breached - a big % swing on a
// small-peso line and a big-peso swing on a low-% line should both surface,
// not just the intersection of the two.
function isAlertRow(row: ReportRow | ReportLineItem, meta: ComparisonMeta, thresholdPct: number, thresholdPeso: number | null): boolean {
  const variancePct = variancePctFor(row, meta);
  const varianceAmt = metricValue(row, meta.varianceKey);
  const pctHit = variancePct != null && Math.abs(variancePct) > thresholdPct;
  const pesoHit = thresholdPeso != null && varianceAmt != null && Math.abs(varianceAmt) > thresholdPeso;
  return pctHit || pesoHit;
}
function heatmapClass(row: ReportRow | ReportLineItem, meta: ComparisonMeta, thresholdPct: number, thresholdPeso: number | null): string {
  if (!isAlertRow(row, meta, thresholdPct, thresholdPeso)) return "";
  const variancePct = variancePctFor(row, meta);
  const varianceAmt = metricValue(row, meta.varianceKey);
  const sign = variancePct ?? varianceAmt ?? 0;
  if (sign > 0) return "bg-red-50";
  if (sign < 0) return "bg-emerald-50";
  return "";
}

export function ReportTable({
  rows,
  meta,
  notesGroup,
  onToggleNotes,
  initialSortByVariance,
  initialExpandOverThreshold,
  thresholdPct = HEATMAP_THRESHOLD_PCT,
  thresholdPeso = null,
}: {
  rows: ReportRow[];
  meta: ComparisonMeta;
  notesGroup: string | null;
  onToggleNotes: (group: string) => void;
  initialSortByVariance?: boolean;
  initialExpandOverThreshold?: boolean;
  thresholdPct?: number;
  thresholdPeso?: number | null;
}) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"category" | "variance-abs" | "variance-pct">(initialSortByVariance ? "variance-pct" : "category");
  const [openCategories, setOpenCategories] = useState<Set<string>>(
    () => new Set(initialExpandOverThreshold ? rows.filter((r) => isAlertRow(r, meta, thresholdPct, thresholdPeso)).map((r) => r.expenseGroup) : [])
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.expenseGroup.toLowerCase().includes(q) || r.lineItems.some((li) => li.name.toLowerCase().includes(q)));
  }, [rows, search]);

  const sorted = useMemo(() => {
    const withMeta = filtered.map((r) => ({ row: r, variance: metricValue(r, meta.varianceKey) ?? 0, variancePct: variancePctFor(r, meta) ?? 0 }));
    if (sortBy === "variance-abs") withMeta.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
    else if (sortBy === "variance-pct") withMeta.sort((a, b) => Math.abs(b.variancePct) - Math.abs(a.variancePct));
    else withMeta.sort((a, b) => a.row.expenseGroup.localeCompare(b.row.expenseGroup));
    return withMeta.map((w) => w.row);
  }, [filtered, sortBy, meta]);

  // A category matching the search only by a child line item's name should
  // show that match - auto-expand it rather than leaving the row collapsed
  // with nothing visibly matching.
  const searchQ = search.trim().toLowerCase();
  const effectiveOpen = (group: string, lineItems: ReportRow["lineItems"]) => openCategories.has(group) || (!!searchQ && lineItems.some((li) => li.name.toLowerCase().includes(searchQ)));

  const toggleCategory = (group: string) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };
  const allOpen = sorted.length > 0 && sorted.every((r) => effectiveOpen(r.expenseGroup, r.lineItems));
  const toggleAll = () => setOpenCategories(allOpen ? new Set() : new Set(sorted.map((r) => r.expenseGroup)));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search categories or line items…"
          className="w-56 rounded border border-slate-300 px-2 py-1 text-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="rounded border border-slate-300 px-2 py-1 text-xs" value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
          <option value="category">Sort: Category</option>
          <option value="variance-abs">Sort: Highest $ Difference</option>
          <option value="variance-pct">Sort: Highest % Difference</option>
        </select>
        <button onClick={toggleAll} className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100">
          {allOpen ? "Collapse All" : "Expand All"}
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-xs">
          <thead className="bg-emerald-50 text-left text-[11px] tracking-wide text-emerald-800">
            <tr>
              <th className="px-2 py-1">Expense Category</th>
              <th className="px-2 py-1">{meta.leftLabel}</th>
              <th className="px-2 py-1">{meta.rightLabel}</th>
              <th className="px-2 py-1">{meta.varianceLabel} (PHP)</th>
              <th className="px-2 py-1">{meta.varianceLabel} (%)</th>
              <th className="px-2 py-1">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-center text-slate-400">
                  No data for this selection.
                </td>
              </tr>
            ) : (
              sorted.map((r) => {
                const isOpen = effectiveOpen(r.expenseGroup, r.lineItems);
                const variancePct = variancePctFor(r, meta);
                return (
                  <Fragment key={r.expenseGroup}>
                    <tr className={`${notesGroup === r.expenseGroup ? "bg-emerald-50/50" : heatmapClass(r, meta, thresholdPct, thresholdPeso)}`}>
                      <td className="px-2 py-1 font-medium">
                        <button onClick={() => toggleCategory(r.expenseGroup)} className="flex items-center gap-1 hover:text-emerald-700" disabled={r.lineItems.length === 0}>
                          {r.lineItems.length > 0 && <span className="inline-block w-3 text-slate-400">{isOpen ? "▾" : "▸"}</span>}
                          {r.expenseGroup}
                        </button>
                      </td>
                      <td className="px-2 py-1">{pesoOrDash(metricValue(r, meta.leftKey))}</td>
                      <td className="px-2 py-1">{pesoOrDash(metricValue(r, meta.rightKey))}</td>
                      <td className={`px-2 py-1 font-medium ${(metricValue(r, meta.varianceKey) ?? 0) < 0 ? "text-red-600" : "text-slate-700"}`}>{pesoOrDash(metricValue(r, meta.varianceKey))}</td>
                      <td className={`px-2 py-1 font-medium ${(metricValue(r, meta.varianceKey) ?? 0) < 0 ? "text-red-600" : "text-slate-700"}`}>{pctOrDash(variancePct)}</td>
                      <td className="px-2 py-1">
                        <button onClick={() => onToggleNotes(r.expenseGroup)} className="rounded-full border border-slate-300 px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100">
                          {r.noteCount} {r.noteCount === 1 ? "note" : "notes"}
                        </button>
                      </td>
                    </tr>
                    {isOpen &&
                      r.lineItems.map((li) => {
                        const liVariancePct = variancePctFor(li, meta);
                        return (
                          <tr key={`${r.expenseGroup}-${li.id}`} className={heatmapClass(li, meta, thresholdPct, thresholdPeso)}>
                            <td className="py-1 pl-8 pr-2 text-slate-600">{li.name}</td>
                            <td className="px-2 py-1 text-slate-600">{pesoOrDash(metricValue(li, meta.leftKey))}</td>
                            <td className="px-2 py-1 text-slate-600">{pesoOrDash(metricValue(li, meta.rightKey))}</td>
                            <td className={`px-2 py-1 ${(metricValue(li, meta.varianceKey) ?? 0) < 0 ? "text-red-600" : "text-slate-600"}`}>{pesoOrDash(metricValue(li, meta.varianceKey))}</td>
                            <td className={`px-2 py-1 ${(metricValue(li, meta.varianceKey) ?? 0) < 0 ? "text-red-600" : "text-slate-600"}`}>{pctOrDash(liVariancePct)}</td>
                            <td className="px-2 py-1" />
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
