-- รายชื่อคนที่ผู้ดูแลสั่ง "ถอด rich menu" ไว้ — ปุ่มเปลี่ยนเมนูให้ทุกคนต้องข้ามคนกลุ่มนี้
--
-- เดิมการถอดเมนูสั่ง LINE อย่างเดียว ไม่ได้จดไว้ที่ไหน พอกดปุ่มเปลี่ยนเมนูให้ทุกคนรอบถัดไป
-- คนที่เพิ่งถอดไปก็ได้เมนูกลับมาทันที เท่ากับปุ่มถอดไม่มีผลอะไรเลยในทางปฏิบัติ
--
-- รันครั้งเดียว รันซ้ำก็ไม่เสียหาย

BEGIN;

CREATE TABLE IF NOT EXISTS richmenu_excluded (
  line_user_id VARCHAR(64)  PRIMARY KEY,
  -- เก็บไว้เพื่อโชว์ชื่อในหน้าจอ ถ้าพนักงานถูกลบทิ้งก็ยังกันเมนูไว้เหมือนเดิม
  employee_id  UUID         REFERENCES employees(id) ON DELETE SET NULL,
  excluded_by  UUID         REFERENCES employees(id),
  excluded_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMIT;

-- ตรวจผล — ต้องขึ้นว่า มีแล้ว
SELECT 'ตารางรายชื่อที่ถูกถอดเมนู' AS "รายการ",
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'richmenu_excluded'
       ) THEN 'มีแล้ว' ELSE 'ยังไม่มี — ผิดปกติ' END AS "ผล"
UNION ALL
SELECT 'ตอนนี้ถอดเมนูไว้กี่คน', count(*)::text FROM richmenu_excluded;
