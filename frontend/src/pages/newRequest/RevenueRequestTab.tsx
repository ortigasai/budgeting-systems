import { useLayoutEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../context/AuthContext";
import { sfSbus } from "../../lib/groupScope";
import { api, SBU_OPTIONS, type Company, type RevenueBatchDetail, type Sbu } from "../../api/client";
import { PageHeader } from "../../components/PageHeader";
import { SectionLabel } from "../../components/TabBar";
import { useFiscalYear } from "../../lib/fiscalCycle";
import { startUpload, useUploadTask } from "../../lib/uploadManager";

interface BoardBudgetRow {
  id: string;
  fiscalYear: number;
  amount: number;
  requestCategory: string;
  sbu: Sbu | null;
  setAt: string;
}

// Exported so MyRequestsPage can render the same labels for the revenue
// rows it now shows (the "My Revenue Requests" list here was removed in
// favor of that single consolidated list).
export const STAGE_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  REVENUE_BU_FINANCE_OFFICER_REVIEW: "BU Finance Officer Review",
  REVENUE_BU_FINANCE_HEAD_REVIEW: "BU Finance Head Review",
  REVENUE_BUDGET_OFFICER_REVIEW: "Budget Officer Review",
  REVENUE_BCA_HEAD_REVIEW: "BC&A Head Review",
  APPROVED: "Approved",
  CANCELLED: "Cancelled",
  RETURNED_TO_REQUESTOR: "Returned",
};

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Spec item 16 - Revenue's own New Request form: no expense line item picker
// or spend grid (that's per-CC-GL data inside the uploaded template
// instead) - just SBU/Company plus the upload widget. Everything else
// (parsing, the Board-Approved Budget tie-out check, batch creation) happens
// server-side - see backend/src/routes/revenueBatches.ts.
export function RevenueRequestTab({ subtitle }: { subtitle: string }) {
  const queryClient = useQueryClient();
  const { targetYear: FISCAL_YEAR } = useFiscalYear();
  const [sbu, setSbu] = useState<Sbu | "">("");
  const { currentUser: authUser, hasRole: authHasRole } = useAuth();
  const mySfSbus = sfSbus(authUser, authHasRole("BUDGET_OFFICER"));
  const [companyId, setCompanyId] = useState("");
  const [error, setError] = useState<string | null>(null);
  // "My Revenue Requests" (the standalone list this tab used to render) was
  // removed in favor of showing revenue requests under the single "My
  // Requests" page - its "View" link opens the request straight into this
  // tab's own detail view via ?batch=<id>, same as this tab already switches
  // into that view after a fresh upload.
  const [searchParams] = useSearchParams();
  const [activeBatchId, setActiveBatchId] = useState<string | null>(searchParams.get("batch"));

  const { data: companies = [] } = useQuery({
    queryKey: ["companies"],
    queryFn: async () => (await api.get<Company[]>("/admin/companies")).data,
  });
  const { data: boardBudget } = useQuery({
    queryKey: ["board-approved-budget", FISCAL_YEAR],
    queryFn: async () => (await api.get<{ history: BoardBudgetRow[] }>(`/admin/board-approved-budget?fiscalYear=${FISCAL_YEAR}`)).data,
  });
  const boardAmountForSbu = sbu ? boardBudget?.history.find((h) => h.requestCategory === "REVENUE" && h.sbu === sbu)?.amount : undefined;

  const { data: activeBatch, refetch: refetchActive } = useQuery({
    queryKey: ["revenue-batches", activeBatchId],
    queryFn: async () => (await api.get<RevenueBatchDetail>(`/revenue-batches/${activeBatchId}`)).data,
    enabled: !!activeBatchId,
  });

  // Both uploads run through the shared uploadManager (see
  // lib/uploadManager.ts) instead of a local mutation, so progress and the
  // result toast survive navigating to a different page mid-upload.
  const [uploadTaskId, setUploadTaskId] = useState<string | null>(null);
  const uploadTask = useUploadTask(uploadTaskId);
  function startBatchUpload(file: File) {
    const form = new FormData();
    form.append("file", file);
    form.append("sbu", sbu);
    form.append("companyId", companyId);
    form.append("fiscalYear", String(FISCAL_YEAR));
    setUploadTaskId(
      startUpload<RevenueBatchDetail>({
        label: `Revenue bulk upload (${file.name})`,
        url: "/revenue-batches",
        form,
        invalidateKeys: [["revenue-batches", "mine"]],
        onDone: (data) => setActiveBatchId(data.id),
      })
    );
  }

  const [overrideTaskId, setOverrideTaskId] = useState<string | null>(null);
  const overrideTask = useUploadTask(overrideTaskId);
  function startOverrideUpload(file: File) {
    const form = new FormData();
    form.append("file", file);
    setOverrideTaskId(
      startUpload<RevenueBatchDetail>({
        label: `Revenue override file (${file.name})`,
        url: `/revenue-batches/${activeBatchId}/upload`,
        form,
        invalidateKeys: [["revenue-batches", "mine"]],
        onDone: () => refetchActive(),
      })
    );
  }

  const submitMutation = useMutation({
    mutationFn: async () => (await api.post<RevenueBatchDetail>(`/revenue-batches/${activeBatchId}/submit`)).data,
    onSuccess: () => {
      setError(null);
      refetchActive();
      queryClient.invalidateQueries({ queryKey: ["revenue-batches", "mine"] });
    },
    onError: (err: any) => setError(err.response?.data?.error ?? "Failed to submit."),
  });

  const cancelMutation = useMutation({
    mutationFn: async (batchId: string) => (await api.post<RevenueBatchDetail>(`/revenue-batches/${batchId}/cancel`)).data,
    onSuccess: (data) => {
      if (data.id === activeBatchId) refetchActive();
      queryClient.invalidateQueries({ queryKey: ["revenue-batches", "mine"] });
    },
  });

  const canUpload = !!sbu && !!companyId;
  const isDraft = activeBatch?.currentStage === "DRAFT";
  const [frozenHeaderEl, setFrozenHeaderEl] = useState<HTMLDivElement | null>(null);
  const [frozenHeaderHeight, setFrozenHeaderHeight] = useState(0);
  useLayoutEffect(() => {
    if (frozenHeaderEl) setFrozenHeaderHeight(frozenHeaderEl.offsetHeight);
  });

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div ref={setFrozenHeaderEl} className="sticky top-0 z-30 space-y-4 bg-[#f5faf7] pb-3 pt-1">
        <PageHeader subtitle={subtitle} />
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm shadow-sm">
          <div>
            <label className="block font-medium text-emerald-800">Originating Department</label>
            <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{authUser?.department?.name}</div>
          </div>
          <div>
            <label className="block font-medium text-emerald-800">Target Calendar Year</label>
            <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{FISCAL_YEAR}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
      {!activeBatch && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <SectionLabel>Upload Template</SectionLabel>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-600">
                SBU <span className="text-red-500">*</span>
              </label>
              <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={sbu} onChange={(e) => setSbu(e.target.value as Sbu)}>
                <option value="">— Select —</option>
                {SBU_OPTIONS.filter((o) => !mySfSbus || mySfSbus.includes(o.value)).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {sbu && (
                <div className="mt-1 text-xs text-slate-500">
                  {boardAmountForSbu !== undefined ? (
                    <>
                      {FISCAL_YEAR} Board-Approved Budget: <span className="font-semibold text-emerald-700">{peso(boardAmountForSbu)}</span> — your template's grand total (cell O1) must tie up with this figure.
                    </>
                  ) : (
                    <span className="text-red-600">The Budget Officer hasn't set the {FISCAL_YEAR} Board-Approved Budget for this SBU yet — uploads will be rejected until they do.</span>
                  )}
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600">
                Company <span className="text-red-500">*</span>
              </label>
              <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="">— Select —</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            <a href="/api/revenue-batches/template" className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100">
              Open Template
            </a>
            <label className={`rounded-md border px-4 py-2 text-sm font-medium ${canUpload ? "cursor-pointer border-slate-300 text-slate-700 hover:bg-slate-100" : "cursor-not-allowed border-slate-200 text-slate-400"}`}>
              {uploadTask?.status === "uploading" ? `Uploading… ${uploadTask.progress}%` : "Upload Completed Template"}
              <input
                type="file"
                accept=".xlsx"
                className="hidden"
                disabled={!canUpload || uploadTask?.status === "uploading"}
                onChange={(e) => e.target.files?.[0] && startBatchUpload(e.target.files[0])}
              />
            </label>
          </div>
          {error && <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
          {uploadTask && uploadTask.status !== "uploading" && (
            <div className={`mt-3 rounded p-2 text-sm ${uploadTask.status === "success" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{uploadTask.message}</div>
          )}
        </div>
      )}

      {activeBatch && (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <SectionLabel>{activeBatch.sbu} · {activeBatch.company?.name}</SectionLabel>
                <div className="text-sm text-slate-600">
                  {activeBatch.rowCount} CC-GL row(s) · Total <span className="font-semibold text-emerald-700">{peso(activeBatch.totalAmount)}</span> · Stage: <span className="font-medium">{STAGE_LABELS[activeBatch.currentStage] ?? activeBatch.currentStage}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {isDraft && (
                  <>
                    <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                      {overrideTask?.status === "uploading" ? `Uploading… ${overrideTask.progress}%` : "Override File"}
                      <input type="file" accept=".xlsx" className="hidden" disabled={overrideTask?.status === "uploading"} onChange={(e) => e.target.files?.[0] && startOverrideUpload(e.target.files[0])} />
                    </label>
                    <button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending} className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
                      Submit for Approval
                    </button>
                    <button onClick={() => cancelMutation.mutate(activeBatch.id)} disabled={cancelMutation.isPending} className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">
                      Cancel
                    </button>
                  </>
                )}
                <button onClick={() => setActiveBatchId(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100">
                  New Upload
                </button>
              </div>
            </div>
            {error && <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">CC</th>
                  <th className="px-3 py-2">GL</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {activeBatch.rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{r.costCenter}</td>
                    <td className="px-3 py-2">{r.glAccount}</td>
                    <td className="px-3 py-2 text-right">{peso(r.proposedAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {activeBatch.reviewDecisions.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
              <SectionLabel>Review History</SectionLabel>
              <ul className="space-y-2">
                {activeBatch.reviewDecisions.map((d) => (
                  <li key={d.id} className="border-l-2 border-emerald-200 pl-3">
                    <div className="font-medium">
                      {d.decision} at {STAGE_LABELS[d.stage] ?? d.stage} — {d.decidedByName}
                    </div>
                    <div className="text-xs text-slate-500">{new Date(d.timestamp).toLocaleString()}</div>
                    {d.comment && <div className="text-slate-600">{d.comment}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      </div>

      <div className="space-y-4 lg:col-span-2">
        <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm shadow-sm lg:sticky" style={{ top: frozenHeaderHeight + 16 }}>
          <SectionLabel>Quick Guide</SectionLabel>
          <ol className="list-decimal space-y-1.5 pl-5 text-xs text-slate-700">
            <li>Choose the SBU and the Company.</li>
            <li>Download the template and fill in one row per Cost Center and GL Account, with the amount for each month.</li>
            <li>Upload the completed template. The batch shows below once it's in.</li>
            <li>Check the rows, then Submit for Approval. Use Override File to replace the upload while it's still a draft.</li>
            <li>It goes to BU Finance, then the Budget Officer and BC&amp;A Head. Any rows that fail the Board-Approved Budget check are listed with the reason.</li>
          </ol>
        </div>
      </div>
      </div>
    </div>
  );
}
