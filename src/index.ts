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

import health from "./api/health";
import authSession from "./api/auth-session";
import authVerifyEmployee from "./api/auth-verify-employee";
import authLink from "./api/auth-link";
import masters from "./api/masters";
import ticketsCreate from "./api/tickets-create";
import ticketsDetail from "./api/tickets-detail";
import ticketsStatus from "./api/tickets-status";
import ticketsAssess from "./api/tickets-assess";
import ticketsProgress from "./api/tickets-progress";
import ticketsTransfer from "./api/tickets-transfer";
import uploads from "./api/uploads";
import adminEmployees from "./api/admin-employees";
import adminEmployeeCreate from "./api/admin-employee-create";
import adminEmployeeSuspend from "./api/admin-employee-suspend";
import adminEmployeeUnlink from "./api/admin-employee-unlink";
import adminEmployeeDepartments from "./api/admin-employee-departments";
import lineWebhook from "./api/line-webhook";
import cronReminders from "./api/cron-reminders";

import reminders from "./api/reminders";
import dbKeepalive from "./api/db-keepalive";
import backup from "./api/backup";
import cleanupFiles from "./api/cleanup-files";
import usageReport from "./api/usage-report";

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

  // /api/auth/*
  if (seg[1] === "auth" && seg.length === 3) {
    if (seg[2] === "session") return authSession;
    if (seg[2] === "verify-employee") return authVerifyEmployee;
    if (seg[2] === "link") return authLink;
    return null;
  }

  // /api/health — ตรวจสุขภาพระบบ (ไม่ต้องล็อกอิน ไม่เปิดเผยค่าตั้งค่า)
  if (seg[1] === "health" && seg.length === 2) return health;

  // /api/masters
  if (seg[1] === "masters" && seg.length === 2) return masters;

  // /api/uploads
  if (seg[1] === "uploads" && seg.length === 2) return uploads;

  // /api/tickets, /api/tickets/:id, /api/tickets/:id/{status,transfer,assess,progress}
  if (seg[1] === "tickets") {
    if (seg.length === 2) return ticketsCreate;
    // :id ครอบคลุม "mine" และ "department" ด้วย — tickets-detail แยกให้เองภายใน
    if (seg.length === 3) return ticketsDetail;
    if (seg.length === 4 && seg[3] === "status") return ticketsStatus;
    if (seg.length === 4 && seg[3] === "transfer") return ticketsTransfer;
    if (seg.length === 4 && seg[3] === "assess") return ticketsAssess;
    if (seg.length === 4 && seg[3] === "progress") return ticketsProgress;
    return null;
  }

  // /api/admin/employees (GET = รายชื่อ, POST = เพิ่มคน), /api/admin/employees/:id/{suspend,unlink}
  if (seg[1] === "admin" && seg[2] === "employees") {
    if (seg.length === 3) return method === "POST" ? adminEmployeeCreate : adminEmployees;
    if (seg.length === 5 && seg[4] === "suspend") return adminEmployeeSuspend;
    if (seg.length === 5 && seg[4] === "unlink") return adminEmployeeUnlink;
    if (seg.length === 5 && seg[4] === "departments") return adminEmployeeDepartments;
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
      return absolutizeMeta(await env.ASSETS.fetch(request), url.origin);
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
