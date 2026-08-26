// งานตามเวลา — เตือนคนที่คิวนวดกำลังจะถึงในอีกประมาณครึ่งชั่วโมง

import { requireCron } from "./_lib/cron";
import { json, methodGuard, run } from "./_lib/http";
import { runMassageSoonReminders } from "./_lib/massage-jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    requireCron(req);
    return json(await runMassageSoonReminders());
  });
