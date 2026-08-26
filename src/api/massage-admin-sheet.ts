// GET /api/massage/admin/sheet?day=YYYY-MM-DD — ฟอร์มเช็คชื่อสำหรับหน้าจอในแอป
//
// คืนข้อมูลพร้อมชื่อจริง (ต่างจาก /api/massage/day ที่ไม่ส่งชื่อใครออกไปเลย) จึงต้องเป็น
// ผู้ดูแลคิวนวดเท่านั้น พร้อมลิงก์ที่เซ็นกำกับไว้ให้ปุ่ม "ดาวน์โหลดฟอร์ม" พาไปเปิดที่เบราว์เซอร์

import { getSession } from "./_lib/auth";
import { HttpError, json, methodGuard, run } from "./_lib/http";
import { assertMassageStaff, bangkokDate, ensureMonthDays, thaiDayLabel } from "./_lib/massage";
import { buildSheet } from "./_lib/massage-sheet";
import { SHEET_TTL_HOURS, signSheetToken } from "./_lib/massage-token";
import { db } from "./_lib/db";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const url = new URL(req.url);
    const today = bangkokDate();
    await ensureMonthDays(today);

    // รายการวันให้เลือกบนหน้าจอ — ย้อนหลังได้ 1 เดือนเผื่อกรอกเช็คชื่อตามหลัง
    const days = await db()<{ day: string }[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day FROM massage_days
      WHERE day >= (${today}::date - INTERVAL '1 month') AND day < (${today}::date + INTERVAL '2 months')
      ORDER BY day
    `;
    const options = days.map((d) => ({ day: d.day, label: thaiDayLabel(d.day) }));

    const asked = (url.searchParams.get("day") ?? "").trim();
    if (asked && !/^\d{4}-\d{2}-\d{2}$/.test(asked)) {
      throw new HttpError(400, "รูปแบบวันที่ไม่ถูกต้อง");
    }
    // ไม่ระบุวัน = วันให้บริการที่ใกล้ที่สุดจากวันนี้ไป ซึ่งเป็นวันที่คนเปิดหน้านี้ต้องการเกือบทุกครั้ง
    const day = asked || options.find((o) => o.day >= today)?.day || options.at(-1)?.day;
    if (!day) return json({ options: [], sheet: null });

    return json({
      options,
      sheet: await buildSheet(day),
      // ลิงก์เป็นเส้นทางแบบสัมพัทธ์ ให้หน้าเว็บเติมโดเมนเอง — Worker ไม่รู้ว่าตัวเองอยู่โดเมนไหน
      downloadPath: `/api/massage/sheet?t=${encodeURIComponent(signSheetToken(day))}`,
      downloadTtlHours: SHEET_TTL_HOURS,
    });
  });
