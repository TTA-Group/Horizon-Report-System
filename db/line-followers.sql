-- รายชื่อคนที่เป็นเพื่อนกับ LINE OA — ใช้เป็นตัวช่วยจับคู่ตอนฝ่ายบุคคลผูกบัญชีให้พนักงาน
--
-- ทำไมต้องเก็บไว้ ไม่ถาม LINE สด ๆ ทุกครั้ง:
-- Worker ของ Cloudflare ยิงคำขอย่อยได้จำกัดต่อหนึ่งคำขอ (แผนฟรี 50 ครั้ง) การถามโปรไฟล์
-- ทีละคนสด ๆ จะไม่จบตั้งแต่คนที่ห้าสิบ ตัวที่ไม่มีเพดานนี้ (Power Automate) จึงเป็นคนไปดึงมา
-- แล้วส่งเข้ามาเก็บไว้ที่นี่ หน้าจับคู่อ่านจากตารางนี้อย่างเดียว
--
-- ตารางนี้ไม่ใช่ "ทะเบียนผู้ใช้" — เป็นแค่รายชื่อชั่วคราวไว้ให้คนจับคู่
-- ความจริงว่าใครผูกกับรหัสพนักงานไหน อยู่ที่ line_accounts ที่เดียวเหมือนเดิม
--
-- รันครั้งเดียว รันซ้ำก็ไม่เสียหาย

CREATE TABLE IF NOT EXISTS line_followers (
  line_user_id  VARCHAR(60) PRIMARY KEY,
  display_name  VARCHAR(150),   -- ชื่อที่เจ้าตัวตั้งไว้ในไลน์ ไม่ใช่ชื่อที่เปลี่ยนไว้ใน OA Manager
  picture_url   TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ตรวจผล — ต้องขึ้นว่า มีแล้ว
SELECT 'ตารางรายชื่อผู้ติดตาม' AS "รายการ",
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'line_followers'
       ) THEN 'มีแล้ว' ELSE 'ยังไม่มี — ผิดปกติ' END AS "ผล";
