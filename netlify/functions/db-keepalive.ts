// งานตามเวลา: ป้องกันฐานข้อมูลระดับฟรีถูกพักการทำงาน (spec หัวข้อ 9.2 / 9.3) — วันละครั้ง

import type { Config } from "@netlify/functions";
import { assertCron } from "./_lib/cron";
import { db } from "./_lib/db";
import { json, run } from "./_lib/http";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);
    const sql = db();
    await sql`SELECT 1`;
    return json({ ok: true, ts: new Date().toISOString() });
  });

export const config: Config = {
  schedule: "0 3 * * *", // 03:00 UTC ทุกวัน
};
