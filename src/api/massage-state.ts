// GET /api/massage/state — ทุกอย่างที่หน้าจองต้องรู้ ในคำขอเดียว
//
// รวมสถานะระบบ วันที่เปิดจอง สิทธิ์ที่เหลือ และคิวของตัวเองไว้ด้วยกัน เพราะหน้าจอต้องใช้
// ทั้งหมดพร้อมกันตั้งแต่เปิดแอป การแยกเป็นสามคำขอทำให้เห็นหน้ากระพริบสามจังหวะ

import { getSession, requireActive } from "./_lib/auth";
import { json, methodGuard, run } from "./_lib/http";
import { assertMassageStaff, massageState, myBookings } from "./_lib/massage";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireActive(s);

    const [state, mine] = await Promise.all([
      massageState(s.employee.id),
      myBookings(s.employee.id),
    ]);

    // ปุ่ม "ฟอร์มเช็คชื่อ" จะโผล่หรือไม่ ให้เซิร์ฟเวอร์เป็นคนตัดสิน ไม่ใช่ให้หน้าเว็บเดาจากรายชื่อฝ่าย
    // ตัวหน้าเว็บไม่รู้ว่าฝ่ายไหนคือฝ่ายที่ดูแลคิวนวด (ตั้งไว้ใน app_settings) และถ้าเดาผิด
    // จะได้ปุ่มที่กดแล้วเจอ 403 ซึ่งแย่กว่าไม่มีปุ่ม
    let canManage = true;
    try {
      await assertMassageStaff(s);
    } catch {
      canManage = false;
    }

    return json({ ...state, mine, canManage });
  });
