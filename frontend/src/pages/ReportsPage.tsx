import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api2,
  FINANCIAL_SCOPE_OPTIONS,
  type FinancialScope,
  type PeriodGridResult,
  type ReportFilterOptions,
  type ReportNote,
  type ReportSeriesPoint,
  type ReportSummary,
  type ReportTrendPoint,
} from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { SectionLabel, TabBar } from "../components/TabBar";
import { SearchableSelect } from "../components/SearchableSelect";
import { ExpandableSection } from "../components/ExpandableSection";
import { useFiscalYear } from "../lib/fiscalCycle";
import { KpiCards } from "./reports/KpiCards";
import { ComparisonChart } from "./reports/ComparisonChart";
import { ScopeDonutChart } from "./reports/ScopeDonutChart";
import { ReportTable, type ComparisonMeta } from "./reports/ReportTable";
import { PeriodGridTable } from "./reports/PeriodGridTable";
import { TrendTable } from "./reports/TrendTable";

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Note 12 revision - "latest year should be the current year. Add year as
// necessary": computed from the real current calendar year (forecastYear -
// the year that's actually happening, not the future year Module 1's New
// Request/Approved Budget are preparing), not a hardcoded list that goes
// stale every year.
function calendarYearsEndingAt(latestYear: number): number[] {
  return Array.from({ length: 8 }, (_, i) => latestYear - 7 + i);
}

// Note 12 revision - Primary Comparison, revised to 8 options (from 5).
// "5-Year Trend" is deliberately NOT one of them - it's reachable only via
// the "5-Year Trend" Saved View below, same as before this revision just
// under its new name (still the same "trend" internal id/state value).
type ComparisonId = "budget-actual" | "budget-forecast" | "forecast-actual" | "yoy-actual" | "yoy-forecast" | "yoy-budget" | "monthly-comparison" | "quarterly-comparison" | "trend";
const COMPARISON_OPTIONS: { value: Exclude<ComparisonId, "trend">; label: string }[] = [
  { value: "budget-actual", label: "Budget vs Actual" },
  { value: "budget-forecast", label: "Budget vs Forecast" },
  { value: "forecast-actual", label: "Forecast vs Actual" },
  { value: "yoy-actual", label: "Last Year Actual vs Current Year Actual" },
  { value: "yoy-forecast", label: "Last Year Actual vs Current Year Forecast" },
  { value: "yoy-budget", label: "Last Year Actual vs Current Year Budget" },
  { value: "monthly-comparison", label: "Monthly Comparison" },
  { value: "quarterly-comparison", label: "Quarterly Comparison" },
];
type SingleComparisonId = "budget-actual" | "budget-forecast" | "forecast-actual" | "yoy-actual" | "yoy-forecast" | "yoy-budget";
const COMPARISON_META: Record<SingleComparisonId, ComparisonMeta & { baselineLabel: string; targetLabel: string }> = {
  "budget-actual": { leftLabel: "Budget", leftKey: "budgetCurrent", rightLabel: "Actual", rightKey: "actualCurrent", varianceLabel: "Budget vs Actual", varianceKey: "variance", baselineLabel: "Budget", targetLabel: "Actual" },
  "budget-forecast": { leftLabel: "Budget", leftKey: "budgetCurrent", rightLabel: "Forecast", rightKey: "forecastCurrent", varianceLabel: "Budget vs Forecast", varianceKey: "varianceBudgetForecast", baselineLabel: "Budget", targetLabel: "Forecast" },
  "forecast-actual": { leftLabel: "Forecast", leftKey: "forecastCurrent", rightLabel: "Actual", rightKey: "actualCurrent", varianceLabel: "Forecast vs Actual", varianceKey: "varianceActualForecast", baselineLabel: "Forecast", targetLabel: "Actual" },
  "yoy-actual": { leftLabel: "LY Actual", leftKey: "actualPrior", rightLabel: "CY Actual", rightKey: "actualCurrent", varianceLabel: "YoY Actual", varianceKey: "varianceActualYoY", baselineLabel: "LY Actual", targetLabel: "CY Actual" },
  "yoy-forecast": { leftLabel: "LY Actual", leftKey: "actualPrior", rightLabel: "CY Forecast", rightKey: "forecastCurrent", varianceLabel: "LY Actual vs CY Forecast", varianceKey: "varianceLYActualCYForecast", baselineLabel: "LY Actual", targetLabel: "CY Forecast" },
  "yoy-budget": { leftLabel: "LY Actual", leftKey: "actualPrior", rightLabel: "CY Budget", rightKey: "budgetCurrent", varianceLabel: "LY Actual vs CY Budget", varianceKey: "varianceLYActualCYBudget", baselineLabel: "LY Actual", targetLabel: "CY Budget" },
};
function isSingleComparison(c: ComparisonId): c is SingleComparisonId {
  return c in COMPARISON_META;
}

// Note 12 revision - Time Granularity now only governs the table's period
// for the 6 single-pair comparisons above (Monthly/Quarterly moved out to
// their own dedicated Primary Comparison modes, so they're no longer tabs
// here - see the "not applicable" rule below).
type Granularity = "YTD" | "ANNUAL";
const GRANULARITY_TABS: { id: Granularity; label: string }[] = [
  { id: "YTD", label: "YTD" },
  { id: "ANNUAL", label: "Annual" },
];

type PresetId = "executive-summary" | "variance-alert" | "5-year-trend";
const PRESETS: { id: PresetId; label: string }[] = [
  { id: "executive-summary", label: "Executive Summary" },
  { id: "variance-alert", label: "Variance Alert View" },
  { id: "5-year-trend", label: "5-Year Trend" },
];

// Phase 4 — Budget Report & Analysis (Note 12's dashboard redesign, revised
// further per the follow-up note). Served by the FastAPI backend
// (backend-py/), reached via api2. Access is gated by RequireReportAccess
// (App.tsx) before this even mounts. FR-4.8's period sign-off lives in the
// Admin Console (PeriodSignOffTab) instead of here.
export function ReportsPage() {
  const { forecastYear } = useFiscalYear();
  const queryClient = useQueryClient();

  const [comparison, setComparison] = useState<ComparisonId>("budget-actual");
  const [financialScope, setFinancialScope] = useState<FinancialScope[]>([]); // empty = Select All
  const [fiscalYear, setFiscalYear] = useState(forecastYear);
  const [granularity, setGranularity] = useState<Granularity>("YTD");
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [costCenter, setCostCenter] = useState("");
  const [glAccount, setGlAccount] = useState("");
  const [sbu, setSbu] = useState("");
  const [notesGroup, setNotesGroup] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [activePreset, setActivePreset] = useState<PresetId>("executive-summary");
  const [tableResetKey, setTableResetKey] = useState(0);
  // Note 12 follow-up - "Variance Alert View: Put a field to indicate a
  // variance in % and in Peso." A row is flagged when EITHER is breached
  // (see ReportTable's isAlertRow), so a Peso-only or %-only swing still
  // surfaces. Peso threshold starts unset ("") - only the %-threshold (same
  // default the heatmap always used) applies until the user opts into one.
  const [varianceThresholdPct, setVarianceThresholdPct] = useState(10);
  const [varianceThresholdPeso, setVarianceThresholdPeso] = useState<number | "">("");

  const calendarYears = calendarYearsEndingAt(forecastYear);

  const applyPreset = (id: PresetId) => {
    setActivePreset(id);
    setFinancialScope([]);
    if (id === "5-year-trend") {
      setComparison("trend");
    } else {
      setComparison("budget-actual");
      setGranularity("YTD");
    }
    setTableResetKey((k) => k + 1);
  };

  const isPeriodGrid = comparison === "monthly-comparison" || comparison === "quarterly-comparison";
  const isTrend = comparison === "trend";
  const period = granularity;
  // Comma-joined, not a repeated query param - axios's default array
  // serialization (financialScope[]=X) doesn't match what FastAPI's
  // list[str] query params expect (repeated financialScope=X&financialScope=Y),
  // so the backend takes one comma-joined string instead.
  const scopeParam = financialScope.length > 0 ? financialScope.join(",") : undefined;
  const sbuParam = sbu || undefined;

  const { data: filterOptions = { costCenters: [], glAccounts: [], expenseGroups: [], sbus: [], financialScopes: [] } } = useQuery({
    queryKey: ["reports", "filter-options"],
    queryFn: async () => (await api2.get<ReportFilterOptions>("/reports/filter-options")).data,
  });

  const { data: summary, isLoading } = useQuery({
    queryKey: ["reports", "summary", fiscalYear, period, costCenter, glAccount, financialScope, sbu],
    queryFn: async () =>
      (
        await api2.get<ReportSummary>("/reports/cc-gl-summary", {
          params: { fiscalYear, period, costCenter: costCenter || undefined, glAccount: glAccount || undefined, financialScope: scopeParam, sbu: sbuParam },
        })
      ).data,
    enabled: !isTrend && !isPeriodGrid,
  });

  const { data: seriesPoints = [] } = useQuery({
    queryKey: ["reports", "series", fiscalYear, costCenter, glAccount, financialScope, sbu],
    queryFn: async () =>
      (
        await api2.get<ReportSeriesPoint[]>("/reports/series", {
          params: { fiscalYear, granularity: "MONTHLY", costCenter: costCenter || undefined, glAccount: glAccount || undefined, financialScope: scopeParam, sbu: sbuParam },
        })
      ).data,
    // Note 12 - /reports/series is single-year (Budget/Actual/Forecast for
    // this fiscalYear); "LY Actual vs CY X" comparisons would need a genuine
    // 2-year monthly series this pass doesn't build (out of scope) - the
    // chart is skipped for those, the KPI cards + table still show the real
    // prior-vs-current totals.
    enabled: !isTrend && !isPeriodGrid && comparison !== "yoy-actual" && comparison !== "yoy-forecast" && comparison !== "yoy-budget",
  });

  const { data: trendPoints = [] } = useQuery({
    queryKey: ["reports", "trend", forecastYear, costCenter, glAccount, financialScope, sbu],
    queryFn: async () => (await api2.get<ReportTrendPoint[]>("/reports/trend", { params: { currentYear: forecastYear, costCenter: costCenter || undefined, glAccount: glAccount || undefined, financialScope: scopeParam, sbu: sbuParam } })).data,
    enabled: isTrend,
  });

  const { data: periodGrid } = useQuery({
    queryKey: ["reports", "period-grid", fiscalYear, comparison, costCenter, glAccount, financialScope, sbu],
    queryFn: async () =>
      (
        await api2.get<PeriodGridResult>("/reports/period-grid", {
          params: { fiscalYear, granularity: comparison === "monthly-comparison" ? "MONTHLY" : "QUARTERLY", costCenter: costCenter || undefined, glAccount: glAccount || undefined, financialScope: scopeParam, sbu: sbuParam },
        })
      ).data,
    enabled: isPeriodGrid,
  });

  const { data: notes = [] } = useQuery({
    queryKey: ["reports", "notes", fiscalYear, notesGroup],
    queryFn: async () => (await api2.get<ReportNote[]>("/reports/notes", { params: { fiscalYear, expenseGroup: notesGroup } })).data,
    enabled: !!notesGroup,
  });
  const addNoteMutation = useMutation({
    mutationFn: async () => (await api2.post<ReportNote>("/reports/notes", { fiscalYear, expenseGroup: notesGroup, text: noteText })).data,
    onSuccess: () => {
      setNoteText("");
      queryClient.invalidateQueries({ queryKey: ["reports", "notes", fiscalYear, notesGroup] });
      queryClient.invalidateQueries({ queryKey: ["reports", "summary"] });
    },
  });

  const exportExcel = async () => {
    const res = await api2.get("/reports/export", {
      params: { fiscalYear, period, costCenter: costCenter || undefined, glAccount: glAccount || undefined, financialScope: scopeParam, sbu: sbuParam },
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data as Blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `budget-report-${fiscalYear}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const rows = summary?.rows ?? [];
  const totals = summary?.totals;
  const notesRow = rows.find((r) => r.expenseGroup === notesGroup);
  const meta = isSingleComparison(comparison) ? COMPARISON_META[comparison] : null;

  const scopeTotals: Record<FinancialScope, number> = { OPEX: 0, REVENUE: 0, NPC: 0 };
  for (const r of rows) {
    if (r.financialScope) scopeTotals[r.financialScope] += r.budgetCurrent;
  }

  const toggleScope = (scope: FinancialScope) => {
    setFinancialScope((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  };

  return (
    <div className="mx-auto max-w-6xl space-y-3">
      <PageHeader
        actions={
          !isTrend &&
          !isPeriodGrid && (
            <button onClick={exportExcel} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600">
              Export to Excel
            </button>
          )
        }
      />

      {/* Section 0 - control bar: Primary Comparison / Financial Scope /
          Calendar Year / Time Granularity, per Note 12's own control table. */}
      <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <label className="block text-xs font-medium text-slate-600">Primary Comparison</label>
            <select className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs" value={comparison === "trend" ? "budget-actual" : comparison} onChange={(e) => setComparison(e.target.value as ComparisonId)}>
              {COMPARISON_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="relative">
            <label className="block text-xs font-medium text-slate-600">Financial Scope</label>
            <button onClick={() => setScopePickerOpen((o) => !o)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-left text-xs">
              {financialScope.length === 0 ? "Select All" : financialScope.map((s) => FINANCIAL_SCOPE_OPTIONS.find((o) => o.value === s)?.label ?? s).join(", ")}
            </button>
            {scopePickerOpen && (
              <div className="absolute z-10 mt-1 w-full rounded border border-slate-300 bg-white p-2 text-xs shadow-lg">
                <label className="flex items-center gap-1.5 py-0.5">
                  <input type="checkbox" checked={financialScope.length === 0} onChange={() => setFinancialScope([])} />
                  Select All
                </label>
                {FINANCIAL_SCOPE_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-center gap-1.5 py-0.5">
                    <input type="checkbox" checked={financialScope.includes(o.value)} onChange={() => toggleScope(o.value)} />
                    {o.label}
                  </label>
                ))}
                <button onClick={() => setScopePickerOpen(false)} className="mt-1 w-full rounded bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-200">
                  Done
                </button>
              </div>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600">Calendar Year</label>
            <select className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs" value={fiscalYear} onChange={(e) => setFiscalYear(Number(e.target.value))}>
              {calendarYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          {/* Note 12 revision - "Time Granularity for Monthly and Quarterly
              Comparison is not applicable" - hidden entirely for those two
              Primary Comparison modes and for 5-Year Trend (which has its
              own fixed yearly window instead). */}
          {!isPeriodGrid && !isTrend && (
            <div>
              <label className="block text-xs font-medium text-slate-600">Time Granularity</label>
              <div className="mt-0.5">
                <TabBar tabs={GRANULARITY_TABS} active={granularity} onChange={setGranularity} />
              </div>
            </div>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-2">
          <span className="text-[11px] font-medium text-slate-500">Saved Views:</span>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => applyPreset(p.id)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${activePreset === p.id ? "bg-emerald-700 text-white" : "border border-slate-300 text-slate-600 hover:bg-slate-50"}`}
            >
              {p.label}
            </button>
          ))}
          <button onClick={() => setMoreFiltersOpen((o) => !o)} className="ml-auto text-[11px] font-medium text-emerald-700 hover:underline">
            {moreFiltersOpen ? "Hide filters" : "More filters"}
          </button>
        </div>

        {activePreset === "variance-alert" && (
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-2 text-xs">
            <span className="font-medium text-slate-500">Flag a variance over:</span>
            <label className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                step={0.5}
                className="w-16 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                value={varianceThresholdPct}
                onChange={(e) => setVarianceThresholdPct(e.target.value === "" ? 0 : Number(e.target.value))}
              />
              <span>%</span>
            </label>
            <span className="text-slate-400">or</span>
            <label className="flex items-center gap-1">
              <span>PHP</span>
              <input
                type="number"
                min={0}
                step={1000}
                placeholder="e.g. 500000"
                className="w-28 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
                value={varianceThresholdPeso}
                onChange={(e) => setVarianceThresholdPeso(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </label>
          </div>
        )}

        {moreFiltersOpen && (
          <div className="mt-2 grid grid-cols-2 gap-2 border-t border-slate-100 pt-2 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-slate-600">Cost Center</label>
              <SearchableSelect placeholder="All cost centers…" options={filterOptions.costCenters.map((c) => ({ value: c.code, label: c.code, sublabel: c.name }))} value={costCenter} onChange={setCostCenter} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">GL Account</label>
              <SearchableSelect placeholder="All GL accounts…" options={filterOptions.glAccounts.map((g) => ({ value: g.code, label: g.code, sublabel: g.name }))} value={glAccount} onChange={setGlAccount} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">SBU</label>
              <select className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs" value={sbu} onChange={(e) => setSbu(e.target.value)}>
                <option value="">All SBUs</option>
                {filterOptions.sbus.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {!isTrend && !isPeriodGrid && summary?.latestActualMonth && (
        <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-1.5 text-xs text-blue-800">
          Current YTD Reporting Period: <span className="font-semibold">Jan–{MONTH_NAMES[summary.latestActualMonth - 1]} {summary.fiscalYear}</span> (latest month with posted Actuals)
        </div>
      )}

      {isTrend ? (
        <ExpandableSection title="5-Year Trend — Budget vs Actual">
          <div className="space-y-3">
            <ComparisonChart
              title="5-Year Trend — Budget vs Actual"
              baselineLabel="Budget"
              targetLabel="Actual"
              points={trendPoints.map((p) => ({ period: String(p.fiscalYear), baseline: p.budget, target: p.actual, variancePct: p.budget ? ((p.actual - p.budget) / p.budget) * 100 : null }))}
            />
            <TrendTable points={trendPoints} />
          </div>
        </ExpandableSection>
      ) : isPeriodGrid ? (
        periodGrid && (
          <ExpandableSection title={comparison === "monthly-comparison" ? "Monthly Comparison" : "Quarterly Comparison"}>
            <PeriodGridTable data={periodGrid} />
          </ExpandableSection>
        )
      ) : (
        <>
          {totals && meta && <KpiCards baselineLabel={meta.baselineLabel} baseline={rowMetric(totals, meta.leftKey)} targetLabel={meta.targetLabel} target={rowMetric(totals, meta.rightKey)} varianceLabel={meta.varianceLabel} />}

          {/* Note 12 revision - table moved above the charts for every view
              (was below before this revision). */}
          {meta && (
            <ExpandableSection title="Budget Report Detail">
              <ReportTable
                key={tableResetKey}
                rows={rows}
                meta={meta}
                notesGroup={notesGroup}
                onToggleNotes={(group) => setNotesGroup(notesGroup === group ? null : group)}
                initialSortByVariance={activePreset === "variance-alert"}
                initialExpandOverThreshold={activePreset === "variance-alert"}
                thresholdPct={varianceThresholdPct}
                thresholdPeso={varianceThresholdPeso === "" ? null : varianceThresholdPeso}
              />
            </ExpandableSection>
          )}
          {isLoading && <div className="text-center text-xs text-slate-400">Loading…</div>}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2">
              {meta && comparison !== "yoy-actual" && comparison !== "yoy-forecast" && comparison !== "yoy-budget" ? (
                <ExpandableSection title="Comparison Chart">
                  <ComparisonChart title="Comparison Chart" baselineLabel={meta.baselineLabel} targetLabel={meta.targetLabel} points={seriesPoints.map((p) => ({ period: p.period, baseline: p.budget, target: comparison === "forecast-actual" ? p.forecast ?? 0 : comparison === "budget-forecast" ? p.forecast ?? 0 : p.actual, variancePct: p.variancePct }))} />
                </ExpandableSection>
              ) : (
                <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-xs text-slate-400">
                  A month-by-month chart isn't available for this comparison yet — see the KPI cards and table above for the Last-Year-vs-Current-Year totals.
                </div>
              )}
            </div>
            <ExpandableSection title="Financial Scope Breakdown">
              <ScopeDonutChart totalsByScope={scopeTotals} onSliceClick={(scope) => setFinancialScope([scope])} />
            </ExpandableSection>
          </div>
        </>
      )}

      {notesGroup && (
        <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
          <SectionLabel>Notes — {notesGroup}</SectionLabel>

          {notesRow && (
            <div className="mb-2 grid grid-cols-3 gap-2 rounded-md bg-slate-50 p-2 text-xs">
              <div>
                <div className="text-[10px] font-semibold tracking-wide text-slate-500">Budget vs Actual</div>
                <div className={`font-semibold ${notesRow.variance < 0 ? "text-red-600" : "text-slate-700"}`}>{peso(notesRow.variance)}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold tracking-wide text-slate-500">Budget vs Forecast</div>
                <div className={`font-semibold ${notesRow.varianceBudgetForecast != null && notesRow.varianceBudgetForecast < 0 ? "text-red-600" : "text-slate-700"}`}>{notesRow.varianceBudgetForecast != null ? peso(notesRow.varianceBudgetForecast) : "—"}</div>
              </div>
              <div>
                <div className="text-[10px] font-semibold tracking-wide text-slate-500">Forecast vs Actual</div>
                <div className={`font-semibold ${notesRow.varianceActualForecast != null && notesRow.varianceActualForecast < 0 ? "text-red-600" : "text-slate-700"}`}>{notesRow.varianceActualForecast != null ? peso(notesRow.varianceActualForecast) : "—"}</div>
              </div>
            </div>
          )}

          {notes.length === 0 ? (
            <div className="text-xs text-slate-500">No notes yet.</div>
          ) : (
            <ul className="space-y-1.5">
              {notes.map((n) => (
                <li key={n.id} className="border-l-2 border-emerald-200 pl-2 text-xs">
                  <div className="text-slate-700">{n.text}</div>
                  <div className="text-[10px] text-slate-400">
                    {n.authorName} · {new Date(n.createdAt).toLocaleString()}
                    {n.month && ` · ${MONTH_NAMES[n.month - 1]}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-2">
            <textarea className="w-full rounded border border-slate-300 px-2 py-1 text-xs" rows={2} placeholder="Add a note…" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
            <button onClick={() => addNoteMutation.mutate()} disabled={!noteText.trim() || addNoteMutation.isPending} className="shrink-0 rounded-md bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function rowMetric(row: ReportSummary["totals"], key: ComparisonMeta["leftKey"]): number | null {
  if (key === "varianceBudgetForecast") return row.forecastCurrent != null ? row.budgetCurrent - row.forecastCurrent : null;
  if (key === "varianceActualForecast") return row.forecastCurrent != null ? row.actualCurrent - row.forecastCurrent : null;
  if (key === "varianceActualYoY") return row.actualCurrent - row.actualPrior;
  if (key === "varianceLYActualCYForecast") return row.forecastCurrent != null ? row.forecastCurrent - row.actualPrior : null;
  if (key === "varianceLYActualCYBudget") return row.budgetCurrent - row.actualPrior;
  if (key === "actualPrior") return row.actualPrior;
  return row[key];
}
