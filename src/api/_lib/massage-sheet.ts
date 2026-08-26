// ฟอร์มเช็คชื่อคิวนวด — ข้อมูลของวันหนึ่ง และหน้าเว็บที่สั่งพิมพ์ลง A4 ได้พอดี
//
// ทำเป็นหน้าเว็บที่ให้เบราว์เซอร์พิมพ์ ไม่ใช่สร้างไฟล์ PDF จากเซิร์ฟเวอร์ เพราะการสร้าง PDF
// ภาษาไทยต้องฝังฟอนต์และต้องวางสระกับวรรณยุกต์เอง ซึ่งไลบรารีที่รันบน Cloudflare Workers ได้
// ยังทำไม่ถูก (สระลอยผิดตำแหน่ง) ปล่อยให้เบราว์เซอร์เป็นคนจัดวาง ภาษาไทยจึงถูกต้องเสมอ
// เป็นวิธีเดียวกับหน้าสรุปงานของระบบแจ้งปัญหา
//
// หน้านี้อ่านอย่างเดียว การกด มา/ไม่มา อยู่ในแอปที่ล็อกอินแล้วเท่านั้น เพราะหน้านี้เปิดได้
// ด้วยลิงก์ที่เซ็นกำกับโดยไม่ต้องล็อกอิน จะให้แก้ข้อมูลจากตรงนี้ไม่ได้

import { db } from "./db";
import { MASSAGE_SLOTS, activeTherapists, slotLabel, thaiDayLabel, type Therapist } from "./massage";

export interface SheetCell {
  bookingId: string | null;
  name: string | null;
  dept: string | null;
  /** present | no_show | null = ยังไม่ได้เช็ค */
  attended: string | null;
}

export interface SheetRow {
  slot: string;
  label: string;
  cells: SheetCell[];
}

export interface CheckSheet {
  day: string;
  label: string;
  therapists: Therapist[];
  rows: SheetRow[];
  booked: number;
  total: number;
  present: number;
  noShow: number;
}

/**
 * ตารางของวันหนึ่งพร้อมชื่อจริงตามทะเบียนพนักงาน
 *
 * ใช้ full_name ของ employees ไม่ใช่ชื่อที่ตั้งไว้ในไลน์ — ชื่อในไลน์เป็นชื่อเล่นหรืออีโมจิได้
 * และเจ้าตัวเปลี่ยนเมื่อไหร่ก็ได้ ฟอร์มเช็คชื่อต้องใช้ชื่อที่ตรงกับทะเบียนพนักงาน
 */
export async function buildSheet(day: string): Promise<CheckSheet> {
  const therapists = await activeTherapists();

  const rows = await db()<
    {
      id: string;
      slot: string;
      therapist_id: string;
      attended: string | null;
      full_name: string;
      dept: string | null;
    }[]
  >`
    SELECT b.id, to_char(b.slot_start, 'HH24:MI') AS slot, b.therapist_id, b.attended,
           e.full_name, COALESCE(d.name, e.department_name) AS dept
    FROM massage_bookings b
    JOIN employees e ON e.id = b.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    WHERE b.day = ${day}::date AND b.status = 'booked'
  `;

  const byCell = new Map(rows.map((r) => [`${r.slot}|${r.therapist_id}`, r]));

  return {
    day,
    label: thaiDayLabel(day),
    therapists,
    rows: MASSAGE_SLOTS.map((slot) => ({
      slot,
      label: slotLabel(slot),
      cells: therapists.map((t) => {
        const r = byCell.get(`${slot}|${t.id}`);
        return {
          bookingId: r?.id ?? null,
          name: r?.full_name ?? null,
          dept: r?.dept ?? null,
          attended: r?.attended ?? null,
        };
      }),
    })),
    booked: rows.length,
    total: MASSAGE_SLOTS.length * therapists.length,
    present: rows.filter((r) => r.attended === "present").length,
    noShow: rows.filter((r) => r.attended === "no_show").length,
  };
}

function esc(v: unknown): string {
  return String(v ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

function cell(c: SheetCell): string {
  if (!c.name) return `<td class="free">ว่าง</td>`;
  const mark =
    c.attended === "present"
      ? `<span class="chk on">มาแล้ว</span>`
      : c.attended === "no_show"
        ? `<span class="chk no">ไม่มา</span>`
        : `<span class="box"></span>`;
  return `<td>
    <div class="nm">${esc(c.name)}</div>
    ${c.dept ? `<div class="dp">${esc(c.dept)}</div>` : ""}
    ${mark}
  </td>`;
}

/**
 * หน้าฟอร์มพร้อมพิมพ์
 *
 * เรื่องที่ต้องรู้ก่อนแก้ CSS ตรงนี้ (ได้มาจากการวัดจริงตอนทำหน้าสรุปงาน):
 *   - ตอนพิมพ์ Chromium จัดหน้าที่ความกว้างประมาณ 816px เสมอ ไม่ใช่ความกว้างกระดาษ
 *     การทดสอบด้วยการย่อหน้าต่างเบราว์เซอร์จึงไม่ได้บอกอะไรเลย
 *   - table-layout: fixed + ความกว้างเป็นเปอร์เซ็นต์ ทำให้ตารางพอดีหน้ากระดาษทุกขนาด
 *   - overflow: auto/hidden จะ "ตัด" เนื้อหาบนกระดาษ เพราะกระดาษไม่มีแถบเลื่อน
 *   - print-color-adjust: exact บังคับให้พื้นหลังพิมพ์ออกมาด้วย แม้ปิด "กราฟิกพื้นหลัง"
 */
export function renderSheetHtml(s: CheckSheet, autoPrint = true): string {
  const head = s.therapists.map((t) => `<th>${esc(t.name)}</th>`).join("");
  const body = s.rows
    .map(
      (r, i) =>
        `${i === 4 ? `<tr class="brk"><td colspan="${s.therapists.length + 1}">พักกลางวัน 12:00 – 13:00</td></tr>` : ""}
      <tr><td class="tm">${esc(r.label)}</td>${r.cells.map(cell).join("")}</tr>`,
    )
    .join("");

  const w = Math.floor(88 / Math.max(1, s.therapists.length));

  return `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ฟอร์มเช็คชื่อคิวนวด · ${esc(s.label)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anuphan:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root{--ink:#101418;--slate:#5B6672;--line:#D8DAD8;--green:#0B7A3E;--alert:#B0331B;--soft:#F4F6F5}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Anuphan',system-ui,sans-serif;color:var(--ink);background:#EDF0F3;padding:20px}
.sheet{max-width:1040px;margin:0 auto;background:#fff;border-radius:12px;padding:22px 24px 26px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;
  padding-bottom:14px;border-bottom:2px solid var(--ink);margin-bottom:16px}
h1{font-size:19px;font-weight:600;line-height:1.35}
.sub{font-size:13px;color:var(--slate);margin-top:3px}
.tally{display:flex;gap:18px;text-align:right}
.tally div{font-size:11.5px;color:var(--slate);line-height:1.5}
.tally b{display:block;font-size:20px;color:var(--ink);font-weight:600;
  font-family:'IBM Plex Mono',monospace}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th,td{border:1px solid var(--line);padding:7px 8px;vertical-align:top;text-align:left}
th{background:var(--soft);font-size:11.5px;font-weight:600;text-align:center;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
th:first-child,td.tm{width:12%}
th:not(:first-child),td:not(.tm){width:${w}%}
td.tm{font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:var(--slate);
  white-space:nowrap;vertical-align:middle}
td{height:46px}
.nm{font-size:12.5px;font-weight:600;line-height:1.35}
.dp{font-size:10.5px;color:var(--slate);line-height:1.4;margin-top:1px}
.free{color:#AAB3BB;font-size:11px;text-align:center;vertical-align:middle}
.box{display:inline-block;width:15px;height:15px;border:1.5px solid #9AA4AE;border-radius:3px;margin-top:5px}
.chk{display:inline-block;font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:20px;margin-top:4px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.chk.on{background:#E6F8ED;color:var(--green)}
.chk.no{background:#FBE6E1;color:var(--alert)}
tr.brk td{background:var(--soft);text-align:center;font-size:11px;color:var(--slate);
  letter-spacing:.08em;height:auto;padding:5px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.foot{display:flex;justify-content:space-between;gap:20px;margin-top:16px;
  font-size:11px;color:var(--slate);line-height:1.6}
.sign{border-top:1px solid var(--line);padding-top:5px;min-width:190px;text-align:center}
.bar{max-width:1040px;margin:0 auto 14px;display:flex;justify-content:flex-end}
button{font-family:inherit;font-size:13px;font-weight:600;color:#fff;background:#06C755;
  border:0;border-radius:10px;padding:10px 20px;cursor:pointer}
@media print{
  @page{size:A4 landscape;margin:10mm}
  body{background:#fff;padding:0}
  .sheet{max-width:none;border-radius:0;padding:0}
  .bar{display:none}
  table{font-size:11px}
  td{height:44px}
}
</style></head><body>
<div class="bar"><button onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button></div>
<div class="sheet">
  <div class="top">
    <div>
      <h1>ฟอร์มเช็คชื่อคิวนวด</h1>
      <div class="sub">${esc(s.label)}</div>
    </div>
    <div class="tally">
      <div><b>${s.booked}</b>จองแล้ว</div>
      <div><b>${s.total - s.booked}</b>ว่าง</div>
      <div><b>${s.present}</b>มาแล้ว</div>
      <div><b>${s.noShow}</b>ไม่มา</div>
    </div>
  </div>
  <table><thead><tr><th>รอบเวลา</th>${head}</tr></thead><tbody>${body}</tbody></table>
  <div class="foot">
    <div>ช่องสี่เหลี่ยมคือคิวที่ยังไม่ได้เช็ค · ติ๊กเมื่อผู้จองมาถึง<br>
      กด มา / ไม่มา ในแอปได้เช่นกัน ตัวเลขด้านบนจะอัปเดตทันที</div>
    <div class="sign">ผู้ตรวจสอบ</div>
  </div>
</div>
${autoPrint ? `<script>addEventListener("load",function(){(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){setTimeout(function(){window.print()},250)})})</script>` : ""}
</body></html>`;
}
