// งานตามเวลา: สำรองข้อมูลรายสัปดาห์ (spec หัวข้อ 9.2 / 9.3)
//
// ส่งออกตารางหลักเป็น JSON แล้วเก็บไว้ที่ storage (โฟลเดอร์ backups/)
// TODO: ตามสเปกควรนำไปเก็บ "นอกผู้ให้บริการเดิม" (เช่น SharePoint/OneDrive)
//       เมื่อมี credential ปลายทางแล้วให้เปลี่ยนปลายทางการอัปโหลดในฟังก์ชันนี้

import type { Config } from "@netlify/functions";
import { assertCron } from "./_lib/cron";
import { db } from "./_lib/db";
import { json, run } from "./_lib/http";

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

    const base = process.env.STORAGE_BUCKET_URL;
    const key = process.env.STORAGE_SERVICE_KEY;
    if (base && key) {
      const date = new Date().toISOString().slice(0, 10);
      const url = `${base.replace(/\/$/, "")}/backups/backup-${date}.json`;
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

    // ยังไม่ได้ตั้งค่าที่เก็บ — บันทึก log ปริมาณไว้ก่อน
    console.log("[backup] storage not configured; counts=", counts, "bytes=", payload.byteLength);
    return json({ ok: true, stored: false, bytes: payload.byteLength, counts });
  });

export const config: Config = {
  schedule: "0 4 * * 0", // 04:00 UTC ทุกวันอาทิตย์
};
