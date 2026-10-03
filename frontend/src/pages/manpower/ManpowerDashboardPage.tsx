import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { StatusBadge } from "../../components/StatusBadge";
import { useFiscalYear } from "../../lib/fiscalCycle";
import { timeAgo } from "../../lib/timeAgo";

// The persisted status row a background sync writes to (see
// backend/src/lib/backgroundSync.ts) - `status`/`startedAt`/`finishedAt`/
// `error` describe the most recent attempt, which may have failed;
// `lastSuccessAt`/`resultJson` only ever update on a real success, so "last
// synced at <x>" keeps showing the last success even right after a later
// attempt errors out.
interface ManpowerSyncStatus {
  status: "idle" | "running" | "success" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  lastSuccessAt: string | null;
  resultJson: { unmapped: { payComponentName: string; companyCode: string }[] } | null;
  error: string | null;
}

interface Company {
  id: string;
  code: string;
  name: string;
}
interface GridCell {
  companyId: string;
  companyCode: string;
  ytdActual: number;
  remainingForecast: number;
  totalActualForecast: number;
  meritAmount: number;
  otherIncrease: number;
  additionalHeadcountCount: number;
  additionalHeadcountAmount: number;
  headcountAdjustmentAmount: number;
  budget: number;
  budgetVsPriorAmount: number;
  budgetVsPriorPercent: number;
}
interface GridRow {
  payComponent: { id: string; name: string; isHeadcountDriven: boolean; appliesMeritIncrease: boolean; forecastSource: string };
  cells: GridCell[];
  totalBudget: number;
}
interface HeadcountRowEntry {
  companyId: string;
  companyCode: string;
  baseHeadcount: number;
  additionalHeadcountCount: number;
  adjustment: number;
  effectiveHeadcount: number;
}
interface GridResponse {
  companies: Company[];
  rows: GridRow[];
  headcountRow: HeadcountRowEntry[];
  asOfMonth: number;
  meritRate: number;
}
interface Submission {
  fiscalYear: number;
  stage: "HR_ANALYST_DRAFT" | "HR_HEAD_REVIEW" | "BUDGET_OFFICER_REVIEW" | "UPLOADED_TO_SAP";
  sapDocumentNumber: string | null;
}
interface MeritRateConfig {
  fiscalYear: number;
  ratePercent: number;
}
interface DashboardSummaryRow {
  payComponentId: string;
  payComponentName: string;
  ytdActual: number;
  remainingForecast: number;
  totalActualForecast: number;
  meritAmount: number;
  additionalHeadcountAmount: number;
  headcountAdjustmentAmount: number;
  budget: number;
  budgetVsPriorAmount: number;
  budgetVsPriorPercent: number;
}
interface DashboardSummaryResponse {
  companyId: string | null;
  salaryRows: DashboardSummaryRow[];
  salaryTotal: DashboardSummaryRow;
  otherRows: DashboardSummaryRow[];
  otherTotal: DashboardSummaryRow;
}

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

type ColumnKey = "ytdActual" | "remainingForecast" | "totalActualForecast" | "meritAmount" | "additionalHeadcountAmount" | "headcountAdjustmentAmount" | "budget" | "budgetVsPriorAmount" | "budgetVsPriorPercent";

const COLUMN_LABELS: Record<ColumnKey, string> = {
  ytdActual: "YTD Actual",
  remainingForecast: "Remaining Forecast",
  totalActualForecast: "Actual + Forecast",
  meritAmount: "Merit Increase",
  additionalHeadcountAmount: "Additional Manpower",
  headcountAdjustmentAmount: "Headcount Adjustment",
  budget: "Proposed Budget",
  budgetVsPriorAmount: "Inc/Dec (Amount)",
  budgetVsPriorPercent: "Inc/Dec (%)",
};

// Notes_6: the on-page "Dashboard Report" card only shows these 4 metric
// columns; clicking "View Full Report" expands into a full-view window with
// every column, matching the "Manpower Budget Report"/"Manpower Budget
// Detailed Report" tabs of the real report file.
const COMPACT_COLUMNS: ColumnKey[] = ["totalActualForecast", "budget", "budgetVsPriorAmount", "budgetVsPriorPercent"];
const DETAILED_COLUMNS: ColumnKey[] = ["ytdActual", "remainingForecast", "totalActualForecast", "meritAmount", "additionalHeadcountAmount", "headcountAdjustmentAmount", "budget", "budgetVsPriorAmount", "budgetVsPriorPercent"];

export function ManpowerDashboardPage() {
  const { hasRole, currentUser } = useAuth();
  const isHrAnalyst = hasRole("HR_ANALYST");
  const isHrHead = currentUser?.department?.name === "Human Resources" && hasRole("CENTRALIZED_DEPARTMENT_HEAD");
  const isBudgetOfficer = hasRole("BUDGET_OFFICER");
  const { targetYear: FISCAL_YEAR } = useFiscalYear();

  const queryClient = useQueryClient();
  const { data: grid, isLoading } = useQuery({
    queryKey: ["manpower-grid"],
    queryFn: async () => (await api.get<GridResponse>(`/manpower/grid?fiscalYear=${FISCAL_YEAR}`)).data,
  });
  const { data: submission } = useQuery({
    queryKey: ["manpower-submission"],
    queryFn: async () => (await api.get<Submission>(`/manpower/submission?fiscalYear=${FISCAL_YEAR}`)).data,
  });
  const { data: meritRateConfig } = useQuery({
    queryKey: ["manpower-merit-rate"],
    queryFn: async () => (await api.get<MeritRateConfig>(`/manpower/merit-rate?fiscalYear=${FISCAL_YEAR}`)).data,
  });

  const [summaryCompanyId, setSummaryCompanyId] = useState<string>("ALL");
  const { data: dashboardSummary } = useQuery({
    queryKey: ["manpower-dashboard-summary", summaryCompanyId],
    queryFn: async () => (await api.get<DashboardSummaryResponse>(`/manpower/dashboard-summary?fiscalYear=${FISCAL_YEAR}${summaryCompanyId !== "ALL" ? `&companyId=${summaryCompanyId}` : ""}`)).data,
  });

  const [showDetailModal, setShowDetailModal] = useState(false);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["manpower-grid"] });
    queryClient.invalidateQueries({ queryKey: ["manpower-submission"] });
    queryClient.invalidateQueries({ queryKey: ["manpower-merit-rate"] });
    queryClient.invalidateQueries({ queryKey: ["manpower-dashboard-summary"] });
  };

  // The recompute itself now also runs automatically every 10 minutes (see
  // backend/src/index.ts's startup scheduler) - this button is a
  // supplementary on-demand refresh, not the only way this data ever
  // updates. It always runs in the background (a full KSSB V1 pull can take
  // longer than a normal request should sit open for), so this polls GET
  // /manpower/run/status for the result instead of awaiting the POST -
  // continuously, both so an automatic tick's progress shows up too and so
  // "last synced" stays fresh on its own.
  const [runStatus, setRunStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const startRunMutation = useMutation({
    mutationFn: async () => (await api.post("/manpower/run", { fiscalYear: FISCAL_YEAR })).data,
    onError: (err: any) => setRunStatus({ ok: false, message: err.response?.data?.error ?? "Could not start the run." }),
  });

  const { data: runPollData } = useQuery({
    queryKey: ["manpower-run-status"],
    queryFn: async () => (await api.get<ManpowerSyncStatus>("/manpower/run/status")).data,
    enabled: isHrAnalyst || isBudgetOfficer,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 5000 : 60000),
  });

  const previousRunStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!runPollData) return;
    const previous = previousRunStatusRef.current;
    previousRunStatusRef.current = runPollData.status;
    // Only react to a *transition* into success/error, not every poll tick
    // that happens to still read the same terminal status.
    if (previous === runPollData.status) return;
    if (runPollData.status === "success" && runPollData.resultJson) {
      invalidateAll();
      const unmapped = runPollData.resultJson.unmapped;
      setRunStatus(
        unmapped.length > 0
          ? { ok: true, message: `Ran successfully - ${unmapped.length} (Pay Component, Company) pair(s) have no GL/CC mapping yet and stayed at 0 (see Admin Console > Manpower GL/CC Mapping).` }
          : { ok: true, message: "Ran successfully - every pair pulled a real KSSB V1 figure." }
      );
    } else if (runPollData.status === "error") {
      setRunStatus({ ok: false, message: runPollData.error ?? "Run failed - could not reach the SAP data broker." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runPollData]);

  const runInProgress = runPollData?.status === "running";
  const lastRunLabel = runPollData?.lastSuccessAt ? `Last synced ${timeAgo(runPollData.lastSuccessAt)}` : runPollData && runPollData.status !== "idle" ? "Never synced successfully yet" : null;
  const submitMutation = useMutation({
    mutationFn: async () => (await api.post("/manpower/submit", { fiscalYear: FISCAL_YEAR })).data,
    onSuccess: invalidateAll,
  });
  const hrHeadDecisionMutation = useMutation({
    mutationFn: async (decision: "APPROVE" | "RETURN") => (await api.post("/manpower/hr-head-decision", { fiscalYear: FISCAL_YEAR, decision })).data,
    onSuccess: invalidateAll,
  });
  const budgetOfficerDecisionMutation = useMutation({
    mutationFn: async (decision: "RETURN" | "UPLOAD_TO_SAP") => (await api.post("/manpower/budget-officer-decision", { fiscalYear: FISCAL_YEAR, decision })).data,
    onSuccess: invalidateAll,
  });
  const meritRateMutation = useMutation({
    mutationFn: async (ratePercent: number) => (await api.put("/manpower/merit-rate", { fiscalYear: FISCAL_YEAR, ratePercent })).data,
    onSuccess: invalidateAll,
  });
  const headcountAdjustmentMutation = useMutation({
    mutationFn: async ({ companyId, adjustment }: { companyId: string; adjustment: number }) => (await api.put("/manpower/headcount-adjustment", { companyId, fiscalYear: FISCAL_YEAR, adjustment })).data,
    onSuccess: invalidateAll,
  });

  if (isLoading || !grid) return <div className="text-sm text-slate-400">Loading…</div>;

  const stage = submission?.stage ?? "HR_ANALYST_DRAFT";

  // Notes: Additional Headcount Request is a single total across all
  // companies (not broken out per company) - Current Headcount + Additional
  // Headcount Request + Headcount Adjustment = Total Headcount.
  const totalCurrentHeadcount = grid.headcountRow.reduce((s, h) => s + h.baseHeadcount, 0);
  const totalAdditionalHeadcount = grid.headcountRow.reduce((s, h) => s + h.additionalHeadcountCount, 0);
  const totalAdjustment = grid.headcountRow.reduce((s, h) => s + h.adjustment, 0);
  const totalHeadcount = totalCurrentHeadcount + totalAdditionalHeadcount + totalAdjustment;

  const selectedCompanyLabel = summaryCompanyId === "ALL" ? "All Companies" : (grid.companies.find((c) => c.id === summaryCompanyId)?.code ?? "");
  const exportUrl = `/api/manpower/export-dashboard-report?fiscalYear=${FISCAL_YEAR}${summaryCompanyId !== "ALL" ? `&companyId=${summaryCompanyId}` : ""}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <StatusBadge stage={stage} />
        {submission?.sapDocumentNumber && <span className="text-sm text-slate-500">SAP #{submission.sapDocumentNumber}</span>}
      </div>

      {isHrAnalyst && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <button
            onClick={() => {
              setRunStatus(null);
              startRunMutation.mutate();
            }}
            disabled={startRunMutation.isPending || runInProgress}
            title="Data refreshes automatically every 10 minutes - use this for an on-demand refresh instead of waiting."
            className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {startRunMutation.isPending || runInProgress ? "Running…" : "Run Manpower Budget"}
          </button>
          {lastRunLabel && (
            <span className="text-xs text-slate-500" title="SAP data refreshes automatically every 10 minutes.">
              {lastRunLabel}
            </span>
          )}
          {runStatus && <span className={`text-xs ${runStatus.ok ? "text-emerald-700" : "text-red-600"}`}>{runStatus.message}</span>}
          <div className="ml-2 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1.5 ring-1 ring-amber-200">
            <label className="text-xs font-semibold text-amber-800">Merit Increase Rate</label>
            <input type="number" className="w-16 rounded border border-amber-300 bg-white px-2 py-0.5 text-sm" defaultValue={meritRateConfig?.ratePercent ?? 0} key={meritRateConfig?.ratePercent} onBlur={(e) => meritRateMutation.mutate(Number(e.target.value) || 0)} />
            <span className="text-xs font-semibold text-amber-800">%</span>
          </div>
          {stage === "HR_ANALYST_DRAFT" && (
            <button onClick={() => submitMutation.mutate()} className="ml-auto rounded-md bg-slate-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700">
              Submit for HR Head Approval
            </button>
          )}
        </div>
      )}

      {isHrHead && stage === "HR_HEAD_REVIEW" && (
        <div className="flex gap-2">
          <button onClick={() => hrHeadDecisionMutation.mutate("APPROVE")} className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600">
            Approve
          </button>
          <button onClick={() => hrHeadDecisionMutation.mutate("RETURN")} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500">
            Return to HR Analyst
          </button>
        </div>
      )}

      {isBudgetOfficer && stage === "BUDGET_OFFICER_REVIEW" && (
        <div className="flex gap-2">
          <button onClick={() => budgetOfficerDecisionMutation.mutate("UPLOAD_TO_SAP")} className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600">
            Upload to SAP
          </button>
          <button onClick={() => budgetOfficerDecisionMutation.mutate("RETURN")} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500">
            Return to HR Analyst
          </button>
        </div>
      )}

      <HeadcountByCompanyTable headcountRow={grid.headcountRow} totalCurrentHeadcount={totalCurrentHeadcount} totalAdditionalHeadcount={totalAdditionalHeadcount} totalAdjustment={totalAdjustment} totalHeadcount={totalHeadcount} isBudgetOfficer={isBudgetOfficer} onAdjust={(companyId, adjustment) => headcountAdjustmentMutation.mutate({ companyId, adjustment })} />

      {/* Notes_6: the compact Dashboard Report (4 metric columns), matching
          the "Manpower Budget Report" tab - click "View Full Report" to
          expand every column in a full-view window ("Manpower Budget
          Detailed Report"). */}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        {dashboardSummary && (
          <ReportTable
            columns={COMPACT_COLUMNS}
            salaryRows={dashboardSummary.salaryRows}
            salaryTotal={dashboardSummary.salaryTotal}
            otherRows={dashboardSummary.otherRows}
            otherTotal={dashboardSummary.otherTotal}
            caption={
              <div className="flex items-center gap-3 px-3 py-1.5">
                <span className="text-xs font-semibold tracking-wide text-emerald-900">Dashboard Report</span>
                <select className="rounded border border-emerald-300 bg-white px-2 py-1 text-xs" value={summaryCompanyId} onChange={(e) => setSummaryCompanyId(e.target.value)}>
                  <option value="ALL">All Companies</option>
                  {grid.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code}
                    </option>
                  ))}
                </select>
                <button onClick={() => setShowDetailModal(true)} className="ml-auto rounded border border-emerald-300 bg-white px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50">
                  View Full Report ↗
                </button>
              </div>
            }
          />
        )}
      </div>

      {showDetailModal && dashboardSummary && (
        <div className="fixed inset-2 z-50 flex items-center justify-center bg-slate-900/60" onClick={() => setShowDetailModal(false)}>
          <div className="flex h-full w-full flex-col overflow-hidden rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between bg-emerald-800 px-5 py-3 text-white">
              <div>
                <div className="text-sm font-bold">Manpower Budget Detailed Report</div>
                <div className="text-xs text-emerald-100">{selectedCompanyLabel}</div>
              </div>
              <div className="flex items-center gap-2">
                <a href={exportUrl} className="rounded-md bg-white/15 px-2.5 py-1 text-xs font-semibold hover:bg-white/25">
                  Export to Excel
                </a>
                <button onClick={() => setShowDetailModal(false)} className="rounded-md bg-white/15 px-2.5 py-1 text-xs font-semibold hover:bg-white/25">
                  Close ✕
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto text-xs">
              <ReportTable columns={DETAILED_COLUMNS} salaryRows={dashboardSummary.salaryRows} salaryTotal={dashboardSummary.salaryTotal} otherRows={dashboardSummary.otherRows} otherTotal={dashboardSummary.otherTotal} dense />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Reusable renderer for both the compact Dashboard Report card and the
// full-view Detailed Report modal - same 2 sections (Salary, Other Manpower
// Benefits), different subset of metric columns.
function ReportTable({ columns, salaryRows, salaryTotal, otherRows, otherTotal, caption, dense }: { columns: ColumnKey[]; salaryRows: DashboardSummaryRow[]; salaryTotal: DashboardSummaryRow; otherRows: DashboardSummaryRow[]; otherTotal: DashboardSummaryRow; caption?: ReactNode; dense?: boolean }) {
  const formatValue = (col: ColumnKey, row: DashboardSummaryRow) => (col === "budgetVsPriorPercent" ? pct(row[col]) : peso(row[col]));
  const cellPad = dense ? "px-2 py-0.5" : "px-3 py-2";
  const sectionPad = dense ? "px-2 py-1" : "px-3 py-1.5";

  const renderRow = (row: DashboardSummaryRow, bold?: boolean) => (
    <tr key={row.payComponentId} className={bold ? "border-t border-slate-200 bg-emerald-50/60 font-semibold text-emerald-900" : "border-t border-slate-100"}>
      {/* Notes_6: freeze the row headers too (Account column), not just the
 column headers - sticky left-0 with a matching background so it
 stays opaque over the scrolling cells behind it. */}
      <td className={`sticky left-0 z-10 whitespace-nowrap ${bold ? "bg-emerald-50" : "bg-white"} ${cellPad}`}>{row.payComponentName}</td>
      {columns.map((col) => (
        <td key={col} className={`whitespace-nowrap ${cellPad}`}>
          {formatValue(col, row)}
        </td>
      ))}
    </tr>
  );

  const sectionHeader = (label: string) => (
    <tr className="border-t border-slate-200 bg-slate-100">
      <td colSpan={columns.length + 1} className={`${sectionPad} text-xs font-semibold tracking-wide text-slate-600`}>
        {label}
      </td>
    </tr>
  );

  return (
    <table className="w-full text-sm">
      {/* A <caption> (rather than a sibling <div>) always renders at the
 table's actual rendered width, so the green header still reaches
 the end of the table even when it's wide enough to scroll
 horizontally. */}
      {caption && <caption className="caption-top bg-emerald-50 p-0 text-left">{caption}</caption>}
      <thead className="text-left text-xs text-slate-500">
        <tr>
          {/* Notes_6: freeze the column headers when scrolling the Detailed
 Report modal - sticky on the <th> elements (not <thead>/<tr>)
 since sticky positioning on those is unreliable across
 browsers for table layouts. The corner cell freezes on both
 axes (z-20, above the plain top- or left-frozen cells). */}
          <th className={`sticky left-0 top-0 z-20 whitespace-nowrap bg-slate-50 ${cellPad}`}>Account</th>
          {columns.map((col) => (
            <th key={col} className={`sticky top-0 z-10 whitespace-nowrap bg-slate-50 ${cellPad}`}>
              {COLUMN_LABELS[col]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sectionHeader("Salary")}
        {salaryRows.map((r) => renderRow(r))}
        {renderRow(salaryTotal, true)}
        {sectionHeader("Other Manpower Benefits")}
        {otherRows.map((r) => renderRow(r))}
        {renderRow(otherTotal, true)}
      </tbody>
    </table>
  );
}

// Current + Additional Headcount by Company. Every company gets its own
// column - per user request, OCLP_PROJECT/OLC_PROJECT/OUTSOURCED are not
// merged into OCC/OCLP/OLC here.
function HeadcountByCompanyTable({ headcountRow, totalCurrentHeadcount, totalAdditionalHeadcount, totalAdjustment, totalHeadcount, isBudgetOfficer, onAdjust }: { headcountRow: HeadcountRowEntry[]; totalCurrentHeadcount: number; totalAdditionalHeadcount: number; totalAdjustment: number; totalHeadcount: number; isBudgetOfficer: boolean; onAdjust: (companyId: string, adjustment: number) => void }) {
  // CSS grid (not <table>) so every data column is exactly the same width
  // regardless of content - table-layout:fixed still lets browsers widen a
  // column to fit an unbreakable string like "OCLP_PROJECT", which a grid
  // with a fixed track size doesn't.
  // minmax(7rem, 1fr) keeps every data column exactly equal to the others
  // while letting them all grow together to fill the card's full width
  // (fixed 7rem tracks left a gap on the right instead of stretching).
  const gridTemplateColumns = `12rem repeat(${headcountRow.length + 1}, minmax(7rem, 1fr))`;
  const cellClass = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap px-3 py-2";

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="bg-emerald-50 px-3 py-1.5 text-xs font-semibold tracking-wide text-emerald-900">Headcount</div>
      <div className="w-full text-sm" style={{ display: "grid", gridTemplateColumns }}>
        <div className={`${cellClass} bg-slate-50 text-xs font-medium text-slate-500`}>&nbsp;</div>
        {headcountRow.map((h) => (
          <div key={h.companyId} className={`${cellClass} bg-slate-50 text-xs font-medium text-slate-500`} title={h.companyCode}>
            {h.companyCode}
          </div>
        ))}
        <div className={`${cellClass} bg-slate-50 text-xs font-medium text-slate-500`}>Total</div>

        <div className={`${cellClass} border-t border-slate-100 font-medium`}>Current Headcount</div>
        {headcountRow.map((h) => (
          <div key={h.companyId} className={`${cellClass} border-t border-slate-100`}>
            {h.baseHeadcount}
          </div>
        ))}
        <div className={`${cellClass} border-t border-slate-100 font-medium`}>{totalCurrentHeadcount}</div>

        <div className={`${cellClass} border-t border-slate-100 bg-amber-50/50 font-medium`}>Additional Manpower</div>
        {headcountRow.map((h) => (
          <div key={h.companyId} className={`${cellClass} border-t border-slate-100 bg-amber-50/50`}>
            +{h.additionalHeadcountCount}
          </div>
        ))}
        <div className={`${cellClass} border-t border-slate-100 bg-amber-50/50 font-medium`}>+{totalAdditionalHeadcount}</div>

        {/* Notes_6: Budget-Officer-only manual add/deduct, not tied to a
 rank - flows into Total Headcount and the Dashboard Report's
 Headcount Adjustment column. */}
        <div className={`${cellClass} border-t border-slate-100 bg-sky-50/50 font-medium`}>Headcount Adjustment</div>
        {headcountRow.map((h) =>
          isBudgetOfficer ? (
            <div key={h.companyId} className={`${cellClass} border-t border-slate-100 bg-sky-50/50`}>
              <input
                type="number"
                className="w-16 rounded border border-sky-300 bg-white px-1.5 py-0.5 text-sm"
                defaultValue={h.adjustment}
                key={h.adjustment}
                onBlur={(e) => {
                  const value = Number(e.target.value) || 0;
                  if (value !== h.adjustment) onAdjust(h.companyId, value);
                }}
              />
            </div>
          ) : (
            <div key={h.companyId} className={`${cellClass} border-t border-slate-100 bg-sky-50/50`}>
              {h.adjustment >= 0 ? `+${h.adjustment}` : h.adjustment}
            </div>
          ),
        )}
        <div className={`${cellClass} border-t border-slate-100 bg-sky-50/50 font-medium`}>{totalAdjustment >= 0 ? `+${totalAdjustment}` : totalAdjustment}</div>

        <div className={`${cellClass} border-t border-slate-200 bg-emerald-50/60 font-semibold text-emerald-900`}>Total Headcount</div>
        {headcountRow.map((h) => (
          <div key={h.companyId} className={`${cellClass} border-t border-slate-200 bg-emerald-50/60 font-semibold text-emerald-900`}>
            {h.effectiveHeadcount}
          </div>
        ))}
        <div className={`${cellClass} border-t border-slate-200 bg-emerald-50/60 font-semibold text-emerald-900`}>{totalHeadcount}</div>
      </div>
    </div>
  );
}
