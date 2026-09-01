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
const FLASH = "#F26A1B";

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
  /** ชื่อผู้จองตามทะเบียนพนักงาน — ไม่ใช่ชื่อในไลน์ซึ่งเป็นชื่อเล่นหรืออีโมจิได้ */
  employeeName: string;
  /** true = คิวด่วน ยกเลิกเองไม่ได้ (เกิดเฉพาะกับคนที่ใช้สิทธิ์ครบแล้ว) */
  flash: boolean;
  /**
   * true = ผู้ดูแลเป็นคนกดจองให้ ไม่ใช่เจ้าตัวกดเอง
   *
   * เปลี่ยนแค่คำพูดบนการ์ด ส่วนปุ่มยกเลิกยังเหมือนกันทุกอย่าง — คนที่ถูกจองให้
   * ต้องยกเลิกเองได้เหมือนคนที่กดจองเอง ไม่งั้นต้องเดินไปหาเจ้าหน้าที่ทุกครั้ง
   *
   * ถ้าใช้คำว่า "จองคิวสำเร็จ" เหมือนกัน คนที่ไม่ได้กดอะไรเลยจะงงว่าตัวเองเผลอกดตอนไหน
   */
  byStaff?: boolean;
}

/**
 * ชื่อที่ขึ้นบนการ์ด — เอาเฉพาะชื่อจริงคำแรก
 *
 * ช่องขวาของแถวข้อมูลบนการ์ดแคบ ชื่อเต็มแบบไทยจึงตัดบรรทัดหรือโดนตัดท้ายทิ้ง
 * และเจ้าตัวอ่านการ์ดของตัวเองอยู่แล้ว ไม่ต้องมีนามสกุลมายืนยันว่าเป็นใคร
 */
function firstName(fullName: string): string {
  return String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

/** การ์ดยืนยันการจอง พร้อมปุ่มยกเลิก */
export function bookingConfirmCard(b: ConfirmInput): LineMessage {
  const cancelUri = massageLiffUri({ cancel: b.bookingId });

  const accent = b.flash ? FLASH : GREEN;

  const body: object[] = [
    {
      type: "text",
      text: b.byStaff ? "เจ้าหน้าที่จองให้คุณ" : "จองคิวสำเร็จ",
      weight: "bold", size: "xl", color: "#333333", align: "center",
    },
    {
      type: "text",
      text: b.flash
        ? "คิวด่วน — ยกเลิกในระบบไม่ได้"
        : b.byStaff
          ? "เจ้าหน้าที่จองคิวนวดนี้ให้คุณแล้ว"
          : "บันทึกการนัดหมายของคุณเรียบร้อยแล้ว",
      size: "sm",
      color: "#AAAAAA",
      align: "center",
      margin: "sm",
      wrap: true,
    },
    { type: "separator", margin: "lg" },
    {
      type: "box",
      layout: "vertical",
      margin: "lg",
      contents: [kv("ผู้จอง", firstName(b.employeeName)), kv("วันที่", thaiDayLabel(b.day))],
    },
    { type: "separator", margin: "lg" },
    {
      type: "box",
      layout: "vertical",
      margin: "lg",
      contents: [
        { type: "text", text: "เวลานัดหมาย", size: "xs", color: "#AAAAAA", align: "center" },
        // เวลากับหมอนวดอยู่บรรทัดเดียวกัน — เป็นข้อมูลคู่กันที่ต้องอ่านพร้อมกันตอนไปถึงหน้างาน
        {
          type: "text",
          text: `${slotLabel(b.slot)} (${b.therapistName})`,
          size: "lg",
          weight: "bold",
          color: accent,
          align: "center",
          margin: "md",
          wrap: true,
        },
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
          text: b.flash
            ? "คิวด่วนยกเลิกในระบบไม่ได้ หากมาไม่ได้ ต้องหาคนมาแทนแล้วแจ้งฝ่ายบุคคล"
            : b.byStaff
              ? "หากไม่สะดวก กดปุ่มยกเลิกด้านล่างได้เอง ก่อนถึงคิว 15 นาที"
              : "หากมาไม่ได้ กรุณากดยกเลิกก่อนถึงคิว 15 นาที",
          size: "xxs",
          color: "#B0331B",
          align: "center",
          wrap: true,
        },
      ],
    },
  ];

  // ไม่มี LIFF_ID ก็ยังส่งการ์ดได้ แค่ไม่มีปุ่ม — ดีกว่าส่งปุ่มที่กดแล้วไม่เกิดอะไรขึ้น
  // คิวด่วนไม่มีปุ่มยกเลิกเลย ด้วยเหตุผลเดียวกัน กดไปก็ถูกปฏิเสธอยู่ดี
  if (cancelUri && !b.flash) {
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
    altText: `${b.byStaff ? "เจ้าหน้าที่จองคิวนวดให้คุณ" : "จองคิวนวดสำเร็จ"} · ${thaiDayLabel(b.day)} ${slotLabel(b.slot)}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: accent,
        paddingAll: "15px",
        contents: [
          {
            type: "text",
            text: b.flash ? "FLASH QUEUE BOOKED" : b.byStaff ? "BOOKED BY STAFF" : "BOOKING CONFIRMED",
            color: "#FFFFFF", size: "md", weight: "bold", gravity: "center",
          },
        ],
      },
      body: { type: "box", layout: "vertical", contents: body },
    },
  };
}

/**
 * ข้อความแจ้งเรื่องคิว — หัวเรื่อง · รายละเอียดคิว · สิ่งที่ต้องทำต่อ
 *
 * แยกบรรทัดตามหัวข้อ ไม่เอาทุกอย่างมาต่อกันด้วยจุดคั่นในบรรทัดเดียว
 * เพราะกล่องแชทของไลน์แคบ บรรทัดยาวจะถูกตัดขึ้นบรรทัดใหม่ตรงไหนก็ได้ อ่านแล้วสะดุด
 *
 * ทุกข้อความของระบบนี้ใช้รูปแบบเดียวกันหมด คนอ่านจะได้กวาดตาหาบรรทัด "เวลา" ได้ทันที
 */
export function massageNotice(
  title: string,
  day: string,
  slot: string,
  therapistName: string,
  footer: string,
): string {
  return [
    title,
    "",
    `วันที่  ${thaiDayLabel(day)}`,
    `เวลา   ${slotLabel(slot)} (${therapistName})`,
    "",
    footer,
  ].join("\n");
}

/** ข้อความยืนยันการยกเลิก — สั้น ไม่ต้องเป็นการ์ด */
export function cancelledText(day: string, slot: string, therapistName: string): string {
  return massageNotice(
    "ยกเลิกคิวนวดเรียบร้อยแล้ว",
    day,
    slot,
    therapistName,
    "สิทธิ์ของเดือนนี้ถูกคืนให้แล้ว จองรอบใหม่ได้เลย",
  );
}

