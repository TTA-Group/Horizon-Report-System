// GET /api/admin/richmenu   ตรวจว่าทำไมเมนูไม่เปลี่ยน
// POST /api/admin/richmenu  ไล่ตั้งเมนูใหม่ให้ทุกคนทีละชุด
//
// มีเพราะการสลับ rich menu ล้มแบบเงียบสนิทได้สามทาง และทั้งสามทางหน้าจอเหมือนกันหมด
// คือ "เมนูไม่เปลี่ยน" โดยไม่มีข้อความผิดพลาดโผล่ที่ไหนเลย
//   1. ยังไม่ได้ตั้งรหัสเมนู       — โค้ดข้ามไปเงียบ ๆ ไม่แม้แต่ลง log
//   2. ยังไม่ได้ตั้งโทเคนของ LINE  — โยน error แล้วถูกกลืนไว้ใน log ที่ไม่มีใครเปิดดู
//   3. รหัสเมนูที่ตั้งไว้ไม่มีอยู่จริง — LINE ตอบ 404 แล้วผลลัพธ์ถูกทิ้ง ไม่มีใครตรวจค่าที่คืนมา
//
// หน้านี้จึงถาม LINE จริงว่ามีเมนูอะไรอยู่บ้าง แล้วเทียบกับที่ตั้งค่าไว้ ให้เห็นด้วยตาว่าตรงไหม
// และการไล่ตั้งเมนูก็บอกกลับว่าสำเร็จกี่คน ไม่สำเร็จกี่คน แทนที่จะเงียบเหมือนเดิม

import { getSession, requireAdmin } from "./_lib/auth";
import { db } from "./_lib/db";
import { envVar } from "./_lib/env";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { defaultRichMenuId, listRichMenus, richMenuOf, setDefaultRichMenu } from "./_lib/line";
import { applyRichMenus, configuredMenus, knownLineUserCount, knownLineUserIds, linkSameMenuTo, planRichMenus } from "./_lib/richmenu";

/**
 * ตั้งได้ครั้งละไม่เกินเท่านี้ต่อหนึ่งคำขอ
 *
 * Worker ของ Cloudflare ยิงคำขอย่อยได้จำกัดต่อหนึ่งคำขอ (แผนฟรี 50 ครั้ง) และการตั้งเมนู
 * ใช้หนึ่งครั้งต่อคน เผื่อไว้ให้เหลือสำหรับคำขอฐานข้อมูลด้วย หน้าจอเป็นคนวนเรียกซ้ำเอง
 */
const BATCH = 25;

/**
 * บันทึกว่าไล่ตั้งเมนูครั้งล่าสุดเมื่อไหร่ โดยใคร
 *
 * มีเพราะคำถามแรกเวลาเมนูไม่เปลี่ยนคือ "กดปุ่มไปหรือยัง" ซึ่งเดิมตอบไม่ได้เลย
 * ต้องไปไล่ log ของ Worker ซึ่งไม่มีใครเปิดดู เก็บไว้ที่ app_settings ซึ่งเป็นตารางของกลาง
 * ที่มีอยู่แล้ว ไม่ต้องเพิ่มตารางใหม่ให้ต้องรัน SQL อีกไฟล์
 *
 * ห้ามทำให้การตั้งเมนูล้มตาม — บันทึกไม่ได้ก็แค่ไม่รู้เวลา ไม่ใช่เรื่องที่ต้องหยุดงานหลัก
 */
const APPLY_KEY = "richmenu.last_apply";

async function noteApplied(employeeId: string, code: string): Promise<void> {
  try {
    await db()`
      INSERT INTO app_settings (key, value, updated_by) VALUES (${APPLY_KEY}, ${code}, ${employeeId})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `;
  } catch (e) {
    console.error("[richmenu] บันทึกเวลาไล่ตั้งเมนูไม่สำเร็จ", e);
  }
}

async function lastApplied(): Promise<{ at: string; by: string } | null> {
  try {
    const rows = await db()<{ at: string; by: string }[]>`
      SELECT to_char(updated_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM/YYYY HH24:MI') AS at, value AS by
      FROM app_settings WHERE key = ${APPLY_KEY}
    `;
    return rows[0] ?? null;
  } catch {
    return null; // ยังไม่ได้รันไฟล์ที่สร้างตารางนี้ — ไม่ใช่เรื่องที่ต้องทำให้หน้าตรวจพัง
  }
}

export const richMenuStatus = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireAdmin(s);

    const config = {
      RICHMENU_NEW_ID: envVar("RICHMENU_NEW_ID") !== undefined,
      RICHMENU_MEMBER_ID: envVar("RICHMENU_MEMBER_ID") !== undefined,
      LINE_CHANNEL_ACCESS_TOKEN: envVar("LINE_CHANNEL_ACCESS_TOKEN") !== undefined,
    };
    const set = configuredMenus();

    const listed = await listRichMenus();
    const def = await defaultRichMenuId();
    const onLine = listed.ok ? listed.data : [];
    const nameOf = (id: string | null) =>
      id ? (onLine.find((m) => m.richMenuId === id)?.name ?? null) : null;

    // เมนูที่ตั้งไว้ต้องมีอยู่จริงบน LINE — รหัสที่ก๊อปมาผิดตัวหรือเมนูที่ถูกลบไปแล้วคือ
    // สาเหตุที่ระบบสั่งได้แต่ LINE ปฏิเสธ แล้วผลลัพธ์ถูกทิ้งไปเงียบ ๆ
    const menus = set
      ? {
          fresh: { id: set.fresh, name: nameOf(set.fresh), exists: onLine.some((m) => m.richMenuId === set.fresh) },
          member: { id: set.member, name: nameOf(set.member), exists: onLine.some((m) => m.richMenuId === set.member) },
        }
      : null;

    // ขอดูเมนูของตัวเองด้วย เป็นคำตอบสุดท้ายว่าตอนนี้ LINE ผูกเมนูใบไหนไว้ให้จริง ๆ
    //
    // แล้วเทียบกับ "ใบที่ควรได้" ตามกติกาเดียวกับที่ระบบใช้จริง — บอกแค่ว่าตอนนี้ได้ใบไหน
    // ยังไม่พอ เพราะคนอ่านต้องจำเองว่าใบนั้นถูกหรือผิด ซึ่งเป็นจุดที่หลงได้ง่ายที่สุด
    const mineNow = s.lineUserId ? await richMenuOf(s.lineUserId) : null;
    const plans = s.lineUserId ? await planRichMenus([s.lineUserId]) : null;
    const want = plans && plans.length > 0 ? plans[0].richMenuId : undefined;
    const mine =
      mineNow === null
        ? null
        : mineNow.ok
          ? {
              ok: true as const,
              id: mineNow.data,
              name: nameOf(mineNow.data),
              // undefined = ยังตั้งค่าไม่ครบจนบอกไม่ได้ว่าควรได้ใบไหน จึงไม่ตัดสินว่าตรงหรือไม่ตรง
              expectedId: want,
              expectedName: want === undefined ? null : want === null ? null : nameOf(want),
              matches: want === undefined ? null : mineNow.data === want,
            }
          : mineNow;

    return json({
      ok: true,
      config,
      ready: config.RICHMENU_NEW_ID && config.RICHMENU_MEMBER_ID && config.LINE_CHANNEL_ACCESS_TOKEN,
      menus,
      line: listed.ok
        ? { ok: true, count: onLine.length, richmenus: onLine.map((m) => ({ id: m.richMenuId, name: m.name })) }
        : { ok: false, error: listed.error },
      // ระบบนี้ตั้งใจไม่ตั้งเมนูตั้งต้น — ถ้ามี คนที่ลาออกแล้วจะตกกลับไปเห็นเมนูที่มีปุ่มลงทะเบียน
      defaultMenu: def.ok ? { ok: true, id: def.data, name: nameOf(def.data) } : { ok: false, error: def.error },
      people: await knownLineUserCount(),
      lastApply: await lastApplied(),
      mine,
    });
  });

export const richMenuApply = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    requireAdmin(s);

    if (!configuredMenus()) {
      throw new HttpError(409, "ยังไม่ได้ตั้งรหัสเมนูทั้งสองใบ (RICHMENU_NEW_ID และ RICHMENU_MEMBER_ID)", "not_configured");
    }
    if (envVar("LINE_CHANNEL_ACCESS_TOKEN") === undefined) {
      throw new HttpError(409, "ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ที่ระบบนี้", "no_token");
    }

    const body = await readJson<{ after?: string; richMenuId?: string }>(req);
    const after = typeof body.after === "string" ? body.after : "";

    // โหมด "ใบเดียวให้ทุกคน" — ส่งรหัสเมนูมาด้วยแปลว่าให้ใช้ใบนั้นกับทุกคน ไม่สนสถานะ
    const same = typeof body.richMenuId === "string" ? body.richMenuId.trim() : "";
    if (same) return applyOneToAll(req, same, after, s.employee!.id, s.employee!.employee_code);

    const ids = await knownLineUserIds(after, BATCH);
    if (ids.length === 0) return json({ ok: true, done: true, next: null, processed: 0, linked: 0, unlinked: 0, failed: 0 });

    const out = await applyRichMenus(ids);
    const failed = out.filter((o) => !o.ok);
    await noteApplied(s.employee!.id, s.employee!.employee_code);
    console.log("[richmenu] ไล่ตั้งเมนู", out.length, "คน ไม่สำเร็จ", failed.length, "โดย", s.employee?.employee_code);

    return json({
      ok: true,
      done: ids.length < BATCH,
      next: ids[ids.length - 1],
      processed: out.length,
      linked: out.filter((o) => o.ok && o.action === "link").length,
      unlinked: out.filter((o) => o.ok && o.action === "unlink").length,
      failed: failed.length,
    });
  });

/**
 * ตั้งเมนู "ใบเดียวกัน" ให้ทุกคน
 *
 * ทำสองอย่างคู่กัน เพราะอย่างเดียวไม่พอสักอย่าง
 *   ตั้งเป็นเมนูตั้งต้นของ OA  ไปถึงคนที่ระบบไม่รู้จัก ซึ่งขอรายชื่อจาก LINE ไม่ได้
 *                             (ต้องเป็นบัญชีที่ผ่านการยืนยันแล้วเท่านั้น)
 *   ไล่ผูกเป็นรายคน            เพราะเมนูที่ผูกไว้เป็นรายคนชนะเมนูตั้งต้นเสมอ
 *                             คนที่เคยถูกระบบอื่นผูกใบเก่าไว้จึงไม่เปลี่ยนตามเมนูตั้งต้น
 *
 * ตั้งเมนูตั้งต้นเฉพาะชุดแรก ไม่ต้องยิงซ้ำทุกชุด
 */
async function applyOneToAll(
  _req: Request,
  richMenuId: string,
  after: string,
  employeeId: string,
  code: string,
): Promise<Response> {
  // รหัสที่ไม่มีอยู่จริงคือสาเหตุที่ LINE ปฏิเสธเงียบ ๆ — ตรวจก่อนยิง ไม่ปล่อยให้ล้มทีละคน
  if (after === "") {
    const listed = await listRichMenus();
    if (!listed.ok) throw new HttpError(502, `ถาม LINE ไม่ได้ · ${listed.error}`, "line_down");
    if (!listed.data.some((m) => m.richMenuId === richMenuId)) {
      throw new HttpError(400, "ไม่พบเมนูรหัสนี้บน LINE", "menu_not_found");
    }
  }

  const asDefault = after === "" ? await setDefaultRichMenu(richMenuId) : null;
  const ids = await knownLineUserIds(after, BATCH);
  const out = ids.length > 0 ? await linkSameMenuTo(ids, richMenuId) : [];
  const failed = out.filter((o) => !o.ok);
  await noteApplied(employeeId, code);
  console.log("[richmenu] ตั้งใบเดียวให้ทุกคน", richMenuId, out.length, "คน ไม่สำเร็จ", failed.length, "โดย", code);

  return json({
    ok: true,
    mode: "all",
    done: ids.length < BATCH,
    next: ids.length > 0 ? ids[ids.length - 1] : null,
    processed: out.length,
    linked: out.length - failed.length,
    unlinked: 0,
    failed: failed.length,
    // null = ชุดถัดไป ไม่ได้ตั้งซ้ำ
    defaultSet: asDefault,
  });
}
