// POST /api/massage/admin/attend — บันทึกว่ามาหรือไม่มา
//
// ส่ง attended = "present" | "no_show" | null (null = ยกเลิกการเช็ค กลับไปเป็นยังไม่ได้เช็ค)
// เก็บไว้ดูอย่างเดียวก่อน ยังไม่ตัดสิทธิ์ใคร — ควรเห็นตัวเลขจริงสักสองสามเดือนก่อนตั้งกติกา

import { getSession } from "./_lib/auth";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { assertMassageStaff } from "./_lib/massage";

const VALID = new Set(["present", "no_show"]);

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { id, attended } = await readJson<{ id?: string; attended?: string | null }>(req);
    if (!id) throw new HttpError(400, "ไม่ได้ระบุคิว");
    if (attended !== null && attended !== undefined && !VALID.has(attended)) {
      throw new HttpError(400, "ค่าการเช็คชื่อไม่ถูกต้อง");
    }

    const mark = attended ?? null;
    const rows = await db()<{ id: string }[]>`
      UPDATE massage_bookings
      SET attended = ${mark},
          checked_at = ${mark === null ? null : new Date()},
          checked_by = ${mark === null ? null : s.employee!.id},
          updated_at = now()
      WHERE id = ${id} AND status = 'booked'
      RETURNING id
    `;
    if (rows.length === 0) throw new HttpError(404, "ไม่พบคิวนี้ หรือคิวถูกยกเลิกไปแล้ว");

    return json({ ok: true, id, attended: mark });
  });
