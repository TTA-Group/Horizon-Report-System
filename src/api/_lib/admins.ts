// รายชื่อผู้ดูแลระบบ และกติกากันไม่ให้ถอดคนสุดท้ายออก
//
// "ผู้ดูแลระบบ" ในระบบนี้ = คนที่อยู่ในฝ่ายบุคคล (ADMIN_DEPARTMENT_CODE) ซึ่ง auth.ts
// แปลเป็น isAdmin = เข้าถึงได้ทุกอย่างในทุกระบบ
//
// การเป็นหัวหน้าฝ่ายหรือผู้รับผิดชอบของฝ่ายอื่น *ไม่ใช่* ผู้ดูแลระบบ — เป็นแค่คนที่รับเรื่อง
// ของฝ่ายนั้น จึงไม่อยู่ในไฟล์นี้และไม่อยู่ในหน้าผู้ดูแลระบบ แต่จัดการที่ทะเบียนพนักงาน
// ซึ่งเป็นที่ที่ดูคนทั้งองค์กรอยู่แล้ว การเอาสองเรื่องนี้มารวมหน้าเดียวทำให้อ่านผิดได้ว่า
// หัวหน้าฝ่ายมีสิทธิ์เท่าฝ่ายบุคคล ซึ่งไม่จริงและเป็นความเข้าใจผิดที่อันตราย

import { ADMIN_DEPARTMENT_CODE, adminCodes } from "./constants";
import { db } from "./db";
import { HttpError } from "./http";

export interface AdminRow {
  id: string;
  employee_code: string;
  full_name: string;
  department_name: string | null;
  status: string;
  linked: boolean;
}

/** ทุกคนที่เป็นผู้ดูแลระบบตอนนี้ */
export async function listAdmins(): Promise<{ admins: AdminRow[]; fallbackCodes: string[] }> {
  const rows = await db()<AdminRow[]>`
    SELECT e.id, e.employee_code, e.full_name, e.department_name, e.status,
           EXISTS (SELECT 1 FROM line_accounts la WHERE la.employee_id = e.id) AS linked
    FROM department_members dm
    JOIN departments d ON d.id = dm.department_id AND d.is_active = true
    JOIN employees e ON e.id = dm.employee_id
    WHERE d.code = ${ADMIN_DEPARTMENT_CODE}
    ORDER BY e.full_name
  `;
  return { admins: [...rows], fallbackCodes: [...adminCodes()] };
}

/** ผู้ดูแลระบบที่ยังใช้งานได้จริงตอนนี้มีกี่คน (ไม่นับคนที่ถูกระงับสิทธิ์) */
async function activeAdminCount(exceptEmployeeId?: string): Promise<number> {
  const rows = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM department_members dm
    JOIN departments d ON d.id = dm.department_id AND d.is_active = true
    JOIN employees e ON e.id = dm.employee_id AND e.status = 'active'
    WHERE d.code = ${ADMIN_DEPARTMENT_CODE}
      AND (${exceptEmployeeId ?? null}::uuid IS NULL OR e.id <> ${exceptEmployeeId ?? null}::uuid)
  `;
  return rows[0]?.n ?? 0;
}

/**
 * กันไม่ให้ระบบเหลือผู้ดูแลศูนย์คน
 *
 * ถ้าถอดคนสุดท้ายออกได้ จะไม่มีใครเข้าหน้าผู้ดูแลได้อีกเลย รวมถึงหน้าที่ใช้ถอด/ใส่สิทธิ์นี้ด้วย
 * ทางแก้เดียวคือให้คนที่เขียน SQL เป็นเข้าไปแก้ฐานข้อมูลให้ ซึ่งเป็นสถานการณ์ที่ทั้งระบบนี้
 * ตั้งใจกำจัดออกไปตั้งแต่แรก จึงกันไว้ที่ทุกทางที่ทำให้เกิดได้ ไม่ใช่กันแค่ที่หน้าจอ
 *
 * ADMIN_EMPLOYEE_CODES เป็นทางสำรองที่ตั้งไว้ในค่า env ถ้ามีตั้งไว้ก็ยังมีทางกลับเข้าระบบ
 * จึงไม่ต้องกัน
 */
export async function assertKeepsOneAdmin(employeeId: string, what: string): Promise<void> {
  if (adminCodes().size > 0) return;
  const isAdminNow = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM department_members dm
    JOIN departments d ON d.id = dm.department_id AND d.is_active = true
    JOIN employees e ON e.id = dm.employee_id AND e.status = 'active'
    WHERE d.code = ${ADMIN_DEPARTMENT_CODE} AND e.id = ${employeeId}
  `;
  if ((isAdminNow[0]?.n ?? 0) === 0) return; // ไม่ได้เป็นผู้ดูแลอยู่แล้ว ถอดยังไงก็ไม่ทำให้เหลือศูนย์
  if ((await activeAdminCount(employeeId)) > 0) return;
  throw new HttpError(
    409,
    `${what}ไม่ได้ เพราะเป็นผู้ดูแลระบบคนสุดท้าย — ตั้งผู้ดูแลคนใหม่ก่อน แล้วค่อยถอดคนนี้ออก`,
    "last_admin",
  );
}
