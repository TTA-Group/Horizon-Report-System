// POST /api/line/webhook — รับ postback และ event จาก LINE (spec หัวข้อ 5.3 / 6 / 7)
//
// - ตรวจ X-Line-Signature ทุกครั้ง
// - postback: action=ack|complete|transfer (จากปุ่มใน Flex Message)
// - join: เก็บ groupId ของกลุ่มฝ่ายไว้ตั้งค่าใน departments.line_group_id

import {
  ADMIN_DEPARTMENT_CODE,
  adminCodes,
  CATEGORY_BY_CODE,
  CHANNEL_KEY, CHANNEL_KEYS_READ,
  DUE_BY_KEY,
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  type StatusCode,
  type UrgencyCode,
} from "./_lib/constants";
import { db } from "./_lib/db";
import {
  assessmentAskCard,
  buildCompactFlex,
  buildTicketFlex,
  dueAskCard,
  needAssessCard,
  ratingAskCard,
  rateInAppCard,
  waitDateCard,
  type TicketFlexInput,
} from "./_lib/flex";
import { HttpError, json, methodGuard, run } from "./_lib/http";
import { syncRichMenu } from "./_lib/richmenu";
import { pushTo, replyTo, textMessage, verifyLineSignature, type LineMessage } from "./_lib/line";
import { tellGroupMoved } from "./_lib/ticket-card";
import { dueFromOption, dueFromPickedDate, shortName, thaiDateShort, thaiDateTimeShort } from "./_lib/tickets";
import { envVar } from "./_lib/env";

interface LineSource {
  type: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}
interface LineEvent {
  type: string;
  replyToken?: string;
  source?: LineSource;
  postback?: { data: string; params?: { date?: string; time?: string; datetime?: string } };
  message?: { type: string; text?: string };
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const raw = await req.text();
    const signature = req.headers.get("x-line-signature");
    if (!verifyLineSignature(raw, signature)) {
      throw new HttpError(401, "invalid signature");
    }

    let payload: { events?: LineEvent[] } | null = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null; // body ไม่ใช่ JSON — ให้ระบบเดิมตัดสินใจเอง แล้วตอบ 200 ไม่ให้ LINE retry
    }
    const events = payload?.events ?? [];

    // ใช้ OA ร่วมกับระบบอื่น (เช่น ระบบจองนวด): ส่งต่อ event ต้นฉบับให้ระบบเดิมก่อนเสมอ
    // ระบบเดิมจะได้รับ webhook เหมือนที่ LINE เคยส่งให้ทุกอย่าง จึงทำงานต่อได้ตามปกติ
    //
    // ยกเว้นกรณีเดียว: ชุด event ที่เป็นของระบบเราล้วน ๆ ระบบเดิมไม่ได้ใช้ข้อมูลนี้
    // แต่จะถูกปลุกให้ทำงาน (และอาจบันทึกแถวขยะลงปลายทาง) ทุกครั้งที่เจ้าหน้าที่กดปุ่มในการ์ด
    // ถ้ามี event อื่นปนมาแม้แต่รายการเดียว ให้ส่งต่อทั้งก้อนตามเดิม — ห้ามตัดแก้ body
    // เพราะ signature ผูกกับ body ต้นฉบับ ถ้าแก้แล้วระบบเดิมจะตรวจไม่ผ่าน
    if (!(events.length > 0 && events.every(isOwnEvent))) {
      await forwardToCoexisting(raw, signature);
    }

    if (!payload) return json({ ok: true });

    for (const ev of events) {
      try {
        await rememberFollower(ev);
        if (ev.type === "postback") await handlePostback(ev);
        else if (ev.type === "join") await handleJoin(ev);
        else if (ev.type === "message") await handleMessage(ev);
        else if (ev.type === "follow") await handleFollow(ev);
      } catch (e) {
        console.error("[webhook event]", e);
      }
    }
    // ต้องตอบ 200 เสมอเพื่อไม่ให้ LINE ส่งซ้ำ
    return json({ ok: true });
  });

/**
 * จำไว้ว่าเคยเห็นบัญชีไลน์นี้ — ใครที่ทักมาหรือแอดเพื่อน ถือว่าระบบรู้จักแล้ว
 *
 * มีเพราะปุ่ม "เปลี่ยน rich menu ให้ทุกคน" ไปถึงได้เฉพาะคนที่ระบบรู้จัก และการขอรายชื่อ
 * ผู้ติดตามทั้งหมดจาก LINE ต้องเป็นบัญชีที่ผ่านการยืนยันแล้วเท่านั้น บัญชีทั่วไปขอไม่ได้
 * ทางเดียวที่เหลือคือเก็บสะสมเองจากคนที่เข้ามาคุย ซึ่งครอบคลุมขึ้นเรื่อย ๆ เองโดยไม่ต้องทำอะไร
 *
 * เก็บแค่รหัสผู้ใช้ ไม่ถามชื่อเพิ่ม เพราะการถามโปรไฟล์ทีละคนกินโควตาคำขอย่อยของ Worker
 * และชื่อไม่ได้จำเป็นกับการตั้งเมนู · ถ้ามีอยู่แล้วก็ไม่เขียนทับชื่อที่ฝ่ายบุคคลเคยนำเข้าไว้
 */
async function rememberFollower(ev: LineEvent): Promise<void> {
  const userId = ev.source?.userId;
  if (!userId || ev.source?.type !== "user") return;
  try {
    await db()`
      INSERT INTO line_followers (line_user_id) VALUES (${userId})
      ON CONFLICT (line_user_id) DO UPDATE SET fetched_at = now()
    `;
  } catch (e) {
    console.error("[followers] จำบัญชีไลน์ไม่สำเร็จ", e);
  }
}

const OWN_ACTIONS = new Set([
  "ack", "complete", "transfer", "cancel", "assess", "due", "duedate",
  "note", "nonote", "progress", "partsok", "rate", "praise",
]);

/**
 * เป็น event ที่เกิดจากระบบนี้เองหรือไม่
 * - การกดปุ่มในการ์ด: แนบ ticket= มาด้วยเสมอ และใช้ action ที่ระบบนี้กำหนดไว้เท่านั้น
 * - คำสั่งที่ระบบนี้กำหนดเอง: "groupid" และข้อความยกเลิกที่ปุ่มเติมรูปแบบให้ล่วงหน้า
 * ทั้งหมดนี้ระบบอื่นบน OA เดียวกันไม่ได้ใช้ จึงไม่ต้องส่งต่อให้เขา
 */
function isOwnEvent(ev: LineEvent): boolean {
  if (ev.type === "postback") {
    const data = new URLSearchParams(ev.postback?.data ?? "");
    return Boolean(data.get("ticket")) && OWN_ACTIONS.has(data.get("action") ?? "");
  }
  if (ev.type === "message" && ev.message?.type === "text") {
    const text = (ev.message.text ?? "").trim();
    const cmd = text.toLowerCase();
    return (
      cmd === "groupid" ||
      BIND_RE.test(text) ||
      WHICH_RE.test(text) ||
      CANCEL_RE.test(text) ||
      NOTE_RE.test(text) ||
      PROGRESS_RE.test(text)
    );
  }
  return false;
}

/**
 * ส่งต่อ webhook ต้นฉบับให้ระบบอื่นที่ใช้ OA เดียวกัน (ตั้งค่า MASSAGE_WEBHOOK_URL)
 * ส่ง body และ X-Line-Signature เดิมไปตรง ๆ ระบบเดิมจึงตรวจ signature ผ่านและทำงานต่อได้
 *
 * จำกัดเวลารอไว้ไม่เกิน 4 วินาที — ถ้าระบบปลายทางตอบช้า (เช่น Power Automate ที่มักตอบช้า
 * กว่าระบบทั่วไป) จะไม่ทำให้ระบบเราตอบ LINE ช้าตามไปด้วยจนหมดเวลา (LINE รอ response ของเรา
 * อยู่ ไม่ได้รอของระบบปลายทาง) ปล่อยให้คำขอที่ส่งไปแล้วทำงานต่อเองในเบื้องหลัง
 */
async function forwardToCoexisting(rawBody: string, signature: string | null): Promise<void> {
  const url = envVar("MASSAGE_WEBHOOK_URL");
  if (!url) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature ? { "x-line-signature": signature } : {}),
      },
      body: rawBody,
      signal: controller.signal,
    });
  } catch (e) {
    console.error("[forward coexisting]", e);
  } finally {
    clearTimeout(timeout);
  }
}

// รูปแบบข้อความยกเลิก — ตรงกับ fillInText ของปุ่ม "ยกเลิกเรื่อง" ที่เติมให้ล่วงหน้าในแป้นพิมพ์
// เก็บเลขที่เรื่องไว้ในตัวข้อความเอง ระบบจึงไม่ต้องจำว่าใครกำลังยกเลิกเรื่องไหนค้างอยู่
const CANCEL_RE = /^ยกเลิก\s+([A-Za-z]{2,4}-\d{4}-\d{3})\s*[:：]\s*([\s\S]*)$/;
// ข้อความที่พิมพ์ต่อท้ายปุ่ม — ข้อความตั้งต้นถูกเติมให้แล้ว ผู้ใช้พิมพ์แค่ส่วนหลังโคลอน
const NOTE_RE = /^ผลตรวจ\s+([A-Za-z]{2,4}-\d{4}-\d{3})\s*[:：]\s*([\s\S]*)$/;
const PROGRESS_RE = /^อัปเดต\s+([A-Za-z]{2,4}-\d{4}-\d{3})\s*[:：]\s*([\s\S]*)$/;
// ผูกกลุ่มนี้เข้ากับฝ่ายหนึ่ง — พิมพ์ในกลุ่มโดยผู้ดูแลระบบ แทนการเข้าไปแก้ตาราง departments ด้วยมือ
// แต่ละฝ่ายมีกลุ่มของตัวเองได้ ข้อความของฝ่ายอื่นจะได้ไม่ปนกันจนไล่ไม่ทัน
const BIND_RE = /^(?:ผูกฝ่าย|ผูกกลุ่ม)\s+([A-Za-z]{2,6})$/i;
// ขอดูว่ากลุ่มนี้เป็นของฝ่ายไหน และฝ่ายไหนยังไม่มีกลุ่ม
const WHICH_RE = /^(?:ฝ่ายนี้|กลุ่มนี้|ตรวจกลุ่ม)$/;

/**
 * มีคนแอดเพื่อนกับ LINE OA — ให้เมนูที่ตรงกับสถานะของเขา
 *
 * ระบบนี้ไม่ได้ตั้ง default rich menu ไว้ (ตั้งแล้วคนที่ลาออกจะตกกลับไปเห็นเมนูตั้งต้น
 * ซึ่งมีปุ่มลงทะเบียน) เมนูจึงต้องผูกให้ทีละคน และจุดแรกสุดที่ทำได้คือตอนแอดเพื่อน
 *
 * คนที่เคยแอดแล้วบล็อกไปแล้วกลับมาแอดใหม่ก็เข้าทางนี้ ซึ่งได้เมนูถูกต้องเหมือนกัน
 * เพราะ syncRichMenu อ่านสถานะจริงจากฐานข้อมูล ไม่ได้เดาจากว่าเป็นคนใหม่หรือคนเก่า
 */
async function handleFollow(ev: LineEvent): Promise<void> {
  const userId = ev.source?.userId;
  if (userId) await syncRichMenu(userId);
}

async function handleMessage(ev: LineEvent): Promise<void> {
  if (ev.message?.type !== "text") return;
  const text = (ev.message.text ?? "").trim();
  if (text.toLowerCase() === "groupid") return handleGroupIdRequest(ev);
  const bind = BIND_RE.exec(text);
  if (bind) return handleBindGroup(ev, bind[1].toUpperCase());
  if (WHICH_RE.test(text)) return handleWhichDept(ev);
  if (CANCEL_RE.test(text)) return handleCancelMessage(ev, text);
  if (NOTE_RE.test(text)) return handleNoteMessage(ev, text);
  if (PROGRESS_RE.test(text)) return handleProgressMessage(ev, text);
}

/**
 * ยกเลิกเรื่องพร้อมเหตุผล — ผู้ใช้กดปุ่ม "ยกเลิกเรื่อง" แป้นพิมพ์เปิดขึ้นพร้อมข้อความตั้งต้น
 * "ยกเลิก <เลขที่เรื่อง>: " แล้วพิมพ์เหตุผลต่อท้ายก่อนส่ง — เหตุผลถูกบันทึกลงประวัติของเรื่อง
 * และแจ้งกลับผู้แจ้ง เพราะการยกเลิกงานของคนอื่นต้องอธิบายได้เสมอว่ายกเลิกเพราะอะไร
 */
async function handleCancelMessage(ev: LineEvent, text: string): Promise<void> {
  const replyToken = ev.replyToken;
  const userId = ev.source?.userId;
  if (!userId) return;

  const m = CANCEL_RE.exec(text);
  if (!m) return;
  const ticketNo = m[1].toUpperCase();
  const reason = m[2].trim();
  if (!reason) {
    return say(replyToken, `กรุณาพิมพ์เหตุผลต่อท้ายด้วย เช่น\nยกเลิก ${ticketNo}: แจ้งซ้ำกับเรื่องเดิม`);
  }

  const res = await loadContext(userId, { ticketNo });
  if (!res.ok) {
    if (res.reason === "no-actor") return say(replyToken, "กรุณายืนยันตัวตนในระบบก่อนใช้งานคำสั่งนี้");
    return say(replyToken, `ไม่พบเรื่องเลขที่ ${ticketNo}`);
  }
  const { actor, isMember, t } = res;
  if (actor.status === "suspended") return say(replyToken, "บัญชีของคุณถูกระงับสิทธิ์การใช้งาน");
  if (!canAct(actor, isMember)) return say(replyToken, "คุณไม่ใช่เจ้าหน้าที่ของฝ่ายที่รับผิดชอบเรื่องนี้");

  const blocked = transitionBlocked(t, "cancelled");
  if (blocked) return replyStale(replyToken, blocked, t);

  const sql = db();
  const done = await sql<{ n: number }[]>`
    WITH upd AS (
      UPDATE tickets SET status='cancelled', updated_at=now()
      WHERE id=${t.id} AND status=${t.status}
      RETURNING id
    ), ev AS (
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      SELECT id, ${t.status}, 'cancelled', ${actor.id}, ${reason} FROM upd RETURNING ticket_id
    )
    SELECT count(*)::int AS n FROM upd
  `;
  if (done[0].n === 0) return replyLatest(replyToken, userId, t.id, "สถานะถูกเปลี่ยนไปแล้ว");

  await replyCard(replyToken, cardFor(t, { status: "cancelled", cancelReason: reason, actorName: actor.full_name, ...justNow(actor.full_name) }));
  await tellReporter(t.reporter_line_user_id, `เรื่อง ${t.ticket_no} ถูกยกเลิก\nเหตุผล: ${reason}`, t.id);
}

/**
 * เจ้าหน้าที่พิมพ์อาการที่พบต่อท้ายปุ่ม "แจ้งผลตรวจสอบ"
 *
 * ถือว่าตรวจสอบครบก็ต่อเมื่อมีทั้งกำหนดเสร็จและคำตอบเรื่องอาการ ถ้ายังไม่ได้เลือกกำหนดเสร็จ
 * ให้ย้อนไปถามก่อน ไม่บันทึกครึ่ง ๆ กลาง ๆ ไว้แล้วปล่อยให้เข้าใจว่าทำครบแล้ว
 */
async function handleNoteMessage(ev: LineEvent, text: string): Promise<void> {
  const m = NOTE_RE.exec(text);
  const userId = ev.source?.userId;
  if (!m || !userId) return;
  const note = m[2].trim();
  const res = await loadTicketForActor(ev, m[1].toUpperCase());
  if (!res) return;
  const { actor, t } = res;
  if (!note) return say(ev.replyToken, `กรุณาพิมพ์อาการที่พบต่อท้ายด้วย เช่น\nผลตรวจ ${t.ticket_no}: พาวเวอร์ซัพพลายเสีย`);
  if (!t.due_at) return replyMessage(ev.replyToken, dueAskCard(t.id, t.ticket_no));
  await saveAssessment(ev, actor, t, note);
}

/** เจ้าหน้าที่พิมพ์ความคืบหน้าต่อท้ายปุ่ม "อัปเดตความคืบหน้า" — บันทึกและส่งถึงผู้แจ้ง */
async function handleProgressMessage(ev: LineEvent, text: string): Promise<void> {
  const m = PROGRESS_RE.exec(text);
  const userId = ev.source?.userId;
  if (!m || !userId) return;
  const note = m[2].trim();
  const res = await loadTicketForActor(ev, m[1].toUpperCase());
  if (!res) return;
  const { actor, t } = res;
  if (!note) return say(ev.replyToken, `กรุณาพิมพ์ความคืบหน้าต่อท้ายด้วย เช่น\nอัปเดต ${t.ticket_no}: สั่งอะไหล่แล้ว รอของ`);

  const sql = db();
  await sql`
    WITH upd AS (
      UPDATE tickets SET last_progress_remind_at = now(), updated_at = now() WHERE id = ${t.id} RETURNING id
    )
    INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
    SELECT id, ${t.status}, ${t.status}, ${actor.id}, ${"อัปเดต: " + note} FROM upd
  `;
  await replyCard(ev.replyToken, cardFor(t, justNow(actor.full_name)));
  await tellReporter(
    t.reporter_line_user_id,
    `อัปเดตเรื่อง ${t.ticket_no}\n${note}\nโดย ${shortName(actor.full_name)}`,
    t.id,
  );
}

/** ด่านตรวจชุดเดียวกันของทุกคำสั่งที่พิมพ์: ต้องผูกบัญชี ไม่ถูกระงับ และเป็นเจ้าหน้าที่ของฝ่ายนั้น */
async function loadTicketForActor(
  ev: LineEvent,
  ticketNo: string,
): Promise<{ actor: ActorRow; t: TicketRow } | null> {
  const userId = ev.source?.userId;
  if (!userId) return null;
  const res = await loadContext(userId, { ticketNo });
  if (!res.ok) {
    if (res.reason === "no-actor") await say(ev.replyToken, "กรุณายืนยันตัวตนในระบบก่อนใช้งานคำสั่งนี้");
    else await say(ev.replyToken, `ไม่พบเรื่องเลขที่ ${ticketNo}`);
    return null;
  }
  if (res.actor.status === "suspended") {
    await say(ev.replyToken, "บัญชีของคุณถูกระงับสิทธิ์การใช้งาน");
    return null;
  }
  if (!canAct(res.actor, res.isMember)) {
    await say(ev.replyToken, "คุณไม่ใช่เจ้าหน้าที่ของฝ่ายที่รับผิดชอบเรื่องนี้");
    return null;
  }
  return { actor: res.actor, t: res.t };
}

/**
 * บันทึกผลตรวจสอบให้ครบ แล้วแจ้งผู้แจ้งข้อความเดียวที่บอกทั้งอาการและกำหนดเสร็จ
 * note = null คือติ๊กว่าไม่มีคำอธิบายเพิ่มเติม
 */
async function saveAssessment(ev: LineEvent, actor: ActorRow, t: TicketRow, note: string | null): Promise<void> {
  const sql = db();
  await sql`
    WITH upd AS (
      UPDATE tickets SET assessment = ${note}, assessed_at = now(),
        last_progress_remind_at = NULL, progress_remind_count = 0, updated_at = now()
      WHERE id = ${t.id} RETURNING id
    )
    INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
    SELECT id, ${t.status}, ${t.status}, ${actor.id}, ${"แจ้งผลตรวจสอบ" + (note ? ": " + note : "")} FROM upd
  `;

  const when = [t.due_label, t.due_at ? thaiDateShort(new Date(t.due_at)) : null].filter(Boolean).join(" · ");
  const fresh: Partial<TicketFlexInput> = {
    assessed: true,
    assessment: note,
    ...justNow(actor.full_name),
  };
  await replyCard(ev.replyToken, cardFor(t, fresh));
  await tellReporter(
    t.reporter_line_user_id,
    [
      `${t.ticket_no} ตรวจสอบแล้ว`,
      note ? `อาการ: ${note}` : null,
      `${t.waiting_parts ? "รออะไหล่ ถึง" : "คาดว่าเสร็จ"}: ${when}`,
      `ผู้รับผิดชอบ: ${shortName(t.assignee_name ?? actor.full_name)}`,
    ]
      .filter(Boolean)
      .join("\n"),
    t.id,
  );
}

async function replyMessage(replyToken: string | undefined, msg: LineMessage): Promise<void> {
  if (replyToken) await replyTo(replyToken, [msg]);
}

/**
 * พิมพ์คำว่า "groupid" ในกลุ่ม แล้วระบบตอบรหัสกลุ่มกลับมา
 *
 * event `join` เกิดขึ้นครั้งเดียวตอนเชิญบอทเข้ากลุ่ม ถ้าบอทอยู่ในกลุ่มอยู่แล้วจะไม่มีทางรู้ groupId
 * เลยนอกจากเตะออกแล้วเชิญใหม่ — คำสั่งนี้จึงมีไว้ขอค่าเดิมซ้ำได้ทุกเมื่อ
 * ใช้การตอบกลับ (reply) ไม่ใช่ push จึงไม่กินโควตาข้อความของ OA
 */
async function handleGroupIdRequest(ev: LineEvent): Promise<void> {
  if (ev.message?.type !== "text") return;
  if (ev.message.text?.trim().toLowerCase() !== "groupid") return;
  if (!ev.replyToken) return;

  const groupId = ev.source?.groupId ?? ev.source?.roomId;
  await replyTo(ev.replyToken, [
    textMessage(
      groupId
        ? `groupId ของกลุ่มนี้คือ\n${groupId}\n\nถ้าจะตั้งให้กลุ่มนี้เป็นกลุ่มของฝ่ายใดฝ่ายหนึ่ง ไม่ต้องใช้ค่านี้ ให้ผู้ดูแลระบบพิมพ์\n${BIND_HINT}`
        : "คำสั่งนี้ใช้ได้เฉพาะในกลุ่มเท่านั้น",
    ),
  ]);
}

async function handleJoin(ev: LineEvent): Promise<void> {
  const groupId = ev.source?.groupId ?? ev.source?.roomId;
  if (!groupId || !ev.replyToken) return;
  await replyTo(ev.replyToken, [
    textMessage(
      "เพิ่มบอทเข้ากลุ่มเรียบร้อย\n\n" +
        "กลุ่มนี้ยังไม่ผูกกับฝ่ายไหน จึงยังไม่มีเรื่องแจ้งเข้ามา\n" +
        "ให้ผู้ดูแลระบบพิมพ์คำสั่งนี้ในกลุ่ม เพื่อบอกว่ากลุ่มนี้เป็นของฝ่ายไหน\n\n" +
        `${BIND_HINT}\n\n` +
        'พิมพ์ "ฝ่ายนี้" เพื่อดูว่าตอนนี้ฝ่ายไหนใช้กลุ่มไหนอยู่',
    ),
  ]);
}

/** ตัวอย่างคำสั่งผูกกลุ่ม ใช้ซ้ำในหลายข้อความ จะได้ไม่เขียนต่างกันจนคนอ่านสับสน */
const BIND_HINT = "ผูกฝ่าย IT      (กลุ่มของฝ่ายไอที)\nผูกฝ่าย ADM   (กลุ่มของฝ่ายอาคาร/ธุรการ)\nผูกฝ่าย GEN   (กลุ่มของเรื่องอื่น ๆ)";

interface DeptBinding {
  code: string;
  name: string;
  line_group_id: string | null;
}

/** ฝ่ายที่รับเรื่องได้ทั้งหมด พร้อมกลุ่มที่ผูกไว้ — ใช้ทั้งตอนผูกและตอนตรวจ */
async function bindableDepts(): Promise<DeptBinding[]> {
  const rows = await db()<DeptBinding[]>`
    SELECT code, name, line_group_id FROM departments
    WHERE is_active = true AND receives_tickets = true ORDER BY code
  `;
  return [...rows];
}

/** คนที่พิมพ์คำสั่งเป็นผู้ดูแลระบบไหม — เกณฑ์เดียวกับที่ใช้ในแอป (อยู่ฝ่าย HR หรืออยู่ในรายชื่อสำรอง) */
async function isAdminActor(actor: ActorRow): Promise<boolean> {
  if (adminCodes().has(actor.employee_code)) return true;
  const rows = await db()`
    SELECT 1 FROM department_members dm
    JOIN departments d ON d.id = dm.department_id
    WHERE dm.employee_id = ${actor.id} AND d.code = ${ADMIN_DEPARTMENT_CODE} LIMIT 1
  `;
  return rows.length > 0;
}

/** บรรทัดสรุปว่าฝ่ายไหนอยู่กลุ่มไหน เทียบกับกลุ่มที่กำลังพิมพ์คำสั่งอยู่ */
function bindingLines(depts: DeptBinding[], hereGroupId: string): string {
  return depts
    .map((d) => {
      const where = !d.line_group_id
        ? "ยังไม่มีกลุ่ม"
        : d.line_group_id === hereGroupId
          ? "กลุ่มนี้"
          : "อยู่กลุ่มอื่น";
      return `${d.code} · ${d.name} — ${where}`;
    })
    .join("\n");
}

/**
 * "ผูกฝ่าย <รหัส>" — ตั้งกลุ่มที่พิมพ์คำสั่งให้เป็นกลุ่มของฝ่ายนั้น
 *
 * มีคำสั่งนี้เพราะทางเลือกเดียวก่อนหน้าคือให้ผู้ดูแลเข้าไปแก้ line_group_id ในตารางเอง
 * ซึ่งต้องใช้ SQL และเป็นขั้นตอนที่พลาดง่ายที่สุดของการติดตั้ง (ผูกผิดฝ่าย = เรื่องไปโผล่ผิดกลุ่ม)
 * ตอบกลับด้วย reply ไม่ใช่ push จึงไม่กินโควตา
 */
async function handleBindGroup(ev: LineEvent, code: string): Promise<void> {
  const replyToken = ev.replyToken;
  if (!replyToken) return;
  const groupId = ev.source?.groupId ?? ev.source?.roomId;
  if (!groupId) return say(replyToken, "คำสั่งนี้ใช้ได้เฉพาะในกลุ่มเท่านั้น");

  const lineUserId = ev.source?.userId;
  const actor = lineUserId ? await resolveActor(lineUserId) : null;
  if (!actor || actor.status !== "active") {
    return say(replyToken, "ต้องผูกบัญชีไลน์กับข้อมูลพนักงานก่อน จึงจะใช้คำสั่งนี้ได้");
  }
  if (!(await isAdminActor(actor))) {
    return say(replyToken, "คำสั่งนี้ใช้ได้เฉพาะผู้ดูแลระบบ (ฝ่ายบุคคล) เท่านั้น");
  }

  const depts = await bindableDepts();
  const target = depts.find((d) => d.code === code);
  if (!target) {
    return say(replyToken, `ไม่พบฝ่ายรหัส ${code}\n\nฝ่ายที่ผูกได้:\n${depts.map((d) => `${d.code} · ${d.name}`).join("\n")}`);
  }

  // ฝ่ายอื่นที่ยังชี้มาที่กลุ่มนี้อยู่ — คือต้นเหตุที่ข้อความปนกัน
  const others = depts.filter((d) => d.code !== code && d.line_group_id === groupId);
  if (target.line_group_id === groupId && others.length === 0) {
    return say(replyToken, `กลุ่มนี้เป็นกลุ่มของ ${target.name} อยู่แล้ว\n\n${bindingLines(depts, groupId)}`);
  }

  // "ผูกฝ่าย X" แปลว่ากลุ่มนี้เป็นของ X และเป็นของ X เท่านั้น จึงปลดฝ่ายอื่นออกจากกลุ่มนี้ด้วย
  // ถ้าไม่ปลด คำสั่งนี้จะพากลับไปสู่สภาพเดิมไม่ได้เลยตอนที่ทุกฝ่ายเริ่มจากกลุ่มเดียวกัน —
  // พิมพ์แล้วระบบตอบว่า "เป็นอยู่แล้ว" ทั้งที่ยังปนกันอยู่ ซึ่งเป็นสิ่งที่ผู้ใช้กำลังพยายามแก้
  await db()`UPDATE departments SET line_group_id = ${groupId} WHERE code = ${code}`;
  if (others.length > 0) {
    await db()`
      UPDATE departments SET line_group_id = NULL
      WHERE line_group_id = ${groupId} AND code <> ${code}
    `;
  }

  const after = await bindableDepts();
  const parts = [`ตั้งกลุ่มนี้เป็นกลุ่มของ ${target.name} แล้ว`];
  if (target.line_group_id && target.line_group_id !== groupId) {
    parts.push("(ย้ายมาจากกลุ่มเดิม เรื่องที่ค้างอยู่จะมาอัปเดตที่กลุ่มนี้แทน)");
  }
  if (others.length > 0) {
    // ปลดออกไปแล้วต้องบอกให้ชัดว่าฝ่ายนั้นกำลังไม่มีกลุ่ม และต้องไปทำอะไรต่อ
    parts.push(
      `\nปลด ${others.map((d) => d.name).join(" และ ")} ออกจากกลุ่มนี้แล้ว ตอนนี้ยังไม่มีกลุ่ม\n` +
        "เรื่องของฝ่ายนั้นยังแจ้งเข้าระบบและดูในแอปได้ตามปกติ แต่จะไม่มีการ์ดเข้ากลุ่มไหน\n" +
        "จนกว่าจะไปพิมพ์คำสั่งนี้ในกลุ่มของแต่ละฝ่าย:\n" +
        others.map((d) => `ผูกฝ่าย ${d.code}`).join("\n"),
    );
  }
  parts.push(`\nสถานะตอนนี้\n${bindingLines(after, groupId)}`);
  await say(replyToken, parts.join("\n"));
}

/** "ฝ่ายนี้" — ตรวจว่าตั้งค่ากลุ่มครบและถูกต้องหรือยัง โดยไม่ต้องเปิดฐานข้อมูลดู */
async function handleWhichDept(ev: LineEvent): Promise<void> {
  const replyToken = ev.replyToken;
  if (!replyToken) return;
  const groupId = ev.source?.groupId ?? ev.source?.roomId;
  if (!groupId) return say(replyToken, "คำสั่งนี้ใช้ได้เฉพาะในกลุ่มเท่านั้น");

  const depts = await bindableDepts();
  const here = depts.filter((d) => d.line_group_id === groupId);
  const head =
    here.length === 0
      ? "กลุ่มนี้ยังไม่ผูกกับฝ่ายไหน จึงยังไม่มีเรื่องแจ้งเข้ามา"
      : here.length === 1
        ? `กลุ่มนี้เป็นกลุ่มของ ${here[0].name}`
        : `กลุ่มนี้รับเรื่องของ ${here.length} ฝ่ายรวมกัน (${here.map((d) => d.name).join(" · ")})\n` +
          "ข้อความของทุกฝ่ายจึงมากองรวมกันที่นี่\n" +
          `ถ้าจะแยก ให้สร้างกลุ่มของแต่ละฝ่าย แล้วพิมพ์ "ผูกฝ่าย <รหัสฝ่าย>" ในกลุ่มนั้น`;
  const tail = depts.some((d) => !d.line_group_id) ? `\n\nฝ่ายที่ยังไม่มีกลุ่ม สั่งได้ด้วย\n${BIND_HINT}` : "";
  await say(replyToken, `${head}\n\n${bindingLines(depts, groupId)}${tail}`);
}

interface TicketRow {
  id: string;
  status: StatusCode;
  department_id: string;
  department_code: string;
  department_name: string;
  department_group_id: string | null;
  reporter_id: string;
  ticket_no: string;
  category_code: string;
  floor: string;
  location_note: string | null;
  detail: string;
  urgency: string;
  created_at: string;
  reporter_name: string;
  reporter_dept: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  reporter_line_user_id: string | null;
  last_actor_name: string | null;
  last_at: string | null;
  photos: string[] | null;
  due_at: string | null;
  due_label: string | null;
  assessment: string | null;
  assessed_at: string | null;
  waiting_parts: boolean;
}

interface ActorRow {
  id: string;
  full_name: string;
  employee_code: string;
  status: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ผู้กดปุ่ม/ผู้พิมพ์คำสั่ง — ต้องผูกบัญชีไลน์กับพนักงานไว้แล้ว */
async function resolveActor(lineUserId: string): Promise<ActorRow | null> {
  const sql = db();
  const rows = await sql<ActorRow[]>`
    SELECT e.id, e.full_name, e.employee_code, e.status
    FROM line_accounts la JOIN employees e ON e.id = la.employee_id
    WHERE la.line_user_id = ${lineUserId} AND la.channel_key = ANY(${CHANNEL_KEYS_READ}) LIMIT 1
  `;
  return rows[0] ?? null;
}

type LoadResult =
  | { ok: true; actor: ActorRow; isMember: boolean; t: TicketRow }
  | { ok: false; reason: "no-actor" | "no-ticket" };

/**
 * อ่านทุกอย่างที่ต้องใช้ในคำขอเดียว: ผู้กด เรื่อง ฝ่าย ผู้รับผิดชอบ สิทธิ์ และไลน์ของผู้แจ้ง
 *
 * รวมเป็น query เดียวเพราะแต่ละครั้งที่คุยกับฐานข้อมูลคือการวิ่งไปกลับจริง ๆ ครั้งหนึ่ง
 * ยิ่งหลายรอบ ผู้กดปุ่มยิ่งต้องรอนานกว่าการ์ดจะเด้ง แล้วก็จะกดซ้ำ
 */
async function loadContext(lineUserId: string, by: { id: string } | { ticketNo: string }): Promise<LoadResult> {
  const sql = db();
  const match = "id" in by ? sql`t.id = ${by.id}` : sql`t.ticket_no = ${by.ticketNo}`;
  const rows = await sql<(TicketRow & ActorRow & { is_member: boolean })[]>`
    SELECT e.id, e.full_name, e.employee_code, e.status,
           t.id AS ticket_pk, t.status AS ticket_status, t.department_id, t.reporter_id,
           t.ticket_no, t.category_code, t.floor, t.location_note, t.detail, t.urgency,
           t.created_at, t.assignee_id,
           t.due_at, t.due_label, t.assessment, t.assessed_at, t.waiting_parts,
           r.full_name AS reporter_name, r.department_name AS reporter_dept,
           d.code AS department_code, d.name AS department_name, d.line_group_id AS department_group_id,
           a.full_name AS assignee_name,
           rl.line_user_id AS reporter_line_user_id,
           last.actor_name AS last_actor_name, last.at AS last_at,
           (SELECT array_agg(ta.file_url ORDER BY ta.created_at)
              FROM ticket_attachments ta
             WHERE ta.ticket_id = t.id AND ta.file_url IS NOT NULL) AS photos,
           (dm.employee_id IS NOT NULL) AS is_member
    FROM line_accounts la
    JOIN employees e ON e.id = la.employee_id
    JOIN tickets t ON ${match}
    JOIN employees r ON r.id = t.reporter_id
    JOIN departments d ON d.id = t.department_id
    LEFT JOIN employees a ON a.id = t.assignee_id
    LEFT JOIN department_members dm ON dm.department_id = t.department_id AND dm.employee_id = e.id
    LEFT JOIN line_accounts rl ON rl.employee_id = t.reporter_id AND rl.channel_key = ANY(${CHANNEL_KEYS_READ})
    -- ความเคลื่อนไหวล่าสุดที่ "คน" เป็นคนทำ (actor_id IS NOT NULL ตัดรายการเตือนซ้ำของระบบทิ้ง)
    -- อยู่ใน query เดียวกัน จึงไม่ได้เพิ่มรอบวิ่งไปฐานข้อมูล
    LEFT JOIN LATERAL (
      SELECT ae.full_name AS actor_name, ev.created_at AS at
      FROM ticket_events ev
      JOIN employees ae ON ae.id = ev.actor_id
      WHERE ev.ticket_id = t.id
      ORDER BY ev.created_at DESC
      LIMIT 1
    ) last ON true
    WHERE la.line_user_id = ${lineUserId} AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
    LIMIT 1
  `;

  if (rows.length === 0) {
    // ไม่มีแถวได้ 2 สาเหตุ แยกให้ออกเพื่อบอกผู้ใช้ให้ถูก — เกิดไม่บ่อย ยอมค้นเพิ่มอีกครั้งเฉพาะตอนพลาด
    const actor = await resolveActor(lineUserId);
    return { ok: false, reason: actor ? "no-ticket" : "no-actor" };
  }

  const row = rows[0] as unknown as Record<string, unknown>;
  return {
    ok: true,
    actor: {
      id: row.id as string,
      full_name: row.full_name as string,
      employee_code: row.employee_code as string,
      status: row.status as string,
    },
    isMember: row.is_member === true,
    t: {
      id: row.ticket_pk as string,
      status: row.ticket_status as StatusCode,
      department_id: row.department_id as string,
      department_code: row.department_code as string,
      department_name: row.department_name as string,
      reporter_id: row.reporter_id as string,
      ticket_no: row.ticket_no as string,
      category_code: row.category_code as string,
      floor: row.floor as string,
      location_note: row.location_note as string | null,
      detail: row.detail as string,
      urgency: row.urgency as string,
      created_at: row.created_at as string,
      reporter_name: row.reporter_name as string,
      reporter_dept: row.reporter_dept as string | null,
      department_group_id: row.department_group_id as string | null,
      assignee_id: row.assignee_id as string | null,
      assignee_name: row.assignee_name as string | null,
      reporter_line_user_id: row.reporter_line_user_id as string | null,
      last_actor_name: row.last_actor_name as string | null,
      last_at: row.last_at as string | null,
      photos: (row.photos as string[] | null) ?? null,
      due_at: row.due_at as string | null,
      due_label: row.due_label as string | null,
      assessment: row.assessment as string | null,
      assessed_at: row.assessed_at as string | null,
      waiting_parts: row.waiting_parts === true,
    },
  };
}

/** มีสิทธิ์จัดการเรื่องนี้ไหม — เจ้าหน้าที่ของฝ่ายนั้น หรือผู้ดูแลระบบ */
function canAct(actor: ActorRow, isMember: boolean): boolean {
  return isMember || adminCodes().has(actor.employee_code);
}

/** เปลี่ยนสถานะนี้ไม่ได้เพราะอะไร — คืน null ถ้าเปลี่ยนได้ */
function transitionBlocked(t: TicketRow, to: StatusCode): string | null {
  if ((STATUS_TRANSITIONS[t.status] ?? []).includes(to)) return null;
  return `เรื่อง ${t.ticket_no} อยู่ในสถานะ "${STATUS_LABELS[t.status] ?? t.status}" แล้ว ทำรายการนี้ไม่ได้`;
}

/**
 * การ์ดของเรื่องนี้ ตามสถานะที่เป็นอยู่ (ส่ง overrides เพื่อวาดสถานะใหม่ที่เพิ่งเปลี่ยนไป)
 *
 * ยังไม่มีผู้รับ = ใบเต็ม เพราะเป็นใบที่คนทั้งกลุ่มต้องอ่านให้ครบก่อนแย่งกันกดรับ
 * มีเจ้าของแล้ว = ใบย่อ เพราะทุกคนอ่านใบแรกไปแล้ว เหลือแค่บอกว่าคืบไปถึงไหน
 */
function cardFor(t: TicketRow, overrides: Partial<TicketFlexInput> = {}): LineMessage {
  const input: TicketFlexInput = {
    ticketId: t.id,
    ticketNo: t.ticket_no,
    status: t.status,
    departmentName: t.department_name,
    categoryLabel: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
    reporterName: t.reporter_name,
    reporterDept: t.reporter_dept,
    floor: t.floor,
    locationNote: t.location_note,
    detail: t.detail,
    urgency: t.urgency as UrgencyCode,
    createdAtLabel: thaiDateTimeShort(new Date(t.created_at)),
    assigneeName: t.assignee_name,
    latestActor: t.last_actor_name,
    latestAtLabel: t.last_at ? thaiDateTimeShort(new Date(t.last_at)) : null,
    photos: t.photos,
    assessed: t.assessed_at !== null,
    dueLabel: t.due_label,
    dueDateLabel: t.due_at ? thaiDateShort(new Date(t.due_at)) : null,
    waitingParts: t.waiting_parts,
    assessment: t.assessment,
    ...overrides,
  };
  return input.status === "pending" ? buildTicketFlex(input) : buildCompactFlex(input);
}

/** ค่าที่ต้องส่งให้การ์ดเมื่อผู้กดปุ่มเพิ่งทำรายการนี้เดี๋ยวนี้ */
function justNow(actorName: string): Partial<TicketFlexInput> {
  return { latestActor: actorName, latestAtLabel: thaiDateTimeShort() };
}

async function say(replyToken: string | undefined, text: string): Promise<void> {
  if (replyToken) await replyTo(replyToken, [textMessage(text)]);
}

async function replyCard(replyToken: string | undefined, card: LineMessage): Promise<void> {
  if (replyToken) await replyTo(replyToken, [card]);
}

/**
 * กดปุ่มบนการ์ดใบเก่าที่สถานะเลยไปแล้ว
 *
 * ไม่ตอบว่า "ทำไม่ได้" เฉย ๆ เพราะการ์ดเก่าค้างอยู่ในกลุ่มเป็นเรื่องปกติ (LINE แก้ข้อความเดิมไม่ได้)
 * และคนกดก็ไม่ได้ทำอะไรผิด — ตอบการ์ดล่าสุดกลับไปพร้อมกัน เขาจะได้กดต่อจากใบใหม่ได้ทันที
 * ในข้อความเดียว การตอบกลับแบบนี้ไม่กินโควตาข้อความของ OA
 */
async function replyStale(replyToken: string | undefined, reason: string, t: TicketRow): Promise<void> {
  if (!replyToken) return;
  await replyTo(replyToken, [textMessage(`${reason}\nนี่คือการ์ดล่าสุด กดต่อจากใบนี้ได้เลย`), cardFor(t)]);
}

/** เหมือน replyStale แต่ต้องอ่านสถานะล่าสุดใหม่ก่อน — ใช้ตอนมีคนชิงเปลี่ยนสถานะไปพร้อมกันพอดี */
async function replyLatest(
  replyToken: string | undefined,
  lineUserId: string,
  ticketId: string,
  reason: string,
): Promise<void> {
  const fresh = await loadContext(lineUserId, { id: ticketId });
  if (!fresh.ok) return say(replyToken, reason);
  await replyStale(replyToken, reason, fresh.t);
}

/** แจ้งผู้แจ้งด้วย line_user_id ที่อ่านมาแล้ว — ไม่ต้องวิ่งไปถามฐานข้อมูลซ้ำ */
async function tellReporter(lineUserId: string | null, text: string, ticketId: string): Promise<void> {
  if (!lineUserId) return;
  await pushTo(lineUserId, [textMessage(text)], { ticketId, channel: "user" });
}

/**
 * บันทึกกำหนดเสร็จ พร้อมนับจำนวนครั้งที่เลื่อน
 *
 * นับเฉพาะตอนที่เคยมีกำหนดอยู่แล้ว การตั้งครั้งแรกไม่ใช่การเลื่อน — ตัวเลขนี้ใช้ตัดสินว่า
 * งานไหนเลื่อนจนผิดปกติแล้วควรให้หัวหน้าฝ่ายรู้
 */
async function setDue(t: TicketRow, actor: ActorRow, due: Date, label: string, waiting: boolean): Promise<void> {
  const sql = db();
  await sql`
    WITH upd AS (
      UPDATE tickets
      SET due_at = ${due}, due_label = ${label}, waiting_parts = ${waiting},
          due_changes = due_changes + CASE WHEN due_at IS NULL THEN 0 ELSE 1 END,
          last_progress_remind_at = NULL, updated_at = now()
      WHERE id = ${t.id} RETURNING id
    )
    INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
    SELECT id, ${t.status}, ${t.status}, ${actor.id}, ${`กำหนดเสร็จ ${label} (${thaiDateShort(due)})`} FROM upd
  `;
  t.due_at = due.toISOString();
  t.due_label = label;
  t.waiting_parts = waiting;
}

/**
 * ผู้แจ้งกดดาว — บันทึกคะแนนแล้วชวนเลือกคำชมต่อ
 *
 * บันทึกทันทีตั้งแต่ขั้นนี้ ไม่รอให้เลือกคำชมก่อน เพราะคนส่วนใหญ่กดดาวแล้วหยุด
 * ถ้ารอจนครบสองขั้นถึงจะบันทึก คะแนนส่วนใหญ่จะหายไป
 */
/**
 * ปุ่มให้ดาวบนการ์ดใบเก่าที่ยังค้างอยู่ในแชท
 *
 * การให้คะแนนย้ายไปทำในแอปแล้ว (ดู /api/tickets/:id/rate) การ์ดที่ส่งไปก่อนหน้านี้แก้ไม่ได้
 * จึงตอบด้วยลิงก์เปิดแอปแทนที่จะปล่อยให้กดแล้วเงียบเหมือนปุ่มเสีย
 */
async function handleRateLegacy(ev: LineEvent, t: TicketRow): Promise<void> {
  await replyMessage(ev.replyToken, rateInAppCard(t.id, t.ticket_no));
}

async function handlePostback(ev: LineEvent): Promise<void> {
  const userId = ev.source?.userId;
  const replyToken = ev.replyToken;
  if (!userId || !ev.postback) return;

  const data = new URLSearchParams(ev.postback.data);
  const action = data.get("action");
  const ticketId = data.get("ticket");
  if (!action || !ticketId || !UUID_RE.test(ticketId)) return;

  // ปุ่มที่หน้าที่คือเปิดแป้นพิมพ์พร้อมข้อความตั้งต้นเท่านั้น งานจริงเกิดตอนผู้กดพิมพ์แล้วส่งออกมา
  // (ดู handleCancelMessage / handleNoteMessage / handleProgressMessage)
  if (action === "cancel" || action === "note" || action === "progress") return;

  const res = await loadContext(userId, { id: ticketId });
  if (!res.ok) {
    if (res.reason === "no-actor") return say(replyToken, "กรุณายืนยันตัวตนในระบบก่อนใช้งานปุ่มนี้");
    // การ์ดยังค้างอยู่ในกลุ่มแต่เรื่องถูกลบไปแล้ว — ตอบให้รู้ ไม่ปล่อยให้กดแล้วเงียบเหมือนปุ่มเสีย
    return say(replyToken, "ไม่พบเรื่องนี้ในระบบแล้ว การ์ดใบนี้อาจค้างอยู่จากก่อนที่ข้อมูลจะถูกลบ");
  }
  const { actor, isMember, t } = res;
  if (actor.status === "suspended") return say(replyToken, "บัญชีของคุณถูกระงับสิทธิ์การใช้งาน");

  // ปุ่มให้คะแนนเป็นของ "ผู้แจ้ง" ไม่ใช่เจ้าหน้าที่ จึงต้องอยู่ก่อนด่านตรวจสิทธิ์เจ้าหน้าที่
  if (action === "rate" || action === "praise") {
    if (t.reporter_id !== actor.id) return say(replyToken, "ให้คะแนนได้เฉพาะผู้แจ้งเรื่องนี้เท่านั้น");
    return handleRateLegacy(ev, t);
  }

  if (!canAct(actor, isMember)) return say(replyToken, "คุณไม่ใช่เจ้าหน้าที่ของฝ่ายที่รับผิดชอบเรื่องนี้");

  const sql = db();

  if (action === "ack") {
    // กดซ้ำเพราะการ์ดยังไม่ทันเด้ง — ถ้าเรื่องนี้เป็นของคนกดอยู่แล้ว ตอบการ์ดปัจจุบันไปเฉย ๆ
    // ดีกว่าขึ้นข้อความว่าทำไม่ได้ ซึ่งอ่านแล้วเหมือนกดพลาดทั้งที่รับเรื่องสำเร็จไปแล้ว
    if (t.status === "in_progress" && t.assignee_id === actor.id) {
      return replyCard(replyToken, cardFor(t));
    }
    const blocked = transitionBlocked(t, "in_progress");
    if (blocked) return replyStale(replyToken, blocked, t);

    // อัปเดตสถานะและบันทึกประวัติในคำสั่งเดียว — CTE ที่แก้ข้อมูลจะทำงานเสมอแม้ไม่ถูก SELECT อ่าน
    const done = await sql<{ n: number }[]>`
      WITH upd AS (
        UPDATE tickets SET status='in_progress', assignee_id=${actor.id},
          acknowledged_at=COALESCE(acknowledged_at, now()), updated_at=now()
        WHERE id=${ticketId} AND status='pending'
        RETURNING id
      ), ev AS (
        INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
        SELECT id, 'pending', 'in_progress', ${actor.id}, NULL FROM upd RETURNING ticket_id
      )
      SELECT count(*)::int AS n FROM upd
    `;
    if (done[0].n === 0) return replyLatest(replyToken, userId, ticketId, `เรื่อง ${t.ticket_no} มีผู้รับไปแล้ว`);

    // ตอบการ์ดก่อน แล้วค่อยแจ้งผู้แจ้ง — คนที่กดปุ่มยืนรออยู่ ส่วนผู้แจ้งช้าไปเสี้ยววินาทีไม่มีผล
    await replyCard(replyToken, cardFor(t, { status: "in_progress", assigneeName: actor.full_name, ...justNow(actor.full_name) }));
    await tellReporter(
      t.reporter_line_user_id,
      `อัปเดตเรื่อง ${t.ticket_no}\nสถานะ: ${STATUS_LABELS.in_progress}\nผู้รับผิดชอบ: ${shortName(actor.full_name)}`,
      ticketId,
    );
    return;
  }

  if (action === "complete") {
    if (t.status === "completed") return replyCard(replyToken, cardFor(t));
    const blocked = transitionBlocked(t, "completed");
    if (blocked) return replyStale(replyToken, blocked, t);
    // ปิดงานได้จากในกลุ่มแตะเดียวเมื่อแจ้งผลไปแล้ว — ถ้ายังไม่เคยแจ้ง พาไปกรอกในแอปก่อน
    if (!t.assessed_at) return replyMessage(replyToken, needAssessCard(t.id, t.ticket_no));

    const done = await sql<{ n: number }[]>`
      WITH upd AS (
        UPDATE tickets SET status='completed', completed_at=now(), updated_at=now()
        WHERE id=${ticketId} AND status=${t.status}
        RETURNING id
      ), ev AS (
        INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
        SELECT id, ${t.status}, 'completed', ${actor.id}, NULL FROM upd RETURNING ticket_id
      )
      SELECT count(*)::int AS n FROM upd
    `;
    if (done[0].n === 0) return replyLatest(replyToken, userId, ticketId, "สถานะถูกเปลี่ยนไปแล้ว");

    await replyCard(
      replyToken,
      cardFor(t, {
        status: "completed",
        assigneeName: t.assignee_name ?? actor.full_name,
        actorName: actor.full_name,
        ...justNow(actor.full_name),
      }),
    );
    // ผู้แจ้งได้การ์ดถามความพึงพอใจแทนข้อความ "เสร็จสิ้น" — ใช้จำนวนข้อความเท่ากัน
    if (t.reporter_line_user_id) {
      const sent = await pushTo(
        t.reporter_line_user_id,
        [ratingAskCard(t.id, t.ticket_no, t.detail, t.assignee_name ?? actor.full_name)],
        { ticketId, channel: "user" },
      );
      // ส่งการ์ดไม่ผ่าน ก็ต้องยังบอกให้รู้ว่างานเสร็จแล้ว ห้ามปล่อยให้ผู้แจ้งเงียบหาย
      if (!sent) {
        await tellReporter(t.reporter_line_user_id, `อัปเดตเรื่อง ${t.ticket_no}\nสถานะ: ${STATUS_LABELS.completed}`, ticketId);
      }
    }
    return;
  }

  // กด "แจ้งผลตรวจสอบ" — ตอบการ์ดถามกำหนดเสร็จกลับไป (ตอบกลับ ไม่กินโควตา)
  if (action === "assess") {
    if (t.status !== "in_progress") return replyStale(replyToken, `เรื่อง ${t.ticket_no} ไม่ได้อยู่ระหว่างดำเนินการ`, t);
    if (!t.due_at) return replyMessage(replyToken, dueAskCard(t.id, t.ticket_no));
    return replyMessage(replyToken, assessmentAskCard(t.id, t.ticket_no));
  }

  // เลือกกรอบเวลาจากชิป — "รออะไหล่" กับ "เลือกวันเอง" ต้องไปเลือกวันจากปฏิทินต่อ
  if (action === "due") {
    if (t.status !== "in_progress") return replyStale(replyToken, `เรื่อง ${t.ticket_no} ไม่ได้อยู่ระหว่างดำเนินการ`, t);
    const opt = DUE_BY_KEY.get(data.get("v") ?? "");
    if (!opt) return;
    if (opt.special === "wait") return replyMessage(replyToken, waitDateCard(t.id, t.ticket_no));
    const due = dueFromOption(opt);
    if (!due) return replyMessage(replyToken, waitDateCard(t.id, t.ticket_no));
    await setDue(t, actor, due, opt.label, false);
    return replyMessage(replyToken, assessmentAskCard(t.id, t.ticket_no));
  }

  // เลือกวันจากปฏิทินของไลน์ — ทั้งกรณีเลือกวันเองและกรณีรออะไหล่
  if (action === "duedate") {
    const picked = dueFromPickedDate(ev.postback.params?.date ?? "");
    if (!picked) return say(replyToken, "วันที่ไม่ถูกต้อง กรุณาเลือกใหม่");
    const waiting = data.get("mode") === "wait";
    const label = waiting ? "รออะไหล่ / ผู้รับเหมา" : "ตามวันที่กำหนด";
    await setDue(t, actor, picked, label, waiting);
    // เลื่อนวันจากข้อความทวงงานรออะไหล่ — แจ้งผลไปแล้ว ไม่ต้องถามอาการซ้ำ
    if (t.assessed_at) {
      await replyCard(replyToken, cardFor(t, { dueDateLabel: thaiDateShort(picked), dueLabel: label, waitingParts: waiting, ...justNow(actor.full_name) }));
      return tellReporter(
        t.reporter_line_user_id,
        `${t.ticket_no} เลื่อนกำหนดเป็น ${thaiDateShort(picked)}\nโดย ${shortName(actor.full_name)}`,
        t.id,
      );
    }
    return replyMessage(replyToken, assessmentAskCard(t.id, t.ticket_no));
  }

  // ติ๊กว่าไม่มีคำอธิบายเพิ่มเติม — ถือว่าตอบเรื่องอาการแล้ว
  if (action === "nonote") {
    if (t.assessed_at) return replyCard(replyToken, cardFor(t));
    if (!t.due_at) return replyMessage(replyToken, dueAskCard(t.id, t.ticket_no));
    return saveAssessment(ev, actor, t, null);
  }

  // งานรออะไหล่ ของมาแล้ว — เลิกทวงทุก 7 วัน แล้วให้เลือกกำหนดเสร็จใหม่
  if (action === "partsok") {
    const sql2 = db();
    await sql2`
      WITH upd AS (
        UPDATE tickets SET waiting_parts = false, due_at = NULL, due_label = NULL,
          last_progress_remind_at = NULL, updated_at = now()
        WHERE id = ${t.id} RETURNING id
      )
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      SELECT id, ${t.status}, ${t.status}, ${actor.id}, 'อะไหล่มาแล้ว เริ่มดำเนินการ' FROM upd
    `;
    await tellReporter(t.reporter_line_user_id, `${t.ticket_no} อะไหล่มาแล้ว เริ่มดำเนินการ`, t.id);
    return replyMessage(replyToken, dueAskCard(t.id, t.ticket_no));
  }

  if (action === "transfer") {
    const toDept = (data.get("to") ?? "").trim().toUpperCase();
    if (!toDept) return;
    const dept = await sql<{ id: string; name: string; line_group_id: string | null }[]>`
      SELECT id, name, line_group_id FROM departments WHERE code=${toDept} AND is_active=true AND receives_tickets=true LIMIT 1
    `;
    if (dept.length === 0 || dept[0].id === t.department_id) return;

    await sql`
      WITH upd AS (
        UPDATE tickets SET department_id=${dept[0].id}, status='pending', assignee_id=NULL,
          acknowledged_at=NULL, updated_at=now()
        WHERE id=${ticketId}
        RETURNING id
      )
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      SELECT id, ${t.status}, 'pending', ${actor.id}, ${"ส่งต่อไปฝ่าย " + dept[0].name} FROM upd
    `;

    if (dept[0].line_group_id) {
      // ส่งต่อฝ่ายแล้วเรื่องกลับไปรอรับใหม่เสมอ และไม่มีผู้รับผิดชอบคนเดิมติดไปด้วย
      const flex = cardFor(t, {
        status: "pending",
        departmentName: dept[0].name,
        assigneeName: null,
        actorName: actor.full_name,
        ...justNow(actor.full_name),
      });
      await pushTo(dept[0].line_group_id, [flex], { ticketId, channel: "group" });
    }
    // แต่ละฝ่ายมีกลุ่มของตัวเอง กลุ่มเดิมจึงไม่เห็นการ์ดใบใหม่ที่ไปโผล่อีกกลุ่ม
    // ถ้าไม่บอก กลุ่มเดิมจะเหลือการ์ดที่หยุดขยับเฉย ๆ โดยไม่มีใครรู้ว่าเรื่องย้ายไปแล้ว
    await tellGroupMoved(t.department_group_id, dept[0].line_group_id, t.ticket_no, dept[0].name, ticketId);
    await say(replyToken, `ส่งต่อ ${t.ticket_no} ไปยัง ${dept[0].name} แล้ว`);
    await tellReporter(t.reporter_line_user_id, `เรื่อง ${t.ticket_no} ถูกส่งต่อไปยัง ${dept[0].name}`, ticketId);
    return;
  }
}

