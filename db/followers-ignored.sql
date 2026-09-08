-- รายชื่อผู้ไม่เกี่ยวข้อง — บัญชีไลน์ที่ฝ่ายบุคคลตัดสินแล้วว่าไม่ใช่พนักงาน ไม่ต้องผูกรหัส
--
-- สำหรับฐานข้อมูลที่รัน db/schema.sql ไปแล้วก่อนมีปุ่มนี้
-- ฐานข้อมูลใหม่ที่ยังไม่เคยรัน ไม่ต้องรันไฟล์นี้ — schema ตัวปัจจุบันมีให้แล้ว
--
-- รันครั้งเดียว รันซ้ำก็ไม่เสียหาย

BEGIN;

-- ทำเครื่องหมายบนแถวเดิม ไม่แยกตารางใหม่ เพราะเป็นสถานะของคนคนเดียวกัน
-- ถ้าแยกตาราง ทุกที่ที่ดึงรายชื่อผู้ติดตามต้อง join เพิ่มอีกหนึ่งตาราง แล้ววันหนึ่งจะมีที่ที่ลืม join
-- กลายเป็นคนที่กดไม่เกี่ยวข้องไปแล้วโผล่กลับมาในรายการรอผูกอีก
--
-- เก็บว่าใครกดและกดเมื่อไหร่ เพราะเป็นการตัดคนออกจากระบบ ต้องตามย้อนหลังได้ว่าใครตัดสิน
ALTER TABLE line_followers
  ADD COLUMN IF NOT EXISTS ignored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ignored_by UUID REFERENCES employees(id);

COMMIT;

-- ตรวจผล — ต้องขึ้นว่า มีแล้ว
SELECT 'ช่องรายชื่อผู้ไม่เกี่ยวข้อง' AS "รายการ",
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'line_followers' AND column_name = 'ignored_at'
       ) THEN 'มีแล้ว' ELSE 'ยังไม่มี — ผิดปกติ' END AS "ผล"
UNION ALL
SELECT 'ตอนนี้อยู่ในรายชื่อผู้ไม่เกี่ยวข้อง', count(*)::text
  FROM line_followers WHERE ignored_at IS NOT NULL;
