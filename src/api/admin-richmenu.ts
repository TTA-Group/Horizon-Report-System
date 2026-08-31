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
import { envVar } from "./_lib/env";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { defaultRichMenuId, listRichMenus, richMenuOf } from "./_lib/line";
import { applyRichMenus, configuredMenus, knownLineUserCount, knownLineUserIds } from "./_lib/richmenu";

/**
 * ตั้งได้ครั้งละไม่เกินเท่านี้ต่อหนึ่งคำขอ
 *
 * Worker ของ Cloudflare ยิงคำขอย่อยได้จำกัดต่อหนึ่งคำขอ (แผนฟรี 50 ครั้ง) และการตั้งเมนู
 * ใช้หนึ่งครั้งต่อคน เผื่อไว้ให้เหลือสำหรับคำขอฐานข้อมูลด้วย หน้าจอเป็นคนวนเรียกซ้ำเอง
 */
const BATCH = 25;

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
    const mine = s.lineUserId ? await richMenuOf(s.lineUserId) : null;

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
      mine: mine === null ? null : mine.ok ? { ok: true, id: mine.data, name: nameOf(mine.data) } : { ok: false, error: mine.error },
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

    const body = await readJson<{ after?: string }>(req);
    const after = typeof body.after === "string" ? body.after : "";

    const ids = await knownLineUserIds(after, BATCH);
    if (ids.length === 0) return json({ ok: true, done: true, next: null, processed: 0, linked: 0, unlinked: 0, failed: 0 });

    const out = await applyRichMenus(ids);
    const failed = out.filter((o) => !o.ok);
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
