// POST /api/massage/admin/cancel · POST /api/massage/admin/move — ผู้ดูแลจัดการคิวแทนพนักงาน
//
// มีเพื่อให้ผู้ดูแลหน้างานแก้ของจริงได้ เช่น พนักงานโทรมาบอกว่ามาไม่ได้ หรือขอสลับรอบ
// ถ้าไม่มีทางแก้ ช่องนั้นจะค้างเป็น "จองแล้ว" ทั้งที่ไม่มีใครมา และไม่มีใครจองแทนได้
//
// ทั้งสองเส้นทางบังคับสิทธิ์ด้วย assertMassageStaff เหมือนฟอร์มเช็คชื่อ
// และแจ้งเจ้าตัวทางไลน์เสมอ เพราะเป็นการแก้คิวของคนอื่น เจ้าตัวต้องรู้ว่ามีอะไรเปลี่ยน

import { getSession } from "./_lib/auth";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { adminCancel, adminMove, assertMassageStaff } from "./_lib/massage";
import { massageNotice } from "./_lib/massage-flex";
import { pushTo, textMessage } from "./_lib/line";
import { db } from "./_lib/db";

/** ส่งข้อความบอกเจ้าของคิว — ส่งไม่ได้ก็ไม่ให้ทั้งคำขอล้ม เพราะงานหลักบันทึกไปแล้ว */
async function notify(employeeId: string, text: string): Promise<void> {
  try {
    const rows = await db()<{ line_user_id: string }[]>`
      SELECT line_user_id FROM line_accounts WHERE employee_id = ${employeeId} AND channel_key = 'core'
    `;
    if (rows.length > 0) await pushTo(rows[0].line_user_id, [textMessage(text)]);
  } catch (e) {
    console.error("[massage] แจ้งเจ้าของคิวไม่สำเร็จ", e);
  }
}

export const massageAdminCancel = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { id, reason } = await readJson<{ id?: string; reason?: string }>(req);
    if (!id) throw new HttpError(400, "ไม่ได้ระบุคิว");

    const b = await adminCancel(id, s.employee!.id, reason || "ผู้ดูแลยกเลิกให้");
    await notify(
      b.employeeId,
      massageNotice(
        "เจ้าหน้าที่ยกเลิกคิวนวดของคุณ",
        b.day,
        b.slot,
        b.therapistName,
        "หากต้องการจองใหม่ เข้าไปจองในแอปได้เลย",
      ),
    );
    return json({ ok: true, id, day: b.day, slot: b.slot });
  });

export const massageAdminMove = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { id, slot, therapistId } = await readJson<{
      id?: string; slot?: string; therapistId?: string;
    }>(req);
    if (!id || !slot || !therapistId) throw new HttpError(400, "ข้อมูลไม่ครบ");

    const b = await adminMove(id, slot, therapistId);
    console.log("[massage] ย้ายคิว", id, "->", b.day, b.slot, "โดย", s.employee!.employee_code);
    await notify(
      b.employeeId,
      massageNotice(
        "เจ้าหน้าที่ย้ายคิวนวดของคุณ",
        b.day,
        b.slot,
        b.therapistName,
        "นี่คือรอบใหม่ของคุณ หากไม่สะดวก กรุณาแจ้งเจ้าหน้าที่",
      ),
    );
    return json({ ok: true, id, day: b.day, slot: b.slot, therapistId: b.therapistId });
  });
