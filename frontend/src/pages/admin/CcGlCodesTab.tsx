import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2, SBU_OPTIONS, type CcGlOptions, type CostCenterEntry, type Sbu } from "../../api/client";

// Spec item 11: "Change the dropdown list for the CC and GL... Allow this
// to be edited by the Budget Officer in the Admin Console." Same "upload
// replaces the list" convention as the Node side's Expense Line Items
// catalog - the uploaded file must have the same 2-sheet shape as the
// source "Budgeting System_CC-GL" file (a "PCCC" sheet for Cost Centers, a
// "COA" sheet for GL Accounts, each with a header row).
export function CcGlCodesTab() {
  const queryClient = useQueryClient();
  const { data: options = { costCenters: [], glAccounts: [] } } = useQuery({
    queryKey: ["transfers", "cc-gl-options"],
    queryFn: async () => (await api2.get<CcGlOptions>("/transfers/cc-gl-options")).data,
  });

  const [uploadStatus, setUploadStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return (await api2.post<CcGlOptions>("/transfers/cc-gl-upload", form)).data;
    },
    onSuccess: (data) => {
      setUploadStatus({ ok: true, message: `Uploaded: ${data.costCenters.length} cost centers, ${data.glAccounts.length} GL accounts.` });
      queryClient.invalidateQueries({ queryKey: ["transfers", "cc-gl-options"] });
    },
    onError: (err: any) => setUploadStatus({ ok: false, message: err.response?.data?.detail ?? "Upload failed." }),
  });

  const deleteCostCenter = useMutation({
    mutationFn: async (id: number) => (await api2.delete(`/transfers/cost-centers/${id}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["transfers", "cc-gl-options"] }),
  });
  const deleteGlAccount = useMutation({
    mutationFn: async (id: number) => (await api2.delete(`/transfers/gl-accounts/${id}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["transfers", "cc-gl-options"] }),
  });

  // Note 11 §5 - which SBU's Dash Flow queue a Cost Center's tickets route
  // to, since a Dash Flow ticket only carries CC/GL, not an SBU.
  const setCostCenterSbu = useMutation({
    mutationFn: async ({ id, sbu }: { id: number; sbu: Sbu | null }) =>
      (await api2.patch<CostCenterEntry>(`/transfers/cost-centers/${id}/sbu`, { sbu })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["transfers", "cc-gl-options"] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="text-sm">
          <div className="font-semibold text-slate-700">Upload Cost Center / GL Account Lists</div>
          <div className="text-xs text-slate-500">
            Replaces both lists from a workbook shaped like "Budgeting System_CC-GL" - a "PCCC" sheet (Cost Center, Name) and a "COA" sheet (GL Account Code, Account Name). Added/changed rows are applied; rows missing from the file are removed.
          </div>
        </div>
        <label className="cursor-pointer rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">
          {uploadMutation.isPending ? "Uploading…" : "Upload Workbook (.xlsx)"}
          <input
            type="file"
            accept=".xlsx"
            className="hidden"
            disabled={uploadMutation.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setUploadStatus(null);
              uploadMutation.mutate(file);
            }}
          />
        </label>
        {uploadStatus && <span className={`text-xs ${uploadStatus.ok ? "text-emerald-700" : "text-red-600"}`}>{uploadStatus.message}</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-sm font-semibold text-slate-700">Cost Centers ({options.costCenters.length})</div>
          <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[#edf6f1] text-left text-xs tracking-wide text-[#164b33]">
                <tr>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">SBU (Dash Flow)</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {options.costCenters.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono">{c.code}</td>
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2">
                      <select
                        className="rounded border border-slate-300 px-1.5 py-1 text-xs"
                        value={c.sbu ?? ""}
                        onChange={(e) => setCostCenterSbu.mutate({ id: c.id, sbu: (e.target.value || null) as Sbu | null })}
                      >
                        <option value="">Not mapped</option>
                        {SBU_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => deleteCostCenter.mutate(c.id)} className="text-xs text-red-600 hover:underline">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-semibold text-slate-700">GL Accounts ({options.glAccounts.length})</div>
          <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[#edf6f1] text-left text-xs tracking-wide text-[#164b33]">
                <tr>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {options.glAccounts.map((g) => (
                  <tr key={g.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono">{g.code}</td>
                    <td className="px-3 py-2">{g.name}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => deleteGlAccount.mutate(g.id)} className="text-xs text-red-600 hover:underline">
                        Remove
                      </button>
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
