// GET /api/reports/summary — ตัวเลขสรุปงานของฝ่าย พร้อมลิงก์รายงานฉบับเต็ม
//
// เปิดให้เฉพาะหัวหน้าฝ่ายและผู้ดูแลระบบ (HR) เพราะรายงานมีตารางผลงานรายบุคคลซึ่งเป็นเอกสาร
// ของฝ่ายบริหาร ไม่ใช่ข้อมูลที่ทุกคนในฝ่ายควรเปิดดูของกันและกันได้เอง
// (คิวงานยังเปิดให้เจ้าหน้าที่ทุกคนเห็นเหมือนเดิม — จำกัดเฉพาะ "การสรุปผลงาน" เท่านั้น)

import { getSession, requireActive, type Session } from "./_lib/auth";
import { db } from "./_lib/db";
import { HttpError, json, methodGuard, run } from "./_lib/http";
import { signReportToken } from "./_lib/report-token";
import { ALL_DEPTS, buildDeptReport, PERIOD_TITLE, periodRange, type Period } from "./_lib/reports";

const MAX_OFFSET = 12; // ย้อนหลังได้ราวหนึ่งปีสำหรับรายเดือน และสามเดือนสำหรับรายสัปดาห์

interface DeptOption {
  id: string;
  code: string;
  name: string;
}

/** ฝ่ายที่คนนี้ดูรายงานได้ — ผู้ดูแลระบบเห็นทุกฝ่ายที่รับเรื่อง ส่วนคนอื่นเห็นเฉพาะฝ่ายที่ตัวเองเป็นหัวหน้า */
async function reportableDepts(s: Session): Promise<DeptOption[]> {
  const sql = db();
  if (s.isAdmin) {
    const rows = await sql<DeptOption[]>`
      SELECT id, code, name FROM departments
      WHERE is_active = true AND receives_tickets = true ORDER BY code
    `;
    return [...rows];
  }
  const headCodes = s.deptRoles.filter((r) => r.role === "head").map((r) => r.department_id);
  if (headCodes.length === 0) return [];
  const rows = await sql<DeptOption[]>`
    SELECT id, code, name FROM departments WHERE id = ANY(${headCodes}) AND is_active = true ORDER BY code
  `;
  return [...rows];
}

export default async (req: Request): Promise<Response> =>
  run(async () => {
    methodGuard(req, "GET");
    const s = await getSession(req);
    requireActive(s);

    const params = new URL(req.url).searchParams;
    const period = (params.get("period") ?? "week").trim() as Period;
    if (period !== "week" && period !== "month") throw new HttpError(400, "ช่วงเวลาไม่ถูกต้อง");
    const offset = Math.min(MAX_OFFSET, Math.max(0, Number(params.get("offset") ?? "1") || 0));

    const options = await reportableDepts(s);
    if (options.length === 0) {
      throw new HttpError(403, "รายงานสรุปงานเปิดให้เฉพาะหัวหน้าฝ่ายและผู้ดูแลระบบ", "not_head");
    }

    // ไม่ระบุฝ่าย = ทุกฝ่ายที่คนนี้ดูได้ ซึ่งเป็นค่าเริ่มต้นของหน้าสรุปงาน
    // ภาพรวมต้องมาก่อน แล้วค่อยเจาะเข้าไปทีละฝ่าย ไม่ใช่เปิดมาเจอฝ่ายแรกตามตัวอักษร
    const wanted = (params.get("dept") ?? "").trim().toUpperCase();
    const all = !wanted || wanted === ALL_DEPTS;
    const dept = all ? null : options.find((d) => d.code === wanted);
    if (!all && !dept) throw new HttpError(403, "ไม่มีสิทธิ์ดูรายงานของฝ่ายนี้");
    const ids = dept ? [dept.id] : options.map((d) => d.id);

    const report = await buildDeptReport(ids, period, offset);
    if (!report) throw new HttpError(404, "ไม่พบฝ่ายนี้");

    // ลิงก์เปิดได้โดยไม่ต้องล็อกอิน เพื่อส่งต่อให้ผู้บริหารที่ไม่ได้ใช้แอปนี้
    const origin = new URL(req.url).origin;
    const token = signReportToken({ d: ids, p: period, o: offset });

    // ชิป "ทั้งหมด" ขึ้นเฉพาะตอนที่มีฝ่ายให้รวมจริง ๆ — ฝ่ายเดียวรวมแล้วก็ได้ตัวเดิม
    const chips = options.map((d) => ({ code: d.code, name: d.name }));
    if (options.length > 1) chips.unshift({ code: ALL_DEPTS, name: "ทั้งหมด" });

    return json({
      ...report,
      departments: chips,
      period_options: [
        { period: "week", offset: 0, label: "สัปดาห์นี้" },
        { period: "week", offset: 1, label: "สัปดาห์ที่แล้ว" },
        { period: "month", offset: 0, label: "เดือนนี้" },
        { period: "month", offset: 1, label: "เดือนที่แล้ว" },
      ],
      share_url: `${origin}/api/reports/view?t=${token}`,
      csv_url: `${origin}/api/reports/view?t=${token}&format=csv`,
      share_label: `${PERIOD_TITLE[period]} ${periodRange(period, offset).label}`,
    });
  });
