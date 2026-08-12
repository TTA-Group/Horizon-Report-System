// การเชื่อมต่อฐานข้อมูล PostgreSQL (ใช้ไลบรารี postgres — query แบบ tagged template กัน SQL injection)

import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;

/** คืน client ฐานข้อมูลแบบ singleton (reuse ข้าม invocation ที่ container ยังอุ่นอยู่) */
export function db(): ReturnType<typeof postgres> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _sql = postgres(url, {
      max: 1, // serverless: จำกัดจำนวน connection ต่อ instance
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false, // ให้ทำงานร่วมกับ connection pooler (เช่น Supabase pooler / pgbouncer) ได้
    });
  }
  return _sql;
}
