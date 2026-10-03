import { useMemo, useState } from "react";
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
  let lastSection = "";
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
            {data.matrix.map((row) => {
              const hasSection = row.label.includes(" - ");
              const section = hasSection ? row.label.split(" - ")[0] : "";
              const showSection = hasSection && section !== lastSection;
              lastSection = section;
              return (
                <tr key={row.key} className="border-t border-slate-100">
                  <td className="px-3 py-1.5">
                    {showSection && <span className="mr-1 text-xs font-semibold text-emerald-800">{section}:</span>}
                    {hasSection ? row.label.split(" - ").slice(1).join(" - ") : row.label}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-slate-500">{row.scope}</td>
                  {COLUMNS.map((c) => (
                    <td key={c} className="px-3 py-1.5 text-center">
                      <button
                        onClick={() => cellMutation.mutate({ key: row.key, group: c, allowed: row[c] !== "P" })}
                        title={row[c] !== defaultOf(row.key, c) ? "Edited - workbook default is " + defaultOf(row.key, c) : "Click to toggle"}
                        className={`inline-block w-6 rounded text-xs font-semibold ${row[c] === "P" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-400"} ${row[c] !== defaultOf(row.key, c) ? "ring-2 ring-amber-400" : ""}`}
                      >
                        {row[c] === "P" ? "✓" : "X"}
                      </button>
                    </td>
                  ))}
                </tr>
              );
            })}
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
