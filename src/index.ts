// จุดเข้าของ Cloudflare Worker — ทำหน้าที่ 3 อย่าง
//   1. เสิร์ฟหน้าเว็บ LIFF (ไฟล์ใน public/) ผ่าน assets binding
//   2. จัดเส้นทาง /api/* ไปยังตัวจัดการใน src/api/
//   3. รันงานตามเวลาผ่าน Cron Triggers
//
// ตัวจัดการทุกตัวรับ Request คืน Response ตามมาตรฐานเว็บ จึงเรียกใช้ได้ตรง ๆ
// ไฟล์นี้เป็นแหล่งข้อมูลเดียวที่กำหนดว่าเส้นทางไหนไปตัวจัดการใด

import { withDbScope } from "./api/_lib/db";
import { setEnv } from "./api/_lib/env";
import { safeErrorText } from "./api/_lib/http";
import { serveAsset } from "./api/_lib/assets";

import health from "./api/health";
import authSession from "./api/auth-session";
import masters from "./api/masters";
import ticketsCreate from "./api/tickets-create";
import ticketsDetail from "./api/tickets-detail";
import ticketsStatus from "./api/tickets-status";
import ticketsAssess from "./api/tickets-assess";
import ticketsProgress from "./api/tickets-progress";
import ticketsRate from "./api/tickets-rate";
import reportsSummary from "./api/reports-summary";
import reportsView from "./api/reports-view";
import ticketsTransfer from "./api/tickets-transfer";
import uploads from "./api/uploads";
import lineWebhook from "./api/line-webhook";
import cronReminders from "./api/cron-reminders";

import reminders from "./api/reminders";
import dailyJobs from "./api/daily-jobs";

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  [key: string]: unknown;
}

type Handler = (req: Request) => Promise<Response>;

/**
 * จับคู่เส้นทางกับตัวจัดการ — ตัวจัดการอ่านพารามิเตอร์จาก URL เองอยู่แล้ว
 * ใช้ method ประกอบด้วยเฉพาะเส้นทางที่อ่านและเขียนคนละตัวจัดการกัน
 */
function route(pathname: string, method: string): Handler | null {
  const seg = pathname.split("/").filter(Boolean); // เช่น ['api','tickets','<id>','status']
  if (seg[0] !== "api") return null;

  // /api/auth/session — ระบบนี้แค่ "อ่าน" ว่าคนที่เข้ามาเป็นใครและมีสิทธิ์อะไร
  // ส่วนการลงทะเบียนผูกบัญชี (verify-employee / link) ย้ายไปอยู่ที่ระบบกลางแล้ว
  // มีที่เดียวเพื่อไม่ให้มีสองทางที่เขียนตาราง line_accounts ได้ (ดู src/core.ts)
  if (seg[1] === "auth" && seg.length === 3) {
    if (seg[2] === "session") return authSession;
    return null;
  }

  // /api/health — ตรวจสุขภาพระบบ (ไม่ต้องล็อกอิน ไม่เปิดเผยค่าตั้งค่า)
  if (seg[1] === "health" && seg.length === 2) return health;

  // /api/masters
  if (seg[1] === "masters" && seg.length === 2) return masters;

  // /api/uploads
  if (seg[1] === "uploads" && seg.length === 2) return uploads;

  // /api/tickets, /api/tickets/:id, /api/tickets/:id/{status,transfer,assess,progress,rate}
  if (seg[1] === "tickets") {
    if (seg.length === 2) return ticketsCreate;
    // :id ครอบคลุม "mine" และ "department" ด้วย — tickets-detail แยกให้เองภายใน
    if (seg.length === 3) return ticketsDetail;
    if (seg.length === 4 && seg[3] === "status") return ticketsStatus;
    if (seg.length === 4 && seg[3] === "transfer") return ticketsTransfer;
    if (seg.length === 4 && seg[3] === "assess") return ticketsAssess;
    if (seg.length === 4 && seg[3] === "progress") return ticketsProgress;
    if (seg.length === 4 && seg[3] === "rate") return ticketsRate;
    return null;
  }

  // /api/reports/summary (ต้องล็อกอิน) · /api/reports/view (ลิงก์ที่เซ็นกำกับ เปิดได้โดยไม่ต้องล็อกอิน)
  if (seg[1] === "reports" && seg.length === 3) {
    if (seg[2] === "summary") return reportsSummary;
    if (seg[2] === "view") return reportsView;
    return null;
  }

  // /api/line/webhook
  if (seg[1] === "line" && seg[2] === "webhook" && seg.length === 3) return lineWebhook;

  // /api/cron/reminders — เรียกด้วยมือได้ ต้องมี header x-cron-secret ตรงกับ CRON_SECRET
  //
  // งานรายวัน (daily-jobs) ไม่เปิดเป็น URL โดยตั้งใจ เพราะข้างในมีการสำรองข้อมูลพนักงาน
  // ทั้งองค์กรและการส่งข้อความหาผู้ดูแล ปล่อยให้ยิงจากภายนอกได้ไม่คุ้มกับประโยชน์ที่ได้
  // ตัว Cloudflare เรียกผ่าน scheduled() ซึ่งไม่ผ่านเส้นทางนี้อยู่แล้ว
  if (seg[1] === "cron" && seg[2] === "reminders" && seg.length === 3) return cronReminders;

  return null;
}

// งานตามเวลา — คีย์ต้องตรงกับที่ตั้งไว้ใน wrangler.toml
//
// Cloudflare แผนฟรีให้ตั้ง cron ได้ 5 ตัว "ต่อบัญชี" ไม่ใช่ต่อ Worker ระบบนี้เคยใช้ครบ 5 ตัว
// คนเดียวจนระบบที่สามตั้ง cron เพิ่มไม่ได้เลย จึงยุบงานรายวัน/รายสัปดาห์/รายเดือน
// มาอยู่ใน cron ตัวเดียว แล้วให้ daily-jobs.ts ดูปฏิทินเองว่าวันนี้ต้องทำงานไหนบ้าง
const CRON_JOBS: Record<string, Handler> = {
  "*/15 * * * *": reminders,
  "0 3 * * *": dailyJobs, // db-keepalive ทุกวัน · backup วันอาทิตย์ · cleanup-files + usage-report วันที่ 1
};

/** ปรับรูปแบบ cron ให้เทียบกันได้ เผื่อช่องว่าง/ตัวพิมพ์ต่างกันเล็กน้อย */
function normalizeCron(expr: string): string {
  return expr.trim().replace(/\s+/g, " ").toUpperCase();
}
const CRON_LOOKUP = new Map(Object.entries(CRON_JOBS).map(([k, v]) => [normalizeCron(k), v]));

/**
 * เติมชื่อโดเมนให้แท็ก og:image / og:url ก่อนส่งหน้าเว็บออกไป
 *
 * ตัวไต่ลิงก์ของไลน์ต้องการ URL เต็มถึงจะดึงภาพตัวอย่างมาแสดงได้ แต่ไฟล์ใน public/
 * ไม่มีทางรู้ว่าตัวเองถูกวางไว้ที่โดเมนไหน จึงเขียนไว้เป็นเส้นทาง แล้วเติมโดเมนตอนมีคำขอเข้ามา
 * ทำเฉพาะไฟล์ HTML — ไฟล์อื่น (js, png, svg) ส่งผ่านไปตรง ๆ ไม่ต้องแตะ
 */
const ABSOLUTE_META = new Set(["og:image", "og:url", "twitter:image"]);

function absolutizeMeta(res: Response, origin: string): Response {
  if (!(res.headers.get("content-type") ?? "").includes("text/html")) return res;
  return new HTMLRewriter()
    .on("meta", {
      element(el) {
        const key = el.getAttribute("property") ?? el.getAttribute("name");
        if (!key || !ABSOLUTE_META.has(key)) return;
        const value = el.getAttribute("content");
        if (!value || !value.startsWith("/")) return;
        el.setAttribute("content", origin + value);
      },
    })
    .transform(res);
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    setEnv(env);

    const url = new URL(request.url);
    const handler = route(url.pathname, request.method);

    if (handler) {
      // ตัวจัดการทุกตัวมีตัวดักจับข้อผิดพลาดของตัวเองอยู่แล้ว ถ้าหลุดมาถึงตรงนี้แปลว่าพัง
      // นอกเหนือจากนั้น (เช่น ข้อจำกัดของรันไทม์) — บันทึกไว้ให้เห็นสาเหตุจริง ไม่ใช่ 500 เปล่า ๆ
      try {
        return await withDbScope(() => handler(request));
      } catch (e) {
        console.error("[fatal]", request.method, url.pathname, e);
        return jsonResponse({ error: "internal error", detail: safeErrorText(e) }, 500);
      }
    }

    // ไม่ใช่ /api/* -> ส่งให้ไฟล์หน้าเว็บใน public/
    if (!url.pathname.startsWith("/api/")) {
      return serveAsset(absolutizeMeta(await env.ASSETS.fetch(request), url.origin), url.pathname);
    }

    return jsonResponse({ error: "not found" }, 404);
  },

  async scheduled(event: { cron: string }, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }): Promise<void> {
    setEnv(env);

    const job = CRON_LOOKUP.get(normalizeCron(event.cron));
    if (!job) {
      console.error("[cron] ไม่พบงานสำหรับรูปแบบเวลา", event.cron);
      return;
    }

    // งานตามเวลาไม่ได้มาจากคำขอจริง จึงสร้าง Request จำลองให้ตัวจัดการใช้
    // (assertCron จะผ่านเมื่อไม่มี header x-cron-secret ส่งมา ซึ่งเป็นกรณีนี้)
    const req = new Request("https://cron.internal/", { method: "POST" });
    ctx.waitUntil(
      withDbScope(() => job(req))
        .then((res) => res.text())
        .then((body) => console.log("[cron]", event.cron, body))
        .catch((e) => console.error("[cron]", event.cron, e)),
    );
  },
};
