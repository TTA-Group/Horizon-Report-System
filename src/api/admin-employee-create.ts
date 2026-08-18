// POST /api/admin/employees — เพิ่มพนักงานเข้าระบบทีละคน (เฉพาะผู้ดูแล)
//
// เดิมรายชื่อพนักงานเข้าระบบได้ทางเดียวคือให้คนเขียน SQL นำเข้าให้ ทุกครั้งที่มีคนเข้าใหม่จึงต้อง
// รอรอบนำเข้า และพนักงานคนนั้นก็ผูกบัญชี LINE ไม่ได้จนกว่าจะถึงรอบ ปุ่มนี้เปิดให้ฝ่ายบุคคล
// เพิ่มเองได้จากหน้าผู้ดูแลโดยตรง
//
// body: { employee_code, full_name, department_name, floor }
// คนที่เพิ่มทางนี้นับเป็น source='directory' เพราะมาจากฝ่ายบุคคล ไม่ใช่พนักงานกรอกเอง

import { getSession, requireAdmin } from "./_lib/auth";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";

interface Body {
  employee_code?: string;
  full_name?: string;
  department_name?: string;
  floor?: string;
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    requireAdmin(s);

    const body = await readJson<Body>(req);
    const code = (body.employee_code ?? "").trim();
    const fullName = (body.full_name ?? "").trim();
    const departmentName = (body.department_name ?? "").trim();
    const floor = (body.floor ?? "").trim();

    // รหัสพนักงานต้องเป็นตัวเลข 5 หลักให้ตรงกับที่หน้าผูกบัญชียอมรับ
    // ถ้าเพิ่มรหัสรูปแบบอื่นเข้ามา พนักงานคนนั้นจะกรอกรหัสตัวเองเพื่อผูกบัญชีไม่ได้เลย
    if (!/^\d{5}$/.test(code)) throw new HttpError(400, "รหัสพนักงานต้องเป็นตัวเลข 5 หลัก");
    if (!fullName) throw new HttpError(400, "กรุณากรอกชื่อ–สกุล");
    if (fullName.length > 150) throw new HttpError(400, "ชื่อ–สกุลยาวเกินไป");
    if (!departmentName) throw new HttpError(400, "กรุณาระบุฝ่าย/แผนก");
    if (departmentName.length > 100) throw new HttpError(400, "ชื่อฝ่าย/แผนกยาวเกินไป");
    if (floor.length > 20) throw new HttpError(400, "ชั้นที่ระบุยาวเกินไป (ไม่เกิน 20 ตัวอักษร)");

    const sql = db();

    // ตรวจก่อนเพื่อบอกได้ว่ารหัสนี้เป็นของใคร — ข้อความ "รหัสซ้ำ" เฉย ๆ ไม่พอให้ฝ่ายบุคคลตัดสินใจ
    // ว่าพิมพ์ผิด หรือเป็นคนเดิมที่ถูกระงับสิทธิ์ไว้แล้วต้องไปกดคืนสิทธิ์แทน
    const dup = await sql<{ full_name: string; status: string }[]>`
      SELECT full_name, status FROM employees WHERE employee_code = ${code} LIMIT 1
    `;
    if (dup.length > 0) {
      const who = dup[0].full_name;
      throw new HttpError(
        409,
        dup[0].status === "suspended"
          ? `รหัส ${code} เป็นของ ${who} ซึ่งถูกระงับสิทธิ์อยู่ หากเป็นคนเดิมให้กดคืนสิทธิ์แทนการเพิ่มใหม่`
          : `รหัส ${code} มีอยู่แล้ว (${who})`,
      );
    }

    try {
      const inserted = await sql<{ id: string }[]>`
        INSERT INTO employees (employee_code, full_name, department_name, floor, source, status)
        VALUES (${code}, ${fullName}, ${departmentName}, ${floor || null}, 'directory', 'active')
        RETURNING id
      `;
      return json({
        ok: true,
        employee: {
          id: inserted[0].id,
          employee_code: code,
          full_name: fullName,
          department_name: departmentName,
          floor: floor || null,
        },
      });
    } catch (e) {
      // กันกรณีมีผู้ดูแลสองคนกดเพิ่มรหัสเดียวกันพร้อมกัน — ด่านตรวจข้างบนไม่ครอบคลุมจังหวะนี้
      if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "23505") {
        throw new HttpError(409, `รหัส ${code} เพิ่งถูกเพิ่มเข้าระบบไปแล้ว`);
      }
      throw e;
    }
  });
