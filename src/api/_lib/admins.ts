// รายชื่อผู้มีสิทธิ์ในระบบ และกติกากันไม่ให้ถอดผู้ดูแลคนสุดท้ายออก
//
// "ผู้ดูแล" ในระบบนี้ไม่ได้เก็บเป็นธงบนแถวพนักงาน แต่เกิดจากการเป็นสมาชิกของฝ่าย
// (department_members) ซึ่งเป็นข้อมูลกลางที่ทุกระบบใช้ร่วมกันอยู่แล้ว
//   • อยู่ฝ่าย HR      = ผู้ดูแลระบบเต็มสิทธิ์ (auth.ts: isAdmin)
//   • อยู่ฝ่ายอื่น      = รับเรื่องแจ้งของฝ่ายนั้น และเป็นผู้ดูแลของระบบที่ผูกกับฝ่ายนั้น
// การจัดการผู้ดูแลจึงเท่ากับการจัดการสมาชิกฝ่าย ไม่ต้องมีตารางสิทธิ์แยกอีกชุด

import { ADMIN_DEPARTMENT_CODE, adminCodes } from "./constants";
import { db } from "./db";
import { HttpError } from "./http";

export interface AdminMember {
  id: string;
  employee_code: string;
  full_name: string;
  department_name: string | null;
  status: string;
  role: string; // head | staff
  linked: boolean;
}

export interface AdminGroup {
  code: string;
  name: string;
  /** true = สมาชิกฝ่ายนี้เป็นผู้ดูแลระบบเต็มสิทธิ์ */
  system: boolean;
  /** สิ่งที่การอยู่ฝ่ายนี้ให้สิทธิ์ทำ — เขียนให้อ่านบนหน้าจอ ไม่ใช่ให้โค้ดตัดสินใจ */
  grants: string;
  members: AdminMember[];
}

/**
 * ฝ่ายที่ดูแลคิวนวด — อ่านจาก app_settings เพื่อ "ตั้งชื่อกลุ่ม" บนหน้าจอเท่านั้น
 *
 * ระบบกลางไม่ได้ตัดสินสิทธิ์ของระบบจองคิวจากค่านี้ (ตัวตัดสินอยู่ที่ assertMassageStaff
 * ในระบบจองคิว) แต่หน้าจัดการผู้ดูแลที่ไม่บอกว่าฝ่ายนี้เปิดหน้าผู้ดูแลคิวนวดได้
 * ก็คือหน้าที่ซ่อนผู้ดูแลไปหนึ่งกลุ่ม ซึ่งแย่กว่าการอ่านค่าตั้งค่ากลางมาหนึ่งบรรทัด
 */
async function massageStaffDept(): Promise<string> {
  const rows = await db()<{ value: string }[]>`
    SELECT value FROM app_settings WHERE key = 'massage.staff_dept' LIMIT 1
  `;
  return (rows[0]?.value ?? "ADM").trim().toUpperCase();
}

function grantsText(code: string, receivesTickets: boolean, massageCode: string): string {
  if (code === ADMIN_DEPARTMENT_CODE) {
    return "เข้าถึงได้ทุกอย่าง — ทะเบียนพนักงาน · หน้าผู้ดูแลระบบ · คิวงานทุกฝ่าย · หน้าผู้ดูแลคิวนวด";
  }
  const parts: string[] = [];
  if (receivesTickets) parts.push("รับเรื่องแจ้งที่ส่งเข้าฝ่ายนี้");
  if (code === massageCode) parts.push("เปิดฟอร์มเช็คชื่อ จองคิวแทนพนักงาน และเปิดปิดวันให้บริการคิวนวด");
  return parts.length ? parts.join(" · ") : "ระบุสังกัดเท่านั้น ไม่ได้เพิ่มสิทธิ์อะไร";
}

/** ทุกคนที่ถือสิทธิ์อยู่ตอนนี้ แบ่งตามฝ่าย — HR ขึ้นก่อน แล้วฝ่ายที่ดูแลคิวนวด แล้วที่เหลือตามรหัส */
export async function listAdmins(): Promise<{ groups: AdminGroup[]; fallbackCodes: string[] }> {
  const massageCode = await massageStaffDept();
  const rows = await db()<
    { code: string; name: string; receives_tickets: boolean; id: string; employee_code: string;
      full_name: string; department_name: string | null; status: string; role: string; linked: boolean }[]
  >`
    SELECT d.code, d.name, d.receives_tickets,
           e.id, e.employee_code, e.full_name, e.department_name, e.status, dm.role,
           EXISTS (SELECT 1 FROM line_accounts la WHERE la.employee_id = e.id) AS linked
    FROM department_members dm
    JOIN departments d ON d.id = dm.department_id AND d.is_active = true
    JOIN employees e ON e.id = dm.employee_id
    ORDER BY d.code, dm.role, e.full_name
  `;

  const byCode = new Map<string, AdminGroup>();
  for (const r of rows) {
    if (!byCode.has(r.code)) {
      byCode.set(r.code, {
        code: r.code,
        name: r.name,
        system: r.code === ADMIN_DEPARTMENT_CODE,
        grants: grantsText(r.code, r.receives_tickets, massageCode),
        members: [],
      });
    }
    byCode.get(r.code)!.members.push({
      id: r.id, employee_code: r.employee_code, full_name: r.full_name,
      department_name: r.department_name, status: r.status, role: r.role, linked: r.linked,
    });
  }

  const rank = (c: string) => (c === ADMIN_DEPARTMENT_CODE ? 0 : c === massageCode ? 1 : 2);
  const groups = [...byCode.values()].sort(
    (a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code),
  );
  return { groups, fallbackCodes: [...adminCodes()] };
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
