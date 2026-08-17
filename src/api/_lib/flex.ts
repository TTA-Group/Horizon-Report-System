// สร้าง Flex Message สำหรับ push เข้ากลุ่มฝ่าย พร้อมปุ่ม postback (spec หัวข้อ 5.2 / 6)

import type { LineMessage } from "./line";
import type { UrgencyCode } from "./constants";

export interface TicketFlexInput {
  ticketId: string;
  ticketNo: string;
  categoryCode: string;
  categoryLabel: string;
  reporterName: string;
  reporterDept: string | null;
  floor: string;
  locationNote: string | null;
  detail: string;
  urgency: UrgencyCode;
  createdAtLabel: string;
}

// สีหัวการ์ดแยกตามหมวด ใช้ชุดสีเดียวกับไอคอนในแอป LIFF เพื่อให้จำสีได้ตรงกันทั้งสองที่
// ทุกฝ่ายอยู่ในกลุ่มไลน์เดียวกัน การ์ดจึงปนกัน — สีหัวคือตัวแยกว่าเป็นงานของทีมไหนตั้งแต่แรกเห็น
const CATEGORY_COLOR: Record<string, string> = {
  IT: "#2C6BE0", // น้ำเงิน — งานคอมพิวเตอร์
  FAC: "#E39B0C", // เหลืองอำพัน — แอร์ ไฟ ประปา
  CLN: "#04A045", // เขียว — งานแม่บ้าน
  GEN: "#6B4FD8", // ม่วง — เรื่องอื่น ๆ
};
const FALLBACK_COLOR = "#5B6672";

// ระดับความเร่งด่วนใช้สัญลักษณ์แทนสี เพราะสีหัวการ์ดถูกใช้บอก "ทีม" ไปแล้ว
// ถ้าใช้สีบอกทั้งสองอย่างจะชนกันเอง เช่น งานแอร์ (เหลือง) ที่เร่งด่วน (เหลือง) จะแยกไม่ออก
const URGENCY_MARK: Record<UrgencyCode, string> = {
  normal: "⚪ ปกติ",
  urgent: "🟠 เร่งด่วน",
  critical: "🔴 เร่งด่วนมาก",
};

function kv(label: string, value: string) {
  return {
    type: "box",
    layout: "baseline",
    spacing: "sm",
    contents: [
      { type: "text", text: label, color: "#8A94A0", size: "sm", flex: 2 },
      { type: "text", text: value || "-", wrap: true, color: "#111111", size: "sm", flex: 5 },
    ],
  };
}

/** สร้างข้อความ Flex ของ ticket หนึ่งใบ */
export function buildTicketFlex(t: TicketFlexInput): LineMessage {
  const accent = CATEGORY_COLOR[t.categoryCode] ?? FALLBACK_COLOR;
  return {
    type: "flex",
    altText: `[${t.ticketNo}] ${t.detail.slice(0, 60)}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        spacing: "xs",
        backgroundColor: accent,
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: t.ticketNo, color: "#FFFFFF", size: "sm", weight: "bold", flex: 3, gravity: "center" },
              { type: "text", text: URGENCY_MARK[t.urgency], color: "#FFFFFF", size: "xs", flex: 4, align: "end", gravity: "center" },
            ],
          },
          { type: "text", text: t.categoryLabel, color: "#FFFFFF", size: "xs", wrap: true },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          kv("ผู้แจ้ง", `${t.reporterName}${t.reporterDept ? " · " + t.reporterDept : ""}`),
          kv("สถานที่", `${t.floor}${t.locationNote ? " · " + t.locationNote : ""}`),
          kv("รายละเอียด", t.detail),
          kv("วันเวลา", t.createdAtLabel),
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#06C755",
            action: {
              type: "postback",
              label: "รับเรื่อง",
              data: `action=ack&ticket=${t.ticketId}`,
              displayText: `รับเรื่อง ${t.ticketNo}`,
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "ดำเนินการเสร็จ",
              data: `action=complete&ticket=${t.ticketId}`,
              displayText: `ปิดงาน ${t.ticketNo}`,
            },
          },
        ],
      },
    },
  };
}
