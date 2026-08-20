// งานตามเวลา: ส่งสรุปงานรายเดือนให้หัวหน้าฝ่าย — วันที่ 1 (พูดถึงเดือนที่เพิ่งจบ)

import { assertCron } from "./_lib/cron";
import { json, run } from "./_lib/http";
import { sendDeptReports } from "./_lib/report-jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);
    return json({ ok: true, period: "month", ...(await sendDeptReports("month")) });
  });
