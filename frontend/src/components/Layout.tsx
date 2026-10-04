import { useLayoutEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, downloadFile, type BudgetRequest, type Department } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { SBU_TYPES } from "./SbuTypeSwitch";
import { RoleSwitcher } from "./RoleSwitcher";
import { UserMenu } from "./UserMenu";
import { phaseForPath } from "../lib/phases";
import { sfSbus } from "../lib/groupScope";
import { useFiscalYear } from "../lib/fiscalCycle";
import { ADMIN_GROUPS, ADMIN_TABS } from "../pages/admin/AdminConsolePage";

const linkClass = ({ isActive }: { isActive: boolean }) => `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? "bg-emerald-700 text-white shadow-sm shadow-emerald-700/30" : "text-slate-600 hover:bg-emerald-50 hover:text-emerald-900"}`;

const subLinkClass = (active: boolean) => `rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors ${active ? "bg-emerald-100 text-emerald-900" : "text-slate-600 hover:bg-emerald-50 hover:text-emerald-900"}`;

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.75} stroke="currentColor" className="h-[18px] w-[18px] shrink-0">
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

const ICONS = {
  home: "M3 11.5 12 4l9 7.5M5.5 10v9a1 1 0 0 0 1 1H9.5v-6h5v6H17.5a1 1 0 0 0 1-1v-9",
  newRequest: "M12 5v14M5 12h14",
  myRequests: "M6 3.5h9l3 3V20a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5ZM9 9.5h6M9 13h6M9 16.5h4",
  inbox: "M3.5 12h4l1.5 3h6l1.5-3h4M3.5 12 5 5.5a1 1 0 0 1 1-.8h12a1 1 0 0 1 1 .8L20.5 12M3.5 12v6a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-6",
  forecast: "M4 19V9.5m5 9.5V5m5 14v-7m5 7V11M4 19h16",
  utilization: "M12 3v9l7.79 4.5A9 9 0 1 0 12 3Z",
  manpower: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 20c0-3 2.5-5.5 5.5-5.5S14.5 17 14.5 20M17 11a2.5 2.5 0 1 0 0-5M20.5 20c0-2.5-1.8-4.5-4-5",
  step5: "M4 20V10m6 10V4m6 16v-7m6 7V13",
  capex: "M4 8.5 12 4l8 4.5V19a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5V8.5ZM9 19v-6h6v6",
  revenue: "M3 17h4l3-9 4 12 3-9h4",
  reports: "M9 4.5h6l3 3V19a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 19V5a.5.5 0 0 1 .5-.5H9ZM9 10.5h6M9 14h6M9 17.5h3.5",
  approvedBudget: "M9 12.5l2 2 4-4.5M6 3.5h9l3 3V20a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z",
  dashFlow: "M4 6h16M4 12h10M4 18h7M17 15l3 3-3 3",
};

// Budget Report & Analysis's own menu: each item is a view of the same Reports page
// (or the separate 5-Year Trend page). Active state comes from the URL, not NavLink's path match.
const REPORT_GROUPS: { title: string; items: { id: string; label: string; to: string }[] }[] = [
  {
    title: "GAE",
    items: [
      { id: "budget-actual", label: "Budget, Actual, Forecast YTD/Annual Comparisons", to: "/reports?comparison=budget-actual" },
      { id: "yoy-actual", label: "Last Year Comparisons", to: "/reports?comparison=yoy-actual" },
      { id: "monthly-comparison", label: "Monthly Comparisons", to: "/reports?comparison=monthly-comparison" },
      { id: "quarterly-comparison", label: "Quarterly Comparisons", to: "/reports?comparison=quarterly-comparison" },
      { id: "trend", label: "5-Year Trend", to: "/reports/trend" },
    ],
  },
  {
    title: "NPC",
    items: [{ id: "npc", label: "NPC Report", to: "/reports/npc" }],
  },
];

function ReportNavItem({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <NavLink to={to} className={() => `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${active ? "bg-emerald-700 text-white shadow-sm shadow-emerald-700/30" : "text-slate-600 hover:bg-emerald-50 hover:text-emerald-900"}`}>
      {children}
    </NavLink>
  );
}

function NavItem({ to, end, icon, children }: { to: string; end?: boolean; icon: keyof typeof ICONS; children: ReactNode }) {
  return (
    <NavLink to={to} end={end} className={linkClass}>
      <Icon path={ICONS[icon]} />
      {children}
    </NavLink>
  );
}

// Notes_7/10: "Make the sub-menu collapsible"/"hide the sub-menu by
// default. just show them when the arrow is clicked." The parent link still
// navigates as before; a separate chevron button toggles the sub-menu's
// visibility so the two actions don't fight each other. Starts collapsed,
// unless the caller already knows you're inside this section (defaultOpen)
// - e.g. landing directly on /requests/new should show its sub-menu right
// away instead of making you click the chevron to see where you are.
function CollapsibleNavGroup({ to, icon, label, defaultOpen, children }: { to: string; icon: keyof typeof ICONS; label: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  // The sidebar persists across client-side navigation (Layout doesn't
  // remount), so a plain useState initializer only catches the very first
  // page load. Re-opening whenever defaultOpen flips true - i.e. whenever
  // you navigate INTO this section from elsewhere - covers every landing,
  // not just the first. Doesn't fight a manual collapse: defaultOpen stays
  // true the whole time you're in the section, so the effect doesn't fire
  // again just because you closed it. useLayoutEffect (not useEffect) so
  // this commits before the browser paints - an effect would let the stale
  // "collapsed" frame flash on screen for one tick after every navigation
  // into the section, since it only runs after paint.
  useLayoutEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <div>
      <div className="flex items-center gap-0.5">
        <div className="min-w-0 flex-1">
          <NavItem to={to} icon={icon}>
            {label}
          </NavItem>
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} className="shrink-0 rounded p-1.5 text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-700">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
          </svg>
        </button>
      </div>
      {open && children}
    </div>
  );
}

function NewRequestSubMenu() {
  const [searchParams] = useSearchParams();
  const currentTab = searchParams.get("tab");
  const { gate, currentUser, hasRole } = useAuth();
  const sbuAllowed = sfSbus(currentUser, hasRole("BUDGET_OFFICER"));
  const noSbuScope = Array.isArray(sbuAllowed) && sbuAllowed.length === 0;

  return (
    <div className="ml-7 mt-1 flex flex-col gap-0.5 border-l border-emerald-100 pl-3">
      {gate("request.gae", true) && (
        <NavLink to="/requests/new?tab=standard" className={subLinkClass(currentTab === "standard")}>
          General &amp; Administrative Expenses (GAE)
        </NavLink>
      )}
      {!noSbuScope && SBU_TYPES.some((t) => gate(`request.${t.access}`, t.key === "DOE" || t.key === "REVENUE")) && (
        <NavLink
          to={`/requests/new?tab=${SBU_TYPES.find((t) => gate(`request.${t.access}`, t.key === "DOE" || t.key === "REVENUE"))!.tab}`}
          className={subLinkClass(SBU_TYPES.some((t) => t.tab === currentTab))}
        >
          SBU Budget (Upload Template)
        </NavLink>
      )}
      {gate("request.npc", true) && (
        <NavLink to="/requests/new?tab=npc" className={subLinkClass(currentTab === "npc")}>
          Non-Project Capex (NPC)
        </NavLink>
      )}
      {gate("request.headcount", true) && (
        <NavLink to="/requests/new?tab=headcount" className={subLinkClass(currentTab === "headcount")}>
          Additional Manpower
        </NavLink>
      )}
    </div>
  );
}

function ManpowerSubMenu() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const isDashboardActive = location.pathname === "/manpower";
  const [uploadStatus, setUploadStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const { targetYear: MANPOWER_FISCAL_YEAR } = useFiscalYear();

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("fiscalYear", String(MANPOWER_FISCAL_YEAR));
      try {
        return (await api.post("/manpower/headcount-salary-template-upload", form)).data;
      } catch (err: any) {
        if (err.response?.status === 400 && err.response.data?.errors) return err.response.data;
        throw err;
      }
    },
    onSuccess: (data) => {
      if (data.ok === false) {
        setUploadStatus({ ok: false, message: `${data.errors.length} row(s) rejected - fix and re-upload.` });
      } else {
        setUploadStatus({
          ok: true,
          message: `Uploaded: ${data.levelsUpdated} rank(s), ${data.companiesUpdated} compan${data.companiesUpdated === 1 ? "y" : "ies"}.`,
        });
        ["manpower-grid", "manpower-submission", "manpower-merit-rate", "manpower-dashboard-summary"].forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }));
      }
    },
  });

  return (
    <div className="ml-7 mt-1 flex flex-col gap-0.5 border-l border-emerald-100 pl-3">
      <NavLink to="/manpower" className={subLinkClass(isDashboardActive)}>
        Dashboard
      </NavLink>
      <button
        type="button"
        onClick={() =>
          downloadFile(`/manpower/headcount-salary-template?fiscalYear=${MANPOWER_FISCAL_YEAR}`, `headcount-salary-template-${MANPOWER_FISCAL_YEAR}.xlsx`).catch(() =>
            setUploadStatus({ ok: false, message: "Failed to download the template." })
          )
        }
        className={`border-0 bg-transparent ${subLinkClass(false)}`}
      >
        Download Headcount & Salary Template
      </button>
      <label className={`cursor-pointer ${subLinkClass(false)}`}>
        Upload Headcount & Salary Template
        <input
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            setUploadStatus(null);
            if (e.target.files?.[0]) uploadMutation.mutate(e.target.files[0]);
          }}
        />
      </label>
      {uploadStatus && <div className={`px-2 text-[11px] leading-snug ${uploadStatus.ok ? "text-emerald-700" : "text-red-600"}`}>{uploadStatus.message}</div>}
    </div>
  );
}

// Notes_9: "Move GAE, DOE and Revenue to sub-menu bar" — was a row of
// buttons at the top of Step5DashboardPage; now a real sub-menu like New
// Request's, driven by the same `?category=` query param the page already
// reads. NPC was added later, treated like GAE (a flat board-approved
// figure, no SBU breakdown) since its own breakdown dimension is Head, not
// SBU - a separate concept not tracked per-Head here.
// A small red count next to a sub-menu link, same style as Inbox/Budget
// Finalization's own badges - 0/missing renders nothing.
function SubLinkBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="ml-1.5 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">{count}</span>;
}

function Step5SubMenu() {
  const [searchParams] = useSearchParams();
  const currentCategory = searchParams.get("category");

  // Same query key/cache entry Layout's own step5PendingCount and
  // Step5DashboardPage.tsx already use (TanStack Query dedupes the network
  // call) - broken down per category here instead of one combined total, so
  // each link shows its own pending count rather than lumping all 7
  // categories into the parent group's badge. Revenue has no count here -
  // it's a separate model/workflow (RevenueBatchSummary, reviewed via
  // Inbox's own RevenueBatchInboxSection) that step5-dashboard doesn't cover.
  const { data: step5Requests = [] } = useQuery({
    queryKey: ["step5-dashboard"],
    queryFn: async () => (await api.get<BudgetRequest[]>("/budget-requests/step5-dashboard")).data,
  });
  const countFor = (category: string) => step5Requests.filter((r) => r.requestCategory === category).length;

  return (
    <div className="ml-7 mt-1 flex flex-col gap-0.5 border-l border-emerald-100 pl-3">
      <NavLink to="/step5?category=GAE" className={subLinkClass(currentCategory === "GAE")}>
        General &amp; Administrative Expenses (GAE)
        <SubLinkBadge count={countFor("GAE")} />
      </NavLink>
      <NavLink to="/step5?category=DOE" className={subLinkClass(currentCategory === "DOE")}>
        Direct Operating Expenses (DOE)
        <SubLinkBadge count={countFor("DOE")} />
      </NavLink>
      <NavLink to="/step5?category=COMMISSION" className={subLinkClass(currentCategory === "COMMISSION")}>
        Commission
        <SubLinkBadge count={countFor("COMMISSION")} />
      </NavLink>
      <NavLink to="/step5?category=COST_OF_SALES" className={subLinkClass(currentCategory === "COST_OF_SALES")}>
        Cost of Sales
        <SubLinkBadge count={countFor("COST_OF_SALES")} />
      </NavLink>
      <NavLink to="/step5?category=DEPRECIATION_AMORTIZATION" className={subLinkClass(currentCategory === "DEPRECIATION_AMORTIZATION")}>
        Depreciation &amp; Amortization
        <SubLinkBadge count={countFor("DEPRECIATION_AMORTIZATION")} />
      </NavLink>
      <NavLink to="/step5?category=INTEREST_EXPENSE" className={subLinkClass(currentCategory === "INTEREST_EXPENSE")}>
        Interest Expense
        <SubLinkBadge count={countFor("INTEREST_EXPENSE")} />
      </NavLink>
      <NavLink to="/step5?category=NPC" className={subLinkClass(currentCategory === "NPC")}>
        Non-Project Capex (NPC)
        <SubLinkBadge count={countFor("NPC")} />
      </NavLink>
      <NavLink to="/step5?category=REVENUE" className={subLinkClass(currentCategory === "REVENUE")}>
        Revenue
      </NavLink>
      <NavLink to="/step5/finalized-budget" className={({ isActive }) => subLinkClass(isActive)}>
        Finalized Budget Report
      </NavLink>
    </div>
  );
}

// Forecast's GAE/DOE/NPC/Revenue sub-menu — same `?category=` pattern as
// Step5SubMenu above, but with NPC included (Finalization never had it).
function ForecastSubMenu() {
  const [searchParams] = useSearchParams();
  const currentCategory = searchParams.get("category");
  const { gate } = useAuth();

  return (
    <div className="ml-7 mt-1 flex flex-col gap-0.5 border-l border-emerald-100 pl-3">
      {gate("forecast.gae", true) && (
        <NavLink to="/forecast?category=GAE" className={subLinkClass(currentCategory === "GAE")}>
          General &amp; Administrative Expenses (GAE)
        </NavLink>
      )}
      {SBU_TYPES.some((t) => gate(`forecast.${t.access}`, false)) && (
        <NavLink
          to={`/forecast?category=${SBU_TYPES.find((t) => gate(`forecast.${t.access}`, false))!.key}`}
          className={subLinkClass(SBU_TYPES.some((t) => t.key === currentCategory))}
        >
          SBU Budget (Upload Template)
        </NavLink>
      )}
      {gate("forecast.npc", true) && (
        <NavLink to="/forecast?category=NPC" className={subLinkClass(currentCategory === "NPC")}>
          Non-Project Capex (NPC)
        </NavLink>
      )}
    </div>
  );
}

// Phase 3's New Transfer/My Transfers/Inbox sidebar nav. Not built from the
// generic NavItem/linkClass (NavLink's own isActive matches by pathname
// only, ignoring the query string, so all three would light up together
// since they all share /transfers) - same reasoning as ForecastSubMenu/
// Step5SubMenu already reading `?category=` manually instead of relying on
// NavLink's isActive.
//
// "New Transfer" no longer carries a GAE/DOE sub-menu (the workflow revision
// replaced that classification concept - SBU is now a field on the New
// Transfer form itself), so this is a plain 3-link list.
function TransferSidebarNav() {
  const { gate } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const view = searchParams.get("view");
  const isTransfersPath = location.pathname === "/transfers";
  const isNewActive = isTransfersPath && !view;

  return (
    <>
      {gate("transfer.new", true) && (
        <Link to="/transfers" className={linkClass({ isActive: isNewActive })}>
          <Icon path={ICONS.newRequest} />
          New Transfer
        </Link>
      )}
      {gate("transfer.mine", true) && (
        <Link to="/transfers?view=mine" className={linkClass({ isActive: isTransfersPath && view === "mine" })}>
          <Icon path={ICONS.myRequests} />
          My Transfers
        </Link>
      )}
      {gate("transfer.inbox", true) && (
        <Link to="/transfers?view=inbox" className={linkClass({ isActive: isTransfersPath && view === "inbox" })}>
          <Icon path={ICONS.inbox} />
          Inbox
        </Link>
      )}
    </>
  );
}

// Internal Order Request sidebar nav (spec item 8) - a separate feature from
// Transfer (own model/router), given its own New/Mine/Inbox trio at
// /internal-orders following the identical pattern above.
function InternalOrderSidebarNav() {
  const { gate } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const view = searchParams.get("view");
  const isIoPath = location.pathname === "/internal-orders";

  return (
    <>
      {gate("io.new", true) && (
        <Link to="/internal-orders" className={linkClass({ isActive: isIoPath && !view })}>
          <Icon path={ICONS.newRequest} />
          New Internal Order Request
        </Link>
      )}
      {gate("io.mine", true) && (
        <Link to="/internal-orders?view=mine" className={linkClass({ isActive: isIoPath && view === "mine" })}>
          <Icon path={ICONS.myRequests} />
          My Internal Order Requests
        </Link>
      )}
      {gate("io.inbox", true) && (
        <Link to="/internal-orders?view=inbox" className={linkClass({ isActive: isIoPath && view === "inbox" })}>
          <Icon path={ICONS.inbox} />
          Inbox
        </Link>
      )}
    </>
  );
}

// Note 11 §5 - Dash Flow Budget Check, gated the same way Approved Budget is
// (any SBU Finance role, or Budget Officer for all SBUs) - access is
// re-checked server-side regardless.
function DashFlowSidebarNav() {
  return (
    <NavItem to="/dash-flow" end icon="dashFlow">
      Dash Flow Budget Check
    </NavItem>
  );
}

// Spec item 17: Phase 2's two GAE/DOE views (previously an in-page TabBar -
// see UtilizationPage.tsx) move into the sidebar, grouped under "Operating
// Expenses" since they share one department picker; NPC gets its own flat
// entry since it's scoped by SBU instead. `?view=` read manually (not
// CollapsibleNavGroup/NavLink's own isActive) for the same reason as
// TransferSidebarNav above - every view shares the /utilization pathname.
function UtilizationSidebarNav() {
  const { gate } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const view = searchParams.get("view");
  const isUtilizationPath = location.pathname === "/utilization";
  const isOperatingExpensesActive = isUtilizationPath && view !== "npc";
  const [open, setOpen] = useState(true);
  useLayoutEffect(() => {
    if (isOperatingExpensesActive) setOpen(true);
  }, [isOperatingExpensesActive]);

  return (
    <>
      {(gate("util.overview", true) || gate("util.reconciliation", true)) && (
      <div>
        <div className="flex items-center gap-0.5">
          <div className="min-w-0 flex-1">
            <Link to="/utilization" className={linkClass({ isActive: isOperatingExpensesActive })}>
              <Icon path={ICONS.utilization} />
              Operating Expenses (GAE &amp; DOE)
            </Link>
          </div>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"} aria-expanded={open} className="shrink-0 rounded p-1.5 text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-700">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} stroke="currentColor" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
        {open && (
          <div className="ml-7 mt-1 flex flex-col gap-0.5 border-l border-emerald-100 pl-3">
            {gate("util.overview", true) && (
              <Link to="/utilization" className={subLinkClass(isOperatingExpensesActive && !view)}>
                Departmental Overview
              </Link>
            )}
            {gate("util.reconciliation", true) && (
              <Link to="/utilization?view=reconciliation" className={subLinkClass(isOperatingExpensesActive && view === "reconciliation")}>
                Live Reconciliation
              </Link>
            )}
          </div>
        )}
      </div>
      )}
      {gate("util.npc", true) && (
        <Link to="/utilization?view=npc" className={linkClass({ isActive: isUtilizationPath && view === "npc" })}>
          <Icon path={ICONS.capex} />
          Non-Project Capex (NPC)
        </Link>
      )}
    </>
  );
}

// Admin Console's sidebar (spec: "place the sidebar to the leftmost part of
// the page - same as the other sidebars in other modules") - `?tab=` links
// grouped by module (ADMIN_GROUPS order), same manual-active-state pattern
// as TransferSidebarNav above, reading the shared ADMIN_TABS list so this
// never drifts from what AdminConsolePage itself renders. "General" holds
// whatever's genuinely cross-module rather than owned by one - it applies
// across every module, not just the ones with their own section here.
function AdminConsoleSidebarNav() {
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab = ADMIN_TABS.find((t) => t.id === tabParam)?.id ?? "expense-items";

  return (
    <>
      {ADMIN_GROUPS.map((group) => {
        const tabs = ADMIN_TABS.filter((t) => t.group === group);
        if (tabs.length === 0) return null;
        return (
          <div key={group} className="mt-3 first:mt-0">
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group}</div>
            {tabs.map((t) => (
              <Link key={t.id} to={`/admin?tab=${t.id}`} className={linkClass({ isActive: activeTab === t.id })}>
                {t.label}
              </Link>
            ))}
          </div>
        );
      })}
    </>
  );
}

export function Layout() {
  const { currentUser, hasRole, hasSbuRole, gate } = useAuth();
  const location = useLocation();
  // The root route is the post-login phase menu (PhaseMenuPage), not inside
  // any one phase yet - the phase-specific nav below doesn't make sense
  // until a phase is chosen, so it's hidden there instead of pointing at
  // pages the user hasn't navigated into.
  const isAtPhaseMenu = location.pathname === "/";
  // Admin Console (spec item 10) lives outside the module system entirely -
  // reached from its own landing-page link, not nested in any module's
  // sidebar - so it gets neither a module's sidebar nor its top-bar title
  // below, same treatment as the phase menu itself minus the tile grid.
  const isAdminConsole = location.pathname.startsWith("/admin");
  // Which phase the current route belongs to, shown in the top bar so it's
  // clear at a glance which of the phase menu's tiles you're inside - same
  // PHASES list PhaseMenuPage renders its tiles from, so the title/blurb
  // shown here can never drift from what the menu itself says.
  const currentPhase = phaseForPath(location.pathname);

  const activeReportView = location.pathname === "/reports/trend" ? "trend" : location.pathname === "/reports/npc" ? "npc" : (new URLSearchParams(location.search).get("comparison") ?? "budget-actual");
  const isBudgetOfficer = hasRole("BUDGET_OFFICER");
  const isReviewer = hasRole("DEPARTMENT_HEAD") || hasRole("CENTRALIZED_FIRST_LEVEL_REVIEWER") || hasRole("CENTRALIZED_DEPARTMENT_HEAD") || hasRole("BCA_HEAD") || hasRole("CFO") || isBudgetOfficer;
  // Spec item 16 - Revenue's 4-stage chain reuses BCA_HEAD/BUDGET_OFFICER
  // (already covered by isReviewer) plus Phase 3's two SBU-scoped roles.
  const isRevenueReviewer = isReviewer || hasSbuRole("BU_FINANCE_OFFICER") || hasSbuRole("BU_FINANCE_HEAD");
  // Note 11 §5 - Dash Flow Budget Check gate: any SBU Finance role, or
  // unconditional Budget Officer oversight.
  const canViewDashFlow = isBudgetOfficer || hasSbuRole("BU_FINANCE_OFFICER") || hasSbuRole("BU_FINANCE_HEAD");
  const isHrAnalyst = hasRole("HR_ANALYST");
  const isHrHead = currentUser?.department?.name === "Human Resources" && hasRole("CENTRALIZED_DEPARTMENT_HEAD");

  // Notes_7: "Forecast should be shown on centralized departments' dashboard
  // only" — gated to the same core centralized department list (see
  // backend's lib/coreDepartments.ts) that drives Home's Cap & Pool cards.
  // The Budget Officer always sees it, matching Forecast's own view-access rule.
  const { data: coreDepartments = [] } = useQuery({
    queryKey: ["core-departments"],
    queryFn: async () => (await api.get<Department[]>("/admin/core-departments")).data,
    enabled: !!currentUser,
  });
  const isForecastEligible = isBudgetOfficer || coreDepartments.some((d) => d.id === currentUser?.department?.id);

  // Notes_8: "On the menu bar, put a count of how many tasks are pending for
  // that user." Reuses the same query keys InboxPage.tsx fetches with, so
  // TanStack Query dedupes the network call when both are mounted — this
  // just needs the counts, not the full inbox content.
  const inboxCountQuery = { enabled: !!currentUser, staleTime: 30_000 };
  const { data: budgetInboxCount = 0 } = useQuery({
    queryKey: ["inbox"],
    queryFn: async () => (await api.get<unknown[]>("/budget-requests/inbox")).data,
    select: (data) => data.length,
    ...inboxCountQuery,
  });
  const { data: headcountInboxCount = 0 } = useQuery({
    queryKey: ["additional-headcount-inbox"],
    queryFn: async () => (await api.get<unknown[]>("/additional-headcount/inbox")).data,
    select: (data) => data.length,
    ...inboxCountQuery,
  });
  const { data: forecastInboxCount = 0 } = useQuery({
    queryKey: ["forecast-inbox"],
    queryFn: async () => (await api.get<unknown[]>("/forecast/inbox/pending")).data,
    select: (data) => data.length,
    ...inboxCountQuery,
  });
  const { data: office365InboxCount = 0 } = useQuery({
    queryKey: ["office365-inbox"],
    queryFn: async () => (await api.get<unknown[]>("/additional-headcount/office365-inbox")).data,
    select: (data) => data.length,
    ...inboxCountQuery,
  });
  const { data: mobilePhoneBudgetInboxCount = 0 } = useQuery({
    queryKey: ["mobile-phone-budget-inbox"],
    queryFn: async () => (await api.get<unknown[]>("/additional-headcount/mobile-phone-budget-inbox")).data,
    select: (data) => data.length,
    ...inboxCountQuery,
  });
  const { data: revenueInboxCount = 0 } = useQuery({
    queryKey: ["revenue-batches", "inbox"],
    queryFn: async () => (await api.get<unknown[]>("/revenue-batches/inbox")).data,
    select: (data) => data.length,
    ...inboxCountQuery,
  });
  const pendingCount = budgetInboxCount + headcountInboxCount + forecastInboxCount + office365InboxCount + mobilePhoneBudgetInboxCount + revenueInboxCount;

  // Budget Officer Review requests (GAE/DOE/Commission/Cost of Sales/D&A/
  // Interest Expense/NPC) are deliberately excluded from the generic Inbox
  // above - they're handled through the dedicated Budget Finalization &
  // Upload / Step 5 dashboard instead (see routes/budgetRequests.ts's own
  // /inbox query, which filters BUDGET_OFFICER_REVIEW out). That page had
  // no pending-count indicator of its own, unlike Inbox - same badge style,
  // same reused-query-for-just-the-count pattern as above.
  const { data: step5PendingCount = 0 } = useQuery({
    queryKey: ["step5-dashboard"],
    queryFn: async () => (await api.get<unknown[]>("/budget-requests/step5-dashboard")).data,
    select: (data) => data.length,
    enabled: !!currentUser && isBudgetOfficer,
    staleTime: 30_000,
  });

  if (!currentUser) {
    return (
      <div className="flex min-h-screen flex-col md:flex-row">
        <div className="flex flex-col justify-center gap-10 bg-gradient-to-br from-[#15603a] to-[#052e1a] p-10 text-white md:w-[38%] md:min-w-[320px] md:max-w-[560px]">
          <div>
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white text-2xl font-bold text-emerald-800">₱</div>
            <div className="mt-5 text-2xl font-bold tracking-tight">Budgeting System</div>
            <div className="mt-1 text-sm font-medium tracking-wider text-emerald-200">Ortigas Group</div>
            <p className="mt-6 text-sm leading-relaxed text-emerald-100">Set, track, and report the annual budget in one place.</p>
          </div>
          <div>
            <div className="mb-4 text-xs font-medium text-emerald-300">Modules</div>
            <ol className="space-y-3 text-sm text-emerald-50">
              <li className="flex items-center gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">1</span>Annual Budget Setting</li>
              <li className="flex items-center gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">2</span>Budget Utilization Tracking</li>
              <li className="flex items-center gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">3</span>Budget Transfer &amp; Reallocation</li>
              <li className="flex items-center gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">4</span>Budget Report &amp; Analysis</li>
            </ol>
          </div>
        </div>
        <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-emerald-50 p-8">
          <div className="relative w-full max-w-md rounded-xl border border-emerald-200 bg-white p-8 shadow-sm">
            <RoleSwitcher />
          </div>
        </div>
      </div>
    );
  }

  // One shared green top bar across every logged-in state (phase menu and
  // every phase) - the sidebar below it is nav-only, not a second place
  // carrying the same branding.
  return (
    <div className="flex h-screen flex-col bg-[#f5faf7]">
      <div className="flex shrink-0 items-center justify-between bg-gradient-to-r from-[#15603a] to-[#052e1a] px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15 text-lg font-bold text-white ring-1 ring-white/30">₱</div>
          <div className="leading-tight">
            <div className="text-base font-bold tracking-tight text-white">Budgeting System</div>
            <div className="text-[11px] font-medium tracking-wider text-emerald-100/80">Ortigas Group</div>
          </div>
          {!isAtPhaseMenu && (
            <>
              <div className="h-8 w-px bg-white/20" />
              <div className="text-sm font-semibold text-white/90">{isAdminConsole ? "Admin Console" : currentPhase.title}</div>
            </>
          )}
        </div>
        <UserMenu dark />
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Phase 3's New Transfer/My Transfers/Inbox views use a sidebar with
            flat NavItems, no collapsible wrapper - there's no higher-level
            grouping needed since the whole sidebar already is Phase 3,
            unlike Forecast/New Request which are one group among several
            Phase 1 siblings. Phase 2 (spec item 17) groups its two GAE/DOE
            views under one collapsible "Operating Expenses" entry instead,
            since NPC is scoped differently (by SBU, not department) and
            reads better as its own flat entry - see UtilizationSidebarNav. */}
        {/* Note 12 - Phase 4 has nothing left to navigate to within itself
            (the dashboard's own control bar replaced the old 4-link
            sub-menu), so it gets no sidebar at all now, same as any other
            single-page phase would. */}
        {!isAtPhaseMenu && (isAdminConsole || currentPhase.number === 1 || currentPhase.number === 2 || currentPhase.number === 3 || currentPhase.number === 4) && (
          <aside className="sidebar-dark flex w-64 shrink-0 flex-col overflow-y-auto border-r border-emerald-900/10 bg-gradient-to-b from-[#15603a] to-[#052e1a]">
            <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
              {isAdminConsole && <AdminConsoleSidebarNav />}
              {!isAdminConsole && currentPhase.number === 4 && (
                <>
                  <CollapsibleNavGroup to="/reports" icon="reports" label="GAE" defaultOpen>
                    <div className="ml-7 mt-1 flex flex-col gap-0.5 border-l border-emerald-100 pl-3">
                      {REPORT_GROUPS[0].items.map((v) => (
                        <NavLink key={v.id} to={v.to} className={subLinkClass(activeReportView === v.id)}>
                          {v.label}
                        </NavLink>
                      ))}
                    </div>
                  </CollapsibleNavGroup>
                  <CollapsibleNavGroup to="/reports/npc" icon="reports" label="NPC" defaultOpen>
                    <div className="ml-7 mt-1 flex flex-col gap-0.5 border-l border-emerald-100 pl-3">
                      {REPORT_GROUPS[1].items.map((v) => (
                        <NavLink key={v.id} to={v.to} className={subLinkClass(activeReportView === v.id)}>
                          {v.label}
                        </NavLink>
                      ))}
                    </div>
                  </CollapsibleNavGroup>
                </>
              )}
              {!isAdminConsole && currentPhase.number === 1 && (
                <>
                  <NavItem to="/phase1" icon="home">
                    Home
                  </NavItem>
                  {/* Every collapsible group starts expanded on arrival, not just
                      once you're already on its section - each one's sub-menu
                      should be visible right from Home without an extra click.
                      defaultOpen=true (a constant, not derived from location)
                      only forces this open once on first mount; a later manual
                      collapse still sticks, since the effect that reopens it
                      only re-fires when defaultOpen itself changes value, which
                      it never does here. */}
                  {gate("forecast.gae", isForecastEligible) || gate("forecast.doe", isForecastEligible) || gate("forecast.revenue", isForecastEligible) || gate("forecast.npc", isForecastEligible) || gate("forecast.commission", false) || gate("forecast.cos", false) || gate("forecast.da", false) || gate("forecast.interest", false) ? (
                    <CollapsibleNavGroup to="/forecast" icon="forecast" label="Forecast" defaultOpen>
                      <ForecastSubMenu />
                    </CollapsibleNavGroup>
                  ) : null}
                  {gate("request.gae", true) ||
                  SBU_TYPES.some((t) => gate(`request.${t.access}`, t.key === "DOE" || t.key === "REVENUE")) ||
                  gate("request.npc", true) ||
                  gate("request.headcount", true) ? (
                    <CollapsibleNavGroup to="/requests/new" icon="newRequest" label="New Request" defaultOpen>
                      <NewRequestSubMenu />
                    </CollapsibleNavGroup>
                  ) : null}
                  {gate("myRequests", true) && (
                    <NavItem to="/requests/mine" icon="myRequests">
                      My Requests
                    </NavItem>
                  )}
                  {/* Every employee gets Inbox, not just reviewers - per
                      user direction, it's not only approval queues, it's
                      also where a returned-to-you request shows up as
                      something needing YOUR action (see InboxPage's own
                      "Returned to You" section). Used to be gated to
                      isRevenueReviewer (isReviewer plus the two SBU Finance
                      roles), which made sense when Inbox was purely review
                      queues, but hid it entirely from a plain requestor
                      whose own request got sent back. */}
                  {gate("inbox", true) && (
                    <NavItem to="/inbox" icon="inbox">
                      <span className="flex flex-1 items-center justify-between">
                        Inbox
                        {pendingCount > 0 && <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">{pendingCount}</span>}
                      </span>
                    </NavItem>
                  )}
                  {(isHrAnalyst || isBudgetOfficer || isHrHead) &&
                    (isHrAnalyst ? (
                      <CollapsibleNavGroup to="/manpower" icon="manpower" label="Manpower Budget" defaultOpen>
                        <ManpowerSubMenu />
                      </CollapsibleNavGroup>
                    ) : (
                      <NavItem to="/manpower" icon="manpower">
                        Manpower Budget
                      </NavItem>
                    ))}
                  {gate("finalization", isBudgetOfficer) && (
                    <>
                      <div className="mb-1 mt-4 border-t border-slate-100 pt-4 text-xs font-semibold tracking-wide text-emerald-800/70">Budget Officer</div>
                      <CollapsibleNavGroup
                        to="/step5"
                        icon="step5"
                        label={
                          <span className="flex flex-1 items-center justify-between">
                            Budget Finalization & Upload
                            {step5PendingCount > 0 && <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">{step5PendingCount}</span>}
                          </span>
                        }
                        defaultOpen
                      >
                        <Step5SubMenu />
                      </CollapsibleNavGroup>
                    </>
                  )}
                </>
              )}
              {!isAdminConsole && currentPhase.number === 2 && (
                <>
                  <UtilizationSidebarNav />
                  {gate("util.dashflow", canViewDashFlow) && (
                    <>
                      <div className="my-1 border-t border-slate-100" />
                      <DashFlowSidebarNav />
                    </>
                  )}
                </>
              )}
              {currentPhase.number === 3 && (
                <>
                  <TransferSidebarNav />
                  <div className="my-1 border-t border-slate-100" />
                  <InternalOrderSidebarNav />
                </>
              )}
            </nav>
          </aside>
        )}

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="px-8 py-6">
            <div className="mx-auto max-w-6xl">
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
