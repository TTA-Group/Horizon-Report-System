-- เปิด Row Level Security (RLS) ให้ทุกตาราง — เกราะป้องกันชั้นในของฐานข้อมูล
--
-- ทำไมต้องเปิด:
-- Supabase เปิด REST API ให้ทุกตารางในสคีมา public โดยอัตโนมัติ ถ้าไม่เปิด RLS ไว้
-- ผู้ที่ได้ anon key ไป (คีย์ตัวนี้ออกแบบมาให้ฝังในหน้าเว็บได้ จึงหลุดง่ายกว่าคีย์อื่น)
-- จะอ่านข้อมูลทุกตารางได้ทันที รวมถึงตาราง employees และ line_accounts
--
-- ทำไมไม่กระทบระบบ:
-- Netlify Functions ของเราต่อฐานข้อมูลตรงผ่าน DATABASE_URL ด้วยบทบาทเจ้าของตาราง
-- ซึ่งข้าม RLS อยู่แล้ว จึงทำงานได้เหมือนเดิมทุกอย่าง
--
-- ผลลัพธ์: เปิด RLS แต่ไม่สร้าง policy ใด ๆ = ไม่มีใครเข้าถึงผ่าน REST API ได้เลย
-- (เข้าถึงได้เฉพาะ backend ของเราที่ต่อตรงเท่านั้น) ซึ่งตรงกับที่ระบบนี้ต้องการ

ALTER TABLE employees          ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_logs       ENABLE ROW LEVEL SECURITY;
