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

/** ปรับเมนูของบัญชีไลน์นี้ให้ตรงกับความจริงล่าสุดในฐานข้อมูล */
export async function syncRichMenu(lineUserId: string): Promise<void> {
  const m = menus();
  if (!m || !lineUserId) return;
  try {
    // อ่านจากฐานข้อมูลทุกครั้ง ไม่รับสถานะที่ผู้เรียกส่งมา — ผู้เรียกแต่ละที่รู้ความจริง
    // คนละส่วนกัน (บางที่รู้แค่ว่าเพิ่งผูกบัญชี บางที่รู้แค่ว่าเพิ่งระงับสิทธิ์)
    // ถ้าให้แต่ละที่ตัดสินเอง กติกาจะกระจายไปอยู่หลายที่แล้วเพี้ยนกันได้
    const rows = await db()<{ status: string | null }[]>`
      SELECT e.status
      FROM line_accounts la
      LEFT JOIN employees e ON e.id = la.employee_id
      WHERE la.line_user_id = ${lineUserId} AND la.channel_key = ANY(${CHANNEL_KEYS_READ})
      LIMIT 1
    `;
    if (rows.length === 0) await linkRichMenu(lineUserId, m.fresh);
    else if (rows[0].status === "active") await linkRichMenu(lineUserId, m.member);
    else await unlinkRichMenu(lineUserId);
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
