// สรุปงานรายสัปดาห์/รายเดือนของแต่ละฝ่าย — ตัวเลขทั้งหมดของรายงานถูกคำนวณที่นี่ที่เดียว
//
// รายงานตอบคำถามของผู้บริหาร 3 ข้อ: ช่วงที่ผ่านมามีงานเข้ามาเท่าไหร่และปิดได้เท่าไหร่ ·
// ตอนนี้ยังค้างอะไรอยู่บ้าง · ใครทำได้แค่ไหน
//
// แยก "ในช่วงนี้" ออกจาก "ณ ปัจจุบัน" อย่างชัดเจน เพราะเป็นคนละคำถามกัน
// งานที่เข้าและปิดเป็นเหตุการณ์ที่เกิดในช่วงเวลา ส่วนงานค้างเป็นภาพนิ่ง ณ วันที่ออกรายงาน
// ถ้าเอาสองอย่างมาปนกันในตารางเดียว ตัวเลขจะบวกกันไม่ลงและอธิบายให้ใครฟังไม่ได้

import { CATEGORY_BY_CODE, STATUS_LABELS, type StatusCode } from "./constants";
import { db } from "./db";
import { thaiDateShort } from "./tickets";

export type Period = "week" | "month";

const TH_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PeriodRange {
  from: Date;
  to: Date;
  /** ช่วงนี้ยังไม่จบ — ตัวเลขเป็นยอดถึงตอนนี้ ไม่ใช่ยอดทั้งช่วง */
  ongoing: boolean;
  label: string;
}

/**
 * ขอบเขตของช่วงเวลาตามเวลาไทย
 *
 * offset = 0 คือช่วงปัจจุบัน · 1 คือช่วงก่อนหน้า — รายงานอัตโนมัติใช้ 1 เสมอ
 * เพราะรายงาน "ประจำสัปดาห์" ที่ส่งเช้าวันจันทร์ต้องพูดถึงสัปดาห์ที่เพิ่งจบ ไม่ใช่สัปดาห์ที่เพิ่งเริ่ม
 *
 * สัปดาห์เริ่มวันจันทร์ตามที่ใช้กันในที่ทำงาน ไม่ใช่วันอาทิตย์
 */
export function periodRange(period: Period, offset = 0, now = new Date()): PeriodRange {
  // เลื่อนเวลาไป 7 ชั่วโมงแล้วอ่านค่าแบบ UTC = อ่านวันเวลาตามปฏิทินไทยโดยไม่ต้องพึ่ง timezone ของเครื่อง
  const th = new Date(now.getTime() + TH_OFFSET_MS);
  const y = th.getUTCFullYear();
  const m = th.getUTCMonth();
  const d = th.getUTCDate();

  let fromLocal: number;
  let toLocal: number;
  if (period === "month") {
    fromLocal = Date.UTC(y, m - offset, 1);
    toLocal = Date.UTC(y, m - offset + 1, 1);
  } else {
    const mondayIndex = (th.getUTCDay() + 6) % 7; // อาทิตย์=0 ของ JS -> จันทร์=0
    fromLocal = Date.UTC(y, m, d - mondayIndex - 7 * offset);
    toLocal = fromLocal + 7 * DAY_MS;
  }

  const from = new Date(fromLocal - TH_OFFSET_MS);
  const to = new Date(toLocal - TH_OFFSET_MS);
  const ongoing = to.getTime() > now.getTime();
  const last = new Date(toLocal - DAY_MS - TH_OFFSET_MS);
  const label = ongoing
    ? `${thaiDateShort(from)} – ปัจจุบัน`
    : `${thaiDateShort(from)} – ${thaiDateShort(last)}`;
  return { from, to, ongoing, label };
}

export const PERIOD_TITLE: Record<Period, string> = { week: "รายสัปดาห์", month: "รายเดือน" };

export interface ReportTicket {
  ticket_no: string;
  category_label: string;
  floor: string;
  location_note: string | null;
  detail: string;
  urgency: string;
  status: StatusCode;
  status_label: string;
  reporter_name: string;
  assignee_name: string | null;
  created_label: string;
  due_label: string | null;
  /** จำนวนวันที่เลยกำหนดมาแล้ว (0 = ยังไม่เลย) */
  overdue_days: number;
  age_days: number;
  waiting_parts: boolean;
  assessment: string | null;
}

export interface PersonRow {
  name: string;
  closed: number;
  open: number;
  overdue: number;
  on_time: number;
  due_closed: number;
  avg_close_hours: number | null;
}

export interface BreakdownRow {
  label: string;
  total: number;
  open: number;
}

export interface DeptReport {
  department_code: string;
  department_name: string;
  period: Period;
  period_title: string;
  range_label: string;
  ongoing: boolean;
  generated_label: string;
  /** เหตุการณ์ที่เกิดในช่วงนี้ */
  flow: { created: number; completed: number; cancelled: number };
  /** ภาพนิ่ง ณ วันที่ออกรายงาน */
  now: { pending: number; in_progress: number; overdue: number; waiting_parts: number; not_assessed: number };
  kpi: {
    ack_hours: number | null;
    /** จำนวนเรื่องที่ใช้คิดเวลารับเรื่องเฉลี่ย (แจ้งเข้ามาในช่วงนี้และมีคนรับแล้ว) */
    ack_base: number;
    close_hours: number | null;
    on_time: number;
    due_closed: number;
    assessed: number;
    completed: number;
    oldest_open_days: number;
  };
  people: PersonRow[];
  categories: BreakdownRow[];
  floors: BreakdownRow[];
  open_tickets: ReportTicket[];
  closed_tickets: ReportTicket[];
  cancelled_tickets: ReportTicket[];
}

interface RawTicket {
  ticket_no: string;
  category_code: string;
  floor: string;
  location_note: string | null;
  detail: string;
  urgency: string;
  status: StatusCode;
  reporter_name: string;
  assignee_name: string | null;
  created_at: string;
  due_at: string | null;
  due_label: string | null;
  waiting_parts: boolean;
  assessment: string | null;
  assessed_at: string | null;
}

function toTicket(t: RawTicket, now: Date): ReportTicket {
  const created = new Date(t.created_at);
  const due = t.due_at ? new Date(t.due_at) : null;
  const overdueMs = due ? now.getTime() - due.getTime() : 0;
  return {
    ticket_no: t.ticket_no,
    category_label: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
    floor: t.floor,
    location_note: t.location_note,
    detail: t.detail,
    urgency: t.urgency,
    status: t.status,
    status_label: STATUS_LABELS[t.status] ?? t.status,
    reporter_name: t.reporter_name,
    assignee_name: t.assignee_name,
    created_label: thaiDateShort(created),
    due_label: due ? [t.due_label, thaiDateShort(due)].filter(Boolean).join(" · ") : null,
    overdue_days: overdueMs > 0 ? Math.floor(overdueMs / DAY_MS) : 0,
    age_days: Math.max(0, Math.floor((now.getTime() - created.getTime()) / DAY_MS)),
    waiting_parts: t.waiting_parts,
    assessment: t.assessment,
  };
}

/** สรุปงานของฝ่ายหนึ่งในช่วงเวลาหนึ่ง */
export async function buildDeptReport(
  departmentId: string,
  period: Period,
  offset = 0,
  now = new Date(),
): Promise<DeptReport | null> {
  const sql = db();
  const range = periodRange(period, offset, now);
  const { from, to } = range;

  const dept = await sql<{ code: string; name: string }[]>`
    SELECT code, name FROM departments WHERE id = ${departmentId} LIMIT 1
  `;
  if (dept.length === 0) return null;

  const [counts, kpi, people, categories, floors, open, closed, cancelled] = await Promise.all([
    sql<
      { created: number; completed: number; cancelled: number; pending: number; in_progress: number; overdue: number; waiting_parts: number; not_assessed: number }[]
    >`
      SELECT
        count(*) FILTER (WHERE t.created_at >= ${from} AND t.created_at < ${to})::int AS created,
        count(*) FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to})::int AS completed,
        count(*) FILTER (WHERE t.status = 'cancelled' AND t.updated_at >= ${from} AND t.updated_at < ${to})::int AS cancelled,
        count(*) FILTER (WHERE t.status = 'pending')::int AS pending,
        count(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
        count(*) FILTER (WHERE t.status = 'in_progress' AND t.due_at IS NOT NULL AND t.due_at < now())::int AS overdue,
        count(*) FILTER (WHERE t.status = 'in_progress' AND t.waiting_parts)::int AS waiting_parts,
        count(*) FILTER (WHERE t.status = 'in_progress' AND t.assessed_at IS NULL)::int AS not_assessed
      FROM tickets t WHERE t.department_id = ${departmentId}
    `,
    sql<{ ack_hours: number | null; ack_base: number; close_hours: number | null; on_time: number; due_closed: number; assessed: number; completed: number; oldest_open_days: number }[]>`
      SELECT
        -- เวลารับเรื่องคิดจากงานที่ "แจ้งเข้ามาในช่วงนี้" ไม่ใช่งานที่ปิดในช่วงนี้ เพราะเป็นตัววัด
        -- ความไวในการตอบสนองของช่วงนั้น ถ้าไปผูกกับวันที่ปิด งานที่แจ้งเดือนก่อนแล้วเพิ่งปิดสัปดาห์นี้
        -- จะลากค่าเฉลี่ยของสัปดาห์นี้ไปด้วยทั้งที่ไม่เกี่ยวกัน
        avg(EXTRACT(EPOCH FROM (t.acknowledged_at - t.created_at)) / 3600)
          FILTER (WHERE t.acknowledged_at IS NOT NULL AND t.created_at >= ${from} AND t.created_at < ${to}) AS ack_hours,
        count(*) FILTER (WHERE t.acknowledged_at IS NOT NULL AND t.created_at >= ${from} AND t.created_at < ${to})::int AS ack_base,
        avg(EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 3600)
          FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to}) AS close_hours,
        count(*) FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to}
                           AND t.due_at IS NOT NULL AND t.completed_at <= t.due_at)::int AS on_time,
        count(*) FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to} AND t.due_at IS NOT NULL)::int AS due_closed,
        count(*) FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to} AND t.assessed_at IS NOT NULL)::int AS assessed,
        count(*) FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to})::int AS completed,
        COALESCE(max(EXTRACT(EPOCH FROM (now() - t.created_at)) / 86400)
          FILTER (WHERE t.status IN ('pending', 'in_progress')), 0)::int AS oldest_open_days
      FROM tickets t WHERE t.department_id = ${departmentId}
    `,
    sql<PersonRow[]>`
      SELECT a.full_name AS name,
             count(*) FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to})::int AS closed,
             count(*) FILTER (WHERE t.status = 'in_progress')::int AS open,
             count(*) FILTER (WHERE t.status = 'in_progress' AND t.due_at IS NOT NULL AND t.due_at < now())::int AS overdue,
             count(*) FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to}
                                AND t.due_at IS NOT NULL AND t.completed_at <= t.due_at)::int AS on_time,
             count(*) FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to} AND t.due_at IS NOT NULL)::int AS due_closed,
             avg(EXTRACT(EPOCH FROM (t.completed_at - t.created_at)) / 3600)
               FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to}) AS avg_close_hours
      FROM tickets t
      JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ${departmentId}
        AND (t.status = 'in_progress' OR (t.completed_at >= ${from} AND t.completed_at < ${to}))
      GROUP BY a.full_name
      ORDER BY closed DESC, open DESC, a.full_name
    `,
    sql<{ code: string; total: number; open: number }[]>`
      SELECT t.category_code AS code,
             count(*) FILTER (WHERE t.created_at >= ${from} AND t.created_at < ${to})::int AS total,
             count(*) FILTER (WHERE t.status IN ('pending', 'in_progress'))::int AS open
      FROM tickets t WHERE t.department_id = ${departmentId}
      GROUP BY t.category_code ORDER BY total DESC
    `,
    sql<{ label: string; total: number; open: number }[]>`
      SELECT t.floor AS label,
             count(*) FILTER (WHERE t.created_at >= ${from} AND t.created_at < ${to})::int AS total,
             count(*) FILTER (WHERE t.status IN ('pending', 'in_progress'))::int AS open
      FROM tickets t WHERE t.department_id = ${departmentId}
      GROUP BY t.floor
      HAVING count(*) FILTER (WHERE t.created_at >= ${from} AND t.created_at < ${to}) > 0
          OR count(*) FILTER (WHERE t.status IN ('pending', 'in_progress')) > 0
      ORDER BY total DESC, open DESC LIMIT 12
    `,
    // งานค้างเป็นภาพนิ่ง ณ ตอนนี้ ไม่ผูกกับช่วงเวลา — เรื่องที่ค้างมาตั้งแต่เดือนก่อนก็ยังต้องอยู่ในรายงาน
    sql<RawTicket[]>`
      SELECT t.ticket_no, t.category_code, t.floor, t.location_note, t.detail, t.urgency, t.status,
             t.created_at, t.due_at, t.due_label, t.waiting_parts, t.assessment, t.assessed_at,
             r.full_name AS reporter_name, a.full_name AS assignee_name
      FROM tickets t
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ${departmentId} AND t.status IN ('pending', 'in_progress')
      ORDER BY (t.due_at IS NOT NULL AND t.due_at < now()) DESC,
               CASE t.urgency WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
               t.created_at ASC
      LIMIT 200
    `,
    sql<RawTicket[]>`
      SELECT t.ticket_no, t.category_code, t.floor, t.location_note, t.detail, t.urgency, t.status,
             t.created_at, t.due_at, t.due_label, t.waiting_parts, t.assessment, t.assessed_at,
             r.full_name AS reporter_name, a.full_name AS assignee_name
      FROM tickets t
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ${departmentId} AND t.completed_at >= ${from} AND t.completed_at < ${to}
      ORDER BY t.completed_at DESC LIMIT 200
    `,
    sql<RawTicket[]>`
      SELECT t.ticket_no, t.category_code, t.floor, t.location_note, t.detail, t.urgency, t.status,
             t.created_at, t.due_at, t.due_label, t.waiting_parts, t.assessment, t.assessed_at,
             r.full_name AS reporter_name, a.full_name AS assignee_name
      FROM tickets t
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ${departmentId} AND t.status = 'cancelled'
        AND t.updated_at >= ${from} AND t.updated_at < ${to}
      ORDER BY t.updated_at DESC LIMIT 100
    `,
  ]);

  const c = counts[0];
  const k = kpi[0];
  return {
    department_code: dept[0].code,
    department_name: dept[0].name,
    period,
    period_title: PERIOD_TITLE[period],
    range_label: range.label,
    ongoing: range.ongoing,
    generated_label: thaiDateShort(now),
    flow: { created: c.created, completed: c.completed, cancelled: c.cancelled },
    now: {
      pending: c.pending,
      in_progress: c.in_progress,
      overdue: c.overdue,
      waiting_parts: c.waiting_parts,
      not_assessed: c.not_assessed,
    },
    kpi: {
      ack_hours: k.ack_hours === null ? null : Number(k.ack_hours),
      ack_base: k.ack_base,
      close_hours: k.close_hours === null ? null : Number(k.close_hours),
      on_time: k.on_time,
      due_closed: k.due_closed,
      assessed: k.assessed,
      completed: k.completed,
      oldest_open_days: k.oldest_open_days,
    },
    people: people.map((p) => ({ ...p, avg_close_hours: p.avg_close_hours === null ? null : Number(p.avg_close_hours) })),
    categories: categories.map((r) => ({
      label: CATEGORY_BY_CODE.get(r.code)?.label ?? r.code,
      total: r.total,
      open: r.open,
    })),
    floors: [...floors],
    open_tickets: open.map((t) => toTicket(t, now)),
    closed_tickets: closed.map((t) => toTicket(t, now)),
    cancelled_tickets: cancelled.map((t) => toTicket(t, now)),
  };
}
