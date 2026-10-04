import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, api2, SBU_OPTIONS, type DemoUser, type TransferDecision, type TransferRequest } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import { SectionLabel } from "../components/TabBar";
import { SearchableSelect } from "../components/SearchableSelect";
import { useAuth } from "../context/AuthContext";

// Mirrors backend-py's routers/transfers.py STAGE_ROLE - which role can act
// at each stage, and whether that role is department-scoped (the specific
// assigned Dept Head), SBU-scoped, or unscoped. Duplicated here (not shared
// with the backend, different language) same as other stage-role maps
// already duplicated between the Node backend and this frontend elsewhere in
// the app.
const STAGE_ROLE: Record<string, string> = {
  DEPT_HEAD_REVIEW: "DEPARTMENT_HEAD",
  SBU_FINANCE_OFFICER_REVIEW: "BU_FINANCE_OFFICER",
  SBU_FINANCE_HEAD_APPROVAL: "BU_FINANCE_HEAD",
  SBU_HEAD_APPROVAL: "BU_HEAD",
  CFO_APPROVAL: "CFO",
  CEO_APPROVAL: "CEO",
  SBU_FINANCE_OFFICER_COMPLETION: "BU_FINANCE_OFFICER",
  BUDGET_OFFICER_SAP_UPLOAD: "BUDGET_OFFICER",
};
const SBU_SCOPED_ROLES = new Set(["BU_FINANCE_HEAD", "BU_HEAD", "BU_FINANCE_OFFICER"]);
const TERMINAL_STATUSES = new Set(["REJECTED", "CANCELLED", "UPLOADED_TO_SAP"]);

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// The download endpoint requires the same JWT every other api2 call sends -
// a plain <a href> wouldn't carry it, so fetch as a blob (axios already
// attaches Authorization via setAuthToken) and trigger the save manually.
async function downloadAttachment(id: number, fileName: string) {
  const res = await api2.get(`/transfers/attachments/${id}`, { responseType: "blob" });
  const url = URL.createObjectURL(res.data as Blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function TransferDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentUser, hasRole, hasSbuRole } = useAuth();
  const queryClient = useQueryClient();

  const { data: t, isLoading } = useQuery({
    queryKey: ["transfer", id],
    queryFn: async () => (await api2.get<TransferRequest>(`/transfers/${id}`)).data,
  });

  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [showReassign, setShowReassign] = useState(false);

  const { data: users = [] } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: async () => (await api.get<DemoUser[]>("/auth/users")).data,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["transfer", id] });
    queryClient.invalidateQueries({ queryKey: ["transfers", "mine"] });
    queryClient.invalidateQueries({ queryKey: ["transfers", "inbox"] });
  };

  const decisionMutation = useMutation({
    mutationFn: async (decision: TransferDecision) => (await api2.post<TransferRequest>(`/transfers/${id}/decision`, { decision, comment: comment || undefined })).data,
    onSuccess: () => {
      setComment("");
      setError(null);
      invalidate();
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Could not record this decision."),
  });

  const reassignMutation = useMutation({
    mutationFn: async () => (await api2.post<TransferRequest>(`/transfers/${id}/reassign`, { assigneeUserId: reassignTo, comment: comment || undefined })).data,
    onSuccess: () => {
      setComment("");
      setReassignTo("");
      setShowReassign(false);
      setError(null);
      invalidate();
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Could not reassign this request."),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => (await api2.post<TransferRequest>(`/transfers/${id}/cancel`)).data,
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Could not cancel this request."),
  });

  const submitMutation = useMutation({
    mutationFn: async (assignedDepartmentHeadId: string) => (await api2.post<TransferRequest>(`/transfers/${id}/submit`, { assignedDepartmentHeadId })).data,
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Could not submit request."),
  });

  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return (await api2.post(`/transfers/${id}/attachments`, form)).data;
    },
    onSuccess: (data: { fileName: string }) => {
      setUploadStatus(`Attached: ${data.fileName}`);
      invalidate();
    },
  });

  if (isLoading || !t) return <div className="text-sm text-slate-400">Loading…</div>;

  const isRequestor = t.requestorId === currentUser?.id;
  const canEditDraft = isRequestor && (t.status === "DRAFT" || t.status === "RETURNED");
  const canCancel = isRequestor && !TERMINAL_STATUSES.has(t.status);
  const role = STAGE_ROLE[t.currentStage];
  const roleEligible =
    role !== undefined &&
    (t.currentStage === "DEPT_HEAD_REVIEW" ? currentUser?.id === t.assignedDepartmentHeadId : SBU_SCOPED_ROLES.has(role) ? hasSbuRole(role, t.sbu ?? undefined) : hasRole(role));
  const canDecide = t.status === "IN_REVIEW" && (t.stageAssigneeOverrideId ? t.stageAssigneeOverrideId === currentUser?.id : roleEligible);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <button type="button" onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-emerald-700">
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor" className="h-4 w-4">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-tight text-slate-800">
          <span className="font-mono text-emerald-800">{t.ticketNumber}</span> — {t.type === "REALLOCATION" ? "Reallocation" : "Supplemental"}
        </h1>
        <div className="flex items-center gap-2">
          <StatusBadge stage={t.status === "REJECTED" || t.status === "RETURNED" || t.status === "CANCELLED" || t.status === "DRAFT" ? t.status : t.currentStage} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm shadow-sm sm:grid-cols-3">
            <Field label="Requestor" value={t.requestorName} />
            <Field label="Department" value={t.departmentName} />
            <Field label="Fiscal Year" value={String(t.fiscalYear)} />
            <Field label="Amount (VAT exclusive)" value={peso(t.amount)} accent />
            <Field label="Company" value={t.companyCode ?? "—"} />
            <Field label="SBU" value={SBU_OPTIONS.find((o) => o.value === t.sbu)?.label ?? t.sbu ?? "—"} />
            {t.location && <Field label="Location" value={t.location} />}
            {t.assignedDepartmentHeadName && <Field label="Department Head" value={t.assignedDepartmentHeadName} />}
            <Field label="To" value={`CC ${t.targetCostCenter ?? "—"} (${t.targetCostCenterName ?? "—"}) / GL ${t.targetGlAccount ?? "—"} (${t.targetGlAccountName ?? "—"})`} />
            {t.type === "REALLOCATION" && <Field label="From" value={`CC ${t.budgetSourceCostCenter} (${t.budgetSourceCostCenterName ?? "—"}) / GL ${t.budgetSourceGlAccount} (${t.budgetSourceGlAccountName ?? "—"})`} />}
            {t.sapDocumentNumber && <Field label="SAP Document #" value={t.sapDocumentNumber} />}
            {t.stageAssigneeOverrideName && <Field label="Reassigned To" value={t.stageAssigneeOverrideName} />}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <SectionLabel>Details</SectionLabel>
            <p className="text-slate-600">{t.details}</p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <SectionLabel>Attachments</SectionLabel>
            {t.attachments.length === 0 ? (
              <div className="text-slate-500">None</div>
            ) : (
              <ul className="list-inside list-disc">
                {t.attachments.map((a) => (
                  <li key={a.id}>
                    <button type="button" onClick={() => downloadAttachment(a.id, a.fileName)} className="text-emerald-800 hover:underline">
                      {a.fileName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {canEditDraft && (
              <div className="mt-2">
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
              </div>
            )}
          </div>

          {canEditDraft && (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
              <SectionLabel>Submit for Approval</SectionLabel>
              <p className="text-xs text-slate-500">Choose which Department Head should review this request. At least one attachment is required.</p>
              <DepartmentHeadPicker
                disabled={t.attachments.length === 0}
                onSubmit={(headId) => submitMutation.mutate(headId)}
                isSubmitting={submitMutation.isPending}
              />
            </div>
          )}

          {error && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}

          {canDecide && (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
              <SectionLabel>Decision</SectionLabel>

              <textarea className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" rows={2} placeholder="Comment (optional, required for Return)" value={comment} onChange={(e) => setComment(e.target.value)} />

              <div className="flex flex-wrap gap-2">
                <button onClick={() => decisionMutation.mutate("APPROVE")} disabled={decisionMutation.isPending} className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
                  {t.currentStage === "BUDGET_OFFICER_SAP_UPLOAD" ? "Upload to SAP" : "Approve"}
                </button>
                <button onClick={() => decisionMutation.mutate("RETURN")} disabled={decisionMutation.isPending || !comment} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100 disabled:opacity-50">
                  Return to Requestor
                </button>
                <button onClick={() => decisionMutation.mutate("REJECT")} disabled={decisionMutation.isPending} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50">
                  Reject
                </button>
                <button onClick={() => setShowReassign((v) => !v)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100">
                  Reassign…
                </button>
              </div>

              {showReassign && (
                <div className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-slate-50 p-3">
                  <div className="w-64">
                    <label className="mb-1 block text-xs font-medium text-slate-500">Reassign to</label>
                    <SearchableSelect
                      placeholder="Search employees…"
                      options={users.map((u) => ({ value: u.id, label: u.name, sublabel: u.department?.name ?? "no dept" }))}
                      value={reassignTo}
                      onChange={setReassignTo}
                    />
                  </div>
                  <button
                    onClick={() => reassignMutation.mutate()}
                    disabled={!reassignTo || reassignMutation.isPending}
                    className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-600 disabled:opacity-50"
                  >
                    Confirm Reassign
                  </button>
                </div>
              )}
            </div>
          )}

          {canCancel && (
            <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
              <button
                onClick={() => {
                  if (window.confirm("Cancel this transfer request? This cannot be undone.")) cancelMutation.mutate();
                }}
                disabled={cancelMutation.isPending}
                className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Cancel Request
              </button>
            </div>
          )}
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <SectionLabel>Review History &amp; Audit Trail</SectionLabel>
            {t.reviewDecisions.length === 0 ? (
              <div className="text-slate-500">No decisions recorded yet.</div>
            ) : (
              <ul className="space-y-3">
                {t.reviewDecisions.map((d) => (
                  <li key={d.id} className="border-l-2 border-emerald-200 pl-3">
                    <div className="font-medium">
                      {d.decision} at {d.stage}
                    </div>
                    <div className="text-xs text-slate-500">
                      {d.decidedByName} — {new Date(d.timestamp).toLocaleString()}
                    </div>
                    {d.comment && <div className="mt-0.5 text-slate-600">{d.comment}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DepartmentHeadPicker({ disabled, onSubmit, isSubmitting }: { disabled: boolean; onSubmit: (headId: string) => void; isSubmitting: boolean }) {
  const [headId, setHeadId] = useState("");
  const { data: heads = [] } = useQuery({
    queryKey: ["transfers", "department-heads"],
    queryFn: async () => (await api2.get<{ id: string; name: string }[]>("/transfers/department-heads")).data,
  });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="block text-xs font-medium text-slate-500">Department Head</label>
        <select className="mt-1 rounded border border-slate-300 px-2 py-1.5 text-sm" value={headId} onChange={(e) => setHeadId(e.target.value)}>
          <option value="">— Select —</option>
          {heads.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </div>
      <button
        onClick={() => onSubmit(headId)}
        disabled={disabled || !headId || isSubmitting}
        className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
      >
        Submit for Approval
      </button>
    </div>
  );
}

function Field({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={accent ? "text-base font-bold text-emerald-800" : "font-medium"}>{value}</div>
    </div>
  );
}
