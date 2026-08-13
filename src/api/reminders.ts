// งานตามเวลา: เตือนซ้ำเรื่องที่เกิน SLA (spec หัวข้อ 5.4 / 9.3) — ทุก 15 นาที
// ตรรกะอยู่ใน _lib/jobs.ts เพื่อให้ใช้ร่วมกับ endpoint /api/cron/reminders ได้

import { json, run } from "./_lib/http";
import { runReminders } from "./_lib/jobs";

export default async (): Promise<Response> =>
  run(async () => {
    const result = await runReminders();
    return json({ ok: true, ...result });
  });
