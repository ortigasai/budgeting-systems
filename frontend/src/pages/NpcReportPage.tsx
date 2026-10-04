import { useQuery } from "@tanstack/react-query";
import { api2, NPC_SBU_OPTIONS } from "../api/client";
import { useFiscalYear } from "../lib/fiscalCycle";

// NPC report, per NPC SBU - laid out like the NPC Budget Monitoring summary:
// Original Board, Total Board Approved, Actual, Committed (open PR/PO), Allotted,
// Remaining vs Allotted, 2026 Forecast and Balance. The letter row (A..L) is the
// same column key the spreadsheet uses, and each derived column follows its formula.

interface NpcSbuRow {
  sbu: string;
  budget: number;
  committed: number;
  actual: number;
  forecastAnnual: number;
}
interface NpcReport {
  fiscalYear: number;
  asOfMonth: number;
  rows: NpcSbuRow[];
}

interface ReportLine {
  label: string;
  a: number; // ORIGINAL BOARD
  b: number; // ADDITIONAL / REDUCTION
  c: number; // TOTAL BOARD APPROVED = A + B
  d: number; // ACTUAL
  e: number; // COMMITTED (open PR PO)
  f: number; // ALLOTTED = D + E
  h: number; // REMAINING vs allotted = C - F
  j: number; // 2026 FORECAST
  k: number; // BALANCE = C - J
}

const fmt = (n: number) => {
  if (Math.abs(n) < 0.5) return "0";
  const body = Math.round(Math.abs(n)).toLocaleString(undefined, { maximumFractionDigits: 0 });
  return n < 0 ? `(${body})` : body;
};
const pct = (value: number, base: number) => (Math.abs(base) < 0.5 ? "0%" : `${Math.round((value / base) * 100)}%`);

function toLine(label: string, r: { budget: number; committed: number; actual: number; forecastAnnual: number }): ReportLine {
  const a = r.budget;
  const b = 0;
  const c = a + b;
  const d = r.actual;
  const e = r.committed;
  const f = d + e;
  return { label, a, b, c, d, e, f, h: c - f, j: r.forecastAnnual, k: c - r.forecastAnnual };
}

const HEAD = "bg-[#1e6b3d] text-white";
const SUB = "bg-[#3f8a5c] text-white";
const CELL = "border border-emerald-200 px-2 py-1 text-right tabular-nums";

export function NpcReportPage() {
  const { forecastYear } = useFiscalYear();
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "npc-report", forecastYear],
    queryFn: async () => (await api2.get<NpcReport>("/reports/npc-report", { params: { fiscalYear: forecastYear } })).data,
  });

  const labelFor = (sbu: string) => NPC_SBU_OPTIONS.find((o) => o.value === sbu)?.label ?? sbu;
  const lines = data ? data.rows.map((r) => toLine(labelFor(r.sbu), r)) : [];
  const total = lines.reduce(
    (acc, l) => ({ label: "TOTAL", a: acc.a + l.a, b: acc.b + l.b, c: acc.c + l.c, d: acc.d + l.d, e: acc.e + l.e, f: acc.f + l.f, h: acc.h + l.h, j: acc.j + l.j, k: acc.k + l.k }),
    { label: "TOTAL", a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, h: 0, j: 0, k: 0 },
  );

  const renderLine = (l: ReportLine, isTotal: boolean) => (
    <tr key={l.label} className={isTotal ? "bg-[#edf6f1] font-semibold text-[#164b33]" : ""}>
      <td className={`border border-emerald-200 px-2 py-1 text-left ${isTotal ? "" : "uppercase"}`}>{l.label}</td>
      <td className={CELL}>{fmt(l.a)}</td>
      <td className={CELL}>{Math.abs(l.b) < 0.5 ? "-" : fmt(l.b)}</td>
      <td className={CELL}>{fmt(l.c)}</td>
      <td className={CELL}>{fmt(l.d)}</td>
      <td className={CELL}>{fmt(l.e)}</td>
      <td className={CELL}>{fmt(l.f)}</td>
      <td className={CELL}>{pct(l.f, l.c)}</td>
      <td className={CELL}>{fmt(l.h)}</td>
      <td className={CELL}>{pct(l.h, l.c)}</td>
      <td className={CELL}>{fmt(l.j)}</td>
      <td className={CELL}>{fmt(l.k)}</td>
      <td className={CELL}>{pct(l.k, l.c)}</td>
    </tr>
  );

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">NPC Report</h1>
          <p className="text-xs text-slate-500">Fiscal year {forecastYear} · Amounts in PHP</p>
        </div>
      </div>

      {isLoading && <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading NPC report…</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">Could not load the NPC report.</div>}

      {data && (
        <div className="overflow-x-auto rounded-lg border border-emerald-200 bg-white shadow-sm">
          <table className="w-full min-w-max border-collapse text-xs">
            <thead>
              <tr className={HEAD}>
                <th rowSpan={2} className="border border-emerald-200 px-2 py-1.5 text-left">SBU</th>
                <th rowSpan={2} className="border border-emerald-200 px-2 py-1.5 text-right">ORIGINAL BOARD</th>
                <th rowSpan={2} className="border border-emerald-200 px-2 py-1.5 text-right">ADDITIONAL/<br />REDUCTION</th>
                <th rowSpan={2} className="border border-emerald-200 px-2 py-1.5 text-right">TOTAL BOARD<br />APPROVED</th>
                <th rowSpan={2} className="border border-emerald-200 px-2 py-1.5 text-right">ACTUAL</th>
                <th rowSpan={2} className="border border-emerald-200 px-2 py-1.5 text-right">COMMITTED<br />(open PR PO)</th>
                <th colSpan={2} className="border border-emerald-200 px-2 py-1.5 text-center">ALLOTTED</th>
                <th colSpan={2} className="border border-emerald-200 px-2 py-1.5 text-center">REMAINING (vs Allotted)</th>
                <th rowSpan={2} className="border border-emerald-200 px-2 py-1.5 text-right">{forecastYear} FORECAST</th>
                <th colSpan={2} className="border border-emerald-200 px-2 py-1.5 text-center">BALANCE</th>
              </tr>
              <tr className={SUB}>
                <th className="border border-emerald-200 px-2 py-1 text-right font-medium">PHP</th>
                <th className="border border-emerald-200 px-2 py-1 text-right font-medium">%</th>
                <th className="border border-emerald-200 px-2 py-1 text-right font-medium">PHP</th>
                <th className="border border-emerald-200 px-2 py-1 text-right font-medium">%</th>
                <th className="border border-emerald-200 px-2 py-1 text-right font-medium">PHP</th>
                <th className="border border-emerald-200 px-2 py-1 text-right font-medium">%</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => renderLine(l, false))}
              {renderLine(total, true)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
