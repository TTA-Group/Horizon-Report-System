-- Horizon Wellness — โครงสร้างฐานข้อมูลของระบบจองคิวนวด
--
-- รันต่อจาก db/schema.sql (ต้องมี employees และ line_accounts อยู่ก่อนแล้ว)
-- ใช้ฐานข้อมูลตัวเดียวกับระบบแจ้งปัญหา เพราะทั้งสองระบบอ้างพนักงานคนเดียวกัน
--
-- แบ่งสองชั้นตาม spec.md หัวข้อ 3:
--   ชั้นที่ 1 — company_holidays, app_settings   (ของกลาง ระบบอื่นใช้ต่อได้)
--   ชั้นที่ 2 — massage_*                        (เฉพาะระบบจองคิวนวด)
--
-- คำสั่งทุกอันเขียนแบบสั่งซ้ำได้ไม่พัง เผื่อรันทับของเดิม

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────────────────── ชั้นที่ 1 : ของกลางองค์กร ─────────────────────────

-- วันหยุดของบริษัท
--
-- อยู่ชั้นที่ 1 เพราะไม่ได้เป็นของระบบจองคิวนวด ระบบแจ้งปัญหาเอาไปนับ "ภายใน 3 วันทำการ"
-- ให้ตรงความจริงได้ด้วย (ตอนนี้นับดะทุกวันรวมวันหยุด) ใครเพิ่มวันหยุดที่นี่ที่เดียว ได้ผลทุกระบบ
--
-- วันหยุดของไทยส่วนใหญ่เป็นวันจันทรคติที่เลื่อนทุกปีและประกาศเป็นมติคณะรัฐมนตรี
-- จึงไม่คำนวณเอง แต่ให้ฝ่ายบุคคลใส่เข้ามา ระบบสนใจแค่ว่าวันศุกร์ไหนตรงกับแถวในตารางนี้
CREATE TABLE IF NOT EXISTS company_holidays (
  day        DATE PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ค่าตั้งที่ต้องเปลี่ยนได้โดยไม่ต้อง deploy ใหม่
--
-- ต่างจากตัวแปรใน Cloudflare ตรงที่ตัวแปรแบบ Text ถูกล้างทุกครั้งที่ deploy และแบบ Secret
-- อ่านย้อนกลับมาดูไม่ได้ ของที่ "คนต้องปรับเอง" อย่างสวิตช์ปิดระบบจึงไม่ควรอยู่ตรงนั้น
--
-- ห้ามเอาค่าลับมาใส่ที่นี่ — ตารางนี้อ่านได้จากทุกที่ที่ต่อฐานข้อมูลได้
CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(60) PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES employees(id)
);

-- ───────────────────────── ชั้นที่ 2 : ระบบจองคิวนวด ─────────────────────────

-- หมอนวด
--
-- ระบบเดิมเขียนชื่อไว้ในโค้ดหน้าเว็บ ("หมอนวดผู้ชาย", "หมอนวด 2"…) เปลี่ยนทีต้องแก้ไฟล์
-- ทำเป็นตารางเพราะสามเรื่องนี้เกิดจริง: คนลาออก, วันไหนมาไม่ครบ 4 คน, และมีคนที่เลือก
-- เจาะจงว่าอยากได้หรือไม่อยากได้หมอนวดผู้ชาย ซึ่งต้องรู้เพศถึงจะบอกผู้ใช้ได้
CREATE TABLE IF NOT EXISTS massage_therapists (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(60) NOT NULL,
  gender     VARCHAR(10),                      -- male | female | NULL = ไม่ระบุ
  sort_order INT NOT NULL DEFAULT 0,           -- ลำดับคอลัมน์ในตารางจอง
  is_active  BOOLEAN NOT NULL DEFAULT true,    -- false = ไม่รับคิวใหม่ (คิวเก่ายังอยู่)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- วันที่เปิดให้บริการ หนึ่งแถวต่อหนึ่งวัน
--
-- ทำไมเป็นตาราง ไม่ใช่คำนวณ "วันศุกร์ที่ไม่ใช่วันหยุด" สด ๆ ทุกครั้ง:
--   1. ถ้าคำนวณสด ตรรกะวันหยุดจะกระจายไปอยู่ทุกที่ที่ถามถึงวัน และเพี้ยนกันได้
--   2. ไม่มีที่ให้บันทึกตอนต้องปิดวันด้วยเหตุอื่น เช่น หมอนวดมาไม่ได้ทั้งวัน
--   3. คำถามอย่าง "เดือนนี้เปิดวันไหนบ้าง" กลายเป็นการอ่านข้อมูลธรรมดา
--
-- แถวถูกสร้างโดยงานตามเวลาของวันที่ 1 และโดยตัวหน้าจองเองถ้าเปิดมาแล้วยังไม่มี
-- (กันกรณีงานตามเวลาล้มเหลวแล้วทั้งเดือนจองไม่ได้เลย)
CREATE TABLE IF NOT EXISTS massage_days (
  day           DATE PRIMARY KEY,
  status        VARCHAR(10) NOT NULL DEFAULT 'open',  -- open | closed
  closed_reason VARCHAR(120),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- คิวที่จอง
--
-- ยกเลิกแล้วไม่ลบแถว (ระบบเดิมใช้ DeleteItem ลบทิ้ง ประวัติจึงหายไปด้วย) เปลี่ยนเป็น
-- status = 'cancelled' เพื่อให้ยังตอบได้ว่าใครยกเลิกกระชั้นบ่อย และเพื่อให้ตัวเลข
-- สรุปรายเดือนย้อนหลังไม่เปลี่ยนไปเรื่อย ๆ
CREATE TABLE IF NOT EXISTS massage_bookings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day           DATE NOT NULL REFERENCES massage_days(day),
  slot_start    TIME NOT NULL,                        -- 10:00 … 14:30 (ดู MASSAGE_SLOTS ในโค้ด)
  therapist_id  UUID NOT NULL REFERENCES massage_therapists(id),
  employee_id   UUID NOT NULL REFERENCES employees(id),
  status        VARCHAR(12) NOT NULL DEFAULT 'booked', -- booked | cancelled
  -- quota = ใช้สิทธิ์ 2 ครั้ง/เดือน · flash = คิวด่วน ไม่นับสิทธิ์ และพนักงานยกเลิกเองไม่ได้
  kind          VARCHAR(8)  NOT NULL DEFAULT 'quota',   -- quota | flash
  -- การเช็คชื่อหน้างาน NULL = ยังไม่ได้เช็ค
  attended      VARCHAR(10),                          -- present | no_show
  checked_at    TIMESTAMPTZ,
  checked_by    UUID REFERENCES employees(id),
  -- ส่งข้อความเตือนไปแล้วหรือยัง กันส่งซ้ำเมื่องานตามเวลาทำงานทับรอบกัน
  -- ตอนนี้เตือนรอบเดียวคือก่อนถึงคิว 15 นาที ใช้แค่ remind_15_at
  -- อีกสองคอลัมน์เป็นของเตือนรอบเย็นวันก่อนกับรอบครึ่งชั่วโมงที่เลิกใช้แล้ว
  -- เก็บไว้เพราะข้อมูลเก่ายังอยู่ในนั้น และการลบคอลัมน์ทิ้งไม่ได้ทำให้อะไรดีขึ้น
  remind_eve_at   TIMESTAMPTZ,   -- เลิกใช้แล้ว
  remind_soon_at  TIMESTAMPTZ,   -- เลิกใช้แล้ว
  remind_15_at    TIMESTAMPTZ,   -- เตือนก่อนถึงคิว 15 นาที
  -- การยกเลิก เก็บไว้ดูย้อนหลังว่าใครยกเลิกและเมื่อไหร่
  cancelled_at  TIMESTAMPTZ,
  cancelled_by  UUID REFERENCES employees(id),        -- ต่างจาก employee_id เมื่อผู้ดูแลปิดทั้งวัน
  cancel_reason VARCHAR(120),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ───────────────────── กันจองซ้ำที่ระดับฐานข้อมูล ─────────────────────
--
-- นี่คือจุดที่ระบบเดิมพลาด: ตัวกรองที่ควรเช็คว่ารอบนี้ถูกจองแล้วหรือยัง เขียนเป็นการเอา
-- "ทั้งอาร์เรย์" ไปเทียบกับ "ข้อความเวลา" ผลจึงเป็นเท็จเสมอ คำตอบ full ไม่เคยถูกส่งออกเลย
-- สิ่งเดียวที่กันคิวชนกันคือหน้าเว็บทำให้ตัวเลือกเป็นสีเทา ซึ่งกันได้แค่คนที่เพิ่งเปิดหน้า
--
-- การอ่านมาเช็คก่อนแล้วค่อยเขียนมีช่องว่างระหว่างสองขั้นเสมอ ต่อให้เขียนถูก การกันที่แน่นอน
-- คือให้ฐานข้อมูลปฏิเสธเอง — สองคนกดพร้อมกันเป๊ะ ฐานข้อมูลรับได้คนเดียว อีกคนได้ error
-- ที่โค้ดดักแล้วบอกว่า "คิวนี้เพิ่งถูกจองไป"
--
-- เป็นดัชนีแบบมีเงื่อนไข (WHERE status = 'booked') เพื่อให้คิวที่ยกเลิกแล้วไม่กินที่
-- คนถัดไปจองรอบเดิมได้ และคนเดิมจองรอบเดิมซ้ำได้ด้วยถ้าเปลี่ยนใจ

-- หมอนวดคนเดียวรับได้คนเดียวต่อรอบ
CREATE UNIQUE INDEX IF NOT EXISTS uq_massage_slot
  ON massage_bookings (day, slot_start, therapist_id)
  WHERE status = 'booked';

-- คนเดียวจองได้วันละคิวเดียว
--
-- กันสองอย่างพร้อมกันด้วยดัชนีเดียว:
--   1. จองซ้อนเวลาตัวเองกับหมอนวดคนละคน (ระบบเดิมไม่ได้กันไว้)
--   2. จองรอบติดกันสองรอบเพื่อนวดยาวหนึ่งชั่วโมง
--
-- แรงกว่าการห้ามเฉพาะรอบติดกัน เพราะคนที่จอง 10:00 กับ 14:00 วันเดียวกันก็ยังกินคิว
-- ไปสองคิวของวันนั้น ทั้งที่คนอื่นยังไม่ได้เลยสักคิว สิทธิ์ 2 ครั้งต่อเดือนจึงกลายเป็น
-- "สองวันคนละสัปดาห์" ซึ่งกระจายกว่า
CREATE UNIQUE INDEX IF NOT EXISTS uq_massage_person_day
  ON massage_bookings (day, employee_id)
  WHERE status = 'booked';

-- นับสิทธิ์รายเดือนและดึง "คิวของฉัน"
CREATE INDEX IF NOT EXISTS idx_massage_employee_day
  ON massage_bookings (employee_id, day);

-- ดึงคิวทั้งวันสำหรับฟอร์มเช็คชื่อและงานเตือนล่วงหน้า
CREATE INDEX IF NOT EXISTS idx_massage_day_status
  ON massage_bookings (day, status);

-- แยกคิวสิทธิ์ออกจากคิวด่วนตอนนับสิทธิ์รายเดือน
CREATE INDEX IF NOT EXISTS idx_massage_kind
  ON massage_bookings (employee_id, kind, day);
