// งานตามเวลา — สร้างวันให้บริการของเดือนปัจจุบัน (ทำงานทุกวัน สั่งซ้ำได้ไม่พัง)

import { requireCron } from "./_lib/cron";
import { json, methodGuard, run } from "./_lib/http";
import { runMassageOpenMonth } from "./_lib/massage-jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    requireCron(req);
    return json(await runMassageOpenMonth());
  });
