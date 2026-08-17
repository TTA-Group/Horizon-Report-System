// PATCH /api/tickets/:id/status — เปลี่ยนสถานะ (spec หัวข้อ 5.3 / 6)
// รองรับการกดรับพร้อมกัน: ใช้ conditional update กันรับซ้ำ

import { getSession, isMemberOf, requireActive } from "./_lib/auth";
import {
  CATEGORY_BY_CODE,
  CHANNEL_KEY,
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  type StatusCode,
  type UrgencyCode,
} from "./_lib/constants";
import { db } from "./_lib/db";
import { buildTicketFlex } from "./_lib/flex";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { pushTo, textMessage } from "./_lib/line";
import { assertTransition, thaiDateTime } from "./_lib/tickets";

interface Body {
  to_status?: string;
  note?: string;
}

function ticketIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','tickets','<id>','status']
  return seg[2] ?? "";
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "PATCH", "POST");
    const id = ticketIdFromPath(req);
    if (!id) throw new HttpError(404, "ไม่พบเรื่องนี้");

    const s = await getSession(req);
    requireActive(s);

    const body = await readJson<Body>(req);
    const to = (body.to_status ?? "").trim() as StatusCode;
    if (!(to in STATUS_TRANSITIONS)) throw new HttpError(400, "สถานะปลายทางไม่ถูกต้อง");
    const note = (body.note ?? "").trim() || null;

    const sql = db();
    const rows = await sql<
      {
        status: StatusCode;
        department_id: string;
        department_code: string;
        department_name: string;
        line_group_id: string | null;
        reporter_id: string;
        ticket_no: string;
        category_code: string;
        floor: string;
        location_note: string | null;
        detail: string;
        urgency: string;
        created_at: string;
        reporter_name: string;
        reporter_dept: string | null;
        assignee_name: string | null;
      }[]
    >`
      SELECT t.status, t.department_id, t.reporter_id, t.ticket_no, t.category_code,
             t.floor, t.location_note, t.detail, t.urgency, t.created_at,
             r.full_name AS reporter_name, r.department_name AS reporter_dept,
             d.code AS department_code, d.name AS department_name, d.line_group_id,
             a.full_name AS assignee_name
      FROM tickets t
      JOIN employees r ON r.id = t.reporter_id
      JOIN departments d ON d.id = t.department_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.id = ${id} LIMIT 1
    `;
    if (rows.length === 0) throw new HttpError(404, "ไม่พบเรื่องนี้");
    const t = rows[0];

    // เจ้าหน้าที่ของฝ่ายทำได้ทุกอย่าง ส่วนผู้แจ้งเองยกเลิกเรื่องของตัวเองได้ เฉพาะตอนที่ยังไม่มีคนรับ
    // (แจ้งผิด/แจ้งซ้ำแล้วอยากถอน — ถ้ามีคนรับไปแล้วต้องให้เจ้าหน้าที่จัดการ)
    const isOwnerCancelling = t.reporter_id === s.employee.id && to === "cancelled" && t.status === "pending";
    if (!isMemberOf(s, t.department_id) && !isOwnerCancelling) {
      throw new HttpError(403, "ไม่มีสิทธิ์ดำเนินการเรื่องนี้");
    }

    const from = t.status;
    assertTransition(from, to);
    const me = s.employee.id;

    // อัปเดตแบบมีเงื่อนไข status=from เพื่อกันการชนกัน (โดยเฉพาะการกดรับพร้อมกัน)
    let updated: { id: string }[];
    if (to === "completed") {
      updated = await sql`UPDATE tickets SET status='completed', completed_at=now(), updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    } else if (to === "closed") {
      updated = await sql`UPDATE tickets SET status='closed', closed_at=now(), updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    } else if (to === "in_progress") {
      updated = await sql`UPDATE tickets SET status='in_progress', assignee_id=${me}, acknowledged_at=COALESCE(acknowledged_at, now()), updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    } else if (to === "pending") {
      updated = await sql`UPDATE tickets SET status='pending', assignee_id=NULL, updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    } else {
      // cancelled
      updated = await sql`UPDATE tickets SET status='cancelled', updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    }

    if (updated.length === 0) {
      const msg = from === "pending" && to === "in_progress" ? "มีผู้รับเรื่องนี้ไปแล้ว" : "สถานะถูกเปลี่ยนไปแล้ว กรุณารีเฟรช";
      throw new HttpError(409, msg);
    }

    await sql`
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      VALUES (${id}, ${from}, ${to}, ${me}, ${note})
    `;

    // การแจ้งเตือนทั้งหมดอยู่หลังบันทึกสำเร็จแล้ว ถ้าส่งข้อความไม่ผ่านก็ไม่ควรทำให้ผู้ใช้
    // เห็นว่าเปลี่ยนสถานะไม่สำเร็จทั้งที่บันทึกลงระบบไปแล้ว
    try {
      // แจ้งผู้แจ้งเมื่อสถานะเปลี่ยน (spec หัวข้อ 5.3)
      // ข้ามกรณีผู้แจ้งเป็นคนกดเอง — เขาเห็นผลบนหน้าจออยู่แล้ว การส่งซ้ำเปลืองโควตาข้อความเปล่า ๆ
      if (!isOwnerCancelling) {
        const reporter = await sql<{ line_user_id: string }[]>`
          SELECT line_user_id FROM line_accounts
          WHERE employee_id = ${t.reporter_id} AND channel_key = ${CHANNEL_KEY} LIMIT 1
        `;
        if (reporter.length > 0) {
          const label = STATUS_LABELS[to] ?? to;
          await pushTo(
            reporter[0].line_user_id,
            [textMessage(`อัปเดตเรื่อง ${t.ticket_no}\nสถานะ: ${label}${note ? "\nหมายเหตุ: " + note : ""}`)],
            { ticketId: id, channel: "user" },
          );
        }
      }

      // อัปเดตการ์ดในกลุ่มด้วย แม้การเปลี่ยนสถานะจะเกิดจากหน้าแอปไม่ใช่ปุ่มในกลุ่ม
      // ไม่อย่างนั้นกลุ่มจะค้างอยู่ที่การ์ดใบเก่า และไม่มีใครรู้ว่าใครเป็นคนรับผิดชอบต่อ
      if (t.line_group_id) {
        const card = buildTicketFlex({
          ticketId: id,
          ticketNo: t.ticket_no,
          status: to,
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
          assigneeName: to === "in_progress" ? s.employee.full_name : to === "pending" ? null : t.assignee_name,
          actorName: s.employee.full_name,
          cancelReason: to === "cancelled" ? note : null,
        });
        await pushTo(t.line_group_id, [card], { ticketId: id, channel: "group" });
      }
    } catch (e) {
      console.error("[tickets-status] notify failed", e);
    }

    return json({ ok: true, id, status: to, status_label: STATUS_LABELS[to] ?? to });
  });
