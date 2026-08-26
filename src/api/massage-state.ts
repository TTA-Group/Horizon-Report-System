// GET /api/massage/state — ทุกอย่างที่หน้าจองต้องรู้ ในคำขอเดียว
//
// รวมสถานะระบบ วันที่เปิดจอง สิทธิ์ที่เหลือ และคิวของตัวเองไว้ด้วยกัน เพราะหน้าจอต้องใช้
// ทั้งหมดพร้อมกันตั้งแต่เปิดแอป การแยกเป็นสามคำขอทำให้เห็นหน้ากระพริบสามจังหวะ

import { getSession, requireActive } from "./_lib/auth";
import { json, methodGuard, run } from "./_lib/http";
import { massageState, myBookings } from "./_lib/massage";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireActive(s);

    const [state, mine] = await Promise.all([
      massageState(s.employee.id),
      myBookings(s.employee.id),
    ]);
    return json({ ...state, mine });
  });
