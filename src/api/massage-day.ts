// GET /api/massage/day?day=YYYY-MM-DD — ตารางคิวว่างของวันหนึ่ง
//
// ผลลัพธ์บอกแค่ว่าช่องไหนว่าง/ไม่ว่าง และช่องไหนเป็นของผู้ถามเอง ไม่มีชื่อคนอื่นอยู่ในนั้น
// (ระบบเดิมส่งทั้งตารางการจองกลับไปที่เบราว์เซอร์ ดูคำอธิบายใน _lib/massage.ts)

import { getSession, requireActive } from "./_lib/auth";
import { HttpError, json, methodGuard, run } from "./_lib/http";
import { dayAvailability } from "./_lib/massage";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireActive(s);

    const day = (new URL(req.url).searchParams.get("day") ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "รูปแบบวันที่ไม่ถูกต้อง");

    return json(await dayAvailability(day, s.employee.id));
  });
