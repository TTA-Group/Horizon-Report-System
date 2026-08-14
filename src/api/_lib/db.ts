// การเชื่อมต่อฐานข้อมูล PostgreSQL (ใช้ไลบรารี postgres — query แบบ tagged template กัน SQL injection)
//
// ข้อจำกัดสำคัญของ Cloudflare Workers: การเชื่อมต่อที่เปิดไว้ในคำขอหนึ่ง เอาไปใช้ในอีกคำขอหนึ่งไม่ได้
// รันไทม์จะโยนข้อผิดพลาด "Cannot perform I/O on behalf of a different request" ออกมานอกโค้ดเรา
// (จับไม่ได้ด้วยตัวดักจับปกติ จึงเห็นเป็น 500 เปล่า ๆ) — ดังนั้นจึงเก็บ client ไว้ "ต่อคำขอ" แทน
// ต่อ instance ภายในคำขอเดียวกัน ทุกจุดที่เรียก db() ยังได้ตัวเดิมร่วมกัน แล้วปิดให้เมื่อจบคำขอ

import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { envVar } from "./env";

type Sql = ReturnType<typeof postgres>;

interface Scope {
  sql: Sql | null;
}

const scope = new AsyncLocalStorage<Scope>();

function createClient(): Sql {
  const url = envVar("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, {
    max: 1, // serverless: จำกัดจำนวน connection ต่อ instance
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // ให้ทำงานร่วมกับ connection pooler (เช่น Supabase pooler / pgbouncer) ได้
  });
}

/** คืน client ฐานข้อมูลของคำขอปัจจุบัน (สร้างเมื่อถูกเรียกครั้งแรก แล้วใช้ซ้ำภายในคำขอนั้น) */
export function db(): Sql {
  const current = scope.getStore();
  if (!current) return createClient(); // นอกบริบทคำขอ เช่น สคริปต์ทดสอบ
  if (!current.sql) current.sql = createClient();
  return current.sql;
}

/** ครอบการทำงานหนึ่งคำขอ เพื่อให้ db() ได้ connection ของคำขอนั้นเอง และปิดให้เมื่อทำงานเสร็จ */
export async function withDbScope<T>(fn: () => Promise<T>): Promise<T> {
  const current: Scope = { sql: null };
  return scope.run(current, async () => {
    try {
      return await fn();
    } finally {
      if (current.sql) {
        try {
          await current.sql.end({ timeout: 5 });
        } catch (e) {
          console.error("[db] ปิดการเชื่อมต่อไม่สำเร็จ", e);
        }
      }
    }
  });
}
