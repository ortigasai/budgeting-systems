import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { SectionLabel } from "../../components/TabBar";
import type { FinancialScope } from "../../api/client";

// dataviz skill's validated categorical slots 1/2/3 (blue/orange/aqua) - a
// 3-segment donut for part-to-whole is explicitly fine per that skill ("part-
// to-whole at a glance only, <=6 segments" - the anti-pattern is a donut for
// *comparing close values*, not this).
const SCOPE_COLORS: Record<FinancialScope, string> = { GAE: "#2a78d6", DOE: "#5b9be6", COMMISSION: "#1baf7a", DA: "#eb6834", INTEREST: "#8e5cc8", REVENUE_COS: "#d6a22a", NPC: "#8a9099" };
const SCOPE_LABELS: Record<FinancialScope, string> = { GAE: "Operating Expense - GAE", DOE: "Operating Expense - DOE", COMMISSION: "Commission", DA: "Depreciation & Amortization", INTEREST: "Interest Expense", REVENUE_COS: "Revenue & Cost of Sales", NPC: "Non-Project Capex" };

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Note 12's "Scope Breakdown Chart" - OpEx/Revenue/NPC split, computed
// client-side from the already-fetched summary rows' financialScope (no
// separate donut endpoint). Clicking a slice sets the Financial Scope filter
// to that one value, per the spec's "Quick Feature."
export function ScopeDonutChart({ totalsByScope, onSliceClick }: { totalsByScope: Record<FinancialScope, number>; onSliceClick: (scope: FinancialScope) => void }) {
  const data = (Object.keys(SCOPE_COLORS) as FinancialScope[]).map((scope) => ({ scope, value: totalsByScope[scope] ?? 0 }));
  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
      <SectionLabel>Scope Breakdown</SectionLabel>
      {total === 0 ? (
        <div className="py-6 text-center text-xs text-slate-400">No data for this selection.</div>
      ) : (
        <div className="flex items-center gap-3">
          <ResponsiveContainer width={140} height={140}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="scope" innerRadius={38} outerRadius={62} paddingAngle={2} onClick={(d) => onSliceClick(d.scope as FinancialScope)} cursor="pointer">
                {data.map((d) => (
                  <Cell key={d.scope} fill={SCOPE_COLORS[d.scope]} stroke="#fcfcfb" strokeWidth={2} />
                ))}
              </Pie>
              <Tooltip formatter={(v: number, _n, entry: any) => [peso(v), SCOPE_LABELS[entry.payload.scope as FinancialScope]]} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 space-y-1.5 text-xs">
            {data.map((d) => (
              <button key={d.scope} onClick={() => onSliceClick(d.scope)} className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-slate-50">
                <span className="flex items-center gap-1.5 text-slate-600">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: SCOPE_COLORS[d.scope] }} />
                  {SCOPE_LABELS[d.scope]}
                </span>
                <span className="font-semibold text-slate-800">{total ? `${((d.value / total) * 100).toFixed(0)}%` : "0%"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
