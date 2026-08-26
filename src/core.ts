// จุดเข้าของ Worker "core" — ระบบกลางขององค์กร
//
// เป็นแอปของ "ผู้ดูแล" และของ "คนที่ยังไม่ได้ลงทะเบียน" — ลงทะเบียนพนักงาน (ผูกบัญชีไลน์
// กับรหัสพนักงาน) · หน้าจัดการทะเบียนของ HR · และฟอร์มเช็คชื่อคิวนวด
//
// ตรรกะของระบบแจ้งปัญหาไม่มีอยู่ในนี้เลย ส่วนของระบบจองคิวนวดมีเฉพาะ "ฟอร์มเช็คชื่อ"
// ซึ่งเป็นงานของผู้ดูแลหน้างาน ไม่ใช่งานของคนจอง การจองทั้งหมดยังอยู่ที่ Worker massage
//
// กติกาสำหรับของที่จะใส่เพิ่มในอนาคต: ต้องเป็นของกลางที่ทุกระบบใช้ร่วมกัน หรือเป็นงานของ
// ผู้ดูแลที่ควรทำจบในแอปเดียว — ไม่ใช่ฟีเจอร์ที่พนักงานทั่วไปใช้ในระบบใดระบบหนึ่ง
//
// พนักงานลงทะเบียนที่นี่ครั้งเดียว แล้วใช้ได้ทุกระบบบน LINE OA เดียวกัน เพราะการผูกบัญชี
// ถูกเก็บด้วยกุญแจกลาง (CHANNEL_KEY = "core") ไม่ใช่กุญแจของระบบใดระบบหนึ่ง
//
// ใช้ฐานข้อมูลตัวเดียวกับระบบอื่น และแชร์โค้ดใน src/api/_lib/ ร่วมกัน จึงอยู่ repo เดียวกัน
// แต่ deploy แยกเป็นคนละ Worker (ดู wrangler.core.toml) ระบบอื่นล่มไม่กระทบการลงทะเบียน

import { withDbScope } from "./api/_lib/db";
import { setEnv } from "./api/_lib/env";
import { safeErrorText } from "./api/_lib/http";

import health from "./api/health";
import authSession from "./api/auth-session";
import authVerifyEmployee from "./api/auth-verify-employee";
import authLink from "./api/auth-link";
import adminEmployees from "./api/admin-employees";
import adminEmployeeCreate from "./api/admin-employee-create";
import adminEmployeeSuspend from "./api/admin-employee-suspend";
import adminEmployeeUnlink from "./api/admin-employee-unlink";
import adminEmployeeDepartments from "./api/admin-employee-departments";
import masters from "./api/masters";

// ฟอร์มเช็คชื่อคิวนวด — ย้ายมาจาก Worker massage ให้ผู้ดูแลทำงานจบในแอปเดียว
//
// ยอมรับว่านี่คือการดึงของจากระบบอื่นเข้ามาใน core ซึ่งขัดกับหลักที่เขียนไว้ด้านบน
// เหตุผลที่ยอม: การเช็คชื่อเป็นงานของผู้ดูแล ไม่ใช่งานของคนจอง และ core คือแอปของผู้ดูแลอยู่แล้ว
// สิ่งที่ยังแยกกันชัดเจนคือ "การจอง" ทั้งหมดยังอยู่ที่ Worker massage — ที่นี่แค่อ่านตารางกับกดเช็คชื่อ
import massageSheet from "./api/massage-sheet";
import massageAdminSheet from "./api/massage-admin-sheet";
import massageAttend from "./api/massage-attend";

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  [key: string]: unknown;
}

type Handler = (req: Request) => Promise<Response>;

function route(pathname: string, method: string): Handler | null {
  const seg = pathname.split("/").filter(Boolean);
  if (seg[0] !== "api") return null;

  // /api/auth/* — session ใช้ร่วมกับระบบอื่น ส่วน verify-employee กับ link มีที่นี่ที่เดียว
  if (seg[1] === "auth" && seg.length === 3) {
    if (seg[2] === "session") return authSession;
    if (seg[2] === "verify-employee") return authVerifyEmployee;
    if (seg[2] === "link") return authLink;
    return null;
  }

  if (seg[1] === "health" && seg.length === 2) return health;

  // รายชื่อฝ่ายและชั้น — หน้าเพิ่มพนักงานของ HR ใช้เติมตัวเลือกในฟอร์ม
  if (seg[1] === "masters" && seg.length === 2) return masters;

  // /api/admin/employees — ทะเบียนพนักงาน สิทธิ์ และการผูกบัญชี ทั้งหมดอยู่ที่นี่ที่เดียว
  if (seg[1] === "admin" && seg[2] === "employees") {
    if (seg.length === 3) return method === "POST" ? adminEmployeeCreate : adminEmployees;
    if (seg.length === 5 && seg[4] === "suspend") return adminEmployeeSuspend;
    if (seg.length === 5 && seg[4] === "unlink") return adminEmployeeUnlink;
    if (seg.length === 5 && seg[4] === "departments") return adminEmployeeDepartments;
    return null;
  }

  // ฟอร์มเช็คชื่อคิวนวด (ดูหมายเหตุตรงส่วน import)
  if (seg[1] === "massage") {
    // หน้าพร้อมพิมพ์ — เปิดได้ด้วยลิงก์ที่เซ็นกำกับ ไม่ต้องล็อกอิน
    if (seg.length === 3 && seg[2] === "sheet") return massageSheet;
    if (seg.length === 4 && seg[2] === "admin") {
      if (seg[3] === "sheet") return massageAdminSheet;
      if (seg[3] === "attend") return method === "POST" ? massageAttend : null;
    }
    return null;
  }

  return null;
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
};
