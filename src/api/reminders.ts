// งานตามเวลา: เตือนซ้ำเรื่องที่ค้าง (spec หัวข้อ 5.4 / 9.3) — ทุก 15 นาที
// ครอบทั้งเรื่องที่ยังไม่มีผู้รับ และเรื่องที่รับไปแล้วแต่ยังไม่แจ้งผล/เลยกำหนด/รออะไหล่
// ตรรกะอยู่ใน _lib/jobs.ts เพื่อให้ใช้ร่วมกับ endpoint /api/cron/reminders ได้

import { json, run } from "./_lib/http";
import { runProgressReminders, runReminders } from "./_lib/jobs";

export default async (): Promise<Response> =>
  run(async () => {
    // สองรอบในงานเดียว: เรื่องที่ยังไม่มีผู้รับ และเรื่องที่รับไปแล้วแต่ยังไม่จบ
    const waiting = await runReminders();
    const inProgress = await runProgressReminders();
    return json({ ok: true, waiting, in_progress: inProgress });
  });
