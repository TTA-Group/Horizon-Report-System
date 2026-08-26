-- เปลี่ยนกติกา: คนเดียวจองได้วันละคิวเดียว + เริ่มเปิดจองเดือนกันยายน 2569
--
-- รันกับฐานข้อมูลที่ติดตั้ง db/massage-schema.sql ไปแล้ว
-- ถ้าเป็นฐานข้อมูลใหม่ที่ยังไม่เคยรัน ไม่ต้องรันไฟล์นี้ (schema ตัวใหม่มีให้แล้ว)

-- ───────────── 1. ตรวจก่อนว่ามีใครจองซ้ำวันเดียวกันอยู่หรือไม่ ─────────────
--
-- ถ้ามี ต้องจัดการก่อน ไม่งั้นสร้างดัชนีไม่ผ่าน
-- (ปกติจะไม่มี เพราะกติกาเดิมห้ามจองซ้อนเวลาตัวเองอยู่แล้ว เหลือแค่กรณีคนละรอบในวันเดียวกัน)

SELECT e.employee_code, e.full_name, b.day, count(*) AS "จำนวนคิว"
FROM massage_bookings b
JOIN employees e ON e.id = b.employee_id
WHERE b.status = 'booked'
GROUP BY e.employee_code, e.full_name, b.day
HAVING count(*) > 1
ORDER BY b.day;

-- ถ้าคำสั่งข้างบนมีผลลัพธ์ ให้ยกเลิกคิวที่เกินออก โดยเก็บคิวที่จองก่อนไว้
-- (เอาคอมเมนต์ออกแล้วรัน แล้วค่อยไปต่อขั้นที่ 2)
--
-- UPDATE massage_bookings SET status = 'cancelled', cancelled_at = now(),
--        cancel_reason = 'ปรับตามกติกาใหม่: จองได้วันละคิวเดียว'
-- WHERE id IN (
--   SELECT id FROM (
--     SELECT id, row_number() OVER (PARTITION BY employee_id, day ORDER BY created_at) AS n
--     FROM massage_bookings WHERE status = 'booked'
--   ) t WHERE t.n > 1
-- );

-- ───────────── 2. เปลี่ยนดัชนี ─────────────

DROP INDEX IF EXISTS uq_massage_person_slot;

CREATE UNIQUE INDEX IF NOT EXISTS uq_massage_person_day
  ON massage_bookings (day, employee_id)
  WHERE status = 'booked';

-- ───────────── 3. ตั้งเดือนแรกที่เปิดให้จอง ─────────────

INSERT INTO app_settings (key, value) VALUES ('massage.start_month', '2026-09')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- ───────────── 4. ล้างวันของเดือนก่อนหน้าที่ระบบสร้างไว้แล้ว ─────────────
--
-- ลบเฉพาะวันที่ยังไม่มีใครจอง วันที่มีคิวอยู่จะไม่ถูกแตะ

DELETE FROM massage_days d
WHERE d.day < DATE '2026-09-01'
  AND NOT EXISTS (SELECT 1 FROM massage_bookings b WHERE b.day = d.day);

-- ───────────── 5. ตรวจผล ─────────────

SELECT 'ดัชนีวันละคิวเดียว' AS "รายการ",
       CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_massage_person_day')
            THEN 'มีแล้ว' ELSE 'ยังไม่มี' END AS "สถานะ"
UNION ALL
SELECT 'ดัชนีเดิม (ต้องหายไปแล้ว)',
       CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_massage_person_slot')
            THEN 'ยังอยู่' ELSE 'ลบแล้ว' END
UNION ALL
SELECT 'เดือนแรกที่เปิดจอง', COALESCE((SELECT value FROM app_settings WHERE key = 'massage.start_month'), 'ยังไม่ได้ตั้ง')
UNION ALL
SELECT 'วันให้บริการก่อน ก.ย. ที่เหลืออยู่', count(*)::text FROM massage_days WHERE day < DATE '2026-09-01';
