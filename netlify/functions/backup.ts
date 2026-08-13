// งานตามเวลา: สำรองข้อมูลรายสัปดาห์ (spec หัวข้อ 9.2 / 9.3)
//
// ⚠️ ไฟล์สำรองมีข้อมูลส่วนบุคคลของพนักงานทุกคน (ชื่อ อีเมล line_user_id) จึงต้องเก็บใน
// bucket ปิดที่แยกจาก bucket ของภาพแนบเสมอ — ภาพแนบต้องเป็น public เพื่อให้แสดงในแอปได้
// ถ้าเขียนไฟล์สำรองลงที่เดียวกัน ข้อมูลพนักงานทั้งองค์กรจะโหลดได้จาก URL ที่เดาง่าย (ชื่อไฟล์เป็นวันที่)
//
// กำหนดปลายทางด้วย BACKUP_BUCKET_URL (ต้องเป็น bucket แบบ private เท่านั้น)
// ถ้าไม่ได้ตั้งค่าไว้ จะ "ไม่เขียนไฟล์" โดยเด็ดขาด (ไม่ fallback ไปใช้ STORAGE_BUCKET_URL)
//
// TODO: ตามสเปกควรนำไปเก็บ "นอกผู้ให้บริการเดิม" (เช่น SharePoint/OneDrive)
//       เมื่อมี credential ปลายทางแล้วให้เปลี่ยนปลายทางการอัปโหลดในฟังก์ชันนี้

import type { Config } from "@netlify/functions";
import { assertCron } from "./_lib/cron";
import { db } from "./_lib/db";
import { json, run } from "./_lib/http";
import { envVar } from "./_lib/env";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);
    const sql = db();

    const [employees, lineAccounts, departments, tickets, ticketEvents] = await Promise.all([
      sql`SELECT * FROM employees`,
      sql`SELECT * FROM line_accounts`,
      sql`SELECT * FROM departments`,
      sql`SELECT * FROM tickets`,
      sql`SELECT * FROM ticket_events`,
    ]);

    const dump = {
      exported_at: new Date().toISOString(),
      tables: {
        employees: [...employees],
        line_accounts: [...lineAccounts],
        departments: [...departments],
        tickets: [...tickets],
        ticket_events: [...ticketEvents],
      },
    };
    const payload = Buffer.from(JSON.stringify(dump), "utf-8");

    const counts = {
      employees: employees.length,
      line_accounts: lineAccounts.length,
      departments: departments.length,
      tickets: tickets.length,
      ticket_events: ticketEvents.length,
    };

    // ใช้เฉพาะ bucket สำรองที่กำหนดไว้ต่างหากเท่านั้น ห้าม fallback ไป STORAGE_BUCKET_URL (public)
    const base = envVar("BACKUP_BUCKET_URL");
    const key = envVar("STORAGE_SERVICE_KEY");
    if (base && key) {
      const date = new Date().toISOString().slice(0, 10);
      const url = `${base.replace(/\/$/, "")}/backup-${date}.json`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          apikey: key,
          "content-type": "application/json",
          "x-upsert": "true",
        },
        body: payload,
      });
      if (!res.ok) console.error("[backup]", res.status, await res.text().catch(() => ""));
      return json({ ok: res.ok, stored: res.ok, bytes: payload.byteLength, counts });
    }

    // ยังไม่ได้ตั้งค่า bucket สำรอง — ไม่เขียนไฟล์ (ยอมไม่มีสำรอง ดีกว่าเขียนลงที่ที่คนนอกอ่านได้)
    console.warn("[backup] BACKUP_BUCKET_URL not set — skipped writing backup file; counts=", counts);
    return json({ ok: true, stored: false, reason: "BACKUP_BUCKET_URL not set", bytes: payload.byteLength, counts });
  });

export const config: Config = {
  schedule: "0 4 * * 0", // 04:00 UTC ทุกวันอาทิตย์
};
