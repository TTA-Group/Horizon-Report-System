// PATCH /api/tickets/:id/status — เปลี่ยนสถานะ (spec หัวข้อ 5.3 / 6)
// รองรับการกดรับพร้อมกัน: ใช้ conditional update กันรับซ้ำ

import type { Config } from "@netlify/functions";
import { getSession, isMemberOf, requireActive } from "./_lib/auth";
import { CHANNEL_KEY, STATUS_LABELS, STATUS_TRANSITIONS, type StatusCode } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { pushTo, textMessage } from "./_lib/line";
import { assertTransition } from "./_lib/tickets";

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
      { status: StatusCode; department_id: string; reporter_id: string; ticket_no: string }[]
    >`SELECT status, department_id, reporter_id, ticket_no FROM tickets WHERE id = ${id} LIMIT 1`;
    if (rows.length === 0) throw new HttpError(404, "ไม่พบเรื่องนี้");
    const t = rows[0];

    if (!isMemberOf(s, t.department_id)) throw new HttpError(403, "ไม่มีสิทธิ์ดำเนินการเรื่องของฝ่ายนี้");

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

    // แจ้งผู้แจ้งทุกครั้งที่สถานะเปลี่ยน (spec หัวข้อ 5.3)
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

    return json({ ok: true, id, status: to, status_label: STATUS_LABELS[to] ?? to });
  });

export const config: Config = { path: "/api/tickets/:id/status" };
