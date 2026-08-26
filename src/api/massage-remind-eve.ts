// งานตามเวลา — เตือนคนที่มีคิวนวดพรุ่งนี้ (แทนที่นัดใน Outlook ของระบบเดิม)

import { assertCron } from "./_lib/cron";
import { json, run } from "./_lib/http";
import { runMassageEveReminders } from "./_lib/massage-jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);
    return json(await runMassageEveReminders());
  });
