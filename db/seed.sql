-- Horizon Report System — ข้อมูลตั้งต้น (seed)
-- รันหลังจาก schema.sql
--
-- - 4 ฝ่ายผู้รับเรื่องตาม spec หัวข้อ 4 (IT | ADM | CLN | GEN) — เป็นค่าตั้งค่าจริงของระบบ
-- - พนักงาน 1 ราย สำหรับผู้ดูแลระบบเริ่มต้น ใช้รหัสกลาง ไม่ผูกกับบุคคลใดบุคคลหนึ่ง
--   ต้องแก้เป็นรหัสพนักงานจริงก่อนเปิดใช้งาน และตั้งค่าให้ตรงกับ env ADMIN_EMPLOYEE_CODES
-- - line_group_id เว้นว่างไว้ ให้เก็บจาก webhook `join` แล้วค่อยอัปเดต

-- ฝ่ายผู้รับเรื่อง
--
-- ฝ่าย CLN ปิดใช้งานไว้ (is_active = false) เพราะงานแม่บ้านกับงานระบบปรับอากาศเป็นทีมเดียวกัน
-- ทั้งสองหมวดจึงเข้าคิวของฝ่าย ADM (ดู CATEGORIES ใน src/api/_lib/constants.ts)
-- คงแถวนี้ไว้เผื่ออนาคตแยกทีมกัน จะได้เปิดใช้ใหม่ได้โดยไม่เสียประวัติงานเดิม
INSERT INTO departments (code, name, sla_ack_minutes, sla_close_hours, is_active) VALUES
  ('IT',  'IT / IT Helpdesk', 120, 24, true),
  ('ADM', 'ADMIN',            120, 24, true),
  ('CLN', 'MAID',             120, 24, false),
  ('GEN', 'OTHER',            120, 48, true)
ON CONFLICT (code) DO NOTHING;

-- ผู้ดูแลระบบเริ่มต้น (แก้เป็นรหัสพนักงานจริงก่อนเปิดใช้งาน)
INSERT INTO employees (employee_code, full_name, department_name, source, status) VALUES
  ('00000', 'ผู้ดูแลระบบ', 'ฝ่ายทรัพยากรบุคคล', 'directory', 'active')
ON CONFLICT (employee_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- ตัวอย่างการกำหนดเจ้าหน้าที่ประจำฝ่ายและหัวหน้าฝ่าย
-- หัวหน้าฝ่ายใช้เป็นปลายทางเมื่อเตือนซ้ำเกินกำหนด (spec หัวข้อ 5.4)
-- เปิดใช้งานโดยแทน <รหัสพนักงาน> ด้วยรหัสจริง แล้วลบเครื่องหมาย -- ออก
-- ─────────────────────────────────────────────────────────────────────────────
--
-- INSERT INTO department_members (department_id, employee_id, role)
-- SELECT d.id, e.id, 'head'
-- FROM departments d, employees e
-- WHERE d.code = 'IT' AND e.employee_code = '<รหัสพนักงาน>'
-- ON CONFLICT DO NOTHING;
--
-- UPDATE departments
-- SET escalate_to = (SELECT id FROM employees WHERE employee_code = '<รหัสพนักงาน>')
-- WHERE code = 'IT';
