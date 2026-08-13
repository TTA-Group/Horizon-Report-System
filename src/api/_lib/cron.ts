// ตัวช่วยสำหรับงานตามเวลา — ตรวจ CRON_SECRET เมื่อถูกเรียกแบบมี header (spec หัวข้อ 9.3)
//
// หมายเหตุ: งานตามเวลาถูกเรียกจาก Cron Trigger ภายในของ Cloudflare (ไม่ผ่าน URL สาธารณะ)
// การตรวจ secret นี้เป็นการป้องกันเพิ่มกรณีมีการเรียกผ่าน HTTP พร้อม header x-cron-secret

import { HttpError } from "./http";
import { envVar } from "./env";

export function assertCron(req: Request): void {
  const provided = req.headers.get("x-cron-secret");
  const expected = envVar("CRON_SECRET");
  // ถ้ามีการส่ง secret มา ต้องตรงกับที่ตั้งไว้
  if (provided !== null && expected && provided !== expected) {
    throw new HttpError(401, "unauthorized cron call");
  }
}

/** สำหรับ endpoint /api/cron/* ที่เปิดเป็น public URL — ต้องมี CRON_SECRET และตรงกันเสมอ */
export function requireCron(req: Request): void {
  const provided = req.headers.get("x-cron-secret");
  const expected = envVar("CRON_SECRET");
  if (!expected || provided !== expected) {
    throw new HttpError(401, "unauthorized cron call");
  }
}
