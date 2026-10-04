import { prisma } from "../prisma";

// HR Head Review on Additional Manpower requests goes to one named approver,
// not to whoever holds the Human Resources Centralized Department Head role.
// Matched by email (unique) so the check survives name spelling changes.
export const HR_HEAD_APPROVER_EMAIL = "marybeth.monis@ortigas.com.ph";

export function isHrHeadApprover(user: { email: string }): boolean {
  return user.email.toLowerCase() === HR_HEAD_APPROVER_EMAIL;
}

// Centralized Department Requestor/Reviewer step on Additional Manpower
// requests (HR Analyst Review) is likewise one named reviewer.
export const HR_ANALYST_REVIEWER_EMAIL = "naisa.reyes@ortigas.com.ph";

export function isHrAnalystReviewer(user: { email: string }): boolean {
  return user.email.toLowerCase() === HR_ANALYST_REVIEWER_EMAIL;
}

export async function hrHeadApproverUserId(): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { email: HR_HEAD_APPROVER_EMAIL }, select: { id: true } });
  return user?.id ?? null;
}
