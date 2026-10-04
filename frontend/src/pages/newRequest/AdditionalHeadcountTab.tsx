import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useFiscalYear } from "../../lib/fiscalCycle";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AdditionalHeadcountRequest, type Company } from "../../api/client";
import { SectionLabel } from "../../components/TabBar";
import { StatusBadge } from "../../components/StatusBadge";
import { SearchableSelect } from "../../components/SearchableSelect";
import { ApproverPicker } from "../../components/ApproverPicker";
import { PageHeader } from "../../components/PageHeader";

interface Position {
  id: string;
  title: string;
}

// Notes_6: Rank dropdown labels - the rank value stored/submitted is still
// the 1-12 integer, only the display label changed from a plain number.
const RANK_OPTIONS = [
  { value: "1", label: "1 – Project-based" },
  { value: "2", label: "2 – Outsourced" },
  { value: "3", label: "3 – Associate" },
  { value: "4", label: "4 – Senior Associate" },
  { value: "5", label: "5 – Officer" },
  { value: "6", label: "6 – Senior Officer" },
  { value: "7", label: "7 – Associate Manager" },
  { value: "8", label: "8 – Manager" },
  { value: "9", label: "9 – Senior Manager" },
  { value: "10", label: "10 – Assistant Vice President" },
  { value: "11", label: "11 – Vice President" },
  { value: "12", label: "12 – President" },
];

export function AdditionalHeadcountTab({ subtitle }: { subtitle: string }) {
  const queryClient = useQueryClient();
  const { data: companies = [] } = useQuery({
    queryKey: ["companies"],
    queryFn: async () => (await api.get<Company[]>("/admin/companies")).data,
  });
  const { data: positions = [] } = useQuery({
    queryKey: ["positions"],
    queryFn: async () => (await api.get<Position[]>("/admin/positions")).data,
  });

  const [form, setForm] = useState({
    position: "",
    rank: "",
    companyId: "",
    estimatedHireDate: "",
    justification: "",
    departmentHeadId: "",
  });
  const [created, setCreated] = useState<AdditionalHeadcountRequest | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { currentUser } = useAuth();
  const { targetYear: FISCAL_YEAR } = useFiscalYear();
  const [frozenHeaderEl, setFrozenHeaderEl] = useState<HTMLDivElement | null>(null);
  const [frozenHeaderHeight, setFrozenHeaderHeight] = useState(0);
  useLayoutEffect(() => {
    if (frozenHeaderEl) setFrozenHeaderHeight(frozenHeaderEl.offsetHeight);
  });

  // Notes_7: Rank 1 (Project-based) can only be requested against the two
  // project companies; Rank 2 (Outsourced) is always the Outsourced company.
  const projectCompanyIds = useMemo(
    () => new Set(companies.filter((c) => c.code === "OCLP_PROJECT" || c.code === "OLC_PROJECT").map((c) => c.id)),
    [companies]
  );
  const outsourcedCompanyId = useMemo(() => companies.find((c) => c.code === "OUTSOURCED")?.id ?? "", [companies]);
  const isRankAboveOutsourced = Number(form.rank) >= 3;
  const companyOptions = form.rank === "1"
    ? companies.filter((c) => projectCompanyIds.has(c.id))
    : form.rank === "2"
      ? companies.filter((c) => c.id === outsourcedCompanyId)
    : isRankAboveOutsourced
      ? companies.filter((c) => !projectCompanyIds.has(c.id) && c.id !== outsourcedCompanyId)
      : companies;

  const handleRankChange = (rank: string) => {
    let companyId = form.companyId;
    if (rank === "1") {
      if (!projectCompanyIds.has(companyId)) companyId = "";
    } else if (rank === "2") {
      companyId = outsourcedCompanyId || companyId;
    } else if (Number(rank) >= 3 && (projectCompanyIds.has(companyId) || companyId === outsourcedCompanyId)) {
      companyId = "";
    }
    setForm({ ...form, rank, companyId });
  };

  // The form is saved as a DRAFT (no reference code yet) and only gets a code
  // and enters the approval chain on submit. Saving again updates the same draft.
  const payloadFromForm = () => ({
    position: form.position,
    rank: Number(form.rank),
    companyId: form.companyId,
    estimatedHireDate: new Date(form.estimatedHireDate).toISOString(),
    justification: form.justification,
    departmentHeadId: form.departmentHeadId,
  });

  const saveDraft = async (): Promise<AdditionalHeadcountRequest> =>
    draftId
      ? (await api.put<AdditionalHeadcountRequest>(`/additional-headcount/${draftId}`, payloadFromForm())).data
      : (await api.post<AdditionalHeadcountRequest>("/additional-headcount", payloadFromForm())).data;

  const invalidateRequests = () => queryClient.invalidateQueries({ queryKey: ["additional-headcount"] });

  // Saving a draft moves to the "Draft created" screen, where Submit lives,
  // mirroring GAE New Request.
  const saveDraftMutation = useMutation({
    mutationFn: saveDraft,
    onSuccess: (data) => {
      setDraftId(data.id);
      setCreated(data);
      setError(null);
      invalidateRequests();
    },
    onError: (err: any) => setError(err.response?.data?.error ?? "Failed to save draft."),
  });

  const submitMutation = useMutation({
    mutationFn: async () => (await api.post<AdditionalHeadcountRequest>(`/additional-headcount/${created!.id}/submit`)).data,
    onSuccess: (data) => {
      setCreated(data);
      setDraftId(null);
      setError(null);
      invalidateRequests();
    },
    onError: (err: any) => setError(err.response?.data?.error ?? "Failed to submit request."),
  });

  // "Edit draft" from the draft's detail page links here with ?draft=<id>;
  // open that draft on the Draft screen once, then drop the param.
  const [searchParams, setSearchParams] = useSearchParams();
  const draftParam = searchParams.get("draft");
  const { data: linkedDraft } = useQuery({
    queryKey: ["additional-headcount", "draft", draftParam],
    enabled: !!draftParam,
    queryFn: async () => (await api.get<AdditionalHeadcountRequest>(`/additional-headcount/${draftParam}`)).data,
  });
  useEffect(() => {
    if (!linkedDraft) return;
    openDraft(linkedDraft);
    setSearchParams({ tab: "headcount" }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedDraft]);

  const cancelMutation = useMutation({
    mutationFn: async () => (await api.post(`/additional-headcount/${created!.id}/cancel`)).data,
    onSuccess: () => {
      resetForm();
      invalidateRequests();
    },
    onError: (err: any) => setError(err.response?.data?.error ?? "Failed to cancel draft."),
  });

  const openDraft = (draft: AdditionalHeadcountRequest) => {
    setDraftId(draft.id);
    setCreated(draft);
    setError(null);
  };

  const editDraft = () => {
    if (!created) return;
    setForm({
      position: created.position,
      rank: String(created.rank),
      companyId: created.companyId,
      estimatedHireDate: created.estimatedHireDate.slice(0, 10),
      justification: created.justification,
      departmentHeadId: created.departmentHeadId ?? "",
    });
    setCreated(null);
    setError(null);
  };

  const resetForm = () => {
    setCreated(null);
    setDraftId(null);
    setForm({ position: "", rank: "", companyId: "", estimatedHireDate: "", justification: "", departmentHeadId: "" });
  };

  const isBusy = saveDraftMutation.isPending || submitMutation.isPending || cancelMutation.isPending;

  if (created?.currentStage === "DRAFT") {
    const onCancel = () => {
      if (window.confirm("Cancel this draft? It will be kept as Cancelled and can't be submitted.")) cancelMutation.mutate();
    };
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-bold tracking-tight text-slate-800">
              {created.position} (Rank {created.rank})
            </h1>
            <StatusBadge stage={created.currentStage} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => submitMutation.mutate()}
              disabled={isBusy}
              className="rounded-md bg-emerald-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Submit for Approval
            </button>
            <button
              onClick={onCancel}
              disabled={isBusy}
              className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Cancel Request
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm shadow-sm sm:grid-cols-3">
          <div>
            <div className="text-xs text-slate-500">Originating Department</div>
            <div className="font-medium">{created.department.name}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Company</div>
            <div className="font-medium">{created.company.code}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Estimated Hire Date</div>
            <div className="font-medium">{new Date(created.estimatedHireDate).toLocaleDateString()}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Reference Code</div>
            <div className="text-slate-500">Assigned on submit</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Department Head / Approver</div>
            <div className="font-medium">{created.departmentHead?.name ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">Created By</div>
            <div className="font-medium">{created.createdBy.name}</div>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <SectionLabel>Justification</SectionLabel>
          <p className="text-slate-600">{created.justification}</p>
          <button type="button" onClick={editDraft} disabled={isBusy} className="mt-3 text-xs font-medium text-emerald-700 hover:underline disabled:opacity-50">
            Edit draft
          </button>
        </div>

        {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
      </div>
    );
  }

  if (created) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <PageHeader
          subtitle={<span className="font-medium text-slate-700">Additional Manpower Request submitted</span>}
          actions={
            <button
              onClick={resetForm}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
            >
              Submit another
            </button>
          }
        />
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <div>
            <span className="font-medium">Reference Code:</span>{" "}
            <span className="font-mono font-bold text-emerald-800">{created.code}</span>
          </div>
          <div>
            <span className="font-medium">Position:</span> {created.position} (Rank {created.rank})
          </div>
          <div>
            <span className="font-medium">Company:</span> {created.company.code}
          </div>
          <div>
            <span className="font-medium">Status:</span>{" "}
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
              Routed to your Department Head for approval
            </span>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          This code stands in for {created.position} on employee pickers (like Mobile Phone requests) until they're
          hired and added to the real roster. Once fully approved, this also auto-generates their Office 365 Account
          and Mobile Phone budget requests.
        </div>
      </div>
    );
  }

  const isFormComplete = Boolean(form.departmentHeadId && form.position && form.rank && form.companyId && form.estimatedHireDate && form.justification);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div ref={setFrozenHeaderEl} className="sticky top-0 z-30 space-y-4 bg-[#f5faf7] pb-3 pt-1">
        <PageHeader
          subtitle={subtitle}
          actions={
            <button
              onClick={() => saveDraftMutation.mutate()}
              disabled={!isFormComplete || isBusy}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              Save Draft
            </button>
          }
        />
        <div className="grid grid-cols-2 gap-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm shadow-sm">
          <div>
            <label className="block font-medium text-emerald-800">Originating Department</label>
            <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{currentUser?.department?.name}</div>
          </div>
          <div>
            <label className="block font-medium text-emerald-800">Target Calendar Year</label>
            <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{FISCAL_YEAR}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <SectionLabel>Position Details</SectionLabel>
        <div>
          <label className="block text-sm font-medium text-slate-600">Position</label>
          <div className="mt-1">
            <SearchableSelect
              placeholder="Search positions…"
              options={positions.map((p) => ({ value: p.title, label: p.title }))}
              value={form.position}
              onChange={(v) => setForm({ ...form, position: v })}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-600">Rank</label>
            <select
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              value={form.rank}
              onChange={(e) => handleRankChange(e.target.value)}
            >
              <option value="">— Select —</option>
              {RANK_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600">Company</label>
            <select
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              value={form.companyId}
              onChange={(e) => setForm({ ...form, companyId: e.target.value })}
            >
              <option value="">— Select —</option>
              {companyOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-600">Estimated Hire Date</label>
          <input
            type="date"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={form.estimatedHireDate}
            onChange={(e) => setForm({ ...form, estimatedHireDate: e.target.value })}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-600">Justification</label>
          <textarea
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            rows={3}
            value={form.justification}
            onChange={(e) => setForm({ ...form, justification: e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <SectionLabel>Approval</SectionLabel>
        <ApproverPicker
          label="Department Head / Approver"
          value={form.departmentHeadId}
          onChange={(v) => setForm({ ...form, departmentHeadId: v })}
        />
      </div>
      </div>

      <div className="space-y-4 lg:col-span-2">
        <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm shadow-sm lg:sticky" style={{ top: frozenHeaderHeight + 16 }}>
          <SectionLabel>Quick Guide</SectionLabel>
          <ol className="list-decimal space-y-1.5 pl-5 text-xs text-slate-700">
            <li>Pick the Position from the list. Rank and Company are needed too.</li>
            <li>Enter the Estimated Hire Date.</li>
            <li>Write a Justification for the headcount.</li>
            <li>Save Draft to keep it for later, or Submit Request. It goes to your Department Head, then the HR Analyst, then the HR Head.</li>
          </ol>
        </div>
      </div>
      </div>

      {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
    </div>
  );
}
