// GET /api/health — ตรวจสุขภาพระบบโดยไม่ต้องล็อกอิน ใช้ไล่หาสาเหตุตอนย้ายที่อยู่ระบบ
//
// บอก 3 อย่าง: ค่าตั้งค่าแต่ละตัว "ตั้งไว้แล้วหรือยัง" (true/false เท่านั้น ไม่แสดงค่า) ·
// "ต่อฐานข้อมูล / ต่อ LINE ได้ไหม" พร้อมเวลาที่ใช้ · และ "รันไฟล์ SQL ที่ต้องรันครบหรือยัง"
//
// ข้อสุดท้ายสำคัญเพราะโค้ดใหม่กับฐานข้อมูลเก่าคือสาเหตุที่เดายากที่สุดเวลาระบบเงียบไปเฉย ๆ
// ตัวจัดการจะพังตั้งแต่คำสั่งอ่านข้อมูล แล้ว error ไปจบใน log ที่ไม่มีใครเปิดดู

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

    // คอลัมน์ที่มาจากไฟล์ migration แต่ละไฟล์ — ขาดตัวไหนแปลว่ายังไม่ได้รันไฟล์นั้น
    let migrations: Record<string, unknown> = { ok: false, error: "ตรวจไม่ได้เพราะต่อฐานข้อมูลไม่ได้" };
    if (database.ok === true) {
      try {
        const sql = db();
        const cols = await sql<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns WHERE table_name = 'tickets'
        `;
        const have = new Set(cols.map((c) => c.column_name));
        const need: Record<string, string[]> = {
          "add-followup.sql": ["due_at", "assessment", "assessed_at", "waiting_parts"],
          "add-rating.sql": ["rating", "rating_note", "rated_at"],
        };
        const missing: string[] = [];
        const files: Record<string, boolean> = {};
        for (const [file, columns] of Object.entries(need)) {
          const gap = columns.filter((c) => !have.has(c));
          files[file] = gap.length === 0;
          if (gap.length > 0) missing.push(`${file} (ขาด ${gap.join(", ")})`);
        }
        migrations = { ok: missing.length === 0, files, ...(missing.length > 0 ? { missing } : {}) };
      } catch (e) {
        console.error("[health] migrations", e);
        migrations = { ok: false, error: safeErrorText(e) };
      }
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
      ok: database.ok === true && line.ok === true && migrations.ok === true,
      config,
      database,
      migrations,
      line,
    });
  });
