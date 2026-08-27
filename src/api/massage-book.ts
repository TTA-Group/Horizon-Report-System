// POST /api/massage/book — จองคิว
//
// กติกาทั้งหมด (สิทธิ์รายเดือน · คิวชนกัน · เส้นตัด 15 นาที) บังคับใน _lib/massage.ts
// ที่นี่ทำแค่รับคำขอ เรียกใช้ แล้วส่งการ์ดยืนยันเข้าไลน์

import { getSession, requireActive } from "./_lib/auth";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { pushTo } from "./_lib/line";
import { book } from "./_lib/massage";
import { bookingConfirmCard } from "./_lib/massage-flex";

interface Body {
  day?: string;
  slot?: string;
  therapistId?: string;
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    requireActive(s);

    const b = await readJson<Body>(req);
    const day = (b.day ?? "").trim();
    const slot = (b.slot ?? "").trim();
    const therapistId = (b.therapistId ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "รูปแบบวันที่ไม่ถูกต้อง");
    if (!therapistId) throw new HttpError(400, "กรุณาเลือกหมอนวด");

    const booked = await book({ employeeId: s.employee.id, day, slot, therapistId });

    // การ์ดส่งไม่สำเร็จไม่ควรทำให้การจองที่บันทึกไปแล้วกลายเป็นล้มเหลวในสายตาผู้ใช้
    try {
      await pushTo(s.lineUserId, [
        bookingConfirmCard({
          bookingId: booked.id,
          day: booked.day,
          slot: booked.slot,
          therapistName: booked.therapistName,
          employeeName: s.employee.full_name,
        }),
      ]);
    } catch (e) {
      console.error("[massage] ส่งการ์ดยืนยันไม่สำเร็จ", e);
    }

    return json({ ok: true, booking: booked }, 201);
  });
