import { NPC_GROUP_SCOPE_TO_SBU, type DemoUser } from "../api/client";

// SBUs a person is limited to by their User Management group memberships; null = not limited.
// (The Budget Officer is never limited - callers pass isBudgetOfficer.)
// Mirrors backend/src/lib/groupScope.ts's SF_EXCLUDED_SBUS - Corporate-scoped
// SBU Finance members get an empty list here (no SBU Budget access at all).
const SF_EXCLUDED_SBUS = ["CORPORATE"];

export function sfSbus(user: DemoUser | null, isBudgetOfficer: boolean): string[] | null {
  if (isBudgetOfficer || !user) return null;
  const s = user.groups.filter((g) => g.group === "SF").map((g) => g.scope.toUpperCase());
  if (s.length === 0) return null;
  return [...new Set(s)].filter((x) => !SF_EXCLUDED_SBUS.includes(x));
}

export function npcGroupSbus(user: DemoUser | null, isBudgetOfficer: boolean): string[] | null {
  if (isBudgetOfficer || !user) return null;
  const s = user.groups.filter((g) => g.group === "NPC").map((g) => NPC_GROUP_SCOPE_TO_SBU[g.scope]).filter(Boolean);
  return s.length > 0 ? [...new Set(s)] : null;
}
