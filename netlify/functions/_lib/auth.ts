// การยืนยันตัวตนและตรวจสิทธิ์จาก LINE ID token ใน header Authorization

import { CHANNEL_KEY, adminCodes } from "./constants";
import { db } from "./db";
import { HttpError } from "./http";
import { verifyIdToken } from "./line";

export interface EmployeeRow {
  id: string;
  employee_code: string;
  full_name: string;
  department_id: string | null;
  department_name: string | null;
  floor: string | null;
  email: string | null;
  status: string; // active | suspended
}

export interface DeptRole {
  department_id: string;
  code: string;
  role: string; // staff | head
}

export interface Session {
  lineUserId: string;
  displayName?: string;
  linked: boolean;
  employee: EmployeeRow | null;
  isAdmin: boolean;
  deptRoles: DeptRole[];
}

/** อ่าน bearer token, ตรวจกับ LINE แล้วประกอบ session จากฐานข้อมูล */
export async function getSession(req: Request): Promise<Session> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new HttpError(401, "missing bearer token");

  const profile = await verifyIdToken(m[1]);
  const sql = db();

  const rows = await sql<EmployeeRow[]>`
    SELECT e.id, e.employee_code, e.full_name, e.department_id,
           e.department_name, e.floor, e.email, e.status
    FROM line_accounts la
    JOIN employees e ON e.id = la.employee_id
    WHERE la.line_user_id = ${profile.sub} AND la.channel_key = ${CHANNEL_KEY}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return {
      lineUserId: profile.sub,
      displayName: profile.name,
      linked: false,
      employee: null,
      isAdmin: false,
      deptRoles: [],
    };
  }

  const employee = rows[0];
  const deptRoles = await sql<DeptRole[]>`
    SELECT dm.department_id, d.code, dm.role
    FROM department_members dm
    JOIN departments d ON d.id = dm.department_id
    WHERE dm.employee_id = ${employee.id}
  `;

  return {
    lineUserId: profile.sub,
    displayName: profile.name,
    linked: true,
    employee,
    isAdmin: adminCodes().has(employee.employee_code),
    deptRoles: [...deptRoles],
  };
}

/** ต้องยืนยันตัวตนแล้วและไม่ถูกระงับสิทธิ์ */
export function requireActive(s: Session): asserts s is Session & { employee: EmployeeRow } {
  if (!s.linked || !s.employee) throw new HttpError(403, "ยังไม่ได้ยืนยันตัวตน");
  if (s.employee.status === "suspended") throw new HttpError(403, "บัญชีถูกระงับสิทธิ์");
}

/** ต้องเป็นผู้ดูแลระบบ */
export function requireAdmin(s: Session): asserts s is Session & { employee: EmployeeRow } {
  requireActive(s);
  if (!s.isAdmin) throw new HttpError(403, "เฉพาะผู้ดูแลระบบเท่านั้น");
}

/** เป็นสมาชิกของฝ่ายนี้หรือเป็นผู้ดูแล */
export function isMemberOf(s: Session, departmentId: string): boolean {
  if (s.isAdmin) return true;
  return s.deptRoles.some((r) => r.department_id === departmentId);
}
