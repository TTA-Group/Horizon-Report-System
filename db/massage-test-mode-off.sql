-- ปิดโหมดทดลอง: ล้างคิวที่ใช้ทดสอบ แล้วคืนค่าให้ระบบเริ่มเปิดจริงเดือนกันยายน 2569
--
-- ลบเฉพาะของก่อนวันที่ 1 กันยายน 2569 ซึ่งเป็นช่วงที่ยังไม่เปิดใช้จริง

BEGIN;

-- 1) ลบคิวที่จองไว้ตอนทดลองทิ้ง (ลบจริง เพราะเป็นข้อมูลทดสอบ ไม่ใช่ประวัติที่ต้องเก็บ)
DELETE FROM massage_bookings WHERE day < DATE '2026-09-01';

-- 2) ลบวันที่ใส่ไว้ตอนทดลอง
DELETE FROM massage_days WHERE day < DATE '2026-09-01';

-- 3) คืนค่าเดือนแรกที่เปิดให้จอง
UPDATE app_settings SET value = '2026-09', updated_at = now() WHERE key = 'massage.start_month';

COMMIT;

-- 4) ตรวจผล — ต้องได้ 2026-09 · 0 · 0
SELECT (SELECT value FROM app_settings WHERE key = 'massage.start_month') AS "เดือนแรกที่เปิดจอง",
       (SELECT count(*) FROM massage_days     WHERE day < DATE '2026-09-01') AS "วันทดลองที่เหลือ",
       (SELECT count(*) FROM massage_bookings WHERE day < DATE '2026-09-01') AS "คิวทดลองที่เหลือ";
