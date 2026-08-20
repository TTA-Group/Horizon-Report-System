// POST /api/tickets/:id/progress — อัปเดตความคืบหน้าระหว่างดำเนินการ
//
// ไม่เปลี่ยนสถานะ แต่รีเซ็ตนาฬิกาทวงงาน — งานที่มีคนรายงานความคืบหน้าเข้ามาแปลว่ายังไม่ถูกทิ้ง
// จึงไม่ต้องทวงซ้ำในรอบถัดไป (ดู runProgressReminders ใน _lib/jobs.ts)
//
// เลื่อนกำหนดเสร็จใช้ /assess แทน เพราะเป็นการเขียนทับข้อมูลชุดเดียวกันและต้องนับจำนวนครั้งที่เลื่อน

import { getSession, isMemberOf, requireActive } from "./_lib/auth";
import { STATUS_LABELS } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { groupCard, justNow, loadCardRow, pushGroupCard, tellReporter } from "./_lib/ticket-card";
import { shortName } from "./_lib/tickets";

interface Body {
  note?: string;
}

function ticketIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','tickets','<id>','progress']
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
    const note = (body.note ?? "").trim().slice(0, 500);
    if (!note) throw new HttpError(400, "กรุณาระบุความคืบหน้า");

    const t = await loadCardRow(id);
    if (!t) throw new HttpError(404, "ไม่พบเรื่องนี้");
    if (!isMemberOf(s, t.department_id)) throw new HttpError(403, "ไม่มีสิทธิ์ดำเนินการเรื่องนี้");
    if (t.status !== "in_progress") {
      throw new HttpError(409, `เรื่องนี้อยู่ในสถานะ "${STATUS_LABELS[t.status] ?? t.status}" แล้ว`);
    }

    const sql = db();
    await sql`
      WITH upd AS (
        UPDATE tickets SET last_progress_remind_at = now(), updated_at = now()
        WHERE id = ${id} AND status = 'in_progress' RETURNING id
      )
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      SELECT id, 'in_progress', 'in_progress', ${s.employee.id}, ${"ความคืบหน้า: " + note} FROM upd
    `;

    try {
      await pushGroupCard(t, groupCard(t, justNow(s.employee.full_name)));
      await tellReporter(t, `อัปเดตเรื่อง ${t.ticket_no}\n${note}\nโดย ${shortName(s.employee.full_name)}`);
    } catch (e) {
      console.error("[tickets-progress] notify failed", e);
    }

    return json({ ok: true, id });
  });
