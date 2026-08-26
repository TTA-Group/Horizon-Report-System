-- ปรับฐานข้อมูลระบบจองคิวนวด: จองได้วันละคิวเดียว + เริ่มเปิดจองเดือนกันยายน 2569
--
-- สำหรับฐานข้อมูลที่รัน db/massage-schema.sql ไปแล้วก่อนมีกติกานี้
-- ฐานข้อมูลใหม่ที่ยังไม่เคยรัน ไม่ต้องรันไฟล์นี้ — schema ตัวปัจจุบันมีให้ครบแล้ว
--
-- รันครั้งเดียว รันซ้ำก็ไม่เสียหาย (ทุกคำสั่งกันการรันซ้ำไว้แล้ว)
-- ทุกอย่างอยู่ในธุรกรรมเดียว ถ้าพังกลางทางจะย้อนกลับทั้งหมด ไม่ทิ้งงานค้างครึ่ง ๆ กลาง ๆ

BEGIN;

-- 1) ถ้ามีใครจองไว้หลายคิวในวันเดียวกัน (กติกาเดิมยอมให้) ให้เก็บคิวแรกไว้ ที่เหลือยกเลิก
--    ไม่ลบแถวทิ้ง เปลี่ยนเป็นสถานะยกเลิกและจดเหตุผลไว้ จะได้ตามย้อนหลังได้
UPDATE massage_bookings SET
  status        = 'cancelled',
  cancelled_at  = now(),
  cancel_reason = 'ปรับตามกติกาใหม่: จองได้วันละคิวเดียว',
  updated_at    = now()
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY employee_id, day ORDER BY created_at) AS n
    FROM massage_bookings WHERE status = 'booked'
  ) t WHERE t.n > 1
);

-- 2) เปลี่ยนกติกาที่ตัวฐานข้อมูล จากห้ามซ้อนรอบเดียวกัน เป็นห้ามซ้ำวันเดียวกัน
--    บังคับที่ดัชนี ไม่ใช่ที่โค้ด เพราะถ้าสองคำขอมาพร้อมกันเป๊ะ ๆ โค้ดกันไม่ทัน แต่ดัชนีกันได้เสมอ
DROP INDEX IF EXISTS uq_massage_person_slot;

CREATE UNIQUE INDEX IF NOT EXISTS uq_massage_person_day
  ON massage_bookings (day, employee_id)
  WHERE status = 'booked';

-- 3) เดือนแรกที่เปิดให้จอง — เดือนก่อนหน้านี้ระบบจะบอกว่า "เปิดเมื่อไหร่" แทนที่จะให้จอง
INSERT INTO app_settings (key, value) VALUES ('massage.start_month', '2026-09')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- 4) ลบวันให้บริการก่อนกันยายนที่ระบบเผลอสร้างไว้ตอนทดลอง
--    ลบเฉพาะวันที่ยังไม่มีใครจอง วันที่มีคิวอยู่ไม่แตะ
DELETE FROM massage_days d
WHERE d.day < DATE '2026-09-01'
  AND NOT EXISTS (SELECT 1 FROM massage_bookings b WHERE b.day = d.day);

COMMIT;

-- 5) ตรวจผล — ต้องได้ครบทั้ง 4 บรรทัดตามที่เขียนไว้ในวงเล็บ
SELECT 'ห้ามจองซ้ำวันเดียวกัน (ต้องขึ้นว่า มีแล้ว)' AS "รายการ",
       CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_massage_person_day')
            THEN 'มีแล้ว' ELSE 'ยังไม่มี — ผิดปกติ' END AS "ผล"
UNION ALL
SELECT 'กติกาเดิม (ต้องขึ้นว่า ลบแล้ว)',
       CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_massage_person_slot')
            THEN 'ยังอยู่ — ผิดปกติ' ELSE 'ลบแล้ว' END
UNION ALL
SELECT 'เดือนแรกที่เปิดจอง (ต้องขึ้นว่า 2026-09)',
       COALESCE((SELECT value FROM app_settings WHERE key = 'massage.start_month'), 'ยังไม่ได้ตั้ง — ผิดปกติ')
UNION ALL
SELECT 'คิวที่ถูกยกเลิกเพราะกติกาใหม่ (ปกติคือ 0)',
       (SELECT count(*)::text FROM massage_bookings
        WHERE cancel_reason = 'ปรับตามกติกาใหม่: จองได้วันละคิวเดียว');
