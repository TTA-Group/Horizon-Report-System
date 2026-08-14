// GET /api/health — ตรวจสุขภาพระบบโดยไม่ต้องล็อกอิน ใช้ไล่หาสาเหตุตอนย้ายที่อยู่ระบบ
//
// บอกแค่ 2 อย่าง: ค่าตั้งค่าแต่ละตัว "ตั้งไว้แล้วหรือยัง" (true/false เท่านั้น ไม่แสดงค่า)
// และ "ต่อฐานข้อมูล / ต่อ LINE ได้ไหม" พร้อมเวลาที่ใช้ ทำให้แยกได้ว่าปัญหาอยู่ตรงไหน

import { db } from "./_lib/db";
import { envVar } from "./_lib/env";
import { json, methodGuard, run, safeErrorText } from "./_lib/http";

const CONFIG_KEYS = [
  "DATABASE_URL",
  "LINE_LOGIN_CHANNEL_ID",
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "STORAGE_BUCKET_URL",
  "BACKUP_BUCKET_URL",
  "STORAGE_SERVICE_KEY",
  "ADMIN_EMPLOYEE_CODES",
  "COMPANY_EMAIL_DOMAIN",
  "MASSAGE_WEBHOOK_URL",
  "CRON_SECRET",
];

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");

    const config: Record<string, boolean> = {};
    for (const key of CONFIG_KEYS) config[key] = envVar(key) !== undefined;

    let database: Record<string, unknown>;
    const dbStart = Date.now();
    try {
      const sql = db();
      await sql`SELECT 1`;
      database = { ok: true, ms: Date.now() - dbStart };
    } catch (e) {
      console.error("[health] database", e);
      database = { ok: false, ms: Date.now() - dbStart, error: safeErrorText(e) };
    }

    let line: Record<string, unknown>;
    const lineStart = Date.now();
    try {
      const res = await fetch("https://api.line.me/oauth2/v2.1/certs");
      line = { ok: res.ok, status: res.status, ms: Date.now() - lineStart };
    } catch (e) {
      console.error("[health] line", e);
      line = { ok: false, ms: Date.now() - lineStart, error: safeErrorText(e) };
    }

    return json({
      ok: database.ok === true && line.ok === true,
      config,
      database,
      line,
    });
  });
