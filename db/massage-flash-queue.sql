-- Flash Queue — คิวด่วนที่เปิดให้จองเกินสิทธิ์ในวันที่ใกล้ถึง
--
-- สำหรับฐานข้อมูลที่ติดตั้ง db/massage-schema.sql ไปแล้วก่อนมีฟีเจอร์นี้
-- ฐานข้อมูลใหม่ที่ยังไม่เคยรัน ไม่ต้องรันไฟล์นี้ — schema ตัวปัจจุบันมีให้แล้ว
--
-- รันครั้งเดียว รันซ้ำก็ไม่เสียหาย

BEGIN;

-- แยกให้ออกว่าคิวไหนใช้สิทธิ์ 2 ครั้ง/เดือน คิวไหนเป็นคิวด่วนที่ไม่นับสิทธิ์
-- ถ้าไม่แยก การนับสิทธิ์จะเพี้ยนทันทีที่มีคนจองคิวด่วน และรายงานจะบอกไม่ได้ว่าใครใช้อะไรไป
ALTER TABLE massage_bookings
  ADD COLUMN IF NOT EXISTS kind VARCHAR(8) NOT NULL DEFAULT 'quota';

-- คิวเดิมทั้งหมดเกิดก่อนมีคิวด่วน จึงเป็นคิวสิทธิ์ทั้งหมด (ค่าตั้งต้นจัดการให้แล้ว)
CREATE INDEX IF NOT EXISTS idx_massage_kind ON massage_bookings (employee_id, kind, day);

COMMIT;

-- ตรวจผล — ต้องขึ้นว่า มีแล้ว
SELECT 'ช่องแยกคิวสิทธิ์/คิวด่วน' AS "รายการ",
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'massage_bookings' AND column_name = 'kind'
       ) THEN 'มีแล้ว' ELSE 'ยังไม่มี — ผิดปกติ' END AS "ผล"
UNION ALL
SELECT 'คิวที่เป็นคิวสิทธิ์', count(*)::text FROM massage_bookings WHERE kind = 'quota'
UNION ALL
SELECT 'คิวที่เป็นคิวด่วน', count(*)::text FROM massage_bookings WHERE kind = 'flash';
