// POST /api/auth/verify-employee — ค้นหาด้วยรหัสพนักงาน คืนข้อมูล "แบบปิดบัง" ให้ยืนยันตัวตน
// (spec หัวข้อ 5.1 / 6 — ปรับให้ไม่คืนข้อมูลส่วนบุคคลแบบเต็มตามข้อกำหนดความปลอดภัยหัวข้อ 10)
//
// เหตุผลที่ต้องปิดบัง: รหัสพนักงานเป็นตัวเลข 5 หลัก (แค่ 100,000 ค่า) ถ้าคืนชื่อ–สกุลและอีเมลเต็ม
// ผู้ที่มีบัญชี LINE ใดก็ได้จะไล่ยิงทุกรหัสเพื่อดูดรายชื่อพนักงานทั้งองค์กรได้
// จึงคืนเฉพาะข้อมูลที่ "พอให้เจ้าตัวยืนยันว่าใช่ตนเอง" แต่ไม่พอให้คนอื่นเอาไปใช้ประโยชน์
// และจำกัดจำนวนครั้งที่ลองต่อบัญชี LINE หนึ่งบัญชี

import type { Config } from "@netlify/functions";
import { getSession } from "./_lib/auth";
import { CHANNEL_KEY } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";

interface Body {
  employee_code?: string;
}

// จำกัดการลองรหัสต่อบัญชี LINE — กันการไล่ยิงรหัสทีละเลข
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 10 * 60_000; // 10 นาที
const attempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(lineUserId: string): void {
  const now = Date.now();
  const cur = attempts.get(lineUserId);
  if (!cur || now > cur.resetAt) {
    attempts.set(lineUserId, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  cur.count++;
  if (cur.count > ATTEMPT_LIMIT) {
    throw new HttpError(429, "ลองรหัสพนักงานบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่");
  }
}

/** ปิดบังชื่อ: "สมชาย ใจดี" -> "สมช*** ใ***" (เหลือพอให้เจ้าตัวรู้ว่าใช่ตนเอง) */
function maskName(full: string): string {
  return full
    .trim()
    .split(/\s+/)
    .map((part) => (part.length <= 1 ? part + "***" : part.slice(0, Math.min(3, part.length - 1)) + "***"))
    .join(" ");
}

/** ปิดบังอีเมล: "somchai.j@thoresen.com" -> "som***@thoresen.com" */
function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  return local.slice(0, Math.min(3, local.length)) + "***" + email.slice(at);
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req); // ต้องมี LINE token ที่ถูกต้องก่อน
    checkRateLimit(s.lineUserId);

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
        full_name: maskName(e.full_name),
        department_name: e.department_name,
        floor: e.floor,
        email: maskEmail(e.email),
      },
    });
  });

export const config: Config = { path: "/api/auth/verify-employee" };
