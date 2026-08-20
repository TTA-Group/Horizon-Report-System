// POST /api/cron/reminders — เรียกงานเตือนซ้ำแบบ manual (spec หัวข้อ 6)
// ต้องแนบ header x-cron-secret ให้ตรงกับ CRON_SECRET (spec หัวข้อ 9.3)

import { requireCron } from "./_lib/cron";
import { json, methodGuard, run } from "./_lib/http";
import { runProgressReminders, runReminders } from "./_lib/jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    requireCron(req);
    // สองรอบในงานเดียว: เรื่องที่ยังไม่มีผู้รับ และเรื่องที่รับไปแล้วแต่ยังไม่จบ
    const waiting = await runReminders();
    const inProgress = await runProgressReminders();
    return json({ ok: true, waiting, in_progress: inProgress });
  });
