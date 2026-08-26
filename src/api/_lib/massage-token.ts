// ลิงก์ฟอร์มเช็คชื่อที่เปิดได้โดยไม่ต้องล็อกอิน และหมดอายุเอง
//
// ทำไมต้องเปิดโดยไม่ล็อกอิน: ผู้ดูแลกด "ดาวน์โหลดฟอร์ม" จากในแอปไลน์ แล้วต้องให้หน้าไปเปิด
// ที่เบราว์เซอร์ของเครื่อง เพราะเบราว์เซอร์ในแอปไลน์สั่งพิมพ์และบันทึกไฟล์ได้ไม่แน่นอน
// พอออกไปเบราว์เซอร์ข้างนอกแล้วก็ไม่มี session ของไลน์ติดไปด้วย
//
// สิ่งที่กันไว้แทนการล็อกอิน: ลิงก์ถูกเซ็นกำกับ (แก้วันที่ในลิงก์แล้วลายเซ็นไม่ตรงทันที)
// และหมดอายุใน 2 วัน — สั้นกว่าลิงก์รายงานมาก เพราะหน้านี้มีชื่อพนักงานเรียงเป็นตาราง
// ไม่ได้ตั้งใจให้ส่งต่อ ตั้งใจให้ใช้พิมพ์แล้วจบ

import crypto from "node:crypto";
import { envVar } from "./env";
import { HttpError } from "./http";

export interface SheetClaim {
  /** วันที่ของฟอร์ม "YYYY-MM-DD" */
  d: string;
  /** วันหมดอายุ (epoch วินาที) */
  e: number;
}

/** อายุลิงก์ — ยาวพอให้เตรียมล่วงหน้าวันพฤหัสบดีแล้วใช้จริงวันศุกร์ */
export const SHEET_TTL_HOURS = 48;

const toUrl = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * กุญแจสำหรับเซ็น
 *
 * แยกจากกุญแจของลิงก์รายงานด้วยป้ายชื่อคนละอัน ลิงก์ของสองระบบจึงใช้แทนกันไม่ได้
 * ต่อให้ใครถอดโครงสร้างลิงก์ออกมาได้ก็ยังปลอมข้ามระบบไม่ได้
 */
function signingKey(): string {
  const secret = envVar("LINE_CHANNEL_SECRET");
  if (!secret) throw new HttpError(501, "ยังไม่ได้ตั้งค่า LINE_CHANNEL_SECRET จึงสร้างลิงก์ฟอร์มไม่ได้");
  return crypto.createHmac("sha256", secret).update("horizon-massage-sheet-v1").digest("base64");
}

function sign(payload: string): string {
  return toUrl(crypto.createHmac("sha256", signingKey()).update(payload).digest("base64"));
}

/** เทียบสองสตริงโดยใช้เวลาเท่ากันเสมอ ไม่ให้เดาลายเซ็นทีละตัวอักษรจากเวลาที่ใช้ตอบ */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function signSheetToken(day: string, ttlHours = SHEET_TTL_HOURS): string {
  const claim: SheetClaim = { d: day, e: Math.floor(Date.now() / 1000) + ttlHours * 3600 };
  // วันที่เป็น ASCII ล้วน จึงเข้ารหัส base64 ตรง ๆ ได้ ไม่ต้องผ่านตัวแปลง UTF-8
  const payload = toUrl(btoa(JSON.stringify(claim)));
  return `${payload}.${sign(payload)}`;
}

/** คืนวันที่เมื่อลายเซ็นถูกและยังไม่หมดอายุ · คืน null เมื่อไม่ผ่าน */
export function verifySheetToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(payload))) return null;

  try {
    const claim = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as SheetClaim;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(claim.d)) return null;
    if (typeof claim.e !== "number" || claim.e * 1000 < Date.now()) return null;
    return claim.d;
  } catch {
    return null;
  }
}
