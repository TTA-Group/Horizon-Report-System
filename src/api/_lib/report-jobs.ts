// ส่งรายงานสรุปให้หัวหน้าฝ่ายตามรอบ — เช้าวันจันทร์ (รายสัปดาห์) และวันที่ 1 (รายเดือน)
//
// รายงานที่ต้องรอให้คนนึกขึ้นได้เองว่าต้องเปิดดู สุดท้ายจะไม่มีใครเปิด การส่งเข้าแชทส่วนตัว
// ของหัวหน้าฝ่ายพร้อมลิงก์ ทำให้รายงานไปถึงมือคนที่ต้องใช้โดยไม่ต้องจำอะไร
//
// ข้ามฝ่ายที่ไม่มีอะไรจะรายงาน (ไม่มีงานเข้า ไม่มีงานปิด ไม่มีงานค้าง) — ข้อความที่เป็นศูนย์ทุกช่อง
// ส่งไปทุกสัปดาห์มีแต่จะสอนให้คนเลิกอ่าน

import { adminCodes, CHANNEL_KEY } from "./constants";
import { db } from "./db";
import { publicBaseUrl } from "./env";
import { pushTo, textMessage } from "./line";
import { signReportToken } from "./report-token";
import { buildDeptReport, PERIOD_TITLE, type DeptReport, type Period } from "./reports";

interface DeptRow {
  id: string;
  code: string;
  name: string;
  escalate_to: string | null;
}

function reportUrl(departmentId: string, period: Period): string | null {
  const base = publicBaseUrl();
  if (!base) return null;
  // ลิงก์ของรายงานที่ส่งอัตโนมัติอายุยาวกว่าปกติหน่อย เผื่อหัวหน้าฝ่ายเปิดอ่านช้าหรือส่งต่อทีหลัง
  return `${base}/api/reports/view?t=${signReportToken({ d: departmentId, p: period, o: 1 }, 30)}`;
}

function summaryText(r: DeptReport, link: string | null): string {
  const open = r.now.pending + r.now.in_progress;
  const lines = [
    `สรุปงาน${r.period_title} · ${r.department_name}`,
    `ช่วง ${r.range_label}`,
    "",
    `แจ้งเข้ามา ${r.flow.created} เรื่อง`,
    `ปิดจบไปแล้ว ${r.flow.completed} เรื่อง`,
    `ยังค้างอยู่ ${open} เรื่อง`,
  ];
  const alerts: string[] = [];
  if (r.now.pending > 0) alerts.push(`ยังไม่มีผู้รับ ${r.now.pending} เรื่อง`);
  if (r.now.overdue > 0) alerts.push(`เลยกำหนดแล้ว ${r.now.overdue} เรื่อง`);
  if (r.now.not_assessed > 0) alerts.push(`รับแล้วยังไม่แจ้งผล ${r.now.not_assessed} เรื่อง`);
  if (alerts.length > 0) lines.push("", "ต้องตามต่อ", ...alerts.map((a) => `• ${a}`));
  if (link) lines.push("", "รายงานฉบับเต็ม (เปิดแล้วบันทึกเป็น PDF ได้)", link);
  else lines.push("", "เปิดรายงานฉบับเต็มได้ที่แท็บ “สรุปงาน” ในแอป");
  return lines.join("\n");
}

async function lineIdOf(employeeId: string): Promise<string | null> {
  const sql = db();
  const rows = await sql<{ line_user_id: string }[]>`
    SELECT line_user_id FROM line_accounts
    WHERE employee_id = ${employeeId} AND channel_key = ${CHANNEL_KEY} LIMIT 1
  `;
  return rows[0]?.line_user_id ?? null;
}

export async function sendDeptReports(period: Period): Promise<{ departments: number; sent: number; skipped: number }> {
  const sql = db();
  const depts = await sql<DeptRow[]>`
    SELECT id, code, name, escalate_to FROM departments
    WHERE is_active = true AND receives_tickets = true ORDER BY code
  `;

  let sent = 0;
  let skipped = 0;
  const digest: string[] = [];

  for (const d of depts) {
    const r = await buildDeptReport(d.id, period, 1);
    if (!r) continue;
    const open = r.now.pending + r.now.in_progress;
    if (r.flow.created === 0 && r.flow.completed === 0 && open === 0) {
      skipped++;
      continue;
    }

    const link = reportUrl(d.id, period);
    digest.push(
      `• ${d.name}: เข้า ${r.flow.created} · ปิด ${r.flow.completed} · ค้าง ${open}` +
        (r.now.overdue > 0 ? ` (เลยกำหนด ${r.now.overdue})` : "") +
        (link ? `\n  ${link}` : ""),
    );

    if (d.escalate_to) {
      const head = await lineIdOf(d.escalate_to);
      if (head) {
        await pushTo(head, [textMessage(summaryText(r, link))], { channel: "user" });
        sent++;
      }
    }
  }

  // ผู้ดูแลระบบ (HR) ได้ฉบับรวมทุกฝ่ายในข้อความเดียว เพราะเป็นคนที่ต้องเอาไปประกอบเสนอผู้บริหาร
  const codes = [...adminCodes()];
  if (digest.length > 0 && codes.length > 0) {
    const admins = await sql<{ line_user_id: string }[]>`
      SELECT la.line_user_id FROM employees e
      JOIN line_accounts la ON la.employee_id = e.id AND la.channel_key = ${CHANNEL_KEY}
      WHERE e.employee_code = ANY(${codes})
    `;
    const text = [`สรุปงาน${PERIOD_TITLE[period]} ทุกฝ่าย`, "", ...digest].join("\n");
    for (const a of admins) {
      await pushTo(a.line_user_id, [textMessage(text)], { channel: "user" });
      sent++;
    }
  }

  return { departments: depts.length, sent, skipped };
}
