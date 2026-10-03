function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Note 12 - Section 1's 4 fixed KPI cards: Baseline (the starting/reference
// amount for whichever Primary Comparison is active), Target (the
// comparison amount), Difference ($), and Variance (%) with the existing
// red/emerald favorable-unfavorable convention every other page in this app
// already uses (kept as-is rather than introducing a separate status
// palette, which would look inconsistent against the rest of the app).
export function KpiCards({
  baselineLabel,
  baseline,
  targetLabel,
  target,
  varianceLabel,
}: {
  baselineLabel: string;
  baseline: number | null;
  targetLabel: string;
  target: number | null;
  varianceLabel: string;
}) {
  const difference = target != null && baseline != null ? target - baseline : null;
  const variancePct = difference != null && baseline ? (difference / baseline) * 100 : null;
  // Favorable = under budget on expenses, or above target on revenue - this
  // generic card doesn't know which, so it uses the same "negative = red"
  // convention already used everywhere else in this app (a negative
  // difference reads as unfavorable for an expense-shaped baseline, which is
  // the common case here).
  const favorable = difference == null || difference <= 0;

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
        <div className="text-[10px] font-semibold tracking-wide text-slate-500">{baselineLabel}</div>
        <div className="text-base font-bold text-slate-800">{baseline != null ? peso(baseline) : "—"}</div>
      </div>
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2">
        <div className="text-[10px] font-semibold tracking-wide text-emerald-700">{targetLabel}</div>
        <div className="text-base font-bold text-emerald-800">{target != null ? peso(target) : "—"}</div>
      </div>
      <div className={`rounded-lg border p-2 ${favorable ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
        <div className={`text-[10px] font-semibold tracking-wide ${favorable ? "text-emerald-700" : "text-red-700"}`}>Difference ($)</div>
        <div className={`text-base font-bold ${favorable ? "text-emerald-800" : "text-red-700"}`}>{difference != null ? peso(difference) : "—"}</div>
      </div>
      <div className={`rounded-lg border p-2 ${favorable ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
        <div className={`text-[10px] font-semibold tracking-wide ${favorable ? "text-emerald-700" : "text-red-700"}`}>{varianceLabel} (%)</div>
        <div className={`text-base font-bold ${favorable ? "text-emerald-800" : "text-red-700"}`}>{variancePct != null ? `${variancePct.toFixed(1)}%` : "—"}</div>
      </div>
    </div>
  );
}
