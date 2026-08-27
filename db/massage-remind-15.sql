-- เพิ่มการเตือนซ้ำก่อนถึงคิว 15 นาที
--
-- สำหรับฐานข้อมูลที่ติดตั้ง db/massage-schema.sql ไปแล้วก่อนมีการเตือนรอบนี้
-- ฐานข้อมูลใหม่ที่ยังไม่เคยรัน ไม่ต้องรันไฟล์นี้ — schema ตัวปัจจุบันมีคอลัมน์นี้แล้ว
--
-- รันครั้งเดียว รันซ้ำก็ไม่เสียหาย

BEGIN;

-- เก็บ "เตือนรอบ 15 นาทีไปแล้วเมื่อไหร่" แยกจากรอบครึ่งชั่วโมง
-- ถ้าใช้คอลัมน์เดียวกัน พอเตือนรอบแรกไปแล้วรอบ 15 นาทีจะไม่มีทางได้ส่ง
ALTER TABLE massage_bookings ADD COLUMN IF NOT EXISTS remind_15_at TIMESTAMPTZ;

COMMIT;

-- ตรวจผล — ต้องขึ้นว่า มีแล้ว
SELECT 'คอลัมน์เตือน 15 นาที' AS "รายการ",
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'massage_bookings' AND column_name = 'remind_15_at'
       ) THEN 'มีแล้ว' ELSE 'ยังไม่มี — ผิดปกติ' END AS "ผล";
