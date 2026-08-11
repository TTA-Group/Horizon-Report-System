// POST /api/auth/link — ยืนยันและผูกบัญชี LINE (spec หัวข้อ 5.1 / 6)
//
// สองโหมด:
//  - directory: ระบุ employee_code ที่มีอยู่ในระบบ -> ผูกกับพนักงานคนนั้น
//  - self: ไม่พบรหัส / ไม่ได้ระบุ -> สร้างพนักงานใหม่ source='self' แล้วผูกทันที (ไม่ต้องรออนุมัติ)

import type { Config } from "@netlify/functions";
import { getSession, invalidateSessionByLineUserId } from "./_lib/auth";
import { CHANNEL_KEY } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";

interface Body {
  employee_code?: string;
  full_name?: string;
  department_name?: string;
  floor?: string;
  email?: string;
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    if (s.linked) return json({ ok: true, already: true, employee_id: s.employee?.id });

    const body = await readJson<Body>(req);
    const code = (body.employee_code ?? "").trim().toUpperCase();
    const sql = db();

    try {
      const employeeId = (await sql.begin(async (tx) => {
        // 1) หา employee id — directory mode ถ้ารหัสมีจริง
        let id: string | null = null;
        if (code) {
          const found = await tx`SELECT id FROM employees WHERE employee_code = ${code} LIMIT 1`;
          if (found.length > 0) {
            id = found[0].id as string;
            const already = await tx`
              SELECT 1 FROM line_accounts
              WHERE employee_id = ${id} AND channel_key = ${CHANNEL_KEY} LIMIT 1
            `;
            if (already.length > 0) {
              throw new HttpError(409, "รหัสพนักงานนี้ถูกผูกกับบัญชี LINE อื่นแล้ว กรุณาติดต่อฝ่ายทรัพยากรบุคคล");
            }
          }
        }

        // 2) self mode — สร้างพนักงานใหม่เมื่อไม่พบรหัส
        if (!id) {
          const fullName = (body.full_name ?? "").trim();
          const deptName = (body.department_name ?? "").trim();
          if (!fullName || !deptName) {
            throw new HttpError(400, "กรุณากรอกชื่อ–สกุล และเลือกฝ่าย/แผนก");
          }
          const empCode = code || `SELF-${s.lineUserId.slice(-10)}`;
          const inserted = await tx`
            INSERT INTO employees (employee_code, full_name, department_name, floor, email, source, status)
            VALUES (${empCode}, ${fullName}, ${deptName}, ${body.floor ?? null}, ${body.email ?? null}, 'self', 'active')
            RETURNING id
          `;
          id = inserted[0].id as string;
        }

        // 3) ผูกบัญชี LINE
        await tx`
          INSERT INTO line_accounts (employee_id, line_user_id, channel_key, display_name)
          VALUES (${id}, ${s.lineUserId}, ${CHANNEL_KEY}, ${s.displayName ?? null})
        `;
        return id;
      })) as string;

      invalidateSessionByLineUserId(s.lineUserId);
      return json({ ok: true, employee_id: employeeId });
    } catch (e) {
      // จับ unique violation (เช่น line_user_id ถูกผูกไว้แล้ว หรือ employee_code ซ้ำ)
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "23505") {
        throw new HttpError(409, "บัญชีนี้ถูกผูกไว้แล้ว หรือรหัสพนักงานซ้ำ กรุณาติดต่อฝ่ายทรัพยากรบุคคล");
      }
      throw e;
    }
  });

export const config: Config = { path: "/api/auth/link" };
