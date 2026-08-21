// POST /api/tickets/:id/assess — แจ้งผลตรวจสอบหลังรับเรื่อง (อาการที่พบ + กำหนดเสร็จ)
//
// ขั้นตอนนี้เคยทำผ่านการ์ดถาม-ตอบในกลุ่มไลน์ ซึ่งกินพื้นที่ 2-3 ใบต่อหนึ่งเรื่องทั้งที่เป็นบทสนทนา
// ระหว่างระบบกับผู้รับผิดชอบคนเดียว ย้ายมาทำในแอปแล้วกลุ่มเห็นแค่ผลลัพธ์ใบเดียว และผู้รับผิดชอบ
// ได้หน้าจอที่กว้างพอจะเห็นตัวเลือกทั้งหมดพร้อมกัน
//
// then_complete = ปิดงานต่อในคำขอเดียวกัน — ใช้ตอนกด "ดำเนินการเสร็จสิ้น" บนการ์ดที่ยังไม่ได้แจ้งผล
// แล้วระบบพามากรอกก่อน จะได้ไม่ต้องกดสองรอบและไม่ต้องส่งการ์ดเข้ากลุ่มสองใบ

import { getSession, isMemberOf, requireActive } from "./_lib/auth";
import { DUE_BY_KEY, STATUS_LABELS } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { askReporterRating, groupCard, justNow, loadCardRow, pushGroupCard, tellReporter } from "./_lib/ticket-card";
import { dueFromOption, dueFromPickedDate, shortName, thaiDateShort } from "./_lib/tickets";

interface Body {
  due_key?: string;
  due_date?: string;
  note?: string;
  no_note?: boolean;
  then_complete?: boolean;
}

function ticketIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','tickets','<id>','assess']
  return seg[2] ?? "";
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST", "PATCH");
    const id = ticketIdFromPath(req);
    if (!id) throw new HttpError(404, "ไม่พบเรื่องนี้");

    const s = await getSession(req);
    requireActive(s);

    const body = await readJson<Body>(req);
    const opt = DUE_BY_KEY.get((body.due_key ?? "").trim());
    if (!opt) throw new HttpError(400, "กรุณาเลือกกรอบเวลาที่คาดว่าจะเสร็จ");

    // อาการที่พบบังคับกรอก เว้นแต่ติ๊กว่าไม่มีคำอธิบายเพิ่มเติม — เรื่องที่ปิดไปโดยไม่มีใครรู้ว่า
    // เกิดอะไรขึ้นคือสิ่งที่ระบบนี้ตั้งใจกำจัด การติ๊กจึงต้องเป็นการเลือกที่ตั้งใจ ไม่ใช่การเว้นว่าง
    const noNote = body.no_note === true;
    const note = (body.note ?? "").trim();
    if (!noNote && !note) throw new HttpError(400, "กรุณาระบุอาการที่พบ หรือติ๊กว่าไม่มีคำอธิบายเพิ่มเติม");
    const assessment = noNote ? null : note.slice(0, 500);

    const waiting = opt.special === "wait";
    let due = dueFromOption(opt);
    if (!due) {
      const picked = (body.due_date ?? "").trim();
      due = dueFromPickedDate(picked);
      if (!due) throw new HttpError(400, "กรุณาเลือกวันที่คาดว่าจะเสร็จ");
      // วันที่ย้อนหลังทำให้เรื่องเลยกำหนดตั้งแต่วินาทีแรกแล้วโดนทวงทันที ซึ่งไม่ใช่สิ่งที่ใครตั้งใจ
      // เทียบกับวันนี้ตามเวลาไทย ไม่ใช่ UTC — ไม่งั้นช่วงเช้ามืดของไทยจะปฏิเสธวันของวันนี้เอง
      const todayTh = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (picked < todayTh) throw new HttpError(400, "วันที่คาดว่าจะเสร็จต้องไม่ใช่วันที่ผ่านมาแล้ว");
    }

    const t = await loadCardRow(id);
    if (!t) throw new HttpError(404, "ไม่พบเรื่องนี้");
    if (!isMemberOf(s, t.department_id)) throw new HttpError(403, "ไม่มีสิทธิ์ดำเนินการเรื่องนี้");
    if (t.status !== "in_progress") {
      throw new HttpError(409, `เรื่องนี้อยู่ในสถานะ "${STATUS_LABELS[t.status] ?? t.status}" แล้ว แจ้งผลตรวจสอบไม่ได้`);
    }

    const sql = db();
    const complete = body.then_complete === true;
    const label = opt.label;
    const eventNote = [`แจ้งผลตรวจสอบ${assessment ? ": " + assessment : ""}`, `กำหนดเสร็จ ${label} (${thaiDateShort(due)})`].join(" · ");

    // ปิดงานต่อในคำสั่งเดียวกันเมื่อมาจากปุ่มปิดงาน — เขียนเป็นชิ้นส่วนที่ต่อเข้าไปตอนประกอบคำสั่ง
    // ไม่ใช้ CASE WHEN ที่รับค่าจริง/เท็จมาเป็นพารามิเตอร์ เพราะค่านี้รู้ตั้งแต่ก่อนประกอบคำสั่งอยู่แล้ว
    const closing = complete ? sql`, status = 'completed', completed_at = now()` : sql``;
    const toStatus = complete ? "completed" : t.status;

    await sql`
      WITH upd AS (
        UPDATE tickets
        SET assessment = ${assessment}, assessed_at = now(),
            due_at = ${due}, due_label = ${label}, waiting_parts = ${waiting},
            due_changes = due_changes + CASE WHEN due_at IS NULL THEN 0 ELSE 1 END,
            progress_remind_count = 0, last_progress_remind_at = NULL,
            updated_at = now() ${closing}
        WHERE id = ${id} AND status = ${t.status}
        RETURNING id
      )
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      SELECT id, ${t.status}, ${toStatus}, ${s.employee.id}, ${eventNote} FROM upd
    `;

    // เขียนค่าใหม่ทับแถวที่อ่านมา จะได้ไม่ต้องวิ่งไปอ่านฐานข้อมูลซ้ำเพื่อวาดการ์ด
    t.assessment = assessment;
    t.assessed_at = new Date().toISOString();
    t.due_at = due.toISOString();
    t.due_label = label;
    t.waiting_parts = waiting;
    if (complete) t.status = "completed";

    const when = [label, thaiDateShort(due)].join(" · ");
    try {
      await pushGroupCard(t, groupCard(t, justNow(s.employee.full_name)));
      if (complete) {
        // ปิดงานไปเลยในขั้นตอนเดียว — ผู้แจ้งได้การ์ดถามความพึงพอใจใบเดียว ไม่ต้องมีข้อความบอกสถานะซ้ำ
        await askReporterRating(t);
      } else {
        await tellReporter(
          t,
          [
            `${t.ticket_no} ตรวจสอบแล้ว`,
            assessment ? `อาการ: ${assessment}` : null,
            `${waiting ? "รออะไหล่ ถึง" : "คาดว่าเสร็จ"}: ${when}`,
            `ผู้รับผิดชอบ: ${shortName(t.assignee_name ?? s.employee.full_name)}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }
    } catch (e) {
      console.error("[tickets-assess] notify failed", e);
    }

    return json({ ok: true, id, status: t.status, status_label: STATUS_LABELS[t.status] ?? t.status });
  });
