// POST /api/massage/cancel — ยกเลิกคิวของตัวเอง
//
// ต้องเป็นเจ้าของคิวเท่านั้น ระบบเดิมรับมาแค่ eventId แล้วลบทันทีโดยไม่ตรวจว่าใครสั่ง

import { getSession, requireActive } from "./_lib/auth";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { pushTo, textMessage } from "./_lib/line";
import { cancel } from "./_lib/massage";
import { cancelledText } from "./_lib/massage-flex";

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

    return json({ ok: true, cancelled: gone });
  });
