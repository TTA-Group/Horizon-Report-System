// การ์ดที่ส่งเข้าไลน์ของระบบจองคิวนวด
//
// หน้าตาอิงการ์ดของระบบเดิม (แถบเขียวด้านบน · รายละเอียด · ปุ่มยกเลิกสีแดง) เพื่อให้คนที่เคยใช้
// จำได้ทันที ต่างกันที่ปุ่มยกเลิกพาเข้าแอปแล้วให้แอปเป็นคนถามยืนยัน แทนที่จะยิงคำสั่งลบทันที
//
// ปุ่มเป็นลิงก์ LIFF ไม่ใช่ postback โดยตั้งใจ — LINE OA หนึ่งบัญชีตั้ง webhook ได้ปลายทางเดียว
// ซึ่งตอนนี้เป็นระบบแจ้งปัญหา ถ้าใช้ postback ระบบจองต้องไปแทรกตัวจัดการในระบบอื่น
// ระบบเดิมก็ใช้ลิงก์เหมือนกันและเป็นทางที่ถูกแล้ว

import { envVar } from "./env";
import type { LineMessage } from "./line";
import { slotLabel, thaiDayLabel } from "./massage";

const GREEN = "#06C755";

/**
 * ลิงก์เปิดแอปจองคิวนวด · คืน null เมื่อยังไม่ได้ตั้ง LIFF_ID
 *
 * ค่าตั้งต้นใน wrangler.massage.toml เป็นข้อความบอกให้ไปตั้งค่า ไม่ใช่รหัสจริง
 * ต้องนับว่า "ยังไม่ได้ตั้ง" ด้วย ไม่งั้นการ์ดจะมีปุ่มที่กดแล้วเปิดหน้าที่ไม่มีอยู่จริง
 * ซึ่งแย่กว่าการ์ดที่ไม่มีปุ่ม — รหัส LIFF จริงมีแต่ตัวเลข ขีด และอักษรอังกฤษเท่านั้น
 */
const LIFF_ID_RE = /^\d{6,12}-[A-Za-z0-9]{4,20}$/;

export function massageLiffUri(params?: Record<string, string>): string | null {
  const liffId = (envVar("LIFF_ID") ?? "").trim();
  if (!LIFF_ID_RE.test(liffId)) return null;
  const q = params ? `?${new URLSearchParams(params).toString()}` : "";
  return `https://liff.line.me/${liffId}${q}`;
}

function kv(label: string, value: string): object {
  return {
    type: "box",
    layout: "baseline",
    margin: "md",
    contents: [
      { type: "text", text: label, size: "sm", color: "#AAAAAA", flex: 2 },
      { type: "text", text: value, size: "sm", weight: "bold", color: "#333333", flex: 5, align: "end", wrap: true },
    ],
  };
}

export interface ConfirmInput {
  bookingId: string;
  day: string;
  slot: string;
  therapistName: string;
}

/** การ์ดยืนยันการจอง พร้อมปุ่มยกเลิก */
export function bookingConfirmCard(b: ConfirmInput): LineMessage {
  const cancelUri = massageLiffUri({ cancel: b.bookingId });

  const body: object[] = [
    { type: "text", text: "จองคิวสำเร็จ", weight: "bold", size: "xl", color: "#333333", align: "center" },
    {
      type: "text",
      text: "บันทึกการนัดหมายของคุณเรียบร้อยแล้ว",
      size: "sm",
      color: "#AAAAAA",
      align: "center",
      margin: "sm",
      wrap: true,
    },
    { type: "separator", margin: "lg" },
    { type: "box", layout: "vertical", margin: "lg", contents: [kv("วันที่", thaiDayLabel(b.day)), kv("หมอนวด", b.therapistName)] },
    { type: "separator", margin: "lg" },
    {
      type: "box",
      layout: "vertical",
      margin: "lg",
      contents: [
        { type: "text", text: "เวลานัดหมาย", size: "xs", color: "#AAAAAA", align: "center" },
        { type: "text", text: slotLabel(b.slot), size: "xl", weight: "bold", color: GREEN, align: "center", margin: "md" },
      ],
    },
    {
      type: "box",
      layout: "vertical",
      margin: "lg",
      backgroundColor: "#FFF3F0",
      cornerRadius: "md",
      paddingAll: "md",
      contents: [
        {
          type: "text",
          text: "กรุณามาก่อนเวลานัดหมายอย่างน้อย 5 นาที",
          size: "xxs",
          weight: "bold",
          color: "#B0331B",
          align: "center",
          wrap: true,
        },
        {
          type: "text",
          text: "หากมาไม่ได้ กรุณากดยกเลิกก่อนถึงคิว 15 นาที",
          size: "xxs",
          color: "#B0331B",
          align: "center",
          wrap: true,
        },
      ],
    },
  ];

  // ไม่มี LIFF_ID ก็ยังส่งการ์ดได้ แค่ไม่มีปุ่ม — ดีกว่าส่งปุ่มที่กดแล้วไม่เกิดอะไรขึ้น
  if (cancelUri) {
    body.push({
      type: "button",
      style: "link",
      height: "sm",
      margin: "md",
      action: { type: "uri", label: "ยกเลิกการจอง", uri: cancelUri },
      color: "#D93025",
    });
  }

  return {
    type: "flex",
    altText: `จองคิวนวดสำเร็จ · ${thaiDayLabel(b.day)} ${slotLabel(b.slot)}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: GREEN,
        paddingAll: "15px",
        contents: [
          { type: "text", text: "BOOKING CONFIRMED", color: "#FFFFFF", size: "md", weight: "bold", gravity: "center" },
        ],
      },
      body: { type: "box", layout: "vertical", contents: body },
    },
  };
}

/** ข้อความยืนยันการยกเลิก — สั้น ไม่ต้องเป็นการ์ด */
export function cancelledText(day: string, slot: string, therapistName: string): string {
  return `ยกเลิกคิวนวดเรียบร้อยแล้ว\n${thaiDayLabel(day)} · ${slotLabel(slot)} · ${therapistName}\n\nสิทธิ์ของเดือนนี้ถูกคืนให้แล้ว จองรอบใหม่ได้เลย`;
}

