// งานตามเวลา: สรุปปริมาณการใช้ Messaging API ให้ผู้ดูแล (spec หัวข้อ 9.2 / 9.3) — ต้นเดือน
//
// รวมยอดของเดือนก่อนหน้าจาก message_logs แล้ว push สรุปให้ผู้ดูแลระบบ (ADMIN_EMPLOYEE_CODES)

import { CHANNEL_KEY, adminCodes } from "./_lib/constants";
import { assertCron } from "./_lib/cron";
import { db } from "./_lib/db";
import { json, run } from "./_lib/http";
import { pushTo, textMessage } from "./_lib/line";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);
    const sql = db();

    const agg = await sql<{ api_type: string; channel: string; n: number; ok: number }[]>`
      SELECT api_type, channel, count(*)::int AS n,
             sum(CASE WHEN succeeded THEN 1 ELSE 0 END)::int AS ok
      FROM message_logs
      WHERE created_at >= date_trunc('month', now()) - interval '1 month'
        AND created_at <  date_trunc('month', now())
      GROUP BY api_type, channel
      ORDER BY api_type, channel
    `;

    const total = agg.reduce((sum, r) => sum + r.n, 0);
    const lines = agg.map((r) => `• ${r.api_type}/${r.channel}: ${r.n} (สำเร็จ ${r.ok})`);
    const summary = `สรุปการใช้ Messaging API เดือนก่อนหน้า\nรวมทั้งหมด ${total} ข้อความ\n${lines.join("\n") || "ไม่มีข้อมูล"}`;

    const codes = [...adminCodes()];
    let sent = 0;
    if (codes.length > 0) {
      const admins = await sql<{ line_user_id: string }[]>`
        SELECT la.line_user_id
        FROM employees e
        JOIN line_accounts la ON la.employee_id = e.id AND la.channel_key = ${CHANNEL_KEY}
        WHERE e.employee_code = ANY(${codes})
      `;
      for (const a of admins) {
        await pushTo(a.line_user_id, [textMessage(summary)], { channel: "user" });
        sent++;
      }
    }

    return json({ ok: true, total, breakdown: [...agg], notified_admins: sent });
  });
