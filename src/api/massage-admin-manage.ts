// /api/massage/admin/{cancel,move,reassign,book,day,employees,quota} — ผู้ดูแลจัดการคิวแทนพนักงาน
//
// มีเพื่อให้ผู้ดูแลหน้างานแก้ของจริงได้ เช่น พนักงานโทรมาบอกว่ามาไม่ได้ ขอสลับรอบ
// หรือเดินมาขอคิวที่หน้าห้องนวดเลย ถ้าไม่มีทางแก้ ช่องนั้นจะค้างเป็น "จองแล้ว"
// ทั้งที่ไม่มีใครมา และไม่มีใครจองแทนได้
//
// ทุกเส้นทางบังคับสิทธิ์ด้วย assertMassageStaff เหมือนฟอร์มเช็คชื่อ
// และแจ้งเจ้าตัวทางไลน์เสมอ เพราะเป็นการแตะคิวของคนอื่น เจ้าตัวต้องรู้ว่ามีอะไรเปลี่ยน

import { getSession } from "./_lib/auth";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import {
  MONTHLY_QUOTA, adjustQuota, adminBook, adminCancel, adminDayGrid, adminMove, adminReassign,
  assertMassageStaff, bangkokDate, quotaFromExtra, PERMANENT_MONTH, STAFF_CODE, usedQuotaRule,
  type QuotaScope,
} from "./_lib/massage";
import { bookingConfirmCard, massageNotice } from "./_lib/massage-flex";
import { notifyEmployee as notify, notifyEmployeeWith } from "./_lib/massage-notify";
import { db } from "./_lib/db";

export const massageAdminCancel = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { id, reason } = await readJson<{ id?: string; reason?: string }>(req);
    if (!id) throw new HttpError(400, "ไม่ได้ระบุคิว");

    const b = await adminCancel(id, s.employee!.id, reason || "ผู้ดูแลยกเลิกให้");
    // ช่องที่ล็อกไว้ไม่มีเจ้าของ การปลดล็อกจึงไม่ต้องบอกใคร
    if (b.kind !== "hold") {
      await notify(
        b.employeeId,
        massageNotice(
          "เจ้าหน้าที่ยกเลิกคิวนวดของคุณ",
          b.day,
          b.slot,
          b.therapistName,
          "หากมีข้อสงสัยโปรดติดต่อฝ่ายบุคคล",
        ),
      );
    }
    return json({ ok: true, id, day: b.day, slot: b.slot });
  });

export const massageAdminMove = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { id, slot, therapistId } = await readJson<{
      id?: string; slot?: string; therapistId?: string;
    }>(req);
    if (!id || !slot || !therapistId) throw new HttpError(400, "ข้อมูลไม่ครบ");

    const b = await adminMove(id, slot, therapistId);
    console.log("[massage] ย้ายคิว", id, "->", b.day, b.slot, "โดย", s.employee!.employee_code);
    // ช่องที่ล็อกไว้ยังไม่มีเจ้าของ ย้ายไปไหนก็ไม่ต้องบอกใคร
    if (b.kind !== "hold") {
      await notify(
        b.employeeId,
        massageNotice(
          "เจ้าหน้าที่ย้ายคิวนวดของคุณ",
          b.day,
          b.slot,
          b.therapistName,
          "นี่คือรอบใหม่ของคุณ หากไม่สะดวก กรุณาแจ้งเจ้าหน้าที่",
        ),
      );
    }
    return json({ ok: true, id, day: b.day, slot: b.slot, therapistId: b.therapistId });
  });

/** GET /api/massage/admin/employees?q= — ค้นชื่อพนักงานสำหรับเปลี่ยนคนจอง */
export const massageAdminEmployees = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    await assertMassageStaff(s);

    // เดือนกับสิทธิ์ปกติส่งกลับเสมอ แม้ยังไม่ได้พิมพ์อะไร เพราะหน้าปรับสิทธิ์ต้องขึ้น
    // ชื่อเดือนให้ถูกตั้งแต่เปิดหน้า ไม่ใช่รอจนกว่าจะค้นเจอคนแรก
    // ส่งพนักงานเงา STAFF มาด้วยเสมอ เพื่อให้หน้าจองแทนมีปุ่มล็อกช่องได้โดยไม่ต้องค้นหาเอง
    // ยังไม่ได้รัน db/massage-staff-hold.sql = ไม่มีแถวนี้ ปุ่มก็ไม่ขึ้น ซึ่งตรงกับความจริง
    const staffRows = await db()<{ id: string; full_name: string }[]>`
      SELECT id, full_name FROM employees
      WHERE employee_code = ${STAFF_CODE} AND status = 'active'
    `;
    const staff = staffRows[0]
      ? { id: staffRows[0].id, name: staffRows[0].full_name, code: STAFF_CODE }
      : null;

    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (q.length < 2) {
      return json({ month: bangkokDate().slice(0, 7), base: MONTHLY_QUOTA, staff, employees: [] });
    }

    // จำกัดจำนวนไว้ เพราะหน้าจอแสดงได้ไม่กี่รายการอยู่แล้ว และกันการดูดทะเบียนทั้งบริษัทออกไป
    //
    // ส่งจำนวนสิทธิ์ที่ใช้ไปของเดือนนี้มาด้วย เพราะหน้าจองแทนต้องบอกผู้ดูแลก่อนกดว่า
    // คิวนี้จะหักสิทธิ์หรือกลายเป็นคิวด่วน ถ้าไม่บอกก่อน ผู้ดูแลจะรู้ก็ต่อเมื่อกดไปแล้ว
    //
    // ส่ง extra มาด้วย เพราะสิทธิ์ปรับเป็นรายคนได้แล้ว ถ้าหน้าจอเอาสิทธิ์ของผู้ดูแลเอง
    // มาหารตัวเลข คนที่ถูกปรับสิทธิ์จะโชว์ผิดทุกคน
    const rows = await db()<
      {
        id: string; employee_code: string; full_name: string;
        dept: string | null; used: number; permanent: number; monthly: number;
      }[]
    >`
      SELECT e.id, e.employee_code, e.full_name, COALESCE(d.name, e.department_name) AS dept,
             -- ใช้กติกาเดียวกับที่ตอนกดจองใช้ตัดสิน (usedQuotaRule) ห้ามเขียนเงื่อนไขเอง
             -- ไม่งั้นเลขบนหน้าผู้ดูแลกับเลขที่พนักงานโดนจริงจะไม่ตรงกัน
             (SELECT count(*)::int FROM massage_bookings b
               WHERE b.employee_id = e.id AND b.kind = 'quota'
                 AND b.day >= date_trunc('month', (now() AT TIME ZONE 'Asia/Bangkok'))::date
                 AND b.day <  (date_trunc('month', (now() AT TIME ZONE 'Asia/Bangkok'))
                               + INTERVAL '1 month')::date
                 AND ${usedQuotaRule(db())}) AS used,
             -- แยกสองชั้นมาให้หน้าจอ: สิทธิ์ที่ให้ถาวร กับสิทธิ์ที่ให้เฉพาะเดือนนี้
             -- ต้องแยก เพราะหน้าปรับสิทธิ์มีคันโยกสองอัน ถ้าส่งมาแต่ผลรวมจะเติมเลขคืนไม่ถูก
             COALESCE((SELECT x.extra FROM massage_quota_extra x
                        WHERE x.employee_id = e.id AND x.month = ${PERMANENT_MONTH}), 0) AS permanent,
             COALESCE((SELECT x.extra FROM massage_quota_extra x
                        WHERE x.employee_id = e.id
                          AND x.month = to_char((now() AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM')), 0) AS monthly
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.status = 'active' AND (e.full_name ILIKE ${"%" + q + "%"} OR e.employee_code ILIKE ${q + "%"})
      ORDER BY e.full_name
      LIMIT 10
    `;
    // ส่งเดือนที่ตัวเลขชุดนี้อ้างถึงกลับไปด้วย เพราะหน้าจอห้ามคิดเดือนเองจากนาฬิกาเครื่อง
    // (เครื่องที่ตั้งเขตเวลาผิดจะขึ้นชื่อเดือนคนละเดือนกับที่เซิร์ฟเวอร์ใช้ตัดสินสิทธิ์)
    return json({
      month: bangkokDate().slice(0, 7),
      base: MONTHLY_QUOTA,
      staff,
      employees: rows.map((r) => ({
        ...r,
        extra: r.permanent + r.monthly,
        quota: quotaFromExtra(r.permanent + r.monthly),
      })),
    });
  });

/**
 * POST /api/massage/admin/quota — ผู้ดูแลกดเพิ่ม/ลดสิทธิ์ให้พนักงานหนึ่งครั้ง
 *
 * รับแค่ทิศทาง (+1 / -1) ไม่รับตัวเลขสิทธิ์ที่ต้องการ เพราะหน้าจอเป็นปุ่มบวกลบ
 * และการส่งทิศทางทำให้ผู้ดูแลสองคนที่กดพร้อมกันได้ผลรวมที่ถูก แทนที่จะทับกัน
 *
 * ไม่แจ้งเจ้าตัวทางไลน์ ต่างจากการแตะคิว เพราะสิทธิ์ที่เพิ่มให้มักตกลงกันปากเปล่าอยู่แล้ว
 * และการยิงข้อความทุกครั้งที่กดปุ่มปรับ จะกลายเป็นสแปมตอนผู้ดูแลกดแก้ไปมา
 */
export const massageAdminQuota = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { employeeId, step, scope } = await readJson<{
      employeeId?: string; step?: number; scope?: string;
    }>(req);
    if (!employeeId) throw new HttpError(400, "ไม่ได้ระบุพนักงาน");
    if (step !== 1 && step !== -1) throw new HttpError(400, "ปรับได้ทีละหนึ่งครั้งเท่านั้น");
    // ไม่ระบุ = เดือนนี้ ตามพฤติกรรมเดิมก่อนมีปุ่มถาวร
    if (scope !== undefined && scope !== "month" && scope !== "permanent") {
      throw new HttpError(400, "ระบุขอบเขตสิทธิ์ไม่ถูกต้อง", "bad_scope");
    }
    const which: QuotaScope = scope === "permanent" ? "permanent" : "month";

    const month = bangkokDate().slice(0, 7);
    const line = await adjustQuota(employeeId, month, step, s.employee!.id, which);
    console.log(
      "[massage] ปรับสิทธิ์", employeeId,
      which === "permanent" ? "แบบถาวร" : `เดือน ${month}`,
      "เป็น", line.quota, "โดย", s.employee!.employee_code,
    );
    return json({ ok: true, ...line });
  });

/** POST /api/massage/admin/reassign — เปลี่ยนชื่อผู้จองของคิวหนึ่ง */
export const massageAdminReassign = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { id, employeeId } = await readJson<{ id?: string; employeeId?: string }>(req);
    if (!id || !employeeId) throw new HttpError(400, "ข้อมูลไม่ครบ");

    const b = await adminReassign(id, employeeId);
    console.log("[massage] เปลี่ยนคนจอง", id, "->", b.toName,
      b.hold ? "(กลายเป็นช่องที่ล็อกไว้)" : b.flash ? "(คิวด่วน)" : "(คิวสิทธิ์)",
      "โดย", s.employee!.employee_code);

    // แจ้งทั้งคนเดิมและคนใหม่ ทั้งคู่ต้องรู้ว่าคิวนี้เป็นของใครแล้ว
    //
    // ยกเว้นฝั่งที่เป็นช่องล็อกของ STAFF ซึ่งไม่มีเจ้าของจริงให้แจ้ง — การโอนช่องที่ล็อกไว้
    // ให้คนจริงจึงส่งข้อความออกใบเดียว ไม่ใช่ส่งบอกใครว่า "คิวของคุณถูกโอนไป"
    if (b.kind !== "hold") {
      await notify(
        b.employeeId,
        massageNotice("คิวนวดของคุณถูกโอนให้ผู้อื่นแล้ว", b.day, b.slot, b.therapistName,
          `เจ้าหน้าที่เปลี่ยนชื่อผู้จองเป็น ${b.toName} ตามที่แจ้งไว้`),
      );
    }
    if (!b.hold) {
      await notify(
        employeeId,
        massageNotice("คุณได้รับคิวนวดที่โอนมา", b.day, b.slot, b.therapistName,
          "เจ้าหน้าที่เปลี่ยนชื่อผู้จองเป็นคุณแล้ว กรุณามาตามเวลา"),
      );
    }
    return json({ ok: true, id, toName: b.toName, flash: b.flash, hold: b.hold });
  });

/** GET /api/massage/admin/day?day=YYYY-MM-DD — ตารางทั้งวันพร้อมชื่อผู้จอง สำหรับหน้าจองแทน */
export const massageAdminDayGrid = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const day = (new URL(req.url).searchParams.get("day") ?? "").trim();
    if (!day) throw new HttpError(400, "ไม่ได้ระบุวัน");
    return json(await adminDayGrid(day));
  });

/**
 * POST /api/massage/admin/book — ผู้ดูแลจองคิวให้พนักงานคนอื่น
 *
 * แจ้งเจ้าตัวเสมอ เพราะพนักงานไม่ได้เป็นคนกดเอง ถ้าไม่แจ้งก็ไม่มีทางรู้ว่ามีคิวรออยู่
 *
 * ส่งเป็น "การ์ด" ใบเดียวกับตอนพนักงานกดจองเอง ไม่ใช่ข้อความเปล่า เพราะปุ่มยกเลิก
 * อยู่บนการ์ด — ถ้าส่งเป็นข้อความ คนที่ถูกจองให้จะยกเลิกเองไม่ได้ ต้องเดินไปหา
 * เจ้าหน้าที่ทุกครั้ง ทั้งที่กติกาให้ยกเลิกเองได้อยู่แล้ว
 */
export const massageAdminBook = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { employeeId, day, slot, therapistId } = await readJson<{
      employeeId?: string; day?: string; slot?: string; therapistId?: string;
    }>(req);
    if (!employeeId || !day || !slot || !therapistId) throw new HttpError(400, "ข้อมูลไม่ครบ");

    const b = await adminBook({ employeeId, day, slot, therapistId });
    console.log("[massage] จองแทน", b.name, b.day, b.slot,
      b.hold ? "(ล็อกช่องไว้)" : b.flash ? "(คิวด่วน)" : "(คิวสิทธิ์)",
      "โดย", s.employee!.employee_code);

    // ช่องที่ล็อกไว้ยังไม่มีเจ้าของจริง จึงไม่มีใครให้แจ้ง
    // (ถึงส่งไปก็ไม่มีบัญชีไลน์ให้ส่ง แต่การไม่เรียกเลยทำให้อ่านโค้ดแล้วรู้ว่าตั้งใจ)
    if (!b.hold) {
      await notifyEmployeeWith(b.employeeId, [
        bookingConfirmCard({
          bookingId: b.id,
          day: b.day,
          slot: b.slot,
          therapistName: b.therapistName,
          employeeName: b.name,
          flash: b.flash,
          byStaff: true,
        }),
      ]);
    }
    return json({
      ok: true, id: b.id, name: b.name, day: b.day, slot: b.slot,
      therapistName: b.therapistName, flash: b.flash, hold: b.hold, used: b.used,
    });
  });
