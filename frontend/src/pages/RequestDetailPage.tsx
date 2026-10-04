import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, requestLineDisplay, type BudgetRequest, type DemoUser } from "../api/client";
import { ApproverPicker } from "../components/ApproverPicker";
import { SearchableSelect } from "../components/SearchableSelect";
import { StatusBadge, STAGE_LABELS } from "../components/StatusBadge";
import { useAuth } from "../context/AuthContext";
import { SectionLabel } from "../components/TabBar";

// The backend (workflowService.ts's cancelRequest) is the real authority on
// who can cancel when - this is just when to show the button: the requestor
// (their own draft, or their first pending stage) or whoever the current
// stage is assigned to (request.canAct, set by GET /budget-requests/:id).
const TERMINAL_STAGES = new Set(["APPROVED", "CANCELLED", "REJECTED", "UPLOADED_TO_SAP"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function RequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pickDeptHead, setPickDeptHead] = useState("");
  const [pickSbuHead, setPickSbuHead] = useState("");
  const [pickCentralizedHead, setPickCentralizedHead] = useState("");
  const { data: request, isLoading } = useQuery({
    queryKey: ["budget-request", id],
    queryFn: async () => (await api.get<BudgetRequest>(`/budget-requests/${id}`)).data,
  });

  // A DRAFT request is editable by its own requestor - either a brand-new
  // one not yet submitted, or one RETURN_REQUESTOR sent all the way back to
  // DRAFT (see workflowService.ts). Edited here, not re-derived from
  // scratch via NewRequestPage, since a returned request needs to fix
  // whatever the reviewer's comment called out, not start over. Synced from
  // the loaded request once (not on every refetch) so the requestor's
  // in-progress edits aren't clobbered by an unrelated background refetch.
  const [editedMonthlyAmounts, setEditedMonthlyAmounts] = useState<number[]>(Array(12).fill(0));
  const [editedBusinessJustification, setEditedBusinessJustification] = useState("");
  const [editedOtherFields, setEditedOtherFields] = useState<Record<string, string>>({});
  const [editsLoaded, setEditsLoaded] = useState(false);
  useEffect(() => {
    if (!request || editsLoaded) return;
    setEditedMonthlyAmounts(request.monthlyAmounts);
    setEditedBusinessJustification(request.businessJustification);
    setEditedOtherFields(request.otherRequiredFields);
    setEditsLoaded(true);
  }, [request, editsLoaded]);

  const cancelMutation = useMutation({
    mutationFn: async () => (await api.post<BudgetRequest>(`/budget-requests/${id}/cancel`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budget-request", id] });
      queryClient.invalidateQueries({ queryKey: ["my-requests"] });
    },
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      // Save whatever was edited first - PATCH only accepts a DRAFT request
      // from its own requestor, same as /submit right after it, so a
      // returned request's fix and its resubmission land as one action from
      // the requestor's point of view.
      await api.patch<BudgetRequest>(`/budget-requests/${id}`, {
        monthlyAmounts: editedMonthlyAmounts,
        businessJustification: editedBusinessJustification,
        otherRequiredFields: editedOtherFields,
      });
      return (await api.post<BudgetRequest>(`/budget-requests/${id}/submit`, { departmentHeadId: pickDeptHead || undefined, sbuHeadId: pickSbuHead || undefined, centralizedHeadId: pickCentralizedHead || undefined })).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budget-request", id] });
      queryClient.invalidateQueries({ queryKey: ["my-requests"] });
      setSubmitError(null);
    },
    onError: (err: any) => setSubmitError(err.response?.data?.error ?? "Could not submit request."),
  });

  // Reviewer's own decision controls, same actions/endpoints as the Inbox's
  // expanded review card (InboxPage.tsx) - lets whoever the current stage is
  // assigned to (request.canAct) act straight from this page instead of
  // having to go back to the Inbox list to find this same request again.
  const [decisionComment, setDecisionComment] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const { data: allUsers = [] } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: async () => (await api.get<DemoUser[]>("/auth/users")).data,
    enabled: !!request?.canAct,
  });
  const refreshAfterDecision = () => {
    queryClient.invalidateQueries({ queryKey: ["budget-request", id] });
    queryClient.invalidateQueries({ queryKey: ["inbox"] });
    queryClient.invalidateQueries({ queryKey: ["reviewed-by-me"] });
    queryClient.invalidateQueries({ queryKey: ["my-requests"] });
    setDecisionComment("");
    setReassignTo("");
    setDecisionError(null);
  };
  const decisionMutation = useMutation({
    mutationFn: async (decision: "APPROVE" | "RETURN_PREVIOUS" | "RETURN_REQUESTOR") =>
      (await api.post(`/budget-requests/${id}/decision`, { decision, comment: decisionComment || undefined })).data,
    onSuccess: refreshAfterDecision,
    onError: (err: any) => setDecisionError(err.response?.data?.error ?? "Action failed."),
  });
  const reassignMutation = useMutation({
    mutationFn: async () => (await api.post(`/budget-requests/${id}/reassign`, { userId: reassignTo, comment: decisionComment || undefined })).data,
    onSuccess: refreshAfterDecision,
    onError: (err: any) => setDecisionError(err.response?.data?.error ?? "Reassign failed."),
  });

  if (isLoading || !request) return <div className="text-sm text-slate-400">Loading…</div>;

  const canCancel = !TERMINAL_STAGES.has(request.currentStage) && (request.createdById === currentUser?.id || request.canAct);
  const canSubmit = request.createdById === currentUser?.id && request.currentStage === "DRAFT";
  // NPC's own creation form (NpcRequestTab.tsx) never collects a 12-month
  // grid or free-text Business Justification - amount is a single flat
  // figure living in monthlyAmounts[0], and Business Justification is
  // auto-derived ("NPC Project: ..."). Editing those here the same way GAE/
  // DOE's spend grid is edited would let a resubmission drift from that
  // convention, so NPC keeps both read-only; only its otherRequiredFields
  // (none today, but schema-supported) and approver picks are editable.
  const isNpc = request.requestCategory === "NPC";
  // Mirrors StandardRequestTab.tsx's own-department detection - no separate
  // Department Head for these, they assign their own Centralized Department
  // Head directly instead.
  const ownDeptInitiated =
    request.requestCategory === "GAE" &&
    currentUser?.roles.some((r) => (r.roleType === "CENTRALIZED_BUDGET_PREPARER" || r.roleType === "CENTRALIZED_FIRST_LEVEL_REVIEWER") && r.department?.id === request.expenseLineItem!.ownerDepartmentId);
  const line = requestLineDisplay(request);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <button type="button" onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-emerald-700">
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor" className="h-4 w-4">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-tight text-slate-800">{line.name}</h1>
        <div className="flex items-center gap-2">
          <StatusBadge stage={request.currentStage} />
          {canSubmit && (
            <button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending} className="rounded-md bg-emerald-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
              {request.status === "RETURNED" ? "Resubmit for Approval" : "Submit for Approval"}
            </button>
          )}
          {canCancel && (
            <button onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending} className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50">
              Cancel Request
            </button>
          )}
        </div>
      </div>

      {canSubmit &&
        (request.requestCategory === "GAE" || request.requestCategory === "NPC") &&
        ((ownDeptInitiated && !request.centralizedHeadId) || (!ownDeptInitiated && !request.departmentHeadId) || (request.requestCategory === "NPC" && !request.sbuHeadId)) && (
          <div className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
            {ownDeptInitiated
              ? !request.centralizedHeadId && <ApproverPicker label="Centralized Department Head" value={pickCentralizedHead} onChange={setPickCentralizedHead} />
              : !request.departmentHeadId && <ApproverPicker label="Department Head / Approver" value={pickDeptHead} onChange={setPickDeptHead} />}
            {request.requestCategory === "NPC" && !request.sbuHeadId && <ApproverPicker label="SBU or Division Head" value={pickSbuHead} onChange={setPickSbuHead} />}
          </div>
        )}
      {submitError && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{submitError}</div>}

      <div className="grid grid-cols-2 gap-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm shadow-sm sm:grid-cols-3">
        <Field label="Originating Department" value={request.department.name} />
        {line.ownerDepartmentName && <Field label="Owning (Centralized) Department" value={line.ownerDepartmentName} />}
        <Field label="GL-CC" value={line.glCc} />
        <Field label="Budget Code" value={line.budgetCode ?? "—"} />
        <Field label="Fiscal Year" value={String(request.fiscalYear)} />
        <Field label="Proposed Amount" value={`${request.proposedAmount.toLocaleString()}`} accent />
        {request.requestCategory === "NPC" && request.npcSbu && <Field label="SBU" value={request.npcSbu} />}
        {request.requestCategory === "NPC" && request.npcLocation && <Field label="Location" value={request.npcLocation} />}
        {request.requestCategory === "NPC" && request.projectStartDate && <Field label="Project Start" value={new Date(request.projectStartDate).toLocaleDateString()} />}
        {request.requestCategory === "NPC" && request.projectEndDate && <Field label="Project End" value={new Date(request.projectEndDate).toLocaleDateString()} />}
        {request.budgetCutAmount > 0 && <Field label="Budget Cut" value={`${request.budgetCutAmount.toLocaleString()}`} />}
        {request.isOverBudget && <Field label="Flag" value="Over-budget / Requires Realignment" />}
        {request.sapDocumentNumber && <Field label="SAP Document #" value={request.sapDocumentNumber} />}
        {request.reasonCode && <Field label="Return Reason" value={request.reasonCode} />}
        <Field label="Created By" value={request.createdBy.name} />
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="bg-emerald-50 px-4 py-2 text-xs font-semibold tracking-wide text-emerald-800">Monthly Spend Grid</div>
        <div className="grid grid-cols-3 divide-x divide-y divide-slate-100 border-t border-slate-100 text-sm sm:grid-cols-4 lg:grid-cols-6">
          {MONTHS.map((m, i) => (
            <div key={m} className="px-2 py-3 text-center">
              <div className="text-xs font-medium tracking-wide text-slate-400">{m}</div>
              {canSubmit && !isNpc ? (
                <input
                  type="number"
                  className="mt-1 w-full rounded border border-slate-300 px-1 py-0.5 text-center text-sm tabular-nums"
                  value={editedMonthlyAmounts[i]}
                  onChange={(e) => {
                    const value = Number(e.target.value) || 0;
                    setEditedMonthlyAmounts((prev) => prev.map((v, j) => (j === i ? value : v)));
                  }}
                />
              ) : (
                <div className="mt-1 font-semibold tabular-nums text-slate-700">{request.monthlyAmounts[i].toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <SectionLabel>Business Justification</SectionLabel>
        {canSubmit && !isNpc ? (
          <textarea className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" rows={3} value={editedBusinessJustification} onChange={(e) => setEditedBusinessJustification(e.target.value)} />
        ) : (
          <p className="text-slate-600">{request.businessJustification}</p>
        )}
      </div>

      {(Object.keys(request.otherRequiredFields).length > 0 || (canSubmit && Object.keys(editedOtherFields).length > 0)) && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <SectionLabel>Other Fields</SectionLabel>
          {canSubmit ? (
            <div className="space-y-2">
              {Object.entries(editedOtherFields).map(([k, v]) => (
                <div key={k}>
                  <label className="mb-0.5 block text-xs font-medium text-slate-500">{k}</label>
                  <input
                    type="text"
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                    value={v}
                    onChange={(e) => setEditedOtherFields((prev) => ({ ...prev, [k]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          ) : (
            Object.entries(request.otherRequiredFields).map(([k, v]) => (
              <div key={k}>
                <span className="font-medium">{k}:</span> {v}
              </div>
            ))
          )}
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <SectionLabel>Attachments</SectionLabel>
        {request.attachments.length === 0 ? (
          <div className="text-slate-500">None</div>
        ) : (
          <ul className="list-inside list-disc">
            {request.attachments.map((a) => (
              <li key={a.id}>
                <a className="text-emerald-800 hover:underline" href={`/uploads/${a.storagePath}`} target="_blank" rel="noreferrer">
                  {a.fileName}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>

      {request.canAct && request.status === "IN_REVIEW" && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <SectionLabel>Take Action</SectionLabel>
          <div className="mt-2 space-y-2">
            <div className="text-xs text-slate-500">
              If you proceed, this moves to:{" "}
              <span className="font-medium text-slate-700">{request.nextStage ? (STAGE_LABELS[request.nextStage] ?? request.nextStage) : "Finalize & Upload"}</span>
            </div>
            <label className="block text-xs font-medium text-slate-600">Comment (required to return)</label>
            <textarea className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" rows={2} value={decisionComment} onChange={(e) => setDecisionComment(e.target.value)} />
            {decisionError && <div className="text-red-700">{decisionError}</div>}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => decisionMutation.mutate("APPROVE")}
                disabled={decisionMutation.isPending}
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                Proceed to next stage
              </button>
              <button
                onClick={() => decisionMutation.mutate("RETURN_PREVIOUS")}
                disabled={decisionMutation.isPending}
                className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {request.previousStage ? `Return to ${STAGE_LABELS[request.previousStage] ?? request.previousStage}` : "Return to requestor"}
              </button>
              {request.previousStage && (
                <button
                  onClick={() => decisionMutation.mutate("RETURN_REQUESTOR")}
                  disabled={decisionMutation.isPending}
                  className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                >
                  Return to requestor
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
              <div className="w-64">
                <label className="mb-1 block text-xs font-medium text-slate-500">Reassign this stage to</label>
                <SearchableSelect placeholder="Search employees…" options={allUsers.filter((u) => u.isEmployee).map((u) => ({ value: u.id, label: u.name, sublabel: u.department?.name }))} value={reassignTo} onChange={setReassignTo} />
              </div>
              <button onClick={() => reassignMutation.mutate()} disabled={reassignMutation.isPending || !reassignTo} className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">
                Reassign
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <SectionLabel>Request Status History</SectionLabel>
        {request.status === "DRAFT" && request.reviewDecisions.length === 0 ? (
          <div className="text-slate-500">No decisions recorded yet.</div>
        ) : (
          <ul className="space-y-2">
            {request.status !== "DRAFT" && (
              <li className="border-l-2 border-emerald-200 pl-3">
                <div className="font-medium">Submitted — {request.createdBy.name}</div>
                <div className="text-xs text-slate-500">{new Date(request.createdAt).toLocaleString()}</div>
              </li>
            )}
            {request.reviewDecisions.map((d) => (
              <li key={d.id} className="border-l-2 border-emerald-200 pl-3">
                <div className="font-medium">
                  {d.decision} at {STAGE_LABELS[d.stage] ?? d.stage} — {d.decidedBy.name}
                </div>
                <div className="text-xs text-slate-500">{new Date(d.timestamp).toLocaleString()}</div>
                {d.comment && <div className="text-slate-600">{d.comment}</div>}
              </li>
            ))}
            {request.status === "IN_REVIEW" && (
              <li className="border-l-2 border-amber-300 pl-3">
                <div className="font-medium text-amber-700">
                  Pending at {STAGE_LABELS[request.currentStage] ?? request.currentStage}
                  {request.pendingReviewers && request.pendingReviewers.length > 0 && ` — ${request.pendingReviewers.join(", ")}`}
                </div>
                <div className="text-xs text-slate-500">Awaiting action</div>
              </li>
            )}
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
