// ตัวช่วยเชื่อมต่อ LINE: ตรวจ ID token, ตรวจ signature ของ webhook, push/reply/multicast + บันทึก message_logs

import crypto from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTPayload } from "jose";
import { db } from "./db";
import { HttpError } from "./http";
import { envVar } from "./env";

const LINE_API = "https://api.line.me";
// การอัปโหลดรูปของ rich menu ต้องยิงไปที่โดเมนนี้เท่านั้น ยิงไป api.line.me จะได้ 404 เปล่า ๆ
const LINE_DATA_API = "https://api-data.line.me";

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

/**
 * ลบเมนูทิ้งจากบัญชี LINE — ใบที่สร้างผ่าน API ลบใน OA Manager ไม่ได้ ต้องลบทางนี้เท่านั้น
 *
 * ใบที่ยังมีคนผูกอยู่ก็ลบได้ คนกลุ่มนั้นจะกลายเป็นไม่มีเมนูทันที ฝั่งที่เรียกจึงต้องกันเอง
 * ว่าอย่าลบใบที่ระบบตั้งใช้อยู่ (ดู admin-richmenu.ts)
 *
 * 404 = ใบนั้นไม่มีอยู่แล้ว ซึ่งคือผลลัพธ์ที่ต้องการพอดี นับว่าสำเร็จ (callRichMenu จัดการให้แล้ว)
 */
/**
 * สร้าง rich menu ใบใหม่แล้วอัปโหลดรูปให้ — คืนรหัสใบที่สร้าง หรือข้อความบอกสาเหตุที่ไม่สำเร็จ
 *
 * สองขั้นตอน และคนละโดเมนกัน: สร้างโครงที่ api.line.me ส่วนอัปโหลดรูปต้องยิงไปที่
 * api-data.line.me เท่านั้น (ยิงผิดโดเมนจะได้ 404 ซึ่งอ่านแล้วไม่รู้เลยว่าผิดตรงไหน)
 *
 * ถ้าอัปโหลดรูปไม่สำเร็จ ต้องลบใบที่เพิ่งสร้างทิ้ง ไม่งั้นจะเหลือเมนูที่ไม่มีรูปค้างอยู่
 * ซึ่งผูกให้ใครไม่ได้ และไปโผล่ในรายการเมนูให้สับสนต่อ
 */
export async function createRichMenu(
  body: unknown,
  pngBase64: string,
): Promise<LineQuery<string>> {
  const token = envVar("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) return { ok: false, error: "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ที่ระบบนี้" };
  try {
    const made = await fetch(`${LINE_API}/v2/bot/richmenu`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const madeText = await made.text();
    if (!made.ok) {
      console.error("[line] สร้างเมนูไม่สำเร็จ", made.status, madeText);
      return { ok: false, error: `LINE ตอบกลับ ${made.status} · ${madeText.slice(0, 160)}` };
    }
    const id = (JSON.parse(madeText) as { richMenuId?: string }).richMenuId;
    if (!id) return { ok: false, error: "LINE ไม่ได้ส่งรหัสเมนูกลับมา" };

    const bin = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    const up = await fetch(`${LINE_DATA_API}/v2/bot/richmenu/${encodeURIComponent(id)}/content`, {
      method: "POST",
      headers: { "content-type": "image/png", authorization: `Bearer ${token}` },
      body: bin,
    });
    if (!up.ok) {
      const why = await up.text().catch(() => "");
      console.error("[line] อัปโหลดรูปเมนูไม่สำเร็จ", up.status, why);
      await deleteRichMenu(id);   // อย่าทิ้งเมนูที่ไม่มีรูปไว้ให้รก
      return { ok: false, error: `อัปโหลดรูปไม่สำเร็จ · LINE ตอบกลับ ${up.status} ${why.slice(0, 120)}` };
    }
    return { ok: true, data: id };
  } catch (e) {
    console.error("[line] สร้างเมนูไม่สำเร็จ", e);
    return { ok: false, error: "ต่อกับ LINE ไม่ได้" };
  }
}

export function deleteRichMenu(richMenuId: string): Promise<boolean> {
  return callRichMenu(`richmenu/${encodeURIComponent(richMenuId)}`, "DELETE");
}

export interface LineUserProfile {
  displayName: string;
  pictureUrl?: string;
}

/**
 * ชื่อกับรูปที่เจ้าตัวตั้งไว้ในไลน์ — ถามทีละคนด้วย userId
 *
 * ต่างจาก followers/ids ตรงที่เส้นทางนี้ไม่ได้จำกัดเฉพาะบัญชีที่ผ่านการยืนยัน แลกกับการที่
 * ต้องรู้ userId มาก่อน ซึ่งพอดีกับสิ่งที่ระบบมีอยู่แล้ว (เก็บ userId ของคนที่ทักเข้ามา)
 *
 * คืน null เมื่อ LINE ตอบ 404 — คนนี้บล็อก OA หรือเลิกเป็นเพื่อนไปแล้ว ต่างจาก ok:false
 * ซึ่งแปลว่าถาม LINE ไม่ได้ ต้องแยกให้ออกเพราะสิ่งที่ต้องทำต่อไม่เหมือนกัน
 */
export async function lineProfile(userId: string): Promise<LineQuery<LineUserProfile | null>> {
  return getFromLine<LineUserProfile | null>(`profile/${encodeURIComponent(userId)}`, () => null);
}

/**
 * รายชื่อ "ทุกคนที่เป็นเพื่อนกับ OA" จาก LINE โดยตรง — ทีละหน้า หน้าละไม่เกิน 1000 คน
 *
 * เป็นแหล่งเดียวที่ตอบได้ว่าใครเป็นเพื่อนบ้าง ระบบเองรู้จักแค่คนที่ลงทะเบียน คนที่ฝ่ายบุคคล
 * นำเข้ามา และคนที่เคยทักแชท ซึ่งไม่ใช่ทุกคน
 *
 * ข้อจำกัดของ LINE: เส้นทางนี้เปิดให้เฉพาะบัญชีที่ผ่านการยืนยัน (Verified) หรือ Premium
 * บัญชีทั่วไปจะถูกปฏิเสธ จึงต้องแยกให้ออกว่า "ขอไม่ได้เพราะบัญชียังไม่ผ่านการยืนยัน"
 * ไม่ใช่ "ไม่มีเพื่อนสักคน" — สองอย่างนี้ต้องบอกคนใช้ต่างกัน
 */
export async function followerIds(start?: string): Promise<LineQuery<{ ids: string[]; next: string | null }>> {
  const q = new URLSearchParams({ limit: "1000" });
  if (start) q.set("start", start);
  const r = await getFromLine<{ userIds?: string[]; next?: string }>(`followers/ids?${q.toString()}`);
  return r.ok ? { ok: true, data: { ids: r.data.userIds ?? [], next: r.data.next ?? null } } : r;
}

/**
 * ตั้งเมนูตั้งต้นของทั้ง OA — ทุกคนที่ "ไม่มีเมนูผูกไว้เป็นรายคน" จะเห็นใบนี้
 *
 * เป็นทางเดียวที่ไปถึงคนที่ระบบไม่รู้จักได้ เพราะการขอรายชื่อผู้ติดตามทั้งหมดจาก LINE
 * ต้องเป็นบัญชีที่ผ่านการยืนยันแล้วเท่านั้น บัญชีทั่วไปขอไม่ได้
 *
 * ข้อควรรู้: เมนูที่ผูกไว้เป็นรายคน "ชนะ" เมนูตั้งต้นเสมอ การตั้งใบนี้จึงไม่ทำให้คนที่
 * เคยถูกผูกใบอื่นไว้เปลี่ยนตาม ต้องไล่ผูกให้เป็นรายคนควบคู่กันไปด้วย
 */
export function setDefaultRichMenu(richMenuId: string): Promise<boolean> {
  return callRichMenu(`user/all/richmenu/${encodeURIComponent(richMenuId)}`, "POST");
}

/** ยกเลิกเมนูตั้งต้นของทั้ง OA */
export function clearDefaultRichMenu(): Promise<boolean> {
  return callRichMenu("user/all/richmenu", "DELETE");
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
