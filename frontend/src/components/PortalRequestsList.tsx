import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Department, type ExpenseLineItem } from "../api/client";
import { StatusBadge } from "./StatusBadge";

interface PoolConsumingRequest {
  id: string;
  proposedAmount: number;
  budgetCutAmount: number;
  currentStage: string;
  businessJustification: string;
  updatedAt: string;
  department: Department;
  expenseLineItem: ExpenseLineItem;
  createdBy: { name: string; email: string };
}

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// The drill-down behind the "Portal Requests" stat tile — the individual
// requests that make up that department's totalPortalRequests figure (see
// budgetCalcService.ts's POOL_CONSUMING_STAGES). Shared between the Home
// dashboard (inline, under each department's Cap & Pool card) and the
// standalone /dashboard/:departmentId/requests page.
export function PortalRequestsList({ departmentId, fiscalYear }: { departmentId: string; fiscalYear: number }) {
  const { data: requests = [], isLoading } = useQuery({
    queryKey: ["dashboard", departmentId, fiscalYear, "requests"],
    queryFn: async () => (await api.get<PoolConsumingRequest[]>(`/dashboard/${departmentId}/requests?fiscalYear=${fiscalYear}`)).data,
    enabled: !!departmentId,
  });

  const total = requests.reduce((sum, r) => sum + Math.max(0, r.proposedAmount - r.budgetCutAmount), 0);

  if (isLoading) return <div className="text-sm text-slate-400">Loading…</div>;

  if (requests.length === 0) {
    return <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">No requests are currently consuming this department's pool.</div>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-sm">
        <thead className="bg-emerald-50 text-left text-xs tracking-wide text-emerald-800">
          <tr>
            <th className="whitespace-nowrap px-3 py-2">Expense Line Item</th>
            <th className="whitespace-nowrap px-3 py-2">Originating Department</th>
            <th className="whitespace-nowrap px-3 py-2">Requested By</th>
            <th className="whitespace-nowrap px-3 py-2">Stage</th>
            <th className="whitespace-nowrap px-3 py-2">Amount</th>
            <th className="whitespace-nowrap px-3 py-2">Justification</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => {
            const net = Math.max(0, r.proposedAmount - r.budgetCutAmount);
            return (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="whitespace-nowrap px-3 py-2">{r.expenseLineItem.name}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.department.name}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.createdBy.name}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <StatusBadge stage={r.currentStage} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-medium">{peso(net)}</td>
                <td className="max-w-xs truncate px-3 py-2 text-slate-500" title={r.businessJustification}>
                  {r.businessJustification}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Link to={`/requests/${r.id}`} className="text-xs font-medium text-emerald-700 hover:underline">
                    View
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 bg-slate-50 font-semibold">
            <td className="px-3 py-2" colSpan={4}>
              Total
            </td>
            <td className="px-3 py-2">{peso(total)}</td>
            <td className="px-3 py-2" colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
