import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useFiscalYear } from "../../lib/fiscalCycle";

export function ThresholdsTab() {
  const queryClient = useQueryClient();
  const { targetYear } = useFiscalYear();
  const { data: docThreshold } = useQuery({
    queryKey: ["documentation-threshold"],
    queryFn: async () => (await api.get<{ amount: number }>("/admin/documentation-threshold")).data,
  });

  const [docAmount, setDocAmount] = useState("");
  const updateDocThreshold = useMutation({
    mutationFn: async () => (await api.put("/admin/documentation-threshold", { amount: Number(docAmount) })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documentation-threshold"] });
      setDocAmount("");
    },
  });

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 text-sm font-semibold">
          Documentation Threshold: <span className="text-emerald-800">{(docThreshold?.amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
        </div>
        <p className="mb-2 text-xs text-slate-500">
          Attachments are mandatory once the {targetYear} Proposed Amount exceeds this figure (Field 7).
        </p>
        <div className="flex items-center gap-2 text-sm">
          <input
            type="number"
            className="w-40 rounded border border-slate-300 px-2 py-1"
            placeholder="New amount"
            value={docAmount}
            onChange={(e) => setDocAmount(e.target.value)}
          />
          <button
            onClick={() => updateDocThreshold.mutate()}
            disabled={!docAmount}
            className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            Update
          </button>
        </div>
      </div>
    </div>
  );
}
