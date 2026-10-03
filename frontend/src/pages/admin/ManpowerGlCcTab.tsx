import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Company, type PayComponent } from "../../api/client";

// SAP Requirements integration - Manpower's "Run Manpower Budget" (spec:
// KSBB 1 -> Manpower Budget Dashboard) needs a real GL Account per Pay
// Component and a real Cost Center per Company before it can pull live KSSB
// V1 actuals for that pair (see manpowerService.ts's runManpowerRecompute).
// Both lists were previously unmapped - plain admin-editable text fields,
// same convention as CcGlCodesTab's SBU dropdown.
export function ManpowerGlCcTab() {
  const queryClient = useQueryClient();
  const { data: payComponents = [] } = useQuery({
    queryKey: ["admin-pay-components"],
    queryFn: async () => (await api.get<PayComponent[]>("/admin/pay-components")).data,
  });
  const { data: companies = [] } = useQuery({
    queryKey: ["admin-companies"],
    queryFn: async () => (await api.get<Company[]>("/admin/companies")).data,
  });

  const updatePayComponent = useMutation({
    mutationFn: async ({ id, glAccount }: { id: string; glAccount: string | null }) =>
      (await api.patch<PayComponent>(`/admin/pay-components/${id}`, { glAccount })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-pay-components"] }),
  });
  const updateCompany = useMutation({
    mutationFn: async ({ id, costCenter }: { id: string; costCenter: string | null }) =>
      (await api.patch<Company>(`/admin/companies/${id}`, { costCenter })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-companies"] }),
  });

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800">
        "Run Manpower Budget" pulls real KSSB V1 actuals per (Pay Component, Company) pair - only pairs with both a GL Account and a Cost Center mapped below get a live figure; unmapped pairs stay at 0 and are listed after each run.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-semibold text-slate-700">Pay Components - GL Account ({payComponents.length})</div>
          <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[#edf6f1] text-left text-xs tracking-wide text-[#164b33]">
                <tr>
                  <th className="px-3 py-2">Pay Component</th>
                  <th className="px-3 py-2">GL Account</th>
                </tr>
              </thead>
              <tbody>
                {payComponents.map((pc) => (
                  <tr key={pc.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{pc.name}</td>
                    <td className="px-3 py-2">
                      <input
                        className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
                        placeholder="Not mapped"
                        defaultValue={pc.glAccount ?? ""}
                        key={pc.glAccount}
                        disabled={updatePayComponent.isPending}
                        onBlur={(e) => {
                          const value = e.target.value.trim();
                          if (value !== (pc.glAccount ?? "")) updatePayComponent.mutate({ id: pc.id, glAccount: value || null });
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-semibold text-slate-700">Companies - Cost Center ({companies.length})</div>
          <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[#edf6f1] text-left text-xs tracking-wide text-[#164b33]">
                <tr>
                  <th className="px-3 py-2">Company</th>
                  <th className="px-3 py-2">Cost Center</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2">
                      <input
                        className="w-32 rounded border border-slate-300 px-2 py-1 text-xs"
                        placeholder="Not mapped"
                        defaultValue={c.costCenter ?? ""}
                        key={c.costCenter}
                        disabled={updateCompany.isPending}
                        onBlur={(e) => {
                          const value = e.target.value.trim();
                          if (value !== (c.costCenter ?? "")) updateCompany.mutate({ id: c.id, costCenter: value || null });
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
