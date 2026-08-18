// POST /api/tickets — สร้างเรื่องใหม่ (spec หัวข้อ 5.2 / 6)

import { getSession, requireActive } from "./_lib/auth";
import { CATEGORY_BY_CODE, URGENCY_CODES, type UrgencyCode } from "./_lib/constants";
import { db } from "./_lib/db";
import { buildTicketFlex } from "./_lib/flex";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { pushTo, textMessage } from "./_lib/line";
import { groupMessages } from "./_lib/mentions";
import { currentYYMM, thaiDateTime } from "./_lib/tickets";

interface Body {
  category_code?: string;
  floor?: string;
  location_note?: string;
  detail?: string;
  urgency?: string;
  attachments?: string[];
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    requireActive(s);

    const body = await readJson<Body>(req);
    const category = CATEGORY_BY_CODE.get((body.category_code ?? "").trim());
    if (!category) throw new HttpError(400, "กรุณาเลือกประเภทเรื่องที่แจ้ง");
    // ผู้แจ้งเลือก "ชั้นอื่น" แล้วพิมพ์เองได้ ค่านี้จึงไม่จำกัดอยู่แค่รายการใน FLOORS
    // แต่ต้องไม่ยาวเกินความกว้างของคอลัมน์ ไม่งั้นฐานข้อมูลจะปฏิเสธและเรื่องหายไปทั้งใบ
    const floor = (body.floor ?? "").trim();
    if (!floor) throw new HttpError(400, "กรุณาเลือกชั้นที่เกิดเหตุ");
    if (floor.length > 20) throw new HttpError(400, "ชั้นที่ระบุยาวเกินไป (ไม่เกิน 20 ตัวอักษร)");
    const detail = (body.detail ?? "").trim();
    if (!detail) throw new HttpError(400, "กรุณาระบุรายละเอียดของปัญหา");
    const urgency = (body.urgency ?? "normal").trim();
    if (!URGENCY_CODES.has(urgency)) throw new HttpError(400, "ระดับความเร่งด่วนไม่ถูกต้อง");
    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((x) => typeof x === "string").slice(0, 3)
      : [];
    const locationNote = (body.location_note ?? "").trim() || null;

    const sql = db();

    // ฝ่ายปลายทางกำหนดจาก mapping ของหมวด ไม่ให้ผู้ใช้เลือกเอง (spec หัวข้อ 5.2)
    const deptRows = await sql<{ id: string; name: string; line_group_id: string | null }[]>`
      SELECT id, name, line_group_id FROM departments
      WHERE code = ${category.deptCode} AND is_active = true LIMIT 1
    `;
    if (deptRows.length === 0) throw new HttpError(400, "ไม่พบฝ่ายปลายทางของหมวดนี้");
    const departmentId = deptRows[0].id;
    const departmentName = deptRows[0].name;
    const lineGroupId = deptRows[0].line_group_id;

    // จำกัดอัตราการแจ้ง: ไม่เกิน 10 เรื่อง/คน/ชั่วโมง (spec หัวข้อ 10)
    const recent = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM tickets
      WHERE reporter_id = ${s.employee.id} AND created_at > now() - interval '1 hour'
    `;
    if (recent[0].n >= 10) throw new HttpError(429, "แจ้งเรื่องบ่อยเกินไป กรุณาลองใหม่ภายหลัง");

    const yymm = currentYYMM();
    const reporterId = s.employee.id;

    const created = (await sql.begin(async (tx) => {
      // ล็อกเพื่อกันเลขที่เรื่องซ้ำภายในฝ่าย+เดือนเดียวกัน (spec หัวข้อ 4)
      await tx`SELECT pg_advisory_xact_lock(hashtext(${category.prefix + yymm}))`;
      const cnt = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM tickets
        WHERE department_id = ${departmentId} AND ticket_no LIKE ${category.prefix + "-" + yymm + "-%"}
      `;
      const seq = String(cnt[0].n + 1).padStart(3, "0");
      const ticketNo = `${category.prefix}-${yymm}-${seq}`;

      const ins = await tx`
        INSERT INTO tickets
          (ticket_no, reporter_id, category_code, department_id, floor, location_note, detail, urgency, status)
        VALUES
          (${ticketNo}, ${reporterId}, ${category.code}, ${departmentId}, ${floor}, ${locationNote}, ${detail}, ${urgency}, 'pending')
        RETURNING id, ticket_no, status
      `;
      const ticket = ins[0] as { id: string; ticket_no: string; status: string };

      await tx`
        INSERT INTO ticket_events (ticket_id, from_status, to_status, actor_id, note)
        VALUES (${ticket.id}, NULL, 'pending', ${reporterId}, 'ส่งเรื่อง')
      `;
      for (const url of attachments) {
        await tx`
          INSERT INTO ticket_attachments (ticket_id, file_url, phase, uploaded_by)
          VALUES (${ticket.id}, ${url}, 'report', ${reporterId})
        `;
      }
      return ticket;
    })) as { id: string; ticket_no: string; status: string };

    // แจ้งเตือนเข้ากลุ่มฝ่าย + กรณี critical แจ้งสมาชิกรายบุคคลเพิ่ม (spec หัวข้อ 5.2)
    // ticket ถูกบันทึกสำเร็จแล้วที่บรรทัดบน ๆ (ผ่าน sql.begin) — ครอบการแจ้งเตือนด้วย try/catch
    // เพื่อไม่ให้ปัญหาการส่งข้อความ LINE (เช่น token ผิด, LINE API ล่ม) ทำให้ผู้ใช้เห็นว่าแจ้งเรื่องไม่สำเร็จ
    // ทั้งที่จริงบันทึกเข้าระบบแล้ว
    try {
      const flex = buildTicketFlex({
        ticketId: created.id,
        ticketNo: created.ticket_no,
        status: "pending",
        departmentCode: category.deptCode,
        departmentName,
        categoryLabel: category.label,
        reporterName: s.employee.full_name,
        reporterDept: s.employee.department_name,
        floor,
        locationNote,
        detail,
        urgency: urgency as UrgencyCode,
        createdAtLabel: thaiDateTime(),
      });

      if (lineGroupId) {
        // เรียกเจ้าหน้าที่ของฝ่ายที่รับผิดชอบด้วย @mention เพราะทุกฝ่ายใช้กลุ่มไลน์ร่วมกัน
        const messages = await groupMessages(
          departmentId,
          `🔔 เรื่องใหม่ ${created.ticket_no} · ${category.label}`,
          flex,
        );
        await pushTo(lineGroupId, messages, { ticketId: created.id, channel: "group" });
      }
      // งาน "เร่งด่วนมาก" เคยส่งการ์ดซ้ำเข้าแชทส่วนตัวของเจ้าหน้าที่ทุกคนตาม spec หัวข้อ 5.2
      // เลิกทำแล้ว: @mention ในกลุ่มเด้งเตือนถึงตัวคนอยู่แล้วแม้ปิดเสียงกลุ่ม การส่งซ้ำจึงได้แค่
      // ข้อความซ้ำในสองที่ และกินโควตาข้อความของ OA เพิ่มตามจำนวนเจ้าหน้าที่ในฝ่าย

      // แจ้งกลับผู้แจ้งพร้อมเลขที่เรื่อง
      await pushTo(
        s.lineUserId,
        [
          textMessage(
            `รับเรื่องของคุณแล้ว เลขที่ ${created.ticket_no}\nระบบส่งเรื่องถึง ${category.label} เรียบร้อย ติดตามสถานะได้ในเมนู “เรื่องที่แจ้ง”`,
          ),
        ],
        { ticketId: created.id, channel: "user" },
      );
    } catch (e) {
      console.error("[tickets-create] notify failed", e);
    }

    return json({ ok: true, id: created.id, ticket_no: created.ticket_no, status: created.status });
  });
