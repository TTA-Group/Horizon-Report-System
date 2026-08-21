// PATCH /api/tickets/:id/status — เปลี่ยนสถานะ (spec หัวข้อ 5.3 / 6)
// รองรับการกดรับพร้อมกัน: ใช้ conditional update กันรับซ้ำ

import { getSession, isMemberOf, requireActive } from "./_lib/auth";
import { STATUS_LABELS, STATUS_TRANSITIONS, type StatusCode } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { askReporterRating, groupCard, justNow, loadCardRow, pushGroupCard, tellReporter } from "./_lib/ticket-card";
import { assertTransition, shortName } from "./_lib/tickets";

interface Body {
  to_status?: string;
  note?: string;
}

function ticketIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','tickets','<id>','status']
  return seg[2] ?? "";
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "PATCH", "POST");
    const id = ticketIdFromPath(req);
    if (!id) throw new HttpError(404, "ไม่พบเรื่องนี้");

    const s = await getSession(req);
    requireActive(s);

    const body = await readJson<Body>(req);
    const to = (body.to_status ?? "").trim() as StatusCode;
    if (!(to in STATUS_TRANSITIONS)) throw new HttpError(400, "สถานะปลายทางไม่ถูกต้อง");
    const note = (body.note ?? "").trim() || null;

    const t = await loadCardRow(id);
    if (!t) throw new HttpError(404, "ไม่พบเรื่องนี้");

    // เจ้าหน้าที่ของฝ่ายทำได้ทุกอย่าง ส่วนผู้แจ้งเองยกเลิกเรื่องของตัวเองได้ เฉพาะตอนที่ยังไม่มีคนรับ
    // (แจ้งผิด/แจ้งซ้ำแล้วอยากถอน — ถ้ามีคนรับไปแล้วต้องให้เจ้าหน้าที่จัดการ)
    const isOwnerCancelling = t.reporter_id === s.employee.id && to === "cancelled" && t.status === "pending";
    if (!isMemberOf(s, t.department_id) && !isOwnerCancelling) {
      throw new HttpError(403, "ไม่มีสิทธิ์ดำเนินการเรื่องนี้");
    }

    const from = t.status;
    assertTransition(from, to);

    // ปิดงานทั้งที่ยังไม่เคยแจ้งผลตรวจสอบ — ส่งรหัสกลับให้หน้าจอพาไปกรอกก่อนแล้วปิดให้ในคราวเดียว
    // (ดู /api/tickets/:id/assess พารามิเตอร์ then_complete) เรื่องที่เปิดแล้วปิดโดยไม่มีใครรู้ว่า
    // เกิดอะไรขึ้นคือช่องโหว่ที่ตั้งใจอุด
    if (to === "completed" && !t.assessed_at) {
      throw new HttpError(409, "กรุณาแจ้งผลตรวจสอบก่อนปิดงาน", "need_assessment");
    }

    const sql = db();
    const me = s.employee.id;

    // อัปเดตแบบมีเงื่อนไข status=from เพื่อกันการชนกัน (โดยเฉพาะการกดรับพร้อมกัน)
    let updated: { id: string }[];
    if (to === "completed") {
      updated = await sql`UPDATE tickets SET status='completed', completed_at=now(), updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    } else if (to === "closed") {
      updated = await sql`UPDATE tickets SET status='closed', closed_at=now(), updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    } else if (to === "in_progress") {
      updated = await sql`UPDATE tickets SET status='in_progress', assignee_id=${me}, acknowledged_at=COALESCE(acknowledged_at, now()), updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    } else if (to === "pending") {
      updated = await sql`UPDATE tickets SET status='pending', assignee_id=NULL, updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    } else {
      // cancelled
      updated = await sql`UPDATE tickets SET status='cancelled', updated_at=now() WHERE id=${id} AND status=${from} RETURNING id`;
    }

    if (updated.length === 0) {
      const msg = from === "pending" && to === "in_progress" ? "มีผู้รับเรื่องนี้ไปแล้ว" : "สถานะถูกเปลี่ยนไปแล้ว กรุณารีเฟรช";
      throw new HttpError(409, msg);
    }

    await sql`
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      VALUES (${id}, ${from}, ${to}, ${me}, ${note})
    `;

    t.status = to;
    if (to === "in_progress") t.assignee_name = s.employee.full_name;
    if (to === "pending") t.assignee_name = null;

    // การแจ้งเตือนทั้งหมดอยู่หลังบันทึกสำเร็จแล้ว ถ้าส่งข้อความไม่ผ่านก็ไม่ควรทำให้ผู้ใช้
    // เห็นว่าเปลี่ยนสถานะไม่สำเร็จทั้งที่บันทึกลงระบบไปแล้ว
    try {
      // แจ้งผู้แจ้งเมื่อสถานะเปลี่ยน (spec หัวข้อ 5.3)
      // ข้ามกรณีผู้แจ้งเป็นคนกดเอง — เขาเห็นผลบนหน้าจออยู่แล้ว การส่งซ้ำเปลืองโควตาข้อความเปล่า ๆ
      if (to === "completed") {
        // ปิดงานแล้วถามความพึงพอใจแทนการบอกสถานะ (ดู askReporterRating)
        await askReporterRating(t);
      } else if (!isOwnerCancelling) {
        // บอกชื่อผู้รับผิดชอบด้วยตอนมีคนรับเรื่อง ให้ตรงกับตอนกดปุ่มจากการ์ดในกลุ่ม
        // ไม่งั้นผู้แจ้งจะรู้ชื่อคนรับผิดชอบบ้างไม่รู้บ้าง ขึ้นอยู่กับว่าเจ้าหน้าที่กดจากที่ไหน
        const who = to === "in_progress" ? `\nผู้รับผิดชอบ: ${shortName(s.employee.full_name)}` : "";
        await tellReporter(
          t,
          `อัปเดตเรื่อง ${t.ticket_no}\nสถานะ: ${STATUS_LABELS[to] ?? to}${who}${note ? "\nหมายเหตุ: " + note : ""}`,
        );
      }

      // อัปเดตการ์ดในกลุ่มด้วย แม้การเปลี่ยนสถานะจะเกิดจากหน้าแอปไม่ใช่ปุ่มในกลุ่ม
      // ไม่อย่างนั้นกลุ่มจะค้างอยู่ที่การ์ดใบเก่า และไม่มีใครรู้ว่าใครเป็นคนรับผิดชอบต่อ
      await pushGroupCard(
        t,
        groupCard(t, {
          actorName: s.employee.full_name,
          cancelReason: to === "cancelled" ? note : null,
          ...justNow(s.employee.full_name),
        }),
      );
    } catch (e) {
      console.error("[tickets-status] notify failed", e);
    }

    return json({ ok: true, id, status: to, status_label: STATUS_LABELS[to] ?? to });
  });
