import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api2, type ReportTrendPoint } from "../api/client";
import { useFiscalYear } from "../lib/fiscalCycle";
import { ComparisonChart } from "./reports/ComparisonChart";
import { TrendTable } from "./reports/TrendTable";

// The 5-Year Trend report, on its own page rather than inside the Reports
// page's Primary Comparison views. Primary Comparison picks what the chart shows:
// Actual vs Budget (both series as bars), or Actual / Budget alone (a line).
type TrendMeasure = "pair" | "actual" | "budget";
const TREND_OPTIONS: { value: TrendMeasure; label: string }[] = [
  { value: "pair", label: "Actual vs Budget" },
  { value: "actual", label: "Actual" },
  { value: "budget", label: "Budget" },
];

interface TrendType {
  key: string;
  label: string;
  points: { fiscalYear: number; budget: number; actual: number }[];
}

export function ReportsTrendPage() {
  const { forecastYear } = useFiscalYear();
  const [measure, setMeasure] = useState<TrendMeasure>("pair");
  const { data: trendPoints = [], isLoading } = useQuery({
    queryKey: ["reports", "trend", forecastYear],
    queryFn: async () => (await api2.get<ReportTrendPoint[]>("/reports/trend", { params: { currentYear: forecastYear } })).data,
  });

  const { data: byType = [] } = useQuery({
    queryKey: ["reports", "trend-by-type", forecastYear],
    queryFn: async () => (await api2.get<TrendType[]>("/reports/trend-by-type", { params: { currentYear: forecastYear } })).data,
  });

  const title = `5-Year Trend — ${TREND_OPTIONS.find((o) => o.value === measure)?.label ?? ""}`;
  const points = trendPoints.map((p) => ({
    period: String(p.fiscalYear),
    baseline: p.budget,
    target: measure === "budget" ? p.budget : p.actual,
    variancePct: p.budget ? ((p.actual - p.budget) / p.budget) * 100 : null,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">{title}</h1>
          <p className="text-xs text-slate-500">Fiscal years ending {forecastYear}</p>
        </div>
        <Link to="/reports" className="text-sm font-medium text-emerald-800 hover:underline">Back to Reports</Link>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-600">Primary Comparison</label>
        <select className="mt-0.5 w-56 rounded border border-slate-300 px-2 py-1 text-xs" value={measure} onChange={(e) => setMeasure(e.target.value as TrendMeasure)}>
          {TREND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading trend…</div>
      ) : (
        <div className="space-y-3 rounded-lg border border-emerald-200 bg-white p-4 shadow-sm">
          <TrendTable points={trendPoints} />
          {measure === "pair" ? (
            <ComparisonChart title={title} baselineLabel="Budget" targetLabel="Actual" points={points} />
          ) : (
            <ComparisonChart title={title} baselineLabel="" targetLabel={measure === "budget" ? "Budget" : "Actual"} singleLabel={measure === "budget" ? "Budget" : "Actual"} asLine points={points} />
          )}
        </div>
      )}

      {/* One chart per GAE Main Report type, using the same Primary Comparison. */}
      {byType.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {byType.map((t) => {
            const typePoints = t.points.map((p) => ({
              period: String(p.fiscalYear),
              baseline: p.budget,
              target: measure === "budget" ? p.budget : p.actual,
              variancePct: p.budget ? ((p.actual - p.budget) / p.budget) * 100 : null,
            }));
            return measure === "pair" ? (
              <ComparisonChart key={t.key} title={t.label} baselineLabel="Budget" targetLabel="Actual" points={typePoints} />
            ) : (
              <ComparisonChart key={t.key} title={t.label} baselineLabel="" targetLabel={measure === "budget" ? "Budget" : "Actual"} singleLabel={measure === "budget" ? "Budget" : "Actual"} asLine points={typePoints} />
            );
          })}
        </div>
      )}
    </div>
  );
}
