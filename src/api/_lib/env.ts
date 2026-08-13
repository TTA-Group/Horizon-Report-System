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

/** อ่านค่าตั้งค่าหนึ่งตัว — คืน undefined ถ้าไม่ได้ตั้งไว้ */
export function envVar(key: string): string | undefined {
  const fromWorker = RUNTIME_ENV?.[key];
  if (typeof fromWorker === "string" && fromWorker !== "") return fromWorker;

  // เผื่อรันนอก Worker (เช่น สคริปต์ทดสอบ) — เข้าถึงแบบระวังไม่ให้พังบน runtime ที่ไม่มี process
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromNode = proc?.env?.[key];
  return fromNode !== undefined && fromNode !== "" ? fromNode : undefined;
}
