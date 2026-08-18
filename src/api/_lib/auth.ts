// การยืนยันตัวตนและตรวจสิทธิ์จาก LINE ID token ใน header Authorization

import { ADMIN_DEPARTMENT_CODE, CHANNEL_KEY, adminCodes } from "./constants";
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

// แคชผล session ในหน่วยความจำของฟังก์ชันสั้น ๆ คีย์ด้วย line_user_id — ทุกการสลับแท็บ
// เดิมต้องยิง 2 คำสั่งค้นหา (employee + dept_roles) ซ้ำทุกครั้งทั้งที่ข้อมูลนี้แทบไม่เปลี่ยน
// ระหว่างที่เปิดแอปอยู่ ตรวจลายเซ็น token ใหม่ทุกครั้งเหมือนเดิม (ส่วนนี้ห้ามข้าม) แค่ข้าม
// การ query ซ้ำถ้าเพิ่ง query ไปไม่เกิน SESSION_TTL_MS — ใช้กับ endpoint ที่ "อ่าน" ข้อมูลเท่านั้น
const SESSION_TTL_MS = 60_000;
const sessionCache = new Map<string, { session: Session; at: number }>();

/** อ่าน bearer token, ตรวจกับ LINE แล้วประกอบ session จากฐานข้อมูล (มีแคชสั้น ๆ ต่อผู้ใช้) */
export async function getSession(req: Request): Promise<Session> {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new HttpError(401, "missing bearer token");

  const profile = await verifyIdToken(m[1]);

  const cached = sessionCache.get(profile.sub);
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.session;

  const sql = db();

  const rows = await sql<EmployeeRow[]>`
    SELECT e.id, e.employee_code, e.full_name, e.department_id,
           e.department_name, e.floor, e.email, e.status
    FROM line_accounts la
    JOIN employees e ON e.id = la.employee_id
    WHERE la.line_user_id = ${profile.sub} AND la.channel_key = ${CHANNEL_KEY}
    LIMIT 1
  `;

  let session: Session;
  if (rows.length === 0) {
    session = {
      lineUserId: profile.sub,
      displayName: profile.name,
      linked: false,
      employee: null,
      isAdmin: false,
      deptRoles: [],
    };
  } else {
    const employee = rows[0];
    const deptRoles = await sql<DeptRole[]>`
      SELECT dm.department_id, d.code, dm.role
      FROM department_members dm
      JOIN departments d ON d.id = dm.department_id
      WHERE dm.employee_id = ${employee.id}
    `;
    session = {
      lineUserId: profile.sub,
      displayName: profile.name,
      linked: true,
      employee,
      // สิทธิ์ผู้ดูแลมาจากการอยู่ในฝ่าย HR เป็นหลัก ส่วน ADMIN_EMPLOYEE_CODES เก็บไว้เป็นทางสำรอง
      // เผื่อกรณีที่ยังไม่มีใครอยู่ในฝ่าย HR เลย จะได้ไม่มีใครเข้าหน้าผู้ดูแลไม่ได้ทั้งระบบ
      isAdmin:
        adminCodes().has(employee.employee_code) ||
        deptRoles.some((r) => r.code === ADMIN_DEPARTMENT_CODE),
      deptRoles: [...deptRoles],
    };
  }

  sessionCache.set(profile.sub, { session, at: Date.now() });
  return session;
}

/** ล้างแคชของ line_user_id นี้ทันที — เรียกหลังผูกบัญชีสำเร็จ (จาก linked:false เป็น true) */
export function invalidateSessionByLineUserId(lineUserId: string): void {
  sessionCache.delete(lineUserId);
}

/** ล้างแคช session ของพนักงานคนหนึ่งทันที — เรียกหลังระงับ/คืนสิทธิ์ กันไม่ให้เห็นสถานะเก่าค้าง */
export function invalidateSessionByEmployeeId(employeeId: string): void {
  for (const [key, v] of sessionCache) {
    if (v.session.employee?.id === employeeId) sessionCache.delete(key);
  }
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
