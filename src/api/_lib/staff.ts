// รายชื่อบัญชีไลน์ของเจ้าหน้าที่ประจำฝ่าย สำหรับส่งข้อความส่วนตัว
//
// ทำไมต้องส่งส่วนตัว: บัญชีทางการของ LINE ส่ง @mention ไม่ได้ (ทดลองแล้วทั้งเรียกรายคนและ
// เรียกทั้งกลุ่ม LINE รับข้อความไว้แต่ทิ้งส่วนที่เป็นการเรียกทิ้งเงียบ ๆ ไม่มี error)
// การ์ดในกลุ่มจึงปลุกใครไม่ได้ถ้าเขาปิดเสียงกลุ่มไว้ — ข้อความส่วนตัวเป็นทางเดียวที่เตือนถึงตัวคนจริง
//
// ใช้เฉพาะตอนงานค้างเกินกำหนดเท่านั้น ไม่ได้ใช้กับทุกเรื่องที่แจ้งเข้ามา เพราะแต่ละข้อความ
// นับโควตารายเดือนของ OA ที่ใช้ร่วมกับระบบอื่น

import { CHANNEL_KEY, CHANNEL_KEYS_READ } from "./constants";
import { db } from "./db";

/**
 * บัญชีไลน์ของเจ้าหน้าที่ฝ่ายนี้ที่ยังไม่ถูกระงับสิทธิ์และผูกบัญชีไว้แล้ว
 * (คนที่ยังไม่ผูกบัญชีส่งหาไม่ได้ เพราะระบบยังไม่รู้ว่าไลน์ไหนคือเขา)
 */
export async function departmentStaffLineIds(departmentId: string): Promise<string[]> {
  const sql = db();
  const rows = await sql<{ line_user_id: string }[]>`
    SELECT la.line_user_id
    FROM department_members dm
    JOIN employees e ON e.id = dm.employee_id AND e.status = 'active'
    JOIN line_accounts la ON la.employee_id = dm.employee_id AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
    WHERE dm.department_id = ${departmentId}
  `;
  return rows.map((r) => r.line_user_id);
}
