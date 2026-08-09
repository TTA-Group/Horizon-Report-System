// GET /api/tickets/department — รายการงานของฝ่าย รองรับ filter สถานะและผู้รับผิดชอบ (spec หัวข้อ 6)
// query: ?dept=IT&status=pending&assignee=me

import type { Config } from "@netlify/functions";
import { getSession, isMemberOf, requireActive } from "./_lib/auth";
import { CATEGORY_BY_CODE, STATUS_LABELS, STATUS_TRANSITIONS, type StatusCode } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, run } from "./_lib/http";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireActive(s);

    const params = new URL(req.url).searchParams;
    const deptCode = (params.get("dept") ?? "").trim().toUpperCase();
    const status = (params.get("status") ?? "").trim();
    const assigneeMe = params.get("assignee") === "me";

    const sql = db();

    // ระบุฝ่ายที่จะดู
    let departmentId: string;
    if (deptCode) {
      const rows = await sql<{ id: string }[]>`SELECT id FROM departments WHERE code = ${deptCode} LIMIT 1`;
      if (rows.length === 0) throw new HttpError(404, "ไม่พบฝ่ายนี้");
      departmentId = rows[0].id;
      if (!isMemberOf(s, departmentId)) throw new HttpError(403, "ไม่มีสิทธิ์ดูรายการงานของฝ่ายนี้");
    } else if (s.deptRoles.length === 1) {
      departmentId = s.deptRoles[0].department_id;
    } else {
      throw new HttpError(400, "กรุณาระบุฝ่าย (dept)");
    }

    // ตรวจค่า status ให้อยู่ในชุดที่รู้จัก
    if (status && !(status in STATUS_TRANSITIONS)) throw new HttpError(400, "สถานะไม่ถูกต้อง");
    const statusFilter = status ? sql`AND t.status = ${status}` : sql``;
    const assigneeFilter = assigneeMe ? sql`AND t.assignee_id = ${s.employee.id}` : sql``;

    const rows = await sql<
      {
        id: string;
        ticket_no: string;
        category_code: string;
        floor: string;
        location_note: string | null;
        detail: string;
        urgency: string;
        status: StatusCode;
        created_at: string;
        reporter_name: string;
        reporter_dept: string | null;
        assignee_name: string | null;
      }[]
    >`
      SELECT t.id, t.ticket_no, t.category_code, t.floor, t.location_note, t.detail,
             t.urgency, t.status, t.created_at,
             r.full_name AS reporter_name, r.department_name AS reporter_dept,
             a.full_name AS assignee_name
      FROM tickets t
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ${departmentId} ${statusFilter} ${assigneeFilter}
      ORDER BY CASE t.urgency WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, t.created_at DESC
      LIMIT 100
    `;

    return json({
      department_id: departmentId,
      tickets: rows.map((t) => ({
        id: t.id,
        ticket_no: t.ticket_no,
        category_label: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
        floor: t.floor,
        location_note: t.location_note,
        detail: t.detail,
        urgency: t.urgency,
        status: t.status,
        status_label: STATUS_LABELS[t.status] ?? t.status,
        created_at: t.created_at,
        reporter_name: t.reporter_name,
        reporter_dept: t.reporter_dept,
        assignee_name: t.assignee_name,
      })),
    });
  });

export const config: Config = { path: "/api/tickets/department" };
