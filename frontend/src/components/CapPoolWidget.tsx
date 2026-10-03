import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useFiscalYear } from "../lib/fiscalCycle";
import { SBU_TYPES } from "./SbuTypeSwitch";

interface CapPoolResult {
  value: number;
  actualsYtd2026: number;
  remainingForecast2026: number;
  growthRateUsed: number;
  totalPortalRequests: number;
  remainingPool: number;
}

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// FR-1.6 — Cap / Remaining Pool, recomputed live every time this widget is
// shown (React Query refetches on mount/focus rather than a websocket push).
export function CapPoolWidget({ departmentId, fiscalYear }: { departmentId: string; fiscalYear?: number }) {
  const { targetYear } = useFiscalYear();
  fiscalYear ??= targetYear;
  const { gate } = useAuth();
  const canViewForecast =
    gate("forecast.gae", true) ||
    SBU_TYPES.some((t) => gate(`forecast.${t.access}`, t.key === "DOE" || t.key === "REVENUE")) ||
    gate("forecast.npc", true) ||
    gate("forecast.commission", false) ||
    gate("forecast.cos", false) ||
    gate("forecast.da", false) ||
    gate("forecast.interest", false);
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", departmentId, fiscalYear],
    queryFn: async () => (await api.get<CapPoolResult>(`/dashboard/${departmentId}?fiscalYear=${fiscalYear}`)).data,
  });

  if (isLoading || !data) {
    return <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400">Loading…</div>;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {/* value = (actualsYtd2026 + remainingForecast2026) * (1 + growthRate / 100) — see budgetCalcService.ts */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-slate-800">
        <div className="text-xs font-semibold tracking-wide opacity-70">{fiscalYear} Departmental Budget Cap</div>
        <div className="mt-1 text-lg font-bold">{peso(data.value)}</div>
        <div className="mt-1.5 text-[11px] leading-snug text-slate-500">
          ({peso(data.actualsYtd2026)} YTD Actuals + {peso(data.remainingForecast2026)} Remaining Forecast) ×{""}
          {(1 + data.growthRateUsed / 100).toFixed(2)} ({data.growthRateUsed}% growth)
        </div>
        {canViewForecast && (
          <Link to={`/forecast?category=GAE&departmentId=${departmentId}`} className="mt-1.5 inline-block text-[11px] font-semibold text-emerald-700 hover:underline">
            View Forecast →
          </Link>
        )}
      </div>
      <Stat label={`${fiscalYear} Portal Requests`} value={peso(data.totalPortalRequests)} tone="blue" />
      <Stat label="Remaining Departmental Pool" value={peso(data.remainingPool)} tone={data.remainingPool < 0 ? "red" : "emerald"} />
      <Stat label="Growth Rate Used" value={`${data.growthRateUsed}%`} tone="amber" />
    </div>
  );
}

const TONES = {
  slate: "border-slate-200 bg-slate-50 text-slate-800",
  blue: "border-blue-200 bg-blue-50 text-blue-800",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  red: "border-red-200 bg-red-50 text-red-700",
};

function Stat({ label, value, tone }: { label: string; value: string; tone: keyof typeof TONES }) {
  return (
    <div className={`rounded-lg border p-3 ${TONES[tone]}`}>
      <div className="text-xs font-semibold tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-lg font-bold">{value}</div>
    </div>
  );
}
