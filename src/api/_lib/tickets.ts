// ตัวช่วยเกี่ยวกับ ticket ที่ไม่ผูกกับการเชื่อมต่อฐานข้อมูลโดยตรง

import { STATUS_TRANSITIONS, type StatusCode } from "./constants";
import { HttpError } from "./http";

/** ตรวจว่าเปลี่ยนสถานะจาก -> เป็น ได้หรือไม่ (spec หัวข้อ 4) */
export function assertTransition(from: StatusCode, to: StatusCode): void {
  const allowed = STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new HttpError(409, `ไม่สามารถเปลี่ยนสถานะจาก ${from} เป็น ${to} ได้`);
  }
}

/** คืน field เวลาที่ต้องบันทึกเมื่อเข้าสู่สถานะใหม่ */
export function timestampField(to: StatusCode): "acknowledged_at" | "completed_at" | "closed_at" | null {
  if (to === "in_progress") return "acknowledged_at";
  if (to === "completed") return "completed_at";
  if (to === "closed") return "closed_at";
  return null;
}

/** YYMM ตามเวลาปัจจุบัน (โซนเวลา Asia/Bangkok) สำหรับเลขที่เรื่อง */
export function currentYYMM(now = new Date()): string {
  // แปลงเป็นเวลาไทย (UTC+7) เพื่อให้เลขเดือนตรงกับวันทำงานจริง
  const th = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const yy = String(th.getUTCFullYear()).slice(-2);
  const mm = String(th.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}${mm}`;
}

const TH_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

/** จัดรูปแบบวันเวลาแบบไทย เช่น "7 ส.ค. 2569 · 09:41" (โซนเวลา Asia/Bangkok, พ.ศ.) */
export function thaiDateTime(d = new Date()): string {
  const th = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const day = th.getUTCDate();
  const mon = TH_MONTHS[th.getUTCMonth()];
  const year = th.getUTCFullYear() + 543;
  const hh = String(th.getUTCHours()).padStart(2, "0");
  const mm = String(th.getUTCMinutes()).padStart(2, "0");
  return `${day} ${mon} ${year} · ${hh}:${mm}`;
}
