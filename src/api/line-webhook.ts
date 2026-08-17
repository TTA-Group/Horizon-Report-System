// POST /api/line/webhook — รับ postback และ event จาก LINE (spec หัวข้อ 5.3 / 6 / 7)
//
// - ตรวจ X-Line-Signature ทุกครั้ง
// - postback: action=ack|complete|transfer (จากปุ่มใน Flex Message)
// - join: เก็บ groupId ของกลุ่มฝ่ายไว้ตั้งค่าใน departments.line_group_id

import {
  adminCodes,
  CATEGORY_BY_CODE,
  CHANNEL_KEY,
  STATUS_LABELS,
  STATUS_TRANSITIONS,
  type StatusCode,
  type UrgencyCode,
} from "./_lib/constants";
import { db } from "./_lib/db";
import { buildTicketFlex, type TicketFlexInput } from "./_lib/flex";
import { HttpError, json, methodGuard, run } from "./_lib/http";
import { pushTo, replyTo, textMessage, verifyLineSignature, type LineMessage } from "./_lib/line";
import { groupMessages } from "./_lib/mentions";
import { thaiDateTime } from "./_lib/tickets";
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
  postback?: { data: string };
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
        if (ev.type === "postback") await handlePostback(ev);
        else if (ev.type === "join") await handleJoin(ev);
        else if (ev.type === "message") await handleMessage(ev);
      } catch (e) {
        console.error("[webhook event]", e);
      }
    }
    // ต้องตอบ 200 เสมอเพื่อไม่ให้ LINE ส่งซ้ำ
    return json({ ok: true });
  });

const OWN_ACTIONS = new Set(["ack", "complete", "transfer", "cancel"]);

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
    return text.toLowerCase() === "groupid" || CANCEL_RE.test(text);
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

async function handleMessage(ev: LineEvent): Promise<void> {
  if (ev.message?.type !== "text") return;
  const text = (ev.message.text ?? "").trim();
  if (text.toLowerCase() === "groupid") return handleGroupIdRequest(ev);
  if (CANCEL_RE.test(text)) return handleCancelMessage(ev, text);
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

  const actor = await resolveActor(userId);
  if (!actor) return say(replyToken, "กรุณายืนยันตัวตนในระบบก่อนใช้งานคำสั่งนี้");
  if (actor.status === "suspended") return say(replyToken, "บัญชีของคุณถูกระงับสิทธิ์การใช้งาน");

  const t = await loadTicket({ ticketNo });
  if (!t) return say(replyToken, `ไม่พบเรื่องเลขที่ ${ticketNo}`);
  if (!(await canAct(actor, t.department_id))) {
    return say(replyToken, "คุณไม่ใช่เจ้าหน้าที่ของฝ่ายที่รับผิดชอบเรื่องนี้");
  }

  const blocked = transitionBlocked(t, "cancelled");
  if (blocked) return say(replyToken, blocked);

  const sql = db();
  const upd = await sql`
    UPDATE tickets SET status='cancelled', updated_at=now()
    WHERE id=${t.id} AND status=${t.status} RETURNING id
  `;
  if (upd.length === 0) return say(replyToken, "สถานะถูกเปลี่ยนไปแล้ว");

  await insertEvent(t.id, t.status, "cancelled", actor.id, reason);
  await notifyReporter(t.reporter_id, `เรื่อง ${t.ticket_no} ถูกยกเลิก\nเหตุผล: ${reason}`, t.id);
  if (replyToken) {
    await replyTo(replyToken, [cardFor(t, { status: "cancelled", cancelReason: reason, actorName: actor.full_name })]);
  }
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
    textMessage(groupId ? `groupId ของกลุ่มนี้คือ\n${groupId}` : "คำสั่งนี้ใช้ได้เฉพาะในกลุ่มเท่านั้น"),
  ]);
}

async function handleJoin(ev: LineEvent): Promise<void> {
  const groupId = ev.source?.groupId ?? ev.source?.roomId;
  if (!groupId || !ev.replyToken) return;
  await replyTo(ev.replyToken, [
    textMessage(
      `เพิ่มบอทเข้ากลุ่มเรียบร้อย\ngroupId ของกลุ่มนี้คือ:\n${groupId}\n\nกรุณาส่งค่านี้ให้ผู้ดูแลระบบ เพื่อตั้งเป็น line_group_id ของทุกฝ่ายในตาราง departments (ทุกฝ่ายใช้กลุ่มนี้ร่วมกัน แล้วเรียกเจ้าหน้าที่ที่รับผิดชอบด้วยการ mention)`,
    ),
  ]);
}

interface TicketRow {
  id: string;
  status: StatusCode;
  department_id: string;
  department_code: string;
  department_name: string;
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
  assignee_name: string | null;
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
    WHERE la.line_user_id = ${lineUserId} AND la.channel_key = ${CHANNEL_KEY} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** อ่านเรื่องหนึ่งใบพร้อมข้อมูลที่การ์ดต้องใช้ทั้งหมด (ค้นด้วย id หรือเลขที่เรื่องก็ได้) */
async function loadTicket(by: { id: string } | { ticketNo: string }): Promise<TicketRow | null> {
  const sql = db();
  const match = "id" in by ? sql`t.id = ${by.id}` : sql`t.ticket_no = ${by.ticketNo}`;
  const rows = await sql<TicketRow[]>`
    SELECT t.id, t.status, t.department_id, t.reporter_id, t.ticket_no, t.category_code,
           t.floor, t.location_note, t.detail, t.urgency, t.created_at,
           r.full_name AS reporter_name, r.department_name AS reporter_dept,
           d.code AS department_code, d.name AS department_name,
           a.full_name AS assignee_name
    FROM tickets t
    JOIN employees r ON r.id = t.reporter_id
    JOIN departments d ON d.id = t.department_id
    LEFT JOIN employees a ON a.id = t.assignee_id
    WHERE ${match} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** มีสิทธิ์จัดการเรื่องนี้ไหม — เจ้าหน้าที่ของฝ่ายนั้น หรือผู้ดูแลระบบ */
async function canAct(actor: ActorRow, departmentId: string): Promise<boolean> {
  if (adminCodes().has(actor.employee_code)) return true;
  const sql = db();
  const rows = await sql`
    SELECT 1 FROM department_members
    WHERE department_id = ${departmentId} AND employee_id = ${actor.id} LIMIT 1
  `;
  return rows.length > 0;
}

/** เปลี่ยนสถานะนี้ไม่ได้เพราะอะไร — คืน null ถ้าเปลี่ยนได้ */
function transitionBlocked(t: TicketRow, to: StatusCode): string | null {
  if ((STATUS_TRANSITIONS[t.status] ?? []).includes(to)) return null;
  return `เรื่อง ${t.ticket_no} อยู่ในสถานะ "${STATUS_LABELS[t.status] ?? t.status}" แล้ว ทำรายการนี้ไม่ได้`;
}

/** การ์ดของเรื่องนี้ ตามสถานะที่เป็นอยู่ (ส่ง overrides เพื่อวาดสถานะใหม่ที่เพิ่งเปลี่ยนไป) */
function cardFor(t: TicketRow, overrides: Partial<TicketFlexInput> = {}): LineMessage {
  return buildTicketFlex({
    ticketId: t.id,
    ticketNo: t.ticket_no,
    status: t.status,
    departmentCode: t.department_code,
    categoryLabel: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
    reporterName: t.reporter_name,
    reporterDept: t.reporter_dept,
    floor: t.floor,
    locationNote: t.location_note,
    detail: t.detail,
    urgency: t.urgency as UrgencyCode,
    createdAtLabel: thaiDateTime(new Date(t.created_at)),
    assigneeName: t.assignee_name,
    ...overrides,
  });
}

async function say(replyToken: string | undefined, text: string): Promise<void> {
  if (replyToken) await replyTo(replyToken, [textMessage(text)]);
}

async function handlePostback(ev: LineEvent): Promise<void> {
  const userId = ev.source?.userId;
  const replyToken = ev.replyToken;
  if (!userId || !ev.postback) return;

  const data = new URLSearchParams(ev.postback.data);
  const action = data.get("action");
  const ticketId = data.get("ticket");
  if (!action || !ticketId || !UUID_RE.test(ticketId)) return;

  // ปุ่ม "ยกเลิกเรื่อง" ไม่ทำอะไรตอนกด — หน้าที่ของมันคือเปิดแป้นพิมพ์พร้อมข้อความตั้งต้น
  // การยกเลิกจริงเกิดตอนผู้กดพิมพ์เหตุผลแล้วส่งออกมา (ดู handleCancelMessage)
  if (action === "cancel") return;

  const actor = await resolveActor(userId);
  if (!actor) return say(replyToken, "กรุณายืนยันตัวตนในระบบก่อนใช้งานปุ่มนี้");
  if (actor.status === "suspended") return say(replyToken, "บัญชีของคุณถูกระงับสิทธิ์การใช้งาน");

  const t = await loadTicket({ id: ticketId });
  if (!t) return;
  if (!(await canAct(actor, t.department_id))) {
    return say(replyToken, "คุณไม่ใช่เจ้าหน้าที่ของฝ่ายที่รับผิดชอบเรื่องนี้");
  }

  const sql = db();

  if (action === "ack") {
    const blocked = transitionBlocked(t, "in_progress");
    if (blocked) return say(replyToken, blocked);
    const upd = await sql`
      UPDATE tickets SET status='in_progress', assignee_id=${actor.id},
        acknowledged_at=COALESCE(acknowledged_at, now()), updated_at=now()
      WHERE id=${ticketId} AND status='pending' RETURNING id
    `;
    if (upd.length === 0) return say(replyToken, `เรื่อง ${t.ticket_no} มีผู้รับไปแล้ว`);

    await insertEvent(ticketId, t.status, "in_progress", actor.id, null);
    await notifyReporter(t.reporter_id, `อัปเดตเรื่อง ${t.ticket_no}\nสถานะ: ${STATUS_LABELS.in_progress}`, ticketId);
    if (replyToken) {
      await replyTo(replyToken, [cardFor(t, { status: "in_progress", assigneeName: actor.full_name })]);
    }
    return;
  }

  if (action === "complete") {
    const blocked = transitionBlocked(t, "completed");
    if (blocked) return say(replyToken, blocked);
    const upd = await sql`
      UPDATE tickets SET status='completed', completed_at=now(), updated_at=now()
      WHERE id=${ticketId} AND status=${t.status} RETURNING id
    `;
    if (upd.length === 0) return say(replyToken, "สถานะถูกเปลี่ยนไปแล้ว");

    await insertEvent(ticketId, t.status, "completed", actor.id, null);
    await notifyReporter(t.reporter_id, `อัปเดตเรื่อง ${t.ticket_no}\nสถานะ: ${STATUS_LABELS.completed}`, ticketId);
    if (replyToken) {
      await replyTo(replyToken, [
        cardFor(t, { status: "completed", assigneeName: t.assignee_name ?? actor.full_name, actorName: actor.full_name }),
      ]);
    }
    return;
  }

  if (action === "transfer") {
    const toDept = (data.get("to") ?? "").trim().toUpperCase();
    if (!toDept) return;
    const dept = await sql<{ id: string; name: string; line_group_id: string | null }[]>`
      SELECT id, name, line_group_id FROM departments WHERE code=${toDept} AND is_active=true LIMIT 1
    `;
    if (dept.length === 0 || dept[0].id === t.department_id) return;

    await sql`
      UPDATE tickets SET department_id=${dept[0].id}, status='pending', assignee_id=NULL,
        acknowledged_at=NULL, updated_at=now() WHERE id=${ticketId}
    `;
    await insertEvent(ticketId, t.status, "pending", actor.id, "ส่งต่อไปฝ่าย " + dept[0].name);

    if (dept[0].line_group_id) {
      // ส่งต่อฝ่ายแล้วเรื่องกลับไปรอรับใหม่เสมอ และไม่มีผู้รับผิดชอบคนเดิมติดไปด้วย
      const flex = cardFor(t, {
        status: "pending",
        departmentCode: toDept,
        assigneeName: null,
        actorName: actor.full_name,
      });
      const messages = await groupMessages(
        dept[0].id,
        `↪️ ส่งต่อ ${t.ticket_no} มาที่ ${dept[0].name}`,
        flex,
      );
      await pushTo(dept[0].line_group_id, messages, { ticketId, channel: "group" });
    }
    await notifyReporter(t.reporter_id, `เรื่อง ${t.ticket_no} ถูกส่งต่อไปยัง ${dept[0].name}`, ticketId);
    if (replyToken) await replyTo(replyToken, [textMessage(`ส่งต่อ ${t.ticket_no} ไปยัง ${dept[0].name} แล้ว`)]);
    return;
  }
}

async function insertEvent(
  ticketId: string,
  from: string,
  to: string,
  actorId: string,
  note: string | null,
): Promise<void> {
  const sql = db();
  await sql`
    INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
    VALUES (${ticketId}, ${from}, ${to}, ${actorId}, ${note})
  `;
}

async function notifyReporter(reporterId: string, text: string, ticketId: string): Promise<void> {
  const sql = db();
  const rows = await sql<{ line_user_id: string }[]>`
    SELECT line_user_id FROM line_accounts
    WHERE employee_id = ${reporterId} AND channel_key = ${CHANNEL_KEY} LIMIT 1
  `;
  if (rows.length > 0) {
    await pushTo(rows[0].line_user_id, [textMessage(text)], { ticketId, channel: "user" });
  }
}
