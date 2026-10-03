import { useState } from "react";
import type { PeriodGridResult } from "../../api/client";
import { HEATMAP_THRESHOLD_PCT } from "./ReportTable";

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function heatmapClass(variancePct: number | null): string {
  if (variancePct == null) return "";
  if (variancePct > HEATMAP_THRESHOLD_PCT) return "bg-red-50";
  if (variancePct < -HEATMAP_THRESHOLD_PCT) return "bg-emerald-50";
  return "";
}

// Note 12 revision - "Monthly Comparison"/"Quarterly Comparison": the full
// Expense Category x period grid (Budget vs Actual, one column per period),
// not the single-pair-of-columns shape ReportTable renders for every other
// Primary Comparison. Each period shows Budget/Actual stacked in one cell
// (compact) with the variance driving the same +-10% heatmap convention
// ReportTable already uses, so a problem month/quarter is visually obvious
// without needing yet another column per period.
export function PeriodGridTable({ data }: { data: PeriodGridResult }) {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const rows = q ? data.rows.filter((r) => r.expenseGroup.toLowerCase().includes(q)) : data.rows;

  return (
    <div className="space-y-2">
      <input
        type="text"
        placeholder="Search categories…"
        className="w-56 rounded border border-slate-300 px-2 py-1 text-xs"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-xs">
          <thead className="bg-emerald-50 text-left text-[11px] tracking-wide text-emerald-800">
            <tr>
              <th className="sticky left-0 z-10 bg-emerald-50 px-2 py-1">Expense Category</th>
              {data.periods.map((p) => (
                <th key={p} className="whitespace-nowrap px-2 py-1 text-right">
                  {p}
                </th>
              ))}
              <th className="whitespace-nowrap px-2 py-1 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={data.periods.length + 2} className="px-2 py-4 text-center text-slate-400">
                  No data for this selection.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.expenseGroup}>
                  <td className="sticky left-0 z-10 bg-white px-2 py-1 font-medium">{r.expenseGroup}</td>
                  {r.cells.map((c, i) => (
                    <td key={i} className={`whitespace-nowrap px-2 py-1 text-right ${heatmapClass(c.variancePct)}`}>
                      <div>{peso(c.actual)}</div>
                      <div className="text-[10px] text-slate-400">of {peso(c.budget)}</div>
                    </td>
                  ))}
                  <td className={`whitespace-nowrap px-2 py-1 text-right font-medium ${heatmapClass(r.total.variancePct)}`}>
                    <div>{peso(r.total.actual)}</div>
                    <div className="text-[10px] text-slate-400">of {peso(r.total.budget)}</div>
                  </td>
                </tr>
              ))
            )}
            {rows.length > 0 && (
              <tr className="border-t-2 border-slate-200 font-semibold">
                <td className="sticky left-0 z-10 bg-white px-2 py-1">TOTAL</td>
                {data.totals.cells.map((c, i) => (
                  <td key={i} className="whitespace-nowrap px-2 py-1 text-right">
                    <div>{peso(c.actual)}</div>
                    <div className="text-[10px] font-normal text-slate-400">of {peso(c.budget)}</div>
                  </td>
                ))}
                <td className="whitespace-nowrap px-2 py-1 text-right">
                  <div>{peso(data.totals.total.actual)}</div>
                  <div className="text-[10px] font-normal text-slate-400">of {peso(data.totals.total.budget)}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-slate-400">Each cell shows Actual, with Budget (an even split of the category's annual budget) shown below it. Shaded when variance exceeds ±{HEATMAP_THRESHOLD_PCT}%.</div>
    </div>
  );
}
