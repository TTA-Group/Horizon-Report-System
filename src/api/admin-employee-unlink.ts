// PATCH /api/admin/employees/:id/unlink — ปลดการผูกบัญชี LINE ของพนักงานคนนี้ (เฉพาะผู้ดูแล)
//
// จำเป็นเพราะ 1 พนักงาน ผูกได้ 1 บัญชี LINE เท่านั้น ถ้าพนักงานเปลี่ยนมือถือ/เปลี่ยนบัญชี LINE
// รหัสพนักงานจะถูกล็อกกับบัญชีเดิมและเข้าใช้งานไม่ได้อีกเลย — ต้องมีทางให้ HR ปลดให้
// (ยิ่งจำเป็นเมื่อปิดการสมัครเอง เพราะจะไม่มีทางเลี่ยงอื่น)
//
// ลบเฉพาะการผูกบัญชี ไม่แตะข้อมูลพนักงานและเรื่องที่เคยแจ้งไว้

import { getSession, invalidateSessionByLineUserId, requireAdmin } from "./_lib/auth";
import { CHANNEL_KEY } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, run } from "./_lib/http";

function employeeIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','admin','employees','<id>','unlink']
  return seg[3] ?? "";
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "PATCH", "POST", "DELETE");
    const id = employeeIdFromPath(req);
    if (!id) throw new HttpError(404, "ไม่พบพนักงานนี้");

    const s = await getSession(req);
    requireAdmin(s);

    const sql = db();
    const removed = await sql<{ line_user_id: string }[]>`
      DELETE FROM line_accounts
      WHERE employee_id = ${id} AND channel_key = ${CHANNEL_KEY}
      RETURNING line_user_id
    `;
    if (removed.length === 0) throw new HttpError(404, "พนักงานคนนี้ยังไม่ได้ผูกบัญชี LINE");

    // ล้างแคช session ของบัญชีที่เพิ่งถูกปลด ไม่ให้ยังใช้งานต่อได้จนกว่าแคชจะหมดอายุ
    invalidateSessionByLineUserId(removed[0].line_user_id);

    return json({ ok: true, id, linked: false });
  });
