-- Horizon Report System — โครงสร้างฐานข้อมูล (อ้างอิง spec.md หัวข้อ 3 และ 9.2)
--
-- แบ่งเป็น 2 ชั้น:
--   ชั้นที่ 1 — ข้อมูลกลางองค์กร (employees, line_accounts, departments, department_members)
--   ชั้นที่ 2 — เฉพาะระบบแจ้งเรื่อง (tickets, ticket_events, ticket_attachments, message_logs)
--
-- ลำดับการสร้างถูกจัดใหม่เพื่อแก้ปัญหา foreign key แบบวน (employees <-> departments)
-- โดยสร้าง departments ก่อนแบบยังไม่ผูก escalate_to แล้วค่อย ALTER เพิ่มภายหลัง

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- สำหรับ gen_random_uuid()

-- ───────────────────────── ชั้นที่ 1 : ข้อมูลกลางองค์กร ─────────────────────────

-- ฝ่ายผู้รับเรื่อง (ตั้งค่าผ่านข้อมูล ห้าม hardcode ในโค้ด)
CREATE TABLE departments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              VARCHAR(10) UNIQUE NOT NULL,   -- IT | ADM | CLN | GEN
  name              VARCHAR(100) NOT NULL,
  line_group_id     VARCHAR(60),                   -- กลุ่มที่จะ push แจ้งเตือน
  sla_ack_minutes   INT NOT NULL DEFAULT 120,      -- เกินนี้ยังไม่มีคนรับ -> เตือนซ้ำ
  sla_close_hours   INT NOT NULL DEFAULT 24,
  escalate_to       UUID,                          -- หัวหน้าฝ่าย (ผูก FK ภายหลัง)
  is_active         BOOLEAN NOT NULL DEFAULT true,
  -- ฝ่ายนี้รับเรื่องแจ้งหรือไม่ — ฝ่ายอย่าง HR อยู่ในตารางนี้เพื่อใช้จัดกลุ่มคนและให้สิทธิ์เท่านั้น
  -- ไม่มีหมวดไหนส่งงานเข้าไป จึงต้องไม่โผล่ในตัวเลือกส่งต่อฝ่ายและไม่มีคิวงานของตัวเอง
  receives_tickets  BOOLEAN NOT NULL DEFAULT true
);

-- พนักงาน (แกนกลางของทุกระบบ ใช้ employee_code เป็นตัวอ้างอิงหลัก)
CREATE TABLE employees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code   VARCHAR(20) UNIQUE NOT NULL,
  full_name       VARCHAR(150) NOT NULL,
  department_id   UUID REFERENCES departments(id),
  department_name VARCHAR(100),          -- กรณีฝ่ายที่ไม่ใช่ฝ่ายผู้รับเรื่อง
  floor           VARCHAR(20),
  source          VARCHAR(20) NOT NULL,  -- 'directory' = พบในฐาน HR, 'self' = กรอกเอง
  status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active | suspended
  suspended_at    TIMESTAMPTZ,
  suspended_by    UUID REFERENCES employees(id),
  suspend_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- เพิ่ม FK ของ departments.escalate_to หลัง employees ถูกสร้างแล้ว
ALTER TABLE departments
  ADD CONSTRAINT fk_departments_escalate_to
  FOREIGN KEY (escalate_to) REFERENCES employees(id);

-- ผูกบัญชี LINE (แยกตารางเพราะ userId ผูกกับ channel ไม่ใช่กับคน)
CREATE TABLE line_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  line_user_id   VARCHAR(60) NOT NULL,
  channel_key    VARCHAR(50) NOT NULL,   -- 'report' | 'massage' | ระบบอื่นในอนาคต
  display_name   VARCHAR(150),           -- ชื่อใน LINE ใช้อ้างอิงเท่านั้น
  linked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_user_id, channel_key),
  UNIQUE (employee_id, channel_key)      -- 1 คน ผูกได้ 1 บัญชีต่อระบบ
);

-- เจ้าหน้าที่ประจำฝ่าย (คนหนึ่งอยู่ได้หลายฝ่าย)
CREATE TABLE department_members (
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role          VARCHAR(20) NOT NULL DEFAULT 'staff', -- staff | head
  PRIMARY KEY (department_id, employee_id)
);

-- ───────────────────────── ชั้นที่ 2 : เฉพาะระบบแจ้งเรื่อง ─────────────────────────

CREATE TABLE tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no       VARCHAR(20) UNIQUE NOT NULL,    -- เช่น IT-2608-014
  reporter_id     UUID NOT NULL REFERENCES employees(id),
  category_code   VARCHAR(10) NOT NULL,           -- IT | FAC | CLN | GEN (ดู spec หัวข้อ 4)
  department_id   UUID NOT NULL REFERENCES departments(id),
  floor           VARCHAR(20) NOT NULL,
  location_note   VARCHAR(200),
  detail          TEXT NOT NULL,
  urgency         VARCHAR(10) NOT NULL,           -- normal | urgent | critical
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  assignee_id     UUID REFERENCES employees(id),
  acknowledged_at TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  reminder_count  INT NOT NULL DEFAULT 0,
  last_remind_at  TIMESTAMPTZ,
  -- ผลตรวจสอบหลังรับเรื่อง (spec เพิ่มเติม: ผู้แจ้งต้องรู้ว่าเสียอะไรและจะเสร็จเมื่อไหร่)
  due_at          TIMESTAMPTZ,           -- กำหนดเสร็จที่ผู้รับผิดชอบแจ้งไว้
  due_label       VARCHAR(40),           -- คำที่เลือก เช่น 'ภายใน 3 วัน' ไว้แสดงคู่กับวันที่
  assessment      TEXT,                  -- อาการที่พบ (NULL = ติ๊กว่าไม่มีคำอธิบายเพิ่มเติม)
  assessed_at     TIMESTAMPTZ,           -- ครบทั้งกำหนดเสร็จและอาการแล้วเมื่อไหร่
  waiting_parts   BOOLEAN NOT NULL DEFAULT false, -- รออะไหล่/ผู้รับเหมา ทวงทุก 7 วัน
  due_changes     INT NOT NULL DEFAULT 0,         -- เลื่อนกำหนดมากี่ครั้ง (เกิน 3 ครั้งแจ้งหัวหน้า)
  progress_remind_count  INT NOT NULL DEFAULT 0,  -- ทวงหลังรับเรื่องไปกี่ครั้ง
  last_progress_remind_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tickets_dept_status ON tickets(department_id, status);
CREATE INDEX idx_tickets_reporter ON tickets(reporter_id, created_at DESC);

-- ประวัติสถานะ เป็นแหล่งข้อมูลจริงของไทม์ไลน์ ห้ามลบหรือแก้ไขย้อนหลัง
CREATE TABLE ticket_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status   VARCHAR(20) NOT NULL,
  actor_id    UUID REFERENCES employees(id),      -- NULL = ระบบดำเนินการเอง
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_ticket ON ticket_events(ticket_id, created_at);

CREATE TABLE ticket_attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  file_url    TEXT,                                          -- NULL หลังถูกลบตามรอบ cleanup
  phase       VARCHAR(10) NOT NULL DEFAULT 'report',         -- report | complete
  uploaded_by UUID REFERENCES employees(id),
  deleted_at  TIMESTAMPTZ,                                   -- วันที่ลบไฟล์จริงออกจาก storage
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attachments_ticket ON ticket_attachments(ticket_id);

-- บันทึกการเรียก Messaging API เพื่อดูปริมาณการใช้จริง (spec หัวข้อ 9.2)
CREATE TABLE message_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID REFERENCES tickets(id) ON DELETE SET NULL,
  channel    VARCHAR(20) NOT NULL,   -- group | user
  api_type   VARCHAR(20) NOT NULL,   -- push | reply | multicast
  target_id  VARCHAR(60),
  succeeded  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_msglog_month ON message_logs(created_at);
