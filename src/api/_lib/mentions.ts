// การ @mention เจ้าหน้าที่ของฝ่ายที่รับผิดชอบ ในกลุ่มไลน์ที่ทุกฝ่ายใช้ร่วมกัน
//
// ทุกฝ่ายอยู่กลุ่มเดียวกัน การ์ดจึงปนกันหมด — mention คือตัวบอกว่า "เรื่องนี้ของใคร"
// และทำให้คนที่ถูกเรียกได้รับการแจ้งเตือนจริง แม้จะปิดเสียงกลุ่มไว้
//
// ข้อจำกัดของ LINE ที่ต้องรู้:
//   - mention ใช้ได้เฉพาะข้อความตัวอักษร ใส่ใน Flex ไม่ได้ จึงต้องส่งคู่กันเป็น 2 ส่วน
//   - ต้องเขียนชื่อลงในข้อความเอง แล้วบอกตำแหน่งเริ่มต้นและความยาวของชื่อนั้น
//   - ได้ไม่เกิน 20 คนต่อข้อความ

import { CHANNEL_KEY } from "./constants";
import { db } from "./db";
import type { LineMessage } from "./line";

export interface Mentionee {
  index: number;
  length: number;
  /** ต้องระบุเสมอ — ถ้าไม่ใส่ LINE จะรับข้อความไว้เฉย ๆ แต่แสดงชื่อเป็นตัวหนังสือธรรมดา ไม่เรียกใคร */
  type: "user";
  userId: string;
}

export interface MentionTarget {
  userId: string;
  name: string;
}

/**
 * เจ้าหน้าที่ของฝ่ายที่ควรถูกเรียกในกลุ่ม — เฉพาะคนที่ยังไม่ถูกระงับสิทธิ์และผูกบัญชีไลน์แล้ว
 * (คนที่ยังไม่ผูกบัญชีจะ mention ไม่ได้ เพราะระบบยังไม่รู้ userId ของเขา)
 */
export async function departmentMentionTargets(departmentId: string): Promise<MentionTarget[]> {
  const sql = db();
  const rows = await sql<{ line_user_id: string; full_name: string; display_name: string | null }[]>`
    SELECT la.line_user_id, e.full_name, la.display_name
    FROM department_members dm
    JOIN employees e ON e.id = dm.employee_id AND e.status = 'active'
    JOIN line_accounts la ON la.employee_id = dm.employee_id AND la.channel_key = ${CHANNEL_KEY}
    WHERE dm.department_id = ${departmentId}
    ORDER BY CASE WHEN dm.role = 'head' THEN 0 ELSE 1 END, e.full_name
    LIMIT 20
  `;
  return rows.map((r) => ({ userId: r.line_user_id, name: r.display_name || r.full_name }));
}

/**
 * ประกอบข้อความนำ + รายชื่อที่ถูก mention
 * ตำแหน่ง (index/length) นับเป็นหน่วยอักขระแบบ UTF-16 ซึ่งตรงกับค่า .length ของ JavaScript พอดี
 */
export function buildMentionText(lead: string, targets: MentionTarget[]): { text: string; mentionees: Mentionee[] } {
  if (targets.length === 0) return { text: lead, mentionees: [] };

  let text = lead ? `${lead}\n` : "";
  const mentionees: Mentionee[] = [];
  targets.forEach((t, i) => {
    if (i > 0) text += " ";
    const tag = `@${t.name}`;
    mentionees.push({ index: text.length, length: tag.length, type: "user", userId: t.userId });
    text += tag;
  });
  return { text, mentionees };
}

/** ข้อความตัวอักษรที่มี mention (ถ้าไม่มีใครให้เรียก ก็เป็นข้อความธรรมดา) */
export function mentionMessage(text: string, mentionees: Mentionee[]): LineMessage {
  return mentionees.length > 0 ? { type: "text", text, mention: { mentionees } } : { type: "text", text };
}

/**
 * ชุดข้อความสำหรับ push เข้ากลุ่มรวม: ข้อความเรียกเจ้าหน้าที่ + การ์ดรายละเอียด
 * ถ้าฝ่ายนั้นยังไม่มีใครผูกบัญชีไลน์ จะส่งแค่การ์ดใบเดียวเหมือนเดิม ไม่เปลืองข้อความเปล่า ๆ
 */
export async function groupMessages(departmentId: string, lead: string, card: LineMessage): Promise<LineMessage[]> {
  const targets = await departmentMentionTargets(departmentId);
  if (targets.length === 0) return [card];
  const { text, mentionees } = buildMentionText(lead, targets);
  return [mentionMessage(text, mentionees), card];
}
