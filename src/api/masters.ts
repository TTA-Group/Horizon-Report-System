// GET /api/masters — หมวด ฝ่าย ชั้น ระดับความเร่งด่วน (spec หัวข้อ 6)
// ต้องล็อกอินก่อน — เป็นระบบภายในองค์กร ไม่ควรเปิดรายชื่อฝ่าย/ชั้นให้คนนอกดูได้

import { getSession } from "./_lib/auth";
import { CATEGORIES, FLOORS, URGENCIES } from "./_lib/constants";
import { db } from "./_lib/db";
import { json, methodGuard, run } from "./_lib/http";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    await getSession(req);
    const sql = db();
    // ส่งมาทุกฝ่ายที่เปิดใช้งาน พร้อมบอกว่าฝ่ายไหนรับเรื่องแจ้ง — หน้าจอเลือกใช้ต่างกันตามบริบท
    // (ส่งต่อฝ่ายและคิวงานใช้เฉพาะฝ่ายที่รับเรื่อง ส่วนหน้าผู้ดูแลกำหนดคนเข้าได้ทุกฝ่ายรวมถึง HR)
    const departments = await sql<{ code: string; name: string; receives_tickets: boolean }[]>`
      SELECT code, name, receives_tickets FROM departments WHERE is_active = true ORDER BY code
    `;
    return json({
      categories: CATEGORIES.map((c) => ({ code: c.code, label: c.label, dept_code: c.deptCode })),
      departments: [...departments],
      floors: FLOORS,
      urgencies: URGENCIES,
    });
  });
