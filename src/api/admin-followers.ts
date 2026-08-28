// รายชื่อคนที่เป็นเพื่อนกับ LINE OA และการผูกบัญชีให้พนักงานแทนเจ้าตัว
//
//   POST /api/admin/followers        รับรายชื่อที่ดึงมาจาก LINE เข้ามาเก็บ (เครื่องต่อเครื่อง)
//   GET  /api/admin/followers        คนที่เป็นเพื่อนแต่ยังไม่ได้ผูกรหัสพนักงาน (ฝ่ายบุคคล)
//   POST /api/admin/followers/link   ฝ่ายบุคคลจับคู่แล้วผูกให้เลย (ฝ่ายบุคคล)
//
// มีเพื่อไม่ต้องให้พนักงานทุกคนมานั่งลงทะเบียนเอง — LINE ไม่บอกว่า userId ไหนเป็นของใคร
// คนที่รู้คือฝ่ายบุคคลซึ่งเห็นรายชื่อแชทใน OA Manager อยู่แล้ว หน้านี้จึงเอาชื่อไลน์กับรูป
// มากางให้ แล้วให้คนเป็นคนจับคู่ ระบบไม่เดาให้เอง เพราะเดาผิดแปลว่าคนหนึ่งได้คิวนวด
// และเรื่องแจ้งของอีกคน ส่วนเจ้าตัวจริงจะเข้าระบบไม่ได้เลย

import { getSession, invalidateSessionByLineUserId, requireAdmin } from "./_lib/auth";
import { CHANNEL_KEY, CHANNEL_KEYS_READ } from "./_lib/constants";
import { requireCron } from "./_lib/cron";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { syncRichMenu } from "./_lib/richmenu";

/** จำกัดต่อหนึ่งคำขอ ให้ฝั่งที่ส่งแบ่งเป็นชุด แทนการยัดมาทีเดียวทั้งบริษัท */
const MAX_BATCH = 500;

interface Incoming {
  userId?: unknown;
  displayName?: unknown;
  pictureUrl?: unknown;
}

/** POST /api/admin/followers — รับรายชื่อผู้ติดตามเข้ามาเก็บ */
export const followersIngest = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    requireCron(req);

    const { followers } = await readJson<{ followers?: unknown }>(req);
    if (!Array.isArray(followers)) throw new HttpError(400, "followers ต้องเป็นรายการ");
    if (followers.length > MAX_BATCH) {
      throw new HttpError(400, `ส่งได้ครั้งละไม่เกิน ${MAX_BATCH} รายชื่อ กรุณาแบ่งส่งเป็นชุด`);
    }

    const rows = (followers as Incoming[])
      .map((f) => ({
        line_user_id: typeof f.userId === "string" ? f.userId.trim() : "",
        display_name: typeof f.displayName === "string" ? f.displayName.slice(0, 150) : null,
        picture_url: typeof f.pictureUrl === "string" ? f.pictureUrl.slice(0, 500) : null,
      }))
      .filter((f) => f.line_user_id.startsWith("U"));
    if (rows.length === 0) return json({ ok: true, saved: 0 });

    // เขียนทับของเดิมเสมอ — ชื่อในไลน์กับรูปเปลี่ยนได้ตลอด ของที่เก็บไว้จึงควรเป็นของล่าสุด
    await db()`
      INSERT INTO line_followers (line_user_id, display_name, picture_url, fetched_at)
      SELECT * FROM UNNEST(
        ${rows.map((r) => r.line_user_id)}::varchar[],
        ${rows.map((r) => r.display_name)}::varchar[],
        ${rows.map((r) => r.picture_url)}::text[]
      ) AS t(line_user_id, display_name, picture_url), LATERAL (SELECT now()) AS f(fetched_at)
      ON CONFLICT (line_user_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            picture_url = EXCLUDED.picture_url,
            fetched_at = EXCLUDED.fetched_at
    `;
    return json({ ok: true, saved: rows.length });
  });

/** GET /api/admin/followers — คนที่ยังไม่ได้ผูกรหัสพนักงาน */
export const followersList = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireAdmin(s);

    const rows = await db()<
      { line_user_id: string; display_name: string | null; picture_url: string | null; fetched_at: string }[]
    >`
      SELECT f.line_user_id, f.display_name, f.picture_url,
             to_char(f.fetched_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS fetched_at
      FROM line_followers f
      WHERE NOT EXISTS (
        SELECT 1 FROM line_accounts la
        WHERE la.line_user_id = f.line_user_id AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
      )
      ORDER BY f.display_name NULLS LAST, f.line_user_id
    `;
    const [tally] = await db()<{ total: number; linked: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM line_accounts la
               WHERE la.line_user_id = f.line_user_id AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
             ))::int AS linked
      FROM line_followers f
    `;
    return json({ waiting: [...rows], total: tally?.total ?? 0, linked: tally?.linked ?? 0 });
  });

/** POST /api/admin/followers/link — ฝ่ายบุคคลผูกบัญชีไลน์นี้ให้พนักงานคนนี้ */
export const followersLink = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    requireAdmin(s);

    const { lineUserId, employeeId } = await readJson<{ lineUserId?: string; employeeId?: string }>(req);
    if (!lineUserId || !employeeId) throw new HttpError(400, "ข้อมูลไม่ครบ");

    const sql = db();
    const emp = await sql<{ id: string; full_name: string; status: string }[]>`
      SELECT id, full_name, status FROM employees WHERE id = ${employeeId} LIMIT 1
    `;
    if (emp.length === 0) throw new HttpError(404, "ไม่พบพนักงานคนนี้");
    if (emp[0].status === "suspended") {
      throw new HttpError(409, "พนักงานคนนี้ถูกระงับสิทธิ์อยู่ กรุณาคืนสิทธิ์ก่อนผูกบัญชี");
    }

    // ข้อความปฏิเสธใช้ถ้อยคำเดียวกับตอนพนักงานลงทะเบียนเอง เพราะเป็นกติกาเดียวกัน
    const takenByOther = await sql`
      SELECT 1 FROM line_accounts
      WHERE employee_id = ${employeeId} AND channel_key = ANY(${CHANNEL_KEYS_READ}) LIMIT 1
    `;
    if (takenByOther.length > 0) {
      throw new HttpError(409, "รหัสพนักงานนี้ถูกผูกกับบัญชี LINE อื่นแล้ว", "already_linked");
    }

    const name = await sql<{ display_name: string | null }[]>`
      SELECT display_name FROM line_followers WHERE line_user_id = ${lineUserId} LIMIT 1
    `;
    try {
      await sql`
        INSERT INTO line_accounts (employee_id, line_user_id, channel_key, display_name)
        VALUES (${employeeId}, ${lineUserId}, ${CHANNEL_KEY}, ${name[0]?.display_name ?? null})
      `;
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "23505") {
        throw new HttpError(409, "บัญชีไลน์นี้ถูกผูกไว้กับพนักงานคนอื่นแล้ว", "already_linked");
      }
      throw e;
    }

    console.log("[link] ฝ่ายบุคคลผูกบัญชีให้", emp[0].full_name, "โดย", s.employee.employee_code);
    invalidateSessionByLineUserId(lineUserId);
    // ผูกแล้วต้องได้เมนูใช้งานทันทีเหมือนคนที่ลงทะเบียนเอง ไม่งั้นยังเห็นปุ่มลงทะเบียนค้างอยู่
    await syncRichMenu(lineUserId);
    return json({ ok: true, name: emp[0].full_name });
  });
