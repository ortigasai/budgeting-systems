import { DueDateStage, RequestStage, ReviewDecisionType } from "@prisma/client";
import { prisma } from "../prisma";
import { HttpError } from "../httpError";
import { computeDepartmentalCap } from "./budgetCalcService";
import { determineRequiresCfoApproval } from "./mobilePolicyService";
import { getFiscalCycle } from "../lib/fiscalCycle";
import { uploadCostCenterPlanning } from "./sapMockAdapter";
import type { AuthedUser } from "../middleware/auth";
import { assigneeForStage, canActOnStage, chainFor, nextStageAfter, previousStageBefore, type ChainRequest } from "./approvalChain";

const DUE_DATE_STAGE_LABELS: Record<DueDateStage, string> = {
  FINALIZE_FORECAST: "Finalize Forecast",
  REQUEST_AND_AUTHORIZATION: "Departmental Request Creation & Authorization",
  CENTRALIZED_L1_REVIEW: "Centralized First-Level Review",
  CENTRALIZED_HEAD_REVIEW: "Centralized Department Head Review",
  BCA_AND_FINALIZATION: "BC&A Head Approval & Technical Review/Finalization",
};

// Notes_2 item 6: "When a workflow stage's due date passes without action —
// block actions." No-ops if the Budget Officer hasn't configured a due date
// for that stage yet.
export async function assertDueDateNotPassed(stage: DueDateStage) {
  const config = await prisma.workflowStageConfig.findUnique({ where: { stage } });
  if (config && config.dueDate.getTime() < Date.now()) {
    throw new HttpError(
      409,
      `The due date for "${DUE_DATE_STAGE_LABELS[stage]}" (${config.dueDate.toLocaleDateString()}) has passed. The Budget Officer must move the due date before this action can proceed.`
    );
  }
}

// FR-1.15 #2 — the Budget Officer's manual open/close gate on the budget
// cycle. Only blocks creating new requests; requests already in flight are
// unaffected. No config row yet means the cycle defaults to open.
export async function assertCycleOpen() {
  const config = await prisma.fiscalCycleConfig.findUnique({ where: { id: "singleton" } });
  if (config && !config.cycleOpen) {
    throw new HttpError(
      409,
      `The ${config.targetCalendarYear} budget cycle is closed. The Budget Officer must reopen it before new requests can be created.`
    );
  }
}

interface ExtraField {
  label: string;
  required: boolean;
  type?: "TEXT" | "NUMBER" | "DROPDOWN";
  options?: { label: string; value: number | null }[];
}

async function logDecision(
  budgetRequestId: string,
  stage: RequestStage,
  decision: ReviewDecisionType,
  decidedById: string,
  comment?: string | null
) {
  await prisma.reviewDecision.create({
    data: { budgetRequestId, stage, decision, decidedById, comment: comment ?? null },
  });
}

function requireStage(actual: RequestStage, expected: RequestStage) {
  if (actual !== expected) {
    throw new HttpError(409, `Request is at stage ${actual}, expected ${expected}.`);
  }
}

export async function submitRequest(requestId: string) {
  const request = await prisma.budgetRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { expenseLineItem: true, attachments: true },
  });
  requireStage(request.currentStage, RequestStage.DRAFT);
  if (request.requestCategory === "REVENUE") {
    throw new HttpError(400, "Revenue requests are submitted as a batch - use the Revenue upload flow's Submit action instead.");
  }
  await assertDueDateNotPassed(DueDateStage.REQUEST_AND_AUTHORIZATION);

  if (request.proposedAmount <= 0) {
    const { targetCalendarYear } = await getFiscalCycle();
    throw new HttpError(400, `${targetCalendarYear} Proposed Amount must be greater than 0 to submit.`);
  }
  if (!request.businessJustification?.trim()) {
    throw new HttpError(400, "Business Justification is mandatory.");
  }

  const docThreshold = await prisma.documentationThresholdConfig.findUnique({ where: { id: "singleton" } });
  if (docThreshold && request.proposedAmount > docThreshold.amount && request.attachments.length === 0) {
    throw new HttpError(
      400,
      `Supporting attachments are mandatory for requests over PHP ${docThreshold.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}.`
    );
  }

  const extraFieldsConfig = (request.expenseLineItem?.extraFieldsConfig as unknown as ExtraField[]) ?? [];
  const otherFields = (request.otherRequiredFields as Record<string, string>) ?? {};

  // Mirrors StandardRequestTab.tsx's usesHeadcountTable rule exactly: a
  // Headcount + rate NUMBER pair (Driver/Messenger/Operator, Drivers' Meal
  // Allowance, etc.), no DROPDOWN field. Those line items render the
  // repeatable Headcount & Rate table instead of the flat form, so their
  // values land in otherRequiredFields under "Row N <label>" keys (see
  // headcountRowsToFields) - the plain field.label lookup below would never
  // find them, and always reject a fully-filled-out request.
  const hasDropdownField = extraFieldsConfig.some((f) => f.type === "DROPDOWN");
  const headcountField = extraFieldsConfig.find((f) => f.label === "Headcount");
  const rateField = extraFieldsConfig.find((f) => f.label !== "Headcount" && f.type === "NUMBER");
  const usesHeadcountTable = !!(
    headcountField &&
    rateField &&
    request.expenseLineItem?.spendGridComputation &&
    !hasDropdownField
  );

  if (usesHeadcountTable) {
    const hasCompleteRow = Object.keys(otherFields).some((key) => {
      const match = key.match(/^Row (\d+) Headcount$/);
      if (!match) return false;
      return otherFields[key]?.trim() && otherFields[`Row ${match[1]} ${rateField!.label}`]?.trim();
    });
    if (!hasCompleteRow) {
      throw new HttpError(400, "At least one Headcount & Rate row must be filled out.");
    }
  } else {
    for (const field of extraFieldsConfig) {
      if (field.required && !otherFields[field.label]?.trim()) {
        throw new HttpError(400, `Field "${field.label}" is required for this expense line item.`);
      }
    }
  }

  const requiresCfoApproval = await determineRequiresCfoApproval(extraFieldsConfig as any, otherFields);

  // A Centralized Department Requestor initiating a GAE request for their own
  // centralized department has no separate Department Head - their own Submit
  // sends it straight to their Centralized Department Head (see
  // approvalChain.ts's chainFor - no Centralized L1 Review stage).
  let ownDeptInitiated = false;
  if (request.requestCategory === "GAE") {
    const creatorRoles = await prisma.roleAssignment.findMany({
      where: {
        userId: request.createdById,
        departmentId: request.expenseLineItem!.ownerDepartmentId,
        roleType: { in: ["CENTRALIZED_BUDGET_PREPARER", "CENTRALIZED_FIRST_LEVEL_REVIEWER"] },
      },
    });
    ownDeptInitiated = creatorRoles.length > 0;
  }
  const chainReq = { ...request, requiresCfoApproval, ownDeptInitiated };
  const chain = chainFor(chainReq);
  if (chain[0] === RequestStage.DEPT_HEAD_REVIEW && !request.departmentHeadId) {
    throw new HttpError(400, 'Select a "Department Head / Approver" for this request.');
  }
  if (chain.includes(RequestStage.SBU_HEAD_REVIEW) && !request.sbuHeadId) {
    throw new HttpError(400, 'Select an "SBU or Division Head" for this request.');
  }
  if (ownDeptInitiated && !request.centralizedHeadId) {
    throw new HttpError(400, 'Select a "Centralized Department Head" for this request.');
  }
  return prisma.budgetRequest.update({
    where: { id: requestId },
    data: { currentStage: chain[0], status: "IN_REVIEW", requiresCfoApproval, ownDeptInitiated, assigneeId: assigneeForStage(chainReq, chain[0]) },
  });
}




const DUE_DATE_BY_STAGE: Partial<Record<RequestStage, DueDateStage>> = {
  [RequestStage.DEPT_HEAD_REVIEW]: DueDateStage.REQUEST_AND_AUTHORIZATION,
  [RequestStage.CENTRALIZED_L1_REVIEW]: DueDateStage.CENTRALIZED_L1_REVIEW,
  [RequestStage.CENTRALIZED_HEAD_REVIEW]: DueDateStage.CENTRALIZED_HEAD_REVIEW,
  [RequestStage.BUDGET_OFFICER_VALIDATION]: DueDateStage.BCA_AND_FINALIZATION,
  [RequestStage.BCA_HEAD_REVIEW]: DueDateStage.BCA_AND_FINALIZATION,
  [RequestStage.BUDGET_OFFICER_REVIEW]: DueDateStage.BCA_AND_FINALIZATION,
};

async function loadForChain(requestId: string) {
  return prisma.budgetRequest.findUniqueOrThrow({ where: { id: requestId }, include: { expenseLineItem: true } });
}

/** Whether `user` may act on the request's current stage - drives the Inbox and the decision buttons. */
export function userCanAct(user: AuthedUser, request: ChainRequest & { currentStage: RequestStage }) {
  return canActOnStage(user, request, request.currentStage);
}

function assertCanAct(user: AuthedUser, request: ChainRequest & { currentStage: RequestStage }) {
  if (!canActOnStage(user, request, request.currentStage)) {
    throw new HttpError(403, "This request is not assigned to you at its current stage.");
  }
}

function moveTo(request: ChainRequest, stage: RequestStage | null) {
  if (stage === null) return { currentStage: RequestStage.DRAFT, status: "RETURNED" as const, assigneeId: null };
  return { currentStage: stage, assigneeId: assigneeForStage(request, stage) };
}

/**
 * The actions available at every stage of the approval chain: proceed to the
 * next stage, return to the previous stage, or return to the requestor.
 * (Finalize & Upload at the last stage stays in finalizeAtStep5.)
 */
export async function decideRequest(
  requestId: string,
  user: AuthedUser,
  decision: "APPROVE" | "RETURN_PREVIOUS" | "RETURN_REQUESTOR",
  comment?: string
) {
  const request = await loadForChain(requestId);
  assertCanAct(user, request);
  const stage = request.currentStage;
  if (stage === RequestStage.BUDGET_OFFICER_REVIEW && decision === "APPROVE") {
    throw new HttpError(409, "Use Finalize & Upload in Budget Finalization to complete this request.");
  }
  const dueDate = DUE_DATE_BY_STAGE[stage];
  if (dueDate) await assertDueDateNotPassed(dueDate);

  if (decision !== "APPROVE") {
    if (!comment?.trim()) throw new HttpError(400, "A reason is required to return this request.");
    await logDecision(requestId, stage, "RETURN", user.id, comment);
    const target = decision === "RETURN_REQUESTOR" ? null : previousStageBefore(request, stage);
    return prisma.budgetRequest.update({ where: { id: requestId }, data: moveTo(request, target) });
  }

  if (stage === RequestStage.CENTRALIZED_L1_REVIEW) {
    // GAE-only stage - SBU-batch categories (raw Cost Center/GL Account) never reach it.
    const { forecastYear } = await getFiscalCycle();
    // isForecastCompleteForDepartment only ever becomes true via the full
    // per-department Submit -> Head Review -> Budget Officer Review chain
    // (forecastWorkflowService.ts's budgetOfficerDecision is the only place
    // that sets HistoricalActuals.forecastCompletedAt). 2026 never runs that
    // chain at all - the Budget Officer enters it directly via Upload
    // Completed Template instead (same restriction as PATCH
    // /forecast/entries/:id and POST /forecast/:departmentId/submit above),
    // so this gate would otherwise block every GAE request at this stage
    // for the entire cycle regardless of how complete the uploaded data is.
    // Keyed off forecastYear, not hardcoded, so it lifts on its own once the
    // cycle rolls to forecastYear 2027 and the normal per-department
    // approval chain resumes.
    const forecastReady = forecastYear === 2026 || (await isForecastCompleteForDepartment(request.expenseLineItem!.ownerDepartmentId));
    if (!forecastReady) {
      throw new HttpError(
        409,
        `The ${forecastYear} Remaining Months Forecast must be completed for this department before Centralized Department Requestor/Reviewer review can proceed.`
      );
    }
  }
  const next = nextStageAfter(request, stage);
  if (!next) throw new HttpError(409, "There is no next stage for this request.");
  await logDecision(requestId, stage, "APPROVE", user.id, comment);
  return prisma.budgetRequest.update({ where: { id: requestId }, data: moveTo(request, next) });
}

/** Hand the current stage to any other person (the workbook: "reassign current stage to anyone"). */
export async function reassignRequest(requestId: string, user: AuthedUser, assigneeId: string, comment?: string) {
  const request = await loadForChain(requestId);
  assertCanAct(user, request);
  const target = await prisma.user.findUnique({ where: { id: assigneeId } });
  if (!target) throw new HttpError(400, "Unknown user.");
  await logDecision(requestId, request.currentStage, "REASSIGN", user.id, `Reassigned to ${target.name}${comment ? ` - ${comment}` : ""}`);
  return prisma.budgetRequest.update({ where: { id: requestId }, data: { assigneeId } });
}

// The requestor can cancel while the request is still theirs (draft, or before
// its first reviewer has acted); whoever the current stage is assigned to can
// cancel it too ("cancel ticket" is available in all stages).
export async function cancelRequest(requestId: string, user: AuthedUser, comment?: string) {
  const request = await loadForChain(requestId);
  if (request.requestCategory === "REVENUE") {
    throw new HttpError(400, "Revenue requests are cancelled as a batch - use the Revenue upload flow's Cancel action instead.");
  }
  if (request.currentStage === RequestStage.APPROVED || request.currentStage === RequestStage.CANCELLED || request.currentStage === RequestStage.REJECTED) {
    throw new HttpError(409, "This request is already closed.");
  }
  const isRequestorWhileTheirs =
    request.createdById === user.id && (request.currentStage === RequestStage.DRAFT || request.currentStage === chainFor(request)[0]);
  if (!isRequestorWhileTheirs && !canActOnStage(user, request, request.currentStage)) {
    throw new HttpError(403, "You can only cancel your own request before it has been acted on, or a request assigned to you.");
  }
  if (request.currentStage !== RequestStage.DRAFT) {
    await logDecision(requestId, request.currentStage, "CANCEL", user.id, comment ?? null);
  }
  return prisma.budgetRequest.update({
    where: { id: requestId },
    data: { currentStage: RequestStage.CANCELLED, status: "CANCELLED", assigneeId: null },
  });
}

export async function isForecastCompleteForDepartment(departmentId: string) {
  const rows = await prisma.historicalActuals.findMany({ where: { departmentId } });
  if (rows.length === 0) return false;
  return rows.every((r) => r.forecastCompletedAt !== null);
}




export async function applyBudgetCut(requestId: string, userId: string, cutAmount: number) {
  const request = await prisma.budgetRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { expenseLineItem: true },
  });
  requireStage(request.currentStage, RequestStage.BUDGET_OFFICER_REVIEW);
  await assertDueDateNotPassed(DueDateStage.BCA_AND_FINALIZATION);
  if (cutAmount < 0 || cutAmount > request.proposedAmount) {
    throw new HttpError(400, "Budget cut must be between 0 and the proposed amount.");
  }

  const net = request.proposedAmount - cutAmount;
  // The Departmental Budget Cap (FR-1.4) is a GAE-specific concept, tied to
  // a centralized department's expense line item - the SBU-batch categories
  // (raw Cost Center/GL Account, no catalog line item) have no such cap to
  // check against.
  const isOverBudget = request.expenseLineItem
    ? net > (await computeDepartmentalCap(request.expenseLineItem.ownerDepartmentId, request.fiscalYear)).value
    : false;

  return prisma.budgetRequest.update({
    where: { id: requestId },
    data: {
      budgetCutAmount: cutAmount,
      isOverBudget,
    },
  });
}

export async function returnAtStep5(
  requestId: string,
  userId: string,
  targetStage: Extract<
    RequestStage,
    | "DEPT_HEAD_REVIEW"
    | "CENTRALIZED_L1_REVIEW"
    | "CENTRALIZED_HEAD_REVIEW"
    | "BCA_HEAD_REVIEW"
    | "BUDGET_OFFICER_VALIDATION"
    | "SF_VALIDATION"
    | "SF_HEAD_REVIEW"
    | "SBU_HEAD_REVIEW"
  >,
  reasonCodeId: string
) {
  const request = await prisma.budgetRequest.findUniqueOrThrow({ where: { id: requestId } });
  requireStage(request.currentStage, RequestStage.BUDGET_OFFICER_REVIEW);
  await assertDueDateNotPassed(DueDateStage.BCA_AND_FINALIZATION);

  const reason = await prisma.reasonCode.findUniqueOrThrow({ where: { id: reasonCodeId } });
  await logDecision(requestId, request.currentStage, "RETURN", userId, reason.label);

  return prisma.budgetRequest.update({
    where: { id: requestId },
    data: { currentStage: targetStage, reasonCode: reason.label, assigneeId: assigneeForStage({ ...request, requiresCfoApproval: request.requiresCfoApproval } as any, targetStage) },
  });
}

// Note 11: "Finalize & Upload" is now one click for every category
// (including NPC, which previously had no SAP-upload step at all) - it logs
// the approval, triggers the mock SAP adapter, and writes one
// FinalizedBudgetLine snapshot, all in the same transaction. That snapshot
// (not this row's own currentStage/status) is what every "approved budget"
// reader elsewhere in the system now queries - see budget_balance.py,
// utilization.py, reports.py in backend-py.
export async function finalizeAtStep5(requestId: string, userId: string) {
  const request = await prisma.budgetRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { expenseLineItem: true },
  });
  requireStage(request.currentStage, RequestStage.BUDGET_OFFICER_REVIEW);
  await assertDueDateNotPassed(DueDateStage.BCA_AND_FINALIZATION);

  const amount = request.proposedAmount - request.budgetCutAmount;
  // SBU-batch categories (DOE/Commission/Cost of Sales/Depreciation &
  // Amortization/Interest Expense) carry Cost Center/GL Account directly on
  // the request (no catalog line item) - everything else still reads them
  // off the catalog row.
  const glAccount = request.expenseLineItem?.glAccount ?? request.glAccount;
  const costCenter = request.expenseLineItem?.costCenter ?? request.costCenter;
  if (!glAccount || !costCenter) {
    throw new HttpError(500, "Request is missing its GL Account/Cost Center - cannot finalize.");
  }
  const result = await uploadCostCenterPlanning([
    {
      budgetRequestId: request.id,
      glAccount,
      costCenter,
      fiscalYear: request.fiscalYear,
      monthlyAmounts: request.monthlyAmounts as number[],
    },
  ]);

  return prisma.$transaction(async (tx) => {
    await tx.reviewDecision.create({
      data: { budgetRequestId: requestId, stage: request.currentStage, decision: "APPROVE", decidedById: userId, comment: null },
    });
    const updated = await tx.budgetRequest.update({
      where: { id: requestId },
      data: { currentStage: RequestStage.APPROVED, status: "APPROVED", sapDocumentNumber: result.documentNumber },
    });
    await tx.finalizedBudgetLine.create({
      data: {
        budgetRequestId: requestId,
        fiscalYear: request.fiscalYear,
        requestCategory: request.requestCategory,
        sbu: request.sbu,
        npcSbu: request.npcSbu,
        glAccount,
        costCenter,
        amount,
        sapDocumentNumber: result.documentNumber,
        finalizedById: userId,
      },
    });
    return updated;
  });
}

// ---- Revenue (spec item 16) ----
// Revenue requests are created as a batch (one BudgetRequest per CC-GL row
// of the uploaded template - see routes/revenueBatches.ts), and every row in
// a batch always shares one currentStage: every mutation below acts on the
// whole batch atomically via updateMany, never on an individual row, so
// sibling rows can never drift apart. Its own 4-stage chain (SBU-role-based,
// no Department Head step) - see the RequestStage enum comment in
// schema.prisma for why this can't reuse the shared BCA_HEAD_REVIEW/
// BUDGET_OFFICER_REVIEW values GAE/DOE/NPC use.
const REVENUE_STAGE_ORDER: RequestStage[] = [
  RequestStage.REVENUE_BU_FINANCE_OFFICER_REVIEW,
  RequestStage.REVENUE_BU_FINANCE_HEAD_REVIEW,
  RequestStage.REVENUE_BUDGET_OFFICER_REVIEW,
  RequestStage.REVENUE_BCA_HEAD_REVIEW,
];

async function revenueBatchRows(batchId: string) {
  const rows = await prisma.budgetRequest.findMany({
    where: { bulkUploadBatchId: batchId },
    include: { expenseLineItem: true },
  });
  if (rows.length === 0) throw new HttpError(404, "Revenue batch not found or has no rows.");
  return rows;
}

function requireUniformStage(rows: { currentStage: RequestStage }[], expected: RequestStage) {
  if (!rows.every((r) => r.currentStage === expected)) {
    throw new HttpError(409, `This batch is at stage ${rows[0].currentStage}, expected ${expected}.`);
  }
}

export async function submitRevenueBatch(batchId: string) {
  const rows = await revenueBatchRows(batchId);
  requireUniformStage(rows, RequestStage.DRAFT);
  await assertDueDateNotPassed(DueDateStage.REQUEST_AND_AUTHORIZATION);

  const totalAmount = rows.reduce((sum, r) => sum + r.proposedAmount, 0);
  if (totalAmount <= 0) {
    throw new HttpError(400, "The uploaded template's total amount must be greater than 0 to submit.");
  }

  await prisma.budgetRequest.updateMany({
    where: { bulkUploadBatchId: batchId },
    data: { currentStage: RequestStage.REVENUE_BU_FINANCE_OFFICER_REVIEW, status: "IN_REVIEW" },
  });
  return revenueBatchRows(batchId);
}

export async function revenueBatchDecision(
  batchId: string,
  stage: (typeof REVENUE_STAGE_ORDER)[number],
  userId: string,
  decision: "APPROVE" | "RETURN",
  comment?: string
) {
  const rows = await revenueBatchRows(batchId);
  requireUniformStage(rows, stage);
  await assertDueDateNotPassed(DueDateStage.BCA_AND_FINALIZATION);

  const stageIndex = REVENUE_STAGE_ORDER.indexOf(stage);

  if (decision === "RETURN") {
    if (!comment?.trim()) throw new HttpError(400, "A reason is required to return this batch.");
    const targetStage = stageIndex === 0 ? RequestStage.DRAFT : REVENUE_STAGE_ORDER[stageIndex - 1];
    await prisma.reviewDecision.createMany({
      data: rows.map((r) => ({ budgetRequestId: r.id, stage, decision: "RETURN" as const, decidedById: userId, comment })),
    });
    await prisma.budgetRequest.updateMany({
      where: { bulkUploadBatchId: batchId },
      data: { currentStage: targetStage, status: targetStage === RequestStage.DRAFT ? "RETURNED" : undefined },
    });
    return revenueBatchRows(batchId);
  }

  const isLastStage = stageIndex === REVENUE_STAGE_ORDER.length - 1;

  // Note 11: the batch's terminal approval (REVENUE_BCA_HEAD_REVIEW) is
  // Revenue's "one click" finalize & upload - no separate button, since this
  // was already the only terminal action in its 4-stage chain. Same
  // mock-SAP-adapter-per-line + FinalizedBudgetLine-per-row shape as
  // finalizeAtStep5 above, just batched across every row at once.
  if (isLastStage) {
    const result = await uploadCostCenterPlanning(
      rows.map((r) => ({
        budgetRequestId: r.id,
        glAccount: r.expenseLineItem!.glAccount,
        costCenter: r.expenseLineItem!.costCenter,
        fiscalYear: r.fiscalYear,
        monthlyAmounts: r.monthlyAmounts as number[],
      }))
    );
    await prisma.$transaction(async (tx) => {
      await tx.reviewDecision.createMany({
        data: rows.map((r) => ({ budgetRequestId: r.id, stage, decision: "APPROVE" as const, decidedById: userId, comment: comment ?? null })),
      });
      await tx.budgetRequest.updateMany({
        where: { bulkUploadBatchId: batchId },
        data: { currentStage: RequestStage.APPROVED, status: "APPROVED", sapDocumentNumber: result.documentNumber },
      });
      await tx.finalizedBudgetLine.createMany({
        data: rows.map((r) => ({
          budgetRequestId: r.id,
          fiscalYear: r.fiscalYear,
          requestCategory: r.requestCategory,
          sbu: r.sbu,
          npcSbu: r.npcSbu,
          glAccount: r.expenseLineItem!.glAccount,
          costCenter: r.expenseLineItem!.costCenter,
          amount: r.proposedAmount - r.budgetCutAmount,
          sapDocumentNumber: result.documentNumber,
          finalizedById: userId,
        })),
      });
    });
    return revenueBatchRows(batchId);
  }

  await prisma.reviewDecision.createMany({
    data: rows.map((r) => ({ budgetRequestId: r.id, stage, decision: "APPROVE" as const, decidedById: userId, comment: comment ?? null })),
  });
  await prisma.budgetRequest.updateMany({
    where: { bulkUploadBatchId: batchId },
    data: { currentStage: REVENUE_STAGE_ORDER[stageIndex + 1] },
  });
  return revenueBatchRows(batchId);
}

export async function cancelRevenueBatch(batchId: string, userId: string) {
  const rows = await revenueBatchRows(batchId);
  if (rows.some((r) => r.createdById !== userId)) {
    throw new HttpError(403, "You can only cancel your own requests.");
  }
  requireUniformStage(rows, RequestStage.DRAFT);

  await prisma.budgetRequest.updateMany({
    where: { bulkUploadBatchId: batchId },
    data: { currentStage: RequestStage.CANCELLED, status: "CANCELLED" },
  });
  return revenueBatchRows(batchId);
}
