// ตรรกะของงานตามเวลาที่ใช้ร่วมกัน (เรียกได้ทั้งจาก scheduled function และ endpoint /api/cron/*)

import { CATEGORY_BY_CODE, CHANNEL_KEY, type UrgencyCode } from "./constants";
import { db } from "./db";
import { buildTicketFlex } from "./flex";
import { multicastTo, pushTo, textMessage } from "./line";
import { departmentStaffLineIds } from "./staff";
import { thaiDateTimeShort } from "./tickets";

/**
 * เตือนซ้ำเรื่องที่ค้างเกิน SLA (spec หัวข้อ 5.4)
 * - ครั้งที่ 1: เตือนในกลุ่ม + ส่งข้อความส่วนตัวหาเจ้าหน้าที่ของฝ่ายทุกคน
 * - ครั้งที่ 2 เป็นต้นไป: เตือนในกลุ่ม + ส่งถึงหัวหน้าฝ่าย (escalate_to)
 * - เตือนซ้ำได้ไม่เกิน 3 ครั้งต่อเรื่อง
 *
 * กำหนดเวลาอยู่ที่ departments.sla_ack_minutes (ตั้งไว้ 15 นาที) และงานนี้ทำงานทุก 15 นาที
 * เรื่องที่ยังไม่มีผู้รับจึงถูกเตือนภายในประมาณ 15–30 นาทีหลังแจ้ง
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
      sla_ack_minutes: number;
      photos: string[] | null;
    }[]
  >`
    SELECT t.id, t.ticket_no, t.reminder_count, t.category_code, t.floor, t.location_note,
           t.detail, t.urgency, t.created_at, r.full_name AS reporter_name, r.department_name AS reporter_dept,
           t.department_id, d.code AS department_code, d.name AS department_name,
           d.line_group_id, d.escalate_to, d.sla_ack_minutes,
           (SELECT array_agg(ta.file_url ORDER BY ta.created_at)
              FROM ticket_attachments ta
             WHERE ta.ticket_id = t.id AND ta.file_url IS NOT NULL) AS photos
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
      departmentName: t.department_name,
      categoryLabel: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
      reporterName: t.reporter_name,
      reporterDept: t.reporter_dept,
      floor: t.floor,
      locationNote: t.location_note,
      detail: t.detail,
      urgency: t.urgency as UrgencyCode,
      createdAtLabel: thaiDateTimeShort(new Date(t.created_at)),
      photos: t.photos,
    });

    if (t.line_group_id) {
      await pushTo(t.line_group_id, [flex], { ticketId: t.id, channel: "group" });
    }

    // ครั้งแรกที่เกินกำหนด: ส่งข้อความส่วนตัวหาเจ้าหน้าที่ของฝ่ายทุกคน
    //
    // การ์ดในกลุ่มปลุกคนที่ปิดเสียงกลุ่มไว้ไม่ได้ และบัญชีทางการของ LINE ส่ง @mention ไม่ได้
    // (ทดลองแล้วทั้งเรียกรายคนและเรียกทั้งกลุ่ม) ข้อความส่วนตัวจึงเป็นทางเดียวที่เตือนถึงตัวคนจริง
    //
    // ส่งเฉพาะรอบแรกรอบเดียว เพราะแต่ละข้อความนับโควตาของ OA ที่ใช้ร่วมกับระบบอื่น — เตือนให้รู้ตัว
    // ครั้งเดียวก็พอ รอบถัดไปเตือนในกลุ่มและส่งถึงหัวหน้าฝ่ายแทน
    if (nextCount === 1) {
      const staff = await departmentStaffLineIds(t.department_id);
      if (staff.length > 0) {
        await multicastTo(
          staff,
          [textMessage(`⏰ ${t.ticket_no} ยังไม่มีผู้รับเรื่อง เกิน ${t.sla_ack_minutes} นาทีแล้ว`), flex],
          { ticketId: t.id },
        );
      }
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
