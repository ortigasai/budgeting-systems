import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { ApproverPicker } from "../../components/ApproverPicker";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, downloadFile, type BudgetRequest, type EmployeeOption, type ExpenseLineItem, type ExtraField, type MobilePhonePolicyTier, type RequestCategory } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { PageHeader } from "../../components/PageHeader";
import { SearchableSelect } from "../../components/SearchableSelect";
import { SectionLabel } from "../../components/TabBar";
import { evaluateSpendGridFormula, spreadByFrequency, spreadByMonthNumbers } from "../../lib/spendGridFormula";
import { useFiscalYear } from "../../lib/fiscalCycle";
import { startUpload, useUploadTask } from "../../lib/uploadManager";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const FULL_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// DROPDOWN fields render <option value={opt.label}> (see the Additional
// Fields section below), so a month-picker field's otherFields value is the
// full month name ("March"), not its numeric opt.value — this converts back.
function monthNameToNumber(name: string | undefined): number | null {
  if (!name) return null;
  const idx = FULL_MONTH_NAMES.indexOf(name);
  return idx === -1 ? null : idx + 1;
}

// Notes_8: "allow selection of multiple months" — a multi DROPDOWN field
// stores its selections as one comma-separated string in otherFields (e.g.
// "March, June"), matching the free-text-map shape otherRequiredFields
// already uses everywhere else.
function monthNamesToNumbers(csv: string | undefined): number[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => monthNameToNumber(s.trim()))
    .filter((n): n is number => n !== null);
}

// Same "option's DOM value is its label, not its numeric value" quirk as
// month fields — used for Rank, where "Project-Based"/"Outsourced" aren't
// numeric labels at all (see expenseLineItemCatalog.ts).
function optionValueByLabel(field: ExtraField | undefined, label: string | undefined): number | null {
  if (!field || !label) return null;
  return field.options?.find((o) => o.label === label)?.value ?? null;
}

interface HeadcountRow {
  headcount: string;
  rate: string;
  monthStart: string;
}
const EMPTY_HEADCOUNT_ROW: HeadcountRow = { headcount: "", rate: "", monthStart: "1" };

// Notes_7: "For expense line items with headcount requirements, put a table
// grid of monthly rate per headcount and month start" — lets a Requestor
// model separate hiring batches (e.g. 3 headcount from January, 2 more from
// July) in one request instead of one flat Headcount/Rate pair. Flattened
// into plain "Row N <label>" keys so it fits the existing free-text
// otherRequiredFields map RequestDetailPage already renders generically.
function headcountRowsToFields(rows: HeadcountRow[], rateLabel: string): Record<string, string> {
  const fields: Record<string, string> = {};
  rows.forEach((row, i) => {
    fields[`Row ${i + 1} Headcount`] = row.headcount;
    fields[`Row ${i + 1} ${rateLabel}`] = row.rate;
    fields[`Row ${i + 1} Month Start`] = row.monthStart ? MONTHS[Number(row.monthStart) - 1] : "";
  });
  return fields;
}

// Notes_7: "allow paste of values from outside files like excel or word...
// one-time paste." Excel/Word copy a row of cells as tab- or newline-
// separated text; pasting into any month box fills that month and however
// many follow fit. A single pasted value falls through to normal browser
// paste behavior (no special handling needed). Only tab/newline separate
// distinct cells — a comma is a thousands separator within one Accounting-
// formatted cell (e.g. "1,999,888"), not a cell boundary.
function parseGridPaste(text: string): number[] {
  return text
    .split(/[\t\r\n]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => Number(t.replace(/[₱,\s]/g, "")))
    .filter((n) => !Number.isNaN(n));
}

// GAE's manual request form. DOE and Revenue both moved to the same
// SBU+Company Upload Template flow (see SbuBatchUploadTab.tsx/RevenueRequestTab.tsx)
// - `requestCategory` is kept as a prop rather than hardcoded since NPC used
// to share this form too before spec item 12 gave it its own (see
// NpcRequestTab.tsx), so the shape is still generically GAE-only in practice.
export function StandardRequestTab({ requestCategory, subtitle }: { requestCategory: RequestCategory; subtitle: string }) {
  const { currentUser } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { targetYear: FISCAL_YEAR } = useFiscalYear();

  // Notes_7: "limit the visibility of the departments for some expenses" —
  // the backend filters out rows restricted to a different department than
  // the Requestor's own (see admin.ts's requesterDepartmentId param).
  const requesterDepartmentId = currentUser?.department?.id;
  const { data: lineItems = [] } = useQuery({
    queryKey: ["expense-line-items", "for-request", requesterDepartmentId],
    queryFn: async () =>
      (
        await api.get<ExpenseLineItem[]>("/admin/expense-line-items", {
          params: requesterDepartmentId ? { requesterDepartmentId } : undefined,
        })
      ).data,
    enabled: !!requesterDepartmentId,
  });
  const { data: docThreshold } = useQuery({
    queryKey: ["documentation-threshold"],
    queryFn: async () => (await api.get<{ amount: number }>("/admin/documentation-threshold")).data,
  });
  // Notes_8: Mobile Phone's Budget Limit per Rank — the catalog no longer
  // carries its own Plan/price list, so the requested amount is derived
  // entirely from this lookup.
  const { data: mobileTiers = [] } = useQuery({
    queryKey: ["mobile-policy-tiers"],
    queryFn: async () => (await api.get<MobilePhonePolicyTier[]>("/admin/mobile-policy-tiers")).data,
  });
  // Notes_8: Mobile Phone's "Employee Name, Department" field — combines
  // real employees with pending (not-yet-hired) Additional Headcount
  // Requests, identified by their generated code, so a phone can be
  // budgeted for an incoming hire before they exist in the real roster.
  const { data: employees = [] } = useQuery({
    queryKey: ["additional-headcount", "employee-options"],
    queryFn: async () => (await api.get<EmployeeOption[]>("/additional-headcount/employee-options")).data,
  });

  // Notes_7: "'Manpower - Salary' expense category should not be shown in
  // the selection since this should be budgeted by the HR Analyst in the
  // Manpower Budget section" — the rows stay in the catalog (needed for the
  // CC-GL/SAP reference the note mentions), just excluded from this picker.
  const categories = useMemo(() => [...new Set(lineItems.map((i) => i.category))].filter((c) => c !== "Manpower - Salary").sort(), [lineItems]);

  const [category, setCategory] = useState("");
  const [expenseLineItemId, setExpenseLineItemId] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [customExpenseName, setCustomExpenseName] = useState("");
  const [monthlyAmounts, setMonthlyAmounts] = useState<number[]>(Array(12).fill(0));
  const [businessJustification, setBusinessJustification] = useState("");
  const [departmentHeadId, setDepartmentHeadId] = useState("");
  const [centralizedHeadId, setCentralizedHeadId] = useState("");
  const [otherFields, setOtherFields] = useState<Record<string, string>>({});
  const [headcountRows, setHeadcountRows] = useState<HeadcountRow[]>([EMPTY_HEADCOUNT_ROW]);
  const [created, setCreated] = useState<BudgetRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Note 11 §6 - "Open Spreadsheet Template": a bulk alternative to the
  // manual form above for requestors who'd rather fill many line items at
  // once. Reuses the existing bulk-upload flow (see routes/bulkUpload.ts).
  // The upload itself runs through the shared uploadManager (see
  // lib/uploadManager.ts) instead of a local mutation, so progress and the
  // result toast survive navigating to a different page mid-upload - this
  // tab just keeps the task id to show the same status inline while it's
  // still mounted.
  const [uploadTaskId, setUploadTaskId] = useState<string | null>(null);
  const uploadTask = useUploadTask(uploadTaskId);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [frozenHeaderEl, setFrozenHeaderEl] = useState<HTMLDivElement | null>(null);
  const [frozenHeaderHeight, setFrozenHeaderHeight] = useState(0);
  useLayoutEffect(() => {
    if (frozenHeaderEl) setFrozenHeaderHeight(frozenHeaderEl.offsetHeight);
  });
  // Notes_8: "amount should be in 'Accounting' format, e.g., 1000 should be
  // reflected as 1,000." The box being actively typed into shows the raw
  // digits (so commas don't fight the cursor mid-keystroke); every other box
  // shows the comma-formatted value.
  const [editingMonth, setEditingMonth] = useState<{ index: number; value: string } | null>(null);
  // Notes_8: "put 1 box to input amount then that amount will automatically
  // fill all months from Jan-Dec" — a single amount applied to all 12
  // months at once, as an alternative to filling each box individually.
  const [fillAllValue, setFillAllValue] = useState("");
  // Accounting-format display while not focused, same raw-while-editing
  // pattern as the month boxes above (see editingMonth).
  const [fillAllFocused, setFillAllFocused] = useState(false);

  const itemsInCategory = useMemo(() => lineItems.filter((i) => i.category === category), [lineItems, category]);
  const selectedItem = lineItems.find((i) => i.id === expenseLineItemId);
  // A Centralized Department Requestor raising a GAE request for their own
  // department has no separate Department Head to pick - Submit sends it
  // straight to their own Centralized Department Head (no L1 review stage).
  const ownDeptInitiated =
    requestCategory === "GAE" &&
    !!selectedItem &&
    !!currentUser?.roles.some((r) => (r.roleType === "CENTRALIZED_BUDGET_PREPARER" || r.roleType === "CENTRALIZED_FIRST_LEVEL_REVIEWER") && r.department?.id === selectedItem.ownerDepartmentId);
  const proposedAmount = monthlyAmounts.reduce((a, b) => a + b, 0);
  const needsAttachment = docThreshold && proposedAmount > docThreshold.amount;

  // Notes_7: line items whose Additional Field is a "Headcount" + rate pair
  // (Driver/Messenger/Operator, Drivers' Meal Allowance) get the repeatable
  // rate table below instead of the flat two-field form, so a Requestor can
  // model separate hiring batches starting in different months. Excludes
  // rows carrying a DROPDOWN field (Mobile Phone's Rank/Month Start, or a
  // "Spend Month" picker) — those are a single-shot amount for one month or
  // rank, not a repeatable multi-batch table.
  const hasDropdownField = selectedItem?.extraFieldsConfig.some((f) => f.type === "DROPDOWN") ?? false;
  const headcountField = selectedItem?.extraFieldsConfig.find((f) => f.label === "Headcount");
  const rateField = selectedItem?.extraFieldsConfig.find((f) => f.label !== "Headcount" && f.type === "NUMBER");
  const usesHeadcountTable = !!(headcountField && rateField && selectedItem?.spendGridComputation && !hasDropdownField);

  // Notes_8: "Mobile Phone – Require input of Rank... Automatically reflect
  // Budget Limit based on Rank chosen. Reflect Budget Limit on the monthly
  // spend grid starting on the Month Start input by the user then." No
  // formula involved — the amount is always exactly the rank's tier limit.
  const mobileRankField = selectedItem?.extraFieldsConfig.find((f) => f.label === "Rank" && f.type === "DROPDOWN");
  const mobileMonthStartField = selectedItem?.extraFieldsConfig.find((f) => f.label === "Month Start" && f.type === "DROPDOWN");
  const usesMobileRankTable = !!(mobileRankField && mobileMonthStartField);

  const monthlyFromMobileRank = useMemo(() => {
    if (!usesMobileRankTable) return null;
    const rank = optionValueByLabel(mobileRankField, otherFields["Rank"]);
    const monthStart = monthNameToNumber(otherFields["Month Start"]);
    if (!rank || !monthStart) return null;
    const tier = mobileTiers.find((t) => rank >= t.minRank && rank <= t.maxRank);
    if (!tier) return null;
    const totals = Array(12).fill(0);
    for (let m = monthStart; m <= 12; m++) totals[m - 1] = tier.budgetLimit;
    return totals;
  }, [usesMobileRankTable, mobileRankField, otherFields, mobileTiers]);

  // Notes_8: for line items whose catalog frequency is "User to select
  // which month," the computed total lands in the Requestor's chosen
  // "Spend Month" instead of every month or a catalog-fixed one.
  const usesSpendMonthField = selectedItem?.spendGridFrequency === "User to select which month" && !usesMobileRankTable;

  // Notes_8: "Those Line Items with 'Spend Grid Computation', spend grid
  // fields should be automatically computed based on the formula indicated
  // and cannot be edited." The Requestor fills the Additional Fields
  // (Headcount, Rate, etc.); once every value the formula needs is present
  // and the formula can be confidently evaluated, the Monthly Spend Grid is
  // derived from it and locked. If it can't be evaluated yet (fields still
  // blank) or ever (a small number of real catalog formulas use ambiguous
  // notation like "40km/L" that can't be safely parsed), the grid falls
  // back to normal manual entry rather than showing a fabricated number.
  // The "Spend Month" field itself is never part of the arithmetic — it's
  // excluded from what's handed to the evaluator, which requires every
  // field it's given to actually appear in the formula text.
  const formulaResult = useMemo(() => {
    if (usesHeadcountTable || usesMobileRankTable || !selectedItem?.spendGridComputation) return null;
    const fields = selectedItem.extraFieldsConfig.filter((f) => f.label !== "Spend Month").map((f) => ({ label: f.label, value: Number(otherFields[f.label]) }));
    return evaluateSpendGridFormula(selectedItem.spendGridComputation, fields);
  }, [usesHeadcountTable, usesMobileRankTable, selectedItem, otherFields]);

  // One evaluation per headcount-table row, each contributing its computed
  // monthly amount from its own Month Start through December; a row with
  // blank inputs contributes nothing rather than blocking the others.
  const monthlyFromHeadcountRows = useMemo(() => {
    if (!usesHeadcountTable || !selectedItem?.spendGridComputation || !rateField) return null;
    const totals = Array(12).fill(0);
    let anyComputed = false;
    for (const row of headcountRows) {
      if (!row.headcount || !row.rate || !row.monthStart) continue;
      const amount = evaluateSpendGridFormula(selectedItem.spendGridComputation, [
        { label: "Headcount", value: Number(row.headcount) },
        { label: rateField.label, value: Number(row.rate) },
      ]);
      if (amount === null) continue;
      anyComputed = true;
      for (let m = Number(row.monthStart); m <= 12; m++) totals[m - 1] += amount;
    }
    return anyComputed ? totals : null;
  }, [usesHeadcountTable, selectedItem, rateField, headcountRows]);

  // Notes_12: "don't allow the manual input of amount on the Monthly Spend
  // Grid... as these will be automatically filled-out once the additional
  // required fields are manually filled-out." Previously the grid only
  // locked once the formula actually resolved to a number — meaning it was
  // freely editable in the gap between picking the line item and finishing
  // the Additional Fields, letting a Requestor type a value that would
  // later get silently overwritten (or never get overwritten, if they never
  // finished the fields). The lock should apply as soon as the item is
  // known to be formula-driven, not only once it's resolved.
  // A small number of real catalog formulas use notation
  // (evaluateSpendGridFormula's docs mention "40km/L") that can never be
  // parsed no matter how complete the inputs are — those must still fall
  // back to manual entry, so this probes parseability with placeholder `1`
  // values instead of trusting spendGridComputation's mere presence.
  const canComputeGrid = useMemo(() => {
    if (usesMobileRankTable) return true; // deterministic rank/tier lookup, no formula parsing involved
    if (!selectedItem?.spendGridComputation) return false;
    if (usesHeadcountTable) {
      if (!rateField) return false;
      return (
        evaluateSpendGridFormula(selectedItem.spendGridComputation, [
          { label: "Headcount", value: 1 },
          { label: rateField.label, value: 1 },
        ]) !== null
      );
    }
    const probeFields = selectedItem.extraFieldsConfig.filter((f) => f.label !== "Spend Month").map((f) => ({ label: f.label, value: 1 }));
    return evaluateSpendGridFormula(selectedItem.spendGridComputation, probeFields) !== null;
  }, [usesMobileRankTable, usesHeadcountTable, selectedItem, rateField]);

  const isFormulaLocked = canComputeGrid;

  useEffect(() => {
    if (usesHeadcountTable) {
      if (monthlyFromHeadcountRows !== null) setMonthlyAmounts(monthlyFromHeadcountRows);
    } else if (usesMobileRankTable) {
      if (monthlyFromMobileRank !== null) setMonthlyAmounts(monthlyFromMobileRank);
    } else if (formulaResult !== null) {
      if (usesSpendMonthField) {
        setMonthlyAmounts(spreadByMonthNumbers(formulaResult, monthNamesToNumbers(otherFields["Spend Month"])));
      } else {
        setMonthlyAmounts(spreadByFrequency(formulaResult, selectedItem?.spendGridFrequency));
      }
    }
  }, [usesHeadcountTable, monthlyFromHeadcountRows, usesMobileRankTable, monthlyFromMobileRank, formulaResult, usesSpendMonthField, otherFields, selectedItem?.spendGridFrequency]);

  const createMutation = useMutation({
    mutationFn: async () =>
      (
        await api.post<BudgetRequest>("/budget-requests", {
          fiscalYear: FISCAL_YEAR,
          expenseLineItemId: useCustom ? undefined : expenseLineItemId,
          customExpenseName: useCustom ? customExpenseName : undefined,
          monthlyAmounts,
          businessJustification,
          otherRequiredFields: usesHeadcountTable && rateField ? headcountRowsToFields(headcountRows, rateField.label) : otherFields,
          requestCategory,
          departmentHeadId: departmentHeadId || undefined,
          centralizedHeadId: centralizedHeadId || undefined,
        })
      ).data,
    onSuccess: (data) => {
      setCreated(data);
      setError(null);
    },
    onError: (err: any) => setError(err.response?.data?.error ?? "Failed to create request."),
  });

  const attachMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return (await api.post(`/budget-requests/${created!.id}/attachments`, form)).data;
    },
    onSuccess: async () => {
      const refreshed = (await api.get<BudgetRequest>(`/budget-requests/${created!.id}`)).data;
      setCreated(refreshed);
    },
  });

  const submitMutation = useMutation({
    mutationFn: async () => (await api.post<BudgetRequest>(`/budget-requests/${created!.id}/submit`, { departmentHeadId: departmentHeadId || undefined, centralizedHeadId: centralizedHeadId || undefined })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["my-requests"] });
      navigate("/requests/mine");
    },
    onError: (err: any) => setError(err.response?.data?.error ?? "Failed to submit request."),
  });

  if (created) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageHeader
          subtitle={<span className="font-medium text-slate-700">Draft created</span>}
          actions={
            <button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
              Submit for Approval
            </button>
          }
        />
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <div>
            <span className="font-medium">Expense line item:</span> {created.expenseLineItem?.name ?? "—"}
          </div>
          <div>
            <span className="font-medium">Budget Code:</span>
            {""}
            {created.budgetCode ?? created.expenseLineItem?.budgetCode ?? "—"}
          </div>
          <div>
            <span className="font-medium">{FISCAL_YEAR} Proposed Amount:</span>
            {""}
            <span className="font-bold text-emerald-800">{created.proposedAmount.toLocaleString()}</span>
          </div>
          <div>
            <span className="font-medium">Attachments:</span>
            {""}
            {created.attachments.length === 0 ? "None yet" : created.attachments.map((a) => a.fileName).join(",")}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium">Supporting attachments</label>
          <input type="file" className="mt-1 text-sm" onChange={(e) => e.target.files?.[0] && attachMutation.mutate(e.target.files[0])} />
        </div>

        {error && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
      </div>
    );
  }

  const saveDraftDisabled = createMutation.isPending || (!useCustom && !expenseLineItemId) || (useCustom && !customExpenseName);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div ref={setFrozenHeaderEl} className="sticky top-0 z-30 space-y-4 bg-slate-100 pb-3 pt-1">
      <PageHeader
        subtitle={subtitle}
        actions={
          <button onClick={() => createMutation.mutate()} disabled={saveDraftDisabled} className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
            Save Draft
          </button>
        }
      />
      <div className="grid grid-cols-2 gap-4 rounded-lg border border-emerald-200 border-l-4 border-l-lime-600 bg-emerald-50 p-4 text-sm shadow-sm">
        <div>
          <label className="block font-medium text-emerald-800">Originating Department</label>
          <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{currentUser?.department?.name}</div>
        </div>
        <div>
          <label className="block font-medium text-emerald-800">Target Calendar Year</label>
          <div className="mt-1 rounded border border-emerald-200 bg-white px-2 py-1.5 text-emerald-950">{FISCAL_YEAR}</div>
        </div>
      </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <div className="space-y-4 lg:col-span-3">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm">
        <span className="font-medium text-slate-600">Bulk upload:</span>
        <button
          type="button"
          onClick={() =>
            downloadFile(`/budget-requests/bulk-upload/template?category=${requestCategory}&fiscalYear=${FISCAL_YEAR}`, `budget-request-template-${requestCategory.toLowerCase()}-${FISCAL_YEAR}.xlsx`).catch(() =>
              setTemplateError("Failed to download the template.")
            )
          }
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
        >
          Open Template
        </button>
        <label className="cursor-pointer rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
          {uploadTask?.status === "uploading" ? `Uploading… ${uploadTask.progress}%` : "Upload Completed Template"}
          <input
            type="file"
            accept=".xlsx"
            className="hidden"
            disabled={uploadTask?.status === "uploading"}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setTemplateError(null);
              const form = new FormData();
              form.append("file", file);
              form.append("category", requestCategory);
              form.append("fiscalYear", String(FISCAL_YEAR));
              setUploadTaskId(startUpload({ label: `${requestCategory} bulk upload (${file.name})`, url: "/budget-requests/bulk-upload", form, invalidateKeys: [["my-requests"]] }));
            }}
          />
        </label>
        {templateError && <span className="text-xs text-red-600">{templateError}</span>}
        {uploadTask && uploadTask.status !== "uploading" && (
          <span className={`text-xs ${uploadTask.status === "success" ? "text-emerald-700" : "text-red-600"}`}>{uploadTask.message}</span>
        )}
      </div>
      {uploadTask?.errors && uploadTask.errors.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          <div className="mb-1 font-medium">{uploadTask.errors.length} row(s) couldn't be uploaded - fix these in the spreadsheet and re-upload:</div>
          <ul className="max-h-48 list-disc space-y-0.5 overflow-y-auto pl-4">
            {uploadTask.errors.map((e, i) => (
              <li key={i}>
                <span className="font-medium">Row {e.row}:</span> {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <SectionLabel>Expense Selection</SectionLabel>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={useCustom} onChange={(e) => setUseCustom(e.target.checked)} />
              This expense isn't in the standard list
            </label>
            {useCustom ? (
              <input className="mt-2 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" placeholder="Describe the expense (routes to the Budget Officer for GL-CC assignment)" value={customExpenseName} onChange={(e) => setCustomExpenseName(e.target.value)} />
            ) : (
              <div className="mt-2 space-y-2">
                <div>
                  <label className="block text-xs font-medium text-slate-500">Expense Category</label>
                  <SearchableSelect
                    placeholder="Search categories…"
                    options={categories.map((c) => ({ value: c, label: c }))}
                    value={category}
                    onChange={(v) => {
                      setCategory(v);
                      setExpenseLineItemId("");
                    }}
                  />
                </div>
                {category && (
                  <div>
                    <label className="block text-xs font-medium text-slate-500">Expense Line Item</label>
                    <SearchableSelect
                      placeholder="Search line items…"
                      options={itemsInCategory.map((i) => ({
                        value: i.id,
                        label: i.company ? `${i.name} (${i.company.code})` : i.name,
                        sublabel: `${i.glAccount} / ${i.costCenter}`,
                      }))}
                      value={expenseLineItemId}
                      onChange={(v) => {
                        setExpenseLineItemId(v);
                        setOtherFields({});
                        setHeadcountRows([EMPTY_HEADCOUNT_ROW]);
                        setMonthlyAmounts(Array(12).fill(0));
                        setFillAllValue("");
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {selectedItem?.requiresMobilePolicy && (
              <div className="mt-3 space-y-1 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
                <div>The monthly amount is set automatically to your rank's Budget Limit and repeats from the Month Start you choose through December — it can't be edited directly.</div>
                <div>
                  This request is for <strong>new mobile phone applications only</strong> — no need to request for employees who already have an existing mobile phone.
                </div>
                <div>
                  For a <strong>new hire</strong>, mobile phone budget is requested automatically through the "Additional Manpower" request once it's approved — no separate submission needed here.
                </div>
              </div>
            )}

            {selectedItem && (selectedItem.description || selectedItem.sampleCharges || selectedItem.spendGridComputation) && (
              <div className="mt-3 space-y-1 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                {selectedItem.description && (
                  <div>
                    <span className="font-medium text-slate-700">Description:</span> {selectedItem.description}
                  </div>
                )}
                {selectedItem.sampleCharges && (
                  <div>
                    <span className="font-medium text-slate-700">Sample charges:</span> {selectedItem.sampleCharges}
                  </div>
                )}
                {selectedItem.spendGridComputation && (
                  <div>
                    <span className="font-medium text-slate-700">Spend grid computation:</span>
                    {""}
                    {selectedItem.spendGridComputation}
                    {selectedItem.spendGridFrequency && ` (${selectedItem.spendGridFrequency})`}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <SectionLabel>Monthly Spend Grid (Jan–Dec)</SectionLabel>
              {!isFormulaLocked && (
                <button
                  type="button"
                  onClick={() => {
                    setMonthlyAmounts(Array(12).fill(0));
                    setFillAllValue("");
                  }}
                  className="text-xs font-medium text-slate-500 hover:text-red-600 hover:underline"
                >
                  Clear all
                </button>
              )}
            </div>
            {isFormulaLocked ? (
              <div className="mb-2 text-xs text-slate-500">Computed automatically from the Additional Fields on the right and can't be edited directly.</div>
            ) : (
              <>
                <div className="mb-2 text-xs text-slate-500">Tip: paste a row of 12 values copied from Excel or Word into any box below to fill Jan–Dec in one go.</div>
                <div className="mb-3 flex items-center gap-2">
                  <label className="text-xs font-medium text-slate-500">Apply one amount to all months:</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    className="w-32 rounded border border-slate-300 px-2 py-1 text-sm"
                    value={fillAllFocused || fillAllValue === "" ? fillAllValue : Number(fillAllValue).toLocaleString()}
                    onFocus={() => setFillAllFocused(true)}
                    onBlur={() => setFillAllFocused(false)}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[₱,\s]/g, "");
                      if (raw === "" || /^\d*\.?\d*$/.test(raw)) setFillAllValue(raw);
                    }}
                    onPaste={(e) => {
                      const values = parseGridPaste(e.clipboardData.getData("text"));
                      if (values.length === 0) return; // let the browser handle it normally
                      e.preventDefault();
                      setFillAllValue(String(values[0]));
                      setFillAllFocused(false);
                    }}
                  />
                  <button type="button" onClick={() => setMonthlyAmounts(Array(12).fill(Number(fillAllValue) || 0))} disabled={!fillAllValue} className="rounded border border-emerald-600 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50">
                    Fill all months
                  </button>
                </div>
              </>
            )}
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {MONTHS.map((m, i) => (
                <div key={m}>
                  <label className="block text-xs text-slate-500">{m}</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    readOnly={isFormulaLocked}
                    className={`w-full rounded border border-slate-300 px-2 py-1 text-sm ${isFormulaLocked ? "bg-slate-100 text-slate-600" : ""}`}
                    value={editingMonth?.index === i ? editingMonth.value : monthlyAmounts[i].toLocaleString()}
                    onFocus={() => {
                      if (isFormulaLocked) return;
                      setEditingMonth({ index: i, value: monthlyAmounts[i] === 0 ? "" : String(monthlyAmounts[i]) });
                    }}
                    onBlur={() => setEditingMonth(null)}
                    onChange={(e) => {
                      if (isFormulaLocked) return;
                      const raw = e.target.value.replace(/,/g, "");
                      if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
                      setEditingMonth({ index: i, value: raw });
                      const next = [...monthlyAmounts];
                      next[i] = raw === "" ? 0 : Number(raw);
                      setMonthlyAmounts(next);
                    }}
                    onPaste={(e) => {
                      if (isFormulaLocked) return;
                      const values = parseGridPaste(e.clipboardData.getData("text"));
                      if (values.length <= 1) return; // let the browser handle a single-value paste normally
                      e.preventDefault();
                      const next = [...monthlyAmounts];
                      for (let j = 0; j < values.length && i + j < 12; j++) next[i + j] = values[j];
                      setMonthlyAmounts(next);
                      setEditingMonth(null);
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm">
              <span className="font-medium text-emerald-800">{FISCAL_YEAR} Proposed Amount:</span>
              {""}
              <span className="font-bold text-emerald-800">{proposedAmount.toLocaleString()}</span>
              {needsAttachment && <span className="ml-2 text-amber-700">(exceeds {docThreshold!.amount.toLocaleString()} — attachment will be required)</span>}
            </div>
          </div>

          {selectedItem && !usesHeadcountTable && selectedItem.extraFieldsConfig.length > 0 && (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <SectionLabel>Additional Fields</SectionLabel>
              {selectedItem.extraFieldsConfig.map((field) => {
                if (field.label === "Employee Name") {
                  return (
                    <div key={field.label}>
                      <label className="block text-sm font-medium text-slate-600">
                        {field.label} {field.required && <span className="text-red-500">*</span>}
                      </label>
                      <SearchableSelect
                        placeholder="Search employees…"
                        options={employees.map((u) => ({ value: u.name, label: u.name, sublabel: u.department ?? undefined }))}
                        value={otherFields[field.label] ?? ""}
                        onChange={(v) => {
                          const emp = employees.find((u) => u.name === v);
                          setOtherFields({ ...otherFields, "Employee Name": v, Department: emp?.department ?? "" });
                        }}
                      />
                    </div>
                  );
                }
                // Department is derived from whichever employee is picked above
                // rather than chosen independently, so it can't be mismatched -
                // shown read-only here.
                if (field.label === "Department" && selectedItem.extraFieldsConfig.some((f) => f.label === "Employee Name")) {
                  return (
                    <div key={field.label}>
                      <label className="block text-sm font-medium text-slate-600">
                        {field.label} {field.required && <span className="text-red-500">*</span>}
                      </label>
                      <div className="mt-1 rounded border border-slate-200 bg-slate-100 px-2 py-1.5 text-sm text-slate-600">{otherFields[field.label] || "— Select an employee above —"}</div>
                    </div>
                  );
                }
                return (
                  <div key={field.label}>
                    <label className="block text-sm font-medium text-slate-600">
                      {field.label} {field.required && <span className="text-red-500">*</span>}
                    </label>
                    {field.type === "DROPDOWN" && field.multi ? (
                      // Multiple months can be selected for one field.
                      <div className="mt-1 flex flex-wrap gap-2">
                        {field.options?.map((opt) => {
                          const selected = (otherFields[field.label] ?? "")
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean);
                          const checked = selected.includes(opt.label);
                          return (
                            <label key={opt.label} className={`cursor-pointer rounded border px-2 py-1 text-xs ${checked ? "border-emerald-600 bg-emerald-50 text-emerald-800" : "border-slate-300 text-slate-600"}`}>
                              <input
                                type="checkbox"
                                className="mr-1"
                                checked={checked}
                                onChange={(e) => {
                                  const next = e.target.checked ? [...selected, opt.label] : selected.filter((s) => s !== opt.label);
                                  setOtherFields({ ...otherFields, [field.label]: next.join(",") });
                                }}
                              />
                              {opt.label}
                            </label>
                          );
                        })}
                      </div>
                    ) : field.type === "DROPDOWN" ? (
                      <select className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={otherFields[field.label] ?? ""} onChange={(e) => setOtherFields({ ...otherFields, [field.label]: e.target.value })}>
                        <option value="">— Select —</option>
                        {field.options?.map((opt) => (
                          <option key={opt.label} value={opt.label}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input type={field.type === "NUMBER" ? "number" : "text"} className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm" value={otherFields[field.label] ?? ""} onChange={(e) => setOtherFields({ ...otherFields, [field.label]: e.target.value })} />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <SectionLabel>Business Justification</SectionLabel>
            <textarea className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" rows={3} value={businessJustification} onChange={(e) => setBusinessJustification(e.target.value)} />
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <SectionLabel>Approval</SectionLabel>
            {ownDeptInitiated ? (
              <div className="space-y-2">
                <div className="text-sm text-slate-500">This is your own centralized department's expense, so there's no Department Head to pick - instead, assign it directly to your Centralized Department Head.</div>
                <div className="max-w-md">
                  <ApproverPicker label="Centralized Department Head" value={centralizedHeadId} onChange={setCentralizedHeadId} />
                </div>
              </div>
            ) : (
              <div className="max-w-md">
                <ApproverPicker label="Department Head / Approver" value={departmentHeadId} onChange={setDepartmentHeadId} />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4 lg:col-span-2">
          <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-sm shadow-sm lg:sticky" style={{ top: frozenHeaderHeight + 16 }}>
            <SectionLabel>Quick Guide</SectionLabel>
            <ol className="list-decimal space-y-1.5 pl-5 text-xs text-slate-700">
              <li>Choose an Expense Category, then an Expense Line Item. Tick "This expense isn't in the standard list" for anything custom.</li>
              <li>Enter the amount for each month, or use "Fill all months" to apply one amount to all twelve.</li>
              <li>Fill in any Additional Fields marked as required.</li>
              <li>Pick the Department Head / Approver and write a Business Justification.</li>
              <li>Save Draft to keep working on it later, then submit it for approval.</li>
              <li>If the amount is over the threshold shown under Proposed Amount, attach the supporting document before submitting.</li>
            </ol>
            <div className="border-t border-emerald-200 pt-2 text-xs text-slate-600">
              <span className="font-medium text-emerald-800">Bulk upload:</span> download the template, add one row per line item, then upload it. Any rejected rows are listed here with the reason.
            </div>
          </div>
          {selectedItem && usesHeadcountTable && rateField && (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <SectionLabel>Headcount &amp; Rate</SectionLabel>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs tracking-wide text-slate-500">
                    <tr>
                      <th className="py-1 pr-2">Headcount</th>
                      <th className="py-1 pr-2">{rateField.label}</th>
                      <th className="py-1 pr-2">Month Start</th>
                      <th className="py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {headcountRows.map((row, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-1 pr-2">
                          <input
                            type="number"
                            min={0}
                            className="w-24 rounded border border-slate-300 px-2 py-1"
                            value={row.headcount}
                            onChange={(e) => {
                              const next = [...headcountRows];
                              next[i] = { ...next[i], headcount: e.target.value };
                              setHeadcountRows(next);
                            }}
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <input
                            type="number"
                            min={0}
                            className="w-32 rounded border border-slate-300 px-2 py-1"
                            value={row.rate}
                            onChange={(e) => {
                              const next = [...headcountRows];
                              next[i] = { ...next[i], rate: e.target.value };
                              setHeadcountRows(next);
                            }}
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <select
                            className="rounded border border-slate-300 px-2 py-1"
                            value={row.monthStart}
                            onChange={(e) => {
                              const next = [...headcountRows];
                              next[i] = { ...next[i], monthStart: e.target.value };
                              setHeadcountRows(next);
                            }}
                          >
                            {MONTHS.map((m, mi) => (
                              <option key={m} value={mi + 1}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-1">
                          {headcountRows.length > 1 && (
                            <button type="button" onClick={() => setHeadcountRows(headcountRows.filter((_, ri) => ri !== i))} className="text-xs text-red-600 hover:underline">
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={() => setHeadcountRows([...headcountRows, EMPTY_HEADCOUNT_ROW])} className="rounded border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                + Add row
              </button>
            </div>
          )}
        </div>
      </div>

      {error &&<div className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
    </div>
  );
}
