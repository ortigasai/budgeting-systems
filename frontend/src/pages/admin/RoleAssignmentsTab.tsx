import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Department, type DemoUser } from "../../api/client";
import { SearchableSelect } from "../../components/SearchableSelect";
import { roleLabel } from "../../components/RoleSwitcher";
import { SortableHeader, TableFilter } from "../../components/SortableHeader";
import { useTableSort } from "../../lib/useTableSort";

interface RoleAssignment {
  id: string;
  roleType: string;
  department: Department;
  user: { id: string; name: string; email: string };
}

// Role dropdown, in the order of the approval workflow's Roles list. Department
// Head and SBU or Division Head aren't assigned here: the requester picks them
// from the list when submitting. Tiered approvers (BCA Head / CFO / CEO) appear
// once each; SBU Finance and SBU Head roles are assigned in SBU Roles instead.
const ROLE_TYPES = [
  "HR_ANALYST",
  "CENTRALIZED_BUDGET_PREPARER",
  "CENTRALIZED_DEPARTMENT_HEAD",
  "BUDGET_OFFICER",
  "BCA_HEAD",
  "CFO",
  "CEO",
];

export function RoleAssignmentsTab() {
  const queryClient = useQueryClient();
  const { data: assignments = [] } = useQuery({
    queryKey: ["role-assignments"],
    queryFn: async () => (await api.get<RoleAssignment[]>("/admin/role-assignments")).data,
  });
  const { data: users = [] } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: async () => (await api.get<DemoUser[]>("/auth/users")).data,
  });

  // Sort alphabetically by department, then user name, so the table reads
  // in a stable, scannable order rather than insertion order.
  const sortedAssignments = useMemo(() => [...assignments].sort((a, b) => a.department.name.localeCompare(b.department.name) || a.user.name.localeCompare(b.user.name)), [assignments]);
  const [filterText, setFilterText] = useState("");
  const filteredAssignments = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return sortedAssignments;
    return sortedAssignments.filter((a) =>
      [a.department.name, roleLabel(a.roleType), a.user.name, a.user.email].some((v) => v.toLowerCase().includes(q))
    );
  }, [sortedAssignments, filterText]);
  const { sorted, sortKey, sortDir, toggle } = useTableSort(filteredAssignments, (a, key) => {
    if (key === "department") return a.department.name;
    if (key === "role") return roleLabel(a.roleType);
    if (key === "user") return a.user.name;
    return a.user.email;
  });

  // Notes_6: fields are (1) Username - searchable from the employee list,
  // (2) Department - defaults to that user's own department but is
  // overridable, (3) Role, (4) Email address (editable, pre-filled from the
  // selected user's current email).
  // Notes_9: "some employees may become an approver of more than two
  // departments" — Department used to be a read-only mirror of the user's
  // home department, which made it impossible to assign someone as an
  // approver for a department they don't belong to. RoleAssignment.departmentId
  // is already independent of User.departmentId on the backend (see
  // schema.prisma), so this just unlocks the field the UI was artificially
  // pinning.
  const { data: departments = [] } = useQuery({
    queryKey: ["departments"],
    queryFn: async () => (await api.get<Department[]>("/admin/departments")).data,
  });
  const [userId, setUserId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [roleType, setRoleType] = useState(ROLE_TYPES[0]);
  const [email, setEmail] = useState("");
  const selectedUser = users.find((u) => u.id === userId);

  const assignMutation = useMutation({
    mutationFn: async () => {
      if (!selectedUser) throw new Error("Select an employee.");
      if (!departmentId) throw new Error("Select a department.");
      if (email && email !== selectedUser.email) {
        await api.patch(`/admin/users/${selectedUser.id}`, { email });
      }
      return (
        await api.post("/admin/role-assignments", {
          departmentId,
          roleType,
          userId: selectedUser.id,
        })
      ).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["role-assignments"] });
      queryClient.invalidateQueries({ queryKey: ["auth", "users"] });
      setUserId("");
      setDepartmentId("");
      setRoleType(ROLE_TYPES[0]);
      setEmail("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/role-assignments/${id}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["role-assignments"] }),
  });

  // Notes_7: "Put a button to upload Employee List to update the list of
  // employees to choose from and their corresponding departments."
  const [uploadStatus, setUploadStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return (await api.post("/admin/employees/upload", form)).data;
    },
    onSuccess: (data: { imported: number; positions: number; departments: number; roleAssignmentsUpdated: number }) => {
      setUploadStatus({
        ok: true,
        message: `Updated ${data.imported} employees (${data.departments} departments, ${data.positions} positions, ${data.roleAssignmentsUpdated} role assignments moved to a new department).`,
      });
      queryClient.invalidateQueries({ queryKey: ["auth", "users"] });
      queryClient.invalidateQueries({ queryKey: ["departments"] });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      queryClient.invalidateQueries({ queryKey: ["role-assignments"] });
    },
    onError: (err: any) => setUploadStatus({ ok: false, message: err.response?.data?.error ?? "Upload failed." }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="text-sm">
          <div className="font-semibold text-slate-700">Upload Employee List</div>
          <div className="text-xs text-slate-500">Refreshes the employees available above and their departments (column J) from an updated roster file. Matches by Id Number, so existing users keep their email/login.</div>
        </div>
        <label className="cursor-pointer rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600">
          {uploadMutation.isPending ? "Uploading…" : "Upload Employee List (.xlsx)"}
          <input
            type="file"
            accept=".xlsx"
            className="hidden"
            disabled={uploadMutation.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setUploadStatus(null);
              uploadMutation.mutate(file);
            }}
          />
        </label>
        {uploadStatus && <span className={`text-xs ${uploadStatus.ok ? "text-emerald-700" : "text-red-600"}`}>{uploadStatus.message}</span>}
      </div>

      <div className="flex flex-wrap items-end gap-2 text-sm">
        <div className="w-56">
          <label className="mb-1 block text-xs font-medium text-slate-500">Username</label>
          <SearchableSelect
            placeholder="Search employees…"
            options={users.map((u) => ({ value: u.id, label: u.name, sublabel: u.department?.name ?? "no dept" }))}
            value={userId}
            onChange={(v) => {
              setUserId(v);
              const u = users.find((x) => x.id === v);
              setEmail(u?.email ?? "");
              setDepartmentId(u?.department?.id ?? "");
            }}
          />
        </div>
        <div className="w-48">
          <label className="mb-1 block text-xs font-medium text-slate-500">Department</label>
          <select className="w-full rounded border border-slate-300 px-2 py-1.5" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">— Select —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.id !== selectedUser?.department?.id ? "(override)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-500">Role</label>
          <select className="rounded border border-slate-300 px-2 py-1.5" value={roleType} onChange={(e) => setRoleType(e.target.value)}>
            {ROLE_TYPES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <div className="w-56">
          <label className="mb-1 block text-xs font-medium text-slate-500">Email address</label>
          <input type="email" className="w-full rounded border border-slate-300 px-2 py-1.5" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <button onClick={() => assignMutation.mutate()} disabled={!selectedUser || !departmentId || !email || assignMutation.isPending} className="rounded bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
          Assign
        </button>
      </div>
      {assignMutation.isError && <div className="text-xs text-red-600">{(assignMutation.error as any)?.response?.data?.error ?? "Could not assign this role."}</div>}

      <TableFilter value={filterText} onChange={setFilterText} placeholder="Filter assignments…" count={sorted.length} total={assignments.length} />
      <table className="w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-sm">
        <thead className="bg-emerald-50 text-left text-xs tracking-wide text-emerald-800">
          <tr>
            <SortableHeader label="Department" sortKey="department" activeKey={sortKey} dir={sortDir} onToggle={toggle} className="px-3 py-2" />
            <SortableHeader label="Role" sortKey="role" activeKey={sortKey} dir={sortDir} onToggle={toggle} className="px-3 py-2" />
            <SortableHeader label="User" sortKey="user" activeKey={sortKey} dir={sortDir} onToggle={toggle} className="px-3 py-2" />
            <SortableHeader label="Email" sortKey="email" activeKey={sortKey} dir={sortDir} onToggle={toggle} className="px-3 py-2" />
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={a.id} className="border-t border-slate-100">
              <td className="px-3 py-2">{a.department.name}</td>
              <td className="px-3 py-2">{roleLabel(a.roleType)}</td>
              <td className="px-3 py-2">{a.user.name}</td>
              <td className="px-3 py-2 text-slate-500">{a.user.email}</td>
              <td className="px-3 py-2 text-right">
                <button onClick={() => deleteMutation.mutate(a.id)} className="text-xs text-red-600 hover:underline">
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
