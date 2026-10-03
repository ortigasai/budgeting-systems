import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2 } from "../api/client";
import { PageHeader } from "../components/PageHeader";

interface DashFlowTicketOut {
  id: number;
  externalTicketId: string;
  externalTicketUrl: string | null;
  costCenter: string;
  glAccount: string;
  requestAmount: number;
  fiscalYear: number;
  routedSbu: string | null;
  status: "OPEN" | "CLOSED";
  budgetAvailable: boolean;
  availableAmount: number;
  closedByName: string | null;
  closedAt: string | null;
  createdAt: string;
}

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Note 11 §5 - "Dash Flow Payment Request Ticket – Budget Check". Served by
// the FastAPI backend (backend-py/), reached via api2 - same as every other
// Phase 2/3 page. Restricted to SBU Finance Officers (own SBU only) plus the
// Budget Officer (all SBUs), enforced server-side; this page shows whatever
// GET /dash-flow/tickets returns rather than re-deriving access here.
// Switched off for everyone for now - the menu entry stays visible for SBU
// Finance members, but the page shows this notice and the API refuses every
// request (see backend-py/app/routers/dash_flow.py's DASH_FLOW_ENABLED). Set
// both to true to restore it.
const DASH_FLOW_ENABLED = false;

export function DashFlowBudgetCheckPage() {
  if (!DASH_FLOW_ENABLED) {
    return (
      <div className="space-y-4">
        <PageHeader subtitle="Dash Flow Budget Check is temporarily unavailable." />
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
          This page is not open for use yet. You'll be notified once it is available.
        </div>
      </div>
    );
  }
  return <DashFlowBudgetCheckContent />;
}

function DashFlowBudgetCheckContent() {
  const [showHistory, setShowHistory] = useState(false);
  const queryClient = useQueryClient();

  const { data: tickets = [], isLoading, error } = useQuery({
    queryKey: ["dash-flow", "tickets", showHistory],
    queryFn: async () =>
      (
        await api2.get<DashFlowTicketOut[]>("/dash-flow/tickets", {
          params: { status_filter: showHistory ? "CLOSED" : "OPEN" },
        })
      ).data,
  });

  const syncMutation = useMutation({
    mutationFn: async () => (await api2.post<{ created: number; updated: number }>("/dash-flow/sync")).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dash-flow", "tickets"] }),
  });

  const closeMutation = useMutation({
    mutationFn: async (id: number) => (await api2.post(`/dash-flow/tickets/${id}/close`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dash-flow", "tickets"] }),
  });

  if ((error as any)?.response?.status === 403) {
    return (
      <div className="space-y-6">
        <PageHeader subtitle="You do not have Dash Flow Budget Check access." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        subtitle="Payment request tickets from Dash Flow, checked live against the finalized budget."
        actions={
          <>
            <button
              onClick={() => setShowHistory((s) => !s)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              {showHistory ? "Show Open Queue" : "Show History"}
            </button>
            {!showHistory && (
              <button
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {syncMutation.isPending ? "Syncing…" : "Sync from Dash Flow"}
              </button>
            )}
          </>
        }
      />

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-left text-xs tracking-wide text-emerald-800">
            <tr>
              <th className="px-4 py-2">Ticket</th>
              <th className="px-4 py-2">Cost Center</th>
              <th className="px-4 py-2">GL Account</th>
              <th className="px-4 py-2">Request Amount</th>
              <th className="px-4 py-2">Budget Check</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Loading…
                </td>
              </tr>
            ) : tickets.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  {showHistory ? "No closed tickets yet." : "No open tickets. Try Sync from Dash Flow."}
                </td>
              </tr>
            ) : (
              tickets.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-2">
                    {t.externalTicketUrl ? (
                      <a href={t.externalTicketUrl} target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline">
                        {t.externalTicketId}
                      </a>
                    ) : (
                      t.externalTicketId
                    )}
                  </td>
                  <td className="px-4 py-2">{t.costCenter}</td>
                  <td className="px-4 py-2">{t.glAccount}</td>
                  <td className="px-4 py-2 font-semibold text-slate-700">{peso(t.requestAmount)}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        t.budgetAvailable ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"
                      }`}
                    >
                      {t.budgetAvailable ? "Budget available" : "No sufficient budget"}
                    </span>
                    <span className="ml-2 text-xs text-slate-400">available {peso(t.availableAmount)}</span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {t.status === "OPEN" ? (
                      <button
                        onClick={() => closeMutation.mutate(t.id)}
                        disabled={closeMutation.isPending}
                        className="text-xs font-medium text-slate-600 hover:underline disabled:opacity-50"
                      >
                        Close ticket
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">
                        Closed by {t.closedByName ?? "—"} {t.closedAt ? new Date(t.closedAt).toLocaleDateString() : ""}
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
