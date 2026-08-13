// ค่าคงที่ของระบบ (อ้างอิง spec.md หัวข้อ 4)

export const CHANNEL_KEY = "report";

export type UrgencyCode = "normal" | "urgent" | "critical";
export type StatusCode = "pending" | "in_progress" | "completed" | "closed" | "cancelled";

export interface CategoryDef {
  code: string; // category_code ที่ client ส่งมา
  label: string; // ชื่อที่แสดง
  deptCode: string; // รหัสฝ่ายปลายทาง
  prefix: string; // คำนำหน้าเลขที่เรื่อง
}

// หมายเหตุ: หมวด FAC ส่งไปฝ่าย Admin (ADM) และใช้คำนำหน้าเลขที่เรื่อง ADM- ตาม spec หัวข้อ 4
export const CATEGORIES: CategoryDef[] = [
  { code: "IT", label: "IT Support / Help Desk", deptCode: "IT", prefix: "IT" },
  { code: "FAC", label: "ระบบปรับอากาศ ประปา ไฟฟ้า", deptCode: "ADM", prefix: "ADM" },
  { code: "CLN", label: "งานแม่บ้านและความสะอาด", deptCode: "CLN", prefix: "CLN" },
  { code: "GEN", label: "เรื่องอื่น ๆ", deptCode: "GEN", prefix: "GEN" },
];
export const CATEGORY_BY_CODE = new Map(CATEGORIES.map((c) => [c.code, c]));

export const FLOORS = ["ชั้น 15", "ชั้น 9", "ชั้น 8", "ชั้น 7", "ชั้น 5", "ชั้นลอย"];

export const URGENCIES: { code: UrgencyCode; label: string; note: string }[] = [
  { code: "normal", label: "ปกติ", note: "ภายใน 3 วันทำการ" },
  { code: "urgent", label: "เร่งด่วน", note: "ภายในวันนี้" },
  { code: "critical", label: "เร่งด่วนมาก", note: "กระทบการทำงาน แจ้งรายบุคคลเพิ่ม" },
];
export const URGENCY_CODES = new Set<string>(URGENCIES.map((u) => u.code));

export const STATUS_LABELS: Record<StatusCode, string> = {
  pending: "รอรับเรื่อง",
  in_progress: "กำลังดำเนินการ",
  completed: "ดำเนินการแล้วเสร็จ",
  closed: "ปิดเรื่อง",
  cancelled: "ยกเลิก",
};

// การเปลี่ยนสถานะที่อนุญาต (spec หัวข้อ 4)
export const STATUS_TRANSITIONS: Record<StatusCode, StatusCode[]> = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["completed", "pending"],
  completed: ["closed", "in_progress"],
  closed: [],
  cancelled: [],
};

/**
 * โดเมนอีเมลของบริษัท (คั่นด้วยจุลภาคได้ถ้ามีหลายโดเมน) เช่น "thoresen.com"
 * ใช้เป็นด่านกรองตอนผู้ใช้กรอกข้อมูลเอง — ถ้าไม่ตั้งค่าไว้ ระบบจะไม่ตรวจสอบโดเมน
 */
export function companyEmailDomains(): string[] {
  return (process.env.COMPANY_EMAIL_DOMAIN ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/** อีเมลนี้อยู่ในโดเมนของบริษัทหรือไม่ (ไม่ได้ตั้งค่าโดเมนไว้ = ผ่านทุกกรณี) */
export function isCompanyEmail(email: string): boolean {
  const domains = companyEmailDomains();
  if (domains.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return false;
  return domains.includes(email.slice(at + 1).trim().toLowerCase());
}

/** รหัสพนักงานที่มีสิทธิ์ผู้ดูแลระบบ อ่านจาก env */
export function adminCodes(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMPLOYEE_CODES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
