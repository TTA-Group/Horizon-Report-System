// ส่งข้อความหาเจ้าของคิวทางไลน์
//
// แยกออกมาเป็นไฟล์ของตัวเองเพราะทั้งหน้าจัดการคิวและหน้าจัดการวันต้องใช้เหมือนกัน
// และทั้งสองที่ต้องการพฤติกรรมเดียวกันคือ "ส่งไม่ได้ก็ไม่ให้ทั้งคำขอล้ม" — งานหลัก
// บันทึกลงฐานข้อมูลไปแล้ว ถ้าปล่อยให้ล้มเพราะส่งข้อความไม่ได้ ผู้ดูแลจะกดซ้ำแล้วซ้ำอีก
// ทั้งที่ของถูกบันทึกไปตั้งแต่ครั้งแรก

import { db } from "./db";
import { pushTo, textMessage } from "./line";
import type { LineMessage } from "./line";

/** ส่งอะไรก็ได้ที่ไลน์รับ — ข้อความเปล่าหรือการ์ด แล้วแต่ว่าเรื่องนั้นต้องมีปุ่มให้กดต่อไหม */
export async function notifyEmployeeWith(
  employeeId: string,
  messages: LineMessage[],
): Promise<void> {
  try {
    const rows = await db()<{ line_user_id: string }[]>`
      SELECT line_user_id FROM line_accounts
      WHERE employee_id = ${employeeId} AND channel_key = 'core'
    `;
    if (rows.length > 0) await pushTo(rows[0].line_user_id, messages);
  } catch (e) {
    console.error("[massage] แจ้งเจ้าของคิวไม่สำเร็จ", e);
  }
}

export async function notifyEmployee(employeeId: string, text: string): Promise<void> {
  await notifyEmployeeWith(employeeId, [textMessage(text)]);
}
