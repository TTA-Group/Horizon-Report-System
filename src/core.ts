// จุดเข้าของ Worker "core" — ระบบกลางขององค์กร
//
// ทำสองอย่างเท่านั้น: ลงทะเบียนพนักงาน (ผูกบัญชีไลน์กับรหัสพนักงาน) และหน้าจัดการข้อมูลของ HR
// ไม่มีตรรกะของระบบแจ้งปัญหาหรือระบบจองคิวนวดอยู่ในนี้เลย — เป็นกติกาเดียวกับ "ชั้นที่ 1"
// ในโครงข้อมูล (ดู spec.md หัวข้อ 3) ของที่ใส่เพิ่มเข้ามาต้องเป็นของที่ทุกระบบใช้ร่วมกันได้จริง
//
// หน้าจัดการมีปุ่มเปิด "ฟอร์มเช็คชื่อคิวนวด" ซึ่งเป็นแค่ลิงก์ไปเปิดแอปจองคิว
// ตัวฟอร์มกับ API ยังอยู่ที่ Worker massage ทั้งหมด ที่นี่ไม่ได้แตะข้อมูลคิวนวดเลย
//
// พนักงานลงทะเบียนที่นี่ครั้งเดียว แล้วใช้ได้ทุกระบบบน LINE OA เดียวกัน เพราะการผูกบัญชี
// ถูกเก็บด้วยกุญแจกลาง (CHANNEL_KEY = "core") ไม่ใช่กุญแจของระบบใดระบบหนึ่ง
//
// ใช้ฐานข้อมูลตัวเดียวกับระบบอื่น และแชร์โค้ดใน src/api/_lib/ ร่วมกัน จึงอยู่ repo เดียวกัน
// แต่ deploy แยกเป็นคนละ Worker (ดู wrangler.core.toml) ระบบอื่นล่มไม่กระทบการลงทะเบียน

import { withDbScope } from "./api/_lib/db";
import { setEnv } from "./api/_lib/env";
import { safeErrorText } from "./api/_lib/http";
import { serveAsset } from "./api/_lib/assets";

import health from "./api/health";
import authSession from "./api/auth-session";
import authVerifyEmployee from "./api/auth-verify-employee";
import authLink from "./api/auth-link";
import adminAdmins from "./api/admin-admins";
import adminEmployees from "./api/admin-employees";
import { followersImport, followersIngest, followersLink, followersList } from "./api/admin-followers";
import adminRichMenuPlan from "./api/admin-richmenu-plan";
import adminEmployeeCreate from "./api/admin-employee-create";
import adminEmployeeSuspend from "./api/admin-employee-suspend";
import adminEmployeeUnlink from "./api/admin-employee-unlink";
import adminEmployeeDepartments from "./api/admin-employee-departments";
import masters from "./api/masters";


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

  // /api/admin/followers — รายชื่อคนที่เป็นเพื่อนกับ LINE OA และการผูกบัญชีให้แทนเจ้าตัว
  if (seg[1] === "admin" && seg[2] === "followers") {
    if (seg.length === 3) return method === "POST" ? followersIngest : followersList;
    if (seg.length === 4 && seg[3] === "link") return method === "POST" ? followersLink : null;
    if (seg.length === 4 && seg[3] === "import") return method === "POST" ? followersImport : null;
    return null;
  }

  // /api/admin/richmenu/plan — ไล่ตั้ง rich menu ให้คนที่เป็นเพื่อนอยู่ก่อนแล้ว (เรียกจากเครื่องต่อเครื่อง)
  if (seg[1] === "admin" && seg[2] === "richmenu" && seg[3] === "plan" && seg.length === 4) {
    return method === "POST" ? adminRichMenuPlan : null;
  }

  // /api/admin/admins — ใครถือสิทธิ์อะไรอยู่บ้าง (อ่านอย่างเดียว การแก้ไปที่ employees/:id/departments)
  if (seg[1] === "admin" && seg[2] === "admins" && seg.length === 3) return adminAdmins;

  // /api/admin/employees — ทะเบียนพนักงาน สิทธิ์ และการผูกบัญชี ทั้งหมดอยู่ที่นี่ที่เดียว
  if (seg[1] === "admin" && seg[2] === "employees") {
    if (seg.length === 3) return method === "POST" ? adminEmployeeCreate : adminEmployees;
    if (seg.length === 5 && seg[4] === "suspend") return adminEmployeeSuspend;
    if (seg.length === 5 && seg[4] === "unlink") return adminEmployeeUnlink;
    if (seg.length === 5 && seg[4] === "departments") return adminEmployeeDepartments;
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

    if (!url.pathname.startsWith("/api/")) {
      return serveAsset(await env.ASSETS.fetch(request), url.pathname);
    }

    return jsonResponse({ error: "not found" }, 404);
  },
};
