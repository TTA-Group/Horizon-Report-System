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

export type Period = "week" | "month" | "all";

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
  // "ทั้งหมด" ไม่มีขอบเวลา — นับทุกเรื่องที่มีในระบบ ไม่ว่าจะแจ้งไว้ตั้งแต่เมื่อไหร่
  // ใช้เวลาเริ่มต้นของยุค epoch เป็นขอบล่าง เพื่อให้ query ชุดเดียวใช้ได้กับทุกช่วงโดยไม่ต้องแยกเส้นทาง
  if (period === "all") {
    // ไม่มีขอบบนจริง ๆ ไม่ใช่ "ถึงตอนนี้" — เผื่อมีเรื่องที่วันเวลาในฐานข้อมูลล้ำหน้าไป
    // (เวลาเครื่องเพี้ยน หรือแก้ข้อมูลย้อนหลัง) จะได้ไม่หายไปจากรายงานที่ชื่อว่า "ทั้งหมด"
    return { from: new Date(0), to: new Date("9999-12-31T00:00:00Z"), ongoing: false, label: "ตั้งแต่เริ่มใช้ระบบ" };
  }

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

export const PERIOD_TITLE: Record<Period, string> = { week: "รายสัปดาห์", month: "รายเดือน", all: "ทั้งหมด" };

/** รหัสสมมติของ "ทุกฝ่ายรวมกัน" — ไม่ใช่รหัสฝ่ายจริงในฐานข้อมูล จึงชนกับของจริงไม่ได้ */
export const ALL_DEPTS = "ALL";

export interface ReportTicket {
  ticket_no: string;
  /** ฝ่ายเจ้าของเรื่อง — ใช้ตอนรายงานรวมหลายฝ่าย เพราะตารางเดียวปนกันแล้วต้องแยกออก */
  dept_name: string;
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
  /** คำบอกกำหนด เช่น "ภายใน 3 วัน" — แยกจากวันที่ ให้หน้ารายงานวางคนละบรรทัดได้ */
  due_label: string | null;
  due_date_label: string | null;
  /** จำนวนวันที่เลยกำหนดมาแล้ว (0 = ยังไม่เลย) */
  overdue_days: number;
  age_days: number;
  waiting_parts: boolean;
  assessment: string | null;
}

export interface DeptReport {
  department_code: string;
  department_name: string;
  /** จำนวนฝ่ายที่รายงานนี้รวมไว้ — มากกว่า 1 เมื่อไหร่ ตารางต้องบอกด้วยว่าแต่ละเรื่องเป็นของฝ่ายไหน */
  dept_count: number;
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
  dept_name: string;
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
    dept_name: t.dept_name,
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
    due_label: due ? t.due_label : null,
    due_date_label: due ? thaiDateShort(due) : null,
    overdue_days: overdueMs > 0 ? Math.floor(overdueMs / DAY_MS) : 0,
    age_days: Math.max(0, Math.floor((now.getTime() - created.getTime()) / DAY_MS)),
    waiting_parts: t.waiting_parts,
    assessment: t.assessment,
  };
}

/**
 * สรุปงานของฝ่ายหนึ่ง หรือของหลายฝ่ายรวมกันในช่วงเวลาหนึ่ง
 *
 * รับเป็นรายชื่อฝ่ายเสมอ เพราะหน้าสรุปงานตั้งต้นที่ "ทั้งหมด" — หัวหน้าที่ดูแลหลายฝ่าย
 * และฝ่ายบุคคลต้องเห็นภาพรวมก่อน แล้วค่อยเจาะเข้าไปดูทีละฝ่าย ไม่ใช่เห็นฝ่ายแรกตามตัวอักษร
 * แล้วต้องไล่กดดูเองว่ารวมกันแล้วเป็นเท่าไหร่
 */
export async function buildDeptReport(
  departmentIds: string | string[],
  period: Period,
  offset = 0,
  now = new Date(),
): Promise<DeptReport | null> {
  const ids = (Array.isArray(departmentIds) ? departmentIds : [departmentIds]).filter(Boolean);
  if (ids.length === 0) return null;
  const sql = db();
  const range = periodRange(period, offset, now);
  const { from, to } = range;

  const dept = await sql<{ code: string; name: string }[]>`
    SELECT code, name FROM departments WHERE id = ANY(${ids}::uuid[]) ORDER BY code
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
      FROM tickets t WHERE t.department_id = ANY(${ids}::uuid[])
    `,
    // งานค้างเป็นภาพนิ่ง ณ ตอนนี้ ไม่ผูกกับช่วงเวลา — เรื่องที่ค้างมาตั้งแต่เดือนก่อนก็ยังต้องอยู่ในรายงาน
    // เรียงให้ของที่ต้องรีบอยู่บนสุด: เลยกำหนดก่อน แล้วตามความเร่งด่วน แล้วเรื่องเก่าก่อน
    sql<RawTicket[]>`
      SELECT t.ticket_no, t.category_code, t.floor, t.location_note, t.detail, t.urgency, t.status,
             t.created_at, t.due_at, t.due_label, t.waiting_parts, t.assessment, t.assessed_at,
             d.name AS dept_name, r.full_name AS reporter_name, a.full_name AS assignee_name
      FROM tickets t
      JOIN departments d ON d.id = t.department_id
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ANY(${ids}::uuid[]) AND t.status IN ('pending', 'in_progress')
      ORDER BY (t.due_at IS NOT NULL AND t.due_at < now()) DESC,
               CASE t.urgency WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
               t.created_at ASC
      LIMIT 500
    `,
    sql<RawTicket[]>`
      SELECT t.ticket_no, t.category_code, t.floor, t.location_note, t.detail, t.urgency, t.status,
             t.created_at, t.due_at, t.due_label, t.waiting_parts, t.assessment, t.assessed_at,
             d.name AS dept_name, r.full_name AS reporter_name, a.full_name AS assignee_name
      FROM tickets t
      JOIN departments d ON d.id = t.department_id
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ANY(${ids}::uuid[]) AND t.completed_at >= ${from} AND t.completed_at < ${to}
      ORDER BY t.completed_at DESC LIMIT 1000
    `,
    sql<RawTicket[]>`
      SELECT t.ticket_no, t.category_code, t.floor, t.location_note, t.detail, t.urgency, t.status,
             t.created_at, t.due_at, t.due_label, t.waiting_parts, t.assessment, t.assessed_at,
             d.name AS dept_name, r.full_name AS reporter_name, a.full_name AS assignee_name
      FROM tickets t
      JOIN departments d ON d.id = t.department_id
      JOIN employees r ON r.id = t.reporter_id
      LEFT JOIN employees a ON a.id = t.assignee_id
      WHERE t.department_id = ANY(${ids}::uuid[]) AND t.status = 'cancelled'
        AND t.updated_at >= ${from} AND t.updated_at < ${to}
      ORDER BY t.updated_at DESC LIMIT 300
    `,
  ]);

  const c = counts[0];
  // รวมหลายฝ่าย ชื่อรายงานจึงเป็นชื่อรวม ไม่ใช่ชื่อฝ่ายใดฝ่ายหนึ่ง
  const many = dept.length > 1;
  return {
    department_code: many ? ALL_DEPTS : dept[0].code,
    department_name: many ? "รวมทุกฝ่าย" : dept[0].name,
    dept_count: dept.length,
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
