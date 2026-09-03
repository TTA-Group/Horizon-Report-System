// POST /api/auth/link — ยืนยันและผูกบัญชี LINE (spec หัวข้อ 5.1 / 6)
//
// ผูกได้เฉพาะรหัสที่ฝ่ายบุคคลลงทะเบียนไว้ในระบบแล้วเท่านั้น
//
// เดิมเปิดให้คนที่ไม่มีรหัสในระบบกรอกชื่อกับฝ่ายเองแล้วเข้าใช้งานได้ทันที (source='self')
// โดยกั้นด้วยอีเมลบริษัทเมื่อมีการตั้งค่าโดเมนไว้เท่านั้น ซึ่งแปลว่าถ้าไม่ได้ตั้งโดเมน
// ใครที่มีบัญชีไลน์ก็สมัครเข้ามาเองได้ ตอนนี้ทะเบียนพนักงานอยู่ในระบบครบแล้ว
// และฝ่ายบุคคลเพิ่มคนใหม่เองได้จากหน้าผู้ดูแล ทางลัดนี้จึงถูกปิด

import { getSession, invalidateSessionByLineUserId } from "./_lib/auth";
import { CHANNEL_KEY, CHANNEL_KEYS_READ } from "./_lib/constants";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { syncRichMenu } from "./_lib/richmenu";

interface Body {
  employee_code?: string;
}

const NOT_IN_DIRECTORY = "ไม่พบรหัสพนักงานนี้ในระบบ กรุณาติดต่อฝ่ายทรัพยากรบุคคลเพื่อเพิ่มข้อมูลก่อนใช้งาน";

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    if (s.linked) return json({ ok: true, already: true, employee_id: s.employee?.id });

    const body = await readJson<Body>(req);
    const code = (body.employee_code ?? "").trim().toUpperCase();
    if (!code) throw new HttpError(400, "กรุณาระบุรหัสพนักงาน");

    const sql = db();

    const found = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM employees WHERE employee_code = ${code} LIMIT 1
    `;
    if (found.length === 0) throw new HttpError(404, NOT_IN_DIRECTORY);
    const employeeId = found[0].id;

    // คนที่ลาออกหรือถูกระงับสิทธิ์ ผูกบัญชีใหม่ไม่ได้
    //
    // สำคัญขึ้นมากตั้งแต่ OA มีเมนูตั้งต้น เพราะคนกลุ่มนี้ถูกผูก "เมนูลงทะเบียน" ไว้เป็นรายคน
    // (ถอดเมนูเฉย ๆ ไม่ได้แล้ว จะตกไปได้เมนูหลักแทน) ปุ่มลงทะเบียนจึงอยู่ตรงหน้าเขาตลอด
    // ถ้าไม่กันตรงนี้ กดแล้วผูกสำเร็จ สถานะจะกลายเป็น "ผูกแล้ว" แล้วได้เมนูหลักกลับไปทันที
    if (found[0].status === "suspended") {
      throw new HttpError(
        409,
        "รหัสพนักงานนี้ถูกระงับสิทธิ์อยู่ กรุณาติดต่อฝ่ายทรัพยากรบุคคล",
        "suspended",
      );
    }

    const already = await sql`
      SELECT 1 FROM line_accounts
      WHERE employee_id = ${employeeId} AND channel_key = ANY(${CHANNEL_KEYS_READ}) LIMIT 1
    `;
    if (already.length > 0) {
      throw new HttpError(
        409,
        "รหัสพนักงานนี้ถูกผูกกับบัญชี LINE อื่นแล้ว กรุณาติดต่อฝ่ายทรัพยากรบุคคล",
        "already_linked",
      );
    }

    try {
      await sql`
        INSERT INTO line_accounts (employee_id, line_user_id, channel_key, display_name)
        VALUES (${employeeId}, ${s.lineUserId}, ${CHANNEL_KEY}, ${s.displayName ?? null})
      `;
    } catch (e) {
      // unique violation — บัญชีไลน์นี้ถูกผูกกับพนักงานคนอื่นไปแล้ว หรือมีคนกดพร้อมกันพอดี
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "23505") {
        throw new HttpError(
          409,
          "บัญชีไลน์นี้ถูกผูกไว้กับพนักงานคนอื่นแล้ว กรุณาติดต่อฝ่ายทรัพยากรบุคคล",
          "already_linked",
        );
      }
      throw e;
    }

    invalidateSessionByLineUserId(s.lineUserId);
    // เปลี่ยนเป็นเมนูของคนที่ลงทะเบียนแล้ว ปุ่มลงทะเบียนจะได้หายไปจากเมนูของเขา
    await syncRichMenu(s.lineUserId);
    return json({ ok: true, employee_id: employeeId });
  });
