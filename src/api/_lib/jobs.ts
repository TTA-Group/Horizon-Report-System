// ตรรกะของงานตามเวลาที่ใช้ร่วมกัน (เรียกได้ทั้งจาก scheduled function และ endpoint /api/cron/*)

import { CATEGORY_BY_CODE, CHANNEL_KEY, type UrgencyCode } from "./constants";
import { db } from "./db";
import { buildTicketFlex } from "./flex";
import { pushTo, textMessage } from "./line";
import { groupMessages } from "./mentions";
import { thaiDateTime } from "./tickets";

/**
 * เตือนซ้ำเรื่องที่ค้างเกิน SLA (spec หัวข้อ 5.4)
 * - ครั้งที่ 1: push ซ้ำเข้ากลุ่มฝ่าย
 * - ครั้งที่ 2 เป็นต้นไป: push ถึงหัวหน้าฝ่าย (escalate_to) เพิ่ม
 * - เตือนซ้ำได้ไม่เกิน 3 ครั้งต่อเรื่อง
 */
export async function runReminders(): Promise<{ checked: number; notified: number }> {
  const sql = db();

  const overdue = await sql<
    {
      id: string;
      ticket_no: string;
      reminder_count: number;
      category_code: string;
      floor: string;
      location_note: string | null;
      detail: string;
      urgency: string;
      created_at: string;
      reporter_name: string;
      reporter_dept: string | null;
      department_id: string;
      department_code: string;
      department_name: string;
      line_group_id: string | null;
      escalate_to: string | null;
    }[]
  >`
    SELECT t.id, t.ticket_no, t.reminder_count, t.category_code, t.floor, t.location_note,
           t.detail, t.urgency, t.created_at, r.full_name AS reporter_name, r.department_name AS reporter_dept,
           t.department_id, d.code AS department_code, d.name AS department_name,
           d.line_group_id, d.escalate_to
    FROM tickets t
    JOIN departments d ON d.id = t.department_id
    JOIN employees r ON r.id = t.reporter_id
    WHERE t.status = 'pending'
      AND t.reminder_count < 3
      AND now() - COALESCE(t.last_remind_at, t.created_at) >= make_interval(mins => d.sla_ack_minutes)
    LIMIT 100
  `;

  let notified = 0;
  for (const t of overdue) {
    const nextCount = t.reminder_count + 1;
    await sql`UPDATE tickets SET reminder_count = ${nextCount}, last_remind_at = now(), updated_at = now() WHERE id = ${t.id}`;
    await sql`
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      VALUES (${t.id}, 'pending', 'pending', NULL, ${"เตือนซ้ำครั้งที่ " + nextCount})
    `;

    const flex = buildTicketFlex({
      ticketId: t.id,
      ticketNo: t.ticket_no,
      status: "pending", // งานเตือนซ้ำเลือกเฉพาะเรื่องที่ยังไม่มีผู้รับเท่านั้น
      departmentCode: t.department_code,
      departmentName: t.department_name,
      categoryLabel: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
      reporterName: t.reporter_name,
      reporterDept: t.reporter_dept,
      floor: t.floor,
      locationNote: t.location_note,
      detail: t.detail,
      urgency: t.urgency as UrgencyCode,
      createdAtLabel: thaiDateTime(new Date(t.created_at)),
    });

    if (t.line_group_id) {
      const messages = await groupMessages(
        t.department_id,
        `⏰ เตือนซ้ำ (ครั้งที่ ${nextCount}) ${t.ticket_no} ยังไม่มีผู้รับเรื่อง`,
        flex,
      );
      await pushTo(t.line_group_id, messages, { ticketId: t.id, channel: "group" });
    }

    // ครั้งที่ 2 เป็นต้นไป แจ้งหัวหน้าฝ่ายเพิ่ม
    if (nextCount >= 2 && t.escalate_to) {
      const head = await sql<{ line_user_id: string }[]>`
        SELECT line_user_id FROM line_accounts
        WHERE employee_id = ${t.escalate_to} AND channel_key = ${CHANNEL_KEY} LIMIT 1
      `;
      if (head.length > 0) {
        await pushTo(head[0].line_user_id, [textMessage(`เรื่อง ${t.ticket_no} ยังไม่มีผู้รับเกินกำหนด กรุณาติดตาม`), flex], {
          ticketId: t.id,
          channel: "user",
        });
      }
    }
    notified++;
  }

  return { checked: overdue.length, notified };
}
