// GET /api/tickets/:id — รายละเอียดพร้อมไทม์ไลน์และไฟล์แนบ (spec หัวข้อ 6)
//
// เป็นจุดเดียวที่รับ "/api/tickets/<segment>" ทั้งหมด แล้วแยกเองว่าเป็นคำขอแบบไหน
// ("mine" / "department" / รหัสเรื่องจริง) — เพราะทั้งสามรูปแบบมีหน้าตาเส้นทางเหมือนกัน
// ถ้าแยกเป็นคนละไฟล์จะเสี่ยงถูกจับคู่ผิดตัว

import { getSession, isMemberOf, requireActive } from "./_lib/auth";
import { CATEGORY_BY_CODE, STATUS_LABELS, type StatusCode } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, run } from "./_lib/http";
import { handleTicketsDepartment, handleTicketsMine } from "./_lib/ticket-lists";

function ticketIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','tickets','<id>']
  return seg[2] ?? "";
}

export default async (req: Request): Promise<Response> => {
  const id = ticketIdFromPath(req);
  if (id === "mine") return handleTicketsMine(req);
  if (id === "department") return handleTicketsDepartment(req);

  return run(async () => {
    methodGuard(req, "GET");
    if (!id) throw new HttpError(404, "ไม่พบเรื่องนี้");

    const s = await getSession(req);
    requireActive(s);

    const sql = db();
    const rows = await sql<
      {
        id: string;
        ticket_no: string;
        category_code: string;
        department_id: string;
        dept_code: string;
        dept_name: string;
        floor: string;
        location_note: string | null;
        detail: string;
        urgency: string;
        status: StatusCode;
        reporter_id: string;
        reporter_name: string;
        assignee_name: string | null;
        created_at: string;
        acknowledged_at: string | null;
        completed_at: string | null;
        closed_at: string | null;
      }[]
    >`
      SELECT t.id, t.ticket_no, t.category_code, t.department_id,
             d.code AS dept_code, d.name AS dept_name,
             t.floor, t.location_note, t.detail, t.urgency, t.status,
             t.reporter_id, r.full_name AS reporter_name, a.full_name AS assignee_name,
             t.created_at, t.acknowledged_at, t.completed_at, t.closed_at
      FROM tickets t
      JOIN departments d ON d.id = t.department_id
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.id = ${id} LIMIT 1
    `;
    if (rows.length === 0) throw new HttpError(404, "ไม่พบเรื่องนี้");
    const t = rows[0];

    // ตรวจสิทธิ์: เจ้าของเรื่อง / สมาชิกฝ่าย / ผู้ดูแล (spec หัวข้อ 10)
    const canView = t.reporter_id === s.employee.id || isMemberOf(s, t.department_id);
    if (!canView) throw new HttpError(403, "ไม่มีสิทธิ์ดูเรื่องนี้");

    const events = await sql<
      { from_status: string | null; to_status: string; note: string | null; created_at: string }[]
    >`
      SELECT from_status, to_status, note, created_at
      FROM ticket_events WHERE ticket_id = ${id} ORDER BY created_at ASC
    `;
    const attachments = await sql<{ file_url: string | null; phase: string; created_at: string }[]>`
      SELECT file_url, phase, created_at
      FROM ticket_attachments WHERE ticket_id = ${id} AND file_url IS NOT NULL ORDER BY created_at ASC
    `;

    return json({
      id: t.id,
      ticket_no: t.ticket_no,
      category_label: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
      dept_code: t.dept_code,
      dept_name: t.dept_name,
      floor: t.floor,
      location_note: t.location_note,
      detail: t.detail,
      urgency: t.urgency,
      status: t.status,
      status_label: STATUS_LABELS[t.status] ?? t.status,
      reporter_name: t.reporter_name,
      assignee_name: t.assignee_name,
      created_at: t.created_at,
      acknowledged_at: t.acknowledged_at,
      completed_at: t.completed_at,
      closed_at: t.closed_at,
      timeline: events.map((e) => ({
        from_status: e.from_status,
        to_status: e.to_status,
        status_label: STATUS_LABELS[e.to_status as StatusCode] ?? e.to_status,
        note: e.note,
        created_at: e.created_at,
      })),
      attachments: [...attachments],
    });
  });
};
