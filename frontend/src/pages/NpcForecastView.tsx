import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, NPC_GROUP_SCOPE_TO_SBU, NPC_SBU_OPTIONS, type NpcSbu } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { ExpandableSection, ExpandButton } from "../components/ExpandableSection";
import { IoDetailModal } from "../components/IoDetailModal";
import { formatAufnr } from "../lib/formatAufnr";
import { useFiscalCycle, useFiscalYear } from "../lib/fiscalCycle";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Frozen on row 2 / column 3 (spreadsheet "Freeze Panes" convention): the
// header row (1) and TOTAL row (2) stay pinned while scrolling down through
// projects, and Budget Code/Project Title (columns 1-2) stay pinned while
// scrolling right through the month columns - everything from column 3
// onward scrolls normally. Column 0 = Budget Code, column 1 = Project
// Title; every other column shares one default width.
const DEFAULT_COL_WIDTH_PX = 100;
// Wide enough for the real Budget Code format ("JLC-2026B-NPC018", ~17
// chars) on one line - 110px was clipping it.
const BUDGET_CODE_COL_WIDTH_PX = 160;
const PROJECT_TITLE_COL_WIDTH_PX = 280;
const IO_CODES_COL_WIDTH_PX = 110;
const IO_DESCRIPTION_COL_WIDTH_PX = 240;
// Column indices: 0 Budget Code, 1 Project Title, 2 NPC Budget, 3 IO
// Code(s), 4 IO Description, 5 IO Budget, 6 IO Actual, 7 NPC Available
// Budget, then one column per remaining month, then the 3 trailing totals.
function colWidthPx(i: number): number {
  if (i === 0) return BUDGET_CODE_COL_WIDTH_PX;
  if (i === 1) return PROJECT_TITLE_COL_WIDTH_PX;
  if (i === 3) return IO_CODES_COL_WIDTH_PX;
  if (i === 4) return IO_DESCRIPTION_COL_WIDTH_PX;
  return DEFAULT_COL_WIDTH_PX;
}
const FROZEN_LEFT_PX = [0, BUDGET_CODE_COL_WIDTH_PX];

interface NpcForecastRow {
  // Null for a row sourced only from the NPC Monitoring import (a temporary
  // 2026-only data source, see backend/src/services/npcForecastService.ts) -
  // there's no real request behind it, so Remaining Months Forecast can't
  // be edited for it.
  budgetRequestId: string | null;
  budgetCode: string;
  projectTitle: string;
  npcBudget: number;
  ioCodes: string[];
  // Per-IO breakdown backing ioCodes above - each shown on its own line,
  // not lumped into the summed ioBudget/ioActual below (see the table).
  ios: { code: string; description: string; budget: number; actual: number | null }[];
  ioBudget: number;
  ioActual: number | null;
  npcAvailableBudget: number;
  monthlyRemainingForecast: Record<string, number>;
  remainingMonthsForecast: number;
  totalActualForecast: number;
  npcSurplus: number;
  // True only for a standalone "Carry-over" IO row (no Budget Code, no
  // NPC-approved project behind it) - npcBudget is set equal to ioBudget
  // for these (confirmed with the user), still counted in the TOTAL row
  // (see the totals block below) since the source workbook's own per-SBU
  // total counts them too.
  isCarryOver: boolean;
}

// Sortable columns - string or (number | null) fields only, matched against
// each other in toggleSort/the sort comparator above.
type SortColumn = "budgetCode" | "projectTitle" | "npcBudget" | "ioBudget" | "ioActual" | "npcAvailableBudget" | "totalActualForecast" | "npcSurplus" | "remainingMonthsForecast";

function peso(n: number) {
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}


// Note 11 §8 - NPC Forecast. Genuinely new (not a filtered view of the
// generic HistoricalActuals table the GAE/DOE/Revenue tabs use) - NPC's
// real data lives in BudgetRequest/FinalizedBudgetLine/InternalOrderRequest,
// never in HistoricalActuals. SBU-scoped rather than department-scoped:
// Budget Officer picks any of the 8 NPC SBUs, everyone else is pinned to
// their own department's Department.sbu (same pattern Utilization's NPC
// view already uses).
export function NpcForecastView() {
  const { currentUser, hasRole } = useAuth();
  const isBudgetOfficer = hasRole("BUDGET_OFFICER");
  const { targetYear, forecastYear } = useFiscalYear();
  const [openIo, setOpenIo] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Budget-Officer-only control, same as ForecastPage.tsx's GAE/DOE view -
  // NPC's own asOfMonth (used just above for remainingMonths) is driven by
  // this same shared fiscal-cycle setting, so editing it here rather than
  // only from GAE keeps NPC's own cutoff reachable from its own page.
  const { data: fiscalCycle } = useFiscalCycle();
  const asOfMonthMutation = useMutation({
    mutationFn: async (month: number) => (await api.put("/admin/fiscal-cycle", { npcAsOfMonth2026: month })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fiscal-cycle"] });
      queryClient.invalidateQueries({ queryKey: ["forecast"] });
    },
  });

  // NPC-group memberships (User Management workbook, e.g. "Corporate - HR")
  // take precedence over the department's own SBU - same rule the backend
  // applies (resolveNpcSbuScope in routes/forecast.ts).
  const groupSbus = (currentUser?.groups ?? [])
    .filter((g) => g.group === "NPC")
    .map((g) => NPC_GROUP_SCOPE_TO_SBU[g.scope])
    .filter((v): v is NpcSbu => Boolean(v));
  const mySbus: NpcSbu[] = isBudgetOfficer ? NPC_SBU_OPTIONS.map((o) => o.value) : groupSbus.length > 0 ? [...new Set(groupSbus)] : currentUser?.department?.sbu ? [currentUser.department.sbu] : [];
  const [pickedSbu, setPickedSbu] = useState<NpcSbu | "">("");
  const effectiveSbu: NpcSbu | "" = pickedSbu && mySbus.includes(pickedSbu) ? pickedSbu : mySbus[0] ?? "";

  const { data, isLoading, isError } = useQuery({
    queryKey: ["forecast", "npc", effectiveSbu],
    queryFn: async () => (await api.get<{ asOfMonth: number; rows: NpcForecastRow[] }>(`/forecast/npc/${effectiveSbu}`)).data,
    enabled: !!effectiveSbu,
  });
  const rows = data?.rows ?? [];
  const asOfMonth = data?.asOfMonth ?? 9;
  const remainingMonths = Array.from({ length: 12 - asOfMonth }, (_, i) => asOfMonth + 1 + i);
  // Budget Code, Project Title, NPC Budget, IO Code(s), IO Description, IO
  // Budget, IO Actual, NPC Available Budget (8) + one column per remaining
  // month + Total Remaining Forecast, Total Actual + Forecast, NPC Surplus (3).
  const columnCount = 8 + remainingMonths.length + 3;

  // Carry-over IOs (appended at the end of the table - see the render
  // below) still count toward the SBU's approved NPC total - the source
  // workbook's own per-SBU tab total (Amount - Cut, summed top to bottom)
  // includes its "Carryover" rows exactly the same as new-budget-code
  // rows, and each carry-over row's npcBudget is already set equal to its
  // ioBudget (no fresh ask this cycle, but a real approved figure), so
  // excluding them here would only make this total diverge from the
  // workbook's.
  // ioActual is only summed across rows that actually have one - a project
  // with no live/imported Actual yet shouldn't silently count as ₱0 and
  // understate the total, same "—" semantics each row's own cell already
  // uses (see the table below).
  const rowsWithActual = rows.filter((r) => r.ioActual !== null);
  const totals = {
    npcBudget: rows.reduce((sum, r) => sum + r.npcBudget, 0),
    ioBudget: rows.reduce((sum, r) => sum + r.ioBudget, 0),
    ioActual: rowsWithActual.length > 0 ? rowsWithActual.reduce((sum, r) => sum + (r.ioActual ?? 0), 0) : null,
    npcAvailableBudget: rows.reduce((sum, r) => sum + r.npcAvailableBudget, 0),
    monthlyRemainingForecast: remainingMonths.reduce<Record<string, number>>((acc, m) => {
      acc[String(m)] = rows.reduce((sum, r) => sum + (r.monthlyRemainingForecast[String(m)] ?? 0), 0);
      return acc;
    }, {}),
    remainingMonthsForecast: rows.reduce((sum, r) => sum + r.remainingMonthsForecast, 0),
    totalActualForecast: rows.reduce((sum, r) => sum + r.totalActualForecast, 0),
    npcSurplus: rows.reduce((sum, r) => sum + r.npcSurplus, 0),
  };

  // Filtering/sorting only ever changes what's rendered in the body below -
  // the TOTAL row above always reflects the full SBU, not the filtered/
  // sorted subset, same as a spreadsheet's own grand total staying put
  // under an AutoFilter.
  const [filterText, setFilterText] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const filteredRows = filterText.trim()
    ? rows.filter((r) => {
        const needle = filterText.trim().toLowerCase();
        return (
          r.budgetCode.toLowerCase().includes(needle) ||
          r.projectTitle.toLowerCase().includes(needle) ||
          r.ios.some((io) => io.code.includes(needle) || io.description.toLowerCase().includes(needle))
        );
      })
    : rows;

  const displayRows = sortColumn
    ? [...filteredRows].sort((a, b) => {
        const av = a[sortColumn];
        const bv = b[sortColumn];
        // null (no Actual yet) always sorts last, in either direction -
        // otherwise it's indistinguishable from a real ₱0.
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
        return sortDirection === "asc" ? cmp : -cmp;
      })
    : filteredRows;

  function toggleSort(column: SortColumn) {
    if (sortColumn === column) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  function sortHeader(column: SortColumn, label: string) {
    const active = sortColumn === column;
    return (
      <button type="button" onClick={() => toggleSort(column)} className="inline-flex items-center gap-1 font-semibold hover:underline">
        {label}
        <span aria-hidden className={`text-[10px] ${active ? "opacity-100" : "opacity-30"}`}>{active ? (sortDirection === "asc" ? "▲" : "▼") : "▲"}</span>
      </button>
    );
  }

  // Keyed by budgetCode, not budgetRequestId (see NpcForecastEntry's own
  // schema comment on the Node side) - every row has one, including a row
  // sourced only from the NPC Monitoring import (no real BudgetRequest
  // behind it), so every row's cells below are editable, same as GAE's.
  const updateMutation = useMutation({
    mutationFn: async ({ budgetCode, month, value }: { budgetCode: string; month: number; value: number }) =>
      (await api.patch(`/forecast/npc/entries/${encodeURIComponent(budgetCode)}`, { month, value })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["forecast", "npc", effectiveSbu] }),
  });

  if (!effectiveSbu) {
    return (
      <div className="space-y-4">
        <PageHeader subtitle="You have no NPC SBU assigned - ask the Budget Officer to add you to an NPC SBU group in the Admin Console." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-30 space-y-2 bg-slate-100 pb-1 pt-1">
      <PageHeader
        subtitle={`Months through ${MONTH_NAMES[asOfMonth - 1]} are already in Actuals - only remaining months are editable.`}
        actions={
          <div className="flex items-center gap-3">
            {isBudgetOfficer && (
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-slate-600">YTD Actual through</label>
                <select className="rounded border border-slate-300 bg-white px-2 py-1 text-sm" value={fiscalCycle?.npcAsOfMonth2026 ?? 9} onChange={(e) => asOfMonthMutation.mutate(Number(e.target.value))}>
                  {MONTH_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {mySbus.length > 1 && (
              <select className="rounded border border-slate-300 px-2 py-1.5 text-sm" value={effectiveSbu} onChange={(e) => setPickedSbu(e.target.value as NpcSbu)}>
                {NPC_SBU_OPTIONS.filter((o) => mySbus.includes(o.value)).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-4 rounded-lg border border-emerald-200 border-l-4 border-l-lime-600 bg-emerald-50 p-4 text-sm shadow-sm sm:grid-cols-2">
        <div>
          <label className="block font-medium text-emerald-800">SBU</label>
          <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{NPC_SBU_OPTIONS.find((o) => o.value === effectiveSbu)?.label ?? "—"}</div>
        </div>
        <div>
          <label className="block font-medium text-emerald-800">Forecast Year</label>
          <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{forecastYear}</div>
        </div>
      </div>
      </div>

      {isError && <div className="text-sm text-red-700">You do not have access to this SBU's NPC forecast.</div>}

      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <input
          type="search"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter by Budget Code, Project Title, or IO Code…"
          className="w-96 rounded border border-slate-300 px-2 py-1"
        />
        {filterText && (
          <button type="button" onClick={() => setFilterText("")} className="text-emerald-700 hover:underline">
            Clear
          </button>
        )}
      </div>

      <ExpandableSection title="NPC Forecast" inlineExpand>
        {/* max-h + overflow-auto (not a lone overflow-x-auto) so this is a
            real 2-axis scroll pane - a bare overflow-x-auto gets silently
            upgraded to overflow-y: auto too per the CSS spec once any
            sticky descendant needs a containing block, which leaves
            `position: sticky` inert with no explicit height cap (same fix
            ForecastPage.tsx's GAE/DOE grid already needed). */}
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs italic text-slate-500">All amounts are in PHP.</p>
            <span className="text-xs text-slate-500">Showing {displayRows.length} of {rows.length} line item(s)</span>
          </div>
          <ExpandButton />
        </div>
        <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="table-fixed text-xs" style={{ width: Array.from({ length: columnCount }, (_, i) => colWidthPx(i)).reduce((a, b) => a + b, 0) }}>
            <colgroup>
              {Array.from({ length: columnCount }).map((_, i) => (
                <col key={i} style={{ width: colWidthPx(i) }} />
              ))}
            </colgroup>
            {/* The whole thead (header row + TOTAL row) sticks together as
                one unit - sticky on <thead> itself, not each <tr>, sticks
                every row inside it without needing to hand-compute a `top`
                offset per row. */}
            <thead className="sticky top-0 z-20 bg-[#edf6f1] text-left tracking-wide text-[#164b33]">
              <tr>
                <th rowSpan={2} className="sticky z-30 whitespace-nowrap bg-emerald-50 px-2 py-2 align-bottom" style={{ left: FROZEN_LEFT_PX[0] }}>
                  {sortHeader("budgetCode", "Budget Code")}
                </th>
                <th rowSpan={2} className="sticky z-30 whitespace-nowrap bg-emerald-50 px-2 py-2 align-bottom" style={{ left: FROZEN_LEFT_PX[1] }}>
                  {sortHeader("projectTitle", "Project Title")}
                </th>
                <th rowSpan={2} className="px-2 py-2 text-right align-bottom">
                  {sortHeader("npcBudget", "NPC Budget")}
                </th>
                <th rowSpan={2} className="px-2 py-2 align-bottom">
                  IO Code(s)
                </th>
                <th rowSpan={2} className="px-2 py-2 align-bottom">
                  IO Description
                </th>
                <th rowSpan={2} className="px-2 py-2 text-right align-bottom">
                  {sortHeader("ioBudget", "IO Budget")}
                </th>
                <th rowSpan={2} className="px-2 py-2 text-right align-bottom">
                  {sortHeader("ioActual", "IO Actual")}
                </th>
                <th rowSpan={2} className="px-2 py-2 text-right align-bottom">
                  {sortHeader("npcAvailableBudget", "NPC Available Budget")}
                </th>
                <th colSpan={remainingMonths.length + 1} className="px-2 py-2 text-center">
                  Remaining Months Forecast
                </th>
                <th rowSpan={2} className="px-2 py-2 text-right align-bottom">
                  {sortHeader("totalActualForecast", "Total Actual + Forecast")}
                </th>
                <th rowSpan={2} className="px-2 py-2 text-right align-bottom break-words">
                  {sortHeader("npcSurplus", "NPC Surplus/​(Deficit)")}
                </th>
              </tr>
              <tr>
                {remainingMonths.map((m) => (
                  <th key={m} className="px-2 py-2 text-right">
                    {MONTH_NAMES[m - 1]}
                  </th>
                ))}
                <th className="px-2 py-2 text-right">
                  {sortHeader("remainingMonthsForecast", "Total")}
                </th>
              </tr>
              {rows.length > 0 && (
                <tr className="border-t-2 border-emerald-200 bg-[#edf6f1] font-semibold text-[#164b33]">
                  <td className="sticky z-30 whitespace-nowrap bg-[#edf6f1] px-2 py-1" style={{ left: FROZEN_LEFT_PX[0] }} colSpan={2}>
                    TOTAL
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">{peso(totals.npcBudget)}</td>
                  <td className="px-2 py-1" />
                  <td className="px-2 py-1" />
                  <td className="whitespace-nowrap px-2 py-1 text-right">{peso(totals.ioBudget)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">{totals.ioActual === null ? "—" : peso(totals.ioActual)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">{peso(totals.npcAvailableBudget)}</td>
                  {remainingMonths.map((m) => (
                    <td key={m} className="whitespace-nowrap px-2 py-1 text-right">
                      {peso(totals.monthlyRemainingForecast[String(m)] ?? 0)}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-2 py-1 text-right">{peso(totals.remainingMonthsForecast)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right">{peso(totals.totalActualForecast)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right text-emerald-800">{peso(totals.npcSurplus)}</td>
                </tr>
              )}
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr>
                  <td colSpan={columnCount} className="px-2 py-6 text-center text-slate-400">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="px-2 py-6 text-center text-slate-400">
                    No finalized NPC projects for this SBU yet.
                  </td>
                </tr>
              ) : displayRows.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="px-2 py-6 text-center text-slate-400">
                    No rows match "{filterText}".
                  </td>
                </tr>
              ) : (
                displayRows.map((r, i) => {
                  // Frozen cells need a fully OPAQUE background (not
                  // "inherit"/transparent) - otherwise the columns
                  // scrolling underneath a sticky cell show through it
                  // (same fix ForecastPage.tsx's grid already needed).
                  // A top border marks where the Carry-over section starts
                  // (rows are already sorted with every real project first -
                  // see npcForecastService.ts) - only meaningful while
                  // unsorted/unfiltered, same as a spreadsheet's own
                  // grouping visually breaking once you sort by something
                  // else.
                  const isFirstCarryOver = r.isCarryOver && !displayRows[i - 1]?.isCarryOver;
                  return (
                    <tr key={r.budgetCode} className={`${isFirstCarryOver ? "border-t-2 border-slate-200" : "border-t border-slate-100"} ${i % 2 === 1 ? "bg-slate-50/60" : "bg-white"}`}>
                      <td className={`sticky z-10 whitespace-nowrap ${i % 2 === 1 ? "bg-slate-50" : "bg-white"} px-2 py-1 ${r.isCarryOver ? "italic text-slate-400" : ""}`} style={{ left: FROZEN_LEFT_PX[0] }}>
                        {r.isCarryOver ? "Carry-over" : r.budgetCode}
                      </td>
                      <td className={`sticky z-10 truncate ${i % 2 === 1 ? "bg-slate-50" : "bg-white"} px-2 py-1`} style={{ left: FROZEN_LEFT_PX[1] }} title={r.projectTitle}>
                        {r.projectTitle}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-right">{peso(r.npcBudget)}</td>
                      {r.ios.length > 0 ? (
                        <>
                          <td className="px-2 py-1">
                            {r.ios.map((io) => (
                              <div key={io.code}>
                                <button type="button" onClick={() => setOpenIo(io.code)} className="text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-900">
                                  {formatAufnr(io.code)}
                                </button>
                              </div>
                            ))}
                          </td>
                          <td className="px-2 py-1">
                            {r.ios.map((io) => (
                              <div key={io.code} className="truncate" title={io.description}>
                                {io.description}
                              </div>
                            ))}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1 text-right">
                            {r.ios.map((io) => (
                              <div key={io.code}>{peso(io.budget)}</div>
                            ))}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1 text-right">
                            {r.ios.map((io) => (
                              <div key={io.code}>{io.actual === null ? "—" : peso(io.actual)}</div>
                            ))}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-2 py-1">—</td>
                          <td className="px-2 py-1">—</td>
                          <td className="whitespace-nowrap px-2 py-1 text-right">{peso(0)}</td>
                          <td className="whitespace-nowrap px-2 py-1 text-right">—</td>
                        </>
                      )}
                      <td className="whitespace-nowrap px-2 py-1 text-right">{peso(r.npcAvailableBudget)}</td>
                      {/* Same input styling/onBlur pattern as ForecastPage.tsx's
                          GAE/DOE grid - editable for every row (including a
                          Carry-over row and one sourced only from the NPC
                          Monitoring import), keyed by budgetCode rather than
                          budgetRequestId so a row with no real BudgetRequest
                          still has somewhere to save its own entry. */}
                      {remainingMonths.map((m) => (
                        <td key={m} className="whitespace-nowrap px-2 py-1 text-right">
                          <input
                            type="number"
                            className="w-full rounded border border-slate-300 px-1 py-0.5 text-right text-xs"
                            defaultValue={r.monthlyRemainingForecast[String(m)] ?? ""}
                            onBlur={(e) => {
                              const value = Number(e.target.value) || 0;
                              if (value !== (r.monthlyRemainingForecast[String(m)] ?? 0)) {
                                updateMutation.mutate({ budgetCode: r.budgetCode, month: m, value });
                              }
                            }}
                          />
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2 py-1 text-right font-medium text-slate-700">{peso(r.remainingMonthsForecast)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right">{peso(r.totalActualForecast)}</td>
                      <td className="whitespace-nowrap px-2 py-1 text-right font-semibold text-emerald-800">{peso(r.npcSurplus)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </ExpandableSection>
      {openIo && <IoDetailModal aufnr={openIo} fiscalYear={forecastYear} onClose={() => setOpenIo(null)} />}
    </div>
  );
}
