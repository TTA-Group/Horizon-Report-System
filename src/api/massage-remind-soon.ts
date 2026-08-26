// งานตามเวลา — เตือนคนที่คิวนวดกำลังจะถึงในอีกประมาณครึ่งชั่วโมง

import { assertCron } from "./_lib/cron";
import { json, run } from "./_lib/http";
import { runMassageSoonReminders } from "./_lib/massage-jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);
    return json(await runMassageSoonReminders());
  });
