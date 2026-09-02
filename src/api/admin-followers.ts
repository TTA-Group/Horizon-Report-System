// รายชื่อคนที่เป็นเพื่อนกับ LINE OA และการผูกบัญชีให้พนักงานแทนเจ้าตัว
//
//   POST /api/admin/followers        รับรายชื่อที่ดึงมาจาก LINE เข้ามาเก็บ (เครื่องต่อเครื่อง)
//   GET  /api/admin/followers        คนที่เป็นเพื่อนแต่ยังไม่ได้ผูกรหัสพนักงาน (ฝ่ายบุคคล)
//   POST /api/admin/followers/names  เติมชื่อไลน์ให้แถวที่ยังไม่มีชื่อ (ฝ่ายบุคคล)
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
import { HttpError, describeBody, json, listFrom, methodGuard, readJson, run } from "./_lib/http";
import { lineProfile } from "./_lib/line";
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

    // อ่าน body เป็นข้อความก่อน เพื่อเอาไปบอกกลับได้ว่าได้อะไรมาเมื่อรูปแบบไม่ถูก
    const rawBody = await req.text();
    let parsed: unknown = null;
    try {
      parsed = rawBody.trim() ? JSON.parse(rawBody) : null;
    } catch {
      parsed = rawBody;
    }
    const followers = listFrom(parsed, "followers");
    if (followers === null) {
      throw new HttpError(400, `ส่ง followers มาเป็นรายการ หรือส่งรายการมาตรง ๆ ก็ได้ · ${describeBody(rawBody)}`);
    }
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

    // ชื่อว่างเปล่า (ไม่ใช่ NULL) = เคยถามแล้วแต่ LINE บอกว่าไม่ใช่เพื่อนกันแล้ว
    // แยกออกจาก NULL ที่แปลว่า "ยังไม่เคยถาม" เพราะสิ่งที่ฝ่ายบุคคลต้องทำต่อไม่เหมือนกัน
    // และดันสองกลุ่มนี้ลงท้ายรายการ คนที่มีชื่อจับคู่ได้จริงต้องอยู่บนสุด
    const rows = await db()<
      {
        line_user_id: string; display_name: string | null;
        picture_url: string | null; fetched_at: string; gone: boolean;
      }[]
    >`
      SELECT f.line_user_id, NULLIF(f.display_name, '') AS display_name, f.picture_url,
             to_char(f.fetched_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS fetched_at,
             COALESCE(f.display_name = '', false) AS gone
      FROM line_followers f
      WHERE NOT EXISTS (
        SELECT 1 FROM line_accounts la
        WHERE la.line_user_id = f.line_user_id AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
      )
      ORDER BY CASE WHEN f.display_name = '' THEN 2 WHEN f.display_name IS NULL THEN 1 ELSE 0 END,
               f.display_name, f.line_user_id
    `;
    const [tally] = await db()<{ total: number; linked: number; nameless: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM line_accounts la
               WHERE la.line_user_id = f.line_user_id AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
             ))::int AS linked,
             count(*) FILTER (WHERE f.display_name IS NULL)::int AS nameless
      FROM line_followers f
    `;
    return json({
      waiting: [...rows],
      total: tally?.total ?? 0,
      linked: tally?.linked ?? 0,
      nameless: tally?.nameless ?? 0,
    });
  });

/**
 * POST /api/admin/followers/names — เติมชื่อไลน์ให้แถวที่ยังไม่มีชื่อ
 *
 * แถวที่ไม่มีชื่อคือคนที่ระบบรู้จักจากการที่เขาทักเข้ามา (webhook เก็บไว้แค่ userId)
 * ไม่ใช่คนที่ถูกนำเข้าพร้อมชื่อ หน้าผูกบัญชีจึงขึ้นว่า "ไม่มีชื่อในไลน์" ซึ่งจับคู่กับใครไม่ได้
 *
 * ทำทีละชุด ไม่ใช่ทีเดียวทั้งหมด เพราะ Worker แผนฟรียิงคำขอย่อยได้ 50 ครั้งต่อหนึ่งคำขอ
 * และหนึ่งโปรไฟล์คือหนึ่งคำขอ หน้าจอเป็นคนกดซ้ำจนกว่าจะหมด เหมือนปุ่มเปลี่ยน rich menu
 *
 * คนที่บล็อก OA ไปแล้ว LINE ตอบ 404 — จดไว้ด้วยค่าว่างเปล่า (ไม่ใช่ NULL) เพื่อไม่ให้
 * ชุดถัดไปวนกลับมาถามคนเดิมซ้ำไปเรื่อย ๆ จนไม่มีวันจบ
 */
const NAME_BATCH = 25;

export const followersFillNames = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    requireAdmin(s);

    const sql = db();
    const todo = await sql<{ line_user_id: string }[]>`
      SELECT line_user_id FROM line_followers
      WHERE display_name IS NULL
      ORDER BY fetched_at DESC
      LIMIT ${NAME_BATCH}
    `;
    if (todo.length === 0) {
      return json({ ok: true, filled: 0, gone: 0, remaining: 0 });
    }

    let filled = 0;
    let gone = 0;
    let failure: string | null = null;

    for (const row of todo) {
      const p = await lineProfile(row.line_user_id);
      if (!p.ok) {
        // ถาม LINE ไม่ได้เลย — หยุดทั้งชุด ไม่ต้องไล่ยิงที่เหลือให้พังเหมือนกันหมด
        failure = p.error;
        break;
      }
      if (p.data) {
        await sql`
          UPDATE line_followers
             SET display_name = ${p.data.displayName.slice(0, 150)},
                 picture_url  = ${p.data.pictureUrl ? p.data.pictureUrl.slice(0, 500) : null}
           WHERE line_user_id = ${row.line_user_id}
        `;
        filled++;
      } else {
        await sql`
          UPDATE line_followers SET display_name = '' WHERE line_user_id = ${row.line_user_id}
        `;
        gone++;
      }
    }

    const [left] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM line_followers WHERE display_name IS NULL
    `;
    console.log("[followers] เติมชื่อ", filled, "คน · หลุดไปแล้ว", gone, "คน · เหลือ", left?.n ?? 0);
    return json({
      ok: failure === null,
      filled,
      gone,
      remaining: left?.n ?? 0,
      ...(failure ? { error: failure } : {}),
    });
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
      SELECT NULLIF(display_name, '') AS display_name FROM line_followers
      WHERE line_user_id = ${lineUserId} LIMIT 1
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

/**
 * POST /api/admin/followers/import — วางข้อมูลทีละหลายคนแล้วผูกให้ในคราวเดียว
 *
 * มีเพราะข้อมูลที่ฝ่ายบุคคลรวบรวมมาเองอยู่ในไฟล์ตาราง ไม่ได้อยู่ในระบบ ก่อนหน้านี้
 * ต้องเอาไปแปะเป็นคำสั่ง SQL รันที่ฐานข้อมูลทุกครั้ง ซึ่งเป็นงานที่คนไม่ได้เขียนโปรแกรม
 * ไม่ควรต้องทำ และพลาดครั้งเดียวก็แก้ยาก
 *
 * ทำงานสองจังหวะ: apply=false คือตรวจอย่างเดียว ยังไม่เขียนอะไรลงฐานข้อมูล
 * ให้คนดูก่อนว่าชื่อในไลน์กับชื่อในทะเบียนเป็นคนเดียวกันจริงไหม แล้วค่อยยืนยัน
 * ด่านนี้สำคัญที่สุด เพราะจับคู่ผิดแปลว่าคนหนึ่งได้คิวนวดและเรื่องแจ้งของอีกคน
 */
const MAX_IMPORT = 30;

interface ImportRow {
  code?: unknown;
  userId?: unknown;
  lineName?: unknown;
}

export const followersImport = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    requireAdmin(s);

    const body = await readJson<{ rows?: unknown; apply?: boolean }>(req);
    const raw = Array.isArray(body.rows) ? (body.rows as ImportRow[]) : null;
    if (raw === null) throw new HttpError(400, "ไม่มีข้อมูลส่งมา");
    if (raw.length > MAX_IMPORT) {
      // เพดานนี้มาจากจำนวนคำขอย่อยที่ Worker ยิงออกได้ต่อหนึ่งคำขอ (สลับเมนูคนละหนึ่งครั้ง)
      throw new HttpError(400, `วางได้ครั้งละไม่เกิน ${MAX_IMPORT} คน กรุณาแบ่งวางเป็นชุด`);
    }

    const rows = raw.map((r) => ({
      code: String(r.code ?? "").trim(),
      userId: String(r.userId ?? "").trim(),
      lineName: String(r.lineName ?? "").trim() || null,
    }));

    const sql = db();
    const codes = rows.map((r) => r.code);
    const uids = rows.map((r) => r.userId);

    const emps = await sql<{ id: string; employee_code: string; full_name: string; status: string }[]>`
      SELECT id, employee_code, full_name, status FROM employees WHERE employee_code = ANY(${codes})
    `;
    const byCode = new Map(emps.map((e) => [e.employee_code, e]));

    const taken = await sql<{ employee_id: string; line_user_id: string }[]>`
      SELECT employee_id, line_user_id FROM line_accounts
      WHERE channel_key = ANY(${CHANNEL_KEYS_READ})
        AND (employee_id = ANY(${emps.map((e) => e.id)}::uuid[]) OR line_user_id = ANY(${uids}))
    `;
    const empTaken = new Set(taken.map((t) => t.employee_id));
    const lineTaken = new Set(taken.map((t) => t.line_user_id));

    // ซ้ำกันเองในรายการที่วางมา — เจอบ่อยเวลาก๊อปจากตารางแล้วมีบรรทัดซ้ำ
    const seenCode = new Map<string, number>();
    const seenUid = new Map<string, number>();
    rows.forEach((r, i) => {
      if (!seenCode.has(r.code)) seenCode.set(r.code, i);
      if (!seenUid.has(r.userId)) seenUid.set(r.userId, i);
    });

    const decided = rows.map((r, i) => {
      const e = byCode.get(r.code);
      const status = !r.code || !r.userId
        ? "bad_row"
        : !r.userId.startsWith("U")
          ? "bad_user_id"
          : seenCode.get(r.code) !== i || seenUid.get(r.userId) !== i
            ? "duplicate"
            : !e
              ? "not_found"
              : e.status !== "active"
                ? "suspended"
                : empTaken.has(e.id)
                  ? "emp_taken"
                  : lineTaken.has(r.userId)
                    ? "line_taken"
                    : "ready";
      return { ...r, employeeName: e?.full_name ?? null, status };
    });

    if (body.apply !== true) {
      return json({ ok: true, applied: false, rows: decided });
    }

    const ready = decided.filter((r) => r.status === "ready");
    for (const r of ready) {
      const e = byCode.get(r.code)!;
      await sql`
        INSERT INTO line_followers (line_user_id, display_name)
        VALUES (${r.userId}, ${r.lineName})
        ON CONFLICT (line_user_id) DO UPDATE
          SET display_name = EXCLUDED.display_name, fetched_at = now()
      `;
      await sql`
        INSERT INTO line_accounts (employee_id, line_user_id, channel_key, display_name)
        VALUES (${e.id}, ${r.userId}, ${CHANNEL_KEY}, ${r.lineName})
        ON CONFLICT DO NOTHING
      `;
      invalidateSessionByLineUserId(r.userId);
      // ผูกแล้วต้องได้เมนูใช้งานทันที เหมือนคนที่ลงทะเบียนเอง
      await syncRichMenu(r.userId);
    }

    console.log("[link] นำเข้าเป็นชุด", ready.length, "คน โดย", s.employee.employee_code);
    return json({
      ok: true,
      applied: true,
      linked: ready.length,
      rows: decided.map((r) => (r.status === "ready" ? { ...r, status: "done" } : r)),
    });
  });
