// ตัวช่วยเชื่อมต่อ LINE: ตรวจ ID token, ตรวจ signature ของ webhook, push/reply/multicast + บันทึก message_logs

import crypto from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTPayload } from "jose";
import { db } from "./db";
import { HttpError } from "./http";
import { envVar } from "./env";

const LINE_API = "https://api.line.me";

export interface LineProfile {
  sub: string; // = userId ที่เชื่อถือได้
  name?: string;
  picture?: string;
}

// ตรวจลายเซ็นของ ID token ด้วยกุญแจสาธารณะของ LINE เอง (JWKS) แทนการเรียก endpoint
// /oauth2/v2.1/verify ทุกครั้ง — ทุก request ที่ต้องยืนยันตัวตนก่อนหน้านี้ต้องออกไปคุยกับ
// เซิร์ฟเวอร์ LINE ก่อนเสมอ ทำให้ทุกหน้าในแอปช้าลงเท่ากันหมด (ไม่ใช่แค่ตอนล็อกอินครั้งแรก)
// วิธีนี้เป็นวิธีที่ LINE แนะนำสำหรับ backend ที่ต้องตรวจ token บ่อย ๆ
//
// เก็บกุญแจไว้เป็น "ข้อมูล JSON ธรรมดา" เท่านั้น แล้วประกอบตัวตรวจใหม่ในแต่ละคำขอ
// เหตุผล: บน Cloudflare Workers อ็อบเจกต์ที่ผูกกับการเชื่อมต่อเครือข่ายของคำขอหนึ่ง
// เอาไปใช้ในอีกคำขอหนึ่งไม่ได้ ตัวโหลดกุญแจแบบ remote จะเก็บสถานะการดาวน์โหลดค้างไว้ข้ามคำขอ
const JWKS_URL = `${LINE_API}/oauth2/v2.1/certs`;
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache: { set: JSONWebKeySet; at: number } | null = null;

function jwksIsFresh(): boolean {
  return jwksCache !== null && Date.now() - jwksCache.at < JWKS_TTL_MS;
}

async function lineJwks(refresh: boolean): Promise<JSONWebKeySet> {
  if (!refresh && jwksCache && jwksIsFresh()) return jwksCache.set;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`โหลดกุญแจสาธารณะของ LINE ไม่สำเร็จ (${res.status})`);
  const set = (await res.json()) as JSONWebKeySet;
  if (!Array.isArray(set?.keys)) throw new Error("รูปแบบกุญแจสาธารณะของ LINE ไม่ถูกต้อง");
  jwksCache = { set, at: Date.now() };
  return set;
}

/**
 * สาเหตุที่ตั๋วเข้าระบบใช้ไม่ได้ — ต้องแยกให้ออก เพราะสามสาเหตุนี้แก้คนละทางกันคนละขั้ว
 *
 * เคยเสียเวลาไล่หาสาเหตุมาแล้วรอบหนึ่ง เพราะทุกสาเหตุขึ้นข้อความเดียวกันหมดว่า
 * "invalid LINE id token" ซึ่งไม่ได้บอกเลยว่าต้องไปแก้ที่ผู้ใช้ ที่ค่าตั้งค่า หรือที่ไหน
 *   หมดอายุ      → ผู้ใช้เปิดใหม่ก็หาย หน้าจอขอตั๋วใบใหม่ให้เองได้
 *   ค่าตั้งไม่ตรง  → ผู้ใช้ทำอะไรก็ไม่หาย ต้องไปแก้ LINE_LOGIN_CHANNEL_ID ของ Worker ตัวนั้น
 *   อ่านไม่ออก    → ตั๋วเพี้ยนหรือกุญแจของไลน์เปลี่ยน ลองดึงกุญแจใหม่แล้วตรวจซ้ำได้
 */
interface TokenFailure {
  code: "token_expired" | "token_config" | "bad_token";
  message: string;
  /** ดึงกุญแจสาธารณะชุดใหม่แล้วตรวจซ้ำมีโอกาสช่วยไหม — มีแค่กรณีลายเซ็นเท่านั้น */
  retryWithFreshKeys: boolean;
}

function classifyTokenError(e: unknown): TokenFailure {
  const err = e as { code?: string; claim?: string } | null;
  if (err?.code === "ERR_JWT_EXPIRED") {
    return {
      code: "token_expired",
      message: "การล็อกอินไลน์หมดอายุแล้ว กรุณาปิดหน้านี้แล้วเปิดลิงก์ใหม่อีกครั้ง",
      retryWithFreshKeys: false,
    };
  }
  if (err?.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    return {
      code: "token_config",
      message:
        err.claim === "aud"
          ? "ค่า LINE_LOGIN_CHANNEL_ID ของระบบนี้ไม่ตรงกับช่องทางล็อกอินของ LIFF ที่เปิดเข้ามา"
          : `ตั๋วเข้าระบบมีค่า ${err.claim ?? "ที่จำเป็น"} ไม่ถูกต้อง`,
      retryWithFreshKeys: false,
    };
  }
  return {
    code: "bad_token",
    message: "ตั๋วเข้าระบบของไลน์ใช้ไม่ได้ กรุณาปิดหน้านี้แล้วเปิดลิงก์ใหม่อีกครั้ง",
    retryWithFreshKeys: true,
  };
}

type VerifyResult =
  | { payload: JWTPayload; failure?: undefined }
  | { payload?: undefined; failure: TokenFailure };

/** ตรวจลายเซ็นด้วยกุญแจชุดปัจจุบัน — ถ้าไม่ผ่าน คืนเหตุผลมาด้วย ไม่ใช่แค่ null */
async function tryVerify(idToken: string, clientId: string, refresh: boolean): Promise<VerifyResult> {
  const keys = createLocalJWKSet(await lineJwks(refresh));
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: "https://access.line.me",
      audience: clientId,
    });
    return { payload };
  } catch (e) {
    return { failure: classifyTokenError(e) };
  }
}

/**
 * ตรวจสอบ LINE ID token ฝั่ง server แล้วคืน payload ที่เชื่อถือได้
 * ห้ามเชื่อ userId ที่ client ส่งมาตรง ๆ (spec หัวข้อ 5.1 / 10)
 */
export async function verifyIdToken(idToken: string): Promise<LineProfile> {
  const clientId = envVar("LINE_LOGIN_CHANNEL_ID");
  if (!clientId) throw new Error("LINE_LOGIN_CHANNEL_ID is not set");

  const usedCache = jwksIsFresh();
  let out = await tryVerify(idToken, clientId, false);
  // ลายเซ็นไม่ผ่านทั้งที่ใช้กุญแจที่แคชไว้ อาจเป็นเพราะ LINE เปลี่ยนกุญแจ — ดึงใหม่แล้วลองอีกครั้งเดียว
  // สาเหตุอื่น (หมดอายุ · ค่าตั้งไม่ตรง) กุญแจชุดใหม่ช่วยไม่ได้ ไม่ต้องเสียเวลายิงออกไปซ้ำ
  if (out.failure && usedCache && out.failure.retryWithFreshKeys) {
    out = await tryVerify(idToken, clientId, true);
  }
  if (out.failure) {
    // ลงบันทึกไว้เฉพาะรหัสสาเหตุ ไม่ลงตัวตั๋ว เพราะตั๋วใช้เข้าระบบแทนเจ้าตัวได้
    console.warn("[line] ตั๋วเข้าระบบใช้ไม่ได้:", out.failure.code);
    throw new HttpError(401, out.failure.message, out.failure.code);
  }
  const payload = out.payload;

  if (typeof payload.sub !== "string") throw new HttpError(401, "ตั๋วเข้าระบบของไลน์ไม่มีรหัสผู้ใช้", "bad_token");
  return {
    sub: payload.sub,
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
}

/** ตรวจ signature ของ webhook ด้วย X-Line-Signature (spec หัวข้อ 7) */
export function verifyLineSignature(rawBody: string, signature: string | null): boolean {
  const secret = envVar("LINE_CHANNEL_SECRET");
  if (!secret || !signature) return false;
  const mac = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(signature));
  } catch {
    return false;
  }
}

export type LineMessage = Record<string, unknown>;

async function callMessaging(path: string, body: unknown): Promise<boolean> {
  const token = envVar("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  const res = await fetch(`${LINE_API}/v2/bot/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("[line]", path, res.status, await res.text().catch(() => ""));
  }
  return res.ok;
}

/**
 * ผูก rich menu ให้ผู้ใช้คนหนึ่ง · ถอดออกด้วย unlinkRichMenu
 *
 * เขียนแยกจาก callMessaging เพราะสอง endpoint นี้ไม่เหมือน endpoint อื่นของ Messaging API
 * — ไม่มี body และตัวถอดใช้ method DELETE
 *
 * ใช้เปลี่ยนเมนูตามสถานะของคนคนนั้น: ยังไม่ลงทะเบียน = เมนูที่มีปุ่มลงทะเบียน ·
 * ลงทะเบียนแล้ว = เมนูใช้งาน · ลาออกหรือถูกระงับ = ไม่มีเมนู (ดู _lib/richmenu.ts)
 */
async function callRichMenu(path: string, method: "POST" | "DELETE"): Promise<boolean> {
  const token = envVar("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  const res = await fetch(`${LINE_API}/v2/bot/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  // 404 ตอนถอดเมนูแปลว่าคนนั้นไม่มีเมนูผูกอยู่แล้ว ซึ่งคือผลลัพธ์ที่ต้องการพอดี ไม่ใช่ข้อผิดพลาด
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    console.error("[line]", path, res.status, await res.text().catch(() => ""));
    return false;
  }
  return true;
}

/**
 * ผลของการ "ถาม" LINE — แยกให้ออกระหว่างถามไม่ได้ กับถามได้แล้วไม่มีข้อมูล
 *
 * สองอย่างนี้ต้องไม่ยุบเป็นค่าเดียวกัน เพราะ "ยังไม่ได้ตั้งโทเคน" กับ "ตั้งแล้วแต่ยังไม่มีเมนู"
 * ต้องไปแก้คนละที่กัน และเป็นสาเหตุที่ทำให้เมนูไม่เปลี่ยนได้เหมือนกันทั้งคู่
 */
export type LineQuery<T> = { ok: true; data: T } | { ok: false; error: string };

async function getFromLine<T>(path: string, notFound?: () => T): Promise<LineQuery<T>> {
  const token = envVar("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) return { ok: false, error: "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ที่ระบบนี้" };
  try {
    const res = await fetch(`${LINE_API}/v2/bot/${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 404 && notFound) return { ok: true, data: notFound() };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[line] GET", path, res.status, body);
      // ข้อความจาก LINE เป็นภาษาอังกฤษ แต่บอกสาเหตุตรงที่สุด จึงส่งต่อไปให้คนอ่านเห็น
      return { ok: false, error: `LINE ตอบกลับ ${res.status}${body ? ` · ${body.slice(0, 160)}` : ""}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    console.error("[line] GET", path, e);
    return { ok: false, error: "ต่อกับ LINE ไม่ได้" };
  }
}

export interface RichMenuInfo {
  richMenuId: string;
  name: string;
  chatBarText?: string;
}

/** รายการ rich menu ทั้งหมดที่มีอยู่จริงบน LINE — ใช้เทียบว่ารหัสที่ตั้งไว้มีอยู่จริงไหม */
export async function listRichMenus(): Promise<LineQuery<RichMenuInfo[]>> {
  const r = await getFromLine<{ richmenus?: RichMenuInfo[] }>("richmenu/list");
  return r.ok ? { ok: true, data: r.data.richmenus ?? [] } : r;
}

/** เมนูตั้งต้นของทั้ง OA — ระบบนี้ต้องไม่มี ไม่งั้นคนที่ถูกถอดเมนูจะตกกลับไปเห็นเมนูนั้น */
export async function defaultRichMenuId(): Promise<LineQuery<string | null>> {
  const r = await getFromLine<{ richMenuId?: string }>("user/all/richmenu", () => ({}));
  return r.ok ? { ok: true, data: r.data.richMenuId ?? null } : r;
}

/** เมนูที่ผูกอยู่กับคนคนนี้จริง ๆ ตอนนี้ — คำตอบสุดท้ายว่า "เปลี่ยนแล้วหรือยัง" */
export async function richMenuOf(userId: string): Promise<LineQuery<string | null>> {
  const r = await getFromLine<{ richMenuId?: string }>(
    `user/${encodeURIComponent(userId)}/richmenu`,
    () => ({}),
  );
  return r.ok ? { ok: true, data: r.data.richMenuId ?? null } : r;
}

export function linkRichMenu(userId: string, richMenuId: string): Promise<boolean> {
  return callRichMenu(`user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`, "POST");
}

export function unlinkRichMenu(userId: string): Promise<boolean> {
  return callRichMenu(`user/${encodeURIComponent(userId)}/richmenu`, "DELETE");
}

interface LogMeta {
  ticketId?: string | null;
  channel?: "group" | "user";
}

/** push ข้อความไปยัง userId หรือ groupId เดียว */
export async function pushTo(to: string, messages: LineMessage[], meta: LogMeta = {}): Promise<boolean> {
  const ok = await callMessaging("message/push", { to, messages });
  await logMessage("push", to, meta.channel ?? "user", meta.ticketId ?? null, ok);
  return ok;
}

/** ตอบกลับผ่าน replyToken (ใช้ในบริบท webhook) */
export async function replyTo(replyToken: string, messages: LineMessage[]): Promise<boolean> {
  const ok = await callMessaging("message/reply", { replyToken, messages });
  await logMessage("reply", null, "user", null, ok);
  return ok;
}

/** push ถึงผู้รับหลายคนพร้อมกัน (ใช้กรณี critical แจ้งสมาชิกฝ่ายรายบุคคล) */
export async function multicastTo(to: string[], messages: LineMessage[], meta: LogMeta = {}): Promise<boolean> {
  if (to.length === 0) return true;
  const ok = await callMessaging("message/multicast", { to, messages });
  await logMessage("multicast", null, meta.channel ?? "user", meta.ticketId ?? null, ok);
  return ok;
}

/** สร้างข้อความตัวอักษรอย่างง่าย */
export function textMessage(text: string): LineMessage {
  return { type: "text", text };
}

async function logMessage(
  apiType: string,
  targetId: string | null,
  channel: string,
  ticketId: string | null,
  ok: boolean,
): Promise<void> {
  // การบันทึก log ต้องไม่ทำให้ flow หลักล้ม
  try {
    const sql = db();
    await sql`
      INSERT INTO message_logs (ticket_id, channel, api_type, target_id, succeeded)
      VALUES (${ticketId}, ${channel}, ${apiType}, ${targetId}, ${ok})
    `;
  } catch (e) {
    console.error("[message_logs]", e);
  }
}
