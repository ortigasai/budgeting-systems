import type { BulkUploadBatch } from "@prisma/client";
import { prisma } from "../prisma";
import { HttpError } from "../httpError";
import type { AuthedUser } from "../middleware/auth";
import { ACTIVE_STAGES } from "../services/approvalChain";
import { userCanAct } from "../services/workflowService";

// Deliberately stricter than GET /budget-requests/:id (which has no
// ownership check at all): downloading a bulk upload's original file is
// gated to the uploader, or anyone who can currently see one of the batch's
// resulting requests through an existing surface - My Requests, Inbox, or
// Reviewed by Me - reusing exactly those routes' own visibility rules
// rather than inventing a new one.
export async function assertCanAccessBulkUploadBatch(user: AuthedUser, batch: BulkUploadBatch) {
  if (batch.uploadedById === user.id) return;

  const rows = await prisma.budgetRequest.findMany({
    where: { bulkUploadBatchId: batch.id },
    include: { expenseLineItem: true, reviewDecisions: true },
  });

  const ok = rows.some(
    (r) =>
      r.createdById === user.id ||
      (ACTIVE_STAGES.includes(r.currentStage) && userCanAct(user, r)) ||
      r.reviewDecisions.some((d) => d.decidedById === user.id)
  );
  if (!ok) throw new HttpError(403, "You don't have access to this upload.");
}
