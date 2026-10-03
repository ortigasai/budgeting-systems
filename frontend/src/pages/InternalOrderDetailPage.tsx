import { formatAufnr } from "../lib/formatAufnr";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2, type InternalOrderRequest, type TransferDecision } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import { SectionLabel } from "../components/TabBar";
import { useAuth } from "../context/AuthContext";

// Mirrors backend-py's routers/internal_orders.py (which reuses transfers.py's
// STAGE_ROLE) - same stage-role map already duplicated in
// TransferDetailPage.tsx for the same reason (different language, no shared
// module between the two).
const STAGE_ROLE: Record<string, string> = {
  DEPT_HEAD_REVIEW: "DEPARTMENT_HEAD",
  BUDGET_OFFICER_VALIDATION: "BUDGET_OFFICER",
  BU_FINANCE_HEAD_REVIEW: "BU_FINANCE_HEAD",
  BU_HEAD_AUTHORIZATION: "BU_HEAD",
  BU_FINANCE_OFFICER_VERIFICATION: "BU_FINANCE_OFFICER",
  CFO_REVIEW: "CFO",
  CFO_AUTHORIZATION: "CFO",
  BUDGET_OFFICER_SAP_UPLOAD: "BUDGET_OFFICER",
};
const SBU_SCOPED_ROLES = new Set(["BU_FINANCE_HEAD", "BU_HEAD", "BU_FINANCE_OFFICER"]);

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// IO's `sbu` is its own fixed 8-value code (MALLS/OFFICES/.../CORPORATE_ADMIN
// - see api/client.ts's IO_SBU_OPTIONS), not the Prisma Sbu enum, EXCEPT the
// 5 regional (DOE) codes are spelled identically to it - which is exactly
// what makes hasSbuRole(role, io.sbu) work correctly for the DOE stream
// without any translation here.
export function InternalOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentUser, hasRole, hasSbuRole } = useAuth();
  const queryClient = useQueryClient();

  const { data: io, isLoading } = useQuery({
    queryKey: ["internal-order", id],
    queryFn: async () => (await api2.get<InternalOrderRequest>(`/internal-orders/${id}`)).data,
  });

  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["internal-order", id] });
    queryClient.invalidateQueries({ queryKey: ["internal-orders", "mine"] });
    queryClient.invalidateQueries({ queryKey: ["internal-orders", "inbox"] });
  };

  const decisionMutation = useMutation({
    mutationFn: async (decision: TransferDecision) => (await api2.post<InternalOrderRequest>(`/internal-orders/${id}/decision`, { decision, comment: comment || undefined })).data,
    onSuccess: () => {
      setComment("");
      setError(null);
      invalidate();
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Could not record this decision."),
  });

  const submitMutation = useMutation({
    mutationFn: async () => (await api2.post<InternalOrderRequest>(`/internal-orders/${id}/submit`)).data,
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: any) => setError(err.response?.data?.detail ?? "Could not submit request."),
  });

  if (isLoading || !io) return <div className="text-sm text-slate-400">Loading…</div>;

  const isRequestor = io.requestorId === currentUser?.id;
  const canEditDraft = isRequestor && (io.status === "DRAFT" || io.status === "RETURNED");
  const role = STAGE_ROLE[io.currentStage];
  const canDecide =
    io.status === "IN_REVIEW" &&
    role !== undefined &&
    (role === "DEPARTMENT_HEAD" ? hasRole(role, io.departmentId) : SBU_SCOPED_ROLES.has(role) ? hasSbuRole(role, io.sbu) : hasRole(role));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <button type="button" onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-emerald-700">
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor" className="h-4 w-4">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-tight text-slate-800">Internal Order Request — {io.projectTitle}</h1>
        <div className="flex items-center gap-2">
          <StatusBadge stage={io.status === "REJECTED" || io.status === "RETURNED" || io.status === "DRAFT" ? io.status : io.currentStage} />
          {canEditDraft && (
            <button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending} className="rounded-md bg-emerald-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
              Submit for Approval
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-lg border border-emerald-200 border-l-4 border-l-lime-600 bg-emerald-50 p-4 text-sm shadow-sm sm:grid-cols-3">
        <Field label="Requestor" value={io.requestorName} />
        <Field label="Department" value={io.departmentName} />
        <Field label="Fiscal Year" value={String(io.fiscalYear)} />
        <Field label="SBU" value={io.sbuLabel} />
        <Field label="Location" value={io.location} />
        <Field label="Cost Center" value={io.costCenter} />
        <Field label="Amount (VAT excl.)" value={peso(io.amount)} accent />
        <Field label="Project Start" value={new Date(io.projectStart).toLocaleDateString()} />
        <Field label="Project End" value={new Date(io.projectEnd).toLocaleDateString()} />
        {io.sapDocumentNumber && <Field label="SAP Document #" value={formatAufnr(io.sapDocumentNumber)} />}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <SectionLabel>Funding</SectionLabel>
        {io.isBudgeted ? (
          <div>Already NPC-budgeted — {io.npcBudgetCode}</div>
        ) : (
          <div className="space-y-1">
            <div>Not yet budgeted — requesting {io.requestType === "REALLOCATION" ? "a reallocation" : "a supplement"}</div>
            {io.requestType === "REALLOCATION" && (
              <div className="text-slate-600">
                Source: {io.reallocationSourceType === "NPC_BUDGET" ? `NPC Budget ${io.reallocationNpcBudgetCode}` : `IO Budget ${io.reallocationIoBudgetCode ? formatAufnr(io.reallocationIoBudgetCode) : "(pending SAP integration)"}`}
              </div>
            )}
          </div>
        )}
      </div>

      {error && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {canDecide && (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <SectionLabel>Your Decision</SectionLabel>

          <textarea className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" rows={2} placeholder="Comment (optional, required for Return)" value={comment} onChange={(e) => setComment(e.target.value)} />

          <div className="flex flex-wrap gap-2">
            <button onClick={() => decisionMutation.mutate("APPROVE")} disabled={decisionMutation.isPending} className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
              {io.currentStage === "BUDGET_OFFICER_SAP_UPLOAD" ? "Upload to SAP" : "Approve"}
            </button>
            <button onClick={() => decisionMutation.mutate("RETURN")} disabled={decisionMutation.isPending || !comment} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100 disabled:opacity-50">
              Return
            </button>
            <button onClick={() => decisionMutation.mutate("REJECT")} disabled={decisionMutation.isPending} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50">
              Reject
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <SectionLabel>Review History</SectionLabel>
        {io.reviewDecisions.length === 0 ? (
          <div className="text-slate-500">No decisions recorded yet.</div>
        ) : (
          <ul className="space-y-2">
            {io.reviewDecisions.map((d) => (
              <li key={d.id} className="border-l-2 border-emerald-200 pl-3">
                <div className="font-medium">
                  {d.decision} at {d.stage} — {d.decidedByName}
                </div>
                <div className="text-xs text-slate-500">{new Date(d.timestamp).toLocaleString()}</div>
                {d.comment && <div className="text-slate-600">{d.comment}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>
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
