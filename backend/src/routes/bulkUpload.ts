import { Router } from "express";
import ExcelJS from "exceljs";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Prisma, RequestCategory, Sbu } from "@prisma/client";
import { prisma } from "../prisma";
import { asyncHandler } from "../asyncHandler";
import { requireAuth } from "../middleware/auth";
import { HttpError } from "../httpError";
import { assertCycleOpen, submitRequest } from "../services/workflowService";
import { getFiscalCycle } from "../lib/fiscalCycle";
import { nextBudgetCode, sbuBudgetCodePrefix } from "../lib/budgetCode";
import { SBU_BATCH_CATEGORIES } from "../services/approvalChain";
import { sbuBatchCategoryLabel } from "../lib/sbuBatchCategories";
import { fetchCcGlOptions } from "../lib/pyBackendClient";
import { NPC_LOCATION_VALUES, NPC_SBU_VALUES, npcSbuBudgetCodePrefix, type NpcLocation, type NpcSbu } from "../lib/npcSbu";
import { EXPENSE_REQUEST_TEMPLATE_HEADER, parseExpenseRequestSheet, visibleLineItemsForRequest } from "../lib/expenseRequestTemplate";
import { assertCanAccessBulkUploadBatch } from "../lib/bulkUploadAccess";

export const bulkUploadRouter = Router();

bulkUploadRouter.use(requireAuth);

// Same uploads directory/convention doeBatches.ts and revenueBatches.ts
// already persist their source files under - one shared location for every
// uploaded-template's original bytes, regardless of which route created it.
const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
fs.mkdirSync(uploadDir, { recursive: true });

// 1-indexed column number -> Excel column letters (1 -> "A", 27 -> "AA").
function columnLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const HEADER = EXPENSE_REQUEST_TEMPLATE_HEADER;

// Bulk upload is capped well below the exceljs/archiver DoS advisory's blast
// radius (see plan notes) — small spreadsheets only, never arbitrary blobs.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Note 11 §6 - "Open Spreadsheet Template" for GAE (catalog line-item name +
// Jan-Dec). The 5 SBU-batch categories (DOE, Commission, Cost of Sales,
// Depreciation & Amortization, Interest Expense - see routes/doeBatches.ts
// and approvalChain.ts's SBU_BATCH_CATEGORIES) get their own, entirely
// different shape below - real SAP upload data for these is a raw Cost
// Center + GL Account (Cost Element) pair with no catalog line item behind
// it at all (confirmed against "SAP Upload validation.xlsx"'s MallsDOE/
// OfficesDOE/EstatesDOE/RBUcommission/RBUcos/Depreciation/Interest tabs -
// every one of them is Cost Center/Cost Element/Jan-Dec, never a line-item
// name), so this reuses Revenue's exact CC/GL/Jan-Dec/Total template shape
// (see revenueBatches.ts's own "/template" route) rather than GAE's.
// (NPC/Revenue keep their own separate routes below - npc-template and
// revenueBatchesRouter's own "/template" respectively.)

const SBU_BATCH_MONTH_HEADER = ["CC", "GL", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "Total"];

async function writeSbuBatchTemplate(res: import("express").Response, category: RequestCategory, sbu: string, fiscalYear: number) {
  const { costCenters, glAccounts } = await fetchCcGlOptions();

  const workbook = new ExcelJS.Workbook();
  const refSheet = workbook.addWorksheet("Reference", { state: "veryHidden" });
  costCenters.forEach((c, i) => {
    refSheet.getCell(i + 1, 1).value = c.code;
  });
  glAccounts.forEach((g, i) => {
    refSheet.getCell(i + 1, 2).value = g.code;
  });

  const sheetTitle = `${sbu} ${sbuBatchCategoryLabel(category)} Requests ${fiscalYear}`;
  const sheet = workbook.addWorksheet(sheetTitle.slice(0, 31));
  sheet.getCell("O1").value = { formula: "SUBTOTAL(9,O3:O1048576)" } as any;
  sheet.getRow(2).values = SBU_BATCH_MONTH_HEADER;
  sheet.getRow(2).font = { bold: true };
  sheet.getColumn(1).width = 12;
  sheet.getColumn(2).width = 12;
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
  res.setHeader("Content-Disposition", `attachment; filename="budget-request-template-${category.toLowerCase()}-${sbu.toLowerCase()}-${fiscalYear}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
}

bulkUploadRouter.get(
  "/bulk-upload/template",
  asyncHandler(async (req, res) => {
    const { targetCalendarYear } = await getFiscalCycle();
    const fiscalYear = Number(req.query.fiscalYear ?? targetCalendarYear);
    const requestedCategory = req.query.category as string | undefined;
    const category =
      requestedCategory && (SBU_BATCH_CATEGORIES as readonly string[]).includes(requestedCategory)
        ? (requestedCategory as RequestCategory)
        : RequestCategory.GAE;
    const isSbuBatch = (SBU_BATCH_CATEGORIES as readonly RequestCategory[]).includes(category);
    const sbu = req.query.sbu as string | undefined;
    if (isSbuBatch && !sbu) {
      throw new HttpError(400, `Select an SBU before downloading the ${sbuBatchCategoryLabel(category)} template.`);
    }

    if (isSbuBatch) {
      await writeSbuBatchTemplate(res, category, sbu!, fiscalYear);
      return;
    }

    const departmentId = req.user!.departmentId;
    if (!departmentId) throw new HttpError(400, "Your account has no assigned department.");

    const items = await visibleLineItemsForRequest(departmentId);
    const categories = [...new Set(items.map((i) => i.category))].sort((a, b) => a.localeCompare(b));
    const itemsByCategory = new Map<string, typeof items>();
    for (const item of items) {
      const list = itemsByCategory.get(item.category) ?? [];
      list.push(item);
      itemsByCategory.set(item.category, list);
    }

    const workbook = new ExcelJS.Workbook();

    // Hidden list sources for the dropdowns below. Column A/B are the flat
    // category list and full item list (category dropdown, and the Expense
    // Line Item dropdown's fallback before a category is picked). Column C
    // pairs each category with an opaque named-range name ("cat_0", "cat_1",
    // ...) - real category text contains characters Excel defined names
    // can't (&, commas, parentheses), so rather than derive a range name
    // from the text itself, each category gets one of these columns D
    // onward holding just its own items, named via that opaque id, and the
    // Expense Line Item dropdown looks the id up through column C instead
    // of needing to sanitize the category text in a formula.
    const refSheet = workbook.addWorksheet("Reference", { state: "veryHidden" });
    categories.forEach((c, i) => {
      refSheet.getCell(i + 1, 1).value = c;
    });
    items.forEach((item, i) => {
      refSheet.getCell(i + 1, 2).value = item.name;
    });
    categories.forEach((c, i) => {
      const rangeName = `cat_${i}`;
      refSheet.getCell(i + 1, 3).value = rangeName;
      const categoryItems = itemsByCategory.get(c) ?? [];
      const col = 4 + i;
      categoryItems.forEach((item, r) => {
        refSheet.getCell(r + 1, col).value = item.name;
      });
      if (categoryItems.length > 0) {
        const colLetter = columnLetter(col);
        workbook.definedNames.add(`Reference!$${colLetter}$1:$${colLetter}$${categoryItems.length}`, rangeName);
      }
    });
    // One extra lookup-table row, keyed on a blank Expense Category, so the
    // Expense Line Item dropdown falls back to the full catalog before a
    // category is picked - via the same plain VLOOKUP every other row uses,
    // not an IFERROR wrapper. Excel's data validation list evaluator doesn't
    // reliably support IFERROR(INDIRECT(...)) (it was silently always
    // falling through to the fallback, defeating the per-category filter
    // entirely) - a genuine lookup row sidesteps that rather than working
    // around it.
    const blankKeyRow = categories.length + 1;
    refSheet.getCell(blankKeyRow, 3).value = `Reference!$B$1:$B$${items.length}`;

    // Visible, read-only lookup so whoever fills the sheet can see which
    // Expense Line Items belong to which Expense Category, and what each
    // one's Other Required Fields actually are, without leaving Excel or
    // guessing at the JSON shape the upload expects.
    const catalogSheet = workbook.addWorksheet("Catalog Reference");
    catalogSheet.addRow(["Expense Category", "Expense Line Item", "Required Fields (fill into \"Other Required Fields (JSON)\")"]);
    catalogSheet.getRow(1).font = { bold: true };
    for (const item of items) {
      const extraFieldsConfig = (item.extraFieldsConfig as { label: string; required: boolean }[] | null) ?? [];
      const requiredLabels = extraFieldsConfig.filter((f) => f.required).map((f) => f.label);
      catalogSheet.addRow([item.category, item.name, requiredLabels.length > 0 ? requiredLabels.join(", ") : "—"]);
    }
    catalogSheet.columns = [{ width: 28 }, { width: 36 }, { width: 50 }];
    catalogSheet.autoFilter = { from: "A1", to: `C${items.length + 1}` };

    const sheet = workbook.addWorksheet(`Budget Requests ${fiscalYear}`.slice(0, 31));
    sheet.addRow(HEADER);
    sheet.getRow(1).font = { bold: true };

    for (let row = 2; row <= 201; row++) {
      sheet.getCell(`A${row}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`Reference!$A$1:$A$${categories.length}`],
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Invalid Expense Category",
        error: "Pick a category from the dropdown list - see the Catalog Reference sheet for the full list.",
      };
      sheet.getCell(`B${row}`).dataValidation = {
        type: "list",
        allowBlank: true,
        // Filters to the chosen row's Expense Category via the lookup table
        // in Reference!A:C (category text -> either a "cat_N" range name
        // for that category's own items, or - for row blankKeyRow, keyed on
        // a blank category - the full item range as a literal address, same
        // fallback as before cascading existed, before a category is
        // picked).
        formulae: [`INDIRECT(VLOOKUP($A${row},Reference!$A$1:$C$${blankKeyRow},3,FALSE))`],
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Invalid Expense Line Item",
        error: "Pick a line item from the dropdown list for the chosen Expense Category - see the Catalog Reference sheet for the full list.",
      };
    }

    sheet.columns.forEach((col) => {
      col.width = 20;
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="budget-request-template-${category.toLowerCase()}-${fiscalYear}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

// Lets a reviewer download exactly what a Requestor originally uploaded,
// for any of the four bulk-upload flows that persist a batch (GAE/DOE, NPC,
// and - via their own routers - the SBU-batch categories and Revenue, which
// already wrote sourceFileRef as a real on-disk filename before this route
// existed). Batches created before file persistence was added have no real
// file on disk - sourceFileRef is just their original display name - so
// this 404s cleanly for those rather than erroring.
bulkUploadRouter.get(
  "/bulk-upload/:batchId/source-file",
  asyncHandler(async (req, res) => {
    const batch = await prisma.bulkUploadBatch.findUniqueOrThrow({ where: { id: req.params.batchId } });
    await assertCanAccessBulkUploadBatch(req.user!, batch);

    const filePath = path.join(uploadDir, batch.sourceFileRef);
    if (!fs.existsSync(filePath)) {
      throw new HttpError(404, "The original uploaded file isn't available for this upload.");
    }
    // Strip the crypto.randomUUID()-prefix back off so the downloaded file
    // is named the same as what the Requestor originally uploaded.
    const displayName = batch.sourceFileRef.replace(/^[0-9a-f-]{36}-/, "");
    res.download(filePath, displayName);
  })
);

interface RowError {
  row: number;
  error: string;
}

bulkUploadRouter.post(
  "/bulk-upload",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "No file uploaded.");
    await assertCycleOpen();
    const departmentId = req.user!.departmentId;
    if (!departmentId) throw new HttpError(400, "Your account has no assigned department.");

    const { targetCalendarYear } = await getFiscalCycle();
    const fiscalYear = Number(req.body.fiscalYear ?? targetCalendarYear);
    const category = req.body.category === "DOE" ? RequestCategory.DOE : RequestCategory.GAE;
    let sbu: Sbu | undefined;
    if (category === RequestCategory.DOE) {
      if (!Object.values(Sbu).includes(req.body.sbu)) {
        throw new HttpError(400, "Select a valid SBU for this DOE upload.");
      }
      sbu = req.body.sbu as Sbu;
    }

    const workbook = new ExcelJS.Workbook();
    // exceljs's bundled Buffer type predates the current @types/node Buffer
    // generic; the value itself is a plain Node Buffer at runtime.
    await workbook.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    // "Catalog Reference" is a visible read-only lookup sheet that sits
    // before the real data sheet in the template - excluded by name so it's
    // never mistaken for the one the user actually filled in.
    const sheet = workbook.worksheets.find((w) => w.state !== "veryHidden" && w.name !== "Catalog Reference");
    if (!sheet) throw new HttpError(400, "No usable worksheet found in the uploaded file.");

    const standardItems = await visibleLineItemsForRequest(departmentId);
    const itemsByName = new Map(standardItems.map((i) => [i.name.trim().toLowerCase(), i]));

    // Persist the original upload (parsing above already reads it from the
    // in-memory buffer) so a reviewer can download exactly what was
    // submitted later - see the /bulk-upload/:batchId/source-file route.
    const sourceFileName = `${crypto.randomUUID()}-${req.file.originalname}`;
    fs.writeFileSync(path.join(uploadDir, sourceFileName), req.file.buffer);

    const batch = await prisma.bulkUploadBatch.create({
      data: {
        uploadedById: req.user!.id,
        departmentId,
        fiscalYear,
        sourceFileRef: sourceFileName,
        rowCount: 0,
        status: "PROCESSING",
      },
    });

    const parsed = parseExpenseRequestSheet(sheet, itemsByName);
    const errors: RowError[] = [...parsed.errors];
    let created = 0;
    const rowCount = parsed.rowCount;

    for (const parsedRow of parsed.rows) {
      try {
        // DOE gets a fresh Budget Code per row, same as one manual DOE
        // submission via the Save Draft form (lib/budgetCode.ts) - this
        // sheet is many independent DOE requests, not one batch total.
        const budgetCode = sbu ? await nextBudgetCode(sbuBudgetCodePrefix(sbu), targetCalendarYear) : undefined;

        const requestRecord = await prisma.budgetRequest.create({
          data: {
            departmentId,
            fiscalYear,
            expenseLineItemId: parsedRow.lineItem.id,
            monthlyAmounts: parsedRow.monthlyAmounts,
            proposedAmount: parsedRow.proposedAmount,
            businessJustification: parsedRow.businessJustification,
            otherRequiredFields: parsedRow.otherRequiredFields,
            requestCategory: category,
            sbu,
            budgetCode,
            createdById: req.user!.id,
            bulkUploadBatchId: batch.id,
          },
        });

        try {
          await submitRequest(requestRecord.id);
        } catch (submitErr) {
          // Attachment-threshold rows can't auto-submit (no attachment
          // mechanism in the spreadsheet) — leave as a draft the Requestor
          // finishes manually rather than failing the whole row.
          if (!(submitErr instanceof HttpError) || !submitErr.message.includes("attachments")) {
            throw submitErr;
          }
        }

        created++;
      } catch (err) {
        errors.push({ row: parsedRow.row, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }

    const status = errors.length === 0 ? "COMPLETED" : created > 0 ? "COMPLETED_WITH_ERRORS" : "FAILED";
    const updatedBatch = await prisma.bulkUploadBatch.update({
      where: { id: batch.id },
      data: { rowCount, validationErrors: errors as unknown as Prisma.InputJsonValue, status },
    });

    res.status(201).json({ batch: updatedBatch, created, errors });
  })
);

// Note 11 §6 - NPC's "Open Spreadsheet Template". NPC's required-fields set
// is entirely different from GAE/DOE (spec item 12 - no expense line item
// picker, spend grid, or Business Justification; see NpcRequestTab.tsx/
// budgetRequestsRouter's NPC branch), so this is its own sheet shape, not a
// variant of the one above. `npcSbu` and fiscal year are one-per-sheet
// (passed at download and re-supplied at upload), like DOE's `sbu` above;
// Location and every other field are per-row.
const NPC_HEADER = ["Location", "Project Title", "Project Start (YYYY-MM-DD)", "Project End (YYYY-MM-DD)", "Cost Center", "Amount (VAT exclusive)"];

bulkUploadRouter.get(
  "/npc-template",
  asyncHandler(async (req, res) => {
    const { targetCalendarYear } = await getFiscalCycle();
    const fiscalYear = Number(req.query.fiscalYear ?? targetCalendarYear);
    const npcSbu = req.query.npcSbu as string | undefined;
    if (!npcSbu || !(NPC_SBU_VALUES as readonly string[]).includes(npcSbu)) {
      throw new HttpError(400, "Select a valid NPC SBU before downloading the template.");
    }

    const workbook = new ExcelJS.Workbook();
    const refSheet = workbook.addWorksheet("Reference", { state: "veryHidden" });
    NPC_LOCATION_VALUES.forEach((loc, i) => {
      refSheet.getCell(i + 1, 1).value = loc;
    });

    const sheet = workbook.addWorksheet(`${npcSbu} NPC Requests ${fiscalYear}`.slice(0, 31));
    sheet.addRow(NPC_HEADER);
    sheet.getRow(1).font = { bold: true };

    for (let row = 2; row <= 201; row++) {
      sheet.getCell(`A${row}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`Reference!$A$1:$A$${NPC_LOCATION_VALUES.length}`],
      };
      sheet.getCell(`C${row}`).numFmt = "yyyy-mm-dd";
      sheet.getCell(`D${row}`).numFmt = "yyyy-mm-dd";
      sheet.getCell(`F${row}`).numFmt = "#,##0.00";
    }
    sheet.columns.forEach((col) => {
      col.width = 22;
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="npc-request-template-${npcSbu.toLowerCase()}-${fiscalYear}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

bulkUploadRouter.post(
  "/npc-template-upload",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "No file uploaded.");
    await assertCycleOpen();
    const departmentId = req.user!.departmentId;
    if (!departmentId) throw new HttpError(400, "Your account has no assigned department.");

    const { targetCalendarYear } = await getFiscalCycle();
    const fiscalYear = Number(req.body.fiscalYear ?? targetCalendarYear);
    const npcSbu = req.body.npcSbu as string | undefined;
    if (!npcSbu || !(NPC_SBU_VALUES as readonly string[]).includes(npcSbu)) {
      throw new HttpError(400, "Select a valid NPC SBU for this upload.");
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets.find((w) => w.state !== "veryHidden");
    if (!sheet) throw new HttpError(400, "No usable worksheet found in the uploaded file.");

    const sourceFileName = `${crypto.randomUUID()}-${req.file.originalname}`;
    fs.writeFileSync(path.join(uploadDir, sourceFileName), req.file.buffer);

    const batch = await prisma.bulkUploadBatch.create({
      data: {
        uploadedById: req.user!.id,
        departmentId,
        fiscalYear,
        sourceFileRef: sourceFileName,
        rowCount: 0,
        status: "PROCESSING",
      },
    });

    const errors: RowError[] = [];
    let created = 0;
    let rowCount = 0;

    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const projectTitle = String(row.getCell(2).value ?? "").trim();
      if (!projectTitle) continue; // blank row, not counted

      rowCount++;

      try {
        const location = String(row.getCell(1).value ?? "").trim();
        if (!(NPC_LOCATION_VALUES as readonly string[]).includes(location)) {
          throw new Error(`Location "${location}" is not one of ${NPC_LOCATION_VALUES.join("/")}.`);
        }
        const startRaw = row.getCell(3).value;
        const endRaw = row.getCell(4).value;
        const projectStartDate = startRaw instanceof Date ? startRaw : new Date(String(startRaw ?? ""));
        const projectEndDate = endRaw instanceof Date ? endRaw : new Date(String(endRaw ?? ""));
        if (Number.isNaN(projectStartDate.getTime()) || Number.isNaN(projectEndDate.getTime())) {
          throw new Error("Project Start and Project End must be valid dates.");
        }
        const costCenter = String(row.getCell(5).value ?? "").trim();
        if (!costCenter) throw new Error("Cost Center is mandatory.");
        const amount = Number(row.getCell(6).value ?? 0);
        if (Number.isNaN(amount) || amount <= 0) throw new Error("Amount must be a positive number.");

        const budgetCode = await nextBudgetCode(npcSbuBudgetCodePrefix(npcSbu as NpcSbu), targetCalendarYear);
        const expenseLineItem = await prisma.expenseLineItem.create({
          data: {
            name: projectTitle,
            glAccount: "PENDING",
            costCenter,
            category: "Non-Project Capex",
            ownerDepartmentId: departmentId,
            isCustom: true,
            status: "PENDING_REFINEMENT",
          },
        });
        const monthlyAmounts = Array(12).fill(0);
        monthlyAmounts[0] = amount;

        const requestRecord = await prisma.budgetRequest.create({
          data: {
            departmentId,
            fiscalYear,
            expenseLineItemId: expenseLineItem.id,
            monthlyAmounts,
            proposedAmount: amount,
            businessJustification: `NPC Project: ${projectTitle}`,
            otherRequiredFields: {},
            requestCategory: "NPC",
            npcSbu,
            npcLocation: location as NpcLocation,
            projectTitle,
            projectStartDate,
            projectEndDate,
            budgetCode,
            createdById: req.user!.id,
            bulkUploadBatchId: batch.id,
          },
        });

        try {
          await submitRequest(requestRecord.id);
        } catch (submitErr) {
          if (!(submitErr instanceof HttpError) || !submitErr.message.includes("attachments")) {
            throw submitErr;
          }
        }

        created++;
      } catch (err) {
        errors.push({ row: rowNumber, error: err instanceof Error ? err.message : "Unknown error" });
      }
    }

    const status = errors.length === 0 ? "COMPLETED" : created > 0 ? "COMPLETED_WITH_ERRORS" : "FAILED";
    const updatedBatch = await prisma.bulkUploadBatch.update({
      where: { id: batch.id },
      data: { rowCount, validationErrors: errors as unknown as Prisma.InputJsonValue, status },
    });

    res.status(201).json({ batch: updatedBatch, created, errors });
  })
);
