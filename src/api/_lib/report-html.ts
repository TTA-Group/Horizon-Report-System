// หน้ารายงานสรุปงาน — ไฟล์เดียวจบ เปิดในเบราว์เซอร์ไหนก็ได้ และสั่งพิมพ์เป็น PDF ได้เลย
//
// ทำเป็นหน้าเว็บไม่ใช่ PDF เพราะ Worker สร้าง PDF ไม่ได้ถ้าไม่ลงไลบรารีหนัก ๆ และหน้าเว็บ
// ได้ประโยชน์มากกว่า: ส่งลิงก์ให้ผู้บริหารเปิดจากมือถือได้ทันที หรือกด Ctrl+P บันทึกเป็น PDF
// แนบอีเมลก็ได้ — ได้ทั้งสองอย่างจากไฟล์เดียว
//
// ทุกอย่างอยู่ในไฟล์เดียว (CSS ฝังในหน้า ไม่มีสคริปต์) เพื่อให้เปิดได้แม้ตอนที่เครือข่ายบริษัท
// บล็อกแหล่งภายนอก และเพื่อให้บันทึกหน้าเว็บเก็บไว้แล้วยังหน้าตาเหมือนเดิม

import type { BreakdownRow, DeptReport, PersonRow, ReportTicket } from "./reports";

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

/** ชั่วโมงเป็นคำที่คนอ่านเข้าใจทันที — "18 ชม." อ่านง่ายกว่า "0.75 วัน" */
function hoursLabel(h: number | null): string {
  if (h === null || !isFinite(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)} นาที`;
  if (h < 48) return `${h.toFixed(1)} ชม.`;
  const days = Math.floor(h / 24);
  const rest = Math.round(h - days * 24);
  return rest > 0 ? `${days} วัน ${rest} ชม.` : `${days} วัน`;
}

function pct(part: number, whole: number): string {
  if (!whole) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

// สีของระดับความเร่งด่วน — คู่เหลือง/แดงถูกเลือกให้ต่างกันพอสำหรับตาที่แยกสีแดง-เขียวไม่ออก
// (ตรวจด้วยเครื่องมือวัดระยะสีแล้ว) และทุกป้ายมีตัวหนังสือกำกับเสมอ ไม่ได้ใช้สีอย่างเดียวบอกความหมาย
const URGENCY_CLASS: Record<string, string> = { normal: "u-n", urgent: "u-u", critical: "u-c" };
const URGENCY_LABEL: Record<string, string> = { normal: "ปกติ", urgent: "เร่งด่วน", critical: "เร่งด่วนมาก" };

/**
 * บรรทัดเดียวที่ตอบว่าช่วงนี้เป็นยังไง — สำหรับคนที่อ่านแค่บรรทัดแรกแล้วปิด
 * ผู้บริหารส่วนใหญ่อ่านแค่นี้ ตัวเลขที่เหลือคือของที่เอาไว้ให้ถามต่อได้
 */
function headline(r: DeptReport): string {
  const open = r.now.pending + r.now.in_progress;
  const parts = [
    `ช่วงนี้แจ้งเข้ามา ${r.flow.created} เรื่อง ปิดจบไปแล้ว ${r.flow.completed} เรื่อง`,
    open > 0 ? `ยังค้างอยู่ ${open} เรื่อง` : "ไม่มีงานค้าง",
  ];
  const alerts: string[] = [];
  if (r.now.overdue > 0) alerts.push(`เลยกำหนดแล้ว ${r.now.overdue}`);
  if (r.now.pending > 0) alerts.push(`ยังไม่มีผู้รับ ${r.now.pending}`);
  if (alerts.length > 0) parts.push(`ในจำนวนนี้ ${alerts.join(" และ ")} เรื่อง`);
  return parts.join(" · ");
}

function tile(value: string, label: string, tone = "", note = ""): string {
  return `<div class="tile ${tone}">
    <div class="v">${esc(value)}</div>
    <div class="l">${esc(label)}</div>
    ${note ? `<div class="n">${esc(note)}</div>` : ""}
  </div>`;
}

/**
 * แถบเทียบปริมาณ — ชุดข้อมูลเดียว (จำนวนเรื่องที่เข้ามาในช่วงนี้) จึงใช้สีเดียวทั้งชุด
 * ไม่ต้องมีคำอธิบายสี และติดตัวเลขไว้ท้ายแถบทุกแถวเพราะมีไม่เกินสิบกว่าแถว
 * อ่านค่าได้จากตัวเลขตรง ๆ ไม่ต้องกะจากความยาว
 */
function bars(rows: BreakdownRow[], emptyText: string): string {
  if (rows.length === 0) return `<p class="empty">${esc(emptyText)}</p>`;
  const max = Math.max(...rows.map((r) => r.total), 1);
  return `<div class="bars">${rows
    .map(
      (r) => `<div class="bar">
        <div class="bl">${esc(r.label)}</div>
        <div class="bt">${r.total > 0 ? `<span style="width:${((r.total / max) * 100).toFixed(1)}%"></span>` : ""}</div>
        <div class="bv">${r.total}</div>
        <div class="bo">${r.open > 0 ? `ค้าง ${r.open}` : ""}</div>
      </div>`,
    )
    .join("")}</div>`;
}

function peopleTable(rows: PersonRow[]): string {
  if (rows.length === 0) return `<p class="empty">ยังไม่มีงานที่มีผู้รับผิดชอบในช่วงนี้</p>`;
  return `<table>
    <thead><tr>
      <th>ผู้รับผิดชอบ</th><th class="r">ปิดได้</th><th class="r">ค้างอยู่</th>
      <th class="r">เลยกำหนด</th><th class="r">ตรงกำหนด</th><th class="r">เวลาปิดเฉลี่ย</th>
    </tr></thead>
    <tbody>${rows
      .map(
        (p) => `<tr>
          <td>${esc(p.name)}</td>
          <td class="r n">${p.closed}</td>
          <td class="r n">${p.open}</td>
          <td class="r n ${p.overdue > 0 ? "bad" : ""}">${p.overdue}</td>
          <td class="r n">${p.due_closed ? `${pct(p.on_time, p.due_closed)} <small>(${p.on_time}/${p.due_closed})</small>` : "—"}</td>
          <td class="r n">${esc(hoursLabel(p.avg_close_hours))}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function ticketTable(rows: ReportTicket[], kind: "open" | "closed" | "cancelled", emptyText: string): string {
  if (rows.length === 0) return `<p class="empty">${esc(emptyText)}</p>`;
  const lastHead = kind === "open" ? "กำหนดเสร็จ" : kind === "closed" ? "ผู้รับผิดชอบ" : "ผู้รับผิดชอบ";
  return `<table class="tk">
    <thead><tr>
      <th>เลขที่</th><th>เรื่อง</th><th>สถานที่</th>
      ${kind === "open" ? "<th>ผู้รับผิดชอบ</th><th class='r'>ค้างมา</th>" : "<th>ผู้แจ้ง</th>"}
      <th>${esc(lastHead)}</th>
    </tr></thead>
    <tbody>${rows
      .map((t) => {
        const late = t.overdue_days > 0 && kind === "open";
        return `<tr class="${late ? "late" : ""}">
          <td class="n nowrap">${esc(t.ticket_no)}</td>
          <td>
            <div class="d">${esc(t.detail)}</div>
            <div class="sub"><span class="ub ${URGENCY_CLASS[t.urgency] ?? "u-n"}">${esc(URGENCY_LABEL[t.urgency] ?? t.urgency)}</span> ${esc(t.category_label)}${
              t.waiting_parts ? ' <span class="ub u-u">รออะไหล่</span>' : ""
            }${t.status === "pending" ? ' <span class="ub u-c">ยังไม่มีผู้รับ</span>' : ""}</div>
          </td>
          <td>${esc(t.floor)}${t.location_note ? "<br><small>" + esc(t.location_note) + "</small>" : ""}</td>
          ${
            kind === "open"
              ? `<td>${esc(t.assignee_name ?? "—")}</td><td class="r n ${late ? "bad" : ""}">${t.age_days} วัน</td>`
              : `<td>${esc(t.reporter_name)}</td>`
          }
          <td>${
            kind === "open"
              ? t.due_label
                ? `${esc(t.due_label)}${late ? `<br><small class="bad">เลยมา ${t.overdue_days} วัน</small>` : ""}`
                : '<small class="bad">ยังไม่แจ้งกำหนด</small>'
              : esc(t.assignee_name ?? "—")
          }</td>
        </tr>`;
      })
      .join("")}</tbody>
  </table>`;
}

export function renderReportHtml(r: DeptReport, csvUrl: string | null): string {
  const kpi = r.kpi;
  const openTotal = r.now.pending + r.now.in_progress;

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>สรุปงาน ${esc(r.department_name)} ${esc(r.period_title)} ${esc(r.range_label)}</title>
<style>
  :root{
    --ink:#15201B;--slate:#5B6672;--muted:#8A94A0;--line:#DDE3E9;--soft:#F4F6F8;
    --paper:#FFFFFF;--bar:#2C6BE0;--good:#04A045;--warn:#B7791F;--bad:#B3261E;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:'Anuphan','Noto Sans Thai',system-ui,-apple-system,'Segoe UI',sans-serif;
    background:#EDF0F3;color:var(--ink);font-size:14px;line-height:1.6;
    -webkit-font-smoothing:antialiased;
  }
  .sheet{max-width:940px;margin:0 auto;background:var(--paper);padding:34px 38px 48px}
  .num,.n,.v,td.n,th.r{font-variant-numeric:tabular-nums}

  /* หัวรายงาน */
  header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;
    border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:26px;flex-wrap:wrap}
  .who{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--slate);font-weight:600}
  h1{font-size:25px;line-height:1.25;font-weight:700;margin:4px 0 2px;letter-spacing:-.01em}
  .range{font-size:14px;color:var(--slate)}
  .range b{color:var(--ink);font-weight:600}
  .lede{font-size:14.5px;line-height:1.65;margin-top:9px;max-width:62ch;
    padding-left:11px;border-left:3px solid var(--bar)}
  .stamp{font-size:12px;color:var(--muted);text-align:right;white-space:nowrap}
  .tools{display:flex;gap:8px;margin-top:10px;justify-content:flex-end}
  .tools a,.tools button{font-family:inherit;font-size:12px;font-weight:600;padding:7px 14px;border-radius:8px;
    border:1.5px solid var(--ink);background:#fff;color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}

  h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--slate);
    font-weight:600;margin:30px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  h2:first-of-type{margin-top:0}
  .hint{font-size:12px;color:var(--muted);margin:-6px 0 12px}

  /* ตัวเลขสรุป */
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px}
  .tile{border:1px solid var(--line);border-radius:10px;padding:13px 14px;background:var(--paper);min-width:0}
  .tile .v{font-size:27px;font-weight:700;line-height:1.15;letter-spacing:-.02em}
  .tile .l{font-size:12px;color:var(--slate);margin-top:2px;line-height:1.4}
  .tile .n{font-size:11px;color:var(--muted);margin-top:3px}
  .tile.good{background:#F0FAF4;border-color:#BFE6D0}.tile.good .v{color:var(--good)}
  .tile.warn{background:#FDF6EA;border-color:#EBD9B4}.tile.warn .v{color:var(--warn)}
  .tile.bad{background:#FCEFEE;border-color:#EFC9C5}.tile.bad .v{color:var(--bad)}

  /* แถบเทียบปริมาณ */
  .split{display:grid;grid-template-columns:1fr 1fr;gap:26px}
  .bars{display:flex;flex-direction:column;gap:7px}
  .bar{display:grid;grid-template-columns:minmax(90px,34%) 1fr 34px 56px;align-items:center;gap:9px}
  .bl{font-size:12.5px;line-height:1.35;min-width:0;overflow-wrap:anywhere}
  .bt{height:11px;background:var(--soft);border-radius:6px;overflow:hidden}
  .bt span{display:block;height:100%;background:var(--bar);border-radius:6px;min-width:3px}
  .bv{font-size:13px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
  .bo{font-size:11px;color:var(--warn);white-space:nowrap}

  /* ตาราง */
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;letter-spacing:.05em;color:var(--slate);background:var(--soft);font-weight:600;
    text-transform:uppercase;border-bottom:1px solid var(--line)}
  th.r,td.r{text-align:right}
  tbody tr:last-child td{border-bottom:0}
  tr.late{background:#FDF4F3}
  td.n{font-variant-numeric:tabular-nums}
  td .d{font-weight:600;line-height:1.4}
  td .sub{font-size:11px;color:var(--muted);margin-top:2px}
  td small{font-size:11px;color:var(--muted)}
  .bad{color:var(--bad)}
  .nowrap{white-space:nowrap}
  .empty{font-size:13px;color:var(--muted);padding:14px 0}

  .ub{display:inline-block;font-size:10px;font-weight:700;padding:1px 7px;border-radius:9px;
    border:1px solid currentColor;line-height:1.5}
  .u-n{color:var(--slate)}.u-u{color:var(--warn)}.u-c{color:var(--bad)}

  footer{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);
    font-size:11px;color:var(--muted);line-height:1.7}

  @media (max-width:720px){
    .sheet{padding:22px 16px 34px}
    .split{grid-template-columns:1fr;gap:18px}
    .bar{grid-template-columns:minmax(76px,40%) 1fr 30px;gap:7px}
    .bo{display:none}
    table{font-size:12px}
    th,td{padding:7px 6px}
  }
  @media print{
    body{background:#fff}
    .sheet{max-width:none;padding:0}
    .tools{display:none}
    h2{break-after:avoid}
    table,.tiles,.bars{break-inside:auto}
    tr,.tile,.bar{break-inside:avoid}
    thead{display:table-header-group}
    @page{size:A4;margin:14mm}
  }
</style>
</head>
<body>
<div class="sheet">

<header>
  <div>
    <div class="who">Horizon Report · สรุปงาน${esc(r.period_title)}</div>
    <h1>${esc(r.department_name)}</h1>
    <div class="range">ช่วง <b>${esc(r.range_label)}</b>${r.ongoing ? " (ช่วงนี้ยังไม่จบ ตัวเลขคือยอดถึงปัจจุบัน)" : ""}</div>
    <p class="lede">${esc(headline(r))}</p>
  </div>
  <div>
    <div class="stamp">ออกรายงาน ${esc(r.generated_label)}</div>
    <div class="tools">
      <button onclick="window.print()">พิมพ์ / บันทึก PDF</button>
      ${csvUrl ? `<a href="${esc(csvUrl)}">ดาวน์โหลด CSV</a>` : ""}
    </div>
  </div>
</header>

<h2>เกิดอะไรขึ้นในช่วงนี้</h2>
<div class="tiles">
  ${tile(String(r.flow.created), "เรื่องที่แจ้งเข้ามา")}
  ${tile(String(r.flow.completed), "ปิดจบไปแล้ว", "good")}
  ${tile(String(r.flow.cancelled), "ยกเลิก")}
  ${tile(
    r.flow.created ? pct(r.flow.completed, r.flow.created) : "—",
    "สัดส่วนที่ปิดได้",
    r.flow.created && r.flow.completed >= r.flow.created ? "good" : "",
    "เทียบกับที่แจ้งเข้ามาในช่วงเดียวกัน",
  )}
</div>

<h2>ค้างอยู่ ณ วันที่ออกรายงาน</h2>
<p class="hint">ภาพนิ่งของตอนนี้ รวมเรื่องที่ค้างมาตั้งแต่ก่อนช่วงรายงานด้วย</p>
<div class="tiles">
  ${tile(String(openTotal), "งานที่ยังไม่จบ", openTotal > 0 ? "warn" : "good")}
  ${tile(String(r.now.pending), "ยังไม่มีผู้รับเรื่อง", r.now.pending > 0 ? "bad" : "")}
  ${tile(String(r.now.overdue), "เลยกำหนดที่แจ้งไว้", r.now.overdue > 0 ? "bad" : "")}
  ${tile(String(r.now.not_assessed), "รับแล้วแต่ยังไม่แจ้งผล", r.now.not_assessed > 0 ? "warn" : "")}
  ${tile(String(r.now.waiting_parts), "รออะไหล่ / ผู้รับเหมา", r.now.waiting_parts > 0 ? "warn" : "")}
  ${tile(kpi.oldest_open_days ? `${kpi.oldest_open_days} วัน` : "—", "เรื่องที่ค้างนานที่สุด", kpi.oldest_open_days >= 30 ? "bad" : "")}
</div>

<h2>ตัวชี้วัด</h2>
<div class="tiles">
  ${tile(hoursLabel(kpi.ack_hours), "เวลาเฉลี่ยกว่าจะมีคนรับเรื่อง", "", kpi.ack_base ? `จาก ${kpi.ack_base} เรื่องที่แจ้งเข้ามาในช่วงนี้` : "ยังไม่มีเรื่องเข้ามาในช่วงนี้")}
  ${tile(hoursLabel(kpi.close_hours), "เวลาเฉลี่ยตั้งแต่แจ้งจนปิดงาน", "", kpi.completed ? `จาก ${kpi.completed} เรื่องที่ปิดในช่วงนี้` : "ยังไม่มีเรื่องที่ปิดในช่วงนี้")}
  ${tile(
    pct(kpi.on_time, kpi.due_closed),
    "ปิดได้ทันกำหนดที่แจ้งไว้",
    kpi.due_closed && kpi.on_time / kpi.due_closed >= 0.8 ? "good" : kpi.due_closed ? "warn" : "",
    kpi.due_closed ? `${kpi.on_time} จาก ${kpi.due_closed} เรื่องที่มีกำหนด` : "ยังไม่มีเรื่องที่ตั้งกำหนดไว้",
  )}
  ${tile(
    pct(kpi.assessed, kpi.completed),
    "แจ้งผลตรวจสอบครบ",
    kpi.completed && kpi.assessed === kpi.completed ? "good" : kpi.completed ? "warn" : "",
    kpi.completed ? `${kpi.assessed} จาก ${kpi.completed} เรื่องที่ปิด` : "",
  )}
</div>

<h2>งานกระจุกอยู่ตรงไหน</h2>
<div class="split">
  <div>
    <p class="hint">แยกตามประเภทเรื่อง — ตัวเลขคือเรื่องที่แจ้งเข้ามาในช่วงนี้</p>
    ${bars(r.categories, "ไม่มีเรื่องในช่วงนี้")}
  </div>
  <div>
    <p class="hint">แยกตามชั้น — ตัวเลขคือเรื่องที่แจ้งเข้ามาในช่วงนี้</p>
    ${bars(r.floors, "ไม่มีเรื่องในช่วงนี้")}
  </div>
</div>

<h2>ผลงานรายบุคคล</h2>
<p class="hint">"ค้างอยู่" กับ "เลยกำหนด" เป็นภาพ ณ ตอนนี้ ส่วนคอลัมน์อื่นคิดจากงานที่ปิดในช่วงรายงาน</p>
${peopleTable(r.people)}

<h2>งานที่ยังค้าง (${r.open_tickets.length})</h2>
${ticketTable(r.open_tickets, "open", "ไม่มีงานค้าง")}

<h2>งานที่ปิดจบในช่วงนี้ (${r.closed_tickets.length})</h2>
${ticketTable(r.closed_tickets, "closed", "ยังไม่มีงานที่ปิดในช่วงนี้")}

${
  r.cancelled_tickets.length > 0
    ? `<h2>งานที่ถูกยกเลิกในช่วงนี้ (${r.cancelled_tickets.length})</h2>
${ticketTable(r.cancelled_tickets, "cancelled", "")}`
    : ""
}

<footer>
  ระบบแจ้งปัญหาภายในออฟฟิศ (Horizon Report System) · ${esc(r.department_name)} · ${esc(r.period_title)} ${esc(r.range_label)}<br>
  ตัวเลขทั้งหมดคำนวณจากข้อมูลจริงในระบบ ณ เวลาที่เปิดรายงานนี้ · เอกสารนี้มีข้อมูลภายในองค์กร โปรดใช้เท่าที่จำเป็น
</footer>

</div>
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
  const rows: string[][] = [];
  const push = (group: string, list: ReportTicket[]) => {
    for (const t of list) {
      rows.push([
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
  return "﻿" + [head, ...rows].map((r2) => r2.map(cell).join(",")).join("\r\n") + "\r\n";
}
