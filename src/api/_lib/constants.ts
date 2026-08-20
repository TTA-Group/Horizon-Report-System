// ค่าคงที่ของระบบ (อ้างอิง spec.md หัวข้อ 4)

import { envVar } from "./env";

export const CHANNEL_KEY = "report";

/**
 * ฝ่ายที่ให้สิทธิ์ผู้ดูแลระบบ — ใครอยู่ในฝ่ายนี้จะเห็นและใช้หน้า "ผู้ดูแล" ได้
 * เก็บเป็นฝ่ายในฐานข้อมูลแทนรายชื่อในไฟล์ตั้งค่า เพราะการเพิ่ม/ถอดคน HR เป็นงานประจำของ HR เอง
 * ไม่ควรต้องรอคนที่เข้าถึงหน้าตั้งค่าของ Cloudflare ได้มาแก้ให้ทุกครั้ง
 */
export const ADMIN_DEPARTMENT_CODE = "HR";

export type UrgencyCode = "normal" | "urgent" | "critical";
export type StatusCode = "pending" | "in_progress" | "completed" | "closed" | "cancelled";

export interface CategoryDef {
  code: string; // category_code ที่ client ส่งมา
  label: string; // ชื่อที่แสดง
  deptCode: string; // รหัสฝ่ายปลายทาง
  prefix: string; // คำนำหน้าเลขที่เรื่อง
}

// หมายเหตุ: หมวด FAC ส่งไปฝ่าย Admin (ADM) และใช้คำนำหน้าเลขที่เรื่อง ADM- ตาม spec หัวข้อ 4
//
// หมวด CLN ก็ส่งไปฝ่าย Admin เช่นกัน (ต่างจาก spec หัวข้อ 4 ที่แยกเป็นฝ่าย CLN) เพราะที่หน้างานจริง
// งานระบบปรับอากาศกับงานแม่บ้านเป็นทีมเดียวกัน จึงให้เข้าคิวเดียวไม่ต้องสลับดู 2 ที่
// ผู้แจ้งยังเลือกได้ 2 หมวดเหมือนเดิม และเลขที่เรื่องยังแยกคำนำหน้า (ADM- / CLN-) จึงดูออกว่างานประเภทไหน
// ถ้าอนาคตแยกทีมกัน: เปลี่ยน deptCode กลับเป็น "CLN" แล้วเปิด is_active ของฝ่าย CLN ในฐานข้อมูล
export const CATEGORIES: CategoryDef[] = [
  { code: "IT", label: "IT Support / Help Desk", deptCode: "IT", prefix: "IT" },
  { code: "FAC", label: "ระบบปรับอากาศ ประปา ไฟฟ้า", deptCode: "ADM", prefix: "ADM" },
  { code: "CLN", label: "งานแม่บ้านและความสะอาด", deptCode: "ADM", prefix: "CLN" },
  { code: "GEN", label: "เรื่องอื่น ๆ", deptCode: "GEN", prefix: "GEN" },
];
export const CATEGORY_BY_CODE = new Map(CATEGORIES.map((c) => [c.code, c]));

// ชั้นที่มีคนทำงานอยู่จริงตามทะเบียนพนักงาน — เรียงจากบนลงล่าง
// ชั้นที่ไม่อยู่ในรายการนี้ (ลานจอดรถ ดาดฟ้า ชั้นใต้ดิน) แจ้งได้ผ่านตัวเลือก "ชั้นอื่น" ในฟอร์ม
export const FLOORS = ["ชั้น 15", "ชั้น 12A", "ชั้น 9", "ชั้น 8", "ชั้น 7", "ชั้น 5", "ชั้นลอย"];

export const URGENCIES: { code: UrgencyCode; label: string; note: string }[] = [
  { code: "normal", label: "ปกติ", note: "ภายใน 3 วันทำการ" },
  { code: "urgent", label: "เร่งด่วน", note: "ภายในวันนี้" },
  { code: "critical", label: "เร่งด่วนมาก", note: "กระทบการทำงาน" },
];
export const URGENCY_CODES = new Set<string>(URGENCIES.map((u) => u.code));

/**
 * กรอบเวลาที่ผู้รับผิดชอบเลือกได้ตอนแจ้งผลตรวจสอบ
 *
 * ต้องเป็นตัวเลือกให้กด ไม่ใช่ช่องให้พิมพ์ เพราะระบบต้องเอาไปเทียบเวลาจริงเพื่อทวงเมื่อเลยกำหนด
 * ข้อความอย่าง "ประมาณอาทิตย์หน้า" ระบบไม่รู้ว่าคือวันไหน จึงทวงต่อไม่ได้
 *
 * chip = คำบนปุ่ม (สั้นให้พอดีแถว) · label = คำที่เก็บและแสดงบนการ์ด (เต็มความหมาย)
 * งานทั้งหมดที่นับเป็นวันไปจบที่ 18:00 ของวันนั้นตามเวลาไทย คือสิ้นวันทำงาน
 */
export interface DueOption {
  key: string;
  chip: string;
  label: string;
  hours?: number;
  days?: number;
  /** endOfDay = 18:00 วันนี้ · pick = ให้เลือกวันจากปฏิทิน · wait = รออะไหล่ (บังคับเลือกวัน) */
  special?: "endOfDay" | "pick" | "wait";
}

export const DUE_OPTIONS: DueOption[] = [
  { key: "h1", chip: "1 ชั่วโมง", label: "ภายใน 1 ชั่วโมง", hours: 1 },
  { key: "d0", chip: "วันนี้", label: "ภายในวันนี้", special: "endOfDay" },
  { key: "d1", chip: "พรุ่งนี้", label: "ภายในพรุ่งนี้", days: 1 },
  { key: "d3", chip: "3 วัน", label: "ภายใน 3 วัน", days: 3 },
  { key: "d7", chip: "7 วัน", label: "ภายใน 7 วัน", days: 7 },
  { key: "d14", chip: "14 วัน", label: "ภายใน 14 วัน", days: 14 },
  { key: "d30", chip: "30 วัน", label: "ภายใน 30 วัน", days: 30 },
  { key: "pick", chip: "เลือกวันเอง", label: "ตามวันที่กำหนด", special: "pick" },
  { key: "wait", chip: "รออะไหล่ / ผู้รับเหมา", label: "รออะไหล่ / ผู้รับเหมา", special: "wait" },
];
export const DUE_BY_KEY = new Map(DUE_OPTIONS.map((d) => [d.key, d]));

/** แถวของชิปบนการ์ดถามกำหนดเสร็จ — Flex ตัดบรรทัดเองไม่ได้ ต้องจัดแถวมาให้ */
export const DUE_ROWS: string[][] = [
  ["h1", "d0", "d1"],
  ["d3", "d7", "d14", "d30"],
  ["pick"],
  ["wait"],
];

export const STATUS_LABELS: Record<StatusCode, string> = {
  pending: "รอรับเรื่อง",
  in_progress: "กำลังดำเนินการ",
  completed: "ดำเนินการแล้วเสร็จ",
  closed: "ปิดเรื่อง",
  cancelled: "ยกเลิก",
};

// การเปลี่ยนสถานะที่อนุญาต (spec หัวข้อ 4)
//
// ต่างจาก spec เดิม 2 ข้อ ตามการใช้งานจริง:
//   - in_progress -> cancelled ได้ เพราะบางทีรับเรื่องไปแล้วถึงรู้ว่าแจ้งซ้ำ หรือหน้างานแก้เองไปแล้ว
//   - completed คือจุดจบ ไม่มีขั้น "ปิดเรื่อง" ต่อท้ายอีก — การให้คนมากดปิดซ้ำอีกครั้งไม่ได้เพิ่ม
//     ข้อมูลอะไร มีแต่ทำให้งานที่เสร็จแล้วค้างอยู่ในคิวเพราะยังไม่มีใครมากดปิด
//     คงค่า closed ไว้ในระบบเพื่อให้เรื่องเก่าที่เคยปิดไปแล้วยังแสดงผลได้ถูกต้อง
export const STATUS_TRANSITIONS: Record<StatusCode, StatusCode[]> = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["completed", "pending", "cancelled"],
  completed: ["in_progress"],
  closed: [],
  cancelled: [],
};

/** รหัสพนักงานที่มีสิทธิ์ผู้ดูแลระบบ อ่านจาก env */
export function adminCodes(): Set<string> {
  return new Set(
    (envVar("ADMIN_EMPLOYEE_CODES") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
