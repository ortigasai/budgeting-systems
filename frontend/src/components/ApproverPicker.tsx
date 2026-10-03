import { useQuery } from "@tanstack/react-query";
import { api, type DemoUser } from "../api/client";
import { SearchableSelect } from "./SearchableSelect";

// "Department Head / Approver" and "SBU or Division Head" - required
// drop-downs on the request submission form (Approval Workflow). The list is
// the employee roster; whoever is picked receives the approval task.
export function ApproverPicker({ label, value, onChange, disabled }: { label: string; value: string; onChange: (userId: string) => void; disabled?: boolean }) {
  const { data: users = [] } = useQuery({
    queryKey: ["auth", "users"],
    queryFn: async () => (await api.get<DemoUser[]>("/auth/users")).data,
  });
  const employees = users.filter((u) => u.isEmployee);
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-600">
        {label} <span className="text-red-500">*</span>
      </label>
      <SearchableSelect
        placeholder="Search employees…"
        options={employees.map((u) => ({ value: u.id, label: u.name, sublabel: u.department?.name }))}
        value={value}
        onChange={onChange}
        disabled={disabled}
        hideUntilTyped
      />
    </div>
  );
}
