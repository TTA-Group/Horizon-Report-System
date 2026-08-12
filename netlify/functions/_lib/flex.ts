// สร้าง Flex Message สำหรับ push เข้ากลุ่มฝ่าย พร้อมปุ่ม postback (spec หัวข้อ 5.2 / 6)

import type { LineMessage } from "./line";
import type { UrgencyCode } from "./constants";

export interface TicketFlexInput {
  ticketId: string;
  ticketNo: string;
  categoryLabel: string;
  reporterName: string;
  reporterDept: string | null;
  floor: string;
  locationNote: string | null;
  detail: string;
  urgency: UrgencyCode;
  createdAtLabel: string;
}

const URGENCY_COLOR: Record<UrgencyCode, string> = {
  normal: "#5B6672",
  urgent: "#E39B0C",
  critical: "#E04A2F",
};
const URGENCY_LABEL: Record<UrgencyCode, string> = {
  normal: "ปกติ",
  urgent: "เร่งด่วน",
  critical: "เร่งด่วนมาก",
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
  const accent = URGENCY_COLOR[t.urgency];
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
        backgroundColor: accent,
        contents: [
          { type: "text", text: t.ticketNo, color: "#FFFFFF", size: "sm", weight: "bold" },
          { type: "text", text: URGENCY_LABEL[t.urgency], color: "#FFFFFF", size: "xs" },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: t.categoryLabel, weight: "bold", size: "md", wrap: true },
          {
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
