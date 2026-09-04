// POST /api/massage/cancel — ยกเลิกคิวของตัวเอง
//
// ต้องเป็นเจ้าของคิวเท่านั้น ระบบเดิมรับมาแค่ eventId แล้วลบทันทีโดยไม่ตรวจว่าใครสั่ง

import { getSession, requireActive } from "./_lib/auth";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { pushTo, textMessage } from "./_lib/line";
import { cancel, slotLabel, thaiDayLabel } from "./_lib/massage";
import { cancelledText } from "./_lib/massage-flex";
import { cancelNoticeMessage, notifyMassageGroup } from "./_lib/massage-group";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    requireActive(s);

    const { id } = await readJson<{ id?: string }>(req);
    if (!id) throw new HttpError(400, "ไม่ได้ระบุคิวที่จะยกเลิก");

    const gone = await cancel(id, s.employee.id);

    try {
      await pushTo(s.lineUserId, [
        textMessage(cancelledText(gone.day, gone.slot, gone.therapistName)),
      ]);
    } catch (e) {
      console.error("[massage] ส่งข้อความยืนยันการยกเลิกไม่สำเร็จ", e);
    }

    // แจ้งกลุ่มทีมงาน — ช่องที่ว่างกลางวันคือช่องที่ยกให้คิวด่วนได้ ถ้ารู้ช้าก็เสียไปเปล่า ๆ
    // ยังไม่ผูกกลุ่มไว้ก็เงียบไป ไม่ใช่เรื่องที่ต้องทำให้การยกเลิกล้ม
    await notifyMassageGroup([
      cancelNoticeMessage({
        name: s.employee.full_name,
        code: s.employee.employee_code,
        dayLabel: thaiDayLabel(gone.day),
        slotLabel: slotLabel(gone.slot),
        therapistName: gone.therapistName,
        keptQuota: gone.keptQuota,
      }),
    ]);

    return json({ ok: true, cancelled: gone });
  });
