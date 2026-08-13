// จุดเข้าของ Cloudflare Worker — ทำหน้าที่ 3 อย่าง
//   1. เสิร์ฟหน้าเว็บ LIFF (ไฟล์ใน public/) ผ่าน assets binding
//   2. จัดเส้นทาง /api/* ไปยังตัวจัดการเดิม (ใช้โค้ดชุดเดียวกับ Netlify ไม่ได้เขียนตรรกะซ้ำ)
//   3. รันงานตามเวลาผ่าน Cron Triggers
//
// ตัวจัดการทุกตัวรับ Request คืน Response ตามมาตรฐานเว็บอยู่แล้ว จึงเรียกใช้ได้ตรง ๆ
// ส่วน `export const config` ในไฟล์เหล่านั้นเป็นข้อมูลสำหรับ Netlify เท่านั้น ฝั่งนี้ไม่ได้ใช้

import { setEnv } from "../netlify/functions/_lib/env";

import authSession from "../netlify/functions/auth-session";
import authVerifyEmployee from "../netlify/functions/auth-verify-employee";
import authLink from "../netlify/functions/auth-link";
import masters from "../netlify/functions/masters";
import ticketsCreate from "../netlify/functions/tickets-create";
import ticketsDetail from "../netlify/functions/tickets-detail";
import ticketsStatus from "../netlify/functions/tickets-status";
import ticketsTransfer from "../netlify/functions/tickets-transfer";
import uploads from "../netlify/functions/uploads";
import adminEmployees from "../netlify/functions/admin-employees";
import adminEmployeeSuspend from "../netlify/functions/admin-employee-suspend";
import adminEmployeeUnlink from "../netlify/functions/admin-employee-unlink";
import lineWebhook from "../netlify/functions/line-webhook";
import cronReminders from "../netlify/functions/cron-reminders";

import reminders from "../netlify/functions/reminders";
import dbKeepalive from "../netlify/functions/db-keepalive";
import backup from "../netlify/functions/backup";
import cleanupFiles from "../netlify/functions/cleanup-files";
import usageReport from "../netlify/functions/usage-report";

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  [key: string]: unknown;
}

type Handler = (req: Request) => Promise<Response>;

/** จับคู่เส้นทางกับตัวจัดการ — ตัวจัดการอ่านพารามิเตอร์จาก URL เองอยู่แล้ว */
function route(pathname: string): Handler | null {
  const seg = pathname.split("/").filter(Boolean); // เช่น ['api','tickets','<id>','status']
  if (seg[0] !== "api") return null;

  // /api/auth/*
  if (seg[1] === "auth" && seg.length === 3) {
    if (seg[2] === "session") return authSession;
    if (seg[2] === "verify-employee") return authVerifyEmployee;
    if (seg[2] === "link") return authLink;
    return null;
  }

  // /api/masters
  if (seg[1] === "masters" && seg.length === 2) return masters;

  // /api/uploads
  if (seg[1] === "uploads" && seg.length === 2) return uploads;

  // /api/tickets, /api/tickets/:id, /api/tickets/:id/{status,transfer}
  if (seg[1] === "tickets") {
    if (seg.length === 2) return ticketsCreate;
    // :id ครอบคลุม "mine" และ "department" ด้วย — tickets-detail แยกให้เองภายใน
    if (seg.length === 3) return ticketsDetail;
    if (seg.length === 4 && seg[3] === "status") return ticketsStatus;
    if (seg.length === 4 && seg[3] === "transfer") return ticketsTransfer;
    return null;
  }

  // /api/admin/employees, /api/admin/employees/:id/{suspend,unlink}
  if (seg[1] === "admin" && seg[2] === "employees") {
    if (seg.length === 3) return adminEmployees;
    if (seg.length === 5 && seg[4] === "suspend") return adminEmployeeSuspend;
    if (seg.length === 5 && seg[4] === "unlink") return adminEmployeeUnlink;
    return null;
  }

  // /api/line/webhook
  if (seg[1] === "line" && seg[2] === "webhook" && seg.length === 3) return lineWebhook;

  // /api/cron/reminders
  if (seg[1] === "cron" && seg[2] === "reminders" && seg.length === 3) return cronReminders;

  return null;
}

// งานตามเวลา — คีย์ต้องตรงกับที่ตั้งไว้ใน wrangler.toml
// หมายเหตุ: Cloudflare ไม่รับเลข 0 ในช่องวันของสัปดาห์ จึงใช้ SUN แทน
const CRON_JOBS: Record<string, Handler> = {
  "*/15 * * * *": reminders,
  "0 3 * * *": dbKeepalive,
  "0 4 * * SUN": backup,
  "0 5 1 * *": cleanupFiles,
  "0 6 1 * *": usageReport,
};

/** ปรับรูปแบบ cron ให้เทียบกันได้ เผื่อช่องว่าง/ตัวพิมพ์ต่างกันเล็กน้อย */
function normalizeCron(expr: string): string {
  return expr.trim().replace(/\s+/g, " ").toUpperCase();
}
const CRON_LOOKUP = new Map(Object.entries(CRON_JOBS).map(([k, v]) => [normalizeCron(k), v]));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    setEnv(env);

    const url = new URL(request.url);
    const handler = route(url.pathname);

    if (handler) return handler(request);

    // ไม่ใช่ /api/* -> ส่งให้ไฟล์หน้าเว็บใน public/
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
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
      job(req)
        .then((res) => res.text())
        .then((body) => console.log("[cron]", event.cron, body))
        .catch((e) => console.error("[cron]", event.cron, e)),
    );
  },
};
