import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2 } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { IoDetailModal } from "../components/IoDetailModal";
import { ExpandableSection, ExpandButton } from "../components/ExpandableSection";
import { formatAufnr } from "../lib/formatAufnr";
import { SearchableSelect } from "../components/SearchableSelect";
import { useFiscalYear } from "../lib/fiscalCycle";
import { timeAgo } from "../lib/timeAgo";

type ViewTab = "overview" | "reconciliation" | "npc";

// Phase 2 (Functional Spec §4) - "Budget Utilization Tracking". Served by
// the FastAPI backend (backend-py/), reached via the api2 client / /api2
// proxy rather than Node's api client. The Target Calendar Year itself still
// comes from the Node backend's FiscalCycleConfig singleton (shared Postgres
// DB) via useFiscalYear() - the one config both backends' UIs read.

interface Department {
  id: string;
  name: string;
}

interface OverviewRow {
  glAccount: string;
  costCenter: string;
  glAccountName: string | null;
  costCenterName: string | null;
  approvedBudget: number;
  actualExpenditures: number;
  commitments: number;
  totalAllotted: number;
  available: number;
}

interface ReconciliationRow {
  // Null for a DOE row - DOE has no Expense Line Item catalog, just a raw
  // GL-CC pair (see glAccount/costCenter below), reconciled directly against
  // SAP actuals the same way Overview already does.
  expenseLineItemId: string | null;
  expenseLineItemName: string;
  glAccount: string | null;
  costCenter: string | null;
  approvedBudget: number;
  sapActual: number;
  statusText: string;
}

interface UnmappedRow {
  id: number;
  itemText: string;
  amount: number;
  glAccount: string;
  costCenter: string;
  postedAt: string;
}

interface LineItem {
  id: string;
  name: string;
}

interface ReconciliationResponse {
  rows: ReconciliationRow[];
  unmapped: UnmappedRow[];
  lineItems: LineItem[];
}

interface NpcSbuOption {
  value: string;
  label: string;
}

interface NpcUtilizationRow {
  budgetCode: string;
  projectTitle: string;
  amount: number;
  location: string | null;
  group: string | null;
  sbu: string;
  ioCodes: string[];
  ioAmount: number;
  balance: number;
}

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

interface SapSyncStatus {
  status: "idle" | "running" | "success" | "error";
  fiscalYear: number;
  startedAt: string | null;
  finishedAt: string | null;
  // Only ever set by a successful run - stays put through a later failed
  // attempt (see routers/utilization.py's own comment), so "last synced"
  // keeps showing the last real success even right after `status`/`error`
  // flip to a failed attempt's outcome.
  lastSuccessAt?: string | null;
  actualsSynced?: number | null;
  commitmentsSynced?: number | null;
  error?: string | null;
}


export function UtilizationPage() {
  const { hasRole, gate, currentUser } = useAuth();
  const isBudgetOfficer = hasRole("BUDGET_OFFICER");
  const isBca = currentUser?.groups.some((g) => g.group === "BCA") ?? false;
  // forecastYear, not targetYear - Budget Utilization Tracking follows the
  // current (already-in-force) calendar year, tracking actual spend against
  // the budget already finalized for it - not the next year's ask still
  // being prepared (that's targetYear, used by New Request/Approved Budget).
  const { forecastYear: FISCAL_YEAR } = useFiscalYear();
  const [openIo, setOpenIo] = useState<string | null>(null);
  const [exportingNpc, setExportingNpc] = useState(false);
  const [npcSearch, setNpcSearch] = useState("");
  const [npcBalanceFilter, setNpcBalanceFilter] = useState<"all" | "positive" | "negative" | "zero">("all");
  const [npcSort, setNpcSort] = useState<{ key: keyof NpcUtilizationRow | "ioCodes"; dir: "asc" | "desc" } | null>(null);
  const toggleNpcSort = (key: keyof NpcUtilizationRow | "ioCodes") => setNpcSort((cur) => (cur?.key === key ? (cur.dir === "asc" ? { key, dir: "desc" } : null) : { key, dir: "asc" }));
  const [exportingOv, setExportingOv] = useState(false);
  // Per-column text filters on the Overview table (case-insensitive "contains").
  const [ovSort, setOvSort] = useState<{ key: keyof OverviewRow; dir: "asc" | "desc" } | null>(null);
  const toggleOvSort = (key: keyof OverviewRow) => setOvSort((cur) => (cur?.key === key ? (cur.dir === "asc" ? { key, dir: "desc" } : null) : { key, dir: "asc" }));
  const [ovSearch, setOvSearch] = useState("");
  const [availFilter, setAvailFilter] = useState<"all" | "positive" | "negative" | "zero">("all");
  // Which view is active lives in `?view=`, driven by Layout.tsx's
  // UtilizationSidebarNav (spec item 17 - moved out of this page's own
  // in-page TabBar into the sidebar, same pattern Phase 3 already uses).
  const [searchParams] = useSearchParams();
  const viewParam = searchParams.get("view");
  // With no ?view=, land on the first page the user's group actually grants
  // (e.g. an NPC-only member has no Departmental Overview).
  const defaultTab: ViewTab = gate("util.overview", true) ? "overview" : gate("util.reconciliation", true) ? "reconciliation" : "npc";
  const tab: ViewTab = viewParam === "reconciliation" || viewParam === "npc" ? viewParam : viewParam === null ? defaultTab : "overview";

  const { data: departments = [] } = useQuery({
    queryKey: ["utilization", "departments"],
    queryFn: async () => (await api2.get<Department[]>("/utilization/departments")).data,
  });

  const [departmentId, setDepartmentId] = useState("");
  // BCA sees every department combined, always - no picker needed (or shown).
  const effectiveDeptId = isBca ? "ALL" : departmentId || departments[0]?.id || "";

  const { data: overviewRows = [], isLoading: overviewLoading } = useQuery({
    queryKey: ["utilization", "overview", effectiveDeptId],
    queryFn: async () =>
      (
        await api2.get<OverviewRow[]>("/utilization/overview", {
          params: { departmentId: effectiveDeptId, fiscalYear: FISCAL_YEAR },
        })
      ).data,
    enabled: !!effectiveDeptId && tab === "overview",
  });
  const filteredUnsorted = overviewRows.filter((r) => {
    const has = (v: string | null, q: string) => !q.trim() || (v ?? "").toLowerCase().includes(q.trim().toLowerCase());
    const availOk = availFilter === "all" || (availFilter === "positive" ? r.available > 0 : availFilter === "negative" ? r.available < 0 : r.available === 0);
    const q = ovSearch.trim().toLowerCase();
    return availOk && (!q || [r.glAccount, r.costCenter, r.glAccountName, r.costCenterName].some((v) => (v ?? "").toLowerCase().includes(q)));
  });
  const filteredOverviewRows = ovSort
    ? [...filteredUnsorted].sort((a, b) => {
        const av = a[ovSort.key] ?? "";
        const bv = b[ovSort.key] ?? "";
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true });
        return ovSort.dir === "asc" ? cmp : -cmp;
      })
    : filteredUnsorted;
  const ovTotals = filteredOverviewRows.reduce(
    (acc, r) => ({
      approvedBudget: acc.approvedBudget + r.approvedBudget,
      actualExpenditures: acc.actualExpenditures + r.actualExpenditures,
      commitments: acc.commitments + r.commitments,
      totalAllotted: acc.totalAllotted + r.totalAllotted,
      available: acc.available + r.available,
    }),
    { approvedBudget: 0, actualExpenditures: 0, commitments: 0, totalAllotted: 0, available: 0 }
  );

  const queryClient = useQueryClient();
  const reconciliationKey = ["utilization", "reconciliation", effectiveDeptId];
  const { data: reconciliation, isLoading: reconciliationLoading } = useQuery({
    queryKey: reconciliationKey,
    queryFn: async () =>
      (
        await api2.get<ReconciliationResponse>("/utilization/reconciliation", {
          params: { departmentId: effectiveDeptId, fiscalYear: FISCAL_YEAR },
        })
      ).data,
    enabled: !!effectiveDeptId && tab === "reconciliation" && gate("util.reconciliationEnabled", false),
  });

  const { data: npcSbus = [] } = useQuery({
    queryKey: ["utilization", "npc-sbus"],
    queryFn: async () => (await api2.get<NpcSbuOption[]>("/utilization/npc/sbus")).data,
    enabled: tab === "npc",
  });
  const [npcSbuFilter, setNpcSbuFilter] = useState("");
  const effectiveNpcSbu = npcSbuFilter || npcSbus[0]?.value || "";

  const { data: npcRows = [], isLoading: npcLoading } = useQuery({
    queryKey: ["utilization", "npc", effectiveNpcSbu, FISCAL_YEAR],
    queryFn: async () =>
      (
        await api2.get<NpcUtilizationRow[]>("/utilization/npc", {
          params: { sbu: effectiveNpcSbu, fiscalYear: FISCAL_YEAR },
        })
      ).data,
    enabled: !!effectiveNpcSbu && tab === "npc",
  });
  const filteredNpcRows = npcRows.filter((r) => {
    const has = (v: string, q: string) => !q.trim() || v.toLowerCase().includes(q.trim().toLowerCase());
    const balanceOk = npcBalanceFilter === "all" || (npcBalanceFilter === "positive" ? r.balance > 0 : npcBalanceFilter === "negative" ? r.balance < 0 : r.balance === 0);
    return (
      balanceOk &&
      (!npcSearch.trim() || [r.budgetCode, r.projectTitle, r.group ?? "", r.sbu, r.ioCodes.join(", ")].some((v) => v.toLowerCase().includes(npcSearch.trim().toLowerCase())))
    );
  });
  const sortedNpcRows = npcSort
    ? [...filteredNpcRows].sort((a, b) => {
        const av = npcSort.key === "ioCodes" ? a.ioCodes.join(", ") : a[npcSort.key];
        const bv = npcSort.key === "ioCodes" ? b.ioCodes.join(", ") : b[npcSort.key];
        const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true });
        return npcSort.dir === "asc" ? cmp : -cmp;
      })
    : filteredNpcRows;

  // The sync itself now runs automatically every 10 minutes (see main.py's
  // startup hook / sap_sync_service.py's start_scheduled_sync) - this button
  // is a supplementary on-demand refresh, not the only way this data ever
  // updates. A full sync takes several minutes (hundreds of paginated,
  // rate-limited broker requests), so it always runs in the background and
  // this polls GET /sync-sap/status for the result - continuously (not just
  // right after a manual click), both so an automatic tick's progress shows
  // up too and so the "last synced" timestamp below stays fresh on its own.
  const [syncStatus, setSyncStatus] = useState<{ ok: boolean; message: string } | null>(null);

  const startSyncMutation = useMutation({
    mutationFn: async () => (await api2.post("/utilization/sync-sap", null, { params: { fiscalYear: FISCAL_YEAR } })).data,
    onSuccess: () => setSyncStatus({ ok: true, message: "Sync started - this can take several minutes, feel free to keep working elsewhere and check back." }),
    onError: (err: any) => setSyncStatus({ ok: false, message: err.response?.data?.detail ?? "Could not start sync." }),
  });

  const { data: syncPollData } = useQuery({
    queryKey: ["utilization", "sync-sap-status", FISCAL_YEAR],
    queryFn: async () => (await api2.get<SapSyncStatus>("/utilization/sync-sap/status", { params: { fiscalYear: FISCAL_YEAR } })).data,
    enabled: tab === "overview" || tab === "reconciliation",
    // Short interval while a sync is actually running (catch completion
    // promptly), a longer one otherwise - just enough to notice the
    // scheduler's own next automatic tick and keep "last synced" current,
    // without polling harder than a value that only changes every 10
    // minutes warrants.
    refetchInterval: (query) => (query.state.data?.status === "running" ? 5000 : 60000),
  });

  const previousSyncStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!syncPollData) return;
    const previous = previousSyncStatusRef.current;
    previousSyncStatusRef.current = syncPollData.status;
    // Only react to a *transition* into success/error (not every 60s
    // refetch that happens to still read the same terminal status) -
    // otherwise this would re-invalidate the tables and re-show the banner
    // on every poll tick, not just when a sync actually just finished.
    if (previous === syncPollData.status) return;
    if (syncPollData.status === "success") {
      setSyncStatus({ ok: true, message: `Synced ${syncPollData.actualsSynced} actual(s), ${syncPollData.commitmentsSynced} commitment(s).` });
      queryClient.invalidateQueries({ queryKey: ["utilization", "overview", effectiveDeptId] });
      queryClient.invalidateQueries({ queryKey: reconciliationKey });
    } else if (syncPollData.status === "error") {
      setSyncStatus({ ok: false, message: syncPollData.error ?? "Sync failed." });
    }
  }, [syncPollData, queryClient, effectiveDeptId, reconciliationKey]);

  const syncInProgress = syncPollData?.status === "running";
  const lastSyncedLabel = syncPollData?.lastSuccessAt ? `Last synced ${new Date(syncPollData.lastSuccessAt).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}` : syncPollData && syncPollData.status !== "idle" ? "Never synced successfully yet" : null;

  const [mappingId, setMappingId] = useState<number | null>(null);
  const mapMutation = useMutation({
    mutationFn: async ({ transactionId, expenseLineItemId }: { transactionId: number; expenseLineItemId: string }) => (await api2.patch(`/utilization/reconciliation/unmapped/${transactionId}`, { expenseLineItemId })).data,
    onSuccess: () => {
      setMappingId(null);
      queryClient.invalidateQueries({ queryKey: reconciliationKey });
    },
  });

  return (
    <div className="mt-2 space-y-6">
      {((tab === "reconciliation" && lastSyncedLabel) || (!isBca && tab !== "npc" && departments.length > 1)) && (
      <PageHeader
        actions={
          <>
            {tab === "reconciliation" && lastSyncedLabel && (
              <span className="text-xs text-slate-500" title="SAP data refreshes automatically every 10 minutes.">
                {lastSyncedLabel}
              </span>
            )}
            {!isBca && tab !== "npc" && departments.length > 1 && (
              <select value={effectiveDeptId} onChange={(e) => setDepartmentId(e.target.value)} className="rounded border border-slate-300 px-2 py-1.5 text-sm">
                <option value="ALL">All Departments</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
          </>
        }
      />
      )}

      {(tab === "overview" || tab === "reconciliation" || tab === "npc") && syncStatus?.ok && <div className={`text-sm ${syncStatus.ok ? "text-emerald-700" : "text-red-600"}`}>{syncStatus.message}</div>}

      {tab !== "npc" && !effectiveDeptId && <div className="rounded-lg border border-emerald-200 bg-white shadow-sm p-6 text-sm text-slate-500">No centralized department is available for your account.</div>}
      {tab === "npc" && !effectiveNpcSbu && <div className="rounded-lg border border-emerald-200 bg-white shadow-sm p-6 text-sm text-slate-500">Your department has no SBU assigned — ask the Budget Officer to set one in the Admin Console.</div>}

      {effectiveDeptId && tab === "overview" && (
        <div className="space-y-2">
          <ExpandableSection title="Departmental Overview" inlineExpand>
        <>
        <div className="mb-2 flex flex-wrap items-start gap-2">
          <input
            type="search"
            value={ovSearch}
            onChange={(e) => setOvSearch(e.target.value)}
            placeholder="Filter by GL, cost center, or name…"
            className="h-9 w-96 rounded border border-slate-300 px-2 text-sm"
          />
            <select value={availFilter} onChange={(e) => setAvailFilter(e.target.value as typeof availFilter)} className="h-9 w-40 rounded border border-slate-300 bg-white px-2 text-sm font-normal text-slate-700">
            <option value="all">All</option>
            <option value="positive">Within budget</option>
            <option value="negative">Over budget</option>
            <option value="zero">Fully used</option>
            </select>

          <div className="ml-auto flex flex-col items-end gap-1 self-start">
          <div className="flex items-center gap-2">
            {lastSyncedLabel && (
              <span className="text-xs text-slate-500" title="SAP data refreshes automatically every 10 minutes.">
                {lastSyncedLabel}
              </span>
            )}
            {isBudgetOfficer && (
              <button
                type="button"
                onClick={() => {
                  setSyncStatus(null);
                  startSyncMutation.mutate();
                }}
                disabled={startSyncMutation.isPending || syncInProgress}
                title="Data refreshes automatically every 10 minutes - use this for an on-demand refresh instead of waiting."
                className="h-9 rounded-md border border-emerald-300 bg-emerald-50 px-3 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              >
                {startSyncMutation.isPending || syncInProgress ? "Syncing…" : "Sync Now"}
              </button>
            )}
          </div>
          <button
            type="button"
            disabled={exportingOv}
            onClick={async () => {
              setExportingOv(true);
              try {
                const res = await api2.get("/utilization/overview/export", { params: { departmentId: effectiveDeptId, fiscalYear: FISCAL_YEAR }, responseType: "blob" });
                const url = URL.createObjectURL(res.data as Blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `utilization-overview-${FISCAL_YEAR}.xlsx`;
                a.click();
                URL.revokeObjectURL(url);
              } finally {
                setExportingOv(false);
              }
            }}
            className="h-9 rounded bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {exportingOv ? "Exporting…" : "Export to Excel"}
          </button>
          </div>
        </div>
        <div className="mb-1 flex items-center gap-3">
          <p className="text-xs italic text-slate-500">All amounts are in PHP.</p>
          <span className="text-xs text-slate-500">Showing {filteredOverviewRows.length} of {overviewRows.length} line item(s)</span>
          {(ovSearch || availFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setOvSearch("");
                setAvailFilter("all");
              }}
              className="text-xs text-emerald-700 hover:underline"
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto">
            <ExpandButton />
          </span>
        </div>
        </>
        <div className="overflow-x-auto rounded-lg border border-emerald-200 bg-white shadow-sm">
          <table className="w-full text-[12px]">
            <thead className="bg-[#edf6f1] text-[12px] font-semibold text-[#164b33]">
              <tr>
                <th className="px-2 py-1 text-left">
                  <button type="button" onClick={() => toggleOvSort("glAccount")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    GL Account
                    <span className="text-[10px]">{ovSort?.key === "glAccount" ? (ovSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-left">
                  <button type="button" onClick={() => toggleOvSort("costCenter")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Cost Center
                    <span className="text-[10px]">{ovSort?.key === "costCenter" ? (ovSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-left">
                  <button type="button" onClick={() => toggleOvSort("glAccountName")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    GL Account Name
                    <span className="text-[10px]">{ovSort?.key === "glAccountName" ? (ovSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-left">
                  <button type="button" onClick={() => toggleOvSort("costCenterName")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Cost Center Name
                    <span className="text-[10px]">{ovSort?.key === "costCenterName" ? (ovSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-right">
                  <button type="button" onClick={() => toggleOvSort("approvedBudget")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Approved Budget
                    <span className="text-[10px]">{ovSort?.key === "approvedBudget" ? (ovSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-right">
                  <button type="button" onClick={() => toggleOvSort("actualExpenditures")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Actual Expenditures
                    <span className="text-[10px]">{ovSort?.key === "actualExpenditures" ? (ovSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-right">
                  <button type="button" onClick={() => toggleOvSort("commitments")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Commitments
                    <span className="text-[10px]">{ovSort?.key === "commitments" ? (ovSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-right">
                  <button type="button" onClick={() => toggleOvSort("totalAllotted")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Total Allotted
                    <span className="text-[10px]">{ovSort?.key === "totalAllotted" ? (ovSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-right">
                  <button type="button" onClick={() => toggleOvSort("available")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Available
                    <span className="text-[10px]">{ovSort?.key === "available" ? (ovSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {!overviewLoading && filteredOverviewRows.length > 0 && (
                <tr className="border-b-2 border-emerald-200 bg-[#edf6f1] font-semibold text-[#164b33]">
                  <td colSpan={4} className="px-2 py-1">
                    Total
                  </td>
                  <td className="px-2 py-1 text-right">{peso(ovTotals.approvedBudget)}</td>
                  <td className="px-2 py-1 text-right">{peso(ovTotals.actualExpenditures)}</td>
                  <td className="px-2 py-1 text-right">{peso(ovTotals.commitments)}</td>
                  <td className="px-2 py-1 text-right">{peso(ovTotals.totalAllotted)}</td>
                  <td className={`px-2 py-1 text-right ${ovTotals.available < 0 ? "text-red-600" : ""}`}>{peso(ovTotals.available)}</td>
                </tr>
              )}
              {overviewLoading ? (
                <tr>
                  <td colSpan={9} className="px-2 py-4 text-center text-slate-400">
                    Loading…
                  </td>
                </tr>
              ) : filteredOverviewRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-2 py-4 text-center text-slate-400">
                    No approved budget lines for this department yet.
                  </td>
                </tr>
              ) : (
                filteredOverviewRows.map((r) => (
                  <tr key={`${r.glAccount}-${r.costCenter}`}>
                    <td className="px-2 py-1">{r.glAccount}</td>
                    <td className="px-2 py-1">{r.costCenter}</td>
                    <td className="px-2 py-1">
                      <div className="max-w-[240px] truncate whitespace-nowrap" title={r.glAccountName ?? undefined}>
                        {r.glAccountName ?? "—"}
                      </div>
                    </td>
                    <td className="px-2 py-1">{r.costCenterName ?? "—"}</td>
                    <td className="px-2 py-1 text-right">{peso(r.approvedBudget)}</td>
                    <td className="px-2 py-1 text-right">{peso(r.actualExpenditures)}</td>
                    <td className="px-2 py-1 text-right">{peso(r.commitments)}</td>
                    <td className="px-2 py-1 text-right font-medium">{peso(r.totalAllotted)}</td>
                    <td className={`px-2 py-1 text-right font-medium ${r.available < 0 ? "text-red-600" : ""}`}>{peso(r.available)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
          </ExpandableSection>
        </div>
      )}

      {effectiveDeptId && tab === "reconciliation" && !gate("util.reconciliationEnabled", false) && (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-6 text-center text-sm text-slate-500">
          Live Reconciliation is temporarily unavailable. Please check back later.
        </div>
      )}

      {effectiveDeptId && tab === "reconciliation" && gate("util.reconciliationEnabled", false) && (
        <div className="space-y-6">
          <div className="overflow-x-auto rounded-lg border border-emerald-200 bg-white shadow-sm">
            <table className="w-full text-[12px]">
              <thead className="bg-[#edf6f1] text-[12px] font-semibold text-[#164b33]">
                <tr>
                  <th className="px-2 py-1 text-left">Expense Line Item</th>
                  <th className="px-2 py-1 text-right">{FISCAL_YEAR} Approved Budget</th>
                  <th className="px-2 py-1 text-right">SAP Actual</th>
                  <th className="px-2 py-1 text-left">Item Status / Text</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {reconciliationLoading ? (
                  <tr>
                    <td colSpan={4} className="px-2 py-4 text-center text-slate-400">
                      Loading…
                    </td>
                  </tr>
                ) : !reconciliation || reconciliation.rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-2 py-4 text-center text-slate-400">
                      No approved budget lines for this department yet.
                    </td>
                  </tr>
                ) : (
                  reconciliation.rows.map((r) => (
                    <tr key={r.expenseLineItemId ?? `${r.glAccount}-${r.costCenter}`}>
                      <td className="px-2 py-1">{r.expenseLineItemName}</td>
                      <td className="px-2 py-1 text-right">{peso(r.approvedBudget)}</td>
                      <td className="px-2 py-1 text-right">{peso(r.sapActual)}</td>
                      <td className="px-2 py-1 text-slate-600">{r.statusText}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-emerald-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3 text-xs font-semibold tracking-wide text-slate-500">
              Unmapped SAP Actuals
              {reconciliation && reconciliation.unmapped.length > 0 && <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">{reconciliation.unmapped.length} pending</span>}
            </div>
            {!reconciliation || reconciliation.unmapped.length === 0 ? (
              <div className="px-2 py-4 text-center text-sm text-slate-400">{reconciliation ? "0 exceptions pending." : "Loading…"}</div>
            ) : (
              <table className="w-full text-[12px]">
                <thead className="bg-[#edf6f1] text-[12px] font-semibold text-[#164b33]">
                  <tr>
                    <th className="px-2 py-1 text-left">Item Text</th>
                    <th className="px-2 py-1 text-left">GL-CC</th>
                    <th className="px-2 py-1 text-right">Amount</th>
                    {isBudgetOfficer && <th className="px-2 py-1 text-left">Map to</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reconciliation.unmapped.map((u) => (
                    <tr key={u.id}>
                      <td className="px-2 py-1 text-amber-700">{u.itemText}</td>
                      <td className="px-2 py-1 text-slate-500">
                        {u.glAccount} / {u.costCenter}
                      </td>
                      <td className="px-2 py-1 text-right">{peso(u.amount)}</td>
                      {isBudgetOfficer && (
                        <td className="px-2 py-1">
                          {mappingId === u.id ? (
                            <div className="w-64">
                              <SearchableSelect placeholder="Select expense line item…" options={reconciliation.lineItems.map((li) => ({ value: li.id, label: li.name }))} value="" disabled={mapMutation.isPending} onChange={(v) => mapMutation.mutate({ transactionId: u.id, expenseLineItemId: v })} />
                            </div>
                          ) : (
                            <button onClick={() => setMappingId(u.id)} className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100">
                              Map…
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {effectiveNpcSbu && tab === "npc" && (
        <ExpandableSection inlineExpand>
        <>
        <div className="mb-2 flex flex-wrap items-start gap-2">
          <input
            type="search"
            value={npcSearch}
            onChange={(e) => setNpcSearch(e.target.value)}
            placeholder="Filter by budget code, project, group, SBU, or IO…"
            className="h-9 w-96 rounded border border-slate-300 px-2 text-sm"
          />
            <select value={npcBalanceFilter} onChange={(e) => setNpcBalanceFilter(e.target.value as typeof npcBalanceFilter)} className="h-9 w-40 rounded border border-slate-300 bg-white px-2 text-sm font-normal text-slate-700">
            <option value="all">All</option>
            <option value="positive">Within budget</option>
            <option value="negative">Over budget</option>
            <option value="zero">Fully used</option>
            </select>
          {npcSbus.length > 1 && (
            <select value={effectiveNpcSbu} onChange={(e) => setNpcSbuFilter(e.target.value)} className="h-9 w-40 rounded border border-slate-300 bg-white px-2 text-sm font-normal text-slate-700">
              {npcSbus.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          )}

          <div className="ml-auto flex flex-col items-end gap-1 self-start">
          {isBudgetOfficer && (
            <div className="flex items-center gap-2">
              {lastSyncedLabel && (
                <span className="text-xs text-slate-500" title="SAP data refreshes automatically every 10 minutes.">
                  {lastSyncedLabel}
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  setSyncStatus(null);
                  startSyncMutation.mutate();
                }}
                disabled={startSyncMutation.isPending || syncInProgress}
                title="Data refreshes automatically every 10 minutes - use this for an on-demand refresh instead of waiting."
                className="h-9 rounded-md border border-emerald-300 bg-emerald-50 px-3 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              >
                {startSyncMutation.isPending || syncInProgress ? "Syncing…" : "Sync Now"}
              </button>
            </div>
          )}
          <button
            type="button"
            disabled={exportingNpc}
            onClick={async () => {
              setExportingNpc(true);
              try {
                const res = await api2.get("/utilization/npc/export", { params: { sbu: effectiveNpcSbu, fiscalYear: FISCAL_YEAR }, responseType: "blob" });
                const url = URL.createObjectURL(res.data as Blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `npc-utilization-${effectiveNpcSbu.toLowerCase()}-${FISCAL_YEAR}.xlsx`;
                a.click();
                URL.revokeObjectURL(url);
              } finally {
                setExportingNpc(false);
              }
            }}
            className="h-9 rounded bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {exportingNpc ? "Exporting…" : "Export to Excel"}
          </button>
          </div>
        </div>
        <div className="mb-1 flex items-center gap-3">
          <p className="text-xs italic text-slate-500">All amounts are in PHP.</p>
          <span className="text-xs text-slate-500">Showing {sortedNpcRows.length} of {npcRows.length} line item(s)</span>
          {(npcSearch || npcBalanceFilter !== "all") && (
            <button
              type="button"
              onClick={() => {
                setNpcSearch("");
                setNpcBalanceFilter("all");
              }}
              className="text-xs text-emerald-700 hover:underline"
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto">
            <ExpandButton />
          </span>
        </div>
        </>
        <div className="overflow-x-auto rounded-lg border border-emerald-200 bg-white shadow-sm">
          <table className="w-full text-[12px]">
            <thead className="bg-[#edf6f1] text-[12px] font-semibold text-[#164b33]">
              <tr>
                <th className="px-2 py-1 text-left">
                  <button type="button" onClick={() => toggleNpcSort("budgetCode")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Budget Code
                    <span className="text-[10px]">{npcSort?.key === "budgetCode" ? (npcSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-left">
                  <button type="button" onClick={() => toggleNpcSort("projectTitle")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Project Title
                    <span className="text-[10px]">{npcSort?.key === "projectTitle" ? (npcSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-right">
                  <button type="button" onClick={() => toggleNpcSort("amount")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Amount (VAT excl.)
                    <span className="text-[10px]">{npcSort?.key === "amount" ? (npcSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-left">
                  <button type="button" onClick={() => toggleNpcSort("group")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Group
                    <span className="text-[10px]">{npcSort?.key === "group" ? (npcSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-left">
                  <button type="button" onClick={() => toggleNpcSort("sbu")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    SBU
                    <span className="text-[10px]">{npcSort?.key === "sbu" ? (npcSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-left">
                  <button type="button" onClick={() => toggleNpcSort("ioCodes")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    IO Code
                    <span className="text-[10px]">{npcSort?.key === "ioCodes" ? (npcSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-right">
                  <button type="button" onClick={() => toggleNpcSort("ioAmount")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    IO Amount
                    <span className="text-[10px]">{npcSort?.key === "ioAmount" ? (npcSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
                <th className="px-2 py-1 text-right">
                  <button type="button" onClick={() => toggleNpcSort("balance")} className="inline-flex items-center gap-1 hover:text-slate-800">
                    Balance
                    <span className="text-[10px]">{npcSort?.key === "balance" ? (npcSort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                  </button>
                </th>
              </tr>
              {sortedNpcRows.length > 0 && (
                <tr className="bg-[#edf6f1] font-semibold text-[#164b33]">
                  <td className="px-2 py-1" colSpan={2}>Total</td>
                  <td className="px-2 py-1 text-right">{peso(sortedNpcRows.reduce((sum, r) => sum + r.amount, 0))}</td>
                  <td className="px-2 py-1" colSpan={3}></td>
                  <td className="px-2 py-1 text-right">{peso(sortedNpcRows.reduce((sum, r) => sum + r.ioAmount, 0))}</td>
                  <td className="px-2 py-1 text-right">{peso(sortedNpcRows.reduce((sum, r) => sum + r.balance, 0))}</td>
                </tr>
              )}
            </thead>
            <tbody className="divide-y divide-slate-100">
              {npcLoading ? (
                <tr>
                  <td colSpan={8} className="px-2 py-4 text-center text-slate-400">
                    Loading…
                  </td>
                </tr>
              ) : sortedNpcRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-2 py-4 text-center text-slate-400">
                    No approved NPC budget codes for this SBU yet.
                  </td>
                </tr>
              ) : (
                sortedNpcRows.map((r) => (
                  <tr key={r.budgetCode}>
                    <td className="px-2 py-1 font-mono text-xs text-emerald-700">{r.budgetCode}</td>
                    <td className="px-2 py-1">{r.projectTitle}</td>
                    <td className="px-2 py-1 text-right">{peso(r.amount)}</td>
                    <td className="px-2 py-1">{r.group ?? "—"}</td>
                    <td className="px-2 py-1">{r.sbu}</td>
                    <td className="px-2 py-1 font-mono text-xs text-slate-600">
                      {r.ioCodes.length > 0
                        ? r.ioCodes.map((code, i) => (
                            <span key={code}>
                              <button type="button" onClick={() => setOpenIo(code)} className="text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-900">
                                {formatAufnr(code)}
                              </button>
                              {i < r.ioCodes.length - 1 ? ", " : ""}
                            </span>
                          ))
                        : "—"}
                    </td>
                    <td className="px-2 py-1 text-right">{peso(r.ioAmount)}</td>
                    <td className={`px-2 py-1 text-right font-medium ${r.balance < 0 ? "text-red-600" : ""}`}>{peso(r.balance)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        </ExpandableSection>
      )}
      {openIo && <IoDetailModal aufnr={openIo} fiscalYear={FISCAL_YEAR} onClose={() => setOpenIo(null)} />}
    </div>
  );
}
