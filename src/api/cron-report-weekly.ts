// งานตามเวลา: ส่งสรุปงานรายสัปดาห์ให้หัวหน้าฝ่าย — เช้าวันจันทร์ (พูดถึงสัปดาห์ที่เพิ่งจบ)

import { assertCron } from "./_lib/cron";
import { json, run } from "./_lib/http";
import { sendDeptReports } from "./_lib/report-jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);
    return json({ ok: true, period: "week", ...(await sendDeptReports("week")) });
  });
