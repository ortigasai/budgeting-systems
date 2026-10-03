import type { ReportTrendPoint } from "../../api/client";

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Note 12 revision - "5-Year Trend": the fixed 5-point window (current year
// and the 4 before it) shown as figures, not just the chart above it -
// "Show also the columns and rows figures, not only charts."
export function TrendTable({ points }: { points: ReportTrendPoint[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-xs">
        <thead className="bg-emerald-50 text-left text-[11px] tracking-wide text-emerald-800">
          <tr>
            <th className="px-2 py-1">Fiscal Year</th>
            <th className="px-2 py-1 text-right">Budget</th>
            <th className="px-2 py-1 text-right">Actual</th>
            <th className="px-2 py-1 text-right">Variance (PHP)</th>
            <th className="px-2 py-1 text-right">Variance (%)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {points.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-2 py-4 text-center text-slate-400">
                No data for this selection.
              </td>
            </tr>
          ) : (
            points.map((p) => {
              const variance = p.budget - p.actual;
              const variancePct = p.budget ? (variance / p.budget) * 100 : null;
              return (
                <tr key={p.fiscalYear}>
                  <td className="px-2 py-1 font-medium">{p.fiscalYear}</td>
                  <td className="px-2 py-1 text-right">{peso(p.budget)}</td>
                  <td className="px-2 py-1 text-right">{peso(p.actual)}</td>
                  <td className={`px-2 py-1 text-right font-medium ${variance < 0 ? "text-red-600" : "text-slate-700"}`}>{peso(variance)}</td>
                  <td className={`px-2 py-1 text-right font-medium ${variance < 0 ? "text-red-600" : "text-slate-700"}`}>{variancePct != null ? `${variancePct.toFixed(1)}%` : "—"}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
