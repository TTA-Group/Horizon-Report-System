// งานตามเวลาของระบบจองคิวนวด — รวมทุกงานไว้ใน cron เดียว
//
// Cloudflare แผนฟรีให้ตั้ง cron ได้ 5 ตัวต่อบัญชี ซึ่งต้องแบ่งกันใช้ทั้งสามระบบ
// ระบบนี้จึงใช้ตัวเดียว ทำงานทุก 15 นาที แล้วให้โค้ดดูนาฬิกาเองว่าถึงเวลาของงานไหน
//
// ทุกงานถูกออกแบบให้เรียกซ้ำได้ไม่พังตั้งแต่แรก จึงย้ายมารวมกันได้โดยไม่ต้องแก้ตรรกะ:
//   - open-month   สั่งซ้ำได้ (INSERT ... ON CONFLICT DO NOTHING)
//   - remind-eve   ส่งครั้งเดียวต่อคิว (กันด้วย remind_eve_at)
//   - remind-soon  คิดช่วงเวลาจากนาฬิกาปัจจุบันเอง (กันด้วย remind_soon_at)
//   - remind-final เตือนซ้ำก่อนถึงคิว 15 นาที (กันด้วย remind_15_at คนละคอลัมน์กับรอบแรก)
//
// การผูกเวลาไว้กับ "ชั่วโมงตามเวลาไทย" แทนที่จะพึ่งว่า cron จะยิงตรงเวลาเป๊ะ ทำให้รอบที่
// พลาดไปหนึ่งครั้งยังตามเก็บได้ในรอบถัดไป — Cloudflare ไม่รับประกันว่า cron จะยิงตรงนาที

import { assertCron } from "./_lib/cron";
import { json, run, safeErrorText } from "./_lib/http";
import {
  runMassageEveReminders,
  runMassageFinalReminders,
  runMassageOpenMonth,
  runMassageSoonReminders,
} from "./_lib/massage-jobs";

/** ชั่วโมงตามเวลาไทย 0–23 */
function bangkokHour(now = new Date()): number {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).getUTCHours();
}

/** เวลาที่เริ่มส่งข้อความเตือนล่วงหน้าหนึ่งวัน (เย็นวันก่อนถึงคิว) */
const EVE_FROM_HOUR = 17;

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
    const hour = bangkokHour();

    return json({
      // สร้างวันให้บริการของเดือนปัจจุบันถ้ายังไม่มี — เป็นตาข่ายกันกรณีที่ไม่มีวันให้จองทั้งเดือน
      // ไม่ต้องรอเวลาไหนเป็นพิเศษ เพราะการมีแถวไม่ได้แปลว่าเปิดให้จองแล้ว
      // (เวลาเปิดจองคุมด้วย monthOpensAt ในโค้ด ดู _lib/massage.ts)
      openMonth: await step("open-month", runMassageOpenMonth),

      // เตือนคนที่มีคิวพรุ่งนี้ ตั้งแต่ 17:00 เป็นต้นไป ส่งครั้งเดียวต่อคิว
      eve:
        hour >= EVE_FROM_HOUR
          ? await step("remind-eve", runMassageEveReminders)
          : { skipped: `ยังไม่ถึง ${EVE_FROM_HOUR}:00 น.` },

      // เตือนคนที่คิวจะเริ่มในอีกประมาณครึ่งชั่วโมง — ฟังก์ชันคัดเองว่าใครเข้าเกณฑ์
      soon: await step("remind-soon", runMassageSoonReminders),

      // เตือนซ้ำอีกครั้งตอนใกล้ถึงคิวจริง ๆ (ไม่เกิน 20 นาทีก่อนรอบเริ่ม)
      final: await step("remind-final", runMassageFinalReminders),
    });
  });
