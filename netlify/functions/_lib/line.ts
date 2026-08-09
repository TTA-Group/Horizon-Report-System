// ตัวช่วยเชื่อมต่อ LINE: ตรวจ ID token, ตรวจ signature ของ webhook, push/reply/multicast + บันทึก message_logs

import crypto from "node:crypto";
import { db } from "./db";
import { HttpError } from "./http";

const LINE_API = "https://api.line.me";

export interface LineProfile {
  sub: string; // = userId ที่เชื่อถือได้
  name?: string;
  picture?: string;
  email?: string;
}

/**
 * ตรวจสอบ LINE ID token ฝั่ง server แล้วคืน payload ที่เชื่อถือได้
 * ห้ามเชื่อ userId ที่ client ส่งมาตรง ๆ (spec หัวข้อ 5.1 / 10)
 */
export async function verifyIdToken(idToken: string): Promise<LineProfile> {
  const clientId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!clientId) throw new Error("LINE_LOGIN_CHANNEL_ID is not set");

  const res = await fetch(`${LINE_API}/oauth2/v2.1/verify`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: clientId }),
  });
  if (!res.ok) throw new HttpError(401, "invalid LINE id token");

  const p = (await res.json()) as {
    sub: string;
    name?: string;
    picture?: string;
    email?: string;
  };
  if (!p.sub) throw new HttpError(401, "invalid LINE id token payload");
  return { sub: p.sub, name: p.name, picture: p.picture, email: p.email };
}

/** ตรวจ signature ของ webhook ด้วย X-Line-Signature (spec หัวข้อ 7) */
export function verifyLineSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET;
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
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
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
