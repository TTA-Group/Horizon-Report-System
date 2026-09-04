// กลุ่มไลน์ของทีมที่ดูแลคิวนวด — ผูกกลุ่มไว้แล้วระบบจะแจ้งเตือนเข้ากลุ่มเมื่อมีคนยกเลิกคิว
//
// มีเพราะการยกเลิกเป็นเรื่องที่ทีมหน้างานต้องรู้ทันที ช่องที่ว่างกลางวันคือช่องที่ยกให้
// คนในคิวด่วนได้ ถ้ารู้ช้าก็เสียไปเปล่า ๆ และคนที่ไม่มาก็ไม่มีใครรู้จนหมอนวดนั่งรอ
//
// เก็บรหัสกลุ่มไว้ที่ app_settings ซึ่งเป็นตารางของกลางที่มีอยู่แล้ว — ไม่ต้องรัน SQL เพิ่ม
// และใช้ตารางเดียวกับค่าตั้งอื่นของระบบนวด จึงดูที่เดียวจบว่าตั้งอะไรไว้บ้าง

import { db } from "./db";
import { pushTo, textMessage, type LineMessage } from "./line";

export const NOTIFY_GROUP_KEY = "massage.notify_group";

/** รหัสกลุ่มที่ผูกไว้ · null = ยังไม่ได้ผูก */
export async function massageGroupId(): Promise<string | null> {
  try {
    const rows = await db()<{ value: string }[]>`
      SELECT value FROM app_settings WHERE key = ${NOTIFY_GROUP_KEY}
    `;
    const v = (rows[0]?.value ?? "").trim();
    return v || null;
  } catch (e) {
    console.error("[massage] อ่านรหัสกลุ่มแจ้งเตือนไม่สำเร็จ", e);
    return null;
  }
}

export async function bindMassageGroup(groupId: string, byEmployeeId: string): Promise<void> {
  await db()`
    INSERT INTO app_settings (key, value, updated_by)
    VALUES (${NOTIFY_GROUP_KEY}, ${groupId}, ${byEmployeeId})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
}

export async function unbindMassageGroup(byEmployeeId: string): Promise<void> {
  await db()`
    INSERT INTO app_settings (key, value, updated_by)
    VALUES (${NOTIFY_GROUP_KEY}, '', ${byEmployeeId})
    ON CONFLICT (key) DO UPDATE
      SET value = '', updated_by = EXCLUDED.updated_by, updated_at = now()
  `;
}

/**
 * ส่งเข้ากลุ่ม — ห้ามทำให้งานหลักล้มไม่ว่ากรณีใด
 *
 * การแจ้งเตือนเป็นของแถม ถ้าส่งไม่สำเร็จ (ยังไม่ผูกกลุ่ม · บอทถูกเตะออก · โควตาหมด)
 * การยกเลิกคิวต้องสำเร็จเหมือนเดิม ไม่ใช่พังตามไปด้วยแล้วคนกดต้องกดซ้ำ
 *
 * คืน true เมื่อส่งออกไปจริง — ให้ชุดทดสอบตรวจได้ว่าเงียบเพราะอะไร
 */
export async function notifyMassageGroup(messages: LineMessage[]): Promise<boolean> {
  try {
    const groupId = await massageGroupId();
    if (!groupId) return false;
    return await pushTo(groupId, messages);
  } catch (e) {
    console.error("[massage] แจ้งเตือนเข้ากลุ่มไม่สำเร็จ", e);
    return false;
  }
}

export interface CancelNotice {
  name: string;
  code: string;
  dayLabel: string;
  slotLabel: string;
  therapistName: string;
  /** ยกเลิกหลังวันถูกล็อก = สิทธิ์ไม่คืน — ทีมงานต้องรู้ เผื่อเจ้าตัวมาทักถามทีหลัง */
  keptQuota: boolean;
  /** ผู้ดูแลเป็นคนยกเลิกให้ ไม่ใช่เจ้าตัวกดเอง */
  byStaffName?: string;
}

/**
 * ข้อความแจ้งเข้ากลุ่ม — ตั้งใจใช้ข้อความธรรมดา ไม่ใช่การ์ด
 *
 * กลุ่มงานอ่านแบบกวาดตา ข้อความสั้น ๆ หลายบรรทัดอ่านเร็วกว่าการ์ดที่กินพื้นที่ทั้งจอ
 * และไม่ต้องกดอะไรต่อ — ข้อมูลที่ต้องใช้อยู่ครบในบรรทัดเดียวกันหมดแล้ว
 */
export function cancelNoticeText(n: CancelNotice): string {
  const who = n.byStaffName
    ? `${n.name} (${n.code})\nเจ้าหน้าที่ ${n.byStaffName} ยกเลิกให้`
    : `${n.name} (${n.code})`;
  const quota = n.keptQuota
    ? "สิทธิ์ครั้งนี้ไม่คืน (ยกเลิกหลังปิดรับจอง)"
    : "สิทธิ์คืนให้แล้ว";
  return [
    "🔕 ยกเลิกคิวนวด",
    who,
    `${n.dayLabel} · ${n.slotLabel}`,
    n.therapistName,
    "",
    `ช่องนี้ว่างแล้ว · ${quota}`,
  ].join("\n");
}

export function cancelNoticeMessage(n: CancelNotice): LineMessage {
  return textMessage(cancelNoticeText(n));
}
