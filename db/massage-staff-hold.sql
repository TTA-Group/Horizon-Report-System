-- STAFF ล็อกคิว — ให้ผู้ดูแลกดจองช่องว่างเก็บไว้ก่อน แล้วค่อยโอนให้คนจริงทีหลัง
--
-- สำหรับฐานข้อมูลที่รัน db/massage-schema.sql ไปแล้วก่อนมีเรื่องนี้
-- ฐานข้อมูลใหม่ที่ยังไม่เคยรัน ไม่ต้องรันไฟล์นี้ — schema ตัวปัจจุบันมีให้แล้ว
--
-- รันครั้งเดียว รันซ้ำก็ไม่เสียหาย

BEGIN;

-- 1. พนักงานเงา ชื่อ STAFF รหัส 00000
--
-- ไม่ผูกบัญชีไลน์ ระบบจึงไม่ส่งข้อความหาใครเวลาล็อกช่อง (ตัวส่งข้ามแถวที่ไม่มีบัญชีอยู่แล้ว)
-- และไม่ต้องมีตัวตนจริงในบริษัท เป็นแค่ชื่อไว้ถือช่องที่ยังไม่รู้ว่าจะให้ใคร
INSERT INTO employees (employee_code, full_name, department_name, source, status)
VALUES ('00000', 'STAFF', 'ล็อกคิว', 'directory', 'active')
ON CONFLICT (employee_code) DO UPDATE
  SET full_name = 'STAFF', status = 'active';

-- 2. ปลดกติกา "วันละคิวเดียว" ให้เฉพาะช่องที่ล็อกไว้
--
-- ต้องสร้างตัวใหม่ก่อนแล้วค่อยลบตัวเก่า ไม่งั้นระหว่างนั้นจะไม่มีอะไรกันคนจองซ้ำวันเดียวกัน
-- ชื่อชั่วคราวเพื่อไม่ให้ชนกับตัวเดิม แล้วค่อยเปลี่ยนชื่อตอนท้าย
CREATE UNIQUE INDEX IF NOT EXISTS uq_massage_person_day_new
  ON massage_bookings (day, employee_id)
  WHERE status = 'booked' AND kind <> 'hold';

DROP INDEX IF EXISTS uq_massage_person_day;
ALTER INDEX uq_massage_person_day_new RENAME TO uq_massage_person_day;

COMMIT;

-- ตรวจผล — ต้องขึ้นว่า มีแล้ว ทั้งสองบรรทัด
SELECT 'พนักงาน STAFF (00000)' AS "รายการ",
       CASE WHEN EXISTS (SELECT 1 FROM employees WHERE employee_code = '00000')
            THEN 'มีแล้ว' ELSE 'ยังไม่มี — ผิดปกติ' END AS "ผล"
UNION ALL
SELECT 'กติกาวันละคิวเดียว ยกเว้นช่องที่ล็อก',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE indexname = 'uq_massage_person_day' AND indexdef LIKE '%hold%'
       ) THEN 'มีแล้ว' ELSE 'ยังไม่มี — ผิดปกติ' END
UNION ALL
SELECT 'ช่องที่ล็อกไว้ตอนนี้', count(*)::text FROM massage_bookings
 WHERE kind = 'hold' AND status = 'booked';
