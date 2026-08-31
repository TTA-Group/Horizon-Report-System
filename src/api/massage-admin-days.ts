// GET /api/massage/admin/days?month=YYYY-MM · POST /api/massage/admin/days
//
// หน้าจัดการวันให้บริการของผู้ดูแล — แทนการเข้าไปรัน SQL เอง ซึ่งเป็นทางเดียวที่เคยทำได้
// งานนี้เกิดทุกครั้งที่บริษัทประกาศวันหยุดหรือหมอนวดลาทั้งวัน บ่อยพอจะไม่ควรต้องพึ่งคนเขียนโปรแกรม
//
// ปิดวันที่มีคนจองอยู่จะยกเลิกคิวทั้งหมดของวันนั้นให้ด้วย และแจ้งเจ้าตัวทุกคนทางไลน์
// เพราะคนที่จองไว้ไม่มีทางรู้เองว่าวันนั้นถูกปิดไปแล้ว

import { getSession } from "./_lib/auth";
import { HttpError, json, methodGuard, readJson, run } from "./_lib/http";
import { adminDays, adminRemoveDay, adminSetDay, assertMassageStaff, bangkokDate } from "./_lib/massage";
import { massageNotice } from "./_lib/massage-flex";
import { notifyEmployee } from "./_lib/massage-notify";

export const massageAdminDays = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const asked = (new URL(req.url).searchParams.get("month") ?? "").trim();
    const month = asked || bangkokDate().slice(0, 7);
    return json({ month, days: await adminDays(month) });
  });

export const massageAdminSetDay = async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "POST");
    const s = await getSession(req);
    await assertMassageStaff(s);

    const { day, status, reason, force, action } = await readJson<{
      day?: string; status?: string; reason?: string; force?: boolean; action?: string;
    }>(req);
    if (!day) throw new HttpError(400, "ไม่ได้ระบุวัน");

    // ลบวันออกจากรายการ — คนละเรื่องกับปิดวัน (ปิดแล้วยังเห็นอยู่และเปิดกลับได้)
    if (action === "remove") {
      const r = await adminRemoveDay(day, { force: force === true, byEmployeeId: s.employee!.id });
      console.log("[massage] ลบวัน", day, `ยกเลิก ${r.cancelled.length} คิว โดย`, s.employee!.employee_code);
      for (const b of r.cancelled) {
        await notifyEmployee(
          b.employeeId,
          massageNotice(
            "คิวนวดของคุณถูกยกเลิก เนื่องจากยกเลิกวันให้บริการ",
            b.day, b.slot, b.therapistName,
            "กรุณาจองวันอื่นแทนได้เลย",
          ),
        );
      }
      return json({ ok: true, day: r.day, removed: true, cancelled: r.cancelled.length });
    }

    if (status !== "open" && status !== "closed") throw new HttpError(400, "สถานะไม่ถูกต้อง");

    const r = await adminSetDay(day, status, {
      reason,
      force: force === true,
      byEmployeeId: s.employee!.id,
    });
    console.log("[massage]", status === "open" ? "เปิดวัน" : "ปิดวัน", day,
      `ยกเลิก ${r.cancelled.length} คิว โดย`, s.employee!.employee_code);

    // แจ้งทีละคน ไม่ multicast เพราะข้อความมีรอบเวลาของแต่ละคนอยู่ข้างใน
    for (const b of r.cancelled) {
      await notifyEmployee(
        b.employeeId,
        massageNotice(
          "คิวนวดของคุณถูกยกเลิก เนื่องจากปิดให้บริการ",
          b.day, b.slot, b.therapistName,
          `เหตุผล: ${(reason ?? "").trim() || "ปิดให้บริการ"}\nกรุณาจองวันอื่นแทนได้เลย`,
        ),
      );
    }
    return json({ ok: true, day: r.day, status: r.status, cancelled: r.cancelled.length });
  });
