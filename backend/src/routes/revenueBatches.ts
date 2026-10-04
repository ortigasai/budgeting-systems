import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { RequestStage, RoleType, Sbu } from "@prisma/client";
import { prisma } from "../prisma";
import { asyncHandler } from "../asyncHandler";
import { hasRole, hasSbuRole, requireAuth } from "../middleware/auth";
import { HttpError } from "../httpError";
import { assertSfSbu } from "../lib/groupScope";
import { parseRevenueTemplate } from "../lib/revenueTemplate";
import { fetchCcGlOptions } from "../lib/pyBackendClient";
import { assertCycleOpen, cancelRevenueBatch, revenueBatchDecision, submitRevenueBatch } from "../services/workflowService";

// Spec item 16 - Revenue's own per-CC-GL template upload. A separate router
// (not nested under budgetRequestsRouter) since the whole shape is different
// from GAE/DOE/NPC: one upload creates a *batch* of BudgetRequest rows (one
// per CC-GL) that always travel through the SBU-role approval chain
// together (see workflowService.ts's revenue* functions) - individually
// they'd desync from their siblings, so every mutation here acts on the
// batch as a whole.
export const revenueBatchesRouter = Router();

revenueBatchesRouter.use(requireAuth);

const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Note 11 §6 - live-generated replacement for the old static
// RevenueBudgetRequestTemplate.xlsx checked-in file. Same exact layout the
// static file had (row 1 = SUBTOTAL grand total, row 2 = CC/GL/Jan-Dec/Total
// header, data from row 3) so lib/revenueTemplate.ts's parseRevenueTemplate
// - the upload contract - needs no change at all; the only addition is CC/GL
// Data Validation dropdowns sourced from Python's admin-maintained master
// lists (Note 11 §7's first real use of pyBackendClient), so a Requestor
// picks valid codes instead of typing them freehand.
revenueBatchesRouter.get(
  "/template",
  asyncHandler(async (_req, res) => {
    const { costCenters, glAccounts } = await fetchCcGlOptions();

    const workbook = new ExcelJS.Workbook();
    const refSheet = workbook.addWorksheet("Reference", { state: "veryHidden" });
    costCenters.forEach((c, i) => {
      refSheet.getCell(i + 1, 1).value = c.code;
    });
    glAccounts.forEach((g, i) => {
      refSheet.getCell(i + 1, 2).value = g.code;
    });

    const sheet = workbook.addWorksheet("Sheet1");
    sheet.getCell("O1").value = { formula: "SUBTOTAL(9,O3:O1048576)" } as any;
    sheet.getRow(2).values = ["CC", "GL", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "Total"];
    sheet.getColumn(1).width = 10.9;
    sheet.getColumn(15).width = 13.8;

    const lastRow = 1002;
    for (let r = 3; r <= lastRow; r++) {
      if (costCenters.length > 0) {
        sheet.getCell(`A${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [`Reference!$A$1:$A$${costCenters.length}`] };
      }
      if (glAccounts.length > 0) {
        sheet.getCell(`B${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [`Reference!$B$1:$B$${glAccounts.length}`] };
      }
      sheet.getCell(`O${r}`).value = { formula: `SUM(C${r}:N${r})` } as any;
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="Budgeting System_Revenue Budget Request Template.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  })
);

const uploadFieldsSchema = z.object({
  sbu: z.nativeEnum(Sbu),
  companyId: z.string().min(1),
  fiscalYear: z.coerce.number().int(),
});

async function assertBoardBudgetTiesOut(fiscalYear: number, sbu: Sbu, grandTotal: number) {
  const board = await prisma.boardApprovedBudget.findFirst({
    where: { fiscalYear, requestCategory: "REVENUE", sbu },
    orderBy: { setAt: "desc" },
  });
  if (!board) {
    throw new HttpError(
      400,
      `The Budget Officer must set the ${fiscalYear} Board-Approved Budget for this SBU before Revenue requests can be created.`
    );
  }
  if (Math.round(Math.abs(board.amount - grandTotal) * 100) / 100 > 0.01) {
    throw new HttpError(
      400,
      `The template's total (₱${grandTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}) does not tie up with the ${fiscalYear} Board-Approved Budget for this SBU (₱${board.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}). Fix the template and re-upload.`
    );
  }
  return board;
}

async function createBatchRows(
  batchId: string,
  departmentId: string,
  fiscalYear: number,
  sbu: Sbu,
  companyId: string,
  companyName: string,
  createdById: string,
  parsedRows: { costCenter: string; glAccount: string; monthlyAmounts: number[]; total: number }[]
) {
  for (const row of parsedRows) {
    const lineItem = await prisma.expenseLineItem.create({
      data: {
        name: `Revenue - CC ${row.costCenter} / GL ${row.glAccount}`,
        glAccount: row.glAccount,
        costCenter: row.costCenter,
        category: "Revenue",
        ownerDepartmentId: departmentId,
        companyId,
        isCustom: true,
        status: "PENDING_REFINEMENT",
      },
    });
    await prisma.budgetRequest.create({
      data: {
        departmentId,
        fiscalYear,
        expenseLineItemId: lineItem.id,
        monthlyAmounts: row.monthlyAmounts,
        proposedAmount: row.total,
        businessJustification: `Revenue Budget Request - ${sbu} / ${companyName} - CC ${row.costCenter} / GL ${row.glAccount}`,
        requestCategory: "REVENUE",
        sbu,
        bulkUploadBatchId: batchId,
        createdById,
      },
    });
  }
}

revenueBatchesRouter.post(
  "/",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "Upload the completed Revenue Budget Request Template.");
    await assertCycleOpen();

    const departmentId = req.user!.departmentId;
    if (!departmentId) throw new HttpError(400, "Your account has no assigned department to originate a request from.");

    const { sbu, companyId, fiscalYear } = uploadFieldsSchema.parse(req.body);
    await assertSfSbu(req.user!, sbu);
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } }).catch(() => {
      throw new HttpError(400, "Unrecognized Company selection.");
    });

    const parsed = await parseRevenueTemplate(req.file.buffer);
    const board = await assertBoardBudgetTiesOut(fiscalYear, sbu, parsed.grandTotal);

    const fileName = `${crypto.randomUUID()}-${req.file.originalname}`;
    fs.writeFileSync(path.join(uploadDir, fileName), req.file.buffer);

    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.bulkUploadBatch.create({
        data: {
          uploadedById: req.user!.id,
          departmentId,
          fiscalYear,
          sourceFileRef: fileName,
          rowCount: parsed.rows.length,
          status: "COMPLETED",
          sbu,
          companyId,
          boardApprovedAmountAtUpload: board.amount,
        },
      });
      return created;
    });

    await createBatchRows(batch.id, departmentId, fiscalYear, sbu, companyId, company.name, req.user!.id, parsed.rows);

    res.status(201).json(await loadBatchDetail(batch.id));
  })
);

revenueBatchesRouter.post(
  "/:id/upload",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "Upload the completed Revenue Budget Request Template.");
    const batch = await prisma.bulkUploadBatch.findUniqueOrThrow({ where: { id: req.params.id } });
    if (batch.uploadedById !== req.user!.id) {
      throw new HttpError(403, "You can only override your own requests.");
    }
    const existingRows = await prisma.budgetRequest.findMany({ where: { bulkUploadBatchId: batch.id } });
    if (existingRows.some((r) => r.currentStage !== RequestStage.DRAFT)) {
      throw new HttpError(409, "This request has already been sent for review and can no longer be overridden - cancel it and create a new one instead.");
    }
    if (!batch.sbu || !batch.companyId) throw new HttpError(500, "Batch is missing its SBU/Company.");
    const company = await prisma.company.findUniqueOrThrow({ where: { id: batch.companyId } });

    const parsed = await parseRevenueTemplate(req.file.buffer);
    const board = await assertBoardBudgetTiesOut(batch.fiscalYear, batch.sbu, parsed.grandTotal);

    const fileName = `${crypto.randomUUID()}-${req.file.originalname}`;
    fs.writeFileSync(path.join(uploadDir, fileName), req.file.buffer);

    await prisma.$transaction([
      prisma.budgetRequest.deleteMany({ where: { bulkUploadBatchId: batch.id } }),
      prisma.bulkUploadBatch.update({
        where: { id: batch.id },
        data: { sourceFileRef: fileName, rowCount: parsed.rows.length, boardApprovedAmountAtUpload: board.amount },
      }),
    ]);
    await createBatchRows(batch.id, batch.departmentId, batch.fiscalYear, batch.sbu, batch.companyId, company.name, req.user!.id, parsed.rows);

    res.json(await loadBatchDetail(batch.id));
  })
);

revenueBatchesRouter.post(
  "/:id/submit",
  asyncHandler(async (req, res) => {
    const batch = await prisma.bulkUploadBatch.findUniqueOrThrow({ where: { id: req.params.id } });
    if (batch.uploadedById !== req.user!.id) {
      throw new HttpError(403, "You can only submit your own requests.");
    }
    await submitRevenueBatch(batch.id);
    res.json(await loadBatchDetail(batch.id));
  })
);

revenueBatchesRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    await cancelRevenueBatch(req.params.id, req.user!.id);
    res.json(await loadBatchDetail(req.params.id));
  })
);

async function batchSummary(batch: { id: string; fiscalYear: number; sbu: Sbu | null; companyId: string | null; sourceFileRef: string; boardApprovedAmountAtUpload: number | null; createdAt: Date }) {
  const rows = await prisma.budgetRequest.findMany({
    where: { bulkUploadBatchId: batch.id },
    include: { expenseLineItem: true },
  });
  const company = batch.companyId ? await prisma.company.findUnique({ where: { id: batch.companyId } }) : null;
  return {
    id: batch.id,
    fiscalYear: batch.fiscalYear,
    sbu: batch.sbu,
    company: company ? { id: company.id, name: company.name, code: company.code } : null,
    sourceFileRef: batch.sourceFileRef,
    boardApprovedAmountAtUpload: batch.boardApprovedAmountAtUpload,
    rowCount: rows.length,
    totalAmount: rows.reduce((sum, r) => sum + r.proposedAmount, 0),
    currentStage: rows[0]?.currentStage ?? RequestStage.CANCELLED,
    status: rows[0]?.status ?? "CANCELLED",
    createdAt: batch.createdAt,
  };
}

async function loadBatchDetail(batchId: string) {
  const batch = await prisma.bulkUploadBatch.findUniqueOrThrow({ where: { id: batchId }, include: { uploadedBy: true } });
  const summary = await batchSummary(batch);
  const rows = await prisma.budgetRequest.findMany({
    where: { bulkUploadBatchId: batchId },
    include: { expenseLineItem: true },
    orderBy: { createdAt: "asc" },
  });
  // Every row in a batch always carries an identical set of decisions (see
  // revenueBatchDecision) - showing just the first row's history avoids
  // displaying the same "APPROVE at ..." line once per CC-GL row.
  const reviewDecisions = rows[0]
    ? await prisma.reviewDecision.findMany({
        where: { budgetRequestId: rows[0].id },
        include: { decidedBy: true },
        orderBy: { timestamp: "asc" },
      })
    : [];
  return {
    ...summary,
    uploadedByName: batch.uploadedBy.name,
    rows: rows.map((r) => ({
      id: r.id,
      costCenter: r.expenseLineItem!.costCenter,
      glAccount: r.expenseLineItem!.glAccount,
      monthlyAmounts: r.monthlyAmounts,
      proposedAmount: r.proposedAmount,
    })),
    reviewDecisions: reviewDecisions.map((d) => ({
      id: d.id,
      stage: d.stage,
      decision: d.decision,
      decidedByName: d.decidedBy.name,
      comment: d.comment,
      timestamp: d.timestamp,
    })),
  };
}

revenueBatchesRouter.get(
  "/mine",
  asyncHandler(async (req, res) => {
    // sbu alone no longer uniquely identifies a Revenue batch - DOE's own
    // batch upload (doeBatches.ts) also sets it now, so every list here
    // additionally requires at least one REVENUE-category row.
    const batches = await prisma.bulkUploadBatch.findMany({
      where: { uploadedById: req.user!.id, sbu: { not: null }, budgetRequests: { some: { requestCategory: "REVENUE" } } },
      orderBy: { createdAt: "desc" },
    });
    res.json(await Promise.all(batches.map(batchSummary)));
  })
);

const REVENUE_STAGE_ROLE_CHECK: Partial<Record<RequestStage, (req: import("express").Request, sbu: Sbu | null) => boolean>> = {
  [RequestStage.REVENUE_BU_FINANCE_OFFICER_REVIEW]: (req, sbu) => hasSbuRole(req.user, RoleType.BU_FINANCE_OFFICER, sbu ?? undefined),
  [RequestStage.REVENUE_BU_FINANCE_HEAD_REVIEW]: (req, sbu) => hasSbuRole(req.user, RoleType.BU_FINANCE_HEAD, sbu ?? undefined),
  [RequestStage.REVENUE_BUDGET_OFFICER_REVIEW]: (req) => hasRole(req.user, RoleType.BUDGET_OFFICER),
  [RequestStage.REVENUE_BCA_HEAD_REVIEW]: (req) => hasRole(req.user, RoleType.BCA_HEAD),
};

revenueBatchesRouter.get(
  "/inbox",
  asyncHandler(async (req, res) => {
    const batches = await prisma.bulkUploadBatch.findMany({ where: { sbu: { not: null }, budgetRequests: { some: { requestCategory: "REVENUE" } } }, orderBy: { createdAt: "asc" } });
    const summaries = await Promise.all(batches.map(batchSummary));
    const mine = summaries.filter((s) => {
      const check = REVENUE_STAGE_ROLE_CHECK[s.currentStage];
      return check ? check(req, s.sbu) : false;
    });
    res.json(mine);
  })
);

// Mirrors budget-requests'/forecast's own /reviewed-by-me — this user's
// past Revenue batch decisions, most recent first. A batch's decisions live
// on its first BudgetRequest row (every row in a batch carries an identical
// set - see loadBatchDetail's own comment), so "did I review this batch" is
// resolved the same way there is.
revenueBatchesRouter.get(
  "/reviewed-by-me",
  asyncHandler(async (req, res) => {
    const batches = await prisma.bulkUploadBatch.findMany({ where: { sbu: { not: null }, budgetRequests: { some: { requestCategory: "REVENUE" } } }, orderBy: { createdAt: "desc" } });
    const withDecisions = await Promise.all(
      batches.map(async (batch) => {
        const summary = await batchSummary(batch);
        const firstRow = await prisma.budgetRequest.findFirst({ where: { bulkUploadBatchId: batch.id }, orderBy: { createdAt: "asc" } });
        const decisions = firstRow
          ? await prisma.reviewDecision.findMany({ where: { budgetRequestId: firstRow.id, decidedById: req.user!.id }, include: { decidedBy: true }, orderBy: { timestamp: "asc" } })
          : [];
        const myDecision = decisions[decisions.length - 1];
        return myDecision ? { ...summary, myDecision } : null;
      })
    );
    const mine = withDecisions
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .sort((a, b) => b.myDecision.timestamp.getTime() - a.myDecision.timestamp.getTime())
      .slice(0, 20);
    res.json(mine);
  })
);

revenueBatchesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await loadBatchDetail(req.params.id));
  })
);

const decisionSchema = z.object({ decision: z.enum(["APPROVE", "RETURN"]), comment: z.string().optional() });

function decisionRoute(stage: (typeof RequestStage)[keyof typeof RequestStage], roleCheck: (req: import("express").Request, sbu: Sbu | null) => boolean, forbiddenMessage: string) {
  return asyncHandler(async (req: import("express").Request, res: import("express").Response) => {
    const batch = await prisma.bulkUploadBatch.findUniqueOrThrow({ where: { id: req.params.id } });
    if (!roleCheck(req, batch.sbu)) throw new HttpError(403, forbiddenMessage);
    const { decision, comment } = decisionSchema.parse(req.body);
    await revenueBatchDecision(batch.id, stage as any, req.user!.id, decision, comment);
    res.json(await loadBatchDetail(batch.id));
  });
}

revenueBatchesRouter.post(
  "/:id/decisions/bu-finance-officer",
  decisionRoute(RequestStage.REVENUE_BU_FINANCE_OFFICER_REVIEW, (req, sbu) => hasSbuRole(req.user, RoleType.BU_FINANCE_OFFICER, sbu ?? undefined), "You are not the BU Finance Officer for this request's SBU.")
);
revenueBatchesRouter.post(
  "/:id/decisions/bu-finance-head",
  decisionRoute(RequestStage.REVENUE_BU_FINANCE_HEAD_REVIEW, (req, sbu) => hasSbuRole(req.user, RoleType.BU_FINANCE_HEAD, sbu ?? undefined), "You are not the BU Finance Head for this request's SBU.")
);
revenueBatchesRouter.post(
  "/:id/decisions/budget-officer",
  decisionRoute(RequestStage.REVENUE_BUDGET_OFFICER_REVIEW, (req) => hasRole(req.user, RoleType.BUDGET_OFFICER), "You are not a Budget Officer.")
);
revenueBatchesRouter.post(
  "/:id/decisions/bca-head",
  decisionRoute(RequestStage.REVENUE_BCA_HEAD_REVIEW, (req) => hasRole(req.user, RoleType.BCA_HEAD), "You are not the BC&A Head.")
);
