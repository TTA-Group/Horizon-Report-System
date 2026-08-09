-- Horizon Report System — ข้อมูลตั้งต้น (seed)
-- รันหลังจาก schema.sql
--
-- - 4 ฝ่ายผู้รับเรื่องตาม spec หัวข้อ 4 (IT | ADM | CLN | GEN)
-- - พนักงานตัวอย่าง (สอดคล้องกับ mockup) + 1 ผู้ดูแล HR
-- - line_group_id เว้นว่างไว้ ให้เก็บจาก webhook `join` แล้วค่อยอัปเดต
--
-- หมายเหตุ: สิทธิ์ผู้ดูแลระบบกำหนดผ่าน env ADMIN_EMPLOYEE_CODES (เช่น HR001)

-- ฝ่ายผู้รับเรื่อง
INSERT INTO departments (code, name, sla_ack_minutes, sla_close_hours, is_active) VALUES
  ('IT',  'IT Support / Help Desk', 120, 24, true),
  ('ADM', 'ฝ่าย Admin',             120, 24, true),
  ('CLN', 'ฝ่ายแม่บ้าน',            120, 24, true),
  ('GEN', 'ฝ่ายธุรการ',             120, 48, true)
ON CONFLICT (code) DO NOTHING;

-- พนักงานตัวอย่าง
INSERT INTO employees (employee_code, full_name, department_name, floor, email, source, status) VALUES
  ('A1042', 'สมชาย ใจดี',    'ฝ่ายบัญชี',              'ชั้น 8', 'somchai.j@company.co.th', 'directory', 'active'),
  ('A0871', 'มานี รักงาน',   'ฝ่ายขายและการตลาด',      'ชั้น 9', 'manee.r@company.co.th',   'directory', 'active'),
  ('B2210', 'เอกพงษ์ ศรีสุข', 'IT Support / Help Desk', 'ชั้น 5', 'ekapong.s@company.co.th', 'directory', 'active'),
  ('HR001', 'ผู้ดูแลระบบ',    'ฝ่ายทรัพยากรบุคคล',      'ชั้น 15','hr.admin@company.co.th',  'directory', 'active')
ON CONFLICT (employee_code) DO NOTHING;

-- เจ้าหน้าที่ประจำฝ่าย IT (เอกพงษ์ เป็นหัวหน้าฝ่าย)
INSERT INTO department_members (department_id, employee_id, role)
SELECT d.id, e.id, 'head'
FROM departments d, employees e
WHERE d.code = 'IT' AND e.employee_code = 'B2210'
ON CONFLICT DO NOTHING;

-- กำหนดหัวหน้าฝ่ายไว้ใช้ escalate เมื่อเตือนซ้ำเกินกำหนด
UPDATE departments
SET escalate_to = (SELECT id FROM employees WHERE employee_code = 'B2210')
WHERE code = 'IT';
