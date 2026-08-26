// งานตามเวลา — สร้างวันให้บริการของเดือนปัจจุบัน (ทำงานทุกวัน สั่งซ้ำได้ไม่พัง)

import { assertCron } from "./_lib/cron";
import { json, run } from "./_lib/http";
import { runMassageOpenMonth } from "./_lib/massage-jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);
    return json(await runMassageOpenMonth());
  });
