import { HeadcountRequestStage, RequestStage, RoleType, Sbu } from "@prisma/client";
import { requestSbu } from "../services/approvalChain";
import { prisma } from "../prisma";
import { HR_ANALYST_REVIEWER_EMAIL, HR_HEAD_APPROVER_EMAIL } from "./headcountHrHead";

// Reverse of budgetRequests.ts's STAGE_BY_ROLE (role -> stage) — given a
// stage, which role currently owns it. Department Heads are scoped by the
// request's *originating* department; the centralized roles are scoped by
// the expense line item's *owning* department (matching the /inbox route's
// own scoping, per FR-1.18); BC&A Head/CFO/Budget Officer aren't
// department-scoped at all.
const BUDGET_STAGE_ROLE: Partial<Record<RequestStage, RoleType>> = {
  [RequestStage.DEPT_HEAD_REVIEW]: RoleType.DEPARTMENT_HEAD,
  [RequestStage.CFO_APPROVAL]: RoleType.CFO,
  [RequestStage.CENTRALIZED_L1_REVIEW]: RoleType.CENTRALIZED_FIRST_LEVEL_REVIEWER,
  [RequestStage.CENTRALIZED_HEAD_REVIEW]: RoleType.CENTRALIZED_DEPARTMENT_HEAD,
  [RequestStage.BCA_HEAD_REVIEW]: RoleType.BCA_HEAD,
  [RequestStage.BUDGET_OFFICER_VALIDATION]: RoleType.BUDGET_OFFICER,
  [RequestStage.BUDGET_OFFICER_REVIEW]: RoleType.BUDGET_OFFICER,
};
const DEPARTMENT_SCOPED_ROLES = new Set<RoleType>([RoleType.DEPARTMENT_HEAD]);
const OWNER_DEPARTMENT_SCOPED_ROLES = new Set<RoleType>([
  RoleType.CENTRALIZED_FIRST_LEVEL_REVIEWER,
  RoleType.CENTRALIZED_DEPARTMENT_HEAD,
]);

let humanResourcesDeptIdPromise: Promise<string | null> | null = null;
function humanResourcesDeptId() {
  humanResourcesDeptIdPromise ??= prisma.department
    .findUnique({ where: { name: "Human Resources" } })
    .then((d) => d?.id ?? null);
  return humanResourcesDeptIdPromise;
}

async function reviewerNamesForRole(roleType: RoleType, departmentId: string | null): Promise<string[]> {
  const assignments = await prisma.roleAssignment.findMany({
    where: { roleType, ...(departmentId ? { departmentId } : {}) },
    include: { user: true },
  });
  return [...new Set(assignments.map((a) => a.user.name))];
}

// Who's currently holding up a BudgetRequest, for My Requests' "Pending:
// <name>" display. Empty for stages nobody is actively reviewing (DRAFT,
// terminal stages). An explicit assignment (the Department Head / SBU Head
// dropdown pick, or a reassignment) names one person; otherwise it's whoever
// holds the stage's role for that department / SBU.
export async function resolveBudgetRequestPendingReviewers(request: {
  currentStage: RequestStage;
  departmentId: string;
  assigneeId?: string | null;
  sbu?: Sbu | null;
  npcSbu?: string | null;
  // Null for the SBU-batch categories (raw Cost Center/GL Account, no
  // catalog line item) - never actually read below, since those categories
  // never reach a CENTRALIZED_* stage.
  expenseLineItem: { ownerDepartmentId: string } | null;
}): Promise<string[]> {
  if (request.assigneeId) {
    const u = await prisma.user.findUnique({ where: { id: request.assigneeId }, select: { name: true } });
    return u ? [u.name] : [];
  }
  const stage = request.currentStage;
  if (stage === RequestStage.SF_VALIDATION || stage === RequestStage.SF_HEAD_REVIEW) {
    const sbu = requestSbu({ sbu: request.sbu ?? null, npcSbu: request.npcSbu ?? null });
    const roles = stage === RequestStage.SF_HEAD_REVIEW ? [RoleType.BU_FINANCE_HEAD] : [RoleType.BU_FINANCE_OFFICER, RoleType.BU_FINANCE_HEAD];
    const rows = await prisma.sbuRoleAssignment.findMany({ where: { roleType: { in: roles }, ...(sbu ? { sbu } : {}) }, include: { user: true } });
    return [...new Set(rows.map((r) => r.user.name))];
  }
  const roleType = BUDGET_STAGE_ROLE[stage];
  if (!roleType) return [];

  const departmentId = DEPARTMENT_SCOPED_ROLES.has(roleType)
    ? request.departmentId
    : OWNER_DEPARTMENT_SCOPED_ROLES.has(roleType)
      ? (request.expenseLineItem?.ownerDepartmentId ?? request.departmentId)
      : null;
  return reviewerNamesForRole(roleType, departmentId);
}

// Same idea for AdditionalHeadcountRequest — a separate stage enum/workflow
// (headcountWorkflowService.ts), mirrored from additionalHeadcount.ts's own
// /inbox route rather than BUDGET_STAGE_ROLE above.
export async function resolveHeadcountRequestPendingReviewers(request: {
  currentStage: HeadcountRequestStage;
  departmentId: string;
  departmentHeadId: string | null;
}): Promise<string[]> {
  switch (request.currentStage) {
    case HeadcountRequestStage.DEPT_HEAD_REVIEW: {
      // The Department Head / Approver the requester picked (not a role lookup).
      if (!request.departmentHeadId) return [];
      const picked = await prisma.user.findUnique({ where: { id: request.departmentHeadId }, select: { name: true } });
      return picked ? [picked.name] : [];
    }
    case HeadcountRequestStage.HR_ANALYST_REVIEW: {
      const analyst = await prisma.user.findUnique({ where: { email: HR_ANALYST_REVIEWER_EMAIL }, select: { name: true } });
      return analyst ? [analyst.name] : [];
    }
    case HeadcountRequestStage.HR_HEAD_REVIEW: {
      const hrHead = await prisma.user.findUnique({ where: { email: HR_HEAD_APPROVER_EMAIL }, select: { name: true } });
      return hrHead ? [hrHead.name] : [];
    }
    default:
      return [];
  }
}
