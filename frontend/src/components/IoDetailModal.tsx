import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api2 } from "../api/client";
import { formatAufnr } from "../lib/formatAufnr";

interface IoDetail {
  aufnr: string;
  description: string | null;
  budgetCode: string | null;
  sbu: string | null;
  sapBudget: number | null;
  sapActual: number | null;
  sapCommitted: number | null;
  sapAllotted: number | null;
  sapAvailable: number | null;
  monitoringBudget: number | null;
  monitoringActual: number | null;
  monitoringCommitted: number | null;
  monitoringAvailable: number | null;
  ytdActualByMonth: Record<string, number> | null;
  requestProjectTitle: string | null;
  requestLocation: string | null;
  requestProjectStart: string | null;
  requestProjectEnd: string | null;
  requestAmount: number | null;
  requestStatus: string | null;
  requestCostCenter: string | null;
}

const peso = (n: number | null) => (n === null || n === undefined ? "—" : `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-sm text-slate-900">{value || "—"}</div>
    </div>
  );
}

// Pop-up with one Internal Order's details - opened from a clickable IO Code
// (Utilization's NPC table). Backed by GET /utilization/npc/io/{aufnr}.
export function IoDetailModal({ aufnr, fiscalYear, onClose }: { aufnr: string; fiscalYear: number; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["npc-io-detail", aufnr, fiscalYear],
    queryFn: async () => (await api2.get<IoDetail>(`/utilization/npc/io/${aufnr}`, { params: { fiscalYear } })).data,
    retry: false,
  });

  const [exporting, setExporting] = useState(false);
  const exportExcel = async () => {
    setExporting(true);
    try {
      const res = await api2.get(`/utilization/npc/io/${aufnr}/export`, { params: { fiscalYear }, responseType: "blob" });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `io-${formatAufnr(aufnr)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold tracking-wide text-slate-500">Internal Order</div>
            <div className="font-mono text-lg font-semibold text-emerald-800">{formatAufnr(aufnr)}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportExcel} disabled={!data || exporting} className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
              {exporting ? "Exporting…" : "Export to Excel"}
            </button>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            ✕
          </button>
          </div>
        </div>

        {isLoading && <div className="text-sm text-slate-500">Loading…</div>}
        {isError && <div className="text-sm text-red-600">Could not load this Internal Order's details.</div>}

        {data && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <Field label="Description" value={data.description} />
              </div>
              <Field label="Budget Code" value={data.budgetCode} />
              <Field label="NPC SBU" value={data.sbu} />
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold tracking-wide text-emerald-800">SAP figures (S_ALR_87013019)</div>
              <div className="grid grid-cols-5 gap-4">
                <Field label="Budget" value={peso(data.sapBudget)} />
                <Field label="Actual" value={peso(data.sapActual)} />
                <Field label="Commitment" value={peso(data.sapCommitted)} />
                <Field label="Allotted" value={peso(data.sapAllotted)} />
                <Field label="Available" value={peso(data.sapAvailable)} />
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
