-- แม่แบบสำหรับนำเข้ารายชื่อพนักงานเป็นชุดจากไฟล์ของฝ่ายบุคคล
--
-- ⚠️ ที่เก็บโค้ดนี้เป็นแบบสาธารณะ — ห้ามใส่ชื่อ รหัส หรือข้อมูลพนักงานจริงลงในไฟล์นี้
--    ให้ก๊อปแม่แบบไปใส่ข้อมูลจริงนอกที่เก็บโค้ด รันเสร็จแล้วลบทิ้ง
--
-- ปกติเพิ่มพนักงานทีละคนได้จากหน้า "ผู้ดูแล" ในแอปอยู่แล้ว
-- ไฟล์นี้มีไว้สำหรับตอนรับคนเข้าเป็นชุดใหญ่ หรือนำเข้าทะเบียนพนักงานทั้งองค์กรรอบแรก
--
-- ข้อกำหนดของข้อมูล
--   employee_code    ตัวเลข 5 หลัก (ต้องตรงกับที่หน้าผูกบัญชี LINE ยอมรับ ไม่งั้นเจ้าตัวผูกบัญชีไม่ได้)
--   full_name        ชื่อ–สกุลภาษาอังกฤษ ไม่เกิน 150 ตัวอักษร
--   department_name  ฝ่าย/แผนกต้นสังกัด ไม่เกิน 100 ตัวอักษร (คนละเรื่องกับฝ่ายผู้รับเรื่อง)
--   floor            ไม่เกิน 20 ตัวอักษร ใส่ NULL ได้ถ้ายังไม่ทราบ
--
-- รันซ้ำได้ไม่เสียหาย: รหัสที่มีอยู่แล้วจะถูกอัปเดตชื่อ/ฝ่าย/ชั้น ไม่ใช่เพิ่มซ้ำ และไม่แตะ
-- สถานะการใช้งาน การผูกบัญชี LINE หรือฝ่ายที่คนนั้นดูแลอยู่ ส่วนชั้นที่เว้นว่างจะไม่ทับค่าเดิม
--
-- วิธีใช้: Supabase -> SQL Editor -> วางทั้งไฟล์ -> Run

BEGIN;

INSERT INTO employees (employee_code, full_name, department_name, floor, source, status) VALUES
  ('00001', 'Example Name', 'Example Department', 'ชั้น 7', 'directory', 'active'),
  ('00002', 'Another Example', 'Example Department', NULL, 'directory', 'active')
ON CONFLICT (employee_code) DO UPDATE SET
  full_name       = EXCLUDED.full_name,
  department_name = EXCLUDED.department_name,
  floor           = COALESCE(EXCLUDED.floor, employees.floor),
  updated_at      = now();

COMMIT;

-- ตรวจผล
SELECT count(*) AS "พนักงานทั้งหมด" FROM employees;
SELECT department_name AS "ฝ่าย", count(*) AS "จำนวน"
FROM employees GROUP BY department_name ORDER BY count(*) DESC;
