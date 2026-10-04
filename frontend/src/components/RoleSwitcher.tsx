import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import { SearchableSelect } from "./SearchableSelect";

// Notes_7: labels follow the "Role" tab of the real "Budgeting System_Employee
// List" file exactly.
const ROLE_LABELS: Record<string, string> = {
  BUDGET_OFFICER: "Budget Officer",
  BCA_HEAD: "BCA Head",
  DEPARTMENT_HEAD: "Department Head",
  DEPARTMENT_PREPARER: "Department Preparer",
  // "Budgeting System_Approval Workflow"'s "Centralized Department Requestor" -
  // renamed from "...Preparer" since this role both creates GAE requests for
  // its department and (per that same file) is who a Centralized Department
  // Requestor's own request gets forwarded through.
  CENTRALIZED_BUDGET_PREPARER: "Centralized Department Requestor/Reviewer",
  CENTRALIZED_FIRST_LEVEL_REVIEWER: "Centralized Department Reviewer",
  CENTRALIZED_DEPARTMENT_HEAD: "Centralized Department Head",
  CFO: "CFO",
  CEO: "CEO",
  HR_ANALYST: "Manpower Preparer",
  // Phase 3 Budget Transfer & Reallocation — SBU-scoped role-type strings
  // stay BU_*, only the displayed label changed to "SBU ..." per the
  // workflow revision.
  BU_FINANCE_HEAD: "SBU Finance Head",
  BU_HEAD: "SBU Head",
  BU_FINANCE_OFFICER: "SBU Finance Officer",
};

export function roleLabel(roleType: string) {
  return ROLE_LABELS[roleType] ?? roleType;
}

// Notes_6 ("Log in account - revise"): a real email+password login form,
// replacing the old "pick any demo user from a list" switcher. Every
// seeded/imported user shares this one testing password - see
// backend/prisma/importEmployees.ts and seed.ts.
const SHARED_TEST_PASSWORD = "Ortigas12345";

// Only ever rendered while logged out (Layout.tsx's login card) - the
// logged-in state is shown by UserMenu instead.
export function RoleSwitcher() {
  const { login, users } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [quickUserId, setQuickUserId] = useState("");

  const doLogin = async (loginEmail: string, loginPassword: string) => {
    const res = await api.post<{ id: string; token: string }>("/auth/login", {
      email: loginEmail,
      password: loginPassword,
    });
    login(res.data.id, res.data.token);
    // The landing page after logging in is always the 4-phase menu ("/"),
    // regardless of what URL happened to be in the address bar - without
    // this, logging in while sitting on a stale deep link (e.g. /phase1
    // left over from before a reload logged you out, since login isn't
    // persisted) would drop you straight back into that page instead.
    navigate("/");
  };

  // Notes_7: "For the purpose of testing, on the log in page, allow
  // selection of users based on the Role Assignments already set by the
  // Budget Officer." Scoped to only users someone has actually assigned a
  // role to (via Admin Console > Role Assignments). Still a real, verified
  // login under the hood (every seeded user shares one known password) -
  // this just skips typing it in, it doesn't skip credential verification.
  const roleAssignedUsers = users.filter((u) => u.isEmployee);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await doLogin(email, password);
    } catch (err: any) {
      setError(err.response?.data?.error ?? "Could not log in.");
    } finally {
      setSubmitting(false);
    }
  };

  const quickLogin = async (userId: string) => {
    setQuickUserId(userId);
    if (!userId) return;
    const picked = roleAssignedUsers.find((u) => u.id === userId);
    if (!picked) return;
    setError(null);
    setSubmitting(true);
    try {
      await doLogin(picked.email, SHARED_TEST_PASSWORD);
    } catch (err: any) {
      setError(err.response?.data?.error ?? "Could not log in.");
      setQuickUserId("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-3">
      {roleAssignedUsers.length > 0 && (
        <div className="flex w-full flex-col gap-2">
          <div className="w-full text-xs font-semibold tracking-wide text-slate-400">Quick login (testing)</div>
          <SearchableSelect
            placeholder="Select an employee…"
            options={roleAssignedUsers.map((u) => ({
              value: u.id,
              label: u.name,
              sublabel: u.department?.name,
            }))}
            value={quickUserId}
            onChange={quickLogin}
            disabled={submitting}
            hideUntilTyped
          />
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <div className="h-px flex-1 bg-slate-200" />
            or log in
            <div className="h-px flex-1 bg-slate-200" />
          </div>
        </div>
      )}
      <form onSubmit={submit} className="flex w-full flex-col gap-2">
        <div className="w-full text-xs font-semibold tracking-wide text-slate-400">Log in</div>
        <input type="email" required autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
        <input type="password" required autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
        {error && <div className="text-xs text-red-600">{error}</div>}
        <button type="submit" disabled={submitting} className="w-full rounded bg-emerald-800 px-2 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
          {submitting ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
