// งานตามเวลาของระบบจองคิวนวด — รวมทุกงานไว้ใน cron เดียว
//
// Cloudflare แผนฟรีให้ตั้ง cron ได้ 5 ตัวต่อบัญชี ซึ่งต้องแบ่งกันใช้ทั้งสามระบบ
// ระบบนี้จึงใช้ตัวเดียว ทำงานทุก 15 นาที แล้วให้โค้ดดูนาฬิกาเองว่าถึงเวลาของงานไหน
//
// ทุกงานถูกออกแบบให้เรียกซ้ำได้ไม่พังตั้งแต่แรก จึงย้ายมารวมกันได้โดยไม่ต้องแก้ตรรกะ:
//   - open-month สั่งซ้ำได้ (INSERT ... ON CONFLICT DO NOTHING)
//   - remind     คิดช่วงเวลาจากนาฬิกาปัจจุบันเอง และส่งครั้งเดียวต่อคิว (กันด้วย remind_15_at)
//
// การคิดช่วงเวลาจากนาฬิกาปัจจุบันแทนที่จะพึ่งว่า cron จะยิงตรงเวลาเป๊ะ ทำให้รอบที่พลาดไป
// หนึ่งครั้งยังตามเก็บได้ในรอบถัดไป — Cloudflare ไม่รับประกันว่า cron จะยิงตรงนาที

import { assertCron } from "./_lib/cron";
import { json, run, safeErrorText } from "./_lib/http";
import { runMassageOpenMonth, runMassageReminders } from "./_lib/massage-jobs";

async function step<T>(name: string, fn: () => Promise<T>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    // งานที่พังต้องไม่ทำให้งานที่เหลือไม่ได้ทำงาน โดยเฉพาะการเตือนก่อนถึงคิว
    console.error("[massage-cron]", name, e);
    return { error: safeErrorText(e) };
  }
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);

    return json({
      // สร้างวันให้บริการของเดือนปัจจุบันถ้ายังไม่มี — เป็นตาข่ายกันกรณีที่ไม่มีวันให้จองทั้งเดือน
      // ไม่ต้องรอเวลาไหนเป็นพิเศษ เพราะการมีแถวไม่ได้แปลว่าเปิดให้จองแล้ว
      // (เวลาเปิดจองคุมด้วย monthOpensAt ในโค้ด ดู _lib/massage.ts)
      openMonth: await step("open-month", runMassageOpenMonth),

      // เตือนคนที่คิวจะเริ่มในอีกไม่เกิน 20 นาที — ฟังก์ชันคัดเองว่าใครเข้าเกณฑ์
      remind: await step("remind", runMassageReminders),
    });
  });
