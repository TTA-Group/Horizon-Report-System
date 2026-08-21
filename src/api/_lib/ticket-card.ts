// ข้อมูลชุดเดียวที่ทุกเส้นทางใช้สร้างการ์ดและส่งแจ้งเตือน
//
// ก่อนหน้านี้ทุกไฟล์ที่ต้อง "อัปเดตการ์ดในกลุ่มแล้วแจ้งผู้แจ้ง" เขียน SELECT ชุดเดียวกันซ้ำเอง
// พอเพิ่มช่องใหม่บนการ์ด (เช่น กำหนดเสร็จ) จึงต้องไล่แก้ทุกไฟล์ และมักลืมสักไฟล์จนการ์ดจากคนละทาง
// แสดงข้อมูลไม่เท่ากัน ไฟล์นี้เป็นที่เดียวที่รู้ว่าการ์ดต้องใช้อะไรบ้าง

import { CATEGORY_BY_CODE, CHANNEL_KEY, type StatusCode, type UrgencyCode } from "./constants";
import { db } from "./db";
import { buildCompactFlex, buildTicketFlex, ratingAskCard, type TicketFlexInput } from "./flex";
import { pushTo, textMessage, type LineMessage } from "./line";
import { thaiDateShort, thaiDateTimeShort } from "./tickets";

export interface CardRow {
  id: string;
  ticket_no: string;
  status: StatusCode;
  department_id: string;
  department_name: string;
  line_group_id: string | null;
  category_code: string;
  floor: string;
  location_note: string | null;
  detail: string;
  urgency: string;
  created_at: string;
  reporter_id: string;
  reporter_name: string;
  reporter_dept: string | null;
  reporter_line: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  photos: string[] | null;
  due_at: string | null;
  due_label: string | null;
  due_changes: number;
  assessment: string | null;
  assessed_at: string | null;
  waiting_parts: boolean;
}

export async function loadCardRow(id: string): Promise<CardRow | null> {
  const sql = db();
  const rows = await sql<CardRow[]>`
    SELECT t.id, t.ticket_no, t.status, t.department_id, t.category_code, t.floor, t.location_note,
           t.detail, t.urgency, t.created_at, t.reporter_id, t.assignee_id,
           t.due_at, t.due_label, t.due_changes, t.assessment, t.assessed_at, t.waiting_parts,
           d.name AS department_name, d.line_group_id,
           r.full_name AS reporter_name, r.department_name AS reporter_dept,
           rl.line_user_id AS reporter_line,
           a.full_name AS assignee_name,
           (SELECT array_agg(ta.file_url ORDER BY ta.created_at)
              FROM ticket_attachments ta
             WHERE ta.ticket_id = t.id AND ta.file_url IS NOT NULL) AS photos
    FROM tickets t
    JOIN departments d ON d.id = t.department_id
    JOIN employees r ON r.id = t.reporter_id
    LEFT JOIN line_accounts rl ON rl.employee_id = t.reporter_id AND rl.channel_key = ${CHANNEL_KEY}
    LEFT JOIN employees a ON a.id = t.assignee_id
    WHERE t.id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** แปลงแถวข้อมูลเป็นค่าที่การ์ดต้องใช้ — overrides ไว้วาดสถานะใหม่ที่เพิ่งเปลี่ยนไปในคำขอนี้ */
export function cardInput(t: CardRow, overrides: Partial<TicketFlexInput> = {}): TicketFlexInput {
  return {
    ticketId: t.id,
    ticketNo: t.ticket_no,
    status: t.status,
    departmentName: t.department_name,
    categoryLabel: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
    reporterName: t.reporter_name,
    reporterDept: t.reporter_dept,
    floor: t.floor,
    locationNote: t.location_note,
    detail: t.detail,
    urgency: t.urgency as UrgencyCode,
    createdAtLabel: thaiDateTimeShort(new Date(t.created_at)),
    assigneeName: t.assignee_name,
    photos: t.photos,
    assessed: t.assessed_at !== null,
    dueLabel: t.due_label,
    dueDateLabel: t.due_at ? thaiDateShort(new Date(t.due_at)) : null,
    waitingParts: t.waiting_parts,
    assessment: t.assessment,
    ...overrides,
  };
}

/**
 * การ์ดที่ควรส่งเข้ากลุ่มของเรื่องนี้
 *
 * เรื่องที่ยังไม่มีผู้รับใช้ใบเต็มเสมอ เพราะเป็นใบที่คนทั้งกลุ่มต้องอ่านให้ครบก่อนแย่งกันกดรับ
 * เรื่องที่มีเจ้าของแล้วใช้ใบย่อ เพราะทุกคนอ่านใบแรกไปแล้ว เหลือแค่บอกว่าคืบไปถึงไหน
 */
export function groupCard(t: CardRow, overrides: Partial<TicketFlexInput> = {}): LineMessage {
  const input = cardInput(t, overrides);
  return input.status === "pending" ? buildTicketFlex(input) : buildCompactFlex(input);
}

/** ค่าที่ต้องส่งให้การ์ดเมื่อคนคนนี้เพิ่งทำรายการนี้เดี๋ยวนี้ */
export function justNow(actorName: string): Partial<TicketFlexInput> {
  return { latestActor: actorName, latestAtLabel: thaiDateTimeShort() };
}

export async function pushGroupCard(t: CardRow, card: LineMessage): Promise<void> {
  if (!t.line_group_id) return;
  await pushTo(t.line_group_id, [card], { ticketId: t.id, channel: "group" });
}

/**
 * ปิดงานแล้วถามความพึงพอใจ แทนข้อความ "สถานะ: ดำเนินการเสร็จสิ้น" แบบเดิม
 *
 * ข้อความเดิมบอกสิ่งที่ผู้แจ้งรู้อยู่แล้ว (ของที่เสียกลับมาใช้ได้แล้ว) และไม่ได้เปิดโอกาสให้ทำอะไรต่อ
 * ใบนี้ใช้จำนวนข้อความเท่ากันคือใบเดียว แต่ได้คำขอบคุณที่เดินทางไปถึงคนที่ลงมือทำจริง
 */
export async function askReporterRating(t: CardRow): Promise<void> {
  if (!t.reporter_line) return;
  const ok = await pushTo(t.reporter_line, [ratingAskCard(t.id, t.ticket_no, t.detail, t.assignee_name)], {
    ticketId: t.id,
    channel: "user",
  });
  // การ์ดส่งไม่ผ่านด้วยเหตุใดก็ตาม ผู้แจ้งต้องไม่เงียบหาย — งานของเขาเสร็จแล้วและเขาควรได้รู้
  // ต่อให้ส่วนที่เป็นลูกเล่นจะพัง ข้อความบอกสถานะเป็นสิ่งที่ห้ามหาย
  if (!ok) await tellReporter(t, `อัปเดตเรื่อง ${t.ticket_no}\nสถานะ: ดำเนินการเสร็จสิ้น`);
}

export async function tellReporter(t: CardRow, text: string): Promise<void> {
  if (!t.reporter_line) return;
  await pushTo(t.reporter_line, [textMessage(text)], { ticketId: t.id, channel: "user" });
}
