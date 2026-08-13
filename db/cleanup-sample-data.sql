-- ลบข้อมูลพนักงานตัวอย่างที่มาจาก seed รุ่นแรก (ชื่อสมมติ) ออกจากฐานข้อมูลจริง
--
-- ปลอดภัยต่อข้อมูลจริง:
--   - ลบเฉพาะรหัสที่ระบุไว้ในรายการเท่านั้น
--   - ข้ามรายที่มีการอ้างอิงอยู่จริง (เคยแจ้งเรื่อง / เคยรับเรื่อง / เคยดำเนินการ / เคยระงับสิทธิ์ผู้อื่น)
--     เพื่อไม่ให้ประวัติการทำงานหายไป
--   - line_accounts และ department_members ถูกลบตามอัตโนมัติ (ON DELETE CASCADE)
--
-- หมายเหตุ: '00000' คือผู้ดูแลระบบเริ่มต้น หากยังใช้อยู่ให้ลบออกจากรายการก่อนรัน

-- ดูรายชื่อก่อนลบ
SELECT employee_code, full_name, department_name,
       (SELECT count(*) FROM tickets t WHERE t.reporter_id = e.id) AS tickets
FROM employees e
WHERE e.employee_code IN ('A1042', 'A0871', 'B2210', 'HR001')
ORDER BY e.employee_code;

-- 1) ปลดการอ้างอิงหัวหน้าฝ่าย (seed เดิมตั้ง B2210 เป็นหัวหน้าฝ่าย IT)
UPDATE departments
SET escalate_to = NULL
WHERE escalate_to IN (
  SELECT id FROM employees WHERE employee_code IN ('A1042', 'A0871', 'B2210', 'HR001')
);

-- 2) ลบเฉพาะรายที่ไม่มีประวัติผูกอยู่
DELETE FROM employees e
WHERE e.employee_code IN ('A1042', 'A0871', 'B2210', 'HR001')
  AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.reporter_id = e.id OR t.assignee_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM ticket_events ev WHERE ev.actor_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM ticket_attachments a WHERE a.uploaded_by = e.id)
  AND NOT EXISTS (SELECT 1 FROM employees s WHERE s.suspended_by = e.id);

-- 3) ตรวจผล — ควรเหลือเฉพาะพนักงานจริง
SELECT employee_code, full_name, department_name, status FROM employees ORDER BY employee_code;
