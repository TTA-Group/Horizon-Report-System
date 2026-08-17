// สร้าง Flex Message ของเรื่องหนึ่งใบ สำหรับส่งเข้ากลุ่มไลน์ (spec หัวข้อ 5.2 / 6)
//
// การ์ดเปลี่ยนหน้าตาตามสถานะ เพราะ LINE แก้ข้อความที่ส่งไปแล้วไม่ได้ — ทุกครั้งที่สถานะเปลี่ยน
// ระบบจะตอบการ์ดใบใหม่ลงในกลุ่ม การ์ดล่าสุดในบทสนทนาจึงเป็นตัวบอกสถานะจริงเสมอ
//
// ลำดับการอ่านของการ์ด: ฝ่ายไหน (หัวการ์ด) -> ด่วนแค่ไหน (แถบสี) -> เรื่องอะไร -> ใครรับผิดชอบ -> ทำอะไรต่อ

import type { LineMessage } from "./line";
import { STATUS_LABELS, type StatusCode, type UrgencyCode } from "./constants";

export interface TicketFlexInput {
  ticketId: string;
  ticketNo: string;
  status: StatusCode;
  departmentCode: string;
  departmentName: string;
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
const DEPARTMENT_COLOR: Record<string, string> = {
  IT: "#2C6BE0", // น้ำเงิน — งานคอมพิวเตอร์และระบบงาน
  ADM: "#B26A00", // เหลืองอำพันเข้ม — แอร์ ไฟ ประปา และงานแม่บ้าน
  CLN: "#05803A", // เขียวเข้ม — งานแม่บ้าน (เผื่อวันที่แยกทีมออกจากฝ่าย Admin)
  GEN: "#6B4FD8", // ม่วง — เรื่องอื่น ๆ
};
const FALLBACK_COLOR = "#5B6672";

// แถบความเร่งด่วน — แถบสีทึบเต็มความกว้าง อ่านออกตั้งแต่ยังไม่ได้เปิดดูรายละเอียด
// ทุกสีเลือกให้เข้มพอสำหรับตัวหนังสือสีขาว และต่างจากสีหัวการ์ดของทุกฝ่าย
const URGENCY: Record<UrgencyCode, { label: string; color: string; note: string | null }> = {
  normal: { label: "ปกติ", color: "#5B6672", note: null },
  urgent: { label: "เร่งด่วน", color: "#C2410C", note: "ภายในวันนี้" },
  critical: { label: "เร่งด่วนมาก", color: "#B3261E", note: "กระทบการทำงาน กรุณารับเรื่องทันที" },
};

// คำนำหน้าชื่อคนที่ทำให้สถานะเปลี่ยน — ทุกการ์ดที่เข้ากลุ่มต้องบอกได้ว่าใครเป็นคนทำ
const ACTOR_LABEL: Record<StatusCode, string> = {
  pending: "ส่งต่อโดย",
  in_progress: "รับเรื่องโดย",
  completed: "ปิดงานโดย",
  closed: "ปิดเรื่องโดย",
  cancelled: "ยกเลิกโดย",
};

const STATUS_CHIP: Record<StatusCode, string> = {
  pending: "รอรับเรื่อง",
  in_progress: "กำลังดำเนินการ",
  completed: "ดำเนินการเสร็จสิ้น",
  closed: "ปิดเรื่องแล้ว",
  cancelled: "ยกเลิกแล้ว",
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

/** กล่องผู้รับผิดชอบ — แยกออกมาให้เด่น เพราะเป็นข้อมูลที่คนในกลุ่มมองหาบ่อยที่สุด */
function assigneeBlock(t: TicketFlexInput, accent: string) {
  const taken = Boolean(t.assigneeName);
  return {
    type: "box",
    layout: "vertical",
    margin: "lg",
    paddingAll: "12px",
    cornerRadius: "8px",
    backgroundColor: taken ? "#F4F7FB" : "#FFF6F5",
    borderWidth: "1px",
    borderColor: taken ? accent : "#E7B7B1",
    contents: [
      { type: "text", text: "ผู้รับผิดชอบ", size: "xs", color: "#8A94A0" },
      {
        type: "text",
        text: taken ? (t.assigneeName as string) : "ยังไม่มีผู้รับผิดชอบ",
        size: "lg",
        weight: "bold",
        color: taken ? accent : "#B3261E",
        wrap: true,
      },
    ],
  };
}

/** สร้างข้อความ Flex ของ ticket หนึ่งใบตามสถานะปัจจุบัน */
export function buildTicketFlex(t: TicketFlexInput): LineMessage {
  const accent = DEPARTMENT_COLOR[t.departmentCode] ?? FALLBACK_COLOR;
  const urgency = URGENCY[t.urgency];
  const statusLabel = STATUS_CHIP[t.status] ?? STATUS_LABELS[t.status] ?? t.status;

  const rows: unknown[] = [
    kv("ผู้แจ้ง", `${t.reporterName}${t.reporterDept ? " · " + t.reporterDept : ""}`),
    kv("สถานที่", `${t.floor}${t.locationNote ? " · " + t.locationNote : ""}`),
    kv("รายละเอียด", t.detail),
    kv("วันเวลา", t.createdAtLabel),
  ];
  // ชื่อคนที่เพิ่งเปลี่ยนสถานะ — ข้ามเมื่อเป็นคนเดียวกับผู้รับผิดชอบ จะได้ไม่ขึ้นชื่อซ้ำสองที่
  if (t.actorName && t.actorName !== t.assigneeName) {
    rows.push(kv(ACTOR_LABEL[t.status] ?? "อัปเดตโดย", t.actorName));
  }
  if (t.cancelReason) rows.push(kv("เหตุผลที่ยกเลิก", t.cancelReason));

  const body: unknown[] = [
    { type: "text", text: t.ticketNo, size: "xl", weight: "bold", align: "center", color: "#111111" },
    { type: "text", text: t.categoryLabel, size: "xs", align: "center", color: "#8A94A0", wrap: true },
    {
      type: "box",
      layout: "horizontal",
      margin: "md",
      justifyContent: "center",
      contents: [
        {
          type: "box",
          layout: "vertical",
          flex: 0,
          paddingAll: "6px",
          paddingStart: "14px",
          paddingEnd: "14px",
          cornerRadius: "14px",
          backgroundColor: "#F1F3F5",
          contents: [{ type: "text", text: statusLabel, size: "xs", weight: "bold", color: accent, align: "center" }],
        },
      ],
    },
    { type: "separator", margin: "lg", color: "#EDF0F3" },
    { type: "box", layout: "vertical", margin: "lg", spacing: "sm", contents: rows },
    assigneeBlock(t, accent),
  ];

  const footer = footerFor(t);

  return {
    type: "flex",
    altText: `[${t.ticketNo}] ${t.departmentName} · ${statusLabel} · ${t.detail.slice(0, 40)}`,
    contents: {
      type: "bubble",
      size: "mega",
      // สองแถบซ้อนกันอยู่ใน header เดียว (ตัด padding ของ header ออกให้แถบลูกกินเต็มความกว้าง)
      // แถบบน = ฝ่ายที่รับผิดชอบ · แถบล่าง = ระดับความเร่งด่วน
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "0px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            paddingAll: "14px",
            backgroundColor: accent,
            contents: [
              { type: "text", text: t.departmentName, color: "#FFFFFF", size: "md", weight: "bold", wrap: true },
            ],
          },
          {
            type: "box",
            layout: "vertical",
            paddingAll: "8px",
            backgroundColor: urgency.color,
            contents: [
              {
                type: "text",
                text: urgency.note ? `${urgency.label} · ${urgency.note}` : urgency.label,
                color: "#FFFFFF",
                size: "xs",
                weight: "bold",
                align: "center",
                wrap: true,
              },
            ],
          },
        ],
      },
      body: { type: "box", layout: "vertical", paddingAll: "16px", contents: body },
      ...(footer ? { footer } : {}),
    },
  };
}
