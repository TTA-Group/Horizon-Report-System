-- ตรวจว่าทำไมสิทธิ์ของคนนี้ถึงเป็นเลขนี้ — เปลี่ยน '00000' เป็นรหัสพนักงานที่มีปัญหา
WITH me AS (SELECT id FROM employees WHERE employee_code = '00000')
SELECT to_char(b.day, 'DD/MM') AS "วัน",
       to_char(b.slot_start, 'HH24:MI') AS "รอบ",
       b.kind AS "ชนิด",
       b.status AS "สถานะ",
       CASE WHEN b.cancelled_by IS NULL THEN '-'
            WHEN b.cancelled_by = b.employee_id THEN 'เจ้าตัวเอง'
            ELSE 'ผู้ดูแล' END AS "ใครยกเลิก",
       to_char(b.cancelled_at AT TIME ZONE 'Asia/Bangkok', 'DD/MM HH24:MI') AS "ยกเลิกเมื่อ",
       to_char((b.day - INTERVAL '1 day' + INTERVAL '15 hours'), 'DD/MM HH24:MI') AS "วันถูกล็อกเมื่อ",
       CASE
         WHEN b.kind <> 'quota' THEN 'ไม่นับ (ไม่ใช่คิวสิทธิ์)'
         WHEN b.status = 'booked' THEN 'นับ (ยังจองอยู่)'
         WHEN b.cancelled_by <> b.employee_id THEN 'ไม่นับ (ผู้ดูแลยกเลิกให้)'
         WHEN b.cancelled_at >= ((b.day - INTERVAL '1 day' + INTERVAL '15 hours')
                                 AT TIME ZONE 'Asia/Bangkok')
           THEN 'นับ (ยกเลิกหลังวันถูกล็อก)'
         ELSE 'ไม่นับ (ยกเลิกก่อนวันถูกล็อก = คืนสิทธิ์)'
       END AS "นับเป็นสิทธิ์ที่ใช้ไปไหม"
FROM massage_bookings b, me
WHERE b.employee_id = me.id
  AND b.day >= date_trunc('month', (now() AT TIME ZONE 'Asia/Bangkok'))::date
  AND b.day <  (date_trunc('month', (now() AT TIME ZONE 'Asia/Bangkok')) + INTERVAL '1 month')::date
ORDER BY b.day, b.slot_start;
