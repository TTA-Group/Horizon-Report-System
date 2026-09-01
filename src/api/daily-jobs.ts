// งานตามเวลารายวันของระบบแจ้งปัญหา — รวมหลายงานไว้ใน cron เดียว
//
// ทำไมต้องรวม: Cloudflare แผนฟรีให้ตั้ง cron ได้ 5 ตัว "ต่อบัญชี" ไม่ใช่ต่อ Worker
// ระบบแจ้งปัญหาเคยใช้ครบ 5 ตัวคนเดียว พอมีระบบที่สามเข้ามาจึงตั้ง cron เพิ่มไม่ได้เลย
// (deploy ขึ้นได้ แต่ตอนตั้งงานตามเวลาจะขึ้น error 10072)
//
// วิธีแก้คือให้ cron เป็นแค่ "จังหวะปลุก" แล้วให้โค้ดดูปฏิทินเองว่าวันนี้ต้องทำงานไหนบ้าง
// ตอนนี้ทั้งสามระบบใช้ cron รวมกัน 3 ตัว เหลือที่ว่างให้ระบบถัดไปอีก 2 ตัว
//
// แต่ละงานถูกครอบแยกกัน งานที่พังจึงไม่ทำให้งานที่เหลือไม่ได้ทำงาน — สำคัญเพราะงานพวกนี้
// ทำงานวันละครั้ง ถ้างานแรกพังแล้วหยุดทั้งชุด กว่าจะรู้ก็ผ่านไปหลายวัน

import { assertCron } from "./_lib/cron";
import { json, run, safeErrorText } from "./_lib/http";

import dbKeepalive from "./db-keepalive";
import backup from "./backup";
import cleanupFiles from "./cleanup-files";

type Handler = (req: Request) => Promise<Response>;

const JOBS: Record<string, Handler> = {
  "db-keepalive": dbKeepalive,
  backup,
  "cleanup-files": cleanupFiles,
};

/**
 * วันนี้ต้องทำงานไหนบ้าง (อิงปฏิทินไทย ไม่ใช่ UTC)
 *
 * แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพื่อให้ทดสอบวันอาทิตย์กับวันที่ 1 ได้โดยไม่ต้องรอให้ถึงวันจริง
 */
export function plannedJobs(now = new Date()): string[] {
  const th = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const plan = ["db-keepalive"]; // ทุกวัน — กันฐานข้อมูลระดับฟรีถูกพักการทำงาน
  if (th.getUTCDay() === 0) plan.push("backup"); // วันอาทิตย์
  if (th.getUTCDate() === 1) plan.push("cleanup-files"); // วันที่ 1 ของเดือน
  return plan;
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    assertCron(req);

    const results: Record<string, unknown> = {};
    for (const name of plannedJobs()) {
      try {
        const res = await JOBS[name](req);
        // ตัวจัดการแต่ละตัวมีตัวดักจับของตัวเองอยู่แล้ว ที่หลุดมาถึงนี่คือกรณีที่ดักไม่ได้จริง ๆ
        results[name] = res.ok ? { ok: true } : { ok: false, status: res.status, body: await res.text() };
      } catch (e) {
        console.error("[daily]", name, e);
        results[name] = { ok: false, error: safeErrorText(e) };
      }
    }

    return json({ ok: true, ran: Object.keys(results), results });
  });
