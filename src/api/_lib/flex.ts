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
  /** คนที่ทำให้สถานะเปลี่ยนล่าสุด และเวลาแบบสั้น — ใช้เขียนแถบ "ล่าสุด" ใต้แถบขั้นตอน */
  latestActor?: string | null;
  latestAtLabel?: string | null;
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

// สีของแถบขั้นตอน — ขั้นที่ยังไม่ถึงใช้สีจางกลาง ๆ ที่ไม่ชนกับสีของฝ่ายไหนเลย
const STEP_FUTURE = "#C6CDD6";
const STEP_LINE = "#E3E8EE";
const STEP_BAD = "#B3261E";

/** คำต่อท้ายชื่อคนในแถบ "ล่าสุด" ให้อ่านเป็นประโยคได้ */
const LATEST_VERB: Record<StatusCode, string> = {
  pending: "ส่งต่อมาเมื่อ",
  in_progress: "รับเรื่องไว้เมื่อ",
  completed: "ปิดงานเมื่อ",
  closed: "ปิดเรื่องเมื่อ",
  cancelled: "ยกเลิกเมื่อ",
};

interface Step {
  label: string;
  done: boolean;
  bad?: boolean;
}

/**
 * ขั้นตอนที่จะวาดบนแถบ
 *
 * เรื่องที่ถูกยกเลิกไม่ได้เดินจนจบเส้นทางปกติ จึงตัดขั้นที่ไม่มีวันเกิดขึ้นทิ้ง แล้วจบด้วยขั้นสีแดง
 * ถ้าฝืนวาดครบ 4 ขั้นเหมือนเดิม แถบจะอ่านเหมือนงานยังค้างอยู่ทั้งที่จบไปแล้ว
 */
function stepsFor(t: TicketFlexInput): Step[] {
  if (t.status === "cancelled") {
    return [
      { label: "แจ้งเรื่อง", done: true },
      ...(t.assigneeName ? [{ label: "รับเรื่อง", done: true }] : []),
      { label: "ยกเลิก", done: true, bad: true },
    ];
  }
  const order: StatusCode[] = ["pending", "in_progress", "completed", "closed"];
  const at = order.indexOf(t.status);
  return [
    { label: "แจ้งเรื่อง", done: at >= 0 },
    { label: "รับเรื่อง", done: at >= 1 },
    { label: "เสร็จสิ้น", done: at >= 2 },
    { label: "ปิดเรื่อง", done: at >= 3 },
  ];
}

/** จุดกลม ๆ ของหนึ่งขั้น — ทึบเมื่อผ่านมาแล้ว กลวงเมื่อยังไม่ถึง */
function stepNode(s: Step, accent: string) {
  const filled = s.bad ? STEP_BAD : accent;
  return {
    type: "box",
    layout: "vertical",
    flex: 0,
    width: "12px",
    height: "12px",
    cornerRadius: "6px",
    backgroundColor: s.done ? filled : "#FFFFFF",
    ...(s.done ? {} : { borderWidth: "2px", borderColor: STEP_FUTURE }),
    contents: [{ type: "filler" }],
  };
}

/** แถบขั้นตอนแนวนอน: จุด — เส้น — จุด พร้อมชื่อขั้นเรียงใต้จุด */
function stepper(t: TicketFlexInput, accent: string) {
  const steps = stepsFor(t);
  const strip: unknown[] = [];
  steps.forEach((s, i) => {
    if (i > 0) {
      strip.push({
        type: "box",
        layout: "vertical",
        height: "2px",
        backgroundColor: s.done ? (s.bad ? STEP_BAD : accent) : STEP_LINE,
        contents: [{ type: "filler" }],
      });
    }
    strip.push(stepNode(s, accent));
  });

  return {
    type: "box",
    layout: "vertical",
    margin: "lg",
    contents: [
      { type: "box", layout: "horizontal", alignItems: "center", contents: strip },
      {
        type: "box",
        layout: "horizontal",
        margin: "sm",
        contents: steps.map((s, i) => ({
          type: "text",
          text: s.label,
          size: "xxs",
          flex: 1,
          align: i === 0 ? "start" : i === steps.length - 1 ? "end" : "center",
          weight: s.done ? "bold" : "regular",
          color: s.done ? (s.bad ? STEP_BAD : accent) : STEP_FUTURE,
        })),
      },
    ],
  };
}

/** ประโยคบอกความเคลื่อนไหวล่าสุด — เรื่องที่เพิ่งแจ้งยังไม่มีใครทำอะไร จึงย้อนไปที่ผู้แจ้ง */
function latestLine(t: TicketFlexInput): string {
  const who = t.latestActor ?? t.actorName ?? t.assigneeName ?? null;
  if (!who || (t.status === "pending" && !t.latestActor && !t.actorName)) {
    return `${t.reporterName} แจ้งเรื่องเมื่อ ${t.latestAtLabel ?? t.createdAtLabel}`;
  }
  return `${who} ${LATEST_VERB[t.status]} ${t.latestAtLabel ?? t.createdAtLabel}`;
}

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
    stepper(t, accent),
    {
      type: "box",
      layout: "vertical",
      margin: "lg",
      paddingAll: "10px",
      cornerRadius: "8px",
      backgroundColor: "#F1F3F5",
      contents: [
        { type: "text", text: "ล่าสุด", size: "xxs", color: "#8A94A0" },
        { type: "text", text: latestLine(t), size: "xs", color: "#111111", wrap: true },
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
