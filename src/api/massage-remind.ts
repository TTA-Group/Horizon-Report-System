// งานตามเวลา — เตือนก่อนถึงคิวประมาณ 15 นาที (รอบเดียว)
//
// แยกเส้นทางไว้เหมือนงานอื่น เพื่อให้สั่งเองได้ตอนไล่หาสาเหตุ ไม่ต้องรอ cron รอบถัดไป

import { requireCron } from "./_lib/cron";
import { json, methodGuard, run } from "./_lib/http";
import { runMassageReminders } from "./_lib/massage-jobs";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    requireCron(req);
    return json(await runMassageReminders());
  });
