-- สิทธิ์พิเศษรายคนรายเดือน — ผู้ดูแลกดเพิ่ม/ลดสิทธิ์ให้พนักงานได้จากหน้าจัดการคิวนวด
--
-- สำหรับฐานข้อมูลที่รัน db/massage-schema.sql ไปแล้วก่อนมีปุ่มนี้
-- ฐานข้อมูลใหม่ที่ยังไม่เคยรัน ไม่ต้องรันไฟล์นี้ — schema ตัวปัจจุบันมีให้แล้ว
--
-- รันครั้งเดียว รันซ้ำก็ไม่เสียหาย

BEGIN;

-- เก็บเป็น "ส่วนต่างจากสิทธิ์ปกติ" ไม่ใช่ตัวเลขสิทธิ์เต็ม เพราะถ้าวันหนึ่งเปลี่ยนสิทธิ์
-- มาตรฐานจาก 2 เป็น 3 คนที่เคยถูกปรับจะได้ตามค่าใหม่เองทันที ไม่ต้องไล่แก้ทีละแถว
--
-- ผูกกับเดือน เพราะสิทธิ์นับเป็นรายเดือนอยู่แล้ว การให้เพิ่มจึงควรหมดอายุพร้อมเดือนนั้น
-- ไม่ติดตัวไปตลอด ซึ่งจะกลายเป็นสิทธิ์ถาวรที่ไม่มีใครจำได้ว่าใครให้ไว้เมื่อไหร่
CREATE TABLE IF NOT EXISTS massage_quota_extra (
  employee_id UUID        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month       CHAR(7)     NOT NULL,                    -- 'YYYY-MM' ตามเวลาไทย
  extra       INT         NOT NULL DEFAULT 0,          -- บวกได้ ลบได้
  updated_by  UUID        REFERENCES employees(id),    -- ผู้ดูแลคนที่กดล่าสุด
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, month)
);

COMMIT;

-- ตรวจผล — ต้องขึ้นว่า มีแล้ว
SELECT 'ตารางสิทธิ์พิเศษ' AS "รายการ",
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.tables WHERE table_name = 'massage_quota_extra'
       ) THEN 'มีแล้ว' ELSE 'ยังไม่มี — ผิดปกติ' END AS "ผล"
UNION ALL
SELECT 'คนที่ถูกปรับสิทธิ์ไว้', count(*)::text FROM massage_quota_extra WHERE extra <> 0;
