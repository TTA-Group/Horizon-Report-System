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

/** ตรวจลายเซ็นด้วยกุญแจชุดปัจจุบัน — คืน null ถ้าลายเซ็น/อายุ/ผู้รับไม่ผ่าน */
async function tryVerify(idToken: string, clientId: string, refresh: boolean): Promise<JWTPayload | null> {
  const keys = createLocalJWKSet(await lineJwks(refresh));
  try {
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: "https://access.line.me",
      audience: clientId,
    });
    return payload;
  } catch {
    return null;
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
  let payload = await tryVerify(idToken, clientId, false);
  // ถ้าใช้กุญแจที่แคชไว้แล้วไม่ผ่าน อาจเป็นเพราะ LINE เปลี่ยนกุญแจ — ดึงใหม่แล้วลองอีกครั้งเดียว
  if (!payload && usedCache) payload = await tryVerify(idToken, clientId, true);
  if (!payload) throw new HttpError(401, "invalid LINE id token");

  if (typeof payload.sub !== "string") throw new HttpError(401, "invalid LINE id token payload");
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
