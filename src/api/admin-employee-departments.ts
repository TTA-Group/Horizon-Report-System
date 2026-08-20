// PATCH /api/admin/employees/:id/departments — กำหนดสถานะของพนักงานหนึ่งคน (เฉพาะผู้ดูแล)
//
// body มีสองแบบ
//   { department_code, role }  role = "head" (หัวหน้าฝ่าย) | "staff" (ผู้รับผิดชอบฝ่าย) | "" (ถอดออกจากฝ่ายนั้น)
//   { department_code, role, replace: true }  เหมือนข้างบน แต่ถอดออกจากฝ่ายอื่นทั้งหมดด้วย (ย้ายฝ่าย)
//   { clear_all: true }        ถอดออกจากทุกฝ่าย = กลับเป็นพนักงานทั่วไป
//
// เดิมงานนี้ต้องเข้าไปแก้ฐานข้อมูลเอง ซึ่งแปลว่าเวลามีคนย้ายฝ่ายหรือลาออกจริง ๆ ระบบจะค้าง
// อยู่กับรายชื่อเก่าจนกว่าจะมีคนที่เขียน SQL เป็นมาแก้ให้

import { getSession, invalidateSessionByEmployeeId, requireAdmin } from "./_lib/auth";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";

interface Body {
  department_code?: string;
  role?: string | null;
  /** ย้ายฝ่าย: ถอดออกจากฝ่ายอื่นทั้งหมดพร้อมกับใส่เข้าฝ่ายนี้ */
  replace?: boolean;
  clear_all?: boolean;
}

function employeeIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','admin','employees','<id>','departments']
  return seg[3] ?? "";
}

/** ฝ่ายที่พนักงานคนนี้ดูแลอยู่ (เฉพาะฝ่ายที่ยังเปิดใช้งาน) */
async function departmentsOf(employeeId: string) {
  const sql = db();
  const rows = await sql<{ code: string; name: string; role: string }[]>`
    SELECT d.code, d.name, dm.role
    FROM department_members dm
    JOIN departments d ON d.id = dm.department_id
    WHERE dm.employee_id = ${employeeId} AND d.is_active = true
    ORDER BY d.code
  `;
  return [...rows];
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "PATCH", "POST");
    const s = await getSession(req);
    requireAdmin(s);

    const id = employeeIdFromPath(req);
    if (!id) throw new HttpError(404, "ไม่พบพนักงานคนนี้");

    const body = await readJson<Body>(req);
    const clearAll = body.clear_all === true;
    const code = (body.department_code ?? "").trim().toUpperCase();
    const role = (body.role ?? "").trim();
    if (!clearAll) {
      if (!code) throw new HttpError(400, "กรุณาระบุฝ่าย");
      if (role && role !== "head" && role !== "staff") throw new HttpError(400, "ตำแหน่งไม่ถูกต้อง");
    }

    const sql = db();
    const emp = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM employees WHERE id = ${id} LIMIT 1
    `;
    if (emp.length === 0) throw new HttpError(404, "ไม่พบพนักงานคนนี้");
    if (!clearAll && role && emp[0].status === "suspended") {
      throw new HttpError(400, "พนักงานคนนี้ถูกระงับสิทธิ์อยู่ กรุณาคืนสิทธิ์ก่อนกำหนดฝ่าย");
    }

    if (clearAll) {
      // สถานะ "พนักงาน" คือไม่ดูแลฝ่ายใดเลย — ถอดออกทุกฝ่ายในครั้งเดียว
      // ไม่ต้องให้ผู้ดูแลนั่งไล่ถอดทีละฝ่ายและเสี่ยงลืมฝ่ายใดฝ่ายหนึ่งไว้
      await sql`DELETE FROM department_members WHERE employee_id = ${id}`;
    } else {
      const dept = await sql<{ id: string; name: string }[]>`
        SELECT id, name FROM departments WHERE code = ${code} AND is_active = true LIMIT 1
      `;
      if (dept.length === 0) throw new HttpError(404, "ไม่พบฝ่ายนี้ หรือฝ่ายนี้ถูกปิดใช้งานอยู่");

      if (!role) {
        await sql`DELETE FROM department_members WHERE department_id = ${dept[0].id} AND employee_id = ${id}`;
      } else {
        // ย้ายฝ่าย: ถอดฝ่ายอื่นออกก่อน ไม่งั้นคนคนนั้นจะกลายเป็นดูแลสองฝ่ายพร้อมกัน
        // แล้วรับทั้งคิวงานและการเตือนของฝ่ายที่ไม่ได้เกี่ยวข้องด้วย
        if (body.replace === true) {
          await sql`
            DELETE FROM department_members
            WHERE employee_id = ${id} AND department_id <> ${dept[0].id}
          `;
        }
        await sql`
          INSERT INTO department_members (department_id, employee_id, role)
          VALUES (${dept[0].id}, ${id}, ${role})
          ON CONFLICT (department_id, employee_id) DO UPDATE SET role = EXCLUDED.role
        `;
      }
    }

    // ปลายทางการเตือนซ้ำต้องเป็นหัวหน้าฝ่ายที่ยังทำงานอยู่เสมอ คำนวณใหม่จากความจริงล่าสุด
    // แทนที่จะไล่แก้เป็นกรณี ๆ ไป — ไม่มีหัวหน้าเหลือก็ปล่อยว่าง แล้วการเตือนขั้นนั้นจะข้ามไปเอง
    // คำนวณใหม่ทุกฝ่ายไปเลย เพราะการถอดออกทุกฝ่ายกระทบได้หลายฝ่ายพร้อมกัน และมีฝ่ายอยู่ไม่กี่แถว
    await sql`
      UPDATE departments d SET escalate_to = (
        SELECT dm.employee_id
        FROM department_members dm
        JOIN employees e ON e.id = dm.employee_id AND e.status = 'active'
        WHERE dm.department_id = d.id AND dm.role = 'head'
        ORDER BY e.employee_code
        LIMIT 1
      )
    `;

    // สิทธิ์ของคนคนนี้เพิ่งเปลี่ยน — ล้างแคช session ทันที ไม่งั้นเขาจะยังเห็นคิวงานชุดเดิมอีกนาทีหนึ่ง
    invalidateSessionByEmployeeId(id);

    return json({ ok: true, departments: await departmentsOf(id) });
  });
