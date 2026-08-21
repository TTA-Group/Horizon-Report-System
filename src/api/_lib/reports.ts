// สรุปงานรายสัปดาห์/รายเดือนของแต่ละฝ่าย — ตัวเลขทั้งหมดของรายงานถูกคำนวณที่นี่ที่เดียว
//
// รายงานตอบคำถามเดียว: ตอนนี้ภาพรวมของฝ่ายเป็นยังไง — เข้ามากี่เรื่อง ปิดไปกี่เรื่อง เหลือค้างอะไร
// ไม่มีตัวชี้วัดประสิทธิภาพและไม่มีกราฟ เพราะสิ่งที่คนเปิดดูต้องการคือรายการงานกับตัวเลขไม่กี่ตัว
// ที่อ่านจบในสิบวินาที ไม่ใช่แผงข้อมูลที่ต้องตีความ
//
// แยก "ในช่วงนี้" ออกจาก "ณ ปัจจุบัน" ในการคำนวณ เพราะเป็นคนละคำถาม — งานที่เข้าและปิด
// เป็นเหตุการณ์ที่เกิดในช่วงเวลา ส่วนงานค้างเป็นภาพนิ่ง ณ วันที่ออกรายงาน

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
  now: { pending: number; in_progress: number; overdue: number };
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

  const [counts, open, closed, cancelled] = await Promise.all([
    sql<{ created: number; completed: number; cancelled: number; pending: number; in_progress: number; overdue: number }[]>`
      SELECT
        count(*) FILTER (WHERE t.created_at >= ${from} AND t.created_at < ${to})::int AS created,
        count(*) FILTER (WHERE t.completed_at >= ${from} AND t.completed_at < ${to})::int AS completed,
        count(*) FILTER (WHERE t.status = 'cancelled' AND t.updated_at >= ${from} AND t.updated_at < ${to})::int AS cancelled,
        count(*) FILTER (WHERE t.status = 'pending')::int AS pending,
        count(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
        count(*) FILTER (WHERE t.status = 'in_progress' AND t.due_at IS NOT NULL AND t.due_at < now())::int AS overdue
      FROM tickets t WHERE t.department_id = ${departmentId}
    `,
    // งานค้างเป็นภาพนิ่ง ณ ตอนนี้ ไม่ผูกกับช่วงเวลา — เรื่องที่ค้างมาตั้งแต่เดือนก่อนก็ยังต้องอยู่ในรายงาน
    // เรียงให้ของที่ต้องรีบอยู่บนสุด: เลยกำหนดก่อน แล้วตามความเร่งด่วน แล้วเรื่องเก่าก่อน
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
      LIMIT 300
    `,
    sql<RawTicket[]>`
      SELECT t.ticket_no, t.category_code, t.floor, t.location_note, t.detail, t.urgency, t.status,
             t.created_at, t.due_at, t.due_label, t.waiting_parts, t.assessment, t.assessed_at,
             r.full_name AS reporter_name, a.full_name AS assignee_name
      FROM tickets t
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ${departmentId} AND t.completed_at >= ${from} AND t.completed_at < ${to}
      ORDER BY t.completed_at DESC LIMIT 300
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
  return {
    department_code: dept[0].code,
    department_name: dept[0].name,
    period,
    period_title: PERIOD_TITLE[period],
    range_label: range.label,
    ongoing: range.ongoing,
    generated_label: thaiDateShort(now),
    flow: { created: c.created, completed: c.completed, cancelled: c.cancelled },
    now: { pending: c.pending, in_progress: c.in_progress, overdue: c.overdue },
    open_tickets: open.map((t) => toTicket(t, now)),
    closed_tickets: closed.map((t) => toTicket(t, now)),
    cancelled_tickets: cancelled.map((t) => toTicket(t, now)),
  };
}
