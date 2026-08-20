// ตรรกะของงานตามเวลาที่ใช้ร่วมกัน (เรียกได้ทั้งจาก scheduled function และ endpoint /api/cron/*)

import { CATEGORY_BY_CODE, CHANNEL_KEY, type UrgencyCode } from "./constants";
import { db } from "./db";
import { buildCompactFlex, buildTicketFlex, overdueCard, partsFollowUpCard } from "./flex";
import { multicastTo, pushTo, textMessage } from "./line";
import { departmentStaffLineIds } from "./staff";
import { thaiDateShort, thaiDateTimeShort } from "./tickets";

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

/**
 * ทวงงานที่รับเรื่องไปแล้วแต่ยังไม่จบ (spec เพิ่มเติม)
 *
 * เดิมการเตือนซ้ำมองเฉพาะเรื่องที่ยังไม่มีผู้รับ พอมีคนกดรับปุ๊บ เรื่องนั้นหลุดออกจากการเตือน
 * ถาวร ค้างได้ไม่จำกัดโดยไม่มีอะไรทวงเลย ตรงนี้คือส่วนที่อุดรูนั้น
 *
 * ทวง 3 กรณี แต่ละกรณีมีจังหวะของตัวเอง
 *   - รับเรื่องแล้วยังไม่แจ้งผลตรวจสอบ : ทุก 2 ชั่วโมง
 *   - เลยกำหนดที่แจ้งไว้                : ทุกวัน
 *   - รออะไหล่                          : ทุก 7 วัน ไม่จำกัดจำนวนครั้ง จนกว่าจะดำเนินการต่อ
 *
 * ส่งถึงผู้รับผิดชอบโดยตรง ไม่ลงกลุ่ม เพราะเป็นการทวงรายบุคคล ไม่ใช่เรื่องที่ทุกคนต้องอ่าน
 * ยกเว้นขั้นที่ต้องให้หัวหน้าฝ่ายรู้ จะส่งถึงหัวหน้าเพิ่มอีกทาง
 */
export async function runProgressReminders(): Promise<{ checked: number; notified: number }> {
  const sql = db();

  const rows = await sql<
    {
      id: string;
      ticket_no: string;
      category_code: string;
      floor: string;
      location_note: string | null;
      detail: string;
      urgency: string;
      created_at: string;
      due_at: string | null;
      due_label: string | null;
      assessment: string | null;
      assessed_at: string | null;
      waiting_parts: boolean;
      due_changes: number;
      progress_remind_count: number;
      reporter_name: string;
      reporter_dept: string | null;
      department_name: string;
      escalate_to: string | null;
      assignee_name: string | null;
      assignee_line: string | null;
      overdue_days: number;
      photos: string[] | null;
    }[]
  >`
    SELECT t.id, t.ticket_no, t.category_code, t.floor, t.location_note, t.detail, t.urgency,
           t.created_at, t.due_at, t.due_label, t.assessment, t.assessed_at, t.waiting_parts,
           t.due_changes, t.progress_remind_count,
           r.full_name AS reporter_name, r.department_name AS reporter_dept,
           d.name AS department_name, d.escalate_to,
           a.full_name AS assignee_name, la.line_user_id AS assignee_line,
           GREATEST(0, EXTRACT(EPOCH FROM (now() - COALESCE(t.due_at, now()))) / 86400)::int AS overdue_days,
           (SELECT array_agg(ta.file_url ORDER BY ta.created_at)
              FROM ticket_attachments ta
             WHERE ta.ticket_id = t.id AND ta.file_url IS NOT NULL) AS photos
    FROM tickets t
    JOIN departments d ON d.id = t.department_id
    JOIN employees r ON r.id = t.reporter_id
    LEFT JOIN employees a ON a.id = t.assignee_id
    LEFT JOIN line_accounts la ON la.employee_id = t.assignee_id AND la.channel_key = ${CHANNEL_KEY}
    WHERE t.status = 'in_progress'
      AND (
        t.assessed_at IS NULL
        OR t.waiting_parts
        OR (t.due_at IS NOT NULL AND now() > t.due_at)
      )
      AND now() - COALESCE(t.last_progress_remind_at, t.assessed_at, t.acknowledged_at, t.created_at) >= (
        CASE
          WHEN t.waiting_parts THEN interval '7 days'
          WHEN t.assessed_at IS NULL THEN interval '2 hours'
          ELSE interval '1 day'
        END
      )
      -- งานรออะไหล่ทวงไปเรื่อย ๆ ตามที่ตกลงกันไว้ ส่วนกรณีอื่นจำกัดไว้กันข้อความท่วมและเปลืองโควตา
      AND (t.waiting_parts OR t.progress_remind_count < 12)
    LIMIT 100
  `;

  let notified = 0;
  for (const t of rows) {
    const kind = t.waiting_parts ? "parts" : t.assessed_at ? "overdue" : "noassess";

    await sql`
      UPDATE tickets SET progress_remind_count = progress_remind_count + 1,
        last_progress_remind_at = now(), updated_at = now()
      WHERE id = ${t.id}
    `;

    // ใบย่อ — คนที่ได้รับข้อความทวงคือผู้รับผิดชอบเองกับหัวหน้าฝ่าย ทั้งคู่รู้จักเรื่องนี้อยู่แล้ว
    // ไม่ต้องส่งรูปกับชื่อผู้แจ้งซ้ำ และปุ่มบนใบย่อพาไปกรอกในแอปได้เลย
    const card = buildCompactFlex({
      ticketId: t.id,
      ticketNo: t.ticket_no,
      status: "in_progress",
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
    });

    const due = t.due_at ? thaiDateShort(new Date(t.due_at)) : "-";
    const ask =
      kind === "parts"
        ? { text: `⏰ ${t.ticket_no} รออะไหล่ครบ 7 วันแล้ว (กำหนดไว้ ${due})`, msg: partsFollowUpCard(t.id, t.ticket_no) }
        : kind === "overdue"
          ? { text: `⏰ ${t.ticket_no} เลยกำหนดที่แจ้งไว้ (${due}) แล้ว`, msg: overdueCard(t.id, t.ticket_no) }
          : { text: `⏰ ${t.ticket_no} รับเรื่องไปแล้วแต่ยังไม่ได้แจ้งผลตรวจสอบ\nกรุณาแจ้งว่าพบอะไรและจะใช้เวลาเท่าไหร่`, msg: card };

    if (t.assignee_line) {
      await pushTo(t.assignee_line, [textMessage(ask.text), ask.msg], { ticketId: t.id, channel: "user" });
      notified++;
    }

    // ขั้นที่หัวหน้าฝ่ายควรรู้: ค้างเกินกำหนดมา 2 วัน หรือเลื่อนกำหนดจนผิดปกติ
    const escalate = (kind === "overdue" && t.overdue_days >= 2) || t.due_changes >= 3;
    if (escalate && t.escalate_to) {
      const head = await sql<{ line_user_id: string }[]>`
        SELECT line_user_id FROM line_accounts
        WHERE employee_id = ${t.escalate_to} AND channel_key = ${CHANNEL_KEY} LIMIT 1
      `;
      if (head.length > 0) {
        const why =
          t.due_changes >= 3
            ? `เลื่อนกำหนดมาแล้ว ${t.due_changes} ครั้ง`
            : `เลยกำหนดมา ${t.overdue_days} วัน`;
        await pushTo(
          head[0].line_user_id,
          [textMessage(`${t.ticket_no} ${why} ผู้รับผิดชอบ ${t.assignee_name ?? "-"} กรุณาติดตาม`), card],
          { ticketId: t.id, channel: "user" },
        );
      }
    }
  }

  return { checked: rows.length, notified };
}
