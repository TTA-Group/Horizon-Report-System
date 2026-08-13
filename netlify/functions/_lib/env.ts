// การอ่านค่าตั้งค่า (environment variables) ให้ทำงานได้ทั้งบน Netlify และ Cloudflare Workers
//
// Netlify (Node.js)   : ค่าอยู่ใน process.env
// Cloudflare Workers  : ค่าถูกส่งเข้ามาเป็นอาร์กิวเมนต์ `env` ของ fetch/scheduled ไม่มี process.env
//
// ตัวจัดการคำขอฝั่ง Worker จะเรียก setEnv(env) ก่อนเสมอ ส่วนโค้ดส่วนอื่นเรียก envVar() ได้เหมือนกันหมด
// ไม่ต้องส่ง env ต่อกันเป็นทอด ๆ ทุกฟังก์ชัน
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

  // Node.js (Netlify) — เข้าถึงแบบระวังไม่ให้พังบน runtime ที่ไม่มี process
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromNode = proc?.env?.[key];
  return fromNode !== undefined && fromNode !== "" ? fromNode : undefined;
}
