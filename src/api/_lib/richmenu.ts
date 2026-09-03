// เลือก rich menu ให้ตรงกับสถานะของคนคนนั้น
//
// กติกาที่ตกลงกันไว้
//   ยังไม่ผูกรหัสพนักงาน  = เมนูที่มีปุ่มลงทะเบียน (RICHMENU_NEW_ID)
//   ผูกแล้ว ยังทำงานอยู่   = เมนูใช้งานปกติ ไม่มีปุ่มลงทะเบียน (RICHMENU_MEMBER_ID)
//   ลาออก ถูกระงับสิทธิ์ ถูกสั่งถอด = เมนูว่างเปล่า (กางออกมาแล้วไม่มีอะไร)
//
// เมนูตั้งต้นของ OA ตั้งเป็น "เมนูหลัก" ไว้ เพราะเป็นทางเดียวที่ไปถึงพนักงานที่แอดเพื่อนไว้แล้ว
// แต่ไม่เคยทักแชทและไม่เคยลงทะเบียน — ระบบไม่รู้ userId ของเขา จึงผูกเมนูรายคนให้ไม่ได้
// (ขอรายชื่อเพื่อนทั้งหมดจาก LINE ก็ไม่ได้ ต้องเป็นบัญชีที่ผ่านการยืนยันเท่านั้น)
//
// ผลที่ตามมา: **"ไม่มีเมนูผูกไว้" = "ได้เมนูตั้งต้น" = "ได้เมนูหลัก"**
// การถอดเมนูออกเฉย ๆ จึงกลายเป็นการยกเมนูหลักให้ ตรงข้ามกับเจตนา
// คนที่ไม่ควรเห็นอะไรเลยจึงต้องผูก **เมนูว่างเปล่า** ทับไว้เป็นรายคน — เมนูรายคนชนะเมนูตั้งต้นเสมอ
// (สร้างเมนูว่างได้จากปุ่มในหน้าตรวจเมนู · ดู _lib/richmenu-blank.ts)
//
// ยังไม่ได้สร้างเมนูว่าง ระบบจะถอดเมนูออกเหมือนเดิม แล้วขึ้นเตือนบนหน้าตรวจว่ายังกันได้ไม่จริง
//
// ทุกฟังก์ชันในไฟล์นี้ "ห้ามโยน error ออกไป" — การสลับเมนูเป็นงานเสริมที่เกิดหลังจาก
// งานหลักบันทึกลงฐานข้อมูลไปแล้ว ถ้าปล่อยให้ล้มตาม ผู้ใช้จะเห็นว่าลงทะเบียนไม่สำเร็จ
// ทั้งที่สำเร็จไปแล้ว แล้วกดซ้ำจนเจอข้อความว่ารหัสนี้ถูกผูกไปแล้ว

import { CHANNEL_KEYS_READ } from "./constants";
import { db } from "./db";
import { envVar } from "./env";
import { linkRichMenu, unlinkRichMenu } from "./line";

/** ตั้งค่าครบทั้งคู่หรือยัง — ยังไม่ครบก็ไม่ต้องไปแตะเมนูของใคร */
function menus(): { fresh: string; member: string } | null {
  const fresh = (envVar("RICHMENU_NEW_ID") ?? "").trim();
  const member = (envVar("RICHMENU_MEMBER_ID") ?? "").trim();
  return fresh && member ? { fresh, member } : null;
}

export interface MenuPlan {
  userId: string;
  /** link = ผูกเมนูตาม richMenuId · unlink = ถอดเมนูออกทั้งอัน */
  action: "link" | "unlink";
  richMenuId: string | null;
}

/**
 * กติกาข้อเดียวที่ตัดสินว่าใครควรได้เมนูไหน
 *
 * ทั้งการสลับทีละคนตอนมีเหตุ และการไล่ตั้งทีเดียวทั้งองค์กร ต้องใช้ฟังก์ชันนี้ร่วมกัน
 * ถ้าแยกกันเขียน วันหนึ่งจะมีสองกติกาที่ไม่ตรงกัน แล้วผลลัพธ์จะขึ้นกับว่าใครสั่งเมื่อไหร่
 *
 * status: null = ไม่มีแถวใน line_accounts เลย (ยังไม่ได้ผูกรหัสพนักงาน)
 */
function decide(
  m: { fresh: string; member: string },
  userId: string,
  status: string | null,
): MenuPlan {
  // ยังไม่ผูกรหัส = คนที่เพิ่งแอดเข้ามา ได้เมนูที่มีปุ่มลงทะเบียน
  if (status === null) return { userId, action: "link", richMenuId: m.fresh };
  if (status === "active") return { userId, action: "link", richMenuId: m.member };
  // ลาออกหรือถูกระงับ = ไม่มีเมนูเลย ไม่ใช่เมนูลงทะเบียน — ไม่ควรมีปุ่มให้กดกลับเข้าระบบ
  return { userId, action: "unlink", richMenuId: null };
}

/** สถานะพนักงานของบัญชีไลน์เหล่านี้ — ไม่มีในผลลัพธ์ = ยังไม่ได้ผูกรหัสพนักงาน */
async function statusOf(lineUserIds: string[]): Promise<Map<string, string | null>> {
  if (lineUserIds.length === 0) return new Map();
  const rows = await db()<{ line_user_id: string; status: string | null }[]>`
    SELECT la.line_user_id, e.status
    FROM line_accounts la
    LEFT JOIN employees e ON e.id = la.employee_id
    WHERE la.line_user_id = ANY(${lineUserIds}) AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
  `;
  return new Map(rows.map((r) => [r.line_user_id, r.status]));
}

/**
 * แผนการตั้งเมนูของบัญชีไลน์ชุดหนึ่ง — ใช้ตอนไล่ตั้งเมนูให้คนที่เป็นเพื่อนอยู่ก่อนแล้ว
 *
 * ไม่ยิง LINE เอง คืนคำสั่งออกไปให้ผู้เรียกยิงแทน เพราะ Worker ของ Cloudflare
 * จำกัดจำนวนคำขอย่อยต่อหนึ่งคำขอ การวนยิงเป็นร้อยครั้งในนี้จะชนเพดานก่อนจะจบงาน
 */
export async function planRichMenus(lineUserIds: string[]): Promise<MenuPlan[] | null> {
  const m = menus();
  if (!m) return null;
  const found = await statusOf(lineUserIds);
  return lineUserIds.map((id) => decide(m, id, found.has(id) ? found.get(id)! : null));
}

/** รหัสเมนูที่ตั้งไว้ตอนนี้ — ให้หน้าตรวจสอบเอาไปเทียบกับเมนูที่มีอยู่จริงบน LINE */
export function configuredMenus(): { fresh: string; member: string } | null {
  return menus();
}

/** รหัสเมนูว่างที่สร้างไว้ — เก็บที่ app_settings เพราะเป็นค่าที่ระบบสร้างเอง ไม่ใช่ค่าตั้งค่า */
const BLANK_KEY = "richmenu.blank_id";

export async function blankMenuId(): Promise<string | null> {
  try {
    const rows = await db()<{ value: string }[]>`
      SELECT value FROM app_settings WHERE key = ${BLANK_KEY}
    `;
    return rows[0]?.value?.trim() || null;
  } catch {
    return null;
  }
}

export async function rememberBlankMenu(richMenuId: string, byEmployeeId: string): Promise<void> {
  await db()`
    INSERT INTO app_settings (key, value, updated_by) VALUES (${BLANK_KEY}, ${richMenuId}, ${byEmployeeId})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `;
}

export async function forgetBlankMenu(): Promise<void> {
  try {
    await db()`DELETE FROM app_settings WHERE key = ${BLANK_KEY}`;
  } catch (e) {
    console.error("[richmenu] ลบรหัสเมนูว่างไม่สำเร็จ", e);
  }
}

/**
 * เมนูของคนที่ไม่ควรเห็นอะไรเลย
 *
 * มีเมนูว่างก็ผูกเมนูว่าง · ยังไม่มีก็ถอดเมนูออกไปก่อน ซึ่งกันได้ไม่จริงเมื่อ OA มีเมนูตั้งต้น
 * แต่ดีกว่าไม่ทำอะไรเลย และหน้าตรวจขึ้นเตือนไว้ให้ไปสร้างเมนูว่าง
 */
async function denyMenu(lineUserId: string): Promise<boolean> {
  const blank = await blankMenuId();
  return blank ? linkRichMenu(lineUserId, blank) : unlinkRichMenu(lineUserId);
}

/**
 * บัญชีไลน์ทั้งหมดที่ระบบรู้จัก เรียงคงที่ เพื่อไล่ตั้งเมนูทีละชุดได้
 *
 * รวมสองแหล่ง: คนที่ผูกรหัสพนักงานแล้ว (line_accounts) และคนที่เป็นเพื่อนแต่ยังไม่ผูก
 * (line_followers) — กลุ่มหลังคือคนที่ต้องได้เมนูที่มีปุ่มลงทะเบียน ถ้าไม่รวมมาด้วย
 * คนที่ยังไม่ลงทะเบียนจะไม่มีทางได้เมนูเลย ซึ่งคือกลุ่มที่ต้องการเมนูมากที่สุด
 */
export async function knownLineUserIds(after: string, limit: number): Promise<string[]> {
  // ยังไม่ได้สร้างตาราง = ยังไม่มีใครถูกถอด ไล่ตั้งเมนูให้ทุกคนตามปกติไปก่อน
  // ดีกว่าปล่อยให้ทั้งปุ่มพังเพราะยังไม่ได้รัน SQL
  if (!(await excludedReady())) {
    const all = await db()<{ line_user_id: string }[]>`
      SELECT line_user_id FROM (
        SELECT line_user_id FROM line_accounts WHERE channel_key = ANY(${CHANNEL_KEYS_READ})
        UNION
        SELECT line_user_id FROM line_followers
      ) AS everyone
      WHERE line_user_id > ${after}
      ORDER BY line_user_id
      LIMIT ${limit}
    `;
    return all.map((r) => r.line_user_id);
  }
  const rows = await db()<{ line_user_id: string }[]>`
    SELECT line_user_id FROM (
      SELECT line_user_id FROM line_accounts WHERE channel_key = ANY(${CHANNEL_KEYS_READ})
      UNION
      SELECT line_user_id FROM line_followers
    ) AS everyone
    WHERE line_user_id > ${after}
      -- ข้ามคนที่ผู้ดูแลสั่งถอดเมนูไว้ ไม่งั้นปุ่มถอดจะไม่มีผลอะไรเลย
      -- เพราะรอบถัดไปที่กดเปลี่ยนเมนูให้ทุกคน คนกลุ่มนี้จะได้เมนูกลับมาทันที
      AND NOT EXISTS (SELECT 1 FROM richmenu_excluded x WHERE x.line_user_id = everyone.line_user_id)
    ORDER BY line_user_id
    LIMIT ${limit}
  `;
  return rows.map((r) => r.line_user_id);
}

/**
 * ตาราง richmenu_excluded ถูกสร้างแล้วหรือยัง
 *
 * เจ้าของงานรัน SQL เองที่ Supabase ระบบจึงเจอสภาพ "โค้ดใหม่ ตารางเก่า" ได้เสมอ
 * ถ้าปล่อยให้คำสั่งที่อ้างถึงตารางนี้พังดิบ ๆ หน้าตรวจเมนูจะขึ้นข้อผิดพลาดยาวเหยียด
 * ที่อ่านไม่รู้เรื่อง แทนที่จะบอกตรง ๆ ว่า "ยังไม่ได้รันไฟล์ไหน"
 */
export async function excludedReady(): Promise<boolean> {
  try {
    const rows = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'richmenu_excluded'
    `;
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/** คนที่ถูกถอดเมนูไว้ตอนนี้ พร้อมชื่อสำหรับโชว์บนหน้าจอ */
export interface ExcludedRow {
  lineUserId: string;
  employeeId: string | null;
  name: string | null;
  code: string | null;
  at: string;
}

export async function excludedList(): Promise<ExcludedRow[]> {
  try {
    const rows = await db()<
      { line_user_id: string; employee_id: string | null; name: string | null;
        code: string | null; at: string }[]
    >`
      SELECT x.line_user_id, x.employee_id, e.full_name AS name, e.employee_code AS code,
             to_char(x.excluded_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS at
      FROM richmenu_excluded x
      LEFT JOIN employees e ON e.id = x.employee_id
      ORDER BY x.excluded_at DESC
    `;
    return rows.map((r) => ({
      lineUserId: r.line_user_id, employeeId: r.employee_id,
      name: r.name, code: r.code, at: r.at,
    }));
  } catch {
    return []; // ยังไม่ได้รันไฟล์สร้างตาราง — ไม่ใช่เรื่องที่ต้องทำให้หน้าตรวจพัง
  }
}

/** จดว่าบัญชีเหล่านี้ถูกถอดเมนูไว้ — ปุ่มเปลี่ยนให้ทุกคนจะข้ามไป */
async function rememberExcluded(
  lineUserIds: string[], employeeId: string | null, byEmployeeId: string,
): Promise<void> {
  if (lineUserIds.length === 0) return;
  try {
    for (const id of lineUserIds) {
      await db()`
        INSERT INTO richmenu_excluded (line_user_id, employee_id, excluded_by)
        VALUES (${id}, ${employeeId}, ${byEmployeeId})
        ON CONFLICT (line_user_id) DO UPDATE
          SET employee_id = EXCLUDED.employee_id, excluded_by = EXCLUDED.excluded_by,
              excluded_at = now()
      `;
    }
  } catch (e) {
    console.error("[richmenu] จดรายชื่อที่ถอดเมนูไม่สำเร็จ", e);
  }
}

/** เอาออกจากรายชื่อที่ถูกถอด — ใช้ตอนสั่งตั้งเมนูให้คนคนนั้นใหม่ */
async function forgetExcluded(lineUserIds: string[]): Promise<void> {
  if (lineUserIds.length === 0) return;
  try {
    await db()`DELETE FROM richmenu_excluded WHERE line_user_id = ANY(${lineUserIds})`;
  } catch (e) {
    console.error("[richmenu] เอาออกจากรายชื่อที่ถอดเมนูไม่สำเร็จ", e);
  }
}

/**
 * ตั้งเมนูหลักให้พนักงานคนเดียว — ปุ่ม "เปลี่ยนเฉพาะบุคคล"
 *
 * เอาชื่อออกจากรายชื่อที่ถูกถอดด้วย เพราะการสั่งตั้งเมนูให้คนคนนี้โดยตรง
 * คือการบอกว่า "ให้เขากลับมามีเมนู" ถ้าไม่เอาออก ปุ่มเปลี่ยนให้ทุกคนรอบหน้าจะข้ามเขาอีก
 * แล้วผู้ดูแลจะงงว่าทำไมคนนี้หายไปจากรอบต่อ ๆ ไปทั้งที่เพิ่งตั้งให้เอง
 */
export async function applyMenuForEmployee(
  employeeId: string,
): Promise<{ done: number; accounts: number }> {
  const m = menus();
  if (!m) return { done: 0, accounts: 0 };
  const rows = await db()<{ line_user_id: string }[]>`
    SELECT line_user_id FROM line_accounts
    WHERE employee_id = ${employeeId} AND channel_key = ANY(${CHANNEL_KEYS_READ})
  `;
  let done = 0;
  for (const r of rows) {
    try {
      if (await linkRichMenu(r.line_user_id, m.member)) done += 1;
    } catch (e) {
      console.error("[richmenu] ตั้งเมนูรายคนไม่สำเร็จ", r.line_user_id, e);
    }
  }
  if (done > 0) await forgetExcluded(rows.map((r) => r.line_user_id));
  return { done, accounts: rows.length };
}

/** จำนวนบัญชีไลน์ทั้งหมดที่ระบบรู้จัก — ใช้บอกความคืบหน้าตอนไล่ตั้งเมนู */
export async function knownLineUserCount(): Promise<number> {
  if (!(await excludedReady())) {
    const [n] = await db()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT line_user_id FROM line_accounts WHERE channel_key = ANY(${CHANNEL_KEYS_READ})
        UNION
        SELECT line_user_id FROM line_followers
      ) AS everyone
    `;
    return n?.n ?? 0;
  }
  const [row] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT line_user_id FROM line_accounts WHERE channel_key = ANY(${CHANNEL_KEYS_READ})
      UNION
      SELECT line_user_id FROM line_followers
    ) AS everyone
    WHERE NOT EXISTS (SELECT 1 FROM richmenu_excluded x WHERE x.line_user_id = everyone.line_user_id)
  `;
  return row?.n ?? 0;
}

/** เก็บรายชื่อเพื่อนที่ดึงมาจาก LINE ไว้ ไม่ทับชื่อที่ฝ่ายบุคคลเคยนำเข้าไว้ */
export async function rememberFollowers(lineUserIds: string[]): Promise<number> {
  if (lineUserIds.length === 0) return 0;
  const rows = await db()<{ line_user_id: string }[]>`
    INSERT INTO line_followers (line_user_id)
    SELECT unnest(${lineUserIds}::varchar[])
    ON CONFLICT (line_user_id) DO UPDATE SET fetched_at = now()
    RETURNING line_user_id
  `;
  return rows.length;
}

export interface ApplyOutcome {
  userId: string;
  action: "link" | "unlink";
  richMenuId: string | null;
  ok: boolean;
}

/**
 * ไล่ตั้งเมนูให้บัญชีไลน์ชุดหนึ่ง แล้ว "บอกผลกลับมาทีละคน"
 *
 * ต่างจาก syncRichMenu ตรงที่ตัวนั้นกลืน error ไว้ทั้งหมดโดยตั้งใจ (เป็นงานเสริมที่ต้องไม่
 * ทำให้การลงทะเบียนล้มตาม) ผลคือถ้าตั้งค่าผิด ระบบจะเงียบสนิทไม่มีอะไรบอกเลย
 * ตัวนี้จึงมีไว้สำหรับหน้าที่คนกดเอง คนกดต้องได้เห็นว่าสำเร็จกี่คน ไม่สำเร็จกี่คน
 */
export async function applyRichMenus(lineUserIds: string[]): Promise<ApplyOutcome[]> {
  const m = menus();
  if (!m) return [];
  const found = await statusOf(lineUserIds);
  const out: ApplyOutcome[] = [];
  for (const id of lineUserIds) {
    const plan = decide(m, id, found.has(id) ? found.get(id)! : null);
    let ok = false;
    try {
      ok = plan.action === "unlink" ? await denyMenu(id) : await linkRichMenu(id, plan.richMenuId!);
    } catch (e) {
      console.error("[richmenu] ตั้งเมนูไม่สำเร็จ", id, e);
    }
    out.push({ userId: id, action: plan.action, richMenuId: plan.richMenuId, ok });
  }
  return out;
}

/** ปรับเมนูของบัญชีไลน์นี้ให้ตรงกับความจริงล่าสุดในฐานข้อมูล */
export async function syncRichMenu(lineUserId: string): Promise<void> {
  const m = menus();
  if (!m || !lineUserId) return;
  try {
    // อ่านจากฐานข้อมูลทุกครั้ง ไม่รับสถานะที่ผู้เรียกส่งมา — ผู้เรียกแต่ละที่รู้ความจริง
    // คนละส่วนกัน (บางที่รู้แค่ว่าเพิ่งผูกบัญชี บางที่รู้แค่ว่าเพิ่งระงับสิทธิ์)
    // ถ้าให้แต่ละที่ตัดสินเอง กติกาจะกระจายไปอยู่หลายที่แล้วเพี้ยนกันได้
    const found = await statusOf([lineUserId]);
    const plan = decide(m, lineUserId, found.has(lineUserId) ? found.get(lineUserId)! : null);
    if (plan.action === "unlink") await denyMenu(lineUserId);
    else await linkRichMenu(lineUserId, plan.richMenuId!);
  } catch (e) {
    console.error("[richmenu] สลับเมนูไม่สำเร็จ", lineUserId, e);
  }
}

/** เหมือน syncRichMenu แต่เริ่มจากรหัสพนักงาน — ใช้ที่หน้าผู้ดูแลซึ่งไม่รู้ line_user_id */
export async function syncRichMenuForEmployee(employeeId: string): Promise<void> {
  if (!menus() || !employeeId) return;
  try {
    const rows = await db()<{ line_user_id: string }[]>`
      SELECT line_user_id FROM line_accounts
      WHERE employee_id = ${employeeId} AND channel_key = ANY(${CHANNEL_KEYS_READ})
    `;
    for (const r of rows) await syncRichMenu(r.line_user_id);
  } catch (e) {
    console.error("[richmenu] หาบัญชีไลน์ของพนักงานไม่สำเร็จ", employeeId, e);
  }
}

/**
 * ให้ทุกคนในชุดนี้ได้ "เมนูหลัก" เหมือนกันหมด ไม่ว่าจะลงทะเบียนแล้วหรือยัง
 *
 * ใช้ตอนสั่งเปลี่ยนเมนูให้ทุกคนพร้อมกัน ต่างจาก applyRichMenus ที่แจกตามสถานะ
 * (ซึ่งเป็นกติกาที่ใช้ตอนมีเหตุรายคน เช่น แอดเพื่อน ลงทะเบียนเสร็จ ถูกระงับสิทธิ์)
 *
 * คนที่ยังไม่ลงทะเบียนยังลงทะเบียนได้อยู่ เพราะเข้าทางแอปแจ้งปัญหาหรือแอปจองคิวได้
 * ทั้งสองแอปพาคนที่ยังไม่ผูกรหัสไปหน้าลงทะเบียนให้เอง ไม่ได้พึ่งปุ่มบนเมนูอย่างเดียว
 *
 * ยกเว้นคนที่ถูกระงับสิทธิ์ ยังถอดเมนูรายคนออกเหมือนเดิมตามที่ตกลงกันไว้
 */
export async function applyMainMenu(lineUserIds: string[]): Promise<ApplyOutcome[]> {
  const m = menus();
  if (!m) return [];
  const found = await statusOf(lineUserIds);
  const out: ApplyOutcome[] = [];
  for (const id of lineUserIds) {
    // ลาออกหรือถูกระงับ = เมนูว่างเปล่า ไม่ใช่ได้เมนูหลักไปด้วย
    const suspended = found.get(id) === "suspended";
    let ok = false;
    try {
      ok = suspended ? await denyMenu(id) : await linkRichMenu(id, m.member);
    } catch (e) {
      console.error("[richmenu] ตั้งเมนูหลักไม่สำเร็จ", id, e);
    }
    out.push({ userId: id, action: suspended ? "unlink" : "link",
      richMenuId: suspended ? null : m.member, ok });
  }
  return out;
}

/**
 * ถอดเมนูของพนักงานคนหนึ่งออก — ใช้ตอนผู้ดูแลสั่งเองเป็นรายคน
 *
 * คืนจำนวนบัญชีไลน์ที่ถอดสำเร็จ ไม่กลืน error เงียบเหมือน syncRichMenu เพราะคนกดปุ่ม
 * ต้องรู้ว่าได้ผลหรือไม่ ต่างจากการสลับเมนูอัตโนมัติที่เป็นงานเสริมท้ายงานหลัก
 */
export async function unlinkRichMenuForEmployee(
  employeeId: string,
  byEmployeeId: string,
): Promise<{ unlinked: number; remembered: boolean }> {
  const rows = await db()<{ line_user_id: string }[]>`
    SELECT line_user_id FROM line_accounts
    WHERE employee_id = ${employeeId} AND channel_key = ANY(${CHANNEL_KEYS_READ})
  `;
  // ผูกเมนูว่างทับไว้ ไม่ใช่ถอดเมนูออก — ถอดออกแล้วจะตกไปได้เมนูตั้งต้นซึ่งคือเมนูหลัก
  const gone: string[] = [];
  for (const r of rows) {
    try {
      if (await denyMenu(r.line_user_id)) gone.push(r.line_user_id);
    } catch (e) {
      console.error("[richmenu] ถอดเมนูไม่สำเร็จ", r.line_user_id, e);
    }
  }
  // จดไว้ ไม่งั้นปุ่ม "เปลี่ยนเมนูให้ทุกคน" รอบหน้าจะคืนเมนูให้คนกลุ่มนี้ทันที
  // ถ้ายังไม่ได้สร้างตาราง ต้องบอกกลับไปตามจริง ไม่ใช่ตอบว่าจดแล้วทั้งที่ไม่ได้จด
  const remembered = gone.length > 0 && (await excludedReady());
  if (remembered) await rememberExcluded(gone, employeeId, byEmployeeId);
  return { unlinked: gone.length, remembered };
}

/**
 * บัญชีไลน์นี้เพิ่งถูกปลดการผูกออกไป — ต้องกลับไปเห็นเมนูที่มีปุ่มลงทะเบียน
 *
 * แยกจาก syncRichMenu เพราะตอนที่เรียก แถวใน line_accounts ถูกลบไปแล้ว
 * การอ่านฐานข้อมูลซ้ำจึงได้คำตอบเดียวกันอยู่แล้ว แต่เขียนแยกไว้ให้ผู้อ่านโค้ดเห็นเจตนาชัด
 */
export async function richMenuAfterUnlink(lineUserId: string): Promise<void> {
  const m = menus();
  if (!m || !lineUserId) return;
  try {
    await linkRichMenu(lineUserId, m.fresh);
  } catch (e) {
    console.error("[richmenu] คืนเมนูลงทะเบียนไม่สำเร็จ", lineUserId, e);
  }
}
