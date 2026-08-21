// หน้าสรุปงาน — ไฟล์เดียวจบ เปิดในเบราว์เซอร์ไหนก็ได้ และสั่งพิมพ์เป็น PDF ได้เลย
//
// หน้านี้มีของอยู่สองอย่างเท่านั้น: ตัวเลขสี่ตัวที่บอกภาพรวม กับตารางรายการงานทั้งหมด
// ไม่มีกราฟและไม่มีตัวชี้วัดประสิทธิภาพ เพราะคนที่เปิดดูต้องการรู้ว่า "ตอนนี้เหลืออะไร"
// ไม่ได้ต้องการแผงข้อมูลที่ต้องนั่งตีความ ของที่ใส่เพิ่มเข้ามาทุกชิ้นคือของที่ทำให้หน้าอ่านยากขึ้น
//
// ทำเป็นหน้าเว็บไม่ใช่ PDF เพราะ Worker สร้าง PDF ไม่ได้ถ้าไม่ลงไลบรารีหนัก ๆ และหน้าเว็บ
// ได้ประโยชน์มากกว่า: ส่งลิงก์ให้เปิดจากมือถือได้ทันที หรือกดพิมพ์เก็บเป็น PDF ก็ได้จากไฟล์เดียว

import type { DeptReport, ReportTicket } from "./reports";

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

const URGENCY_LABEL: Record<string, string> = { normal: "ปกติ", urgent: "เร่งด่วน", critical: "เร่งด่วนมาก" };

/** ป้ายสถานะบนแถว — สีบอกโทน ตัวหนังสือบอกความหมาย ไม่ได้ใช้สีอย่างเดียวสื่อความ */
function statusPill(t: ReportTicket): string {
  if (t.status === "completed" || t.status === "closed") return `<span class="p ok">เสร็จสิ้น</span>`;
  if (t.status === "cancelled") return `<span class="p off">ยกเลิก</span>`;
  if (t.status === "pending") return `<span class="p late">รอรับเรื่อง</span>`;
  if (t.overdue_days > 0) return `<span class="p late">เลยกำหนด ${t.overdue_days} วัน</span>`;
  if (t.waiting_parts) return `<span class="p wait">รออะไหล่</span>`;
  return `<span class="p run">กำลังดำเนินการ</span>`;
}

function card(value: number, label: string, note: string, tone = ""): string {
  return `<div class="kc">
    <div class="kl">${esc(label)}</div>
    <div class="kv">${value}</div>
    <div class="kn ${tone}">${esc(note)}</div>
  </div>`;
}

function rows(list: ReportTicket[]): string {
  return list
    .map(
      (t) => `<tr>
        <td class="mono nowrap">${esc(t.ticket_no)}</td>
        <td><div class="d">${esc(t.detail)}</div><div class="s">${esc(t.category_label)}${
          t.urgency === "normal" ? "" : ` · <b>${esc(URGENCY_LABEL[t.urgency] ?? t.urgency)}</b>`
        }</div></td>
        <td>${esc(t.floor)}${t.location_note ? `<div class="s">${esc(t.location_note)}</div>` : ""}</td>
        <td>${esc(t.assignee_name ?? "—")}</td>
        <td>${statusPill(t)}</td>
        <td class="nowrap">${esc(t.due_label ?? "—")}</td>
        <td class="nowrap">${esc(t.created_label)}</td>
      </tr>`,
    )
    .join("");
}

export function renderReportHtml(r: DeptReport, csvUrl: string | null): string {
  const open = r.now.pending + r.now.in_progress;
  // ตารางเดียวจบ เรียงจากของที่ต้องทำก่อน ไปหาของที่จบไปแล้ว — สถานะบนแถวเป็นตัวแยกให้เอง
  const all = [...r.open_tickets, ...r.closed_tickets, ...r.cancelled_tickets];

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>สรุปงาน ${esc(r.department_name)} ${esc(r.range_label)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anuphan:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --ground:#F1F1EF;--card:#FFFFFF;--line:#E7E8E6;--line-soft:#F0F1EF;
    --ink:#16181A;--mid:#5D6470;--muted:#8A9099;
    --ok:#1A7F45;--ok-bg:#E8F6EE;--late:#B42318;--late-bg:#FDECEC;
    --wait:#B54708;--wait-bg:#FEF4E6;--run:#1C56B8;--run-bg:#E9F0FD;--off-bg:#F1F2F4;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Anuphan',system-ui,-apple-system,'Segoe UI',sans-serif;background:var(--ground);
    color:var(--ink);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1120px;margin:0 auto;padding:26px 22px 60px;display:flex;flex-direction:column;gap:16px}
  .mono{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:12.5px}
  .nowrap{white-space:nowrap}

  /* หัวเรื่อง */
  .top{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;flex-wrap:wrap}
  h1{font-size:21px;font-weight:700;letter-spacing:-.01em;line-height:1.3}
  .sub{font-size:13px;color:var(--mid);margin-top:2px}
  .acts{display:flex;gap:8px}
  .acts a,.acts button{font-family:inherit;font-size:13px;font-weight:600;padding:9px 15px;border-radius:9px;
    border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;text-decoration:none;
    display:inline-flex;align-items:center;gap:7px;line-height:1}
  .acts button{background:var(--ink);color:#fff;border-color:var(--ink)}

  /* ตัวเลขภาพรวม */
  .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
  .kc{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:17px 19px 16px;min-width:0}
  .kl{font-size:12.5px;color:var(--mid);line-height:1.4}
  .kv{font-size:31px;font-weight:700;letter-spacing:-.025em;line-height:1.2;margin-top:5px;
    font-variant-numeric:tabular-nums}
  .kn{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.4}
  .kn.bad{color:var(--late);font-weight:600}
  .kn.good{color:var(--ok);font-weight:600}

  /* ตาราง */
  .panel{background:var(--card);border:1px solid var(--line);border-radius:13px;overflow:hidden}
  .ph{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:16px 19px;flex-wrap:wrap}
  .ph h2{font-size:15px;font-weight:600}
  .ph .cnt{font-size:12.5px;color:var(--muted);font-weight:400;margin-left:6px}
  .find{font-family:inherit;font-size:13px;padding:8px 13px;border-radius:9px;border:1px solid var(--line);
    background:var(--card);color:var(--ink);outline:none;width:210px;max-width:45vw}
  .find:focus{border-color:var(--mid)}
  .scroll{overflow-x:auto}
  /* กว้างพอให้ทุกคอลัมน์ได้ที่ของตัวเองจริง ๆ แล้วให้เลื่อนแนวนอนเอาบนจอแคบ
     ถ้าตั้งไว้แคบกว่านี้ คอลัมน์ "เรื่องที่แจ้ง" จะถูกบีบจนตัวหนังสือตกบรรทัดทีละคำ */
  table{width:100%;border-collapse:collapse;font-size:13px;min-width:1020px}
  th,td{text-align:left;padding:12px 19px;vertical-align:top}
  th{font-size:11.5px;font-weight:600;color:var(--mid);background:#FAFAF9;
    border-top:1px solid var(--line);border-bottom:1px solid var(--line);white-space:nowrap}
  td{border-bottom:1px solid var(--line-soft)}
  tbody tr:last-child td{border-bottom:0}
  /* กำหนดความกว้างของคอลัมน์ที่คาดเดาได้ แล้วปล่อยให้คอลัมน์ "เรื่องที่แจ้ง" กินที่เหลือ
     ไม่งั้นเบราว์เซอร์จะเฉลี่ยความกว้างเอง แล้วชื่อคนกับสถานที่ถูกบีบจนตกบรรทัดทุกแถว */
  th:nth-child(1),td:nth-child(1){width:112px}
  th:nth-child(3),td:nth-child(3){width:126px}
  th:nth-child(4),td:nth-child(4){width:140px}
  th:nth-child(5),td:nth-child(5){width:128px}
  th:nth-child(6),td:nth-child(6){width:168px}
  th:nth-child(7),td:nth-child(7){width:88px}
  td .d{font-weight:500;line-height:1.45}
  /* ความเร่งด่วนขึ้นเฉพาะเรื่องที่ไม่ใช่ระดับปกติ — ส่วนใหญ่เป็นปกติ ถ้าเขียนทุกแถวจะกลายเป็นเสียงรบกวน
     ที่กลบเรื่องที่ด่วนจริงจนมองไม่เห็น */
  td .s{font-size:11.5px;color:var(--muted);margin-top:1px;line-height:1.4}
  td .s b{font-weight:600;color:var(--wait)}
  .p{display:inline-block;font-size:11.5px;font-weight:600;padding:3px 10px;border-radius:20px;white-space:nowrap}
  .p.ok{background:var(--ok-bg);color:var(--ok)}
  .p.late{background:var(--late-bg);color:var(--late)}
  .p.wait{background:var(--wait-bg);color:var(--wait)}
  .p.run{background:var(--run-bg);color:var(--run)}
  .p.off{background:var(--off-bg);color:var(--mid)}
  .none{padding:34px 19px;text-align:center;color:var(--muted);font-size:13px}

  .foot{font-size:11.5px;color:var(--muted);line-height:1.7;padding:0 2px}

  @media (max-width:860px){
    .kpis{grid-template-columns:1fr 1fr}
    .kv{font-size:27px}
  }
  @media (max-width:520px){
    .wrap{padding:18px 13px 40px}
    .kpis{gap:10px}
    .kc{padding:13px 15px}
    th,td{padding:11px 14px}
  }
  @media print{
    body{background:#fff}
    .wrap{max-width:none;padding:0;gap:12px}
    .acts,.find{display:none}
    .panel,.kc{border-color:#D8DAD8}
    tr,.kc{break-inside:avoid}
    thead{display:table-header-group}
    table{min-width:0;font-size:11px}
    th,td{padding:7px 8px}
    @page{size:A4 landscape;margin:12mm}
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="top">
    <div>
      <h1>${esc(r.department_name)}</h1>
      <div class="sub">สรุปงาน${esc(r.period_title)} · ${esc(r.range_label)}${r.ongoing ? " (ถึงปัจจุบัน)" : ""} · ออกรายงาน ${esc(r.generated_label)}</div>
    </div>
    <div class="acts">
      ${csvUrl ? `<a href="${esc(csvUrl)}">ส่งออก CSV</a>` : ""}
      <button onclick="window.print()">พิมพ์ / บันทึก PDF</button>
    </div>
  </div>

  <div class="kpis">
    ${card(r.flow.created, "แจ้งเข้ามาในช่วงนี้", r.flow.cancelled > 0 ? `ยกเลิก ${r.flow.cancelled} เรื่อง` : " ")}
    ${card(r.flow.completed, "ปิดจบไปแล้ว", r.flow.created ? `${Math.round((r.flow.completed / r.flow.created) * 100)}% ของที่แจ้งเข้ามา` : " ", "good")}
    ${card(open, "ยังค้างอยู่ตอนนี้", r.now.pending > 0 ? `ยังไม่มีผู้รับ ${r.now.pending} เรื่อง` : "มีผู้รับผิดชอบครบแล้ว", r.now.pending > 0 ? "bad" : "good")}
    ${card(r.now.overdue, "เลยกำหนดที่แจ้งไว้", r.now.overdue > 0 ? "ต้องตามด่วน" : "ไม่มีงานเลยกำหนด", r.now.overdue > 0 ? "bad" : "good")}
  </div>

  <div class="panel">
    <div class="ph">
      <h2>รายการงานทั้งหมด<span class="cnt">${all.length} เรื่อง</span></h2>
      <input class="find" id="find" type="search" placeholder="ค้นหาเลขที่ เรื่อง หรือชื่อ" autocomplete="off">
    </div>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>เลขที่</th><th>เรื่องที่แจ้ง</th><th>สถานที่</th>
          <th>ผู้รับผิดชอบ</th><th>สถานะ</th><th>กำหนดเสร็จ</th><th>วันที่แจ้ง</th>
        </tr></thead>
        <tbody id="rows">${rows(all)}</tbody>
      </table>
      ${all.length === 0 ? '<div class="none">ไม่มีรายการในช่วงนี้</div>' : ""}
    </div>
  </div>

  <p class="foot">
    ระบบแจ้งปัญหาภายในออฟฟิศ (Horizon Report System) · ตัวเลขคำนวณจากข้อมูลจริงในระบบ ณ เวลาที่เปิดหน้านี้<br>
    เอกสารนี้มีข้อมูลภายในองค์กร โปรดใช้เท่าที่จำเป็น
  </p>

</div>
<script>
  // ค้นหาแบบซ่อนแถวที่ไม่ตรง — ตารางยาวหลายสิบแถวหาเรื่องเดียวด้วยตาไม่ไหว
  var box = document.getElementById("find"), body = document.getElementById("rows");
  if (box && body) box.addEventListener("input", function () {
    var q = box.value.trim().toLowerCase();
    for (var i = 0; i < body.rows.length; i++) {
      var row = body.rows[i];
      row.style.display = !q || row.textContent.toLowerCase().indexOf(q) !== -1 ? "" : "none";
    }
  });
</script>
</body>
</html>`;
}

/** ข้อมูลดิบสำหรับเอาไปทำต่อในตารางคำนวณ — หนึ่งบรรทัดต่อหนึ่งเรื่อง */
export function renderReportCsv(r: DeptReport): string {
  const head = [
    "เลขที่เรื่อง", "กลุ่ม", "สถานะ", "ประเภท", "ความเร่งด่วน", "ชั้น", "จุดที่เกิดเหตุ",
    "รายละเอียด", "ผู้แจ้ง", "ผู้รับผิดชอบ", "วันที่แจ้ง", "กำหนดเสร็จ", "อายุเรื่อง (วัน)",
    "เลยกำหนด (วัน)", "รออะไหล่", "อาการที่พบ",
  ];
  const out: string[][] = [];
  const push = (group: string, list: ReportTicket[]) => {
    for (const t of list) {
      out.push([
        t.ticket_no, group, t.status_label, t.category_label,
        URGENCY_LABEL[t.urgency] ?? t.urgency, t.floor, t.location_note ?? "",
        t.detail, t.reporter_name, t.assignee_name ?? "", t.created_label, t.due_label ?? "",
        String(t.age_days), String(t.overdue_days), t.waiting_parts ? "ใช่" : "", t.assessment ?? "",
      ]);
    }
  };
  push("ยังค้าง", r.open_tickets);
  push("ปิดจบในช่วงนี้", r.closed_tickets);
  push("ยกเลิกในช่วงนี้", r.cancelled_tickets);

  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  // BOM นำหน้า — ไม่งั้น Excel บนวินโดวส์เปิดไฟล์แล้วภาษาไทยกลายเป็นตัวขยะ
  return "﻿" + [head, ...out].map((line) => line.map(cell).join(",")).join("\r\n") + "\r\n";
}
