import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { api2 } from "../../api/client";

// The GAE report (Main Report, with the Detailed Report below it). Every
// Primary Comparison reads the same monthly series from the backend; this
// component only picks the months (YTD or full year) and the two measures the
// chosen comparison sets side by side.

interface SeriesOut {
  budget: number[];
  actual: number[];
  forecast: number[];
  ly: number[];
}
interface ReportRowOut {
  key: string;
  label: string;
  level: number;
  isTotal: boolean;
  series: SeriesOut;
}
interface GaeReportOut {
  fiscalYear: number;
  asOfMonth: number;
  main: ReportRowOut[];
  detailed: ReportRowOut[];
  unmappedSubTypes: string[];
}

type Measure = keyof SeriesOut;
type PairId = "budget-actual" | "budget-forecast" | "forecast-actual" | "yoy-actual" | "yoy-forecast" | "yoy-budget";

const PAIRS: Record<PairId, { left: Measure; right: Measure; leftLabel: string; rightLabel: string }> = {
  "budget-actual": { left: "budget", right: "actual", leftLabel: "Budget", rightLabel: "Actual" },
  "budget-forecast": { left: "budget", right: "forecast", leftLabel: "Budget", rightLabel: "Forecast" },
  "forecast-actual": { left: "forecast", right: "actual", leftLabel: "Forecast", rightLabel: "Actual" },
  "yoy-actual": { left: "ly", right: "actual", leftLabel: "LY Actual", rightLabel: "CY Actual" },
  "yoy-forecast": { left: "ly", right: "forecast", leftLabel: "LY Actual", rightLabel: "CY Forecast" },
  "yoy-budget": { left: "ly", right: "budget", leftLabel: "LY Actual", rightLabel: "CY Budget" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmt = (n: number) => (Math.abs(n) < 0.5 ? "—" : Math.round(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const pct = (variance: number, base: number) => (Math.abs(base) < 0.5 ? "—" : `${((variance / Math.abs(base)) * 100).toFixed(1)}%`);
const sumRange = (values: number[], months: number[]) => months.reduce((acc, m) => acc + (values[m - 1] ?? 0), 0);

export function GaeReportSection({ fiscalYear, granularity, comparison, ytdThrough, measure }: { fiscalYear: number; granularity: "YTD" | "ANNUAL"; comparison: string; ytdThrough?: number; measure?: SingleMeasure }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "gae-report", fiscalYear],
    queryFn: async () => (await api2.get<GaeReportOut>("/reports/gae-report", { params: { fiscalYear } })).data,
  });

  if (isLoading) return <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading GAE report…</div>;
  if (error || !data) return <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Could not load the GAE report.</div>;

  const asOf = ytdThrough || data.asOfMonth || 12;
  const months = granularity === "YTD" ? Array.from({ length: asOf }, (_, i) => i + 1) : Array.from({ length: 12 }, (_, i) => i + 1);
  const periodLabel = granularity === "YTD" ? `Jan–${MONTHS[asOf - 1]} ${fiscalYear}` : `Full year ${fiscalYear}`;
  const quarters = [1, 2, 3, 4].filter((q) => months.some((m) => Math.ceil(m / 3) === q));

  const pair = comparison in PAIRS ? PAIRS[comparison as PairId] : null;
  const isMonthly = comparison === "monthly-comparison";

  // Monthly / Quarterly with a single measure: one column per month or quarter.
  const measureLabel = measure ? measure[0].toUpperCase() + measure.slice(1) : "";

  const headerCells = () => {
    if (pair) {
      return (
        <>
          <th className="px-2 py-2 text-right">{pair.leftLabel}</th>
          <th className="px-2 py-2 text-right">{pair.rightLabel}</th>
          <th className="px-2 py-2 text-right">Variance</th>
          <th className="px-2 py-2 text-right">Variance %</th>
        </>
      );
    }
    if (measure) {
      return (
        <>
          {isMonthly
            ? months.map((m) => (
                <th key={`hm${m}`} className="px-2 py-2 text-right">
                  {MONTHS[m - 1]}
                </th>
              ))
            : quarters.map((q) => (
                <th key={`hq${q}`} className="px-2 py-2 text-right">
                  Q{q} {measureLabel}
                </th>
              ))}
          <th className="px-2 py-2 text-right">Total</th>
        </>
      );
    }
    if (isMonthly) {
      return (
        <>
          {months.map((m) => (
            <Fragment key={`hm${m}`}>
              <th className="px-2 py-2 text-right">{MONTHS[m - 1]} Budget</th>
              <th className="px-2 py-2 text-right">{MONTHS[m - 1]} Actual</th>
            </Fragment>
          ))}
        </>
      );
    }
    return (
      <>
        {quarters.map((q) => (
          <Fragment key={`hq${q}`}>
            <th className="px-2 py-2 text-right">Q{q} Budget</th>
            <th className="px-2 py-2 text-right">Q{q} Actual</th>
            <th className="px-2 py-2 text-right">Q{q} Variance</th>
          </Fragment>
        ))}
      </>
    );
  };

  const cells = (row: ReportRowOut) => {
    if (pair) {
      const left = sumRange(row.series[pair.left], months);
      const right = sumRange(row.series[pair.right], months);
      const variance = right - left;
      return (
        <>
          <td className="px-2 py-1 text-right tabular-nums">{fmt(left)}</td>
          <td className="px-2 py-1 text-right tabular-nums">{fmt(right)}</td>
          <td className="px-2 py-1 text-right tabular-nums">{fmt(variance)}</td>
          <td className="px-2 py-1 text-right tabular-nums">{pct(variance, left)}</td>
        </>
      );
    }
    if (measure) {
      return (
        <>
          {isMonthly
            ? months.map((m) => (
                <td key={`cm${m}`} className="px-2 py-1 text-right tabular-nums">
                  {fmt(row.series[measure][m - 1])}
                </td>
              ))
            : quarters.map((q) => (
                <td key={`cq${q}`} className="px-2 py-1 text-right tabular-nums">
                  {fmt(sumRange(row.series[measure], months.filter((m) => Math.ceil(m / 3) === q)))}
                </td>
              ))}
          <td className="px-2 py-1 text-right font-semibold tabular-nums">{fmt(sumRange(row.series[measure], months))}</td>
        </>
      );
    }
    if (isMonthly) {
      return (
        <>
          {months.map((m) => (
            <Fragment key={`cm${m}`}>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(row.series.budget[m - 1])}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(row.series.actual[m - 1])}</td>
            </Fragment>
          ))}
        </>
      );
    }
    return (
      <>
        {quarters.map((q) => {
          const qm = months.filter((m) => Math.ceil(m / 3) === q);
          const b = sumRange(row.series.budget, qm);
          const a = sumRange(row.series.actual, qm);
          return (
            <Fragment key={`cq${q}`}>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(b)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(a)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(a - b)}</td>
            </Fragment>
          );
        })}
      </>
    );
  };

  const renderRows = (rows: ReportRowOut[]) =>
    rows.map((row) => (
      <tr key={row.key} className={`border-t border-slate-100 ${row.isTotal ? "bg-[#edf6f1] font-semibold text-[#164b33]" : ""}`}>
        <td className={`sticky left-0 z-10 px-2 py-1 ${row.isTotal ? "bg-[#edf6f1]" : "bg-white"} ${row.level === 1 ? "pl-6" : ""}`}>
          <div className="max-w-[220px] truncate whitespace-nowrap" title={row.label}>
            {row.label}
          </div>
        </td>
        {cells(row)}
      </tr>
    ));

  return (
    <section className="space-y-4 rounded-lg border border-emerald-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-800">GAE Report</h2>
        <span className="text-xs text-slate-500">{periodLabel} · Amounts in PHP</span>
      </div>

      <div className="overflow-auto rounded-lg border border-emerald-200" style={{ maxHeight: "70vh" }}>
        <table className="w-full min-w-max text-sm">
          <thead className="sticky top-0 z-20 bg-[#edf6f1] text-left text-xs text-[#164b33]">
            <tr>
              <th className="sticky left-0 z-30 bg-[#edf6f1] px-2 py-2">Main Report</th>
              {headerCells()}
            </tr>
          </thead>
          <tbody>{renderRows(data.main)}</tbody>
        </table>
      </div>

      <h3 className="pt-2 text-sm font-semibold text-slate-800">Detailed Report</h3>
      <div className="overflow-auto rounded-lg border border-emerald-200" style={{ maxHeight: "70vh" }}>
        <table className="w-full min-w-max text-sm">
          <thead className="sticky top-0 z-20 bg-[#edf6f1] text-left text-xs text-[#164b33]">
            <tr>
              <th className="sticky left-0 z-30 bg-[#edf6f1] px-2 py-2">Detailed Report</th>
              {headerCells()}
            </tr>
          </thead>
          <tbody>{renderRows(data.detailed)}</tbody>
        </table>
      </div>

      {data.unmappedSubTypes.length > 0 && (
        <p className="text-xs text-slate-500">Mapped sub types not listed in the Detailed Report, shown as their own lines: {data.unmappedSubTypes.join(", ")}.</p>
      )}
    </section>
  );
}

// Shared by the GAE report and the Reports page's Comparison Chart: the same
// monthly TOTAL series, so the chart and the report always agree.
export function useGaeReport(fiscalYear: number) {
  return useQuery({
    queryKey: ["reports", "gae-report", fiscalYear],
    queryFn: async () => (await api2.get<GaeReportOut>("/reports/gae-report", { params: { fiscalYear } })).data,
  });
}

export function gaeChartSeries(data: GaeReportOut, comparison: string, granularity: "YTD" | "ANNUAL", ytdThrough: number) {
  const isMonthly = comparison === "monthly-comparison";
  const isQuarterly = comparison === "quarterly-comparison";
  const pair: { left: Measure; right: Measure; leftLabel: string; rightLabel: string } | null = comparison in PAIRS ? PAIRS[comparison as PairId] : isMonthly || isQuarterly ? PAIRS["budget-actual"] : null;
  if (!pair) return null;
  const total = data.main.find((r) => r.key === "total");
  if (!total) return null;
  const asOf = ytdThrough || data.asOfMonth || 12;
  const months = granularity === "YTD" ? Array.from({ length: asOf }, (_, i) => i + 1) : Array.from({ length: 12 }, (_, i) => i + 1);
  const points = isQuarterly
    ? [1, 2, 3, 4].filter((q) => months.some((m) => Math.ceil(m / 3) === q)).map((q) => {
        const qm = months.filter((m) => Math.ceil(m / 3) === q);
        const base = sumRange(total.series[pair.left], qm);
        const target = sumRange(total.series[pair.right], qm);
        return { period: `Q${q}`, baseline: base, target, variancePct: base ? ((target - base) / Math.abs(base)) * 100 : null };
      })
    : months.map((m) => {
        const base = total.series[pair.left][m - 1];
        const target = total.series[pair.right][m - 1];
        return { period: MONTHS[m - 1], baseline: base, target, variancePct: Math.abs(base) < 0.5 ? null : ((target - base) / Math.abs(base)) * 100 };
      });
  return { points, baselineLabel: pair.leftLabel, targetLabel: pair.rightLabel };
}

// Monthly / Quarterly Comparison: one measure (Actual, Budget or Forecast) per
// month or quarter, from the same TOTAL row the table and other charts use.
export type SingleMeasure = "budget" | "actual" | "forecast";
export function gaeSingleSeries(data: GaeReportOut, measure: SingleMeasure, granularity: "YTD" | "ANNUAL", ytdThrough: number, quarterly: boolean) {
  const total = data.main.find((r) => r.key === "total");
  if (!total) return null;
  const asOf = ytdThrough || data.asOfMonth || 12;
  const months = granularity === "YTD" ? Array.from({ length: asOf }, (_, i) => i + 1) : Array.from({ length: 12 }, (_, i) => i + 1);
  const series = total.series[measure];
  const points = quarterly
    ? [1, 2, 3, 4].filter((q) => months.some((m) => Math.ceil(m / 3) === q)).map((q) => ({ period: `Q${q}`, baseline: 0, target: sumRange(series, months.filter((m) => Math.ceil(m / 3) === q)), variancePct: null }))
    : months.map((m) => ({ period: MONTHS[m - 1], baseline: 0, target: series[m - 1], variancePct: null }));
  const label = measure[0].toUpperCase() + measure.slice(1);
  return { points, baselineLabel: label, targetLabel: label };
}

// The KPI cards' totals for the chosen comparison, from the GAE report's TOTAL row
// over the same months (YTD or full year) the table uses.
export function gaeKpiTotals(data: GaeReportOut, comparison: string, granularity: "YTD" | "ANNUAL", ytdThrough: number) {
  const pair = comparison in PAIRS ? PAIRS[comparison as PairId] : comparison === "monthly-comparison" || comparison === "quarterly-comparison" ? PAIRS["budget-actual"] : null;
  if (!pair) return null;
  const total = data.main.find((r) => r.key === "total");
  if (!total) return null;
  const asOf = ytdThrough || data.asOfMonth || 12;
  const months = granularity === "YTD" ? Array.from({ length: asOf }, (_, i) => i + 1) : Array.from({ length: 12 }, (_, i) => i + 1);
  return {
    baselineLabel: pair.leftLabel,
    baseline: sumRange(total.series[pair.left], months),
    targetLabel: pair.rightLabel,
    target: sumRange(total.series[pair.right], months),
    varianceLabel: `${pair.leftLabel} vs ${pair.rightLabel}`,
  };
}
