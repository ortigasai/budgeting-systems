import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api2 } from "../../api/client";
import { useFiscalYear } from "../../lib/fiscalCycle";

interface GaePastYear {
  fiscalYear: number;
  actualRows: number;
  actualTotal: number;
  budgetRows: number;
  budgetTotal: number;
}
interface GaePastStatus {
  currentYear: number;
  years: GaePastYear[];
}
interface GaePastUploadResult {
  sourceFile: string;
  currentYear: number;
  skippedCurrentYearColumns: number;
  skippedRepeatedColumns: number;
  actualYears: Record<string, { rows: number; total: number }>;
  budgetYears: Record<string, { rows: number; total: number }>;
}

const peso = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

// Closed years' GAE actuals and budgets, from the GAE past-years workbook. The
// current year is never touched by an upload - its live SAP data stays as is.
export function GaePastDataImportTab() {
  const { forecastYear } = useFiscalYear();
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["admin", "gae-past", "status", forecastYear],
    queryFn: async () => (await api2.get<GaePastStatus>("/admin/gae-past/status", { params: { currentYear: forecastYear } })).data,
  });

  const [result, setResult] = useState<{ ok: boolean; message: string; detail?: GaePastUploadResult } | null>(null);
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("currentYear", String(forecastYear));
      return (await api2.post<GaePastUploadResult>("/admin/gae-past/upload", form)).data;
    },
    onSuccess: (data) => {
      const years = Object.keys({ ...data.actualYears, ...data.budgetYears }).sort();
      setResult({
        ok: true,
        message: `Loaded ${data.sourceFile} for ${years.join(", ")}. Current year ${data.currentYear} was left as is.`,
        detail: data,
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "gae-past", "status", forecastYear] });
      queryClient.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (err: any) => setResult({ ok: false, message: err.response?.data?.detail ?? "Upload failed." }),
  });

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="text-sm">
          <div className="font-semibold text-slate-700">Upload GAE Past Years Workbook</div>
          <div className="text-xs text-slate-500">
            Loads closed years' GAE actuals (monthly columns such as 2022-01, 2023A-01) and budgets (2023B-01 and later) from the workbook. Each year in the file replaces what was loaded before for that year. Columns for the current year ({forecastYear}) are skipped, so live SAP data is never overwritten.
          </div>
        </div>

        <label className="inline-block cursor-pointer rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">
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
              setResult(null);
              uploadMutation.mutate(file);
            }}
          />
        </label>

        {result && (
          <div className={`text-xs ${result.ok ? "text-emerald-700" : "text-red-600"}`}>
            {result.message}
            {result.detail && (
              <div className="mt-1 text-slate-500">
                Skipped {result.detail.skippedCurrentYearColumns} current-year column(s) and {result.detail.skippedRepeatedColumns} repeated column(s) (a month that appears twice is counted once).
              </div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm">
        <div className="mb-2 font-semibold text-slate-700">Currently Loaded</div>
        {status && status.years.length > 0 ? (
          <table className="w-full text-xs">
            <thead className="bg-[#edf6f1] text-left text-[#164b33]">
              <tr>
                <th className="px-2 py-1">Fiscal Year</th>
                <th className="px-2 py-1 text-right">Actual Rows</th>
                <th className="px-2 py-1 text-right">Actual Total</th>
                <th className="px-2 py-1 text-right">Budget Rows</th>
                <th className="px-2 py-1 text-right">Budget Total</th>
              </tr>
            </thead>
            <tbody>
              {status.years.map((y) => (
                <tr key={y.fiscalYear} className="border-t border-slate-100">
                  <td className="px-2 py-1">{y.fiscalYear}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{y.actualRows.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{peso(y.actualTotal)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{y.budgetRows.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{peso(y.budgetTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-slate-400">Nothing has been loaded from this workbook yet.</div>
        )}
      </div>
    </div>
  );
}
