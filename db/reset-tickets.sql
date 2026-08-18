-- ล้างเรื่องที่แจ้งทั้งหมด (ใช้ตอนจบรอบทดสอบ ก่อนเปิดใช้งานจริง)
--
-- ⚠️ ลบแล้วกู้คืนไม่ได้ ให้รันคำสั่งนับจำนวนในหัวข้อ 1 ดูก่อนเสมอ
--
-- สิ่งที่ถูกลบ : เรื่องที่แจ้ง · ประวัติสถานะ · รายการไฟล์แนบ (ลบตามอัตโนมัติผ่าน ON DELETE CASCADE)
-- สิ่งที่ไม่ถูกแตะ : พนักงาน · การผูกบัญชีไลน์ · ฝ่ายและเจ้าหน้าที่ประจำฝ่าย · ค่าตั้งค่าทั้งหมด

-- 1) ดูก่อนว่ากำลังจะลบอะไรบ้าง
SELECT
  (SELECT count(*) FROM tickets)            AS "เรื่องที่แจ้ง",
  (SELECT count(*) FROM ticket_events)      AS "ประวัติสถานะ",
  (SELECT count(*) FROM ticket_attachments) AS "รายการไฟล์แนบ",
  (SELECT count(*) FROM message_logs)       AS "บันทึกการส่งข้อความ";

-- 2) ลบ
DELETE FROM tickets;

-- 3) ล้างบันทึกการส่งข้อความด้วย (ไม่บังคับ — ลบเมื่ออยากให้ยอดใช้ข้อความเริ่มนับใหม่)
-- DELETE FROM message_logs;

-- 4) ตรวจผล ควรเป็น 0 ทั้งสามช่อง
SELECT
  (SELECT count(*) FROM tickets)            AS "เรื่องที่เหลือ",
  (SELECT count(*) FROM ticket_events)      AS "ประวัติที่เหลือ",
  (SELECT count(*) FROM ticket_attachments) AS "รายการไฟล์แนบที่เหลือ";
