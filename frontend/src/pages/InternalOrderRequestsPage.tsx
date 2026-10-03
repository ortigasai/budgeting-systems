import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import { formatAufnr } from "../lib/formatAufnr";
import { npcGroupSbus } from "../lib/groupScope";
import { api, api2, IO_SBU_OPTIONS, type ApprovedNpcCode, type InternalOrderRequest, type IoLocation, type IoReallocationSourceType, type IoRequestType, type IoSbuCode } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { SectionLabel } from "../components/TabBar";
import { StatusBadge } from "../components/StatusBadge";
import { SearchableSelect } from "../components/SearchableSelect";
import { useFiscalYear } from "../lib/fiscalCycle";

interface SalrOption {
  aufnr: string;
  description: string;
  budget: number;
  available: number;
}

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Spec items 8/9 - requesting the creation of an Internal Order in SAP.
// Same `?view=` sidebar-driven pattern as TransfersPage.tsx (Layout.tsx's
// InternalOrderSidebarNav), served by backend-py's /internal-orders router.
export function InternalOrderRequestsPage() {
  const [searchParams] = useSearchParams();
  const view = searchParams.get("view");
  const tab: "new" | "mine" | "inbox" = view === "mine" ? "mine" : view === "inbox" ? "inbox" : "new";

  return (
    <div className="space-y-6">
      {tab === "new" && <NewInternalOrderForm />}
      {tab === "mine" && <IoList queryKey={["internal-orders", "mine"]} url="/internal-orders/mine" empty="You haven't created any Internal Order requests yet." />}
      {tab === "inbox" && <IoList queryKey={["internal-orders", "inbox"]} url="/internal-orders/inbox" empty="Nothing awaiting your review." />}
    </div>
  );
}

function NewInternalOrderForm() {
  const queryClient = useQueryClient();
  // forecastYear, not targetYear - Internal Order Request (Module 3) reallocates
  // already-in-force (current-year) budget, not next year's ask.
  const { forecastYear: FISCAL_YEAR } = useFiscalYear();

  const { data: locations = [] } = useQuery({
    queryKey: ["io-locations"],
    queryFn: async () => (await api2.get<IoLocation[]>("/internal-orders/locations")).data,
  });
  const { data: npcCodes = [] } = useQuery({
    queryKey: ["approved-npc-codes"],
    queryFn: async () => (await api.get<ApprovedNpcCode[]>("/budget-requests/approved-npc-codes")).data,
  });
  const { data: salrOptions = [] } = useQuery({
    queryKey: ["internal-orders", "salr-options", FISCAL_YEAR],
    queryFn: async () => (await api2.get<SalrOption[]>("/internal-orders/salr-options", { params: { fiscalYear: FISCAL_YEAR } })).data,
  });

  const { currentUser: authUser, hasRole: authHasRole } = useAuth();
  const myNpcSbus = npcGroupSbus(authUser, authHasRole("BUDGET_OFFICER"));
  const [sbu, setSbu] = useState<IoSbuCode>(() => IO_SBU_OPTIONS.find((o) => !myNpcSbus || myNpcSbus.includes(o.value))?.value ?? IO_SBU_OPTIONS[0].value);
  const [location, setLocation] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [projectStart, setProjectStart] = useState("");
  const [projectEnd, setProjectEnd] = useState("");
  const [amount, setAmount] = useState("");
  const [costCenter, setCostCenter] = useState("");
  const [isBudgeted, setIsBudgeted] = useState(true);
  const [npcBudgetCode, setNpcBudgetCode] = useState("");
  const [requestType, setRequestType] = useState<IoRequestType>("SUPPLEMENT");
  const [reallocationSourceType, setReallocationSourceType] = useState<IoReallocationSourceType>("NPC_BUDGET");
  const [reallocationNpcBudgetCode, setReallocationNpcBudgetCode] = useState("");
  const [reallocationIoBudgetCode, setReallocationIoBudgetCode] = useState("");

  const [created, setCreated] = useState<InternalOrderRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async () =>
      (
        await api2.post<InternalOrderRequest>("/internal-orders", {
          fiscalYear: FISCAL_YEAR,
          sbu,
          location,
          projectTitle,
          projectStart,
          projectEnd,
          amount: Number(amount),
          costCenter,
          isBudgeted,
          npcBudgetCode: isBudgeted ? npcBudgetCode : undefined,
          requestType: isBudgeted ? undefined : requestType,
          reallocationSourceType: !isBudgeted && requestType === "REALLOCATION" ? reallocationSourceType : undefined,
          reallocationNpcBudgetCode: !isBudgeted && requestType === "REALLOCATION" && reallocationSourceType === "NPC_BUDGET" ? reallocationNpcBudgetCode : undefined,
          reallocationIoBudgetCode: !isBudgeted && requestType === "REALLOCATION" && reallocationSourceType === "IO_BUDGET" ? reallocationIoBudgetCode : undefined,
        })
      ).data,
    onSuccess: (data) => {
      setCreated(data);
      setError(null);
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Failed to create request."),
  });

  const submitMutation = useMutation({
    mutationFn: async () => (await api2.post<InternalOrderRequest>(`/internal-orders/${created!.id}/submit`)).data,
    onSuccess: (data) => {
      setCreated(data);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["internal-orders", "mine"] });
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Could not submit request."),
  });

  if (created) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <PageHeader
          subtitle={<span className="font-medium text-slate-700">{created.status === "DRAFT" ? "Draft created" : "Submitted for approval"}</span>}
          actions={
            <div className="flex items-center gap-2">
              {created.status === "DRAFT" && (
                <button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
                  Submit for Approval
                </button>
              )}
              <button
                onClick={() => {
                  setCreated(null);
                  setProjectTitle("");
                  setProjectStart("");
                  setProjectEnd("");
                  setAmount("");
                  setCostCenter("");
                  setNpcBudgetCode("");
                  setReallocationNpcBudgetCode("");
                  setReallocationIoBudgetCode("");
                  setError(null);
                }}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                Create another
              </button>
            </div>
          }
        />
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <span className="font-medium">SBU:</span> {created.sbuLabel}
          </div>
          <div>
            <span className="font-medium">Project:</span> {created.projectTitle}
          </div>
          <div>
            <span className="font-medium">Amount (VAT excl.):</span> {peso(created.amount)}
          </div>
          <div>
            <span className="font-medium">Status:</span> <StatusBadge stage={created.status === "DRAFT" ? "DRAFT" : created.currentStage} />
          </div>
        </div>

        {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
      </div>
    );
  }

  const canSubmit =
    location &&
    projectTitle &&
    projectStart &&
    projectEnd &&
    amount &&
    costCenter &&
    (isBudgeted
      ? !!npcBudgetCode
      : requestType === "SUPPLEMENT" ||
        (reallocationSourceType === "NPC_BUDGET" ? !!reallocationNpcBudgetCode : !!reallocationIoBudgetCode));

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        subtitle="Request the creation of an Internal Order in SAP."
        actions={
          <button onClick={() => createMutation.mutate()} disabled={!canSubmit || createMutation.isPending} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
            Save Draft
          </button>
        }
      />

      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-800">
        An IO should have an NPC budget first. If none is allocated yet, request additional budget (Supplement) or
        reallocate from an existing NPC or IO budget code. Approved by your Department Head, then the Budget
        Officer, who routes it to the BU Finance or Corporate Finance stream based on the SBU selected below - same
        approval flow as a budget reallocation.
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <SectionLabel>Internal Order Details</SectionLabel>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="block text-sm font-medium text-slate-600">SBU</label>
            <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={sbu} onChange={(e) => setSbu(e.target.value as IoSbuCode)}>
              {IO_SBU_OPTIONS.filter((o) => !myNpcSbus || myNpcSbus.includes(o.value)).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600">Location</label>
            <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={location} onChange={(e) => setLocation(e.target.value)}>
              <option value="">— Select —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600">Cost Center</label>
            <input className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={costCenter} onChange={(e) => setCostCenter(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600">Amount (VAT exclusive)</label>
            <input type="number" className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-600">Project Title</label>
            <input className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={projectTitle} onChange={(e) => setProjectTitle(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600">Project Start</label>
            <input type="date" className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={projectStart} onChange={(e) => setProjectStart(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600">Project End</label>
            <input type="date" className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={projectEnd} onChange={(e) => setProjectEnd(e.target.value)} />
          </div>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-600">
            <input type="checkbox" checked={isBudgeted} onChange={(e) => setIsBudgeted(e.target.checked)} />
            This IO already has an NPC budget allocated
          </label>

          {isBudgeted ? (
            <div className="mt-2">
              <label className="block text-sm font-medium text-slate-600">NPC Budget Code</label>
              <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={npcBudgetCode} onChange={(e) => setNpcBudgetCode(e.target.value)}>
                <option value="">— Select —</option>
                {npcCodes.map((c) => (
                  <option key={c.id} value={c.budgetCode}>
                    {c.budgetCode} — {c.expenseLineItemName}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-600">Since it isn't budgeted yet</label>
                <div className="mt-1 flex gap-4 text-sm">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={requestType === "REALLOCATION"} onChange={() => setRequestType("REALLOCATION")} />
                    Reallocation
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={requestType === "SUPPLEMENT"} onChange={() => setRequestType("SUPPLEMENT")} />
                    Supplement (net-new)
                  </label>
                </div>
              </div>

              {requestType === "REALLOCATION" && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-600">Reallocate from</label>
                    <div className="mt-1 flex gap-4 text-sm">
                      <label className="flex items-center gap-1.5">
                        <input type="radio" checked={reallocationSourceType === "NPC_BUDGET"} onChange={() => setReallocationSourceType("NPC_BUDGET")} />
                        NPC Budget
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="radio" checked={reallocationSourceType === "IO_BUDGET"} onChange={() => setReallocationSourceType("IO_BUDGET")} />
                        IO Budget
                      </label>
                    </div>
                  </div>

                  {reallocationSourceType === "NPC_BUDGET" ? (
                    <div>
                      <label className="block text-sm font-medium text-slate-600">NPC Budget Code (source)</label>
                      <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={reallocationNpcBudgetCode} onChange={(e) => setReallocationNpcBudgetCode(e.target.value)}>
                        <option value="">— Select —</option>
                        {npcCodes.map((c) => (
                          <option key={c.id} value={c.budgetCode}>
                            {c.budgetCode} — {c.expenseLineItemName}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-sm font-medium text-slate-600">IO Budget Code (source)</label>
                      <div className="mt-1">
                        <SearchableSelect
                          placeholder="Search Internal Orders…"
                          options={salrOptions.map((o) => ({
                            value: o.aufnr,
                            label: `${formatAufnr(o.aufnr)} — ${o.description}`,
                            sublabel: `Available: ${o.available.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
                          }))}
                          value={reallocationIoBudgetCode}
                          onChange={setReallocationIoBudgetCode}
                        />
                      </div>
                      <div className="mt-1 text-xs text-slate-500">Live from SAP - each Internal Order's current Available balance is shown alongside it.</div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
    </div>
  );
}

function IoList({ queryKey, url, empty }: { queryKey: string[]; url: string; empty: string }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await api2.get<InternalOrderRequest[]>(url)).data,
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-emerald-50 text-left text-xs tracking-wide text-emerald-800">
          <tr>
            <th className="px-4 py-2">SBU</th>
            <th className="px-4 py-2">Project</th>
            <th className="px-4 py-2">Amount</th>
            <th className="px-4 py-2">Stage</th>
            <th className="px-4 py-2">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {isLoading ? (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2">
                  <Link to={`/internal-orders/${r.id}`} className="font-medium text-emerald-800 hover:underline">
                    {r.sbuLabel}
                  </Link>
                </td>
                <td className="px-4 py-2">{r.projectTitle}</td>
                <td className="px-4 py-2">{peso(r.amount)}</td>
                <td className="px-4 py-2">
                  <StatusBadge stage={r.status === "REJECTED" || r.status === "RETURNED" ? r.status : r.currentStage} />
                </td>
                <td className="px-4 py-2 text-slate-500">{new Date(r.updatedAt).toLocaleString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
