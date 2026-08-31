// เลือก rich menu ให้ตรงกับสถานะของคนคนนั้น
//
// กติกาที่ตกลงกันไว้
//   ยังไม่ผูกรหัสพนักงาน  = เมนูที่มีปุ่มลงทะเบียน (RICHMENU_NEW_ID)
//   ผูกแล้ว ยังทำงานอยู่   = เมนูใช้งานปกติ ไม่มีปุ่มลงทะเบียน (RICHMENU_MEMBER_ID)
//   ลาออกหรือถูกระงับสิทธิ์ = ไม่มีเมนูเลย
//
// **ห้ามตั้ง default rich menu ที่ LINE** ไม่งั้นคนที่ถูกถอดเมนูจะตกกลับไปเห็นเมนูตั้งต้นทันที
// ซึ่งเป็นเมนูที่มีปุ่มลงทะเบียน = คนที่ลาออกไปแล้วจะกดลงทะเบียนใหม่ได้
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
  if (status === null) return { userId, action: "link", richMenuId: m.fresh };
  if (status === "active") return { userId, action: "link", richMenuId: m.member };
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

/**
 * บัญชีไลน์ทั้งหมดที่ระบบรู้จัก เรียงคงที่ เพื่อไล่ตั้งเมนูทีละชุดได้
 *
 * รวมสองแหล่ง: คนที่ผูกรหัสพนักงานแล้ว (line_accounts) และคนที่เป็นเพื่อนแต่ยังไม่ผูก
 * (line_followers) — กลุ่มหลังคือคนที่ต้องได้เมนูที่มีปุ่มลงทะเบียน ถ้าไม่รวมมาด้วย
 * คนที่ยังไม่ลงทะเบียนจะไม่มีทางได้เมนูเลย ซึ่งคือกลุ่มที่ต้องการเมนูมากที่สุด
 */
export async function knownLineUserIds(after: string, limit: number): Promise<string[]> {
  const rows = await db()<{ line_user_id: string }[]>`
    SELECT line_user_id FROM (
      SELECT line_user_id FROM line_accounts WHERE channel_key = ANY(${CHANNEL_KEYS_READ})
      UNION
      SELECT line_user_id FROM line_followers
    ) AS everyone
    WHERE line_user_id > ${after}
    ORDER BY line_user_id
    LIMIT ${limit}
  `;
  return rows.map((r) => r.line_user_id);
}

/** จำนวนบัญชีไลน์ทั้งหมดที่ระบบรู้จัก — ใช้บอกความคืบหน้าตอนไล่ตั้งเมนู */
export async function knownLineUserCount(): Promise<number> {
  const [row] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT line_user_id FROM line_accounts WHERE channel_key = ANY(${CHANNEL_KEYS_READ})
      UNION
      SELECT line_user_id FROM line_followers
    ) AS everyone
  `;
  return row?.n ?? 0;
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
      ok = plan.action === "unlink" ? await unlinkRichMenu(id) : await linkRichMenu(id, plan.richMenuId!);
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
    if (plan.action === "unlink") await unlinkRichMenu(lineUserId);
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
 * ถอดเมนูของพนักงานคนหนึ่งออก — ใช้ตอนผู้ดูแลสั่งเองเป็นรายคน
 *
 * คืนจำนวนบัญชีไลน์ที่ถอดสำเร็จ ไม่กลืน error เงียบเหมือน syncRichMenu เพราะคนกดปุ่ม
 * ต้องรู้ว่าได้ผลหรือไม่ ต่างจากการสลับเมนูอัตโนมัติที่เป็นงานเสริมท้ายงานหลัก
 */
export async function unlinkRichMenuForEmployee(employeeId: string): Promise<number> {
  const rows = await db()<{ line_user_id: string }[]>`
    SELECT line_user_id FROM line_accounts
    WHERE employee_id = ${employeeId} AND channel_key = ANY(${CHANNEL_KEYS_READ})
  `;
  let done = 0;
  for (const r of rows) {
    try {
      if (await unlinkRichMenu(r.line_user_id)) done += 1;
    } catch (e) {
      console.error("[richmenu] ถอดเมนูไม่สำเร็จ", r.line_user_id, e);
    }
  }
  return done;
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
