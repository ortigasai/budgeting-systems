import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SectionLabel } from "../../components/TabBar";

// dataviz skill's validated categorical palette, slots 1 (blue) and 2
// (orange) - this app's own emerald is reserved for brand/chrome, not a
// data-series color, so the chart draws from the reference palette instead.
// Budget (baseline) light green, Actual (target) dark green - the app's brand greens.
const COLOR_BASELINE = "#9fd9b6";
const COLOR_TARGET = "#15603a";
const COLOR_GRID = "#e1e0d9";
const COLOR_AXIS = "#898781";

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

interface Point {
  period: string;
  baseline: number;
  target: number;
  variancePct: number | null;
}

// Note 12's "Comparison Chart (Time Trend)": bars for Baseline vs. Target
// across months/quarters/years, plus "a line showing % variance." The spec's
// literal ask overlays that line on the SAME plot as the currency bars -
// a dual-axis chart (₱ vs %), which the dataviz skill flags as its #1
// anti-pattern ("the chart invents a correlation that isn't in the data").
// Resolved as two small multiples sharing one x-axis instead: bars on top
// (₱, its own axis), a thin variance-% line directly below (its own axis) -
// same information, no fabricated second scale on one plot.
// singleLabel: draw only the target series (one bar per period, no variance
// line) - for a view that shows a single measure, such as Actual only.
// asLine: draw the single series as a line instead of bars.
export function ComparisonChart({ title, baselineLabel, targetLabel, points, singleLabel, asLine }: { title: string; baselineLabel: string; targetLabel: string; points: Point[]; singleLabel?: string; asLine?: boolean }) {
  const single = singleLabel !== undefined;
  if (points.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
        <SectionLabel>{title}</SectionLabel>
        <div className="py-6 text-center text-xs text-slate-400">No data for this selection.</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
      <div className="flex items-center justify-between">
        <SectionLabel>{title}</SectionLabel>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          {!single && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: COLOR_BASELINE }} />
              {baselineLabel}
            </span>
          )}
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: COLOR_TARGET }} />
            {single ? singleLabel : targetLabel}
          </span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        {single && asLine ? (
          <LineChart data={points} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={COLOR_GRID} vertical={false} />
            <XAxis dataKey="period" tick={{ fontSize: 11, fill: COLOR_AXIS }} axisLine={{ stroke: COLOR_GRID }} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: COLOR_AXIS }} axisLine={false} tickLine={false} tickFormatter={(v) => peso(v)} width={70} />
            <Tooltip formatter={(v: number) => peso(v)} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
            <Line type="monotone" dataKey="target" name={singleLabel} stroke={COLOR_TARGET} strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        ) : (
        <BarChart data={points} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barGap={4}>
          <CartesianGrid stroke={COLOR_GRID} vertical={false} />
          <XAxis dataKey="period" tick={{ fontSize: 11, fill: COLOR_AXIS }} axisLine={{ stroke: COLOR_GRID }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: COLOR_AXIS }} axisLine={false} tickLine={false} tickFormatter={(v) => peso(v)} width={70} />
          <Tooltip formatter={(v: number) => peso(v)} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
          {!single && <Bar dataKey="baseline" name={baselineLabel} fill={COLOR_BASELINE} radius={[3, 3, 0, 0]} />}
          <Bar dataKey="target" name={single ? singleLabel : targetLabel} fill={COLOR_TARGET} radius={[3, 3, 0, 0]} />
        </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
