// ตรรกะของระบบจองคิวนวด — กติกาทั้งหมดอยู่ที่นี่ที่เดียว
//
// หลักสำคัญที่ต่างจากระบบเดิม: **กติกาทุกข้อบังคับที่เซิร์ฟเวอร์** ไม่ใช่ที่หน้าเว็บ
// ระบบเดิมนับสิทธิ์และกันคิวชนกันในเบราว์เซอร์ ซึ่งข้ามได้ด้วยการเปิด developer tools
// และกันคนสองคนที่กดพร้อมกันไม่ได้เลย
//
// จุดที่ต้องระวังเป็นพิเศษเวลาแก้ไฟล์นี้:
//   - ห้ามส่งชื่อคนอื่นออกไปในผลของ dayAvailability (ดูคำอธิบายตรงฟังก์ชันนั้น)
//   - การจองต้องอยู่ใน transaction เดียวกับการนับสิทธิ์เสมอ
//   - เวลาทุกจุดเป็นเวลาไทย ส่วนที่เก็บลงฐานข้อมูลเป็น TIMESTAMPTZ ตามปกติ

import { requireActive, type Session } from "./auth";
import { db } from "./db";
import { HttpError } from "./http";

// ───────────────────────── ค่าคงที่ของบริการ ─────────────────────────

/** รอบเวลาให้บริการ 10:00–15:00 เว้นพักกลางวัน 12:00–13:00 (8 รอบ รอบละ 30 นาที) */
export const MASSAGE_SLOTS = [
  "10:00", "10:30", "11:00", "11:30",
  "13:00", "13:30", "14:00", "14:30",
] as const;

export const SLOT_MINUTES = 30;

/** สิทธิ์ต่อคนต่อเดือนปฏิทิน นับตามเดือนของวันที่ไปนวด ไม่ใช่เดือนที่กดจอง */
export const MONTHLY_QUOTA = 2;

/**
 * เส้นตัด 15 นาทีก่อนรอบเริ่ม ใช้ทั้งสองทาง
 *
 * ฝั่งยกเลิก: กันคนไปนวดเสร็จแล้วย้อนกลับมากดยกเลิกเพื่อเอาสิทธิ์คืน
 * ฝั่งจอง: กันไม่ให้หมอนวดเจอคิวโผล่มาตอนคนกำลังจะเดินเข้าห้อง
 */
export const CUTOFF_MINUTES = 15;

/**
 * Flash Queue — คิวด่วน
 *
 * ก่อน 15:00 ของวันก่อนหน้าวันให้บริการ = ช่วงสิทธิ์ ใครมีสิทธิ์เหลือจองได้ นับสิทธิ์ ยกเลิกได้
 * ตั้งแต่ 15:00 เป็นต้นไป = ช่วงคิวด่วน ใครก็จองได้ ไม่นับสิทธิ์ ไม่จำกัดจำนวน แต่ยกเลิกเองไม่ได้
 *
 * เปิดแล้วเปิดยาวจนหมดวัน ไม่ปิดอีก ช่องที่มีคนยกเลิกระหว่างวันจึงกลับเข้าคิวด่วนได้เอง
 * โดยไม่ต้องมีกลไกแยก — เป็นเหตุผลที่เลือกวิธีนี้แทนการเปิดเป็นช่วงสั้น ๆ
 *
 * โหมดตัดสินตอน "กดจอง" ไม่ใช่ย้อนหลัง คิวที่จองด้วยสิทธิ์ไว้ก่อนหน้าจึงยังยกเลิกได้ตามปกติ
 */
export const FLASH_FROM_HOUR = 15;
export const FLASH_LEAD_DAYS = 1;

/** วันให้บริการ = ศุกร์ (ISO: จันทร์=1 … อาทิตย์=7) */
export const SERVICE_ISODOW = 5;

/** เวลาเปิดจองของวันที่ 1 ถ้าไม่ได้ตั้งค่าไว้ใน app_settings */
export const DEFAULT_OPEN_HOUR = 9;

/** จองได้วันละกี่คิวต่อคน — หนึ่ง เพื่อให้สิทธิ์ 2 ครั้งกลายเป็นสองวันคนละสัปดาห์ */
export const DAILY_LIMIT = 1;

const TH_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];
const TH_DOW = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
// ตัวย่อวันตามที่ใช้กันจริง ไม่ใช่การตัดสองตัวอักษรแรก (ศุกร์ ย่อว่า ศ. ไม่ใช่ ศุ.)
const TH_DOW_SHORT = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

// ───────────────────────── เวลาไทย ─────────────────────────
//
// ไทยไม่มีเวลาออมแสง จึงบวก 7 ชั่วโมงแล้วอ่านค่าแบบ UTC ได้ตรง ๆ
// เป็นวิธีเดียวกับที่ _lib/tickets.ts ใช้อยู่ ให้ทั้งสองระบบคิดเวลาเหมือนกัน

/** วันที่วันนี้ตามเวลาไทย เป็น "YYYY-MM-DD" */
export function bangkokDate(now = new Date()): string {
  const th = new Date(now.getTime() + BKK_OFFSET_MS);
  return th.toISOString().slice(0, 10);
}

/** เวลาจริงที่รอบเริ่ม เช่น ("2026-09-04", "10:00") -> 03:00Z ของวันนั้น */
export function slotStartAt(day: string, slot: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = slot.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - BKK_OFFSET_MS);
}

/** วันที่ 1 ของเดือนที่ day อยู่ เป็น "YYYY-MM-01" */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** วันที่ 1 ของเดือนถัดจากเดือนที่ day อยู่ */
export function nextMonthStart(day: string): string {
  const [y, m] = day.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** เวลาที่เดือนของ day เปิดให้จอง = วันที่ 1 เวลา openHour ตามเวลาไทย */
export function monthOpensAt(day: string, openHour: number): Date {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1, openHour, 0) - BKK_OFFSET_MS);
}

/** "2026-09-04" -> "ศุกร์ที่ 4 ก.ย. 2569" */
export function thaiDayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = TH_DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow}ที่ ${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

/** "2026-09-04" -> "ศ. 4 ก.ย." — ใช้บนชิปเลือกวันที่ที่แคบ */
export function thaiDayChip(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = TH_DOW_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow} ${d} ${TH_MONTHS[m - 1]}`;
}

/**
 * รอบเวลาแบบเต็ม "10:00" -> "10.00-10.30"
 *
 * ใช้จุดคั่นชั่วโมงกับนาทีตามที่เขียนกันในเอกสารภาษาไทย ไม่ใช่ทวิภาคแบบนาฬิกาดิจิทัล
 * ค่าที่เก็บในฐานข้อมูลยังเป็น TIME ปกติ (10:00) เปลี่ยนแค่ตอนแสดงผล
 */
export function slotLabel(slot: string): string {
  const [hh, mm] = slot.split(":").map(Number);
  const end = hh * 60 + mm + SLOT_MINUTES;
  const dot = (h: number, m: number) => `${String(h).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
  return `${dot(hh, mm)}-${dot(Math.floor(end / 60), end % 60)}`;
}

/** วันศุกร์ทุกวันของเดือนที่ day อยู่ (ยังไม่ตัดวันหยุด) */
export function serviceDaysOfMonth(day: string): string[] {
  const [y, m] = day.split("-").map(Number);
  const out: string[] = [];
  const cur = new Date(Date.UTC(y, m - 1, 1));
  while (cur.getUTCMonth() === m - 1) {
    // getUTCDay(): อาทิตย์=0 … ศุกร์=5 ตรงกับ ISO เฉพาะจันทร์-เสาร์ ซึ่งครอบคลุมวันศุกร์อยู่แล้ว
    if (cur.getUTCDay() === SERVICE_ISODOW) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// ───────────────────────── ค่าตั้งของระบบ ─────────────────────────

async function settings(): Promise<Map<string, string>> {
  const rows = await db()<{ key: string; value: string }[]>`
    SELECT key, value FROM app_settings WHERE key LIKE 'massage.%'
  `;
  return new Map(rows.map((r) => [r.key, r.value]));
}

function openHourOf(s: Map<string, string>): number {
  const raw = Number(s.get("massage.open_hour"));
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : DEFAULT_OPEN_HOUR;
}

/**
 * เดือนแรกที่เปิดให้จอง ("YYYY-MM") · คืน null เมื่อไม่ได้ตั้งไว้ = เปิดตั้งแต่เดือนไหนก็ได้
 *
 * มีไว้ใช้ตอนขึ้นระบบใหม่ ถ้าเปลี่ยนระบบกลางเดือน เดือนนั้นจะเหลือวันศุกร์แค่วันสองวัน
 * ซึ่งไม่พอให้ทุกคนได้ใช้สิทธิ์ และทำให้เดือนแรกดูเหมือนระบบมีคิวน้อยผิดปกติ
 */
function startMonthOf(s: Map<string, string>): string | null {
  const raw = (s.get("massage.start_month") ?? "").trim();
  return /^\d{4}-\d{2}$/.test(raw) ? raw : null;
}

/** เดือนของวันนี้ยังไม่ถึงเดือนแรกที่เปิดจองหรือไม่ */
function beforeStartMonth(day: string, start: string | null): boolean {
  return start !== null && day.slice(0, 7) < start;
}

/** ฝ่ายที่ดูแลคิวนวดหน้างาน ถ้าไม่ได้ตั้งไว้ใน app_settings */
export const DEFAULT_STAFF_DEPT = "ADM";

/**
 * ใครเปิดฟอร์มเช็คชื่อและกด มา/ไม่มา ได้
 *
 * ฝ่ายบุคคลได้เสมอ (เป็นผู้ดูแลระบบอยู่แล้ว) ส่วนคนที่อยู่หน้างานจริงมักเป็นฝ่ายธุรการ
 * จึงเปิดให้สมาชิกของฝ่ายที่ตั้งไว้ใน app_settings ด้วย — เก็บเป็นค่าตั้งไม่ใช่ค่าคงที่ในโค้ด
 * เพราะถ้าวันหนึ่งย้ายงานนี้ไปฝ่ายอื่น จะได้เปลี่ยนได้โดยไม่ต้อง deploy ใหม่
 */
export async function assertMassageStaff(s: Session): Promise<void> {
  requireActive(s);
  if (s.isAdmin) return;
  const code = (await settings()).get("massage.staff_dept") ?? DEFAULT_STAFF_DEPT;
  if (s.deptRoles.some((r) => r.code === code)) return;
  throw new HttpError(403, "เฉพาะผู้ดูแลคิวนวดเท่านั้น");
}

// ───────────────────────── สร้างวันให้บริการของเดือน ─────────────────────────

/**
 * สร้างแถวใน massage_days สำหรับวันศุกร์ของเดือนที่ day อยู่ ข้ามวันที่ตรงกับวันหยุด
 *
 * เรียกได้ทั้งจากงานตามเวลาของวันที่ 1 และจากตัวหน้าจองเอง — เขียนแบบสั่งซ้ำได้ไม่พัง
 * ให้หน้าจองเรียกได้ด้วยเพราะถ้างานตามเวลาล้มเหลว ทั้งเดือนจะไม่มีวันให้จองเลย
 * ซึ่งเป็นความเสียหายที่ใหญ่กว่าการยอมให้คำขอแรกของเดือนช้าไปหนึ่งคำสั่ง
 *
 * วันที่ถูกปิดด้วยมือไปแล้วจะไม่ถูกเปิดกลับ (ON CONFLICT DO NOTHING)
 */
export async function ensureMonthDays(day: string): Promise<string[]> {
  // เดือนที่ยังไม่ถึงกำหนดเปิด ไม่ต้องสร้างวันไว้ให้รก
  if (beforeStartMonth(day, startMonthOf(await settings()))) return [];

  const candidates = serviceDaysOfMonth(day);
  if (candidates.length === 0) return [];

  const sql = db();
  const holidays = await sql<{ day: string }[]>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day FROM company_holidays WHERE day = ANY(${candidates}::date[])
  `;
  const skip = new Set(holidays.map((h) => h.day));
  const wanted = candidates.filter((d) => !skip.has(d));
  if (wanted.length === 0) return [];

  await sql`
    INSERT INTO massage_days (day)
    SELECT unnest(${wanted}::date[])
    ON CONFLICT (day) DO NOTHING
  `;
  return wanted;
}

// ───────────────────────── สถานะของระบบ ─────────────────────────

export interface DaySummary {
  day: string;
  label: string;
  chip: string;
  free: number;
  total: number;
  /** true = วันนี้เข้าโหมดคิวด่วนแล้ว จองได้โดยไม่นับสิทธิ์ */
  flash: boolean;
}

export interface MassageState {
  open: boolean;
  /** manual = ปิดด้วยมือ · not_yet = ยังไม่ถึงเวลาเปิดของวันที่ 1 · full = ไม่เหลือคิวว่าง */
  reason?: "manual" | "not_yet" | "full";
  /** เวลาที่จะเปิด (ISO) มีเมื่อ reason เป็น not_yet หรือ full */
  opensAt?: string;
  days: DaySummary[];
  used: number;
  quota: number;
}

/**
 * สถานะที่หน้าจองต้องรู้ทั้งหมดในคำขอเดียว
 *
 * "ปิด" ในที่นี้หมายถึงปิดรับ *การจองใหม่* เท่านั้น หน้าคิวของฉันและปุ่มยกเลิกยังทำงาน
 * ระบบเดิมสลับ endpoint ของ LIFF ไปหน้าปิดทั้งหน้า คนที่จองไว้แล้วจึงยกเลิกไม่ได้เลย
 */
export async function massageState(employeeId: string, now = new Date()): Promise<MassageState> {
  const sql = db();
  const cfg = await settings();
  const today = bangkokDate(now);
  const quota = { used: await monthlyUsage(employeeId, today), quota: MONTHLY_QUOTA };

  if (cfg.get("massage.enabled") === "false") {
    return { open: false, reason: "manual", days: [], ...quota };
  }

  const openHour = openHourOf(cfg);
  const start = startMonthOf(cfg);

  // ยังไม่ถึงเดือนแรกที่เปิดให้จอง — บอกวันเวลาที่จะเปิดไปเลย
  if (beforeStartMonth(today, start)) {
    const at = monthOpensAt(`${start}-01`, openHour);
    return { open: false, reason: "not_yet", opensAt: at.toISOString(), days: [], ...quota };
  }

  const opensAt = monthOpensAt(today, openHour);
  if (now < opensAt) {
    return { open: false, reason: "not_yet", opensAt: opensAt.toISOString(), days: [], ...quota };
  }

  await ensureMonthDays(today);

  const therapists = await activeTherapists();
  const rows = await sql<{ day: string; taken: number }[]>`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
           count(b.id) FILTER (WHERE b.status = 'booked')::int AS taken
    FROM massage_days d
    LEFT JOIN massage_bookings b ON b.day = d.day
    WHERE d.status = 'open' AND d.day >= ${today}::date AND d.day < ${nextMonthStart(today)}::date
    GROUP BY d.day
    ORDER BY d.day
  `;

  const days: DaySummary[] = rows.map((r) => {
    // รอบที่เลยเส้นตัดไปแล้วจองไม่ได้ จึงไม่นับเป็นที่ว่าง — สำคัญเฉพาะกับ "วันนี้"
    const bookable = MASSAGE_SLOTS.filter((s) => isBookableSlot(r.day, s, now)).length;
    const total = bookable * therapists.length;
    return {
      day: r.day,
      label: thaiDayLabel(r.day),
      chip: thaiDayChip(r.day),
      free: Math.max(0, total - r.taken),
      total,
      flash: isFlashDay(r.day, now),
    };
  });

  const usable = days.filter((d) => d.free > 0);
  if (usable.length === 0) {
    const next = monthOpensAt(nextMonthStart(today), openHour);
    return { open: false, reason: "full", opensAt: next.toISOString(), days: [], ...quota };
  }

  return { open: true, days: usable, ...quota };
}

/** เวลาที่วันนั้นเปลี่ยนเป็นคิวด่วน — 15:00 ของวันก่อนหน้า ตามเวลาไทย */
export function flashOpensAt(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - FLASH_LEAD_DAYS, FLASH_FROM_HOUR, 0) - BKK_OFFSET_MS);
}

/** วันนี้อยู่ในช่วงคิวด่วนแล้วหรือยัง */
export function isFlashDay(day: string, now = new Date()): boolean {
  return now.getTime() >= flashOpensAt(day).getTime();
}

/** รอบนี้ยังจองได้ไหมเมื่อเทียบกับเวลาปัจจุบัน (ต้องเหลือมากกว่า 15 นาที) */
export function isBookableSlot(day: string, slot: string, now = new Date()): boolean {
  return slotStartAt(day, slot).getTime() - now.getTime() > CUTOFF_MINUTES * 60_000;
}

// ───────────────────────── หมอนวด ─────────────────────────

export interface Therapist {
  id: string;
  name: string;
  gender: string | null;
}

export async function activeTherapists(): Promise<Therapist[]> {
  const rows = await db()<Therapist[]>`
    SELECT id, name, gender FROM massage_therapists
    WHERE is_active = true ORDER BY sort_order, name
  `;
  return [...rows];
}

// ───────────────────────── คิวว่างของวันหนึ่ง ─────────────────────────

export interface SlotCell {
  therapistId: string;
  /** true = มีคนจองแล้ว ไม่ว่าจะเป็นใคร */
  taken: boolean;
  /** true = คิวนี้เป็นของผู้ที่กำลังถามเอง (ให้หน้าจอไฮไลต์ได้) */
  mine: boolean;
}

export interface SlotRow {
  slot: string;
  label: string;
  /** false = รอบนี้เลยเวลาไปแล้ว จองไม่ได้แม้ยังว่าง */
  bookable: boolean;
  cells: SlotCell[];
}

export interface DayAvailability {
  day: string;
  label: string;
  therapists: Therapist[];
  rows: SlotRow[];
  /** true = วันนี้เข้าโหมดคิวด่วนแล้ว */
  flash: boolean;
}

/**
 * ตารางคิวว่างของวันหนึ่ง
 *
 * **ห้ามใส่ชื่อคนอื่นลงในผลลัพธ์ของฟังก์ชันนี้เด็ดขาด**
 *
 * ระบบเดิมส่งทุกแถวในตารางการจองกลับไปที่เบราว์เซอร์ (flow CheckSchedule ดึงทั้งตาราง
 * โดยไม่กรองอะไรเลย) พนักงานทุกคนที่เปิดหน้าจองจึงโหลดชื่อ นามสกุล แผนก อีเมล และ
 * LINE userId ของทุกคนที่เคยจองลงเครื่องตัวเอง หน้าจอต้องการรู้แค่ "ว่างหรือไม่ว่าง"
 * เท่านั้น จึงส่งไปแค่นั้น ชื่อจริงมีอยู่ที่เดียวคือฟอร์มเช็คชื่อซึ่งเปิดได้เฉพาะผู้ดูแล
 */
export async function dayAvailability(
  day: string,
  employeeId: string,
  now = new Date(),
): Promise<DayAvailability> {
  const sql = db();

  const open = await sql<{ day: string }[]>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day FROM massage_days
    WHERE day = ${day}::date AND status = 'open'
  `;
  if (open.length === 0) throw new HttpError(404, "วันนี้ไม่ได้เปิดให้บริการ");

  const therapists = await activeTherapists();
  const booked = await sql<{ slot: string; therapist_id: string; employee_id: string }[]>`
    SELECT to_char(slot_start, 'HH24:MI') AS slot, therapist_id, employee_id
    FROM massage_bookings
    WHERE day = ${day}::date AND status = 'booked'
  `;

  const takenBy = new Map(booked.map((b) => [`${b.slot}|${b.therapist_id}`, b.employee_id]));

  return {
    day,
    label: thaiDayLabel(day),
    flash: isFlashDay(day, now),
    therapists,
    rows: MASSAGE_SLOTS.map((slot) => ({
      slot,
      label: slotLabel(slot),
      bookable: isBookableSlot(day, slot, now),
      cells: therapists.map((t) => {
        const owner = takenBy.get(`${slot}|${t.id}`);
        return { therapistId: t.id, taken: owner !== undefined, mine: owner === employeeId };
      }),
    })),
  };
}

// ───────────────────────── สิทธิ์รายเดือน ─────────────────────────

/** ใช้สิทธิ์ไปกี่ครั้งแล้วในเดือนที่ day อยู่ (นับเฉพาะคิวที่ยังไม่ถูกยกเลิก) */
/** สิทธิ์ที่ใช้ไปในเดือนนั้น — นับเฉพาะคิวสิทธิ์ คิวด่วนไม่นับ */
export async function monthlyUsage(employeeId: string, day: string): Promise<number> {
  const rows = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM massage_bookings
    WHERE employee_id = ${employeeId} AND status = 'booked' AND kind = 'quota'
      AND day >= ${monthStart(day)}::date AND day < ${nextMonthStart(day)}::date
  `;
  return rows[0]?.n ?? 0;
}

// ───────────────────────── จองคิว ─────────────────────────

export interface BookInput {
  employeeId: string;
  day: string;
  slot: string;
  therapistId: string;
}

export interface BookedRow {
  id: string;
  day: string;
  slot: string;
  therapistName: string;
  /** true = คิวด่วน ไม่นับสิทธิ์ และพนักงานยกเลิกเองไม่ได้ */
  flash: boolean;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

function violatedConstraint(e: unknown): string {
  return typeof e === "object" && e !== null
    ? String((e as { constraint_name?: string }).constraint_name ?? "")
    : "";
}

/**
 * จองคิว
 *
 * ทุกอย่างอยู่ใน transaction เดียว และเริ่มด้วยการล็อกแถวพนักงาน เพราะการนับสิทธิ์
 * ("จองไปกี่ครั้งแล้วเดือนนี้") เป็นการอ่านที่ไม่ล็อกอะไรเลยโดยตัวมันเอง — ถ้าคนคนเดียว
 * กดจากสองเครื่องพร้อมกัน ทั้งสองคำขอจะอ่านได้เลข 1 เท่ากันแล้วเขียนเพิ่มทั้งคู่เป็น 3 ครั้ง
 * การล็อกแถวพนักงานทำให้คำขอที่สองต้องรอ แล้วอ่านเลขที่ถูกต้องหลังคำขอแรกเขียนเสร็จ
 *
 * ส่วนคิวชนกันระหว่าง *คนละคน* กันด้วยดัชนีไม่ซ้ำในฐานข้อมูล ไม่ใช่ด้วยการอ่านมาเช็คก่อน
 * เพราะระหว่าง "อ่านว่าว่าง" กับ "เขียน" มีช่องว่างเสมอ ไม่ว่าจะเขียนโค้ดดีแค่ไหน
 */
export async function book(input: BookInput, now = new Date()): Promise<BookedRow> {
  const { employeeId, day, slot, therapistId } = input;
  const flash = isFlashDay(day, now);

  if (!MASSAGE_SLOTS.includes(slot as (typeof MASSAGE_SLOTS)[number])) {
    throw new HttpError(400, "รอบเวลาไม่ถูกต้อง");
  }
  if (!isBookableSlot(day, slot, now)) {
    throw new HttpError(409, `รอบนี้เริ่มในอีกไม่ถึง ${CUTOFF_MINUTES} นาที จองไม่ทันแล้ว`);
  }

  const cfg = await settings();
  if (cfg.get("massage.enabled") === "false") {
    throw new HttpError(409, "ระบบจองปิดให้บริการชั่วคราว");
  }
  if (beforeStartMonth(day, startMonthOf(cfg)) || now < monthOpensAt(day, openHourOf(cfg))) {
    throw new HttpError(409, "ยังไม่ถึงเวลาเปิดจองของเดือนนี้");
  }

  try {
    return await db().begin(async (sql) => {
      // ล็อกแถวพนักงานก่อนอ่านจำนวนสิทธิ์ที่ใช้ไป — ดูคำอธิบายด้านบน
      const emp = await sql<{ id: string }[]>`
        SELECT id FROM employees WHERE id = ${employeeId} FOR UPDATE
      `;
      if (emp.length === 0) throw new HttpError(403, "ไม่พบข้อมูลพนักงาน");

      const dayRow = await sql<{ day: string }[]>`
        SELECT day FROM massage_days WHERE day = ${day}::date AND status = 'open'
      `;
      if (dayRow.length === 0) throw new HttpError(409, "วันนี้ไม่ได้เปิดให้บริการ");

      const th = await sql<{ name: string }[]>`
        SELECT name FROM massage_therapists WHERE id = ${therapistId} AND is_active = true
      `;
      if (th.length === 0) throw new HttpError(409, "หมอนวดท่านนี้ไม่ได้เปิดรับคิว");

      // วันที่เข้าโหมดคิวด่วนแล้วไม่ต้องเช็คสิทธิ์ — เป็นของเหลือที่ถ้าไม่มีใครจองก็เสียเปล่า
      if (!flash) {
        const used = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM massage_bookings
          WHERE employee_id = ${employeeId} AND status = 'booked' AND kind = 'quota'
            AND day >= ${monthStart(day)}::date AND day < ${nextMonthStart(day)}::date
        `;
        if ((used[0]?.n ?? 0) >= MONTHLY_QUOTA) {
          throw new HttpError(409, `เดือนนี้ใช้สิทธิ์ครบ ${MONTHLY_QUOTA} ครั้งแล้ว`, "quota_used");
        }
      }

      // วันละคิวเดียว — เช็คตรงนี้เพื่อให้ได้ข้อความที่บอกสาเหตุชัด ๆ ส่วนการกันจริง
      // เมื่อกดพร้อมกันสองเครื่องอยู่ที่ดัชนี uq_massage_person_day ในฐานข้อมูล
      const sameDay = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM massage_bookings
        WHERE employee_id = ${employeeId} AND status = 'booked' AND day = ${day}::date
      `;
      if ((sameDay[0]?.n ?? 0) >= DAILY_LIMIT) {
        throw new HttpError(409, "วันนี้คุณจองไว้แล้ว 1 คิว จองได้วันละคิวเดียว", "same_day");
      }

      const ins = await sql<{ id: string }[]>`
        INSERT INTO massage_bookings (day, slot_start, therapist_id, employee_id, kind)
        VALUES (${day}::date, ${slot}::time, ${therapistId}, ${employeeId}, ${flash ? "flash" : "quota"})
        RETURNING id
      `;
      return { id: ins[0].id, day, slot, therapistName: th[0].name, flash };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // แยกสองกรณีให้ชัด เพราะสิ่งที่ผู้ใช้ต้องทำต่อไม่เหมือนกัน
      if (violatedConstraint(e) === "uq_massage_person_day") {
        throw new HttpError(409, "วันนี้คุณจองไว้แล้ว 1 คิว จองได้วันละคิวเดียว", "same_day");
      }
      throw new HttpError(409, "คิวนี้เพิ่งถูกจองไปเมื่อสักครู่ กรุณาเลือกรอบอื่น", "slot_taken");
    }
    throw e;
  }
}

// ───────────────────────── ยกเลิกคิว ─────────────────────────

export interface CancelledRow {
  day: string;
  slot: string;
  therapistName: string;
}

/**
 * ยกเลิกคิว
 *
 * ต้องเป็นเจ้าของคิวเท่านั้น — ระบบเดิมรับมาแค่ eventId แล้วลบทันทีโดยไม่ตรวจว่าใครสั่ง
 * ปุ่มยกเลิกบนการ์ดพา eventId ไปในลิงก์ ใครส่งต่อการ์ดให้เพื่อนดู เพื่อนก็กดยกเลิกได้
 *
 * ไม่ลบแถว เปลี่ยนสถานะแทน เพื่อให้ยังตอบได้ว่าใครยกเลิกกระชั้นบ่อย
 * ดัชนีไม่ซ้ำเป็นแบบมีเงื่อนไข (WHERE status = 'booked') คิวที่ยกเลิกแล้วจึงไม่กินที่
 */
export async function cancel(
  bookingId: string,
  employeeId: string,
  now = new Date(),
): Promise<CancelledRow> {
  const sql = db();

  const rows = await sql<
    { id: string; day: string; slot: string; employee_id: string; status: string;
      kind: string; name: string }[]
  >`
    SELECT b.id, to_char(b.day, 'YYYY-MM-DD') AS day, to_char(b.slot_start, 'HH24:MI') AS slot,
           b.employee_id, b.status, b.kind, t.name
    FROM massage_bookings b
    JOIN massage_therapists t ON t.id = b.therapist_id
    WHERE b.id = ${bookingId}
  `;
  if (rows.length === 0) throw new HttpError(404, "ไม่พบคิวนี้ในระบบ");

  const b = rows[0];
  // ตอบเหมือนกันกับกรณีไม่พบ เพื่อไม่ให้เดาได้ว่า id ไหนมีอยู่จริง
  if (b.employee_id !== employeeId) throw new HttpError(404, "ไม่พบคิวนี้ในระบบ");
  if (b.status !== "booked") throw new HttpError(409, "คิวนี้ถูกยกเลิกไปแล้ว", "already_cancelled");

  // คิวด่วนยกเลิกเองไม่ได้ตามกติกา — ฝ่ายบุคคลยังยกเลิกหรือเปลี่ยนคนจองให้ได้จากฟอร์มเช็คชื่อ
  // ถ้าปล่อยให้ยกเลิกเองได้ กติกา "กดแล้วต้องมา" จะไม่มีผลอะไรเลย
  if (b.kind === "flash") {
    throw new HttpError(
      409,
      "คิวด่วนยกเลิกในระบบไม่ได้ หากมาไม่ได้ กรุณาหาคนมาแทนแล้วแจ้งฝ่ายบุคคล",
      "flash_no_cancel",
    );
  }

  const left = slotStartAt(b.day, b.slot).getTime() - now.getTime();
  if (left <= CUTOFF_MINUTES * 60_000) {
    throw new HttpError(
      409,
      `ยกเลิกได้ถึงก่อนรอบเริ่ม ${CUTOFF_MINUTES} นาทีเท่านั้น`,
      "too_late",
    );
  }

  await sql`
    UPDATE massage_bookings
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${employeeId}, updated_at = now()
    WHERE id = ${bookingId} AND status = 'booked'
  `;
  return { day: b.day, slot: b.slot, therapistName: b.name };
}

// ───────────────────────── ผู้ดูแลจัดการคิวแทนพนักงาน ─────────────────────────
//
// ผู้ดูแลหน้างานต้องแก้คิวแทนได้จริง เช่น พนักงานโทรมาบอกว่ามาไม่ได้ หรือขอย้ายรอบ
// ถ้าไม่มีทางแก้ ช่องนั้นจะค้างเป็น "จองแล้ว" ทั้งที่ไม่มีใครมา และไม่มีใครจองแทนได้
//
// ต่างจากการยกเลิกของเจ้าตัวสองข้อ: ไม่ดูเส้นตัด 15 นาที (ผู้ดูแลยืนอยู่หน้างานจริง
// ย่อมรู้สถานการณ์ดีกว่ากติกา) และจดไว้ว่าใครเป็นคนสั่ง จะได้ตามย้อนหลังได้ว่าใครแก้

export interface AdminBookingRow {
  id: string;
  day: string;
  slot: string;
  therapistId: string;
  therapistName: string;
  employeeId: string;
  name: string;
}

async function loadBooking(bookingId: string): Promise<AdminBookingRow> {
  const rows = await db()<
    { id: string; day: string; slot: string; therapist_id: string; therapist_name: string;
      employee_id: string; status: string; full_name: string }[]
  >`
    SELECT b.id, to_char(b.day, 'YYYY-MM-DD') AS day, to_char(b.slot_start, 'HH24:MI') AS slot,
           b.therapist_id, t.name AS therapist_name, b.employee_id, b.status, e.full_name
    FROM massage_bookings b
    JOIN employees e ON e.id = b.employee_id
    JOIN massage_therapists t ON t.id = b.therapist_id
    WHERE b.id = ${bookingId}
  `;
  if (rows.length === 0) throw new HttpError(404, "ไม่พบคิวนี้ในระบบ");
  const b = rows[0];
  if (b.status !== "booked") throw new HttpError(409, "คิวนี้ถูกยกเลิกไปแล้ว", "already_cancelled");
  return {
    id: b.id, day: b.day, slot: b.slot,
    therapistId: b.therapist_id, therapistName: b.therapist_name,
    employeeId: b.employee_id, name: b.full_name,
  };
}

/**
 * ผู้ดูแลเปลี่ยนชื่อผู้จองของคิวหนึ่ง
 *
 * มีเพื่อรองรับกติกาของคิวด่วนที่ว่า "มาไม่ได้ให้หาคนมาแทนแล้วแจ้งฝ่ายบุคคล"
 * ถ้าไม่มีเส้นทางนี้ ฝ่ายบุคคลต้องยกเลิกแล้วให้คนใหม่กดจองเอง ซึ่งคนอื่นตัดหน้าได้
 * กลายเป็นว่าระบบผิดสัญญาที่ตัวเองบอกไว้
 *
 * ไม่แตะสิทธิ์ของทั้งสองฝ่าย เพราะคิวด่วนไม่นับสิทธิ์อยู่แล้ว ส่วนคิวสิทธิ์ที่เปลี่ยนคน
 * จะย้ายภาระสิทธิ์ไปที่คนใหม่เองเมื่อคำนวณครั้งถัดไป (นับจากแถวที่มีอยู่จริง)
 */
export async function adminReassign(
  bookingId: string,
  toEmployeeId: string,
): Promise<AdminBookingRow & { toName: string }> {
  const b = await loadBooking(bookingId);
  const sql = db();

  const to = await sql<{ id: string; full_name: string; status: string }[]>`
    SELECT id, full_name, status FROM employees WHERE id = ${toEmployeeId}
  `;
  if (to.length === 0) throw new HttpError(404, "ไม่พบพนักงานคนนี้");
  if (to[0].status === "suspended") throw new HttpError(409, "พนักงานคนนี้ถูกระงับสิทธิ์อยู่");
  if (to[0].id === b.employeeId) return { ...b, toName: to[0].full_name };

  try {
    await sql`
      UPDATE massage_bookings SET employee_id = ${toEmployeeId}, updated_at = now()
      WHERE id = ${bookingId} AND status = 'booked'
    `;
  } catch (e) {
    // ดัชนี uq_massage_person_day กันไว้ — คนใหม่มีคิวของวันนั้นอยู่แล้ว
    if (isUniqueViolation(e)) {
      throw new HttpError(409, "คนที่จะเปลี่ยนไปมีคิวของวันนี้อยู่แล้ว", "same_day");
    }
    throw e;
  }
  return { ...b, toName: to[0].full_name };
}

/** ผู้ดูแลยกเลิกคิวของพนักงาน — ช่องนั้นกลับมาว่างให้คนอื่นจองได้ทันที */
export async function adminCancel(
  bookingId: string,
  byEmployeeId: string,
  reason = "ผู้ดูแลยกเลิกให้",
): Promise<AdminBookingRow> {
  const b = await loadBooking(bookingId);
  await db()`
    UPDATE massage_bookings
    SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${byEmployeeId},
        cancel_reason = ${reason.slice(0, 120)}, updated_at = now()
    WHERE id = ${bookingId} AND status = 'booked'
  `;
  return b;
}

/**
 * ผู้ดูแลย้ายคิวไปรอบอื่นหรือหมอนวดคนอื่น "ภายในวันเดิม"
 *
 * ไม่ให้ย้ายข้ามวัน เพราะกติกาสิทธิ์ต่อเดือนกับวันละหนึ่งคิวผูกกับวัน ถ้าย้ายข้ามวันได้
 * จะต้องไปนับสิทธิ์ใหม่ทั้งชุด และมีโอกาสทำให้คนนั้นมีสองคิวในวันเดียวโดยไม่ตั้งใจ
 * ผู้ดูแลที่อยากย้ายข้ามวันให้ยกเลิกแล้วให้เจ้าตัวจองใหม่ ซึ่งตรงไปตรงมากว่า
 */
export async function adminMove(
  bookingId: string,
  slot: string,
  therapistId: string,
): Promise<AdminBookingRow> {
  if (!MASSAGE_SLOTS.includes(slot as (typeof MASSAGE_SLOTS)[number])) {
    throw new HttpError(400, "รอบเวลาไม่ถูกต้อง", "bad_slot");
  }
  const b = await loadBooking(bookingId);
  const therapists = await activeTherapists();
  if (!therapists.some((t) => t.id === therapistId)) {
    throw new HttpError(400, "ไม่พบหมอนวดคนนี้", "bad_therapist");
  }
  if (b.slot === slot && b.therapistId === therapistId) return b;

  try {
    await db()`
      UPDATE massage_bookings
      SET slot_start = ${slot}::time, therapist_id = ${therapistId}, updated_at = now(),
          remind_eve_at = NULL, remind_soon_at = NULL
      WHERE id = ${bookingId} AND status = 'booked'
    `;
  } catch (e) {
    // ดัชนีของฐานข้อมูลเป็นตัวกันช่องซ้ำ ไม่ใช่การเช็คก่อนเขียน เพราะสองคำขอที่มาพร้อมกัน
    // จะผ่านการเช็คทั้งคู่แล้วเขียนทับกัน
    if (isUniqueViolation(e)) throw new HttpError(409, "ช่องนี้มีคนจองแล้ว", "slot_taken");
    throw e;
  }
  const moved = therapists.find((t) => t.id === therapistId);
  return { ...b, slot, therapistId, therapistName: moved ? moved.name : b.therapistName };
}

// ───────────────────────── คิวของฉัน ─────────────────────────

export interface MyBooking {
  id: string;
  day: string;
  dayLabel: string;
  slot: string;
  slotLabel: string;
  therapistName: string;
  status: string;
  /** true = คิวด่วน ยกเลิกเองไม่ได้ */
  flash: boolean;
  /** ยกเลิกได้อยู่ไหม ณ ตอนนี้ */
  cancellable: boolean;
  past: boolean;
}

/** คิวของคนคนหนึ่งในเดือนที่ day อยู่ เรียงจากใกล้ที่สุด (รวมที่ยกเลิกไปแล้วด้วย) */
export async function myBookings(
  employeeId: string,
  now = new Date(),
): Promise<MyBooking[]> {
  const today = bangkokDate(now);
  const rows = await db()<
    { id: string; day: string; slot: string; status: string; kind: string; name: string }[]
  >`
    SELECT b.id, to_char(b.day, 'YYYY-MM-DD') AS day, to_char(b.slot_start, 'HH24:MI') AS slot,
           b.status, b.kind, t.name
    FROM massage_bookings b
    JOIN massage_therapists t ON t.id = b.therapist_id
    WHERE b.employee_id = ${employeeId}
      AND b.day >= ${monthStart(today)}::date AND b.day < ${nextMonthStart(today)}::date
    ORDER BY b.day, b.slot_start
  `;

  return rows.map((r) => {
    const startsIn = slotStartAt(r.day, r.slot).getTime() - now.getTime();
    return {
      id: r.id,
      day: r.day,
      dayLabel: thaiDayLabel(r.day),
      slot: r.slot,
      slotLabel: slotLabel(r.slot),
      therapistName: r.name,
      status: r.status,
      flash: r.kind === "flash",
      cancellable:
        r.status === "booked" && r.kind !== "flash" && startsIn > CUTOFF_MINUTES * 60_000,
      past: startsIn <= 0,
    };
  });
}
