// ตรรกะของ GET /api/tickets/mine และ GET /api/tickets/department
//
// อยู่ใน _lib (ไม่ใช่ไฟล์ endpoint แยก) เพราะ "/api/tickets/mine" กับ "/api/tickets/:id"
// มีรูปแบบเส้นทางชนกัน ถ้าแยกไฟล์กันจะเสี่ยงถูกจับคู่ผิดตัว
// จึงให้ tickets-detail.ts เป็นจุดเดียวที่รับ แล้วแยกเรียกฟังก์ชันในไฟล์นี้เอง

import { getSession, isMemberOf, requireActive } from "./auth";
import { CATEGORY_BY_CODE, STATUS_LABELS, STATUS_TRANSITIONS, type StatusCode } from "./constants";
import { db } from "./db";
import { HttpError, json, methodGuard, run } from "./http";
import { thaiDateShort } from "./tickets";

/** สถานะที่ถือว่าเรื่องจบแล้ว — ไม่มีอะไรให้ทำต่อ เหลือไว้เป็นประวัติ */
const DONE_STATUSES = new Set<string>(["completed", "closed", "cancelled"]);

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

/** GET /api/tickets/mine — เรื่องของผู้ใช้ปัจจุบัน พร้อมไทม์ไลน์ (spec หัวข้อ 6) */
export async function handleTicketsMine(req: Request): Promise<Response> {
  return run(async () => {
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
}

/** GET /api/tickets/department — รายการงานของฝ่าย รองรับ filter สถานะและผู้รับผิดชอบ (spec หัวข้อ 6) */
export async function handleTicketsDepartment(req: Request): Promise<Response> {
  return run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireActive(s);

    const params = new URL(req.url).searchParams;
    const deptCode = (params.get("dept") ?? "").trim().toUpperCase();
    const status = (params.get("status") ?? "").trim();
    const assigneeMe = params.get("assignee") === "me";
    // group แยก "งานที่ยังต้องทำ" ออกจาก "งานที่จบไปแล้ว" — งานที่ปิดไปแล้วเป็นประวัติ
    // ไม่ใช่สิ่งที่ต้องเห็นตอนไล่ดูว่าเหลืออะไรต้องทำ ปนกันแล้วรายการยาวขึ้นเรื่อย ๆ จนหาของจริงไม่เจอ
    const group = (params.get("group") ?? "").trim();
    if (group && group !== "active" && group !== "done") throw new HttpError(400, "กลุ่มงานไม่ถูกต้อง");

    const sql = db();

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

    if (status && !(status in STATUS_TRANSITIONS)) throw new HttpError(400, "สถานะไม่ถูกต้อง");
    const statusFilter = status ? sql`AND t.status = ${status}` : sql``;
    const assigneeFilter = assigneeMe ? sql`AND t.assignee_id = ${s.employee.id}` : sql``;
    const groupFilter =
      group === "active"
        ? sql`AND t.status IN ('pending', 'in_progress')`
        : group === "done"
          ? sql`AND t.status IN ('completed', 'closed', 'cancelled')`
          : sql``;
    // งานที่จบแล้วเรียงตามเวลาที่จบ ใหม่สุดขึ้นก่อน — ความเร่งด่วนไม่มีความหมายกับงานที่ปิดไปแล้ว
    const order =
      group === "done"
        ? sql`ORDER BY COALESCE(t.completed_at, t.closed_at, t.updated_at) DESC`
        : sql`ORDER BY CASE t.urgency WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, t.created_at DESC`;

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
        assessed_at: string | null;
        due_at: string | null;
        due_label: string | null;
        waiting_parts: boolean;
        finished_at: string | null;
      }[]
    >`
      SELECT t.id, t.ticket_no, t.category_code, t.floor, t.location_note, t.detail,
             t.urgency, t.status, t.created_at, t.assessed_at, t.due_at, t.due_label, t.waiting_parts,
             COALESCE(t.completed_at, t.closed_at, t.updated_at) AS finished_at,
             r.full_name AS reporter_name, r.department_name AS reporter_dept,
             a.full_name AS assignee_name
      FROM tickets t
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ${departmentId} ${statusFilter} ${assigneeFilter} ${groupFilter}
      ${order}
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
        // งานที่ยังไม่แจ้งผลคือสิ่งที่ค้างอยู่จริง หน้าคิวจึงต้องรู้เพื่อขึ้นปุ่มให้ถูก
        assessed: t.assessed_at !== null,
        due_label: t.due_label,
        due_date_label: t.due_at ? thaiDateShort(new Date(t.due_at)) : null,
        waiting_parts: t.waiting_parts,
        // วันที่จบงาน — มีความหมายเฉพาะกับงานที่ปิดไปแล้ว งานที่ยังทำอยู่ค่านี้คือเวลาที่แก้ไขล่าสุด
        finished_date_label:
          DONE_STATUSES.has(t.status) && t.finished_at ? thaiDateShort(new Date(t.finished_at)) : null,
      })),
    });
  });
}
