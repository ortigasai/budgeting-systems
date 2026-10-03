import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type AdditionalHeadcountRequest } from "../api/client";
import { StatusBadge } from "../components/StatusBadge";
import { SectionLabel } from "../components/TabBar";

// Notes_11: "All requests should be clickable and will be directed to
// 'Details' page." Additional Manpower requests had no detail page at all —
// this mirrors RequestDetailPage.tsx's layout so both read as the same kind
// of page, and also surfaces the Office 365/Mobile Phone follow-ons this
// request auto-generates once approved (see headcountWorkflowService.ts).
export function HeadcountRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: request, isLoading } = useQuery({
    queryKey: ["headcount-request", id],
    queryFn: async () => (await api.get<AdditionalHeadcountRequest>(`/additional-headcount/${id}`)).data,
  });

  if (isLoading || !request) return <div className="text-sm text-slate-400">Loading…</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <button type="button" onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-emerald-700">
        <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor" className="h-4 w-4">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-tight text-slate-800">
          {request.position} (Rank {request.rank})
        </h1>
        <StatusBadge stage={request.currentStage} />
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-lg border border-emerald-200 border-l-4 border-l-lime-600 bg-emerald-50 p-4 text-sm shadow-sm sm:grid-cols-3">
        <Field label="Reference Code" value={request.code} accent />
        <Field label="Originating Department" value={request.department.name} />
        <Field label="Company" value={request.company.code} />
        <Field label="Estimated Hire Date" value={new Date(request.estimatedHireDate).toLocaleDateString()} />
        <Field label="Created By" value={request.createdBy.name} />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <SectionLabel>Justification</SectionLabel>
        <p className="text-slate-600">{request.justification}</p>
      </div>

      {(request.office365AccountRequest || request.mobilePhoneBudgetRequest) && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <SectionLabel>Auto-Generated Follow-On Requests</SectionLabel>
          <div className="space-y-2">
            {request.office365AccountRequest && (
              <div className="flex items-center justify-between rounded border border-slate-100 px-3 py-2">
                <span className="font-medium text-slate-700">Office 365 Account (IS &amp; IT)</span>
                <StatusBadge stage={request.office365AccountRequest.stage} />
              </div>
            )}
            {request.mobilePhoneBudgetRequest && (
              <div className="flex items-center justify-between rounded border border-slate-100 px-3 py-2">
                <span className="font-medium text-slate-700">Mobile Phone Budget (Admin Services)</span>
                <StatusBadge stage={request.mobilePhoneBudgetRequest.stage} />
              </div>
            )}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <SectionLabel>Review History</SectionLabel>
        {request.reviewDecisions.length === 0 ? (
          <div className="text-slate-500">No decisions recorded yet.</div>
        ) : (
          <ul className="space-y-2">
            {request.reviewDecisions.map((d) => (
              <li key={d.id} className="border-l-2 border-emerald-200 pl-3">
                <div className="font-medium">
                  {d.decision} at {d.stage} — {d.decidedBy.name}
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
