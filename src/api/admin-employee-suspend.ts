// PATCH /api/admin/employees/:id/suspend — ระงับหรือคืนสิทธิ์ (spec หัวข้อ 5.5 / 6)
// body: { action: "suspend" | "restore", reason?: string }

import { getSession, invalidateSessionByEmployeeId, requireAdmin } from "./_lib/auth";
import { CHANNEL_KEY, CHANNEL_KEYS_READ } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { pushTo, textMessage } from "./_lib/line";

interface Body {
  action?: string;
  reason?: string;
}

function employeeIdFromPath(req: Request): string {
  const seg = new URL(req.url).pathname.split("/").filter(Boolean); // ['api','admin','employees','<id>','suspend']
  return seg[3] ?? "";
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "PATCH", "POST");
    const id = employeeIdFromPath(req);
    if (!id) throw new HttpError(404, "ไม่พบพนักงานนี้");

    const s = await getSession(req);
    requireAdmin(s);

    const body = await readJson<Body>(req);
    const action = (body.action ?? "").trim();
    if (action !== "suspend" && action !== "restore") {
      throw new HttpError(400, "action ต้องเป็น suspend หรือ restore");
    }

    const sql = db();
    if (action === "suspend") {
      const reason = (body.reason ?? "").trim() || null;
      const upd = await sql`
        UPDATE employees
        SET status = 'suspended', suspended_at = now(), suspended_by = ${s.employee.id},
            suspend_reason = ${reason}, updated_at = now()
        WHERE id = ${id} RETURNING id
      `;
      if (upd.length === 0) throw new HttpError(404, "ไม่พบพนักงานนี้");
      invalidateSessionByEmployeeId(id);
      return json({ ok: true, id, status: "suspended" });
    }

    // restore
    const upd = await sql`
      UPDATE employees
      SET status = 'active', suspended_at = NULL, suspended_by = NULL,
          suspend_reason = NULL, updated_at = now()
      WHERE id = ${id} RETURNING id
    `;
    if (upd.length === 0) throw new HttpError(404, "ไม่พบพนักงานนี้");

    // แจ้งพนักงานทาง LINE ว่าคืนสิทธิ์แล้ว (spec หัวข้อ 5.5)
    const acc = await sql<{ line_user_id: string }[]>`
      SELECT line_user_id FROM line_accounts
      WHERE employee_id = ${id} AND channel_key = ANY(${CHANNEL_KEYS_READ}) LIMIT 1
    `;
    if (acc.length > 0) {
      await pushTo(acc[0].line_user_id, [textMessage("บัญชีของคุณได้รับการคืนสิทธิ์การใช้งานแล้ว สามารถแจ้งเรื่องได้ตามปกติ")], {
        channel: "user",
      });
    }

    invalidateSessionByEmployeeId(id);
    return json({ ok: true, id, status: "active" });
  });
