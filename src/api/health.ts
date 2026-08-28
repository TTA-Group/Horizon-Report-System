// GET /api/health — ตรวจสุขภาพระบบโดยไม่ต้องล็อกอิน ใช้ไล่หาสาเหตุตอนย้ายที่อยู่ระบบ
//
// บอก 3 อย่าง: ค่าตั้งค่าแต่ละตัว "ตั้งไว้แล้วหรือยัง" (true/false เท่านั้น ไม่แสดงค่า) ·
// "ต่อฐานข้อมูล / ต่อ LINE ได้ไหม" พร้อมเวลาที่ใช้ · และ "รันไฟล์ SQL ที่ต้องรันครบหรือยัง"
//
// ข้อสุดท้ายสำคัญเพราะโค้ดใหม่กับฐานข้อมูลเก่าคือสาเหตุที่เดายากที่สุดเวลาระบบเงียบไปเฉย ๆ
// ตัวจัดการจะพังตั้งแต่คำสั่งอ่านข้อมูล แล้ว error ไปจบใน log ที่ไม่มีใครเปิดดู

import { db } from "./_lib/db";
import { envBinding, envVar } from "./_lib/env";
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
  // rich menu สลับเองไม่ได้ถ้าขาดตัวใดตัวหนึ่ง และอาการคือ "เมนูไม่เปลี่ยน" เฉย ๆ
  // ไม่มี error ให้เห็นที่ไหนเลย จึงต้องตรวจได้จากตรงนี้ว่าตั้งค่าครบหรือยัง
  "RICHMENU_NEW_ID",
  "RICHMENU_MEMBER_ID",
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
        // ไฟล์นี้ไม่ได้เพิ่มคอลัมน์ แต่ย้ายค่าในข้อมูล จึงตรวจจากค่าที่เหลืออยู่แทน
        const legacy = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM line_accounts WHERE channel_key = 'report'
        `;
        files["add-core-channel.sql"] = legacy[0].n === 0;
        if (legacy[0].n > 0) missing.push(`add-core-channel.sql (ยังมีบัญชีผูกด้วยกุญแจเดิม ${legacy[0].n} รายการ)`);

        // ไฟล์นี้เพิ่มทั้งตาราง ไม่ใช่คอลัมน์ จึงตรวจจากว่ามีตารางนั้นหรือยัง
        const tables = await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables WHERE table_name = 'line_followers'
        `;
        files["line-followers.sql"] = tables.length > 0;
        if (tables.length === 0) missing.push("line-followers.sql (ยังไม่มีตาราง line_followers)");

        migrations = { ok: missing.length === 0, files, ...(missing.length > 0 ? { missing } : {}) };
      } catch (e) {
        console.error("[health] migrations", e);
        migrations = { ok: false, error: safeErrorText(e) };
      }
    }

    // แต่ละฝ่ายผูกกลุ่มไลน์ของตัวเองไว้หรือยัง — ฝ่ายที่ไม่มีกลุ่มคือฝ่ายที่เรื่องแจ้งเข้ามาแล้วเงียบหาย
    // และสองฝ่ายที่ใช้กลุ่มเดียวกันคือสาเหตุที่ข้อความในกลุ่มปนกันจนไล่ไม่ทัน
    // ไม่แสดงรหัสกลุ่มจริง เพราะหน้านี้เปิดได้โดยไม่ต้องล็อกอิน
    let groups: Record<string, unknown> = { ok: false, error: "ตรวจไม่ได้เพราะต่อฐานข้อมูลไม่ได้" };
    if (database.ok === true) {
      try {
        const rows = await db()<{ code: string; line_group_id: string | null }[]>`
          SELECT code, line_group_id FROM departments
          WHERE is_active = true AND receives_tickets = true ORDER BY code
        `;
        const unbound = rows.filter((r) => !r.line_group_id).map((r) => r.code);
        const byGroup = new Map<string, string[]>();
        for (const r of rows) {
          if (!r.line_group_id) continue;
          byGroup.set(r.line_group_id, [...(byGroup.get(r.line_group_id) ?? []), r.code]);
        }
        const shared = [...byGroup.values()].filter((codes) => codes.length > 1);
        groups = {
          ok: unbound.length === 0,
          departments: rows.length,
          bound: rows.length - unbound.length,
          ...(unbound.length > 0 ? { unbound } : {}),
          ...(shared.length > 0 ? { shared } : {}),
        };
      } catch (e) {
        console.error("[health] groups", e);
        groups = { ok: false, error: safeErrorText(e) };
      }
    }

    // ระบบจองคิวนวด — ตรวจว่ารันไฟล์ schema กับ seed แล้วหรือยัง และเดือนนี้มีวันให้จองหรือเปล่า
    // แยกออกมาจาก migrations ด้านบนเพราะเป็นคนละระบบ ตารางอาจยังไม่มีเลยก็ได้
    let massage: Record<string, unknown> = { ok: false, error: "ตรวจไม่ได้เพราะต่อฐานข้อมูลไม่ได้" };
    if (database.ok === true) {
      try {
        const sql = db();
        const tables = await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('company_holidays','app_settings','massage_therapists','massage_days','massage_bookings')
        `;
        if (tables.length < 5) {
          const have = new Set(tables.map((t) => t.table_name));
          massage = {
            ok: false,
            error: "ยังไม่ได้รัน db/massage-schema.sql",
            missing: ["company_holidays", "app_settings", "massage_therapists", "massage_days", "massage_bookings"].filter(
              (t) => !have.has(t),
            ),
          };
        } else {
          const [t] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM massage_therapists WHERE is_active = true`;
          const [d] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM massage_days
            WHERE day >= date_trunc('month', CURRENT_DATE) AND day < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
          `;
          const [h] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM company_holidays WHERE day >= CURRENT_DATE`;
          const cfg = await sql<{ key: string; value: string }[]>`
            SELECT key, value FROM app_settings WHERE key LIKE 'massage.%' ORDER BY key
          `;
          const seeded = t.n > 0 && cfg.length > 0;
          massage = {
            ok: seeded,
            ...(seeded ? {} : { error: "ยังไม่ได้รัน db/massage-seed.sql" }),
            therapists: t.n,
            days_this_month: d.n,
            holidays_ahead: h.n,
            // ค่าตั้งของระบบจองไม่ใช่ความลับ (สวิตช์เปิด/ปิด · เวลาเปิดจอง · รหัสฝ่ายผู้ดูแล)
            settings: Object.fromEntries(cfg.map((c) => [c.key, c.value])),
          };
        }
      } catch (e) {
        console.error("[health] massage", e);
        massage = { ok: false, error: safeErrorText(e) };
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

    // รุ่นที่กำลังรันอยู่จริงบนเครื่อง — ตอบคำถาม "ของใหม่ขึ้นไปแล้วหรือยัง" ได้ในที่เดียว
    //
    // เคยเสียเวลาไล่หาสาเหตุว่าทำไมแก้แล้วหน้าจอไม่เปลี่ยน โดยเดาว่าเป็นแคชของเบราว์เซอร์
    // ทั้งที่ของใหม่ยังไม่ได้ deploy ขึ้นไป ต่อไปดู deployed.at ว่าเป็นเวลาหลังแก้หรือเปล่า
    const version = envBinding<{ id: string; timestamp: string }>("CF_VERSION");

    return json({
      ok: database.ok === true && line.ok === true && migrations.ok === true,
      deployed: version
        ? { at: version.timestamp, version: version.id.slice(0, 8) }
        : { at: null, note: "Worker ตัวนี้ยังไม่ได้เปิด version_metadata" },
      config,
      database,
      migrations,
      groups,
      massage,
      line,
    });
  });
