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

import type postgres from "postgres";
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
 * เพดานสิทธิ์ที่ผู้ดูแลปรับให้ได้ต่อคนต่อเดือน
 *
 * มีไว้กันนิ้วพลาด ไม่ใช่กันเจตนา — ปุ่มเพิ่มสิทธิ์กดรัวได้ ถ้าไม่มีเพดาน กดค้างไว้
 * แล้วเผลอ จะได้คนที่จองได้ทั้งเดือนโดยไม่มีใครสังเกต
 */
export const QUOTA_MAX = 10;

/**
 * รหัสพนักงานเงาที่ผู้ดูแลใช้ล็อกช่องเก็บไว้ก่อน
 *
 * ผู้ดูแลบางครั้งต้องกันช่องไว้ล่วงหน้าโดยยังไม่รู้ว่าจะให้ใคร (เช่นกันไว้ให้ผู้บริหาร
 * หรือกันไม่ให้คนจองระหว่างที่ยังตกลงกันไม่จบ) เดิมทำไม่ได้เลย ต้องยืมชื่อคนจริงไปก่อน
 * แล้วสิทธิ์ของคนนั้นถูกหักทั้งที่ไม่ได้นวด
 *
 * ช่องที่ล็อกไว้บันทึกเป็น kind = 'hold' จึงไม่นับสิทธิ์ใคร และไม่ติดกติกาวันละคิวเดียว
 * พอรู้ตัวคนจริงแล้วใช้ปุ่ม "เปลี่ยนคนจอง" โอนให้ ตอนนั้นถึงจะนับสิทธิ์ตามปกติ
 */
export const STAFF_CODE = "00000";

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
 * ตั้งแต่ 15:00 ของวันก่อนหน้าวันให้บริการ วันนั้นจะเข้า "โหมดคิวด่วน" ยาวไปจนหมดวัน
 * ช่องที่มีคนยกเลิกระหว่างวันจึงกลับเข้าคิวด่วนได้เองโดยไม่ต้องมีกลไกแยก
 * — เป็นเหตุผลที่เลือกวิธีนี้แทนการเปิดเป็นช่วงสั้น ๆ
 *
 * แต่โหมดคิวด่วน *ไม่ได้* ใช้กับทุกคน ดูที่ isFlashFor
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
export async function ensureMonthDays(day: string, force = false): Promise<string[]> {
  // เดือนที่ยังไม่ถึงกำหนดเปิด ไม่ต้องสร้างวันไว้ให้รก
  // ยกเว้นผู้ดูแลเปิดหน้าจัดการวันของเดือนนั้นเอง = ตั้งใจมาดูอยู่แล้ว ต้องเห็นวันครบ
  if (!force && beforeStartMonth(day, startMonthOf(await settings()))) return [];

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
  /** true = คนที่ถามมาจะได้คิวด่วนถ้าจองวันนี้ (สิทธิ์หมดแล้ว + วันนี้เข้าโหมดคิวด่วนแล้ว) */
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
  const quota = { used: await monthlyUsage(employeeId, today), quota: await quotaOf(employeeId, today) };

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
      flash: isFlashFor(r.day, quota.used, quota.quota, now),
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

/**
 * คิวที่กดในวันนี้จะกลายเป็น "คิวด่วน" สำหรับคนคนนี้หรือไม่
 *
 * คิวด่วนมีไว้เก็บของเหลือ ไม่ใช่ทางลัด คนที่สิทธิ์ยังไม่หมดจึงไม่เข้าโหมดนี้ —
 * ถ้าให้เข้าได้ทุกคน จะไม่มีใครจองตามสิทธิ์ตั้งแต่ต้นสัปดาห์ ทุกคนจะรอมากดวันสุดท้ายพร้อมกัน
 * คิวช่วงต้นก็ว่างยกแผงและเสียเปล่าเหมือนเดิม ซึ่งตรงข้ามกับสิ่งที่ฟีเจอร์นี้ตั้งใจแก้
 *
 * คนที่สิทธิ์ยังเหลือกดจองในวันที่เข้าโหมดคิวด่วนได้ตามปกติ แต่นับเป็นคิวสิทธิ์
 * และยกเลิกได้ตามเดิม เท่ากับวันนั้นเป็นวันธรรมดาวันหนึ่งสำหรับเขา
 */
export function isFlashFor(day: string, used: number, quota: number, now = new Date()): boolean {
  return used >= quota && isFlashDay(day, now);
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
  /** true = คนที่ถามมาจะได้คิวด่วนถ้าจองวันนี้ — ดู isFlashFor */
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
    flash: isFlashFor(day, await monthlyUsage(employeeId, day), await quotaOf(employeeId, day), now),
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

/** สิทธิ์ที่ใช้ไปในเดือนที่ day อยู่ — นับตามกติกาเดียวใน usedQuotaRule */
export async function monthlyUsage(employeeId: string, day: string): Promise<number> {
  return await usedQuotaIn(db(), employeeId, day);
}

/**
 * ค่าที่ใช้แทน "ทุกเดือน" ในคอลัมน์ month ของ massage_quota_extra
 *
 * สิทธิ์ที่ให้ถาวรต้องอยู่ตารางเดียวกับสิทธิ์รายเดือน ไม่งั้นทุกที่ที่นับสิทธิ์ต้องอ่านสองตาราง
 * แล้ววันหนึ่งจะมีที่ที่ลืมอ่านตารางที่สอง กลายเป็นตัวเลขบนหน้าจอกับตอนกดจองไม่ตรงกัน
 *
 * ใช้ '0000-00' เพราะยาว 7 ตัวพอดีกับคอลัมน์เดิม และไม่มีวันตรงกับเดือนจริง
 * จึงไม่ต้องแก้โครงตาราง — ฐานข้อมูลที่รัน db/massage-quota-extra.sql ไปแล้วใช้ได้ทันที
 */
export const PERMANENT_MONTH = "0000-00";

/**
 * เงื่อนไข "คิวนี้นับว่าใช้สิทธิ์ไปแล้ว" — กติกาข้อเดียวที่ทุกที่ต้องใช้ร่วมกัน
 *
 * ไม่ใช่แค่ status = 'booked' เพราะมีรอยรั่วที่เกิดขึ้นจริง:
 *   เช้าวันให้บริการ เจ้าหน้าที่ปริ้นใบเช็คชื่อไปแล้ว พนักงานกดยกเลิกคิวรอบบ่ายของตัวเอง
 *   สิทธิ์เด้งกลับมาเต็ม แล้วไปจองวันอื่นต่อ — ได้นวดเกินสิทธิ์โดยที่ระบบนับว่ายังไม่ได้ใช้เลย
 *
 * เส้นแบ่งใช้เวลาเดียวกับที่วันนั้นเข้าโหมดคิวด่วน (15:00 ของวันก่อนหน้า) เพราะเป็นจังหวะ
 * ที่ "วันนั้นถูกล็อก" อยู่แล้วในระบบ ไม่ต้องเพิ่มกติกาใหม่ให้ต้องจำอีกข้อ
 *
 * นับเฉพาะที่เจ้าตัวกดยกเลิกเอง (cancelled_by = employee_id) — ผู้ดูแลยกเลิกให้
 * หรือปิดวันทั้งวัน ต้องคืนสิทธิ์ตามปกติ ไม่ใช่ลงโทษคนที่ไม่ได้ทำอะไรผิด
 *
 * ต้องใช้ชื่อตาราง b ในคิวรีที่เอาไปแปะ
 */
export function usedQuotaRule(sql: SqlLike) {
  return sql`(
    b.status = 'booked'
    OR (
      b.status = 'cancelled'
      AND b.cancelled_by = b.employee_id
      AND b.cancelled_at >= (
        (b.day - make_interval(days => ${FLASH_LEAD_DAYS}) + make_interval(hours => ${FLASH_FROM_HOUR}))
        AT TIME ZONE 'Asia/Bangkok'
      )
    )
  )`;
}

/**
 * นับสิทธิ์ที่ใช้ไปแล้วของเดือนที่ day อยู่
 *
 * ทุกที่ที่ต้องรู้ว่า "ใช้ไปกี่ครั้งแล้ว" ต้องเรียกอันนี้ ห้ามเขียนคิวรีเอง
 * ไม่งั้นกติกาข้างบนจะมีสองชุดที่ไม่ตรงกัน แล้วเลขบนหน้าจอกับตอนกดจองจะคนละเลข
 */
export async function usedQuotaIn(
  sql: SqlLike,
  employeeId: string,
  day: string,
): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM massage_bookings b
    WHERE b.employee_id = ${employeeId} AND b.kind = 'quota'
      AND b.day >= ${monthStart(day)}::date AND b.day < ${nextMonthStart(day)}::date
      AND ${usedQuotaRule(sql)}
  `;
  return rows[0]?.n ?? 0;
}

/** แปลงส่วนต่างที่ผู้ดูแลปรับไว้ ให้เป็นจำนวนสิทธิ์จริง — ไม่ติดลบ และไม่เกินเพดาน */
export function quotaFromExtra(extra: number): number {
  return Math.max(0, Math.min(QUOTA_MAX, MONTHLY_QUOTA + extra));
}

/** สิทธิ์จริงจากสองชั้นรวมกัน — ชั้นถาวร กับ ชั้นเฉพาะเดือนนี้ */
export function quotaFromExtras(permanent: number, monthly: number): number {
  return quotaFromExtra(permanent + monthly);
}

/**
 * ส่วนต่างทั้งสองชั้นของคนคนหนึ่งในเดือนหนึ่ง
 *
 * รับ sql เข้ามาเพราะบางที่เรียกจากใน transaction ที่ล็อกแถวพนักงานไว้แล้ว
 * ถ้าเปิด connection ใหม่ในนั้นจะอ่านข้ามการล็อกไป แล้วนับสิทธิ์ผิดตอนมีคนกดพร้อมกัน
 */
// รับได้ทั้ง connection ปกติและตัวที่อยู่ใน transaction — ในไลบรารีเป็นคนละชนิดกัน
// แต่สืบทอดจาก ISql ตัวเดียวกัน ซึ่งมีทุกอย่างที่ตรงนี้ใช้
type SqlLike = postgres.ISql;
export async function quotaExtras(
  sql: SqlLike,
  employeeId: string,
  month: string,
): Promise<{ permanent: number; monthly: number }> {
  const rows = await sql<{ month: string; extra: number }[]>`
    SELECT month, extra FROM massage_quota_extra
    WHERE employee_id = ${employeeId} AND month = ANY(${[PERMANENT_MONTH, month]})
  `;
  const at = (m: string) => rows.find((r) => r.month.trim() === m)?.extra ?? 0;
  return { permanent: at(PERMANENT_MONTH), monthly: at(month) };
}

/**
 * สิทธิ์ของคนคนนี้ในเดือนของ day
 *
 * ทุกที่ที่ตัดสินว่า "จองได้อีกไหม" ต้องเรียกอันนี้ ห้ามอ่าน MONTHLY_QUOTA ตรง ๆ
 * ไม่งั้นคนที่ผู้ดูแลเพิ่มสิทธิ์ให้จะเห็นเลขหนึ่งบนหน้าจอ แต่ถูกปฏิเสธด้วยอีกเลขตอนกดจอง
 */
export async function quotaOf(employeeId: string, day: string): Promise<number> {
  const { permanent, monthly } = await quotaExtras(db(), employeeId, day.slice(0, 7));
  return quotaFromExtras(permanent, monthly);
}

/** ปรับสิทธิ์ชั้นไหน — เฉพาะเดือนนี้ หรือถาวรติดตัวไปทุกเดือน */
export type QuotaScope = "month" | "permanent";

export interface QuotaLine {
  month: string;
  /** สิทธิ์ปกติของทุกคน ก่อนถูกปรับ */
  base: number;
  /** ส่วนต่างรวมทั้งสองชั้น (บวก/ลบ/ศูนย์) — ตัวที่หน้าจอเอาไปบอกว่า "เพิ่มให้กี่ครั้ง" */
  extra: number;
  /** ส่วนต่างที่ให้ไว้ถาวร ติดตัวไปทุกเดือน */
  permanent: number;
  /** ส่วนต่างที่ให้เฉพาะเดือนนี้ หมดอายุพร้อมเดือน */
  monthly: number;
  /** สิทธิ์จริงหลังปรับแล้ว */
  quota: number;
  used: number;
}

/** สิทธิ์กับการใช้งานของคนคนหนึ่งในเดือนหนึ่ง — ตัวเลขชุดที่หน้าจอผู้ดูแลต้องใช้ทั้งหมด */
export async function quotaLine(employeeId: string, day: string): Promise<QuotaLine> {
  const month = day.slice(0, 7);
  const { permanent, monthly } = await quotaExtras(db(), employeeId, month);
  return {
    month,
    base: MONTHLY_QUOTA,
    extra: permanent + monthly,
    permanent,
    monthly,
    quota: quotaFromExtras(permanent, monthly),
    used: await monthlyUsage(employeeId, day),
  };
}

/**
 * ผู้ดูแลกดเพิ่มหรือลดสิทธิ์ให้พนักงานหนึ่งครั้ง
 *
 * ตัดสินจากค่าในฐานข้อมูล ณ ตอนกด ไม่ใช่จากตัวเลขที่หน้าจอส่งมา เพราะผู้ดูแลสองคน
 * อาจเปิดหน้าเดียวกันอยู่ ถ้าเชื่อตัวเลขจากหน้าจอ คนที่กดทีหลังจะเขียนทับของคนแรก
 *
 * ลดสิทธิ์ลงต่ำกว่าจำนวนที่จองไปแล้วได้ — คิวเดิมไม่ถูกยกเลิก แต่จองเพิ่มไม่ได้อีก
 * เพราะการยกเลิกคิวคนอื่นอัตโนมัติเป็นผลข้างเคียงที่ผู้ดูแลไม่ได้สั่ง
 */
export async function adjustQuota(
  employeeId: string,
  month: string,
  step: number,
  byEmployeeId: string,
  scope: QuotaScope = "month",
): Promise<QuotaLine> {
  const sql = db();
  return await sql.begin(async (tx) => {
    const emp = await tx<{ id: string }[]>`
      SELECT id FROM employees WHERE id = ${employeeId} FOR UPDATE
    `;
    if (emp.length === 0) throw new HttpError(404, "ไม่พบพนักงานคนนี้", "no_employee");

    const cur = await quotaExtras(tx, employeeId, month);
    // ชั้นที่ไม่ได้กด ต้องเอามาคิดด้วยตอนหนีบ ไม่งั้นคนที่มีสิทธิ์ถาวรเต็มเพดานอยู่แล้ว
    // จะกดเพิ่มรายเดือนได้เรื่อย ๆ โดยตัวเลขบนหน้าจอไม่ขยับ
    const other = scope === "permanent" ? cur.monthly : cur.permanent;
    const mine = scope === "permanent" ? cur.permanent : cur.monthly;

    // หนีบที่ "สิทธิ์จริง" ไม่ใช่ที่ส่วนต่าง เพื่อไม่ให้เก็บส่วนต่างที่กดค้างไว้เกินเพดาน
    // แล้วต้องกดลบซ้ำหลายครั้งกว่าตัวเลขบนหน้าจอจะขยับ
    const total = quotaFromExtra(other + mine + step);
    const extra = total - MONTHLY_QUOTA - other;
    const row = scope === "permanent" ? PERMANENT_MONTH : month;

    await tx`
      INSERT INTO massage_quota_extra (employee_id, month, extra, updated_by)
      VALUES (${employeeId}, ${row}, ${extra}, ${byEmployeeId})
      ON CONFLICT (employee_id, month) DO UPDATE
        SET extra = EXCLUDED.extra, updated_by = EXCLUDED.updated_by, updated_at = now()
    `;

    const used = await usedQuotaIn(tx, employeeId, `${month}-01`);
    const permanent = scope === "permanent" ? extra : cur.permanent;
    const monthly = scope === "permanent" ? cur.monthly : extra;
    return {
      month,
      base: MONTHLY_QUOTA,
      extra: permanent + monthly,
      permanent,
      monthly,
      quota: quotaFromExtras(permanent, monthly),
      used,
    };
  });
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

      // ต้องอ่านสิทธิ์ที่ใช้ไปเสมอ ไม่ใช่เฉพาะตอนจะห้าม เพราะเลขนี้เป็นตัวตัดสินด้วยว่า
      // คิวที่กำลังจะเขียนเป็นคิวสิทธิ์หรือคิวด่วน — สิทธิ์ยังไม่หมดก็นับสิทธิ์ตามปกติ
      // ต่อให้วันนั้นเข้าโหมดคิวด่วนไปแล้ว
      const used = [{ n: await usedQuotaIn(sql, employeeId, day) }];
      // อ่านสิทธิ์ที่ผู้ดูแลปรับไว้ในธุรกรรมเดียวกัน — แถวพนักงานถูกล็อกไปแล้วข้างบน
      // ผู้ดูแลที่กำลังกดลดสิทธิ์คนเดียวกันอยู่จึงต้องรอ ไม่ใช่แทรกกลางคัน
      const ex = await quotaExtras(sql, employeeId, day.slice(0, 7));
      const quota = quotaFromExtras(ex.permanent, ex.monthly);
      const flash = isFlashFor(day, used[0]?.n ?? 0, quota, now);
      if (!flash && (used[0]?.n ?? 0) >= quota) {
        throw new HttpError(
          409,
          quota === 0
            ? "เดือนนี้คุณไม่มีสิทธิ์จองคิวนวด"
            : `เดือนนี้ใช้สิทธิ์ครบ ${quota} ครั้งแล้ว`,
          "quota_used",
        );
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

  // จดเวลาด้วยนาฬิกาตัวเดียวกับที่ใช้ตัดสินข้างบน ไม่ใช่ now() ของฐานข้อมูล
  // เพราะกติกา "ยกเลิกหลังวันถูกล็อก = สิทธิ์ไม่คืน" อ่านจากค่านี้ ถ้าสองนาฬิกาไม่ตรงกัน
  // การตัดสินตอนกดกับการนับตอนอ่านจะให้คนละคำตอบ (และทดสอบเวลาย้อนหลังไม่ได้เลย)
  await sql`
    UPDATE massage_bookings
    SET status = 'cancelled', cancelled_at = ${now}, cancelled_by = ${employeeId}, updated_at = now()
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
  /** quota | flash | hold — ผู้เรียกต้องรู้ เพราะช่องที่ล็อกไว้ไม่มีเจ้าของให้แจ้ง */
  kind: string;
}

async function loadBooking(bookingId: string): Promise<AdminBookingRow> {
  const rows = await db()<
    { id: string; day: string; slot: string; therapist_id: string; therapist_name: string;
      employee_id: string; status: string; full_name: string; kind: string }[]
  >`
    SELECT b.id, to_char(b.day, 'YYYY-MM-DD') AS day, to_char(b.slot_start, 'HH24:MI') AS slot,
           b.therapist_id, t.name AS therapist_name, b.employee_id, b.status, e.full_name, b.kind
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
    employeeId: b.employee_id, name: b.full_name, kind: b.kind,
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
): Promise<AdminBookingRow & { toName: string; flash: boolean; hold: boolean }> {
  const b = await loadBooking(bookingId);

  try {
    return await db().begin(async (sql) => {
      // ล็อกแถวคนที่จะรับคิว ด้วยเหตุผลเดียวกับ adminBook — ต้องนับสิทธิ์ของคนนี้ใหม่
      // ถ้าไม่ล็อก คนที่กำลังกดจองเองอยู่พร้อมกันจะทำให้ทั้งสองฝั่งนับได้เลขเดียวกัน
      const to = await sql<
        { id: string; full_name: string; status: string; employee_code: string }[]
      >`
        SELECT id, full_name, status, employee_code FROM employees
        WHERE id = ${toEmployeeId} FOR UPDATE
      `;
      if (to.length === 0) throw new HttpError(404, "ไม่พบพนักงานคนนี้");
      if (to[0].status === "suspended") throw new HttpError(409, "พนักงานคนนี้ถูกระงับสิทธิ์อยู่");
      if (to[0].id === b.employeeId) {
        return { ...b, toName: to[0].full_name, flash: false, hold: false };
      }

      // ชนิดของคิวคิดใหม่เฉพาะเมื่อจำเป็น ไม่ใช่คิดใหม่ทุกครั้ง
      //
      // ต้องคิดใหม่: ช่องที่ผู้ดูแลล็อกไว้ (hold) ซึ่งไม่นับสิทธิ์ใครเลย ถ้าโอนให้คนจริง
      // แล้วยังเป็น hold อยู่ คนนั้นจะได้นวดฟรี กลายเป็นช่องทางเลี่ยงสิทธิ์
      //
      // ต้องไม่คิดใหม่: คิวด่วนที่โอนต่อให้เพื่อน ซึ่งเป็นทางออกเดียวของกติกา
      // "คิวด่วนยกเลิกเองไม่ได้ ให้หาคนมาแทน" ช่องนั้นเป็นช่องแถมมาตั้งแต่ต้น
      // ถ้าไปหักสิทธิ์คนที่มารับช่วง เท่ากับลงโทษคนที่ช่วยแก้ปัญหาให้
      const hold = to[0].employee_code === STAFF_CODE;
      const recompute = hold || b.kind === "hold";
      const used = hold || !recompute ? 0 : await usedQuotaIn(sql, toEmployeeId, b.day);
      const ex = hold || !recompute
        ? { permanent: 0, monthly: 0 }
        : await quotaExtras(sql, toEmployeeId, b.day.slice(0, 7));
      const kind = hold
        ? "hold"
        : recompute
          ? used >= quotaFromExtras(ex.permanent, ex.monthly) ? "flash" : "quota"
          : b.kind;

      await sql`
        UPDATE massage_bookings
        SET employee_id = ${toEmployeeId}, kind = ${kind}, updated_at = now()
        WHERE id = ${bookingId} AND status = 'booked'
      `;
      return { ...b, toName: to[0].full_name, flash: kind === "flash", hold };
    });
  } catch (e) {
    // ดัชนี uq_massage_person_day กันไว้ — คนใหม่มีคิวของวันนั้นอยู่แล้ว
    if (isUniqueViolation(e)) {
      throw new HttpError(409, "คนที่จะเปลี่ยนไปมีคิวของวันนี้อยู่แล้ว", "same_day");
    }
    throw e;
  }
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
  /** true = ยกเลิกได้ แต่สิทธิ์ไม่คืน เพราะวันนั้นถูกล็อกไปแล้ว — ต้องเตือนก่อนกด */
  keepsQuota: boolean;
  /** true = คิวนี้ถูกยกเลิกไปหลังวันถูกล็อก สิทธิ์จึงยังถูกนับว่าใช้ไปแล้ว */
  spentAnyway: boolean;
  past: boolean;
}

/** คิวของคนคนหนึ่งในเดือนที่ day อยู่ เรียงจากใกล้ที่สุด (รวมที่ยกเลิกไปแล้วด้วย) */
export async function myBookings(
  employeeId: string,
  now = new Date(),
): Promise<MyBooking[]> {
  const today = bangkokDate(now);
  const rows = await db()<
    { id: string; day: string; slot: string; status: string; kind: string; name: string;
      spent: boolean }[]
  >`
    SELECT b.id, to_char(b.day, 'YYYY-MM-DD') AS day, to_char(b.slot_start, 'HH24:MI') AS slot,
           b.status, b.kind, t.name,
           -- ยกเลิกไปแล้วแต่ยังถูกนับว่าใช้สิทธิ์ — ต้องบอกบนหน้าจอ ไม่งั้นเลขสิทธิ์
           -- จะดูเหมือนหายไปเฉย ๆ แล้วพนักงานจะทักมาถามทุกครั้ง
           (b.status = 'cancelled' AND b.kind = 'quota' AND ${usedQuotaRule(db())}) AS spent
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
      // วันถูกล็อกแล้ว = กดยกเลิกได้อยู่ แต่สิทธิ์ไม่คืน ต้องบอกก่อนกด ไม่ใช่ให้รู้ตอนกดไปแล้ว
      keepsQuota: r.kind === "quota" && now >= flashOpensAt(r.day),
      spentAnyway: r.spent === true,
      past: startsIn <= 0,
    };
  });
}

// ───────────────────────── ผู้ดูแลจองแทนพนักงาน ─────────────────────────

/**
 * ผู้ดูแลจองคิวให้พนักงานคนอื่น
 *
 * กติกาที่ข้ามได้ เพราะมีไว้กำกับ "การกดเองของพนักงาน" ไม่ใช่กำกับความถูกต้องของข้อมูล:
 *   เส้นตัด 15 นาที · สิทธิ์ 2 ครั้งต่อเดือน · เวลาเปิดจองของเดือน · ปิดปรับปรุงระบบ
 * ผู้ดูแลยืนอยู่หน้างานและรับสายจริง ย่อมรู้สถานการณ์ดีกว่ากติกาที่เขียนไว้ล่วงหน้า
 *
 * กติกาที่ข้ามไม่ได้ เพราะข้ามแล้วข้อมูลจะผิด ไม่ใช่แค่ยืดหยุ่น:
 *   วันต้องเปิดให้บริการ · หมอนวดต้องยังรับคิว · หนึ่งคนหนึ่งคิวต่อวัน · หนึ่งช่องหนึ่งคน
 * สองข้อหลังมีดัชนีในฐานข้อมูลกันไว้อยู่แล้ว ที่นี่แค่แปลงข้อผิดพลาดให้อ่านรู้เรื่อง
 *
 * คิวที่จองแทนถูกจัดประเภทด้วยเกณฑ์เดียวกับที่พนักงานกดเอง — สิทธิ์ยังเหลือก็หักสิทธิ์
 * เกินสิทธิ์แล้วก็เป็นคิวด่วน ไม่ให้ผู้ดูแลเลือกเอง เพราะถ้าเลือกได้ ตัวเลขสิทธิ์รายเดือน
 * จะขึ้นกับว่าใครเป็นคนกดปุ่ม ไม่ใช่ขึ้นกับว่าพนักงานใช้บริการไปกี่ครั้งจริง ๆ
 */
export async function adminBook(
  input: BookInput,
): Promise<AdminBookingRow & { flash: boolean; hold: boolean; used: number; quota: number }> {
  const { employeeId, day, slot, therapistId } = input;

  if (!MASSAGE_SLOTS.includes(slot as (typeof MASSAGE_SLOTS)[number])) {
    throw new HttpError(400, "รอบเวลาไม่ถูกต้อง", "bad_slot");
  }

  try {
    return await db().begin(async (sql) => {
      // ล็อกแถวพนักงานด้วยเหตุผลเดียวกับ book() — การนับสิทธิ์เป็นการอ่านที่ไม่ล็อกอะไรเลย
      const emp = await sql<
        { id: string; full_name: string; status: string; employee_code: string }[]
      >`
        SELECT id, full_name, status, employee_code FROM employees
        WHERE id = ${employeeId} FOR UPDATE
      `;
      if (emp.length === 0) throw new HttpError(404, "ไม่พบพนักงานคนนี้");
      if (emp[0].status === "suspended") throw new HttpError(409, "พนักงานคนนี้ถูกระงับสิทธิ์อยู่");
      const hold = emp[0].employee_code === STAFF_CODE;

      const dayRow = await sql<{ day: string }[]>`
        SELECT day FROM massage_days WHERE day = ${day}::date AND status = 'open'
      `;
      if (dayRow.length === 0) throw new HttpError(409, "วันนี้ไม่ได้เปิดให้บริการ", "day_closed");

      const th = await sql<{ name: string }[]>`
        SELECT name FROM massage_therapists WHERE id = ${therapistId} AND is_active = true
      `;
      if (th.length === 0) throw new HttpError(409, "หมอนวดท่านนี้ไม่ได้เปิดรับคิว", "bad_therapist");

      // ช่องที่ล็อกไว้ไม่มีเจ้าของจริง จึงไม่ต้องนับสิทธิ์ใครเลย และไม่กลายเป็นคิวด่วน
      const usedRows = hold
        ? [{ n: 0 }]
        : [{ n: await usedQuotaIn(sql, employeeId, day) }];
      const used = usedRows[0]?.n ?? 0;
      const ex = hold
        ? { permanent: 0, monthly: 0 }
        : await quotaExtras(sql, employeeId, day.slice(0, 7));
      const quota = quotaFromExtras(ex.permanent, ex.monthly);
      const flash = !hold && used >= quota;

      const ins = await sql<{ id: string }[]>`
        INSERT INTO massage_bookings (day, slot_start, therapist_id, employee_id, kind)
        VALUES (${day}::date, ${slot}::time, ${therapistId}, ${employeeId},
                ${hold ? "hold" : flash ? "flash" : "quota"})
        RETURNING id
      `;
      return {
        id: ins[0].id, day, slot,
        therapistId, therapistName: th[0].name,
        employeeId, name: emp[0].full_name,
        kind: hold ? "hold" : flash ? "flash" : "quota",
        flash, hold, used: flash || hold ? used : used + 1, quota,
      };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      if (violatedConstraint(e) === "uq_massage_person_day") {
        throw new HttpError(409, "พนักงานคนนี้มีคิวของวันนี้อยู่แล้ว จองได้วันละคิวเดียว", "same_day");
      }
      throw new HttpError(409, "ช่องนี้เพิ่งถูกจองไปเมื่อสักครู่ กรุณาเลือกรอบอื่น", "slot_taken");
    }
    throw e;
  }
}

// ───────────────────────── ผู้ดูแลจัดการวันให้บริการ ─────────────────────────

export interface AdminDayRow {
  day: string;
  label: string;
  status: "open" | "closed";
  closedReason: string | null;
  /** คิวที่ยังไม่ถูกยกเลิกของวันนั้น — ใช้เตือนก่อนปิดวัน */
  booked: number;
  /** ช่องทั้งหมดของวัน = จำนวนรอบ × จำนวนหมอนวดที่เปิดรับ */
  total: number;
  /** true = วันนี้ผ่านไปแล้ว เปลี่ยนอะไรก็ไม่มีผลกับใคร */
  past: boolean;
}

/**
 * รายการวันของเดือนหนึ่งสำหรับหน้าจัดการวัน
 *
 * สร้างวันศุกร์ของเดือนนั้นให้ก่อนเสมอ ไม่งั้นเดือนหน้าจะยังไม่มีแถวให้กดปิดล่วงหน้า
 * — ซึ่งเป็นสิ่งที่คนเปิดหน้านี้ต้องการทำมากที่สุด (รู้ล่วงหน้าว่าเดือนหน้าติดวันหยุด)
 */
export async function adminDays(month: string, now = new Date()): Promise<AdminDayRow[]> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "รูปแบบเดือนไม่ถูกต้อง");
  await ensureMonthDays(`${month}-01`, true);

  const today = bangkokDate(now);
  const therapists = await activeTherapists();
  const rows = await db()<
    { day: string; status: string; closed_reason: string | null; booked: number }[]
  >`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, d.status, d.closed_reason,
           count(b.id) FILTER (WHERE b.status = 'booked')::int AS booked
    FROM massage_days d
    LEFT JOIN massage_bookings b ON b.day = d.day
    WHERE d.day >= ${`${month}-01`}::date AND d.day < ${nextMonthStart(`${month}-01`)}::date
      AND d.status <> 'removed'
    GROUP BY d.day, d.status, d.closed_reason
    ORDER BY d.day
  `;

  return rows.map((r) => ({
    day: r.day,
    label: thaiDayLabel(r.day),
    status: r.status === "closed" ? "closed" : "open",
    closedReason: r.closed_reason,
    booked: r.booked,
    total: MASSAGE_SLOTS.length * therapists.length,
    past: r.day < today,
  }));
}

export interface AdminDayChange {
  day: string;
  status: "open" | "closed";
  /** คิวที่ถูกยกเลิกไปพร้อมกับการปิดวัน — ปลายทางเอาไปแจ้งเจ้าตัวทีละคน */
  cancelled: AdminBookingRow[];
}

/**
 * เปิดหรือปิดวันให้บริการหนึ่งวัน
 *
 * มีไว้แทนการเข้าไปรัน SQL เอง ซึ่งเป็นทางเดียวที่เคยทำได้ และเป็นงานที่ต้องทำทุกครั้ง
 * ที่บริษัทประกาศวันหยุดหรือหมอนวดลาทั้งวัน — บ่อยพอจะไม่ควรต้องพึ่งคนเขียนโปรแกรม
 *
 * ปิดวันที่มีคนจองอยู่ = ยกเลิกคิวทั้งหมดของวันนั้นให้ด้วย ไม่ปล่อยให้ค้างเป็นคิวของวันที่
 * ไม่มีบริการ แต่ต้องส่ง force มาด้วย เพราะเป็นการยกเลิกของคนอื่นหลายคนพร้อมกัน
 * ไม่ใช่สิ่งที่ควรเกิดจากการกดพลาดครั้งเดียว
 *
 * เปิดวันคืน ไม่คืนคิวที่ถูกยกเลิกไปแล้ว — คนที่ถูกยกเลิกได้รับข้อความไปแล้วว่าคิวหาย
 * ถ้าคืนให้เงียบ ๆ จะกลายเป็นว่าเขามีคิวอยู่โดยไม่รู้ตัว
 */
export async function adminSetDay(
  day: string,
  status: "open" | "closed",
  opts: { reason?: string; force?: boolean; byEmployeeId: string },
): Promise<AdminDayChange> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "รูปแบบวันที่ไม่ถูกต้อง");
  const sql = db();

  if (status === "open") {
    await sql`
      INSERT INTO massage_days (day, status) VALUES (${day}::date, 'open')
      ON CONFLICT (day) DO UPDATE SET status = 'open', closed_reason = NULL
    `;
    return { day, status, cancelled: [] };
  }

  const reason = (opts.reason ?? "").trim().slice(0, 120) || "ปิดให้บริการ";
  const active = await sql<
    { id: string; slot: string; therapist_id: string; therapist_name: string;
      employee_id: string; full_name: string; kind: string }[]
  >`
    SELECT b.id, to_char(b.slot_start, 'HH24:MI') AS slot,
           b.therapist_id, t.name AS therapist_name, b.employee_id, e.full_name, b.kind
    FROM massage_bookings b
    JOIN employees e ON e.id = b.employee_id
    JOIN massage_therapists t ON t.id = b.therapist_id
    WHERE b.day = ${day}::date AND b.status = 'booked'
    ORDER BY b.slot_start
  `;
  if (active.length > 0 && !opts.force) {
    throw new HttpError(409, `วันนี้มีคนจองอยู่ ${active.length} คิว`, "has_bookings");
  }

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO massage_days (day, status, closed_reason) VALUES (${day}::date, 'closed', ${reason})
      ON CONFLICT (day) DO UPDATE SET status = 'closed', closed_reason = ${reason}
    `;
    if (active.length > 0) {
      await tx`
        UPDATE massage_bookings
        SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${opts.byEmployeeId},
            cancel_reason = ${reason}, updated_at = now()
        WHERE day = ${day}::date AND status = 'booked'
      `;
    }
  });

  return {
    day,
    status,
    cancelled: active.map((b) => ({
      id: b.id, day, slot: b.slot,
      therapistId: b.therapist_id, therapistName: b.therapist_name,
      employeeId: b.employee_id, name: b.full_name, kind: b.kind,
    })),
  };
}

/**
 * ลบวันให้บริการออกจากรายการ
 *
 * ต่างจาก "ปิดวัน" ตรงที่ปิดแล้ววันนั้นยังอยู่ในรายการให้เห็นว่าปิดอยู่ (และเปิดกลับได้)
 * ส่วนลบคือเอาออกจากสายตาไปเลย ใช้กับวันที่ไม่ควรมีตั้งแต่แรก เช่น เพิ่มวันนอกตารางผิดวัน
 *
 * ไม่ลบแถวจริงด้วยสองเหตุผล
 *   1. massage_bookings.day ผูก foreign key ไว้กับตารางนี้ ลบแถวทิ้งจะพาประวัติคิวเก่าหายไปด้วย
 *      ซึ่งขัดกับที่ตั้งใจไว้ตั้งแต่ต้นว่าคิวที่ยกเลิกแล้วต้องยังตอบได้ว่าใครยกเลิกบ่อย
 *   2. ตัวสร้างวันของเดือน (ensureMonthDays) จะสร้างวันศุกร์กลับมาให้ใหม่ทุกครั้งที่เปิดหน้านี้
 *      ลบแถวทิ้งจึงได้ผลแค่ชั่วคราว วันเดิมจะโผล่กลับมาเองในไม่กี่วินาที
 *
 * ใช้ status = 'removed' แทน แถวยังอยู่ ประวัติยังอยู่ ตัวสร้างวันไม่แตะ (ON CONFLICT DO NOTHING)
 * และเอากลับมาได้ด้วยการเพิ่มวันเดิมซ้ำที่ช่อง "เพิ่มวันให้บริการนอกตาราง"
 */
export async function adminRemoveDay(
  day: string,
  opts: { force?: boolean; byEmployeeId: string },
): Promise<AdminDayChange> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "รูปแบบวันที่ไม่ถูกต้อง");
  const sql = db();

  const exists = await sql<{ status: string }[]>`
    SELECT status FROM massage_days WHERE day = ${day}::date
  `;
  if (exists.length === 0 || exists[0].status === "removed") {
    throw new HttpError(404, "ไม่มีวันนี้ในระบบอยู่แล้ว");
  }

  // คิวที่ยังไม่ถูกยกเลิกต้องถูกยกเลิกไปพร้อมกัน ไม่ปล่อยให้ค้างเป็นคิวของวันที่ไม่มีอยู่แล้ว
  const active = await sql<
    { id: string; slot: string; therapist_id: string; therapist_name: string;
      employee_id: string; full_name: string; kind: string }[]
  >`
    SELECT b.id, to_char(b.slot_start, 'HH24:MI') AS slot,
           b.therapist_id, t.name AS therapist_name, b.employee_id, e.full_name, b.kind
    FROM massage_bookings b
    JOIN employees e ON e.id = b.employee_id
    JOIN massage_therapists t ON t.id = b.therapist_id
    WHERE b.day = ${day}::date AND b.status = 'booked'
    ORDER BY b.slot_start
  `;
  if (active.length > 0 && !opts.force) {
    throw new HttpError(409, `วันนี้มีคนจองอยู่ ${active.length} คิว`, "has_bookings");
  }

  const reason = "ยกเลิกวันให้บริการ";
  await sql.begin(async (tx) => {
    await tx`
      UPDATE massage_days SET status = 'removed', closed_reason = ${reason} WHERE day = ${day}::date
    `;
    if (active.length > 0) {
      await tx`
        UPDATE massage_bookings
        SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${opts.byEmployeeId},
            cancel_reason = ${reason}, updated_at = now()
        WHERE day = ${day}::date AND status = 'booked'
      `;
    }
  });

  return {
    day,
    status: "closed",
    cancelled: active.map((b) => ({
      id: b.id, day, slot: b.slot,
      therapistId: b.therapist_id, therapistName: b.therapist_name,
      employeeId: b.employee_id, name: b.full_name, kind: b.kind,
    })),
  };
}

export interface AdminGridCell {
  therapistId: string;
  bookingId: string | null;
  /** ชื่อคนที่จองช่องนี้ — ว่างเมื่อยังไม่มีใครจอง */
  name: string | null;
}

export interface AdminGridRow {
  slot: string;
  label: string;
  /** true = รอบนี้เริ่มไปแล้ว จองย้อนหลังไม่มีประโยชน์ */
  past: boolean;
  cells: AdminGridCell[];
}

export interface AdminDayGrid {
  day: string;
  label: string;
  status: "open" | "closed";
  therapists: Therapist[];
  rows: AdminGridRow[];
}

/**
 * ตารางทั้งวันพร้อมชื่อผู้จอง สำหรับหน้าจองแทนของผู้ดูแล
 *
 * ต่างจาก dayAvailability สองข้อ: มีชื่อคนอื่นอยู่ในผลลัพธ์ (จึงเรียกได้เฉพาะผู้ดูแล)
 * และไม่ตัดรอบที่เหลือเวลาน้อยกว่า 15 นาทีทิ้ง เพราะการเติมคนเข้ารอบที่กำลังจะถึง
 * คือเหตุผลหลักที่หน้านี้มีอยู่ ตัดเฉพาะรอบที่ "เริ่มไปแล้ว" ซึ่งเติมย้อนหลังไม่ได้จริง ๆ
 */
export async function adminDayGrid(day: string, now = new Date()): Promise<AdminDayGrid> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "รูปแบบวันที่ไม่ถูกต้อง");

  const rows = await db()<{ status: string }[]>`
    SELECT status FROM massage_days WHERE day = ${day}::date
  `;
  // วันที่ถูกลบออกไปแล้วยังมีแถวอยู่ (ประวัติคิวเก่าอ้างถึงอยู่) แต่ต้องถือว่าไม่มีวันนี้
  if (rows.length === 0 || rows[0].status === "removed") throw new HttpError(404, "ไม่มีวันนี้ในระบบ");

  const therapists = await activeTherapists();
  const booked = await db()<
    { id: string; slot: string; therapist_id: string; full_name: string }[]
  >`
    SELECT b.id, to_char(b.slot_start, 'HH24:MI') AS slot, b.therapist_id, e.full_name
    FROM massage_bookings b
    JOIN employees e ON e.id = b.employee_id
    WHERE b.day = ${day}::date AND b.status = 'booked'
  `;
  const at = new Map(booked.map((b) => [`${b.slot}|${b.therapist_id}`, b]));

  return {
    day,
    label: thaiDayLabel(day),
    status: rows[0].status === "closed" ? "closed" : "open",
    therapists,
    rows: MASSAGE_SLOTS.map((slot) => ({
      slot,
      label: slotLabel(slot),
      past: slotStartAt(day, slot).getTime() <= now.getTime(),
      cells: therapists.map((t) => {
        const b = at.get(`${slot}|${t.id}`);
        return { therapistId: t.id, bookingId: b?.id ?? null, name: b?.full_name ?? null };
      }),
    })),
  };
}
