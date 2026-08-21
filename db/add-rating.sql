-- เพิ่มการให้คะแนนความพึงพอใจและคำชมหลังปิดงาน
--
-- เป็นการเพิ่มคอลัมน์อย่างเดียว ไม่แตะข้อมูลเดิม เรื่องที่ปิดไปแล้วก่อนหน้านี้จะไม่มีคะแนน
-- ซึ่งถูกต้องแล้ว เพราะตอนนั้นยังไม่ได้ถาม
--
-- วิธีใช้: Supabase -> SQL Editor -> วางทั้งไฟล์ -> Run
-- รันซ้ำได้ไม่เสียหาย

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS rating      SMALLINT,      -- 1-5 ดาว
  ADD COLUMN IF NOT EXISTS rating_note VARCHAR(120),  -- คำชมหรือสิ่งที่ควรปรับปรุงที่ผู้แจ้งเลือก
  ADD COLUMN IF NOT EXISTS rated_at    TIMESTAMPTZ;

-- ตรวจผล — ต้องเห็นคอลัมน์ใหม่ครบ 3 คอลัมน์
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'tickets' AND column_name IN ('rating','rating_note','rated_at')
ORDER BY column_name;
