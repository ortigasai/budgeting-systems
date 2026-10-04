import ExcelJS from "exceljs";
import bcrypt from "bcryptjs";
import { PrismaClient, RoleType } from "@prisma/client";

// Shared employee-roster import logic - used by both the seed-time importer
// (backend/prisma/importEmployees.ts, reading the source file from disk)
// and the Admin Console's "Upload Employee List" button
// (backend/src/routes/admin.ts, reading an uploaded buffer). Lives under
// backend/src so both can import it without crossing the app's tsconfig
// rootDir boundary.

// Notes_6: "For the purpose of testing, password for all users will be
// Ortigas12345." One shared bcrypt hash, computed once and reused for every
// imported employee (and every seed.ts demo/role user).
export const TEST_PASSWORD = "Ortigas12345";
let cachedTestPasswordHash: string | null = null;
export async function testPasswordHash(): Promise<string> {
  if (!cachedTestPasswordHash) cachedTestPasswordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  return cachedTestPasswordHash;
}

export interface ParsedEmployee {
  // Legacy roster (ID-number keyed) - null for the email-keyed roster.
  idNumber: number | null;
  // Email-keyed roster - null for the legacy roster.
  email: string | null;
  name: string;
  emailLocalPart: string;
  position: string | null;
  // Notes_7: "Department field ... should follow the Department column
  // (column J)." The real roster's department names are a much larger, more
  // granular set than this app's curated centralized/requesting
  // departments - rather than force-fitting them, unmatched names are
  // upserted as new Department rows (same "create what the source data
  // says" precedent as importExpenseLineItems.ts).
  departmentName: string | null;
  // Email-keyed roster's Role column (e.g. "Budget Officer").
  role: string | null;
}

// Roster "Role" labels that become role assignments. Department Head and the
// SBU roles aren't assigned here (the requester picks Department Head on
// submit, and SBU roles live on the SBU Roles tab), so those are reported as
// skipped rather than imported.
const ROSTER_ROLE_TYPES: Record<string, RoleType> = {
  "Budget Officer": RoleType.BUDGET_OFFICER,
  "BCA Head": RoleType.BCA_HEAD,
  CFO: RoleType.CFO,
  CEO: RoleType.CEO,
  "Manpower Preparer": RoleType.HR_ANALYST,
  "Centralized Department Requestor/Reviewer": RoleType.CENTRALIZED_BUDGET_PREPARER,
  "Centralized Department Head": RoleType.CENTRALIZED_DEPARTMENT_HEAD,
};

function slugifyEmailPart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents (combining diacritical marks)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function cellText(row: ExcelJS.Row, col: number): string {
  return row.getCell(col).text?.toString().trim() ?? "";
}

// Email-keyed roster (Name / Email / Position Title / Department Name / Role
// headers). Columns are found by header name, so their order doesn't matter.
function parseEmailRoster(sheet: ExcelJS.Worksheet, headerCols: Map<string, number>): ParsedEmployee[] {
  const nameCol = headerCols.get("name")!;
  const emailCol = headerCols.get("email")!;
  const positionCol = headerCols.get("position title");
  const departmentCol = headerCols.get("department name");
  const roleCol = headerCols.get("role");

  const employees: ParsedEmployee[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const name = cellText(row, nameCol);
    const email = cellText(row, emailCol).toLowerCase();
    if (!name || !email) continue;

    employees.push({
      idNumber: null,
      email,
      name,
      emailLocalPart: email.split("@")[0],
      position: (positionCol ? cellText(row, positionCol) : "") || null,
      departmentName: (departmentCol ? cellText(row, departmentCol) : "") || null,
      role: (roleCol ? cellText(row, roleCol) : "") || null,
    });
  }
  return employees;
}

// Notes_7: the seed-time source file names its one sheet "Sheet1", but the
// real "Budgeting System_Employee List" file (uploaded via the Admin
// Console) names it "Employee List" and has a second "Role" sheet after it -
// so match by name first, falling back to the first sheet either way.
function parseWorkbook(workbook: ExcelJS.Workbook): ParsedEmployee[] {
  const sheet = workbook.getWorksheet("Sheet1") ?? workbook.getWorksheet("Employee List") ?? workbook.worksheets[0];
  if (!sheet) throw new Error("No worksheet found in workbook");

  const headerCols = new Map<string, number>();
  const headerRow = sheet.getRow(1);
  for (let c = 1; c <= sheet.columnCount; c++) {
    const label = cellText(headerRow, c).toLowerCase();
    if (label) headerCols.set(label, c);
  }
  if (headerCols.has("name") && headerCols.has("email") && headerCols.has("role")) {
    return parseEmailRoster(sheet, headerCols);
  }

  const employees: ParsedEmployee[] = [];
  const usedEmails = new Set<string>();

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const idNumber = Number(row.getCell(1).value);
    const firstName = String(row.getCell(3).value ?? "").trim();
    const middleInitial = String(row.getCell(4).value ?? "").trim();
    const lastName = String(row.getCell(5).value ?? "").trim();
    if (!idNumber || !firstName || !lastName) continue;

    const name = middleInitial ? `${firstName} ${middleInitial} ${lastName}` : `${firstName} ${lastName}`;
    const position = String(row.getCell(9).value ?? "").trim() || null;
    const departmentName = String(row.getCell(10).value ?? "").trim() || null;

    let emailLocalPart = `${slugifyEmailPart(firstName)}.${slugifyEmailPart(lastName)}`;
    let suffix = 2;
    while (usedEmails.has(emailLocalPart)) {
      emailLocalPart = `${slugifyEmailPart(firstName)}.${slugifyEmailPart(lastName)}${suffix}`;
      suffix++;
    }
    usedEmails.add(emailLocalPart);

    employees.push({ idNumber, email: null, name, emailLocalPart, position, departmentName, role: null });
  }

  return employees;
}

export async function parseEmployeesFile(filePath: string): Promise<ParsedEmployee[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  return parseWorkbook(workbook);
}

// Admin Console "Upload Employee List" button.
export async function parseEmployeesBuffer(buffer: Buffer): Promise<ParsedEmployee[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return parseWorkbook(workbook);
}

export interface EmployeeImportResult {
  imported: number;
  positions: number;
  departments: number;
  roleAssignmentsUpdated: number;
  roleAssignmentsCreated: number;
  // Roster role labels that weren't imported as role assignments.
  skippedRoles: string[];
}

// Upserts Department (get-or-create by name), User (matched by email for the
// email-keyed roster, or by employeeIdNumber for the legacy roster), role
// assignments from the roster's Role column, and Position (distinct values).
export async function applyEmployeeImport(prisma: PrismaClient, employees: ParsedEmployee[]): Promise<EmployeeImportResult> {
  const passwordHash = await testPasswordHash();
  const departmentCache = new Map<string, string>();

  let imported = 0;
  let roleAssignmentsUpdated = 0;
  let roleAssignmentsCreated = 0;
  const skippedRoles = new Set<string>();
  for (const emp of employees) {
    let departmentId: string | undefined;
    if (emp.departmentName) {
      departmentId = departmentCache.get(emp.departmentName);
      if (!departmentId) {
        const dept = await prisma.department.upsert({
          where: { name: emp.departmentName },
          update: {},
          create: { name: emp.departmentName, type: "CENTRALIZED" },
        });
        departmentId = dept.id;
        departmentCache.set(emp.departmentName, departmentId);
      }
    }

    let user;
    if (emp.email) {
      // Email-keyed roster: existing users keep their login (password untouched).
      const existing = await prisma.user.findFirst({ where: { email: { equals: emp.email, mode: "insensitive" } } });
      user = existing
        ? await prisma.user.update({
            where: { id: existing.id },
            data: { name: emp.name, ...(departmentId ? { departmentId } : {}) },
          })
        : await prisma.user.create({
            data: { name: emp.name, email: emp.email, passwordHash, departmentId },
          });
    } else {
      user = await prisma.user.upsert({
        where: { employeeIdNumber: emp.idNumber! },
        update: { name: emp.name, passwordHash, ...(departmentId ? { departmentId } : {}) },
        create: {
          name: emp.name,
          email: `${emp.emailLocalPart}@ortigas.com.ph`,
          employeeIdNumber: emp.idNumber!,
          passwordHash,
          departmentId,
        },
      });
    }
    imported++;

    // Notes_8: "this should also update the Department of those with Role
    // Assignment." RoleAssignmentsTab.tsx sets RoleAssignment.departmentId
    // from the user's home department at assignment time - it doesn't
    // re-derive it live from User.departmentId - so any of this user's
    // existing assignments still pointing at a different department (either
    // because the roster changed just now, or was already stale from before
    // this reconciliation existed) need to be brought in line too. Compares
    // directly against the roster's department rather than the User row's
    // previous value, so it also repairs pre-existing drift, not just new
    // changes from this run.
    if (departmentId) {
      try {
        const result = await prisma.roleAssignment.updateMany({
          where: { userId: user.id, departmentId: { not: departmentId } },
          data: { departmentId },
        });
        roleAssignmentsUpdated += result.count;
      } catch (err) {
        // Unique constraint [departmentId, roleType, userId] could in theory
        // collide if the user already held that exact role for the new
        // department - extremely unlikely, but don't let it abort the rest
        // of the import.
        console.error(`Failed to update role assignments for user ${user.id} (${emp.name}):`, err);
      }
    }

    // Roster Role column -> role assignment at the person's roster department.
    // Existing assignments are kept; only missing ones are created.
    if (emp.role) {
      const roleType = ROSTER_ROLE_TYPES[emp.role];
      if (!roleType) {
        skippedRoles.add(emp.role);
      } else if (!departmentId) {
        skippedRoles.add(`${emp.role} (no department in roster)`);
      } else {
        const existing = await prisma.roleAssignment.findUnique({
          where: { departmentId_roleType_userId: { departmentId, roleType, userId: user.id } },
        });
        if (!existing) {
          await prisma.roleAssignment.create({ data: { departmentId, roleType, userId: user.id } });
          roleAssignmentsCreated++;
        }
      }
    }
  }

  const positions = [...new Set(employees.map((e) => e.position).filter((p): p is string => Boolean(p)))];
  for (const title of positions) {
    await prisma.position.upsert({ where: { title }, update: {}, create: { title } });
  }

  return {
    imported,
    positions: positions.length,
    departments: departmentCache.size,
    roleAssignmentsUpdated,
    roleAssignmentsCreated,
    skippedRoles: [...skippedRoles],
  };
}
