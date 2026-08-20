-- เพิ่มขั้นตอน "แจ้งผลตรวจสอบ" หลังรับเรื่อง
--
-- เป็นการเพิ่มคอลัมน์อย่างเดียว ไม่แตะข้อมูลเดิม เรื่องที่ค้างอยู่ตอนนี้จะเข้าสู่ขั้นตอนใหม่
-- ทันทีโดยไม่ต้องแก้อะไรย้อนหลัง
--
-- วิธีใช้: Supabase -> SQL Editor -> วางทั้งไฟล์ -> Run
-- รันซ้ำได้ไม่เสียหาย

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS due_at                  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS due_label               VARCHAR(40),
  ADD COLUMN IF NOT EXISTS assessment              TEXT,
  ADD COLUMN IF NOT EXISTS assessed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS waiting_parts           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS due_changes             INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_remind_count   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_progress_remind_at TIMESTAMPTZ;

-- ดัชนีสำหรับงานทวงหลังรับเรื่อง ที่วิ่งทุก 15 นาที
CREATE INDEX IF NOT EXISTS idx_tickets_inprogress
  ON tickets (status, last_progress_remind_at)
  WHERE status = 'in_progress';

-- ตรวจผล — ต้องเห็นคอลัมน์ใหม่ครบ 8 คอลัมน์
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'tickets'
  AND column_name IN ('due_at','due_label','assessment','assessed_at',
                      'waiting_parts','due_changes','progress_remind_count','last_progress_remind_at')
ORDER BY column_name;
