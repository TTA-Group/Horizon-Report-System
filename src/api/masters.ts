// GET /api/masters — หมวด ฝ่าย ชั้น ระดับความเร่งด่วน (spec หัวข้อ 6)
// ต้องล็อกอินก่อน — เป็นระบบภายในองค์กร ไม่ควรเปิดรายชื่อฝ่าย/ชั้นให้คนนอกดูได้

import { getSession } from "./_lib/auth";
import {
  ADMIN_DEPARTMENT_CODE,
  CATEGORIES,
  DUE_OPTIONS,
  FLOORS,
  IMPROVE_CHIPS,
  PRAISE_CHIPS,
  RATING_LABELS,
  URGENCIES,
} from "./_lib/constants";
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
      // บอกไปด้วยว่าฝ่ายไหนให้สิทธิ์ผู้ดูแล — หน้าจอจะได้เตือนตอนกำหนดคนเข้าฝ่ายนั้น
      // โดยไม่ต้องเขียนรหัสฝ่ายซ้ำไว้ฝั่งหน้าจอ (แหล่งความจริงอยู่ที่ ADMIN_DEPARTMENT_CODE)
      departments: departments.map((d) => ({ ...d, grants_admin: d.code === ADMIN_DEPARTMENT_CODE })),
      floors: FLOORS,
      urgencies: URGENCIES,
      // ตัวเลือกกำหนดเสร็จของหน้าแจ้งผลตรวจสอบ — ให้หน้าจอกับการ์ดในไลน์ใช้ชุดเดียวกัน
      // ไม่ต้องเขียนรายการซ้ำสองที่แล้วเผลอแก้ไม่ตรงกัน
      due_options: DUE_OPTIONS.map((d) => ({ key: d.key, chip: d.chip, label: d.label, special: d.special ?? null })),
      // คำชมและสิ่งที่ควรปรับปรุงของหน้าให้คะแนน — เก็บรายการไว้ที่เดียวเหมือนตัวเลือกอื่น
      praise_chips: PRAISE_CHIPS,
      improve_chips: IMPROVE_CHIPS,
      rating_labels: RATING_LABELS,
    });
  });
