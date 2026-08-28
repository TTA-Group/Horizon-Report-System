// การอ่านค่าตั้งค่า (environment variables)
//
// บน Cloudflare Workers ค่าถูกส่งเข้ามาเป็นอาร์กิวเมนต์ `env` ของ fetch/scheduled ไม่ใช่ process.env
// จุดเข้าของ Worker จะเรียก setEnv(env) ก่อนเสมอ ส่วนโค้ดที่เหลือเรียก envVar() ได้เหมือนกันหมด
// ไม่ต้องส่ง env ต่อกันเป็นทอด ๆ ทุกฟังก์ชัน (ยังอ่าน process.env ได้ด้วย เผื่อรันนอก Worker)
//
// หมายเหตุเรื่องความปลอดภัยของค่าที่ใช้ร่วมกัน: ค่า env ของทุกคำขอใน deployment เดียวกันเหมือนกันหมด
// การเขียนทับตัวแปรระดับโมดูลจากหลายคำขอพร้อมกันจึงได้ค่าเดิมเสมอ ไม่เกิดการปนกันของข้อมูล

type EnvBag = Record<string, unknown>;

let RUNTIME_ENV: EnvBag | null = null;

/** ผูกค่า env ของ Worker เข้ากับ runtime (เรียกครั้งแรกของทุกคำขอ) */
export function setEnv(env: EnvBag | null | undefined): void {
  if (env) RUNTIME_ENV = env;
}

/** อ่าน binding ที่ไม่ใช่ข้อความ (เช่น version_metadata ที่เป็นอ็อบเจ็กต์) */
export function envBinding<T>(key: string): T | undefined {
  const v = RUNTIME_ENV?.[key];
  return v === undefined || v === null ? undefined : (v as T);
}

/**
 * อ่านค่าตั้งค่าหนึ่งตัว — คืน undefined ถ้าไม่ได้ตั้งไว้
 *
 * ตัดช่องว่างและบรรทัดใหม่หัว-ท้ายทิ้งเสมอ เพราะการวางค่าลงช่องกรอกของ Cloudflare
 * มักติดอักขระที่มองไม่เห็นมาด้วย แล้วค่าจะ "มีอยู่" แต่ใช้ไม่ได้
 *
 * เคยทำให้ระบบล่มมาแล้ว: LINE_LOGIN_CHANNEL_ID ที่ติด newline ทำให้ผู้ใช้ทุกคน
 * เข้าระบบไม่ได้พร้อมกัน โดย /api/health ยังรายงานว่าตัวแปรนั้น "ตั้งไว้แล้ว"
 * เพราะมันดูแค่ว่ามีค่าหรือไม่ ไม่มีค่าไหนในระบบนี้ที่ต้องการช่องว่างหัวหรือท้าย
 */
export function envVar(key: string): string | undefined {
  const fromWorker = RUNTIME_ENV?.[key];
  if (typeof fromWorker === "string" && fromWorker.trim() !== "") return fromWorker.trim();

  // เผื่อรันนอก Worker (เช่น สคริปต์ทดสอบ) — เข้าถึงแบบระวังไม่ให้พังบน runtime ที่ไม่มี process
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromNode = proc?.env?.[key]?.trim();
  return fromNode !== undefined && fromNode !== "" ? fromNode : undefined;
}

