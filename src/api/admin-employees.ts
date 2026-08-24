// GET /api/admin/employees — รายชื่อผู้ใช้งาน (เฉพาะผู้ดูแล) (spec หัวข้อ 6)
// query: ?q=คำค้น&status=active|suspended
//
// ส่งทั้งองค์กรมาในครั้งเดียว เพราะหน้าผู้ดูแลจัดกลุ่มตามฝ่ายและนับจำนวนคนของแต่ละฝ่ายเอง
// ถ้าตัดรายชื่อทิ้งกลางทาง ตัวเลขที่ขึ้นข้างชื่อฝ่ายจะผิดโดยไม่มีอะไรบอก

import { getSession, requireAdmin } from "./_lib/auth";
import { CHANNEL_KEY, CHANNEL_KEYS_READ } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, run } from "./_lib/http";
import { thaiDateTime } from "./_lib/tickets";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireAdmin(s);

    const params = new URL(req.url).searchParams;
    const q = (params.get("q") ?? "").trim();
    const status = (params.get("status") ?? "").trim();
    if (status && status !== "active" && status !== "suspended") {
      throw new HttpError(400, "สถานะไม่ถูกต้อง");
    }

    const sql = db();
    // ค้นด้วยชื่อในไลน์ได้ด้วย — ผู้ดูแลเห็นชื่อแปลก ๆ ในกลุ่มแล้วอยากรู้ว่าเป็นพนักงานคนไหน
    const qFilter = q
      ? sql`AND (e.employee_code ILIKE ${"%" + q + "%"} OR e.full_name ILIKE ${"%" + q + "%"} OR e.department_name ILIKE ${"%" + q + "%"} OR la.display_name ILIKE ${"%" + q + "%"})`
      : sql``;
    const statusFilter = status ? sql`AND e.status = ${status}` : sql``;

    const rows = await sql<
      {
        id: string;
        employee_code: string;
        full_name: string;
        department_name: string | null;
        floor: string | null;
        status: string;
        suspended_at: string | null;
        suspend_reason: string | null;
        reported_count: number;
        line_display_name: string | null;
        line_user_id: string | null;
        linked_at: string | null;
        depts: { code: string; role: string }[] | null;
      }[]
    >`
      SELECT e.id, e.employee_code, e.full_name, e.department_name, e.floor, e.status,
             e.suspended_at, e.suspend_reason,
             (SELECT count(*)::int FROM tickets t WHERE t.reporter_id = e.id) AS reported_count,
             la.display_name AS line_display_name, la.line_user_id, la.linked_at,
             (SELECT json_agg(json_build_object('code', d.code, 'role', dm.role) ORDER BY d.code)
                FROM department_members dm
                JOIN departments d ON d.id = dm.department_id
               WHERE dm.employee_id = e.id AND d.is_active = true) AS depts
      FROM employees e
      -- 1 คนผูกได้ 1 บัญชีต่อระบบ (UNIQUE employee_id, channel_key) การ join ตรงนี้จึงไม่ทำให้แถวซ้ำ
      LEFT JOIN line_accounts la ON la.employee_id = e.id AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
      WHERE 1=1 ${qFilter} ${statusFilter}
      ORDER BY e.status DESC, e.employee_code ASC
      LIMIT 1000
    `;

    // รวมข้อมูลบัญชีไลน์เป็นก้อนเดียว เพื่อให้หน้าจอเช็คแค่ว่า line เป็น null หรือไม่
    const employees = rows.map(({ line_display_name, line_user_id, linked_at, ...e }) => ({
      ...e,
      linked: line_user_id !== null,
      line: line_user_id
        ? {
            display_name: line_display_name,
            user_id: line_user_id,
            linked_at: linked_at ? thaiDateTime(new Date(linked_at)) : null,
          }
        : null,
    }));

    return json({ employees });
  });
