// GET /api/admin/employees — รายชื่อผู้ใช้งาน (เฉพาะผู้ดูแล) (spec หัวข้อ 6)
// query: ?q=คำค้น&status=active|suspended

import type { Config } from "@netlify/functions";
import { getSession, requireAdmin } from "./_lib/auth";
import { CHANNEL_KEY } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, run } from "./_lib/http";

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
    const qFilter = q ? sql`AND (e.employee_code ILIKE ${"%" + q + "%"} OR e.full_name ILIKE ${"%" + q + "%"} OR e.department_name ILIKE ${"%" + q + "%"})` : sql``;
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
        linked: boolean;
      }[]
    >`
      SELECT e.id, e.employee_code, e.full_name, e.department_name, e.floor, e.status,
             e.suspended_at, e.suspend_reason,
             (SELECT count(*)::int FROM tickets t WHERE t.reporter_id = e.id) AS reported_count,
             EXISTS (
               SELECT 1 FROM line_accounts la
               WHERE la.employee_id = e.id AND la.channel_key = ${CHANNEL_KEY}
             ) AS linked
      FROM employees e
      WHERE 1=1 ${qFilter} ${statusFilter}
      ORDER BY e.status DESC, e.employee_code ASC
      LIMIT 200
    `;

    return json({ employees: [...rows] });
  });

export const config: Config = { path: "/api/admin/employees" };
