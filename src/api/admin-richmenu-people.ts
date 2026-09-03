// GET /api/admin/richmenu/people — ตารางบอกว่าบัญชีไลน์ไหนผูกเมนูใบไหนอยู่
//
// มีเพราะหน้าตรวจเดิมตอบได้แค่ภาพรวม ("ตั้งค่าครบไหม · เมนูมีอยู่จริงไหม") แต่คำถามที่
// ต้องตอบบ่อยกว่าคือรายคน — "คนนี้ตอนนี้เห็นเมนูอะไรอยู่" ซึ่งเดิมต้องไปเปิดไลน์ของคนนั้นดูเอง
//
// เมนูที่ผูกอยู่จริงต้องถาม LINE ทีละคน จึงส่งมาทีละหน้า หน้าจอเป็นคนวนขอต่อเอง
// (Worker แผนฟรียิงคำขอย่อยได้ 50 ครั้งต่อหนึ่งคำขอ ถามทั้งองค์กรรวดเดียวไม่ได้)

import { getSession, requireAdmin } from "./_lib/auth";
import { CHANNEL_KEYS_READ } from "./_lib/constants";
import { db } from "./_lib/db";
import { json, methodGuard, run } from "./_lib/http";
import { listRichMenus, richMenuOf } from "./_lib/line";
import { blankMenuId, configuredMenus, excludedReady } from "./_lib/richmenu";

/** ถาม LINE ได้ไม่เกินเท่านี้ต่อหนึ่งคำขอ — เผื่อโควตาคำขอย่อยไว้ให้ส่วนอื่นด้วย */
const PAGE = 25;

interface Row {
  lineUserId: string;
  name: string | null;
  gone: boolean;
  employeeId: string | null;
  employeeName: string | null;
  code: string | null;
  status: string | null;
  excluded: boolean;
  want: string | null;
  now: string | null;
  asked: boolean;
}

interface DbRow {
  line_user_id: string;
  name: string | null;
  gone: boolean;
  employee_id: string | null;
  emp_name: string | null;
  code: string | null;
  status: string | null;
  excluded: boolean;
}

/**
 * ทุกบัญชีที่ระบบรู้จัก = คนที่ผูกรหัสพนักงานแล้ว รวมกับคนที่เคยทักแชทหรือแอดเพื่อนเข้ามา
 *
 * ต้องใช้ LATERAL ตรง line_accounts เพราะคนหนึ่งมีแถวได้หลาย channel การ JOIN ตรง ๆ
 * จะทำให้คนคนเดียวโผล่มาสองแถวในตาราง
 */
async function page(after: string, limit: number, hasExcluded: boolean): Promise<DbRow[]> {
  const sql = db();
  const excluded = hasExcluded
    ? sql`EXISTS (SELECT 1 FROM richmenu_excluded x WHERE x.line_user_id = p.line_user_id)`
    : sql`false`;
  return await sql<DbRow[]>`
    SELECT p.line_user_id,
           COALESCE(NULLIF(f.display_name, ''), NULLIF(la.display_name, '')) AS name,
           COALESCE(f.display_name = '', false) AS gone,
           la.employee_id, e.full_name AS emp_name, e.employee_code AS code, e.status,
           ${excluded} AS excluded
    FROM (
      SELECT line_user_id FROM line_accounts WHERE channel_key = ANY(${CHANNEL_KEYS_READ})
      UNION
      SELECT line_user_id FROM line_followers
    ) AS p
    LEFT JOIN line_followers f ON f.line_user_id = p.line_user_id
    LEFT JOIN LATERAL (
      SELECT employee_id, display_name FROM line_accounts
      WHERE line_user_id = p.line_user_id AND channel_key = ANY(${CHANNEL_KEYS_READ})
      ORDER BY linked_at DESC LIMIT 1
    ) AS la ON true
    LEFT JOIN employees e ON e.id = la.employee_id
    WHERE p.line_user_id > ${after}
    ORDER BY p.line_user_id
    LIMIT ${limit}
  `;
}

export const richMenuPeople = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireAdmin(s);

    const url = new URL(req.url);
    const after = url.searchParams.get("after") ?? "";
    // ถาม LINE ว่าตอนนี้ผูกใบไหนอยู่ — ปิดได้ เพื่อโหลดรายชื่อล้วน ๆ ให้ขึ้นหน้าจอเร็ว ๆ ก่อน
    const askLine = url.searchParams.get("menus") !== "0";

    const ready = await excludedReady();
    const rows = await page(after, PAGE, ready);

    const set = configuredMenus();
    const blank = await blankMenuId();

    // ใบที่ "ควรได้" ต้องตรงกับกติกาที่ปุ่มข้อ 1 ใช้จริง ไม่งั้นตารางจะฟ้องว่าไม่ตรงทั้งที่ถูกแล้ว
    //   ถูกถอด · ลาออก · ถูกระงับ  → เมนูว่าง (ถ้ายังไม่ได้สร้าง ก็คือไม่มีเมนูเลย)
    //   ยังไม่ผูกรหัสพนักงาน        → เมนูที่มีปุ่มลงทะเบียน
    //   ใช้งานอยู่                  → เมนูหลัก
    const wantOf = (r: DbRow): string | null => {
      if (!set) return null;
      if (r.excluded) return blank;
      if (r.employee_id === null) return set.fresh;
      return r.status === "active" ? set.member : blank;
    };

    const listed = await listRichMenus();
    const onLine = listed.ok ? listed.data : [];

    const out: Row[] = [];
    let lineError: string | null = listed.ok ? null : listed.error;

    for (const r of rows) {
      let now: string | null = null;
      let asked = false;
      if (askLine && lineError === null) {
        const cur = await richMenuOf(r.line_user_id);
        if (cur.ok) {
          now = cur.data;
          asked = true;
        } else {
          // ถาม LINE ไม่ได้เลย — หยุดถามที่เหลือ ไม่ต้องไล่ยิงให้พังเหมือนกันทั้งหน้า
          lineError = cur.error;
        }
      }
      out.push({
        lineUserId: r.line_user_id,
        name: r.name,
        gone: r.gone,
        employeeId: r.employee_id,
        employeeName: r.emp_name,
        code: r.code,
        status: r.status,
        excluded: r.excluded,
        want: wantOf(r),
        now,
        asked,
      });
    }

    const [tally] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT line_user_id FROM line_accounts WHERE channel_key = ANY(${CHANNEL_KEYS_READ})
        UNION
        SELECT line_user_id FROM line_followers
      ) AS everyone
    `;

    return json({
      ok: true,
      rows: out,
      // ยังไม่ถึงแถวสุดท้าย = ส่งรหัสตัวสุดท้ายกลับไปให้ขอหน้าถัดไป
      next: rows.length === PAGE ? rows[rows.length - 1].line_user_id : null,
      total: tally?.n ?? 0,
      // ชื่อเมนูสำหรับโชว์ — ตารางเก็บแต่รหัส คนอ่านต้องเห็นชื่อ
      menuNames: Object.fromEntries(onLine.map((m) => [m.richMenuId, m.name])),
      configured: set,
      blankMenuId: blank,
      lineError,
    });
  });

export default richMenuPeople;
