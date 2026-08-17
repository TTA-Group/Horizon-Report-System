// PATCH /api/tickets/:id/transfer — ส่งต่อฝ่ายอื่น (spec หัวข้อ 5.3 / 6)
// เปลี่ยน department_id คงสถานะ pending แล้ว push เข้ากลุ่มฝ่ายใหม่

import { getSession, isMemberOf, requireActive } from "./_lib/auth";
import { CATEGORY_BY_CODE, CHANNEL_KEY, type UrgencyCode } from "./_lib/constants";
import { db } from "./_lib/db";
import { buildTicketFlex } from "./_lib/flex";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { pushTo, textMessage } from "./_lib/line";
import { groupMessages } from "./_lib/mentions";
import { thaiDateTime } from "./_lib/tickets";

interface Body {
  to_dept?: string;
}

function ticketIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','tickets','<id>','transfer']
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
    const toDept = (body.to_dept ?? "").trim().toUpperCase();
    if (!toDept) throw new HttpError(400, "กรุณาระบุฝ่ายปลายทาง");

    const sql = db();
    const rows = await sql<
      {
        status: string;
        department_id: string;
        category_code: string;
        floor: string;
        location_note: string | null;
        detail: string;
        urgency: string;
        ticket_no: string;
        reporter_id: string;
        reporter_name: string;
        reporter_dept: string | null;
      }[]
    >`
      SELECT t.status, t.department_id, t.category_code, t.floor, t.location_note, t.detail,
             t.urgency, t.ticket_no, t.reporter_id,
             r.full_name AS reporter_name, r.department_name AS reporter_dept
      FROM tickets t JOIN employees r ON r.id = t.reporter_id
      WHERE t.id = ${id} LIMIT 1
    `;
    if (rows.length === 0) throw new HttpError(404, "ไม่พบเรื่องนี้");
    const t = rows[0];

    if (!isMemberOf(s, t.department_id)) throw new HttpError(403, "ไม่มีสิทธิ์ส่งต่อเรื่องของฝ่ายนี้");

    const dept = await sql<{ id: string; name: string; line_group_id: string | null }[]>`
      SELECT id, name, line_group_id FROM departments WHERE code = ${toDept} AND is_active = true LIMIT 1
    `;
    if (dept.length === 0) throw new HttpError(404, "ไม่พบฝ่ายปลายทาง");
    if (dept[0].id === t.department_id) throw new HttpError(400, "เรื่องนี้อยู่ในฝ่ายดังกล่าวอยู่แล้ว");

    await sql`
      UPDATE tickets
      SET department_id = ${dept[0].id}, status = 'pending', assignee_id = NULL,
          acknowledged_at = NULL, updated_at = now()
      WHERE id = ${id}
    `;
    await sql`
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      VALUES (${id}, ${t.status}, 'pending', ${s.employee.id}, ${"ส่งต่อไปฝ่าย " + dept[0].name})
    `;

    // แจ้งกลุ่มฝ่ายใหม่
    if (dept[0].line_group_id) {
      const flex = buildTicketFlex({
        ticketId: id,
        ticketNo: t.ticket_no,
        categoryCode: t.category_code,
        categoryLabel: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
        reporterName: t.reporter_name,
        reporterDept: t.reporter_dept,
        floor: t.floor,
        locationNote: t.location_note,
        detail: t.detail,
        urgency: t.urgency as UrgencyCode,
        createdAtLabel: thaiDateTime(),
      });
      const messages = await groupMessages(
        dept[0].id,
        `↪️ ส่งต่อ ${t.ticket_no} มาที่ ${dept[0].name}`,
        flex,
      );
      await pushTo(dept[0].line_group_id, messages, { ticketId: id, channel: "group" });
    }

    // แจ้งผู้แจ้ง
    const reporter = await sql<{ line_user_id: string }[]>`
      SELECT line_user_id FROM line_accounts
      WHERE employee_id = ${t.reporter_id} AND channel_key = ${CHANNEL_KEY} LIMIT 1
    `;
    if (reporter.length > 0) {
      await pushTo(
        reporter[0].line_user_id,
        [textMessage(`เรื่อง ${t.ticket_no} ถูกส่งต่อไปยัง ${dept[0].name} แล้ว`)],
        { ticketId: id, channel: "user" },
      );
    }

    return json({ ok: true, id, department_id: dept[0].id, status: "pending" });
  });
