import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api, requestLineDisplay, NPC_SBU_OPTIONS, SBU_OPTIONS, type BudgetRequest, type FinalizedBudgetReport, type NpcSbu, type RequestCategory, type Sbu } from "../api/client";
import { SBU_BATCH_TYPES } from "../components/SbuTypeSwitch";
import { PageHeader } from "../components/PageHeader";
import { useFiscalYear } from "../lib/fiscalCycle";

interface ReasonCode {
  id: string;
  label: string;
}
interface BoardBudgetRow {
  id: string;
  fiscalYear: number;
  amount: number;
  requestCategory: RequestCategory;
  sbu: Sbu | null;
  setAt: string;
}

const RETURN_TARGETS = [
  { value: "DEPT_HEAD_REVIEW", label: "Department Head (Step 2)" },
  { value: "CENTRALIZED_L1_REVIEW", label: "Centralized First-Level Reviewer (Step 3A)" },
  { value: "CENTRALIZED_HEAD_REVIEW", label: "Centralized Department Head (Step 3B)" },
  { value: "BCA_HEAD_REVIEW", label: "BC&A Head (Step 4)" },
];

// Latest row (by setAt) for a given category/SBU scope — the history log's
// append-only "latest wins" pattern, same as before, now scoped per field.
function latestFor(history: BoardBudgetRow[], category: RequestCategory | null, sbu: Sbu | null): BoardBudgetRow | null {
  const matches = history.filter((h) => h.requestCategory === category && h.sbu === sbu);
  return matches[0] ?? null; // history arrives sorted desc by setAt
}

export function Step5DashboardPage() {
  const queryClient = useQueryClient();
  const { targetYear: FISCAL_YEAR } = useFiscalYear();
  const { data: allRequests = [] } = useQuery({
    queryKey: ["step5-dashboard"],
    queryFn: async () => (await api.get<BudgetRequest[]>("/budget-requests/step5-dashboard")).data,
  });
  const { data: reasonCodes = [] } = useQuery({
    queryKey: ["reason-codes"],
    queryFn: async () => (await api.get<ReasonCode[]>("/admin/reason-codes")).data,
  });
  const { data: boardBudget } = useQuery({
    queryKey: ["board-approved-budget", FISCAL_YEAR],
    queryFn: async () => (await api.get<{ history: BoardBudgetRow[] }>(`/admin/board-approved-budget?fiscalYear=${FISCAL_YEAR}`)).data,
  });

  // Notes_8: GAE / DOE / Revenue selector, with DOE and Revenue further
  // split by the 5 SBUs — "All" shows every SBU's requests together with a
  // per-SBU Board-Approved Budget breakdown instead of one combined figure.
  // Notes_9: the GAE/DOE/Revenue picker itself moved to the sidebar
  // sub-menu (Layout.tsx's Step5SubMenu), driven by this same `?category=`
  // query param, so the page just reads it instead of owning the state.
  // NPC was added later: its Board-Approved Budget stays a flat figure like
  // GAE (its breakdown dimension is Head, not the Sbu enum), but the
  // request list/dashboard below is still filterable per Head - see
  // npcHeads/npcHeadFilter.
  // No ?category= at all means "haven't picked a category yet" - shows a
  // picker prompt below instead of silently defaulting to GAE, same as New
  // Request/Forecast. GAE is only shown once explicitly chosen
  // (?category=GAE, same as every other category).
  const [searchParams] = useSearchParams();
  const categoryParam = searchParams.get("category");
  // SBU_BATCH_TYPES covers DOE/Commission/Cost of Sales/Depreciation &
  // Amortization/Interest Expense - all SBU-scoped, same board-approved-
  // budget-breakdown shape Revenue already has.
  const sbuBatchCategoryValues = new Set<string>(SBU_BATCH_TYPES.map((t) => t.category));
  const category: RequestCategory | null =
    categoryParam === "GAE" || categoryParam === "NPC" || categoryParam === "REVENUE" || sbuBatchCategoryValues.has(categoryParam as RequestCategory) ? (categoryParam as RequestCategory) : null;
  const usesSbuBreakdown = category === "REVENUE" || sbuBatchCategoryValues.has(category as RequestCategory);
  const [sbuFilter, setSbuFilter] = useState<Sbu | "ALL">("ALL");

  const [npcHeadFilter, setNpcHeadFilter] = useState<NpcSbu | "ALL">("ALL");

  useEffect(() => {
    setSbuFilter("ALL");
    setNpcHeadFilter("ALL");
  }, [category]);

  const requests = useMemo(
    () =>
      allRequests.filter((r) => {
        if (r.requestCategory !== category) return false;
        if (category === "NPC") return npcHeadFilter === "ALL" || r.npcSbu === npcHeadFilter;
        return !usesSbuBreakdown || sbuFilter === "ALL" || r.sbu === sbuFilter;
      }),
    [allRequests, category, sbuFilter, npcHeadFilter, usesSbuBreakdown],
  );

  // Pending (still awaiting Budget Officer Review, from step5-dashboard
  // above) + already finalized/uploaded (FinalizedBudgetLine - written once
  // at Finalize & Upload time, see workflowService.ts). Finalizing a request
  // moves it off the pending list entirely, so summing only `requests`
  // understated this as things got finalized - down to literally ₱0 once
  // everything pending was done, even though the Board-Approved Budget was
  // fully committed by then, not uncommitted. This is the total of
  // everything proposed against the cap this cycle, pending or not.
  const scopedSbu = usesSbuBreakdown ? (sbuFilter === "ALL" ? null : sbuFilter) : null;
  const { data: finalizedReport } = useQuery({
    queryKey: ["finalized-budget-report", FISCAL_YEAR, category, scopedSbu, category === "NPC" ? npcHeadFilter : null],
    queryFn: async () =>
      (
        await api.get<FinalizedBudgetReport>("/budget-requests/finalized-budget-report", {
          params: {
            fiscalYear: FISCAL_YEAR,
            requestCategory: category,
            sbu: scopedSbu ?? undefined,
            npcSbu: category === "NPC" && npcHeadFilter !== "ALL" ? npcHeadFilter : undefined,
          },
        })
      ).data,
    enabled: category !== null,
  });
  const totalPendingProposed = requests.reduce((sum, r) => sum + (r.proposedAmount - r.budgetCutAmount), 0);
  const totalApproved = (finalizedReport?.lines ?? []).reduce((sum, l) => sum + l.amount, 0);
  const totalProposed = totalPendingProposed + totalApproved;
  const [newBoardAmount, setNewBoardAmount] = useState("");

  const history = boardBudget?.history ?? [];
  // "All" on a DOE/Revenue tab has no single field to edit (the notes call
  // for 5 separate SBU fields, not a combined one) — board amount there is
  // just the sum of the 5 SBUs' current figures for comparison purposes.
  const boardAmount = usesSbuBreakdown && sbuFilter === "ALL" ? SBU_OPTIONS.reduce((sum, o) => sum + (latestFor(history, category, o.value)?.amount ?? 0), 0) : (latestFor(history, category, scopedSbu)?.amount ?? 0);

  const setBoardBudget = useMutation({
    mutationFn: async () =>
      (
        await api.post("/admin/board-approved-budget", {
          fiscalYear: FISCAL_YEAR,
          amount: Number(newBoardAmount),
          requestCategory: category,
          sbu: scopedSbu ?? undefined,
        })
      ).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board-approved-budget"] });
      setNewBoardAmount("");
    },
  });

  const applyCut = useMutation({
    mutationFn: async ({ id, cutAmount }: { id: string; cutAmount: number }) => (await api.post(`/budget-requests/${id}/budget-cut`, { cutAmount })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["step5-dashboard"] }),
  });

  // Note 11: one click now does both jobs (finalize + the mock SAP upload,
  // see workflowService.ts's finalizeAtStep5) - the row leaves this "awaiting
  // finalization" list immediately, so there's no persistent place left to
  // show its SAP document number "inline"; a short banner naming the ticket
  // stands in for the old page-level "Uploaded — SAP Document #..." banner.
  const [lastFinalized, setLastFinalized] = useState<{ lineItemName: string; sapDocumentNumber: string | null } | null>(null);
  const finalize = useMutation({
    mutationFn: async (r: BudgetRequest) => (await api.post<BudgetRequest>(`/budget-requests/${r.id}/finalize`)).data,
    onSuccess: (updated, r) => {
      setLastFinalized({ lineItemName: requestLineDisplay(r).name, sapDocumentNumber: updated.sapDocumentNumber });
      queryClient.invalidateQueries({ queryKey: ["step5-dashboard"] });
    },
  });

  const [returning, setReturning] = useState<string | null>(null);
  const [targetStage, setTargetStage] = useState(RETURN_TARGETS[0].value);
  const [reasonCodeId, setReasonCodeId] = useState("");

  const returnRequest = useMutation({
    mutationFn: async (id: string) => (await api.post(`/budget-requests/${id}/return-to-stage`, { targetStage, reasonCodeId })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["step5-dashboard"] });
      setReturning(null);
    },
  });

  const grouped = requests.reduce<Record<string, BudgetRequest[]>>((acc, r) => {
    // SBU-batch categories (no owning centralized department) group by SBU instead.
    const key = requestLineDisplay(r).ownerDepartmentName ?? (r.sbu ? `${r.sbu} SBU` : r.requestCategory);
    acc[key] = acc[key] ?? [];
    acc[key].push(r);
    return acc;
  }, {});

  const variance = boardAmount - totalProposed;
  const variancePct = boardAmount > 0 ? (variance / boardAmount) * 100 : 0;

  if (category === null) {
    return (
      <div className="space-y-6">
        <PageHeader subtitle="Choose a category to get started." />
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
          Select a category from the menu on the left to begin.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {usesSbuBreakdown && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setSbuFilter("ALL")} className={`rounded-full px-2.5 py-1 text-xs font-medium ${sbuFilter === "ALL" ? "bg-slate-700 text-white" : "border border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
              All SBUs
            </button>
            {SBU_OPTIONS.map((o) => (
              <button key={o.value} onClick={() => setSbuFilter(o.value)} className={`rounded-full px-2.5 py-1 text-xs font-medium ${sbuFilter === o.value ? "bg-slate-700 text-white" : "border border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {category === "NPC" && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setNpcHeadFilter("ALL")} className={`rounded-full px-2.5 py-1 text-xs font-medium ${npcHeadFilter === "ALL" ? "bg-slate-700 text-white" : "border border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
              All SBUs
            </button>
            {NPC_SBU_OPTIONS.map((o) => (
              <button key={o.value} onClick={() => setNpcHeadFilter(o.value)} className={`rounded-full px-2.5 py-1 text-xs font-medium ${npcHeadFilter === o.value ? "bg-slate-700 text-white" : "border border-slate-300 text-slate-500 hover:bg-slate-50"}`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="text-xs font-semibold tracking-wide text-slate-500">
              {FISCAL_YEAR} Board-Approved Budget{usesSbuBreakdown && sbuFilter !== "ALL" ? ` — ${SBU_OPTIONS.find((o) => o.value === sbuFilter)?.label}` : ""}
            </div>
            <div className="mt-1 text-xl font-bold text-slate-800">{boardAmount.toLocaleString()}</div>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="text-xs font-semibold tracking-wide text-emerald-700">{FISCAL_YEAR} Total Proposed Budget</div>
            <div className="mt-1 text-xl font-bold text-emerald-800">{totalProposed.toLocaleString()}</div>
            <div className="mt-0.5 text-[11px] text-emerald-700/70">
              {totalPendingProposed.toLocaleString()} pending + {totalApproved.toLocaleString()} approved
            </div>
          </div>
          <div className={`rounded-lg border p-4 ${variance < 0 ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}>
            <div className={`text-xs font-semibold tracking-wide ${variance < 0 ? "text-red-700" : "text-amber-700"}`}>Variance</div>
            <div className={`mt-1 text-xl font-bold ${variance < 0 ? "text-red-700" : "text-amber-800"}`}>
              {variance.toLocaleString()} ({variancePct.toFixed(1)}%)
            </div>
          </div>
        </div>

        {usesSbuBreakdown && sbuFilter === "ALL" ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left tracking-wide text-slate-500">
                <tr>
                  <th className="py-1 pr-3">SBU</th>
                  <th className="py-1 pr-3">Board-Approved Budget</th>
                </tr>
              </thead>
              <tbody>
                {SBU_OPTIONS.map((o) => (
                  <tr key={o.value} className="border-t border-slate-100">
                    <td className="py-1 pr-3">{o.label}</td>
                    <td className="py-1 pr-3">{(latestFor(history, category, o.value)?.amount ?? 0).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 text-xs text-slate-500">Select a specific SBU above to edit its figure.</div>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <input type="number" placeholder="New Board-Approved amount" className="rounded border border-slate-300 px-2 py-1 text-sm" value={newBoardAmount} onChange={(e) => setNewBoardAmount(e.target.value)} />
            <button onClick={() => setBoardBudget.mutate()} disabled={!newBoardAmount || setBoardBudget.isPending} className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
              Update Board-Approved Budget
            </button>
          </div>
        )}
      </div>

      {Object.entries(grouped).map(([deptName, items]) => (
        <div key={deptName} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="bg-emerald-50 px-4 py-2 text-sm font-semibold tracking-wide text-emerald-800">{deptName}</div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">Expense Line Item</th>
                <th className="px-3 py-2">Proposed</th>
                <th className="px-3 py-2">Budget Cut</th>
                <th className="px-3 py-2">Net</th>
                <th className="px-3 py-2">Flag</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r, i) => (
                <tr key={r.id} className={`border-t border-slate-100 ${i % 2 === 1 ? "bg-slate-50/60" : ""}`}>
                  <td className="px-3 py-2">
                    <Link to={`/requests/${r.id}`} className="font-medium text-emerald-800 hover:underline">
                      {requestLineDisplay(r).name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{r.proposedAmount.toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      defaultValue={r.budgetCutAmount}
                      className="w-24 rounded border border-slate-300 px-1 py-0.5"
                      onBlur={(e) => {
                        const cutAmount = Number(e.target.value) || 0;
                        if (cutAmount !== r.budgetCutAmount) applyCut.mutate({ id: r.id, cutAmount });
                      }}
                    />
                  </td>
                  <td className="px-3 py-2 font-semibold text-slate-700">{(r.proposedAmount - r.budgetCutAmount).toLocaleString()}</td>
                  <td className="px-3 py-2">{r.isOverBudget && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Over-budget / Requires Realignment</span>}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button onClick={() => finalize.mutate(r)} disabled={finalize.isPending} className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
                        Finalize & Upload
                      </button>
                      <button onClick={() => setReturning(returning === r.id ? null : r.id)} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100">
                        Return…
                      </button>
                    </div>
                    {returning === r.id && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <select className="rounded border border-slate-300 px-1 py-1 text-xs" value={targetStage} onChange={(e) => setTargetStage(e.target.value)}>
                          {RETURN_TARGETS.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <select className="rounded border border-slate-300 px-1 py-1 text-xs" value={reasonCodeId} onChange={(e) => setReasonCodeId(e.target.value)}>
                          <option value="">— Reason —</option>
                          {reasonCodes.map((rc) => (
                            <option key={rc.id} value={rc.id}>
                              {rc.label}
                            </option>
                          ))}
                        </select>
                        <button onClick={() => returnRequest.mutate(r.id)} disabled={!reasonCodeId} className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50">
                          Confirm Return
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {requests.length === 0 && <div className="text-sm text-slate-500">No requests awaiting finalization.</div>}

      {lastFinalized && (
        <div className="inline-block rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800">
          Finalized "{lastFinalized.lineItemName}" — SAP Document #{lastFinalized.sapDocumentNumber ?? "—"}
        </div>
      )}

      <Link to="/step5/finalized-budget" className="block text-sm font-medium text-emerald-800 hover:underline">
        View the Finalized Budget Report →
      </Link>
    </div>
  );
}
