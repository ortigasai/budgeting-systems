import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type DemoUser } from "../../api/client";
import { SearchableSelect } from "../../components/SearchableSelect";

interface MatrixRow {
  key: string;
  label: string;
  scope: string;
  CD: string;
  NCD: string;
  MC: string;
  SF: string;
  NPC: string;
}
interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  scope: string;
}
interface GroupInfo {
  group: string;
  label: string;
  members: Member[];
}
interface AccessControlData {
  matrix: MatrixRow[];
  defaults: MatrixRow[];
  groups: GroupInfo[];
}

const COLUMNS = ["CD", "NCD", "MC", "SF", "NPC"] as const;
const SCOPED_GROUPS = ["CD", "NCD", "SF", "NPC"];
const scopeLabel = (group: string) => (group === "SF" ? "SBU" : group === "NPC" ? "NPC SBU" : "Department");

// Table order and titles, following the Module titles of the Budget System
// workbook. "sbu" rows are the merged SBU Budget (Upload Template) rows built
// from the per-SBU keys below. Keys not listed here still appear under "Other".
type LayoutEntry =
  | { kind: "module"; title: string }
  | { kind: "group"; title: string; level: number }
  | { kind: "row"; key: string; label: string; level: number };
const TABLE_LAYOUT: LayoutEntry[] = [
  { kind: "module", title: "Module 1 - Annual Budget Setting" },
  { kind: "group", title: "Forecast", level: 1 },
  { kind: "row", key: "forecast.gae", label: "General & Administrative Expenses (GAE)", level: 2 },
  { kind: "row", key: "forecast.sbu", label: "SBU Budget (Upload Template)", level: 2 },
  { kind: "row", key: "forecast.npc", label: "Non-Project Capex (NPC)", level: 2 },
  { kind: "group", title: "New Request", level: 1 },
  { kind: "row", key: "request.gae", label: "General & Administrative Expenses (GAE)", level: 2 },
  { kind: "row", key: "request.sbu", label: "SBU Budget (Upload Template)", level: 2 },
  { kind: "row", key: "request.npc", label: "Non-Project Capex (NPC)", level: 2 },
  { kind: "row", key: "request.headcount", label: "Additional Manpower", level: 2 },
  { kind: "row", key: "myRequests", label: "My Requests", level: 1 },
  { kind: "row", key: "inbox", label: "Inbox", level: 1 },
  { kind: "row", key: "finalization", label: "Budget Finalization & Upload", level: 1 },
  { kind: "module", title: "Module 2 - Budget Utilization Tracking" },
  { kind: "group", title: "Operating Expenses (GAE & DOE)", level: 1 },
  { kind: "row", key: "util.overview", label: "Departmental Overview", level: 2 },
  { kind: "row", key: "util.reconciliation", label: "Live Reconciliation", level: 2 },
  { kind: "row", key: "util.reconciliationEnabled", label: "Live Reconciliation (temporarily BCA-only)", level: 2 },
  { kind: "row", key: "util.npc", label: "Non-Project Capex (NPC)", level: 1 },
  { kind: "row", key: "util.dashflow", label: "Dash Flow Budget Check", level: 1 },
  { kind: "module", title: "Module 3 - Budget Transfer & Reallocation" },
  { kind: "row", key: "transfer.new", label: "New Transfer", level: 1 },
  { kind: "row", key: "transfer.mine", label: "My Transfers", level: 1 },
  { kind: "row", key: "transfer.inbox", label: "Transfer Inbox", level: 1 },
  { kind: "row", key: "io.new", label: "New Internal Order Request", level: 1 },
  { kind: "row", key: "io.mine", label: "My Internal Order Requests", level: 1 },
  { kind: "row", key: "io.inbox", label: "Internal Order Inbox", level: 1 },
  { kind: "module", title: "Module 4 - Budget Report & Analysis" },
  { kind: "row", key: "reports", label: "Budget Report & Analysis", level: 1 },
];

// "Budgeting System_User Management" - Access Control tab. P = all access
// (view / update / upload / download), X = none; BCA members see everything,
// like the Budget Officer, and anyone in several groups gets P wherever any
// of their groups has it. The matrix is fixed in code (backend/src/lib/
// accessControl.ts); who belongs to which group is editable below.
export function AccessControlTab() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["admin", "access-control"],
    queryFn: async () => (await api.get<AccessControlData>("/admin/access-control")).data,
  });
  const { data: users = [] } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: async () => (await api.get<DemoUser[]>("/auth/users")).data,
  });

  const [group, setGroup] = useState("CD");
  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState("");
  const [scope, setScope] = useState("");

  const current = data?.groups.find((g) => g.group === group);
  const members = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (current?.members ?? []).filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q) || m.scope.toLowerCase().includes(q));
  }, [current, search]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin", "access-control"] });
  const addMutation = useMutation({
    mutationFn: async () => (await api.post("/admin/access-control/members", { userId, group, scope })).data,
    onSuccess: () => {
      invalidate();
      setUserId("");
      setScope("");
    },
  });
  const cellMutation = useMutation({
    mutationFn: async (v: { key: string; group: string; allowed: boolean }) => (await api.put("/admin/access-control/matrix", v)).data,
    onSuccess: invalidate,
  });
  const resetMutation = useMutation({
    mutationFn: async () => (await api.delete("/admin/access-control/matrix")).data,
    onSuccess: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/access-control/members/${id}`)).data,
    onSuccess: invalidate,
  });

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  const defaultOf = (key: string, c: (typeof COLUMNS)[number]) => data.defaults.find((d) => d.key === key)?.[c];
  // Display only: the per-SBU keys (DOE, Commission, Revenue, Cost of Sales,
  // D&A, Interest) show as one "SBU Budget (Upload Template)" row per section,
  // matching the sidebar. Each click still sets every underlying key.
  const SBU_CHILD_KEY = /^(forecast|request)\.(doe|commission|revenue|cos|da|interest)$/;
  const displayRows: { row: MatrixRow; children: MatrixRow[] }[] = [];
  const sbuRowIndex: Record<string, number> = {};
  for (const row of data.matrix) {
    if (SBU_CHILD_KEY.test(row.key)) {
      const sec = row.key.split(".")[0];
      if (sbuRowIndex[sec] !== undefined) {
        displayRows[sbuRowIndex[sec]].children.push(row);
        continue;
      }
      sbuRowIndex[sec] = displayRows.length;
      const section = row.label.split(" - ")[0];
      displayRows.push({
        row: { ...row, key: `${sec}.sbu`, label: `${section} - SBU Budget (Upload Template)` },
        children: [row],
      });
    } else {
      displayRows.push({ row, children: [row] });
    }
  }
  const cellValue = (children: MatrixRow[], c: (typeof COLUMNS)[number]) => {
    const on = children.filter((ch) => ch[c] === "P").length;
    return on === children.length ? "P" : on === 0 ? "X" : "mixed";
  };
  const setCell = (children: MatrixRow[], c: (typeof COLUMNS)[number], allowed: boolean) =>
    Promise.all(children.map((ch) => api.put("/admin/access-control/matrix", { key: ch.key, group: c, allowed }))).then(invalidate);

  const displayByKey = new Map(displayRows.map((d) => [d.row.key, d]));
  const placed = new Set<string>();
  const PAD = ["", "pl-4", "pl-8", "pl-12"];
  const renderRow = (d: { row: MatrixRow; children: MatrixRow[] }, label: string, level: number) => {
    placed.add(d.row.key);
    return (
      <tr key={d.row.key} className="border-t border-slate-100">
        <td className={`px-3 py-1.5 ${PAD[level]}`}>{label}</td>
        <td className="px-3 py-1.5 text-xs text-slate-500">{d.row.scope}</td>
        {COLUMNS.map((c) => {
          const value = cellValue(d.children, c);
          const edited = d.children.some((ch) => ch[c] !== defaultOf(ch.key, c));
          return (
            <td key={c} className="px-3 py-1.5 text-center">
              <button
                onClick={() => setCell(d.children, c, value !== "P")}
                title={edited ? "Edited - workbook default differs" : "Click to toggle"}
                className={`inline-block w-6 rounded text-xs font-semibold ${value === "P" ? "bg-emerald-100 text-emerald-800" : value === "mixed" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-400"} ${edited ? "ring-2 ring-amber-400" : ""}`}
              >
                {value === "P" ? "✓" : value === "mixed" ? "–" : "X"}
              </button>
            </td>
          );
        })}
      </tr>
    );
  };
  const moduleRow = (title: string) => (
    <tr key={`module-${title}`} className="border-t border-slate-200 bg-slate-50">
      <td colSpan={2 + COLUMNS.length} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-800">
        {title}
      </td>
    </tr>
  );
  const groupRow = (title: string, level: number) => (
    <tr key={`group-${title}`} className="border-t border-slate-100">
      <td colSpan={2 + COLUMNS.length} className={`px-3 py-1.5 font-semibold text-slate-700 ${PAD[level]}`}>
        {title}
      </td>
    </tr>
  );
  const tableBody: JSX.Element[] = [];
  for (const entry of TABLE_LAYOUT) {
    if (entry.kind === "module") tableBody.push(moduleRow(entry.title));
    else if (entry.kind === "group") tableBody.push(groupRow(entry.title, entry.level));
    else {
      const d = displayByKey.get(entry.key);
      if (d) tableBody.push(renderRow(d, entry.label, entry.level));
    }
  }
  const leftovers = displayRows.filter((d) => !placed.has(d.row.key));
  if (leftovers.length > 0) {
    tableBody.push(moduleRow("Other"));
    for (const d of leftovers) tableBody.push(renderRow(d, d.row.label, 1));
  }

  return (
    <div className="space-y-6">
      <div className="text-xs text-slate-500">
        ✓ = all access (view / update / upload / download) · X = no access. Click a cell to change it (Budget Officer only; edited cells are outlined). Members of several groups get access wherever any of their groups has it; BCA members have access to everything.
        <button onClick={() => window.confirm("Reset every cell to the workbook defaults?") && resetMutation.mutate()} className="ml-2 text-emerald-700 hover:underline">
          Reset to defaults
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm">
          <thead className="bg-emerald-50 text-left text-xs tracking-wide text-emerald-800">
            <tr>
              <th className="px-3 py-2">Module / page</th>
              <th className="px-3 py-2">Scoped by</th>
              {COLUMNS.map((c) => (
                <th key={c} className="px-3 py-2 text-center">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableBody}
          </tbody>
        </table>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {data.groups.map((g) => (
            <button
              key={g.group}
              onClick={() => setGroup(g.group)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${g.group === group ? "bg-emerald-700 text-white" : "bg-slate-100 text-slate-600 hover:bg-emerald-50"}`}
            >
              {g.group} · {g.members.length}
            </button>
          ))}
        </div>
        <div className="text-sm font-medium text-slate-700">{current?.label}</div>

        <div className="flex flex-wrap items-end gap-2 text-sm">
          <div className="w-64">
            <label className="mb-1 block text-xs font-medium text-slate-500">Add member</label>
            <SearchableSelect placeholder="Search employees…" options={users.map((u) => ({ value: u.id, label: u.name, sublabel: u.email }))} value={userId} onChange={setUserId} />
          </div>
          {SCOPED_GROUPS.includes(group) && (
            <div className="w-64">
              <label className="mb-1 block text-xs font-medium text-slate-500">{scopeLabel(group)}</label>
              <input value={scope} onChange={(e) => setScope(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-2 text-sm" />
            </div>
          )}
          <button onClick={() => addMutation.mutate()} disabled={!userId || addMutation.isPending} className="rounded bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
            Add
          </button>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter members…" className="ml-auto w-56 rounded border border-slate-300 px-2 py-2 text-sm" />
        </div>
        {addMutation.isError && <div className="text-xs text-red-600">Could not add member (Budget Officer only).</div>}

        <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200">
          <table className="w-full bg-white text-sm">
            <thead className="sticky top-0 bg-[#edf6f1] text-left text-xs tracking-wide text-[#164b33]">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">{scopeLabel(group)}</th>
                <th className="w-16 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">{m.name}</td>
                  <td className="px-3 py-1.5 text-slate-500">{m.email}</td>
                  <td className="px-3 py-1.5 text-slate-500">{m.scope || "—"}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button onClick={() => removeMutation.mutate(m.id)} className="text-xs text-red-600 hover:underline">
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {members.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-xs text-slate-400">
                    No members.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
