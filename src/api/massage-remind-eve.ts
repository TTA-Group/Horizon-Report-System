// งานตามเวลา — เตือนคนที่มีคิวนวดพรุ่งนี้ (แทนที่นัดใน Outlook ของระบบเดิม)

import { requireCron } from "./_lib/cron";
import { json, methodGuard, run } from "./_lib/http";
import { runMassageEveReminders } from "./_lib/massage-jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    requireCron(req);
    return json(await runMassageEveReminders());
  });
