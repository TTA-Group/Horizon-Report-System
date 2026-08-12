// POST /api/line/webhook — รับ postback และ event จาก LINE (spec หัวข้อ 5.3 / 6 / 7)
//
// - ตรวจ X-Line-Signature ทุกครั้ง
// - postback: action=ack|complete|transfer (จากปุ่มใน Flex Message)
// - join: เก็บ groupId ของกลุ่มฝ่ายไว้ตั้งค่าใน departments.line_group_id

import type { Config } from "@netlify/functions";
import { adminCodes, CATEGORY_BY_CODE, CHANNEL_KEY, STATUS_LABELS, type StatusCode, type UrgencyCode } from "./_lib/constants";
import { db } from "./_lib/db";
import { buildTicketFlex } from "./_lib/flex";
import { HttpError, json, methodGuard, run } from "./_lib/http";
import { pushTo, replyTo, textMessage, verifyLineSignature } from "./_lib/line";
import { assertTransition, thaiDateTime } from "./_lib/tickets";

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
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const raw = await req.text();
    const signature = req.headers.get("x-line-signature");
    if (!verifyLineSignature(raw, signature)) {
      throw new HttpError(401, "invalid signature");
    }

    // ใช้ OA ร่วมกับระบบอื่น (เช่น ระบบจองนวด): ส่งต่อ event ต้นฉบับให้ระบบเดิมก่อนเสมอ
    // ระบบเดิมจะได้รับ webhook เหมือนที่ LINE เคยส่งให้ทุกอย่าง จึงทำงานต่อได้ตามปกติ
    await forwardToCoexisting(raw, signature);

    let payload: { events?: LineEvent[] };
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ ok: true }); // body ไม่ใช่ JSON — ตอบ 200 เพื่อไม่ให้ LINE retry
    }

    for (const ev of payload.events ?? []) {
      try {
        if (ev.type === "postback") await handlePostback(ev);
        else if (ev.type === "join") await handleJoin(ev);
      } catch (e) {
        console.error("[webhook event]", e);
      }
    }
    // ต้องตอบ 200 เสมอเพื่อไม่ให้ LINE ส่งซ้ำ
    return json({ ok: true });
  });

/**
 * ส่งต่อ webhook ต้นฉบับให้ระบบอื่นที่ใช้ OA เดียวกัน (ตั้งค่า MASSAGE_WEBHOOK_URL)
 * ส่ง body และ X-Line-Signature เดิมไปตรง ๆ ระบบเดิมจึงตรวจ signature ผ่านและทำงานต่อได้
 *
 * จำกัดเวลารอไว้ไม่เกิน 4 วินาที — ถ้าระบบปลายทางตอบช้า (เช่น Power Automate ที่มักตอบช้า
 * กว่าระบบทั่วไป) จะไม่ทำให้ระบบเราตอบ LINE ช้าตามไปด้วยจนหมดเวลา (LINE รอ response ของเรา
 * อยู่ ไม่ได้รอของระบบปลายทาง) ปล่อยให้คำขอที่ส่งไปแล้วทำงานต่อเองในเบื้องหลัง
 */
async function forwardToCoexisting(rawBody: string, signature: string | null): Promise<void> {
  const url = process.env.MASSAGE_WEBHOOK_URL;
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

async function handleJoin(ev: LineEvent): Promise<void> {
  const groupId = ev.source?.groupId ?? ev.source?.roomId;
  if (!groupId || !ev.replyToken) return;
  await replyTo(ev.replyToken, [
    textMessage(
      `เพิ่มบอทเข้ากลุ่มเรียบร้อย\ngroupId ของกลุ่มนี้คือ:\n${groupId}\n\nกรุณาส่งค่านี้ให้ผู้ดูแลระบบเพื่อผูกกับฝ่ายในตาราง departments (คอลัมน์ line_group_id)`,
    ),
  ]);
}

async function handlePostback(ev: LineEvent): Promise<void> {
  const userId = ev.source?.userId;
  const replyToken = ev.replyToken;
  if (!userId || !ev.postback) return;

  const data = new URLSearchParams(ev.postback.data);
  const action = data.get("action");
  const ticketId = data.get("ticket");
  if (!action || !ticketId) return;

  const sql = db();

  // resolve ผู้กดปุ่มเป็นพนักงาน
  const actorRows = await sql<{ id: string; employee_code: string; status: string }[]>`
    SELECT e.id, e.employee_code, e.status
    FROM line_accounts la JOIN employees e ON e.id = la.employee_id
    WHERE la.line_user_id = ${userId} AND la.channel_key = ${CHANNEL_KEY} LIMIT 1
  `;
  if (actorRows.length === 0) {
    if (replyToken) await replyTo(replyToken, [textMessage("กรุณายืนยันตัวตนในระบบก่อนใช้งานปุ่มนี้")]);
    return;
  }
  const actor = actorRows[0];

  const ticketRows = await sql<
    {
      status: StatusCode;
      department_id: string;
      reporter_id: string;
      ticket_no: string;
      category_code: string;
      floor: string;
      location_note: string | null;
      detail: string;
      urgency: string;
      reporter_name: string;
      reporter_dept: string | null;
    }[]
  >`
    SELECT t.status, t.department_id, t.reporter_id, t.ticket_no, t.category_code,
           t.floor, t.location_note, t.detail, t.urgency,
           r.full_name AS reporter_name, r.department_name AS reporter_dept
    FROM tickets t JOIN employees r ON r.id = t.reporter_id
    WHERE t.id = ${ticketId} LIMIT 1
  `;
  if (ticketRows.length === 0) return;
  const t = ticketRows[0];

  // ตรวจสิทธิ์: เป็นสมาชิกฝ่ายของเรื่อง หรือผู้ดูแล
  const isAdmin = adminCodes().has(actor.employee_code);
  const member = await sql`
    SELECT 1 FROM department_members
    WHERE department_id = ${t.department_id} AND employee_id = ${actor.id} LIMIT 1
  `;
  if (!isAdmin && member.length === 0) {
    if (replyToken) await replyTo(replyToken, [textMessage("คุณไม่ใช่เจ้าหน้าที่ของฝ่ายที่รับผิดชอบเรื่องนี้")]);
    return;
  }

  if (action === "ack") {
    assertTransition(t.status, "in_progress");
    const upd = await sql`
      UPDATE tickets SET status='in_progress', assignee_id=${actor.id},
        acknowledged_at=COALESCE(acknowledged_at, now()), updated_at=now()
      WHERE id=${ticketId} AND status='pending' RETURNING id
    `;
    if (upd.length === 0) {
      if (replyToken) await replyTo(replyToken, [textMessage(`เรื่อง ${t.ticket_no} มีผู้รับไปแล้ว`)]);
      return;
    }
    await insertEvent(ticketId, t.status, "in_progress", actor.id, null);
    await notifyReporter(t.reporter_id, `อัปเดตเรื่อง ${t.ticket_no}\nสถานะ: ${STATUS_LABELS.in_progress}`, ticketId);
    if (replyToken) await replyTo(replyToken, [textMessage(`รับเรื่อง ${t.ticket_no} เรียบร้อย`)]);
    return;
  }

  if (action === "complete") {
    assertTransition(t.status, "completed");
    const upd = await sql`
      UPDATE tickets SET status='completed', completed_at=now(), updated_at=now()
      WHERE id=${ticketId} AND status=${t.status} RETURNING id
    `;
    if (upd.length === 0) {
      if (replyToken) await replyTo(replyToken, [textMessage("สถานะถูกเปลี่ยนไปแล้ว")]);
      return;
    }
    await insertEvent(ticketId, t.status, "completed", actor.id, null);
    await notifyReporter(t.reporter_id, `อัปเดตเรื่อง ${t.ticket_no}\nสถานะ: ${STATUS_LABELS.completed}`, ticketId);
    if (replyToken) await replyTo(replyToken, [textMessage(`ปิดงาน ${t.ticket_no} เรียบร้อย`)]);
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
      const flex = buildTicketFlex({
        ticketId,
        ticketNo: t.ticket_no,
        categoryLabel: CATEGORY_BY_CODE.get(t.category_code)?.label ?? t.category_code,
        reporterName: t.reporter_name,
        reporterDept: t.reporter_dept,
        floor: t.floor,
        locationNote: t.location_note,
        detail: t.detail,
        urgency: t.urgency as UrgencyCode,
        createdAtLabel: thaiDateTime(),
      });
      await pushTo(dept[0].line_group_id, [flex], { ticketId, channel: "group" });
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

export const config: Config = { path: "/api/line/webhook" };
