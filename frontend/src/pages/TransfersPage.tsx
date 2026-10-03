import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2, COMPANY_OPTIONS, SBU_OPTIONS, type CcGlOptions, type CompanyCode, type DepartmentHeadOption, type IoLocation, type Sbu, type TransferBalanceOut, type TransferRequest, type TransferType } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { SectionLabel } from "../components/TabBar";
import { StatusBadge } from "../components/StatusBadge";
import { SearchableSelect } from "../components/SearchableSelect";
import { useFiscalYear } from "../lib/fiscalCycle";

function peso(n: number) {
  const sign = n < 0 ? "-" : "";
  return `${sign}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Phase 3 (Budget Transfer & Reallocation, workflow revision) - New
// Transfer/My Transfers/Inbox are sidebar nav items (Layout.tsx's
// currentPhase.number === 3 branch) rather than an in-page TabBar; this page
// just reads `?view=` to pick which one renders. Served by the FastAPI
// backend (backend-py/), reached via the api2 client.
export function TransfersPage() {
  const [searchParams] = useSearchParams();
  const view = searchParams.get("view");
  const tab: "new" | "mine" | "inbox" = view === "mine" ? "mine" : view === "inbox" ? "inbox" : "new";

  return (
    <div className="space-y-6">
      {tab === "new" && <NewTransferForm />}
      {tab === "mine" && <TransferList queryKey={["transfers", "mine"]} url="/transfers/mine" empty="You haven't created any transfer requests yet." />}
      {tab === "inbox" && <TransferList queryKey={["transfers", "inbox"]} url="/transfers/inbox" empty="Nothing awaiting your review." />}
    </div>
  );
}

function CcGlPicked({ code, name }: { code: string; name: string | undefined }) {
  if (!code) return null;
  return <div className="mt-1 text-xs text-slate-500">Selected: {code} — {name ?? "—"}</div>;
}

function BalanceRow({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  const accentClass = value < 0 ? "font-semibold text-red-700" : "font-semibold text-emerald-800";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className={accent ? accentClass : "text-slate-700"}>{peso(value)}</span>
    </div>
  );
}

function BalanceColumn({ title, data }: { title: string; data: { budget: number; actual: number; commitment: number; allotted: number; available: number } }) {
  return (
    <div className="space-y-0.5">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      <BalanceRow label="Budget" value={data.budget} />
      <BalanceRow label="Actual" value={data.actual} />
      <BalanceRow label="Commitment" value={data.commitment} />
      <BalanceRow label="Allotted" value={data.allotted} />
      <BalanceRow label="Available" value={data.available} accent />
    </div>
  );
}

// Shows what this CC-GL's Budget/Actual/Commitment/Allotted/Available look
// like right now ("Current Amount"), and what they'd look like once this
// transfer is applied ("Planned Amount") - only Budget (and therefore
// Available) moves, by the transfer amount, in the direction implied by
// `sign` (+1 for the destination "To" pair gaining funds, -1 for the source
// "From" pair losing them); Actual/Commitment don't change until SAP
// activity actually posts.
function BalanceBreakdown({ current, isLoading, amount, sign }: { current: TransferBalanceOut | undefined; isLoading: boolean; amount: number; sign: 1 | -1 }) {
  if (isLoading || !current) {
    return <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-400">Loading…</div>;
  }
  const delta = sign * (Number.isFinite(amount) ? amount : 0);
  const planned = { ...current, budget: current.budget + delta, available: current.available + delta };
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <BalanceColumn title="Current Amount" data={current} />
      <BalanceColumn title="Planned Amount" data={planned} />
    </div>
  );
}

function NewTransferForm() {
  const queryClient = useQueryClient();
  // forecastYear, not targetYear - a Transfer reallocates already-in-force
  // (current-year) budget between GL/CC lines, not next year's ask.
  const { forecastYear: FISCAL_YEAR } = useFiscalYear();
  const { data: ccGlOptions = { costCenters: [], glAccounts: [] } } = useQuery({
    queryKey: ["transfers", "cc-gl-options"],
    queryFn: async () => (await api2.get<CcGlOptions>("/transfers/cc-gl-options")).data,
  });
  const { data: locations = [] } = useQuery({
    queryKey: ["internal-orders", "locations"],
    queryFn: async () => (await api2.get<IoLocation[]>("/internal-orders/locations")).data,
  });

  const [type, setType] = useState<TransferType>("REALLOCATION");
  const [toCostCenter, setToCostCenter] = useState("");
  const [toGlAccount, setToGlAccount] = useState("");
  const [fromCostCenter, setFromCostCenter] = useState("");
  const [fromGlAccount, setFromGlAccount] = useState("");
  const [companyCode, setCompanyCode] = useState<CompanyCode | "">("");
  const [sbu, setSbu] = useState<Sbu | "">("");
  const [location, setLocation] = useState("");
  const [amount, setAmount] = useState("");
  const [details, setDetails] = useState("");
  const [created, setCreated] = useState<TransferRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toBalanceQuery = useQuery({
    queryKey: ["transfers", "cc-gl-balance", toCostCenter, toGlAccount, FISCAL_YEAR],
    queryFn: async () => (await api2.get<TransferBalanceOut>("/transfers/cc-gl-balance", { params: { costCenter: toCostCenter, glAccount: toGlAccount, fiscalYear: FISCAL_YEAR } })).data,
    enabled: Boolean(toCostCenter && toGlAccount),
  });
  const fromBalanceQuery = useQuery({
    queryKey: ["transfers", "cc-gl-balance", fromCostCenter, fromGlAccount, FISCAL_YEAR],
    queryFn: async () => (await api2.get<TransferBalanceOut>("/transfers/cc-gl-balance", { params: { costCenter: fromCostCenter, glAccount: fromGlAccount, fiscalYear: FISCAL_YEAR } })).data,
    enabled: Boolean(type === "REALLOCATION" && fromCostCenter && fromGlAccount),
  });

  const createMutation = useMutation({
    mutationFn: async () =>
      (
        await api2.post<TransferRequest>("/transfers", {
          fiscalYear: FISCAL_YEAR,
          type,
          amount: Number(amount),
          targetCostCenter: toCostCenter,
          targetGlAccount: toGlAccount,
          details,
          budgetSourceCostCenter: type === "REALLOCATION" ? fromCostCenter : undefined,
          budgetSourceGlAccount: type === "REALLOCATION" ? fromGlAccount : undefined,
          companyCode,
          sbu,
          location,
        })
      ).data,
    onSuccess: (data) => {
      setCreated(data);
      setError(null);
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Failed to create request."),
  });

  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return (await api2.post(`/transfers/${created!.id}/attachments`, form)).data;
    },
    onSuccess: (data: { fileName: string }) => {
      setUploadStatus(`Attached: ${data.fileName}`);
      setCreated((c) => (c ? { ...c, attachments: [...c.attachments, { id: 0, fileName: data.fileName }] } : c));
    },
  });

  const { data: departmentHeads = [] } = useQuery({
    queryKey: ["transfers", "department-heads"],
    queryFn: async () => (await api2.get<DepartmentHeadOption[]>("/transfers/department-heads")).data,
    enabled: Boolean(created && created.status === "DRAFT"),
  });
  const [assignedDepartmentHeadId, setAssignedDepartmentHeadId] = useState("");

  const submitMutation = useMutation({
    mutationFn: async () => (await api2.post<TransferRequest>(`/transfers/${created!.id}/submit`, { assignedDepartmentHeadId })).data,
    onSuccess: (data) => {
      setCreated(data);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["transfers", "mine"] });
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Could not submit request."),
  });

  if (created) {
    const canSubmit = created.status === "DRAFT" && created.attachments.length > 0 && Boolean(assignedDepartmentHeadId);
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <PageHeader
          subtitle={
            <span className="font-medium text-slate-700">
              Ticket <span className="font-mono text-emerald-800">{created.ticketNumber}</span> — {created.status === "DRAFT" ? "Draft created" : "Submitted for approval"}
            </span>
          }
          actions={
            <div className="flex items-center gap-2">
              {created.status === "DRAFT" && (
                <button onClick={() => submitMutation.mutate()} disabled={!canSubmit || submitMutation.isPending} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
                  Submit for Approval
                </button>
              )}
              <button
                onClick={() => {
                  setCreated(null);
                  setType("REALLOCATION");
                  setToCostCenter("");
                  setToGlAccount("");
                  setFromCostCenter("");
                  setFromGlAccount("");
                  setCompanyCode("");
                  setSbu("");
                  setLocation("");
                  setAmount("");
                  setDetails("");
                  setAssignedDepartmentHeadId("");
                  setError(null);
                  setUploadStatus(null);
                }}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                Create another
              </button>
            </div>
          }
        />
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <span className="font-medium">Type:</span> {created.type === "REALLOCATION" ? "Reallocation" : "Supplemental"}
          </div>
          <div>
            <span className="font-medium">Amount (VAT exclusive):</span> {peso(created.amount)}
          </div>
          <div>
            <span className="font-medium">Company:</span> {created.companyCode}
          </div>
          <div>
            <span className="font-medium">SBU:</span> {SBU_OPTIONS.find((o) => o.value === created.sbu)?.label ?? created.sbu}
          </div>
          <div>
            <span className="font-medium">Location:</span> {locations.find((l) => l.code === created.location)?.label ?? created.location}
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <span className="font-medium">To:</span> CC {created.targetCostCenter ?? "—"} ({created.targetCostCenterName ?? "—"}) / GL {created.targetGlAccount ?? "—"} ({created.targetGlAccountName ?? "—"})
          </div>
          {created.type === "REALLOCATION" && (
            <div className="sm:col-span-2 lg:col-span-3">
              <span className="font-medium">From:</span> CC {created.budgetSourceCostCenter} ({created.budgetSourceCostCenterName ?? "—"}) / GL {created.budgetSourceGlAccount} ({created.budgetSourceGlAccountName ?? "—"})
            </div>
          )}
          <div>
            <span className="font-medium">Status:</span> <StatusBadge stage={created.status === "REJECTED" || created.status === "RETURNED" || created.status === "CANCELLED" ? created.status : created.currentStage} />
          </div>
        </div>

        {created.status === "DRAFT" && (
          <>
            <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
              <SectionLabel>Attachments</SectionLabel>
              <p className="mb-2 text-xs text-slate-500">At least one supporting document is required before this request can be submitted.</p>
              <label className="inline-block cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100">
                {uploadMutation.isPending ? "Uploading…" : "Add attachment"}
                <input
                  type="file"
                  className="hidden"
                  disabled={uploadMutation.isPending}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) uploadMutation.mutate(file);
                  }}
                />
              </label>
              {uploadStatus && <div className="mt-1 text-xs text-emerald-700">{uploadStatus}</div>}
              {created.attachments.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                  {created.attachments.map((a, i) => (
                    <li key={i}>{a.fileName}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
              <SectionLabel>Department Head</SectionLabel>
              <p className="mb-2 text-xs text-slate-500">Choose which Department Head should review this request.</p>
              <select className="w-full max-w-sm rounded border border-slate-300 px-2 py-1.5 text-sm" value={assignedDepartmentHeadId} onChange={(e) => setAssignedDepartmentHeadId(e.target.value)}>
                <option value="">— Select —</option>
                {departmentHeads.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
              {departmentHeads.length === 0 && <div className="mt-1 text-xs text-amber-600">No Department Head is assigned to your department yet.</div>}
            </div>
          </>
        )}

        {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
      </div>
    );
  }

  const canCreate = toCostCenter && toGlAccount && companyCode && sbu && location && amount && details && (type === "SUPPLEMENTAL" || (fromCostCenter && fromGlAccount));
  const ccSelectOptions = ccGlOptions.costCenters.map((c) => ({ value: c.code, label: c.code, sublabel: c.name }));
  const glSelectOptions = ccGlOptions.glAccounts.map((g) => ({ value: g.code, label: g.code, sublabel: g.name }));
  const toCcName = ccGlOptions.costCenters.find((c) => c.code === toCostCenter)?.name;
  const toGlName = ccGlOptions.glAccounts.find((g) => g.code === toGlAccount)?.name;
  const fromCcName = ccGlOptions.costCenters.find((c) => c.code === fromCostCenter)?.name;
  const fromGlName = ccGlOptions.glAccounts.find((g) => g.code === fromGlAccount)?.name;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        actions={
          <button onClick={() => createMutation.mutate()} disabled={!canCreate || createMutation.isPending} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
            Save Draft
          </button>
        }
      />

      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-800">
        Approved by the Department Head you choose, then routed through your SBU's Finance team and up to the CFO
        and/or CEO for larger amounts, before the Budget Officer uploads it to SAP. Reallocation is tracked per
        CC-GL, not per catalog item - the system checks the source CC-GL's remaining balance before it can be
        submitted, and at least one supporting document must be attached before submitting.
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <SectionLabel>Request Details</SectionLabel>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-4">
            <label className="block text-sm font-medium text-slate-600">Type</label>
            <div className="mt-1 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={type === "REALLOCATION"} onChange={() => setType("REALLOCATION")} />
                Reallocation (moves funds from another CC-GL)
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={type === "SUPPLEMENTAL"} onChange={() => setType("SUPPLEMENTAL")} />
                Supplemental (net-new request)
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600">Company</label>
            <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={companyCode} onChange={(e) => setCompanyCode(e.target.value as CompanyCode)}>
              <option value="">— Select —</option>
              {COMPANY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600">SBU</label>
            <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={sbu} onChange={(e) => setSbu(e.target.value as Sbu)}>
              <option value="">— Select —</option>
              {SBU_OPTIONS.map((o) => (
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
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600">Amount (VAT exclusive)</label>
            <input type="number" className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-600">To — Cost Center</label>
            <div className="mt-1">
              <SearchableSelect placeholder="Search CC code or name…" options={ccSelectOptions} value={toCostCenter} onChange={setToCostCenter} />
            </div>
            <CcGlPicked code={toCostCenter} name={toCcName} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600">To — GL Account</label>
            <div className="mt-1">
              <SearchableSelect placeholder="Search GL code or name…" options={glSelectOptions} value={toGlAccount} onChange={setToGlAccount} />
            </div>
            <CcGlPicked code={toGlAccount} name={toGlName} />
          </div>
          {toCostCenter && toGlAccount && (
            <div className="sm:col-span-2 lg:col-span-4">
              <BalanceBreakdown current={toBalanceQuery.data} isLoading={toBalanceQuery.isLoading} amount={Number(amount)} sign={1} />
            </div>
          )}

          {type === "REALLOCATION" && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-600">From — Cost Center</label>
                <div className="mt-1">
                  <SearchableSelect placeholder="Search CC code or name…" options={ccSelectOptions} value={fromCostCenter} onChange={setFromCostCenter} />
                </div>
                <CcGlPicked code={fromCostCenter} name={fromCcName} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600">From — GL Account</label>
                <div className="mt-1">
                  <SearchableSelect placeholder="Search GL code or name…" options={glSelectOptions} value={fromGlAccount} onChange={setFromGlAccount} />
                </div>
                <CcGlPicked code={fromGlAccount} name={fromGlName} />
              </div>
              {fromCostCenter && fromGlAccount && (
                <div className="sm:col-span-2 lg:col-span-4">
                  <BalanceBreakdown current={fromBalanceQuery.data} isLoading={fromBalanceQuery.isLoading} amount={Number(amount)} sign={-1} />
                </div>
              )}
            </>
          )}

          <div className="sm:col-span-2 lg:col-span-4">
            <label className="block text-sm font-medium text-slate-600">Details</label>
            <textarea
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              rows={3}
              placeholder="Brief description of the request."
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>
        </div>
      </div>

      {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
    </div>
  );
}

function TransferList({ queryKey, url, empty }: { queryKey: string[]; url: string; empty: string }) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await api2.get<TransferRequest[]>(url)).data,
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-emerald-50 text-left text-xs tracking-wide text-emerald-800">
          <tr>
            <th className="px-4 py-2">Ticket #</th>
            <th className="px-4 py-2">Type</th>
            <th className="px-4 py-2">To (CC / GL)</th>
            <th className="px-4 py-2">Amount</th>
            <th className="px-4 py-2">Stage</th>
            <th className="px-4 py-2">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {isLoading ? (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2">
                  <Link to={`/transfers/${r.id}`} className="font-mono font-medium text-emerald-800 hover:underline">
                    {r.ticketNumber}
                  </Link>
                </td>
                <td className="px-4 py-2">{r.type === "REALLOCATION" ? "Reallocation" : "Supplemental"}</td>
                <td className="px-4 py-2">{r.targetCostCenter ?? "—"} / {r.targetGlAccount ?? "—"}</td>
                <td className="px-4 py-2">{peso(r.amount)}</td>
                <td className="px-4 py-2">
                  <StatusBadge stage={r.status === "REJECTED" || r.status === "RETURNED" || r.status === "CANCELLED" ? r.status : r.currentStage} />
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
