// GET /api/tickets/mine — เรื่องของผู้ใช้ปัจจุบัน พร้อมไทม์ไลน์ (spec หัวข้อ 6)

import type { Config } from "@netlify/functions";
import { getSession, requireActive } from "./_lib/auth";
import { CATEGORY_BY_CODE, STATUS_LABELS, type StatusCode } from "./_lib/constants";
import { db } from "./_lib/db";
import { json, methodGuard, run } from "./_lib/http";

interface TicketRow {
  id: string;
  ticket_no: string;
  category_code: string;
  dept_code: string;
  dept_name: string;
  floor: string;
  location_note: string | null;
  detail: string;
  urgency: string;
  status: StatusCode;
  created_at: string;
}

interface EventRow {
  ticket_id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  created_at: string;
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireActive(s);

    const sql = db();
    const tickets = await sql<TicketRow[]>`
      SELECT t.id, t.ticket_no, t.category_code, d.code AS dept_code, d.name AS dept_name,
             t.floor, t.location_note, t.detail, t.urgency, t.status, t.created_at
      FROM tickets t
      JOIN departments d ON d.id = t.department_id
      WHERE t.reporter_id = ${s.employee.id}
      ORDER BY t.created_at DESC
      LIMIT 50
    `;

    const ids = tickets.map((t) => t.id);
    const events = ids.length
      ? await sql<EventRow[]>`
          SELECT ticket_id, from_status, to_status, note, created_at
          FROM ticket_events
          WHERE ticket_id = ANY(${ids}::uuid[])
          ORDER BY created_at ASC
        `
      : [];

    const byTicket = new Map<string, EventRow[]>();
    for (const e of events) {
      const list = byTicket.get(e.ticket_id) ?? [];
      list.push(e);
      byTicket.set(e.ticket_id, list);
    }

    return json({
      tickets: tickets.map((t) => ({
        id: t.id,
        ticket_no: t.ticket_no,
        category_code: t.category_code,
        category_label: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
        dept_code: t.dept_code,
        dept_name: t.dept_name,
        floor: t.floor,
        location_note: t.location_note,
        detail: t.detail,
        urgency: t.urgency,
        status: t.status,
        status_label: STATUS_LABELS[t.status] ?? t.status,
        created_at: t.created_at,
        timeline: (byTicket.get(t.id) ?? []).map((e) => ({
          from_status: e.from_status,
          to_status: e.to_status,
          status_label: STATUS_LABELS[e.to_status as StatusCode] ?? e.to_status,
          note: e.note,
          created_at: e.created_at,
        })),
      })),
    });
  });

export const config: Config = { path: "/api/tickets/mine" };
