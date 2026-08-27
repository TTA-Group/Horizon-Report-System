// GET /api/admin/admins — รายชื่อผู้ดูแลระบบ (เฉพาะผู้ดูแล)
//
// เดิมคำถามว่า "ตอนนี้ใครเป็นผู้ดูแลบ้าง" ตอบได้ทางเดียวคือเปิดทะเบียนพนักงานแล้วไล่ดูป้าย
// ทีละคน ซึ่งตอบไม่ได้จริงเมื่อมีคนหลายร้อยคน
//
// คืนเฉพาะผู้ดูแลระบบเต็มสิทธิ์เท่านั้น หัวหน้าฝ่ายและผู้รับผิดชอบของฝ่ายอื่นไม่นับ —
// เป็นคนละเรื่องกัน และดูได้ที่ทะเบียนพนักงานซึ่งมีคนทั้งองค์กรอยู่แล้ว
//
// การเพิ่ม/ถอด ใช้เส้นทางเดิมคือ PATCH /api/admin/employees/:id/departments
// เพราะ "ผู้ดูแล" ในระบบนี้คือสมาชิกฝ่าย ไม่ใช่ข้อมูลคนละชุด ถ้าเขียนทางเขียนขึ้นมาอีกเส้น
// จะมีสองที่ที่แก้เรื่องเดียวกัน แล้วกติกาอย่าง "ต้องเหลือผู้ดูแลหนึ่งคน" จะหลุดที่ใดที่หนึ่ง

import { getSession, requireAdmin } from "./_lib/auth";
import { listAdmins } from "./_lib/admins";
import { json, methodGuard, run } from "./_lib/http";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireAdmin(s);

    const { admins, fallbackCodes } = await listAdmins();
    // บอกด้วยว่าคนที่เปิดหน้านี้คือใคร หน้าจอจะได้เตือนตอนกำลังจะถอดสิทธิ์ของตัวเอง
    return json({ admins, fallbackCodes, me: s.employee.id });
  });
