// งานตามเวลาของระบบจองคิวนวด
//
// สามงาน ทำงานเองทั้งหมด ไม่มีขั้นตอนไหนที่ต้องรอคนเข้าไปกด:
//   1. เปิดเดือนใหม่      — สร้างวันศุกร์ของเดือนปัจจุบัน ข้ามวันหยุด
//   2. เตือนล่วงหน้า 1 วัน — แทนที่นัดใน Outlook ของระบบเดิม
//   3. เตือนก่อนถึงคิว     — กันคนลืมทั้งที่อยู่ในตึกเดียวกัน
//
// ข้อความเตือนส่งเป็นข้อความส่วนตัวถึงเจ้าตัว ไม่ได้ส่งเข้ากลุ่มไหนทั้งสิ้น
// ระบบจองคิวนวดไม่แตะกลุ่มไลน์เลย ส่วนฟอร์มเช็คชื่อเป็นปุ่มดาวน์โหลดในหน้าผู้ดูแล

import { CHANNEL_KEYS_READ } from "./constants";
import { db } from "./db";
import { pushTo, textMessage } from "./line";
import { bangkokDate, ensureMonthDays, slotStartAt } from "./massage";
import { reminderText } from "./massage-flex";

/** งานที่ 1 — ทำให้เดือนปัจจุบันมีวันให้จองเสมอ */
export async function runMassageOpenMonth(now = new Date()): Promise<{ days: number }> {
  const made = await ensureMonthDays(bangkokDate(now));
  return { days: made.length };
}

interface DueRow {
  id: string;
  day: string;
  slot: string;
  therapist: string;
  line_user_id: string;
}

/**
 * งานที่ 2 — เตือนคนที่มีคิว "พรุ่งนี้"
 *
 * ตั้งให้ทำงานเย็น ๆ ตามเวลาไทย พรุ่งนี้ในที่นี้จึงหมายถึงวันถัดจากวันนี้ตามเวลาไทยจริง ๆ
 * ทำทุกวันไม่ใช่เฉพาะวันพฤหัสบดี เผื่ออนาคตเพิ่มวันให้บริการที่ไม่ใช่วันศุกร์
 * วันที่ไม่มีคิวก็ไม่มีอะไรให้ทำ ไม่ต้องเช็คว่าวันนี้เป็นวันอะไร
 *
 * join line_accounts เพื่อเอา userId ที่ push ได้ — คนที่ถูกปลดการผูกบัญชีไปแล้วจะไม่มีแถว
 * และหลุดออกจากผลลัพธ์เอง ไม่ต้องเช็คเพิ่ม
 */
export async function runMassageEveReminders(now = new Date()): Promise<{ sent: number }> {
  const today = bangkokDate(now);
  const tomorrow = bangkokDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  if (tomorrow === today) return { sent: 0 };

  const sql = db();
  const due = await sql<DueRow[]>`
    SELECT b.id, to_char(b.day, 'YYYY-MM-DD') AS day, to_char(b.slot_start, 'HH24:MI') AS slot,
           t.name AS therapist, la.line_user_id
    FROM massage_bookings b
    JOIN massage_therapists t ON t.id = b.therapist_id
    JOIN line_accounts la ON la.employee_id = b.employee_id AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
    WHERE b.status = 'booked' AND b.remind_eve_at IS NULL AND b.day = ${tomorrow}::date
    ORDER BY b.slot_start
    LIMIT 200
  `;

  const sent: string[] = [];
  for (const b of due) {
    await pushTo(b.line_user_id, [textMessage(reminderText(b.day, b.slot, b.therapist))]);
    // ทำเครื่องหมายแม้ส่งไม่สำเร็จ ไม่งั้นคนที่บล็อกบัญชีไปแล้วจะถูกพยายามส่งซ้ำทุกรอบตลอดไป
    sent.push(b.id);
  }
  if (sent.length > 0) {
    await sql`UPDATE massage_bookings SET remind_eve_at = now() WHERE id = ANY(${sent}::uuid[])`;
  }
  return { sent: sent.length };
}

/** เตือนก่อนถึงคิวประมาณเท่าไหร่ */
const SOON_MINUTES = 30;

/**
 * งานที่ 3 — เตือนคนที่คิวกำลังจะถึง
 *
 * ใช้ช่วงกว้างกว่ารอบการทำงานของงานตามเวลา (ทำงานทุก 15 นาที ช่วงกว้าง 45 นาที)
 * เพื่อให้รอบที่พลาดไปหนึ่งครั้งยังตามเก็บได้ ส่วนการส่งซ้ำกันด้วย remind_soon_at
 */
export async function runMassageSoonReminders(now = new Date()): Promise<{ sent: number }> {
  const today = bangkokDate(now);
  const sql = db();

  const due = await sql<DueRow[]>`
    SELECT b.id, to_char(b.day, 'YYYY-MM-DD') AS day, to_char(b.slot_start, 'HH24:MI') AS slot,
           t.name AS therapist, la.line_user_id
    FROM massage_bookings b
    JOIN massage_therapists t ON t.id = b.therapist_id
    JOIN line_accounts la ON la.employee_id = b.employee_id AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
    WHERE b.status = 'booked' AND b.remind_soon_at IS NULL AND b.day = ${today}::date
    ORDER BY b.slot_start
    LIMIT 200
  `;

  const from = now.getTime();
  const until = from + (SOON_MINUTES + 15) * 60_000;

  const sent: string[] = [];
  for (const b of due) {
    const at = slotStartAt(b.day, b.slot).getTime();
    if (at < from || at > until) continue;
    const mins = Math.max(1, Math.round((at - from) / 60_000));
    await pushTo(b.line_user_id, [
      textMessage(`อีกประมาณ ${mins} นาทีถึงคิวนวดของคุณ\nเวลา ${b.slot} · ${b.therapist}`),
    ]);
    sent.push(b.id);
  }
  if (sent.length > 0) {
    await sql`UPDATE massage_bookings SET remind_soon_at = now() WHERE id = ANY(${sent}::uuid[])`;
  }
  return { sent: sent.length };
}
