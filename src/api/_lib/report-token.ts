// ลิงก์รายงานที่เปิดได้โดยไม่ต้องล็อกอิน และหมดอายุเอง
//
// รายงานต้องส่งให้ผู้บริหารที่ไม่ได้ใช้แอปนี้ ลิงก์จึงต้องเปิดได้จากเบราว์เซอร์ทั่วไป
// แต่ก็ปล่อยให้เป็น URL ที่เดาได้ไม่ได้ เพราะข้างในมีชื่อพนักงานและผลงานรายบุคคล
//
// วิธีที่ใช้: ใส่ข้อมูลที่ต้องรู้ (ฝ่ายไหน ช่วงไหน หมดอายุเมื่อไหร่) ลงในตัวลิงก์เอง
// แล้วเซ็นกำกับด้วยกุญแจของระบบ ใครแก้ตัวเลขในลิงก์ ลายเซ็นจะไม่ตรงทันที
// ไม่ต้องมีตารางเก็บลิงก์ ไม่ต้องมีงานล้างของเก่า และลิงก์เดิมใช้ซ้ำได้จนกว่าจะหมดอายุ

import crypto from "node:crypto";
import { envVar } from "./env";
import { HttpError } from "./http";
import type { Period } from "./reports";

export interface ReportClaim {
  /** รายชื่อ department_id ที่รายงานนี้ครอบคลุม — หนึ่งตัวคือรายงานของฝ่ายเดียว หลายตัวคือรวมทุกฝ่าย */
  d: string[];
  p: Period;
  o: number;
  /** วันหมดอายุ (epoch วินาที) */
  e: number;
}

/** อายุลิงก์เริ่มต้น — ยาวพอให้ส่งต่อและเปิดดูซ้ำได้ทั้งสัปดาห์ แต่ไม่ค้างอยู่ตลอดไป */
export const LINK_TTL_DAYS = 14;

const toUrl = (b64: string) => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrl = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");

/** JSON -> base64url (ผ่านไบต์ UTF-8 เผื่อมีตัวอักษรนอก ASCII) */
function encodeClaim(claim: ReportClaim): string {
  const bytes = new TextEncoder().encode(JSON.stringify(claim));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return toUrl(btoa(bin));
}

function decodeClaim(payload: string): ReportClaim | null {
  try {
    const bin = atob(fromUrl(payload));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as ReportClaim;
  } catch {
    return null;
  }
}

/**
 * กุญแจสำหรับเซ็นลิงก์
 *
 * แยกออกจาก LINE_CHANNEL_SECRET ด้วยการแฮชกับป้ายชื่อประจำงานนี้ ค่าที่ได้จึงใช้แทนกันไม่ได้
 * กับลายเซ็นของ webhook ทำแบบนี้เพื่อไม่ต้องเพิ่มค่าตั้งค่าใหม่ให้ผู้ดูแลไปตั้งอีกตัว
 */
function signingKey(): string {
  const secret = envVar("LINE_CHANNEL_SECRET");
  if (!secret) throw new HttpError(501, "ยังไม่ได้ตั้งค่า LINE_CHANNEL_SECRET จึงสร้างลิงก์รายงานไม่ได้");
  return crypto.createHmac("sha256", secret).update("horizon-report-link-v1").digest("base64");
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

export function signReportToken(claim: Omit<ReportClaim, "e">, ttlDays = LINK_TTL_DAYS): string {
  const full: ReportClaim = { ...claim, e: Math.floor(Date.now() / 1000) + ttlDays * 86400 };
  const payload = encodeClaim(full);
  return `${payload}.${sign(payload)}`;
}

/** คืน claim เมื่อลายเซ็นถูกและยังไม่หมดอายุ · คืน null เมื่อไม่ผ่าน */
export function verifyReportToken(token: string): ReportClaim | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(payload))) return null;

  const claim = decodeClaim(payload);
  if (!claim || (claim.p !== "week" && claim.p !== "month" && claim.p !== "all")) return null;
  // ลิงก์รุ่นก่อนเก็บ d เป็นรหัสฝ่ายเดี่ยว ๆ ที่ยังไม่หมดอายุก็ต้องเปิดได้อยู่
  const raw: unknown = claim.d;
  const depts = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  if (depts.length === 0 || !depts.every((x) => typeof x === "string" && x.length > 0)) return null;
  if (typeof claim.e !== "number" || claim.e * 1000 < Date.now()) return null;
  return { d: depts, p: claim.p, o: Number(claim.o) || 0, e: claim.e };
}
