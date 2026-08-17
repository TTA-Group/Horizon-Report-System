// สร้าง Flex Message ของเรื่องหนึ่งใบ สำหรับส่งเข้ากลุ่มไลน์ (spec หัวข้อ 5.2 / 6)
//
// การ์ดเปลี่ยนหน้าตาตามสถานะ เพราะ LINE แก้ข้อความที่ส่งไปแล้วไม่ได้ — ทุกครั้งที่สถานะเปลี่ยน
// ระบบจะตอบการ์ดใบใหม่ลงในกลุ่ม การ์ดล่าสุดในบทสนทนาจึงเป็นตัวบอกสถานะจริงเสมอ
// (การ์ดใบเก่าที่ค้างอยู่ ถ้ามีคนย้อนไปกดปุ่ม ระบบจะตอบว่าสถานะเปลี่ยนไปแล้ว)

import type { LineMessage } from "./line";
import { STATUS_LABELS, type StatusCode, type UrgencyCode } from "./constants";

export interface TicketFlexInput {
  ticketId: string;
  ticketNo: string;
  status: StatusCode;
  departmentCode: string;
  categoryLabel: string;
  reporterName: string;
  reporterDept: string | null;
  floor: string;
  locationNote: string | null;
  detail: string;
  urgency: UrgencyCode;
  createdAtLabel: string;
  assigneeName?: string | null;
  actorName?: string | null;
  cancelReason?: string | null;
}

// สีหัวการ์ดแยกตามฝ่ายที่รับผิดชอบ — ทุกฝ่ายใช้กลุ่มไลน์เดียวกัน สีหัวจึงเป็นตัวบอกตั้งแต่แรกเห็น
// ว่าการ์ดใบนี้เป็นงานของทีมไหน ใช้โทนเดียวกับไอคอนในแอป LIFF แต่เข้มขึ้นพอให้ตัวหนังสือสีขาวอ่านออก
// (เหลืองกับเขียวสดของแอปใช้เป็นพื้นหลังตัวหนังสือขาวไม่ได้ ความต่างของสีน้อยเกินไปจนอ่านยาก)
const DEPARTMENT_COLOR: Record<string, string> = {
  IT: "#2C6BE0", // น้ำเงิน — งานคอมพิวเตอร์และระบบงาน
  ADM: "#B26A00", // เหลืองอำพันเข้ม — แอร์ ไฟ ประปา และงานแม่บ้าน
  CLN: "#05803A", // เขียวเข้ม — งานแม่บ้าน (เผื่อวันที่แยกทีมออกจากฝ่าย Admin)
  GEN: "#6B4FD8", // ม่วง — เรื่องอื่น ๆ
};
const FALLBACK_COLOR = "#5B6672";

// คำบนหัวการ์ด — เขียนให้อ่านแล้วรู้ทันทีว่าเรื่องเดินไปถึงไหน จึงไม่ใช้คำเดียวกับ STATUS_LABELS
// ที่ใช้ในข้อความแจ้งผู้แจ้ง (เช่น "ยกเลิก" คำเดียวบนหัวการ์ดอ่านเหมือนปุ่มสั่งยกเลิก)
// คำนำหน้าชื่อคนที่ทำให้สถานะเปลี่ยน — ทุกการ์ดที่เข้ากลุ่มต้องบอกได้ว่าใครเป็นคนทำ
const ACTOR_LABEL: Record<StatusCode, string> = {
  pending: "ส่งต่อโดย",
  in_progress: "รับเรื่องโดย",
  completed: "ปิดงานโดย",
  closed: "ปิดเรื่องโดย",
  cancelled: "ยกเลิกโดย",
};

const HEADER_LABEL: Record<StatusCode, string> = {
  pending: "รอรับเรื่อง",
  in_progress: "กำลังดำเนินการ",
  completed: "ดำเนินการเสร็จสิ้น",
  closed: "ปิดเรื่องแล้ว",
  cancelled: "ยกเลิกแล้ว",
};

// ระดับความเร่งด่วนใช้สัญลักษณ์กับกล่องเตือน ไม่ใช้สีหัวการ์ด เพราะสีหัวถูกใช้บอกฝ่ายไปแล้ว
const URGENCY: Record<UrgencyCode, { mark: string; label: string; color: string; soft: string; note: string | null }> = {
  normal: { mark: "⚪", label: "ปกติ", color: "#5B6672", soft: "#F1F3F5", note: null },
  urgent: { mark: "🟠", label: "เร่งด่วน", color: "#B26A00", soft: "#FBF0DA", note: "ควรรับเรื่องและดำเนินการให้เสร็จภายในวันนี้" },
  critical: { mark: "🔴", label: "เร่งด่วนมาก", color: "#C0392B", soft: "#FBE6E2", note: "กระทบการทำงาน กรุณารับเรื่องทันที" },
};

// ใช้ layout horizontal ไม่ใช่ baseline — ช่อง "รายละเอียด" ต้องตัดบรรทัดได้เมื่อข้อความยาว
// ซึ่ง baseline box ของ LINE ออกแบบมาสำหรับข้อความสั้นบรรทัดเดียว
function kv(label: string, value: string) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: [
      { type: "text", text: label, color: "#8A94A0", size: "sm", flex: 3 },
      { type: "text", text: value || "-", wrap: true, color: "#111111", size: "sm", flex: 7 },
    ],
  };
}

/** ปุ่ม "ยกเลิกเรื่อง" — เปิดแป้นพิมพ์พร้อมข้อความตั้งต้น ให้ผู้กดพิมพ์เหตุผลต่อท้ายแล้วส่ง */
function cancelButton(t: TicketFlexInput) {
  return {
    type: "button",
    style: "secondary",
    height: "sm",
    action: {
      type: "postback",
      label: "ยกเลิกเรื่อง",
      data: `action=cancel&ticket=${t.ticketId}`,
      inputOption: "openKeyboard",
      fillInText: `ยกเลิก ${t.ticketNo}: `,
    },
  };
}

// ไม่ใส่ displayText เพราะไม่อยากให้การกดปุ่มไปโพสต์ข้อความในกลุ่มอีกบรรทัด
// การ์ดใบใหม่ที่ระบบตอบกลับบอกอยู่แล้วว่าใครรับเรื่องและสถานะเปลี่ยนเป็นอะไร
function primaryButton(label: string, action: string, t: TicketFlexInput) {
  return {
    type: "button",
    style: "primary",
    height: "sm",
    color: "#06C755",
    action: {
      type: "postback",
      label,
      data: `action=${action}&ticket=${t.ticketId}`,
    },
  };
}

/** ปุ่มท้ายการ์ดตามสถานะ — สถานะที่จบแล้วไม่มีปุ่ม เหลือไว้เป็นบันทึกในกลุ่มเฉย ๆ */
function footerFor(t: TicketFlexInput): Record<string, unknown> | null {
  let buttons: unknown[];
  if (t.status === "pending") buttons = [primaryButton("รับเรื่อง", "ack", t), cancelButton(t)];
  else if (t.status === "in_progress") buttons = [primaryButton("ดำเนินการเสร็จสิ้น", "complete", t), cancelButton(t)];
  else return null;

  return { type: "box", layout: "vertical", spacing: "sm", contents: buttons };
}

/** สร้างข้อความ Flex ของ ticket หนึ่งใบตามสถานะปัจจุบัน */
export function buildTicketFlex(t: TicketFlexInput): LineMessage {
  const accent = DEPARTMENT_COLOR[t.departmentCode] ?? FALLBACK_COLOR;
  const urgency = URGENCY[t.urgency];
  const statusLabel = HEADER_LABEL[t.status] ?? STATUS_LABELS[t.status] ?? t.status;

  const rows: unknown[] = [
    kv("ผู้แจ้ง", `${t.reporterName}${t.reporterDept ? " · " + t.reporterDept : ""}`),
    kv("สถานที่", `${t.floor}${t.locationNote ? " · " + t.locationNote : ""}`),
    kv("รายละเอียด", t.detail),
    kv("วันเวลา", t.createdAtLabel),
  ];
  if (t.assigneeName) rows.push(kv("ผู้รับผิดชอบ", t.assigneeName));
  // ชื่อคนที่เพิ่งเปลี่ยนสถานะ — ข้ามเมื่อเป็นคนเดียวกับผู้รับผิดชอบ จะได้ไม่ขึ้นชื่อซ้ำสองบรรทัด
  if (t.actorName && t.actorName !== t.assigneeName) {
    rows.push(kv(ACTOR_LABEL[t.status] ?? "อัปเดตโดย", t.actorName));
  }
  if (t.cancelReason) rows.push(kv("เหตุผลที่ยกเลิก", t.cancelReason));

  const body: unknown[] = [
    { type: "text", text: t.ticketNo, size: "xl", weight: "bold", align: "center", color: "#111111" },
    { type: "text", text: t.categoryLabel, size: "xs", align: "center", color: "#8A94A0", wrap: true },
    { type: "separator", margin: "lg", color: "#EDF0F3" },
    { type: "box", layout: "vertical", margin: "lg", spacing: "sm", contents: rows },
  ];

  // กล่องเตือนแบบเดียวกับข้อความกำกับในการ์ดตัวอย่าง — ขึ้นเฉพาะงานที่เร่งด่วน
  if (urgency.note) {
    body.push({
      type: "box",
      layout: "vertical",
      margin: "lg",
      paddingAll: "10px",
      cornerRadius: "8px",
      backgroundColor: urgency.soft,
      borderWidth: "1px",
      borderColor: urgency.color,
      contents: [
        { type: "text", text: `${urgency.mark} ${urgency.label} — ${urgency.note}`, size: "xs", color: urgency.color, wrap: true },
      ],
    });
  }

  const footer = footerFor(t);

  return {
    type: "flex",
    altText: `[${t.ticketNo}] ${statusLabel} · ${t.detail.slice(0, 50)}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "horizontal",
        paddingAll: "14px",
        backgroundColor: accent,
        contents: [
          { type: "text", text: statusLabel, color: "#FFFFFF", size: "md", weight: "bold", flex: 3, gravity: "center" },
          { type: "text", text: `${urgency.mark} ${urgency.label}`, color: "#FFFFFF", size: "xs", flex: 4, align: "end", gravity: "center" },
        ],
      },
      body: { type: "box", layout: "vertical", paddingAll: "16px", contents: body },
      ...(footer ? { footer } : {}),
    },
  };
}
