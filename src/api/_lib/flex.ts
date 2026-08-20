// สร้าง Flex Message ของเรื่องหนึ่งใบ สำหรับส่งเข้ากลุ่มไลน์ (spec หัวข้อ 5.2 / 6)
//
// การ์ดเปลี่ยนหน้าตาตามสถานะ เพราะ LINE แก้ข้อความที่ส่งไปแล้วไม่ได้ — ทุกครั้งที่สถานะเปลี่ยน
// ระบบจะตอบการ์ดใบใหม่ลงในกลุ่ม การ์ดล่าสุดในบทสนทนาจึงเป็นตัวบอกสถานะจริงเสมอ
//
// ลำดับการอ่านของการ์ด: ฝ่ายไหน (หัวการ์ด) -> ด่วนแค่ไหน (แถบสี) -> เรื่องอะไร -> ใครรับผิดชอบ -> ทำอะไรต่อ

import type { LineMessage } from "./line";
import { DUE_BY_KEY, DUE_ROWS, STATUS_LABELS, type StatusCode, type UrgencyCode } from "./constants";

export interface TicketFlexInput {
  ticketId: string;
  ticketNo: string;
  status: StatusCode;
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
  /** URL รูปภาพแนบ (สาธารณะ) — แสดงเป็นรูปย่อให้กดดูได้จากในกลุ่ม */
  photos?: string[] | null;
  /** ผลตรวจสอบหลังรับเรื่อง — ยังไม่ครบถือว่ายังไม่ผ่านขั้น "ตรวจสอบ" */
  assessed?: boolean;
  dueLabel?: string | null;
  dueDateLabel?: string | null;
  waitingParts?: boolean;
  assessment?: string | null;
}

// สีหัวการ์ด — ใช้เขียวเดียวกับปุ่มท้ายการ์ด (สีเขียวของ LINE) ทั้งใบจึงเป็นสีเดียวกันหมด
const CARD_COLOR = "#06C755";

// สีของขั้นตอนที่ผ่านมาแล้วในแถบขั้นตอน — เขียวเข้มกว่าหัวการ์ดหนึ่งระดับ
// เพราะตรงนั้นเป็นตัวหนังสือขนาดเล็กที่สุดบนพื้นขาว เขียวสดจะจางจนอ่านไม่ออก
const STEP_DONE = "#04A045";

// แถบความเร่งด่วน — แถบสีทึบเต็มความกว้าง อ่านออกตั้งแต่ยังไม่ได้เปิดดูรายละเอียด
// ทุกสีเลือกให้เข้มพอสำหรับตัวหนังสือสีขาว และต่างจากสีหัวการ์ดชัดเจน
const URGENCY: Record<UrgencyCode, { label: string; color: string; note: string | null }> = {
  normal: { label: "ปกติ", color: "#5B6672", note: null },
  urgent: { label: "เร่งด่วน", color: "#C2410C", note: "ภายในวันนี้" },
  critical: { label: "เร่งด่วนมาก", color: "#B3261E", note: "กระทบการทำงาน กรุณารับเรื่องทันที" },
};

const STATUS_CHIP: Record<StatusCode, string> = {
  pending: "รอรับเรื่อง",
  in_progress: "กำลังดำเนินการ",
  completed: "ดำเนินการเสร็จสิ้น",
  closed: "ปิดเรื่องแล้ว",
  cancelled: "ยกเลิกแล้ว",
};

// สีของแถบขั้นตอน — ขั้นที่ยังไม่ถึงใช้สีจางกลาง ๆ ให้ต่างจากขั้นที่ผ่านมาแล้วอย่างชัดเจน
const STEP_FUTURE = "#C6CDD6";
const STEP_LINE = "#E3E8EE";
const STEP_BAD = "#B3261E";

/** คำต่อท้ายชื่อคนในแถบ "ล่าสุด" ให้อ่านเป็นประโยคได้ */
const LATEST_VERB: Record<StatusCode, string> = {
  pending: "ส่งต่อมาโดย",
  in_progress: "รับเรื่องและรับผิดชอบโดย",
  completed: "ดำเนินการเสร็จสิ้นโดย",
  closed: "ปิดเรื่องโดย",
  cancelled: "ยกเลิกโดย",
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
  // closed เป็นสถานะเก่าที่เลิกใช้แล้ว (ดู STATUS_TRANSITIONS) — เรื่องเก่าที่เคยปิดไว้
  // ให้แสดงเหมือนเสร็จสิ้น จะได้ไม่มีขั้นที่ไม่มีทางเกิดขึ้นอีกค้างอยู่บนแถบ
  const done = t.status === "completed" || t.status === "closed";
  const acked = done || t.status === "in_progress";
  // เรื่องที่จบไปแล้วถือว่าผ่านขั้นตรวจสอบมาแล้วเสมอ — เรื่องเก่าก่อนมีขั้นนี้จะได้ไม่ค้างเป็นจุดกลวง
  return [
    { label: "แจ้งเรื่อง", done: true },
    { label: "รับเรื่อง", done: acked },
    { label: "ตรวจสอบ", done: done || t.assessed === true },
    { label: "เสร็จสิ้น", done },
  ];
}

/** จุดกลม ๆ ของหนึ่งขั้น — ทึบเมื่อผ่านมาแล้ว กลวงเมื่อยังไม่ถึง */
function stepNode(s: Step) {
  const filled = s.bad ? STEP_BAD : STEP_DONE;
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
function stepper(t: TicketFlexInput) {
  const steps = stepsFor(t);
  const strip: unknown[] = [];
  steps.forEach((s, i) => {
    if (i > 0) {
      strip.push({
        type: "box",
        layout: "vertical",
        height: "2px",
        backgroundColor: s.done ? (s.bad ? STEP_BAD : STEP_DONE) : STEP_LINE,
        contents: [{ type: "filler" }],
      });
    }
    strip.push(stepNode(s));
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
          color: s.done ? (s.bad ? STEP_BAD : STEP_DONE) : STEP_FUTURE,
        })),
      },
    ],
  };
}

/**
 * กล่อง "ล่าสุด" — ชื่อคนบรรทัดหนึ่ง วันเวลาอีกบรรทัดหนึ่ง
 *
 * คืน null เมื่อยังไม่มีใครทำอะไรกับเรื่องนี้เลย (เพิ่งแจ้งเข้ามา) เพราะการเขียนว่า
 * "ผู้แจ้ง แจ้งเรื่องเมื่อ ..." ซ้ำกับชิปวันเวลาด้านบนและแถวผู้แจ้งอยู่แล้ว
 */
function latestWho(t: TicketFlexInput): string | null {
  return t.latestActor ?? t.actorName ?? t.assigneeName ?? null;
}

function latestBox(t: TicketFlexInput): Record<string, unknown> | null {
  const who = latestWho(t);
  if (!who) return null;
  return {
    type: "box",
    layout: "vertical",
    margin: "lg",
    paddingAll: "10px",
    cornerRadius: "8px",
    backgroundColor: "#F1F3F5",
    contents: [
      { type: "text", text: LATEST_VERB[t.status], size: "xxs", color: "#8A94A0" },
      { type: "text", text: who, size: "sm", weight: "bold", color: "#111111", wrap: true },
      { type: "text", text: t.latestAtLabel ?? t.createdAtLabel, size: "xxs", color: "#8A94A0" },
    ],
  };
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

/** เหมือน kv แต่เน้นค่าเป็นสีเขียวตัวหนา ใช้กับกำหนดเสร็จซึ่งเป็นข้อมูลที่คนอ่านมองหาก่อน */
function kvHighlight(label: string, value: string) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: [
      { type: "text", text: label, color: "#8A94A0", size: "sm", flex: 3 },
      { type: "text", text: value || "-", wrap: true, color: STEP_DONE, size: "sm", weight: "bold", flex: 7 },
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
function secondaryButton(label: string, action: string, t: TicketFlexInput) {
  return {
    type: "button",
    style: "secondary",
    height: "sm",
    action: { type: "postback", label, data: `action=${action}&ticket=${t.ticketId}` },
  };
}

/**
 * ปุ่มท้ายการ์ดตามสถานะ — สถานะที่จบแล้วไม่มีปุ่ม เหลือไว้เป็นบันทึกในกลุ่มเฉย ๆ
 *
 * ระหว่างดำเนินการ ปุ่มหลักขึ้นกับว่าแจ้งผลตรวจสอบแล้วหรือยัง เพราะการแจ้งผลคือสิ่งที่ค้างอยู่
 * ถ้ายังไม่ได้ทำ — เอาปุ่มนั้นขึ้นก่อน แล้วปุ่มเสร็จสิ้นค่อยเป็นรอง
 */
function footerFor(t: TicketFlexInput): Record<string, unknown> | null {
  let buttons: unknown[];
  if (t.status === "pending") buttons = [primaryButton("รับเรื่อง", "ack", t), cancelButton(t)];
  else if (t.status === "in_progress") {
    buttons = t.assessed
      ? [primaryButton("ดำเนินการเสร็จสิ้น", "complete", t), progressButton(t), cancelButton(t)]
      : [primaryButton("แจ้งผลตรวจสอบ", "assess", t), secondaryButton("ดำเนินการเสร็จสิ้น", "complete", t), cancelButton(t)];
  } else return null;

  return { type: "box", layout: "vertical", spacing: "sm", contents: buttons };
}

/** ปุ่มอัปเดตความคืบหน้า — เปิดแป้นพิมพ์พร้อมข้อความตั้งต้น เหมือนปุ่มยกเลิก */
function progressButton(t: TicketFlexInput) {
  return {
    type: "button",
    style: "secondary",
    height: "sm",
    action: {
      type: "postback",
      label: "อัปเดตความคืบหน้า",
      data: `action=progress&ticket=${t.ticketId}`,
      inputOption: "openKeyboard",
      fillInText: `อัปเดต ${t.ticketNo}: `,
    },
  };
}

/**
 * รูปภาพแนบ — แตะที่รูปแล้วเปิดขนาดเต็มในเบราว์เซอร์ของ LINE ได้ทันที ไม่ต้องเปิดแอป
 *
 * LINE เป็นฝ่ายไปดึงรูปจาก URL เอง ไฟล์จึงต้องอยู่ใน bucket แบบสาธารณะ (STORAGE_BUCKET_URL)
 * แสดงไม่เกิน 3 รูปให้พอดีหนึ่งแถว รูปที่เกินยังดูได้ในแอปตามเดิม
 */
const MAX_PHOTOS = 3;

function photoBlock(urls: string[]) {
  const shown = urls.slice(0, MAX_PHOTOS);
  const more = urls.length - shown.length;
  return {
    type: "box",
    layout: "vertical",
    margin: "lg",
    spacing: "xs",
    contents: [
      {
        type: "text",
        text: more > 0 ? `รูปภาพแนบ · แตะเพื่อดูขนาดเต็ม (อีก ${more} รูปดูในแอป)` : "รูปภาพแนบ · แตะเพื่อดูขนาดเต็ม",
        size: "xxs",
        color: "#8A94A0",
        wrap: true,
      },
      {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: shown.map((url) => ({
          type: "image",
          url,
          size: "full",
          aspectRatio: "1:1",
          aspectMode: "cover",
          flex: 1,
          action: { type: "uri", label: "ดูรูปภาพ", uri: url },
        })),
      },
    ],
  };
}

/**
 * กล่องเตือนว่ายังไม่มีใครรับเรื่อง — ขึ้นเฉพาะตอนที่ยังว่างอยู่จริงเท่านั้น
 * พอมีคนรับแล้ว กล่อง "ล่าสุด" บอกชื่อคนนั้นไว้แล้ว กล่องซ้ำอีกใบมีแต่ทำให้การ์ดยาวขึ้นเปล่า ๆ
 */
function unassignedBlock() {
  return {
    type: "box",
    layout: "vertical",
    margin: "lg",
    paddingAll: "12px",
    cornerRadius: "8px",
    backgroundColor: "#FFF6F5",
    borderWidth: "1px",
    borderColor: "#E7B7B1",
    contents: [
      { type: "text", text: "ผู้รับผิดชอบ", size: "xs", color: "#8A94A0" },
      { type: "text", text: "ยังไม่มีผู้รับผิดชอบ", size: "lg", weight: "bold", color: "#B3261E", wrap: true },
    ],
  };
}

/** สร้างข้อความ Flex ของ ticket หนึ่งใบตามสถานะปัจจุบัน */
export function buildTicketFlex(t: TicketFlexInput): LineMessage {
  const urgency = URGENCY[t.urgency];
  const statusLabel = STATUS_CHIP[t.status] ?? STATUS_LABELS[t.status] ?? t.status;

  const rows: unknown[] = [
    // ชื่อผู้แจ้งกับต้นสังกัดแยกคนละบรรทัด ต้นสังกัดตัวเล็กกว่าและเป็นสีเทา
    // เพราะเป็นข้อมูลประกอบ ไม่ใช่สิ่งที่คนอ่านการ์ดมองหา
    {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        { type: "text", text: "ผู้แจ้ง", color: "#8A94A0", size: "xs", flex: 3 },
        {
          type: "box",
          layout: "vertical",
          flex: 7,
          contents: [
            { type: "text", text: t.reporterName, color: "#111111", size: "xs", wrap: true },
            ...(t.reporterDept
              ? [{ type: "text", text: t.reporterDept, color: "#8A94A0", size: "xxs", wrap: true }]
              : []),
          ],
        },
      ],
    },
    kv("สถานที่", `${t.floor}${t.locationNote ? " · " + t.locationNote : ""}`),
    kv("รายละเอียด", t.detail),
  ];
  // ชื่อผู้รับผิดชอบขึ้นเป็นบรรทัดเดียว เฉพาะตอนที่ไม่ใช่คนเดียวกับคนที่ทำรายการล่าสุด
  // (เช่น A รับเรื่องไว้ แต่ B เป็นคนกดปิดงาน) ถ้าเป็นคนเดียวกัน กล่อง "ล่าสุด" บอกไปแล้ว
  const who = latestWho(t);
  if (t.assigneeName && t.assigneeName !== who) rows.push(kv("ผู้รับผิดชอบ", t.assigneeName));

  // ผลตรวจสอบ — ขึ้นเน้นสีเขียวเพราะเป็นคำตอบที่ผู้แจ้งรอฟังมากที่สุด
  if (t.dueLabel) {
    const when = [t.dueLabel, t.dueDateLabel].filter(Boolean).join(" · ");
    rows.push(kvHighlight(t.waitingParts ? "รออะไหล่ ถึง" : "คาดว่าเสร็จ", when));
  }
  if (t.assessment) rows.push(kv("อาการที่พบ", t.assessment));
  if (t.cancelReason) rows.push(kv("เหตุผลที่ยกเลิก", t.cancelReason));

  const latest = latestBox(t);
  const body: unknown[] = [
    // เลขที่เรื่องซ้ายมือ วันเวลาที่แจ้งเป็นชิปมุมขวาบน — วันเวลาเป็นข้อมูลอ้างอิง
    // ไม่ต้องกินพื้นที่หนึ่งบรรทัดเต็มในรายการข้อมูลด้านล่าง
    {
      type: "box",
      layout: "horizontal",
      alignItems: "center",
      contents: [
        { type: "text", text: t.ticketNo, size: "lg", weight: "bold", color: "#111111", flex: 1 },
        {
          type: "box",
          layout: "vertical",
          flex: 0,
          paddingAll: "4px",
          paddingStart: "10px",
          paddingEnd: "10px",
          cornerRadius: "12px",
          backgroundColor: "#F1F3F5",
          contents: [{ type: "text", text: t.createdAtLabel, size: "xxs", color: "#5B6672", align: "center" }],
        },
      ],
    },
    { type: "text", text: t.categoryLabel, size: "xs", color: "#8A94A0", wrap: true },
    stepper(t),
    ...(latest ? [latest] : []),
    { type: "separator", margin: "lg", color: "#EDF0F3" },
    { type: "box", layout: "vertical", margin: "lg", spacing: "sm", contents: rows },
    ...(t.photos && t.photos.length > 0 ? [photoBlock(t.photos)] : []),
    ...(t.assigneeName ? [] : [unassignedBlock()]),
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
            backgroundColor: CARD_COLOR,
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

/* ───────────────── การ์ดถาม–ตอบระหว่างแจ้งผลตรวจสอบ ─────────────────
 * ทั้งหมดนี้ส่งด้วยการ "ตอบกลับ" หลังผู้ใช้กดปุ่มหรือพิมพ์ จึงไม่กินโควตาข้อความของ OA
 */

const CHIP_TONE = {
  green: { border: "#06C755", text: "#04A045" },
  amber: { border: "#E39B0C", text: "#8A5B00" },
  grey: { border: "#B6C0CA", text: "#424A54" },
};

/**
 * ชิปหนึ่งอัน — ใช้ box ที่มี action แทน button เพราะปุ่มของ Flex สูงคงที่และกินพื้นที่มาก
 * เอามาเรียงเป็นตารางไม่ได้ ส่วน box กำหนดขนาดเองได้ จึงทำเป็นชิปเล็ก ๆ หลายอันต่อแถวได้
 */
function chip(label: string, action: Record<string, unknown>, tone: keyof typeof CHIP_TONE = "green") {
  const c = CHIP_TONE[tone];
  return {
    type: "box",
    layout: "vertical",
    flex: 0,
    paddingAll: "7px",
    paddingStart: "12px",
    paddingEnd: "12px",
    cornerRadius: "16px",
    borderWidth: "1px",
    borderColor: c.border,
    action,
    contents: [{ type: "text", text: label, size: "xxs", weight: "bold", color: c.text, align: "center" }],
  };
}

function chipRow(chips: unknown[]) {
  return { type: "box", layout: "horizontal", spacing: "xs", margin: "sm", contents: chips };
}

function bubble(contents: unknown[]): LineMessage {
  return {
    type: "flex",
    altText: "กรุณาตอบกลับในแอปไลน์",
    contents: { type: "bubble", size: "kilo", body: { type: "box", layout: "vertical", contents } },
  } as unknown as LineMessage;
}

/** ถามกำหนดเสร็จ — ชิปเรียงตาม DUE_ROWS เพราะ Flex ตัดบรรทัดให้เองไม่ได้ */
export function dueAskCard(ticketId: string, ticketNo: string): LineMessage {
  const rows = DUE_ROWS.map((keys) =>
    chipRow(
      keys.map((k) => {
        const o = DUE_BY_KEY.get(k);
        if (!o) return { type: "filler" };
        if (o.special === "pick") {
          return chip(
            `📅 ${o.chip}`,
            { type: "datetimepicker", label: o.chip, data: `action=duedate&ticket=${ticketId}&mode=pick`, mode: "date" },
            "grey",
          );
        }
        const tone = o.special === "wait" ? "amber" : "green";
        return chip(o.chip, { type: "postback", label: o.chip, data: `action=due&ticket=${ticketId}&v=${k}` }, tone);
      }),
    ),
  );
  return bubble([
    { type: "text", text: `${ticketNo} · คาดว่าจะเสร็จเมื่อไหร่`, size: "sm", weight: "bold", color: "#111111", wrap: true },
    { type: "text", text: "เลือกกรอบเวลาที่ใกล้เคียงที่สุด ระบบจะแจ้งผู้แจ้งให้เอง", size: "xxs", color: "#8A94A0", wrap: true, margin: "xs" },
    ...rows,
  ]);
}

/** รออะไหล่ — บังคับเลือกวันจากปฏิทิน ข้ามไม่ได้ */
export function waitDateCard(ticketId: string, ticketNo: string): LineMessage {
  return bubble([
    { type: "text", text: `${ticketNo} · รออะไหล่ / ผู้รับเหมา`, size: "sm", weight: "bold", color: "#111111", wrap: true },
    { type: "text", text: "ระบุวันที่คาดว่าจะแก้ไขได้ (บังคับ)", size: "xxs", color: "#B3261E", wrap: true, margin: "xs" },
    chipRow([
      chip(
        "📅 เลือกวันที่",
        { type: "datetimepicker", label: "เลือกวันที่", data: `action=duedate&ticket=${ticketId}&mode=wait`, mode: "date" },
        "amber",
      ),
    ]),
    { type: "text", text: "ระบบจะถามความคืบหน้าทุก 7 วันจนกว่าจะดำเนินการต่อ", size: "xxs", color: "#8A94A0", wrap: true, margin: "md" },
  ]);
}

/** ขอคำอธิบายอาการ — พิมพ์เอง หรือติ๊กว่าไม่มีคำอธิบายเพิ่มเติม */
export function assessmentAskCard(ticketId: string, ticketNo: string): LineMessage {
  return bubble([
    { type: "text", text: `${ticketNo} · พบอะไรบ้าง`, size: "sm", weight: "bold", color: "#111111", wrap: true },
    { type: "text", text: "พิมพ์ต่อท้ายข้อความที่เตรียมไว้แล้วส่ง", size: "xxs", color: "#8A94A0", wrap: true, margin: "xs" },
    chipRow([
      chip(
        "✎ พิมพ์อาการที่พบ",
        {
          type: "postback",
          label: "พิมพ์อาการที่พบ",
          data: `action=note&ticket=${ticketId}`,
          inputOption: "openKeyboard",
          fillInText: `ผลตรวจ ${ticketNo}: `,
        },
        "green",
      ),
    ]),
    chipRow([
      chip("☑ ไม่มีคำอธิบายเพิ่มเติม", { type: "postback", label: "ไม่มีคำอธิบาย", data: `action=nonote&ticket=${ticketId}` }, "grey"),
    ]),
  ]);
}

/** ทวงงานรออะไหล่ — ตอบได้จากปุ่มในข้อความเลย ไม่ต้องเปิดแอป */
export function partsFollowUpCard(ticketId: string, ticketNo: string): LineMessage {
  return bubble([
    { type: "text", text: `${ticketNo} · อะไหล่มาหรือยัง`, size: "sm", weight: "bold", color: "#111111", wrap: true },
    chipRow([
      chip("ของมาแล้ว เริ่มงาน", { type: "postback", label: "ของมาแล้ว", data: `action=partsok&ticket=${ticketId}` }),
      chip(
        "📅 เลื่อนวัน",
        { type: "datetimepicker", label: "เลื่อนวัน", data: `action=duedate&ticket=${ticketId}&mode=wait`, mode: "date" },
        "grey",
      ),
    ]),
  ]);
}

/** ทวงงานที่เลยกำหนด — ให้เลื่อนกำหนดหรือปิดงานได้จากในข้อความเลย */
export function overdueCard(ticketId: string, ticketNo: string): LineMessage {
  return bubble([
    { type: "text", text: `${ticketNo} · เลยกำหนดแล้ว`, size: "sm", weight: "bold", color: "#B3261E", wrap: true },
    { type: "text", text: "อัปเดตกำหนดใหม่ หรือปิดงานถ้าเสร็จแล้ว", size: "xxs", color: "#8A94A0", wrap: true, margin: "xs" },
    chipRow([
      chip("ดำเนินการเสร็จสิ้น", { type: "postback", label: "เสร็จสิ้น", data: `action=complete&ticket=${ticketId}` }),
      chip(
        "📅 เลื่อนกำหนด",
        { type: "datetimepicker", label: "เลื่อนกำหนด", data: `action=duedate&ticket=${ticketId}&mode=pick`, mode: "date" },
        "grey",
      ),
    ]),
  ]);
}
