// จุดเข้าของ Worker "massage" — ระบบจองคิวนวด (Horizon Wellness)
//
// เป็น Worker ตัวที่สามต่อจาก report (ระบบแจ้งปัญหา) และ core (ลงทะเบียนพนักงาน)
// อยู่ repo เดียวกันเพราะใช้ฐานข้อมูลตัวเดียวกันและแชร์โค้ดใน src/api/_lib/ ร่วมกัน
// แต่ deploy แยก เพราะบั๊กของระบบจองไม่ควรทำให้การเตือน SLA ของระบบแจ้งปัญหาหยุดทำงาน
// และการแก้ระบบจองไม่ควรต้อง deploy ระบบที่ทั้งออฟฟิศใช้อยู่ใหม่ทุกครั้ง
//
// ระบบนี้ไม่รับ webhook ของไลน์ (ตัวรับยังเป็น report เหมือนเดิม เพราะ LINE OA หนึ่งบัญชี
// ตั้ง webhook ได้ปลายทางเดียว) ปุ่มบนการ์ดจึงเป็นลิงก์ LIFF ไม่ใช่ postback
//
// ไม่แตะกลุ่มไลน์เลย ข้อความทุกอย่างเป็นข้อความส่วนตัวถึงเจ้าตัว

import { withDbScope } from "./api/_lib/db";
import { setEnv } from "./api/_lib/env";
import { safeErrorText } from "./api/_lib/http";

import health from "./api/health";
import authSession from "./api/auth-session";
import massageState from "./api/massage-state";
import massageDay from "./api/massage-day";
import massageBook from "./api/massage-book";
import massageCancel from "./api/massage-cancel";
import massageSheet from "./api/massage-sheet";
import massageAdminSheet from "./api/massage-admin-sheet";
import massageAttend from "./api/massage-attend";

import massageOpenMonth from "./api/massage-open-month";
import massageRemindEve from "./api/massage-remind-eve";
import massageRemindSoon from "./api/massage-remind-soon";

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  [key: string]: unknown;
}

type Handler = (req: Request) => Promise<Response>;

function route(pathname: string, method: string): Handler | null {
  const seg = pathname.split("/").filter(Boolean);
  if (seg[0] !== "api") return null;

  // อ่านอย่างเดียวว่าคนที่เข้ามาเป็นใคร — การลงทะเบียนผูกบัญชีอยู่ที่ core ที่เดียว
  if (seg[1] === "auth" && seg[2] === "session" && seg.length === 3) return authSession;

  if (seg[1] === "health" && seg.length === 2) return health;

  if (seg[1] === "massage") {
    if (seg.length === 3) {
      if (seg[2] === "state") return massageState;
      if (seg[2] === "day") return massageDay;
      if (seg[2] === "book") return method === "POST" ? massageBook : null;
      if (seg[2] === "cancel") return method === "POST" ? massageCancel : null;
      // หน้าฟอร์มพร้อมพิมพ์ — เปิดได้ด้วยลิงก์ที่เซ็นกำกับ ไม่ต้องล็อกอิน
      if (seg[2] === "sheet") return massageSheet;
      return null;
    }
    if (seg.length === 4 && seg[2] === "admin") {
      if (seg[3] === "sheet") return massageAdminSheet;
      if (seg[3] === "attend") return method === "POST" ? massageAttend : null;
      return null;
    }
    return null;
  }

  if (seg[1] === "cron" && seg.length === 3) {
    if (seg[2] === "open-month") return massageOpenMonth;
    if (seg[2] === "remind-eve") return massageRemindEve;
    if (seg[2] === "remind-soon") return massageRemindSoon;
    return null;
  }

  return null;
}

// งานตามเวลา — คีย์ต้องตรงกับที่ตั้งไว้ใน wrangler.massage.toml (เวลาเป็น UTC)
const CRON_JOBS: Record<string, Handler> = {
  "0 1 * * *": massageOpenMonth,      // 08:00 น. เวลาไทย ทุกวัน
  "0 10 * * *": massageRemindEve,     // 17:00 น. เวลาไทย ทุกวัน
  "*/15 2-9 * * *": massageRemindSoon, // 09:00–16:45 น. เวลาไทย
};

function normalizeCron(expr: string): string {
  return expr.trim().replace(/\s+/g, " ").toUpperCase();
}
const CRON_LOOKUP = new Map(Object.entries(CRON_JOBS).map(([k, v]) => [normalizeCron(k), v]));

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
      try {
        return await withDbScope(() => handler(request));
      } catch (e) {
        console.error("[fatal]", request.method, url.pathname, e);
        return jsonResponse({ error: "internal error", detail: safeErrorText(e) }, 500);
      }
    }

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    return jsonResponse({ error: "not found" }, 404);
  },

  async scheduled(
    event: { cron: string },
    env: Env,
    ctx: { waitUntil: (p: Promise<unknown>) => void },
  ): Promise<void> {
    setEnv(env);

    const job = CRON_LOOKUP.get(normalizeCron(event.cron));
    if (!job) {
      console.error("[cron] ไม่พบงานสำหรับรูปแบบเวลา", event.cron);
      return;
    }

    const req = new Request("https://cron.internal/", { method: "POST" });
    ctx.waitUntil(
      withDbScope(() => job(req))
        .then((res) => res.text())
        .then((body) => console.log("[cron]", event.cron, body))
        .catch((e) => console.error("[cron]", event.cron, e)),
    );
  },
};
