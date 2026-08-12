# Horizon Report System

ระบบแจ้งเรื่องภายในสำนักงานผ่าน **LINE LIFF** — พนักงานแจ้งปัญหาภายในออฟฟิศผ่าน LINE Official Account
ระบบส่งเรื่องถึงฝ่ายที่รับผิดชอบ และให้ผู้แจ้งติดตามสถานะได้ตลอดเวลา

> ข้อกำหนดฉบับเต็ม: [`spec.md`](./spec.md) · ต้นแบบหน้าจอ: [`liff-report-mockup.html`](./liff-report-mockup.html)

---

## สแตกเทคโนโลยี

| ส่วน | เทคโนโลยี |
|---|---|
| Frontend (LIFF) | HTML/JS + `@line/liff` SDK (static) |
| Backend API | Netlify Functions v2 (Node.js 20, TypeScript) |
| ฐานข้อมูล | PostgreSQL (Supabase) |
| ไฟล์แนบ / สำรองข้อมูล | Supabase Storage |
| งานตามเวลา | Netlify Scheduled Functions |

---

## โครงสร้างโปรเจกต์

```
public/              LIFF frontend — index.html, app.js, config.js (★ ตั้งค่า liffId ที่นี่)
netlify/functions/   REST API + LINE webhook + งานตามเวลา
  _lib/              โค้ดใช้ร่วม (db, auth, line, flex, jobs, constants)
db/                  schema.sql · seed.sql · enable-rls.sql
netlify.toml         การตั้งค่า build / functions / publish
```

**API** (รายละเอียดใน `spec.md` หัวข้อ 6)
`/api/auth/*` ยืนยันตัวตนและผูกบัญชี · `/api/tickets*` แจ้งเรื่อง ติดตาม เปลี่ยนสถานะ ส่งต่อฝ่าย ·
`/api/admin/*` จัดการผู้ใช้งาน · `/api/uploads` ภาพแนบ · `/api/line/webhook` รับ postback จาก LINE

**งานตามเวลา** เตือนซ้ำ (ทุก 15 นาที) · db-keepalive (รายวัน) · backup (รายสัปดาห์) ·
cleanup-files (รายเดือน) · usage-report (ต้นเดือน)

---

## ติดตั้ง

```bash
npm install
```

**ฐานข้อมูล** — รันตามลำดับ
```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql
psql "$DATABASE_URL" -f db/enable-rls.sql
```

**ตัวแปรสภาพแวดล้อม** — คัดลอก `.env.example` เป็น `.env` แล้วเติมค่าจริง
(บน Netlify ให้ตั้งใน Environment variables)

⚠️ `STORAGE_BUCKET_URL` ต้องเป็น bucket แบบ **public** (ภาพต้องแสดงในแอปได้)
ส่วน `BACKUP_BUCKET_URL` ต้องเป็น bucket แบบ **private คนละตัวกัน** เพราะไฟล์สำรองมีข้อมูลส่วนบุคคล

**LIFF** — ระบุ `liffId` ใน `public/config.js`

```bash
npm run typecheck   # ตรวจชนิดข้อมูล
npm run dev         # รันโลคัล (ต้องมี Netlify CLI)
```

---

## ค่าคงที่หลัก (`spec.md` หัวข้อ 4)

| หมวด | ฝ่ายปลายทาง | คำนำหน้าเลขที่เรื่อง |
|---|---|---|
| `IT` IT Support / Help Desk | IT | `IT-` |
| `FAC` ระบบปรับอากาศ ประปา ไฟฟ้า | ฝ่าย Admin (ADM) | `ADM-` |
| `CLN` งานแม่บ้านและความสะอาด | ฝ่ายแม่บ้าน | `CLN-` |
| `GEN` เรื่องอื่น ๆ | ฝ่ายธุรการ | `GEN-` |

สถานะ: `pending → in_progress → completed → closed` (+ `cancelled` จาก `pending`)

---

## การอยู่ร่วมกับระบบอื่นบน LINE OA เดียวกัน

หนึ่ง OA ตั้ง webhook ได้ที่เดียว ระบบนี้จึงทำหน้าที่เป็นตัวกลาง — รับ event จาก LINE แล้ว
ส่งต่อ event ต้นฉบับ (พร้อม signature เดิม) ไปยัง `MASSAGE_WEBHOOK_URL` ให้ระบบเดิมทำงานต่อได้ตามปกติ
พร้อมจำกัดเวลารอ เพื่อไม่ให้การตอบกลับ LINE ช้าตามระบบปลายทาง

⚠️ ทั้งสองระบบใช้โควตาข้อความรายเดือนของ OA ร่วมกัน — ข้อความที่ระบบส่งออกเอง (push) นับโควตา
ส่วนการตอบกลับทันทีหลังผู้ใช้ทัก (reply) ไม่นับ

---

## สถานะการใช้งาน

**ใช้งานได้แล้ว** — ยืนยันตัวตนด้วยรหัสพนักงาน · แจ้งเรื่องพร้อมแนบภาพ (บีบอัดในเบราว์เซอร์) ·
ติดตามสถานะและยกเลิกเรื่องที่ยังไม่มีคนรับ · คิวงานของฝ่ายสำหรับเจ้าหน้าที่ (รับเรื่อง/เสร็จ/ปิด/ส่งต่อ/ยกเลิก) ·
หน้าผู้ดูแลสำหรับ HR (ค้นหา ระงับ–คืนสิทธิ์ ปลดการผูกบัญชีไลน์)

**ยังต้องทำก่อนเปิดใช้ทั้งองค์กร**
- กำหนดเจ้าหน้าที่ประจำฝ่ายจริงใน `department_members` (ปัจจุบันมีแต่ข้อมูลตัวอย่างจาก seed)
- ตั้ง webhook ของ LINE มาที่ `/api/line/webhook` เพื่อให้ปุ่มในข้อความทำงาน
- ผูก `departments.line_group_id` ของแต่ละฝ่าย (รับ `groupId` จาก event `join` ตอนเชิญ OA เข้ากลุ่ม)
- นำเข้ารายชื่อพนักงาน แล้วปิดการสมัครเองหากต้องการจำกัดเฉพาะคนในองค์กร
- ทดสอบตามเกณฑ์ใน `spec.md` หัวข้อ 12 กับผู้ใช้จริงหนึ่งฝ่ายก่อน
