// POST /api/tickets/:id/rate — ผู้แจ้งให้คะแนนความพึงพอใจหลังงานปิด
//
// ผลประเมินส่งกลับ "เข้ากลุ่ม" ไม่ใช่แชทส่วนตัวของผู้รับผิดชอบ — คำชมที่เพื่อนร่วมงานเห็นด้วย
// มีค่ากับคนทำงานมากกว่าคำชมที่รู้กันสองคน
//
// ลงกลุ่มทุกคะแนน ไม่ใช่เฉพาะคะแนนดี เพราะทั้งกลุ่มควรรับทราบผลงานของตัวเองตามจริง
// หน้าตาการ์ดจึงเปลี่ยนตามคะแนน (ดู ratingResultCard) — ขึ้นหัวว่า "คำชม" ทับผลประเมิน 1 ดาว
// จะอ่านเหมือนระบบประชด

import { getSession, requireActive } from "./_lib/auth";
import { IMPROVE_CHIPS, PRAISE_CHIPS, RATING_LABELS } from "./_lib/constants";
import { db } from "./_lib/db";
import { ratingResultCard } from "./_lib/flex";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { loadCardRow, pushGroupCard } from "./_lib/ticket-card";

interface Body {
  rating?: number;
  note?: string;
}

function ticketIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','tickets','<id>','rate']
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
    const rating = Math.round(Number(body.rating));
    if (!(rating >= 1 && rating <= 5)) throw new HttpError(400, "กรุณาเลือกจำนวนดาว");

    // รับเฉพาะคำที่อยู่ในรายการของระบบ ไม่รับข้อความอิสระ — การ์ดนี้ไปโผล่ในกลุ่มที่ทุกคนเห็น
    const raw = (body.note ?? "").trim();
    const allowed = rating >= 4 ? PRAISE_CHIPS : IMPROVE_CHIPS;
    if (raw && !allowed.includes(raw)) throw new HttpError(400, "คำที่เลือกไม่ถูกต้อง");
    const note = raw || null;

    const t = await loadCardRow(id);
    if (!t) throw new HttpError(404, "ไม่พบเรื่องนี้");
    if (t.reporter_id !== s.employee.id) throw new HttpError(403, "ให้คะแนนได้เฉพาะผู้แจ้งเรื่องนี้เท่านั้น");
    if (t.status !== "completed" && t.status !== "closed") {
      throw new HttpError(409, "ให้คะแนนได้หลังงานปิดแล้วเท่านั้น");
    }

    const sql = db();
    // เขียนได้ครั้งเดียว — กันการส่งการ์ดคำชมเข้ากลุ่มซ้ำเมื่อกดส่งรัว ๆ หรือเปิดลิงก์เดิมซ้ำ
    const done = await sql<{ n: number }[]>`
      WITH upd AS (
        UPDATE tickets SET rating = ${rating}, rating_note = ${note}, rated_at = now(), updated_at = now()
        WHERE id = ${id} AND rated_at IS NULL
        RETURNING id
      ), ev AS (
        INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
        SELECT id, ${t.status}, ${t.status}, ${s.employee.id},
               ${`ผู้แจ้งให้ ${rating} ดาว (${RATING_LABELS[rating] ?? ""})${note ? ": " + note : ""}`} FROM upd
        RETURNING ticket_id
      )
      SELECT count(*)::int AS n FROM upd
    `;
    if (done[0].n === 0) throw new HttpError(409, "เรื่องนี้ให้คะแนนไปแล้ว", "already_rated");

    try {
      await pushGroupCard(t, ratingResultCard(t.ticket_no, t.detail, t.reporter_name, t.assignee_name, rating, note));
    } catch (e) {
      // ส่งเข้ากลุ่มไม่ผ่านไม่ควรทำให้ผู้ให้คะแนนเห็นว่าบันทึกไม่สำเร็จ — คะแนนลงฐานข้อมูลไปแล้ว
      console.error("[tickets-rate] ส่งผลประเมินเข้ากลุ่มไม่สำเร็จ", e);
    }

    return json({ ok: true, id, rating, note, shared: Boolean(t.line_group_id) });
  });
