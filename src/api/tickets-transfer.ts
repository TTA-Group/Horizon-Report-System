// PATCH /api/tickets/:id/transfer — ส่งต่อฝ่ายอื่น (spec หัวข้อ 5.3 / 6)
// เปลี่ยน department_id คงสถานะ pending แล้ว push เข้ากลุ่มฝ่ายใหม่

import { getSession, isMemberOf, requireActive } from "./_lib/auth";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { pushTo } from "./_lib/line";
import { groupCard, justNow, loadCardRow, tellGroupMoved, tellReporter } from "./_lib/ticket-card";

interface Body {
  to_dept?: string;
}

function ticketIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','tickets','<id>','transfer']
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
    const toDept = (body.to_dept ?? "").trim().toUpperCase();
    if (!toDept) throw new HttpError(400, "กรุณาระบุฝ่ายปลายทาง");

    const sql = db();
    const t = await loadCardRow(id);
    if (!t) throw new HttpError(404, "ไม่พบเรื่องนี้");

    if (!isMemberOf(s, t.department_id)) throw new HttpError(403, "ไม่มีสิทธิ์ส่งต่อเรื่องของฝ่ายนี้");

    const dept = await sql<{ id: string; name: string; line_group_id: string | null }[]>`
      SELECT id, name, line_group_id FROM departments WHERE code = ${toDept} AND is_active = true AND receives_tickets = true LIMIT 1
    `;
    if (dept.length === 0) throw new HttpError(404, "ไม่พบฝ่ายปลายทาง");
    if (dept[0].id === t.department_id) throw new HttpError(400, "เรื่องนี้อยู่ในฝ่ายดังกล่าวอยู่แล้ว");

    await sql`
      UPDATE tickets
      SET department_id = ${dept[0].id}, status = 'pending', assignee_id = NULL,
          acknowledged_at = NULL, updated_at = now()
      WHERE id = ${id}
    `;
    await sql`
      INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
      VALUES (${id}, ${t.status}, 'pending', ${s.employee.id}, ${"ส่งต่อไปฝ่าย " + dept[0].name})
    `;

    // แจ้งกลุ่มฝ่ายใหม่ — ส่งต่อฝ่ายแล้วเรื่องกลับไปรอรับใหม่เสมอ จึงเป็นการ์ดใบเต็มให้แย่งกันกดรับ
    if (dept[0].line_group_id) {
      const flex = groupCard(t, {
        status: "pending",
        departmentName: dept[0].name,
        assigneeName: null,
        actorName: s.employee.full_name,
        ...justNow(s.employee.full_name),
      });
      await pushTo(dept[0].line_group_id, [flex], { ticketId: id, channel: "group" });
    }
    // แต่ละฝ่ายมีกลุ่มของตัวเอง กลุ่มเดิมจึงไม่เห็นการ์ดใบใหม่ — ถ้าไม่บอก จะเหลือการ์ดที่หยุดขยับ
    await tellGroupMoved(t.line_group_id, dept[0].line_group_id, t.ticket_no, dept[0].name, id);

    await tellReporter(t, `เรื่อง ${t.ticket_no} ถูกส่งต่อไปยัง ${dept[0].name} แล้ว`);

    return json({ ok: true, id, department_id: dept[0].id, status: "pending" });
  });
