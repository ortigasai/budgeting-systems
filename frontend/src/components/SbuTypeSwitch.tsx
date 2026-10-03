import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

// DOE, Commission, Revenue, Cost of Sales, Depreciation & Amortization and
// Interest Expense are all the same kind of submission (SBU + Company upload
// template), so the sidebar has ONE entry ("SBU Budget") and this switch, at
// the top of that page, picks which of the six you're working on.
//
// `category`/`apiPath` are only set for the categories that go through the
// generic batch flow (SbuBatchUploadTab.tsx / backend's createSbuBatchRouter
// - see approvalChain.ts's SBU_BATCH_CATEGORIES). Revenue predates that
// generalization and keeps its own dedicated component/router
// (RevenueRequestTab.tsx/revenueBatches.ts), so it has neither.
export const SBU_TYPES = [
  { key: "DOE", tab: "doe", label: "DOE", access: "doe", category: "DOE", apiPath: "doe-batches" },
  { key: "COMMISSION", tab: "commission", label: "Commission", access: "commission", category: "COMMISSION", apiPath: "commission-batches" },
  { key: "REVENUE", tab: "revenue", label: "Revenue", access: "revenue" },
  { key: "COS", tab: "cos", label: "Cost of Sales", access: "cos", category: "COST_OF_SALES", apiPath: "cost-of-sales-batches" },
  { key: "DA", tab: "da", label: "Depreciation & Amortization", access: "da", category: "DEPRECIATION_AMORTIZATION", apiPath: "depreciation-amortization-batches" },
  { key: "INTEREST", tab: "interest", label: "Interest Expense", access: "interest", category: "INTEREST_EXPENSE", apiPath: "interest-expense-batches" },
] as const;

// Every SBU-batch-flow category (i.e. all of the above except Revenue).
export const SBU_BATCH_TYPES = SBU_TYPES.filter((t) => t.key !== "REVENUE");

export function SbuTypeSwitch({ mode, current }: { mode: "forecast" | "request"; current: string | null }) {
  const { gate } = useAuth();
  const prefix = mode === "forecast" ? "forecast" : "request";
  const allowed = SBU_TYPES.filter((t) => gate(`${prefix}.${t.access}`, mode === "request" && (t.key === "DOE" || t.key === "REVENUE")));
  return (
    <div className="flex flex-wrap gap-2">
      {allowed.map((t) => {
        const active = current === (mode === "forecast" ? t.key : t.tab);
        return (
          <Link
            key={t.key}
            to={mode === "forecast" ? `/forecast?category=${t.key}` : `/requests/new?tab=${t.tab}`}
            className={`rounded-full px-3 py-1 text-xs font-medium ${active ? "bg-emerald-800 text-white" :"bg-slate-100 text-slate-600 hover:bg-emerald-50"}`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
