import { useSearchParams } from "react-router-dom";
import { ExpenseLineItemsTab } from "./ExpenseLineItemsTab";
import { GrowthRateTab } from "./GrowthRateTab";
import { ThresholdsTab } from "./ThresholdsTab";
import { ReasonCodesTab } from "./ReasonCodesTab";
import { RoleAssignmentsTab } from "./RoleAssignmentsTab";
import { SbuRoleAssignmentsTab } from "./SbuRoleAssignmentsTab";
import { IoLocationsTab } from "./IoLocationsTab";
import { CcGlCodesTab } from "./CcGlCodesTab";
import { ReportAccessTab } from "./ReportAccessTab";
import { PeriodSignOffTab } from "./PeriodSignOffTab";
import { DepartmentSbuTab } from "./DepartmentSbuTab";
import { StageDueDatesTab } from "./StageDueDatesTab";
import { BudgetCycleTab } from "./BudgetCycleTab";
import { BudgetCodesTab } from "./BudgetCodesTab";
import { ForecastCategoryMappingsTab } from "./ForecastCategoryMappingsTab";
import { ManpowerGlCcTab } from "./ManpowerGlCcTab";
import { NpcMonitoringImportTab } from "./NpcMonitoringImportTab";
import { GaePastDataImportTab } from "./GaePastDataImportTab";
import { SapSyncStatusTab } from "./SapSyncStatusTab";
import { AccessControlTab } from "./AccessControlTab";

// Shared with Layout.tsx's AdminConsoleSidebarNav, which renders this same
// list as real `?tab=` links in the leftmost sidebar, grouped by `group`
// (spec: "place the sidebar to the leftmost part of the page - same as the
// other sidebars in other modules") - exported from here so the two never
// drift apart. `group` classifies each tab by which module's data it
// actually edits (checked against each tab's own API calls/comments, not
// guessed from its label) - "General" is for a tab that's genuinely
// cross-module (applies to more than one, or the whole app) rather than
// owned by one.
export const ADMIN_GROUPS = ["General", "GAE", "DOE", "NPC", "Transfers", "Manpower", "Reports"] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

export const ADMIN_TABS = [
  { id: "budget-cycle", label: "Budget Cycle", group: "General" },
  { id: "due-dates", label: "Stage Due Dates", group: "General" },
  // Feeds Forecast GAE/DOE, Manpower, Utilization/Transfer/Dash Flow/Reports
  // all at once - not one module's.
  { id: "sap-sync-status", label: "SAP Sync Status", group: "General" },
  // Spans GAE's CENTRALIZED_DEPARTMENT prefix and NPC's NPC_HEAD prefix.
  { id: "budget-codes", label: "Budget Codes", group: "General" },
  // Classifies Forecast rows across GAE/DOE/NPC/Revenue - not one module's.
  { id: "forecast-categories", label: "Forecast Categories", group: "General" },
  { id: "reason-codes", label: "Reason Codes", group: "General" },
  { id: "roles", label: "Role Assignments", group: "General" },
  { id: "access-control", label: "Access Control", group: "General" },
  // Assigns each Department to an NPC SBU, which also scopes Utilization's
  // NPC view - spans two modules, not owned by either alone.
  { id: "department-sbu", label: "Department SBU", group: "General" },
  { id: "expense-items", label: "Expense Line Items", group: "GAE" },
  { id: "gae-past-data", label: "GAE Past Years Data", group: "GAE" },
  { id: "growth-rate", label: "Growth Rate", group: "GAE" },
  { id: "thresholds", label: "Thresholds", group: "GAE" },
  { id: "sbu-roles", label: "SBU Roles", group: "DOE" },
  { id: "npc-monitoring", label: "NPC Monitoring Import", group: "NPC" },
  { id: "io-locations", label: "IO Locations", group: "Transfers" },
  { id: "cc-gl-codes", label: "CC-GL Codes", group: "Transfers" },
  { id: "manpower-gl-cc", label: "Manpower GL/CC Mapping", group: "Manpower" },
  { id: "report-access", label: "Report Access", group: "Reports" },
  { id: "period-sign-off", label: "Period Sign-off", group: "Reports" },
] as const;

export type AdminTabId = (typeof ADMIN_TABS)[number]["id"];

// The sidebar itself now lives in Layout.tsx (AdminConsoleSidebarNav), same
// as every other module's - this page just reads `?tab=` to pick which
// section renders, same `?view=`/`?category=` pattern already used by
// Transfers/Forecast/Step5. No banner header here either (removed per
// request) - the green top bar's "Admin Console" label is enough context.
export function AdminConsolePage() {
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: AdminTabId = (ADMIN_TABS.find((t) => t.id === tabParam)?.id ?? "expense-items") as AdminTabId;

  return (
    <div className="space-y-4">
      {tab === "sap-sync-status" && <SapSyncStatusTab />}
      {tab === "expense-items" && <ExpenseLineItemsTab />}
      {tab === "budget-codes" && <BudgetCodesTab />}
      {tab === "forecast-categories" && <ForecastCategoryMappingsTab />}
      {tab === "growth-rate" && <GrowthRateTab />}
      {tab === "thresholds" && <ThresholdsTab />}
      {tab === "reason-codes" && <ReasonCodesTab />}
      {tab === "roles" && <RoleAssignmentsTab />}
      {tab === "access-control" && <AccessControlTab />}
      {tab === "sbu-roles" && <SbuRoleAssignmentsTab />}
      {tab === "io-locations" && <IoLocationsTab />}
      {tab === "cc-gl-codes" && <CcGlCodesTab />}
      {tab === "npc-monitoring" && <NpcMonitoringImportTab />}
      {tab === "gae-past-data" && <GaePastDataImportTab />}
      {tab === "manpower-gl-cc" && <ManpowerGlCcTab />}
      {tab === "department-sbu" && <DepartmentSbuTab />}
      {tab === "report-access" && <ReportAccessTab />}
      {tab === "period-sign-off" && <PeriodSignOffTab />}
      {tab === "due-dates" && <StageDueDatesTab />}
      {tab === "budget-cycle" && <BudgetCycleTab />}
    </div>
  );
}
