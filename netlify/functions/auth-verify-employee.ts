// POST /api/auth/verify-employee — ค้นหาด้วยรหัสพนักงาน คืนข้อมูลให้ตรวจสอบ (spec หัวข้อ 5.1 / 6)

import type { Config } from "@netlify/functions";
import { getSession } from "./_lib/auth";
import { CHANNEL_KEY } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";

interface Body {
  employee_code?: string;
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    await getSession(req); // ต้องมี LINE token ที่ถูกต้องก่อน

    const { employee_code } = await readJson<Body>(req);
    const code = (employee_code ?? "").trim().toUpperCase();
    if (!code) throw new HttpError(400, "กรุณาระบุรหัสพนักงาน");

    const sql = db();
    const rows = await sql<
      { id: string; employee_code: string; full_name: string; department_name: string | null; floor: string | null; email: string | null; status: string }[]
    >`
      SELECT id, employee_code, full_name, department_name, floor, email, status
      FROM employees WHERE employee_code = ${code} LIMIT 1
    `;

    if (rows.length === 0) return json({ found: false });

    const e = rows[0];
    const linked = await sql`
      SELECT 1 FROM line_accounts
      WHERE employee_id = ${e.id} AND channel_key = ${CHANNEL_KEY} LIMIT 1
    `;

    return json({
      found: true,
      already_linked: linked.length > 0,
      employee: {
        employee_code: e.employee_code,
        full_name: e.full_name,
        department_name: e.department_name,
        floor: e.floor,
        email: e.email,
      },
    });
  });

export const config: Config = { path: "/api/auth/verify-employee" };
