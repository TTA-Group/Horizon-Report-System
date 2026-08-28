// POST /api/admin/richmenu/plan — ส่งรายชื่อผู้ติดตามมา แล้วบอกกลับว่าแต่ละคนควรได้เมนูไหน
//
// มีไว้ตอนเปิดใช้ระบบเมนูครั้งแรก คนที่เป็นเพื่อนกับ LINE OA อยู่ก่อนแล้วจะไม่มี event
// "แอดเพื่อน" ให้ระบบจับได้อีก (event นั้นเกิดครั้งเดียวตอนแอดและผ่านไปแล้ว) จึงต้องมี
// ทางไล่ตั้งเมนูให้ย้อนหลังทีเดียวทั้งองค์กร
//
// ทำไมถึงคืน "คำสั่ง" ออกไปแทนที่จะยิงเอง: Worker ของ Cloudflare จำกัดจำนวนคำขอย่อย
// ต่อหนึ่งคำขอ (แผนฟรี 50 ครั้ง) องค์กรที่มีพนักงานหลายร้อยคนจึงวนยิงในนี้ไม่จบแน่นอน
// ตัวที่ถือรายชื่อผู้ติดตามอยู่แล้ว (Power Automate) เป็นคนยิงเองเหมาะกว่า
//
// ป้องกันด้วย CRON_SECRET เพราะผลลัพธ์มี LINE user ID ของพนักงานอยู่ข้างใน
// และเป็นการเรียกจากเครื่องต่อเครื่อง ไม่มีคนล็อกอินให้ตรวจสิทธิ์แบบปกติได้

import { requireCron } from "./_lib/cron";
import { HttpError, json, listFrom, methodGuard, readJson, run } from "./_lib/http";
import { planRichMenus } from "./_lib/richmenu";

/** จำกัดต่อหนึ่งคำขอ ให้ฝั่งที่เรียกแบ่งส่งเป็นชุด ๆ แทนการยัดมาทีเดียวทั้งบริษัท */
const MAX_IDS = 500;

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    requireCron(req);

    const userIds = listFrom(await readJson<unknown>(req), "userIds");
    if (userIds === null) {
      throw new HttpError(400, "ส่ง userIds มาเป็นรายการ หรือส่งรายการมาตรง ๆ ก็ได้");
    }
    const ids = userIds
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.startsWith("U"));
    if (ids.length === 0) return json({ ok: true, plans: [] });
    if (ids.length > MAX_IDS) {
      throw new HttpError(400, `ส่งได้ครั้งละไม่เกิน ${MAX_IDS} รายชื่อ กรุณาแบ่งส่งเป็นชุด`);
    }

    const plans = await planRichMenus(ids);
    if (plans === null) {
      throw new HttpError(409, "ยังไม่ได้ตั้งค่า RICHMENU_NEW_ID และ RICHMENU_MEMBER_ID", "not_configured");
    }
    return json({ ok: true, plans });
  });
