-- โหมดทดลอง: เปิดให้จองในเดือนปัจจุบัน (ปกติระบบจะเริ่มเปิดจริงเดือนกันยายน 2569)
--
-- ใช้ทดสอบก่อนเปิดใช้จริงเท่านั้น พอทดสอบเสร็จให้รันชุด "ปิดโหมดทดลอง" เพื่อคืนค่าเดิม

BEGIN;

-- 1) ให้เดือนปัจจุบันเปิดจองได้
UPDATE app_settings
   SET value = to_char((now() AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM'), updated_at = now()
 WHERE key = 'massage.start_month';

-- 2) ใส่วันให้บริการสำหรับทดลอง 2 วันข้างหน้า
--    ต้องมีอย่างน้อย 2 วัน ถึงจะทดสอบสิทธิ์ 2 ครั้งต่อเดือนกับกติกาวันละคิวเดียวได้ครบ
--    (ปกติระบบสร้างเฉพาะวันศุกร์ให้เอง ตรงนี้ใส่มือเพื่อให้มีวันทดลองพอ)
INSERT INTO massage_days (day)
SELECT d::date FROM generate_series(
  (now() AT TIME ZONE 'Asia/Bangkok')::date + 1,
  (now() AT TIME ZONE 'Asia/Bangkok')::date + 2, '1 day') AS d
ON CONFLICT (day) DO UPDATE SET status = 'open', closed_reason = NULL;

COMMIT;

-- 3) ตรวจผล — ต้องเห็นวันที่เปิดให้ทดลองอย่างน้อย 2 วัน
SELECT to_char(day, 'DD/MM/YYYY') AS "วันที่เปิดให้จอง", status AS "สถานะ"
FROM massage_days
WHERE day >= (now() AT TIME ZONE 'Asia/Bangkok')::date
ORDER BY day;
