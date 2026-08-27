// งานตามเวลาของระบบจองคิวนวด
//
// สองงาน ทำงานเองทั้งหมด ไม่มีขั้นตอนไหนที่ต้องรอคนเข้าไปกด:
//   1. เปิดเดือนใหม่  — สร้างวันศุกร์ของเดือนปัจจุบัน ข้ามวันหยุด
//   2. เตือนก่อนถึงคิว — รอบเดียว ก่อนถึงเวลานวดประมาณ 15 นาที
//
// เคยมีเตือนสามรอบ (เย็นวันก่อน · ก่อนถึงครึ่งชั่วโมง · ก่อนถึง 15 นาที) แล้วตัดเหลือรอบเดียว
// ตามที่เจ้าของงานสั่ง — เตือนถี่เกินไปคนจะเริ่มปัดข้อความทิ้งโดยไม่อ่าน ซึ่งแย่กว่าเตือนน้อย
//
// ข้อความเตือนส่งเป็นข้อความส่วนตัวถึงเจ้าตัว ไม่ได้ส่งเข้ากลุ่มไหนทั้งสิ้น
// ระบบจองคิวนวดไม่แตะกลุ่มไลน์เลย ส่วนฟอร์มเช็คชื่อเป็นปุ่มดาวน์โหลดในหน้าผู้ดูแล

import { CHANNEL_KEYS_READ } from "./constants";
import { db } from "./db";
import { pushTo, textMessage } from "./line";
import { massageNotice } from "./massage-flex";
import { bangkokDate, ensureMonthDays, slotStartAt } from "./massage";

/** งานที่ 1 — ทำให้เดือนปัจจุบันมีวันให้จองเสมอ */
export async function runMassageOpenMonth(now = new Date()): Promise<{ days: number }> {
  const made = await ensureMonthDays(bangkokDate(now));
  return { days: made.length };
}

/** ส่งเมื่อเหลือไม่เกินกี่นาทีก่อนรอบเริ่ม */
const REMIND_WINDOW = 20;

interface DueRow {
  id: string;
  day: string;
  slot: string;
  therapist: string;
  line_user_id: string;
}

/**
 * งานที่ 2 — เตือนก่อนถึงคิวประมาณ 15 นาที
 *
 * ช่วงที่ยอมส่งคือ 0 ถึง 20 นาทีก่อนรอบเริ่ม กว้างกว่า 15 นาทีอยู่หน่อย
 * เพราะงานตามเวลาทำงานทุก 15 นาที ถ้าจับเป๊ะ ๆ ที่ 15 จะมีคิวที่หลุดไปเงียบ ๆ
 *
 * join line_accounts เพื่อเอา userId ที่ push ได้ — คนที่ถูกปลดการผูกบัญชีไปแล้วจะไม่มีแถว
 * และหลุดออกจากผลลัพธ์เอง ไม่ต้องเช็คเพิ่ม
 */
export async function runMassageReminders(now = new Date()): Promise<{ sent: number }> {
  const today = bangkokDate(now);
  const sql = db();

  const due = await sql<DueRow[]>`
    SELECT b.id, to_char(b.day, 'YYYY-MM-DD') AS day, to_char(b.slot_start, 'HH24:MI') AS slot,
           t.name AS therapist, la.line_user_id
    FROM massage_bookings b
    JOIN massage_therapists t ON t.id = b.therapist_id
    JOIN line_accounts la ON la.employee_id = b.employee_id AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
    WHERE b.status = 'booked' AND b.remind_15_at IS NULL AND b.day = ${today}::date
    ORDER BY b.slot_start
    LIMIT 200
  `;

  const from = now.getTime();
  const sent: string[] = [];
  for (const b of due) {
    const at = slotStartAt(b.day, b.slot).getTime();
    const left = at - from;
    if (left < 0 || left > REMIND_WINDOW * 60_000) continue;
    const mins = Math.max(1, Math.round(left / 60_000));
    await pushTo(b.line_user_id, [
      textMessage(
        massageNotice(
          `ใกล้ถึงคิวนวดของคุณแล้ว อีกประมาณ ${mins} นาที`,
          b.day,
          b.slot,
          b.therapist,
          "กรุณาไปแสดงตนที่ห้องนวด\nหากไม่แสดงตนเกิน 10 นาที เจ้าหน้าที่จะปล่อยคิวให้ท่านอื่น",
        ),
      ),
    ]);
    sent.push(b.id);
  }
  if (sent.length > 0) {
    await sql`UPDATE massage_bookings SET remind_15_at = now() WHERE id = ANY(${sent}::uuid[])`;
  }
  return { sent: sent.length };
}
