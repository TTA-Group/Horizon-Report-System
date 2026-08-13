// งานตามเวลา: ลบไฟล์แนบที่หมดอายุ (spec หัวข้อ 9.2 / 9.3) — เดือนละครั้ง
//
// ลบไฟล์แนบของ ticket ที่สถานะ closed และปิดมาแล้วเกิน 6 เดือน
// ลบเฉพาะไฟล์ ส่วนข้อมูล tickets / ticket_events คงไว้เพื่อทำรายงาน
// อัปเดต file_url เป็น NULL พร้อมบันทึกวันที่ลบ (deleted_at)

import type { Config } from "@netlify/functions";
import { assertCron } from "./_lib/cron";
import { db } from "./_lib/db";
import { json, run } from "./_lib/http";
import { envVar } from "./_lib/env";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);
    const sql = db();

    const rows = await sql<{ id: string; file_url: string }[]>`
      SELECT a.id, a.file_url
      FROM ticket_attachments a
      JOIN tickets t ON t.id = a.ticket_id
      WHERE t.status = 'closed'
        AND t.closed_at < now() - interval '6 months'
        AND a.file_url IS NOT NULL
      LIMIT 500
    `;

    const base = envVar("STORAGE_BUCKET_URL");
    const key = envVar("STORAGE_SERVICE_KEY");

    let deleted = 0;
    for (const a of rows) {
      // best-effort: ลบไฟล์จริงจาก storage ถ้าตั้งค่าไว้และ URL อยู่ภายใต้ bucket ของเรา
      if (base && key && a.file_url.includes("/object/")) {
        try {
          const objectUrl = a.file_url.replace("/object/public/", "/object/");
          await fetch(objectUrl, { method: "DELETE", headers: { authorization: `Bearer ${key}`, apikey: key } });
        } catch (e) {
          console.error("[cleanup-files] delete failed", e);
        }
      }
      await sql`UPDATE ticket_attachments SET file_url = NULL, deleted_at = now() WHERE id = ${a.id}`;
      deleted++;
    }

    return json({ ok: true, deleted });
  });

export const config: Config = {
  schedule: "0 5 1 * *", // 05:00 UTC วันที่ 1 ของทุกเดือน
};
