// /api/massage/admin/{cancel,move,reassign,book,day,employees} — ผู้ดูแลจัดการคิวแทนพนักงาน
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
  adminBook, adminCancel, adminDayGrid, adminMove, adminReassign, assertMassageStaff,
} from "./_lib/massage";
import { massageNotice } from "./_lib/massage-flex";
import { notifyEmployee as notify } from "./_lib/massage-notify";
import { db } from "./_lib/db";

export const massageAdminCancel = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { id, reason } = await readJson<{ id?: string; reason?: string }>(req);
    if (!id) throw new HttpError(400, "ไม่ได้ระบุคิว");

    const b = await adminCancel(id, s.employee!.id, reason || "ผู้ดูแลยกเลิกให้");
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
    return json({ ok: true, id, day: b.day, slot: b.slot, therapistId: b.therapistId });
  });

/** GET /api/massage/admin/employees?q= — ค้นชื่อพนักงานสำหรับเปลี่ยนคนจอง */
export const massageAdminEmployees = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (q.length < 2) return json({ employees: [] });

    // จำกัดจำนวนไว้ เพราะหน้าจอแสดงได้ไม่กี่รายการอยู่แล้ว และกันการดูดทะเบียนทั้งบริษัทออกไป
    //
    // ส่งจำนวนสิทธิ์ที่ใช้ไปของเดือนนี้มาด้วย เพราะหน้าจองแทนต้องบอกผู้ดูแลก่อนกดว่า
    // คิวนี้จะหักสิทธิ์หรือกลายเป็นคิวด่วน ถ้าไม่บอกก่อน ผู้ดูแลจะรู้ก็ต่อเมื่อกดไปแล้ว
    const rows = await db()<
      { id: string; employee_code: string; full_name: string; dept: string | null; used: number }[]
    >`
      SELECT e.id, e.employee_code, e.full_name, COALESCE(d.name, e.department_name) AS dept,
             (SELECT count(*)::int FROM massage_bookings b
               WHERE b.employee_id = e.id AND b.status = 'booked' AND b.kind = 'quota'
                 AND b.day >= date_trunc('month', (now() AT TIME ZONE 'Asia/Bangkok'))::date
                 AND b.day <  (date_trunc('month', (now() AT TIME ZONE 'Asia/Bangkok'))
                               + INTERVAL '1 month')::date) AS used
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.status = 'active' AND (e.full_name ILIKE ${"%" + q + "%"} OR e.employee_code ILIKE ${q + "%"})
      ORDER BY e.full_name
      LIMIT 10
    `;
    return json({ employees: rows });
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
    console.log("[massage] เปลี่ยนคนจอง", id, "->", b.toName, "โดย", s.employee!.employee_code);

    // แจ้งทั้งคนเดิมและคนใหม่ ทั้งคู่ต้องรู้ว่าคิวนี้เป็นของใครแล้ว
    await notify(
      b.employeeId,
      massageNotice("คิวนวดของคุณถูกโอนให้ผู้อื่นแล้ว", b.day, b.slot, b.therapistName,
        `เจ้าหน้าที่เปลี่ยนชื่อผู้จองเป็น ${b.toName} ตามที่แจ้งไว้`),
    );
    await notify(
      employeeId,
      massageNotice("คุณได้รับคิวนวดที่โอนมา", b.day, b.slot, b.therapistName,
        "เจ้าหน้าที่เปลี่ยนชื่อผู้จองเป็นคุณแล้ว กรุณามาตามเวลา"),
    );
    return json({ ok: true, id, toName: b.toName });
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
    console.log("[massage] จองแทน", b.name, b.day, b.slot, b.flash ? "(คิวด่วน)" : "(คิวสิทธิ์)",
      "โดย", s.employee!.employee_code);

    await notify(
      b.employeeId,
      massageNotice(
        "เจ้าหน้าที่จองคิวนวดให้คุณแล้ว",
        b.day, b.slot, b.therapistName,
        b.flash
          ? "คิวนี้เป็นคิวด่วน ยกเลิกในระบบไม่ได้ หากมาไม่ได้ กรุณาแจ้งฝ่ายบุคคล"
          : "หากไม่สะดวก กรุณายกเลิกในแอปล่วงหน้าอย่างน้อย 15 นาที",
      ),
    );
    return json({
      ok: true, id: b.id, name: b.name, day: b.day, slot: b.slot,
      therapistName: b.therapistName, flash: b.flash, used: b.used,
    });
  });
