# Horizon Report System

ระบบแจ้งเรื่องภายในสำนักงานผ่าน **LINE LIFF** — พนักงานแจ้งปัญหาภายในออฟฟิศผ่าน LINE Official Account
ระบบส่งเรื่องถึงฝ่ายที่รับผิดชอบทันที (ทั้งกลุ่ม LINE ของฝ่ายและรายบุคคล) และให้ผู้แจ้งติดตามสถานะได้ตลอดเวลา

> เอกสารข้อกำหนดฉบับเต็มอยู่ที่ [`spec.md`](./spec.md) · ต้นแบบหน้าจอ (mockup แบบกดเล่นได้) อยู่ที่ [`liff-report-mockup.html`](./liff-report-mockup.html)

---

## สแตกเทคโนโลยี

| ส่วน | เทคโนโลยี |
|---|---|
| Frontend (LIFF) | HTML/JS + `@line/liff` SDK (static site) |
| Backend API | Netlify Functions v2 (Node.js 20, TypeScript) |
| ฐานข้อมูล | PostgreSQL (แนะนำ Supabase / Neon) |
| ที่เก็บไฟล์แนบ | Supabase Storage (หรือเทียบเท่า) |
| งานตามเวลา | Netlify Scheduled Functions |

ออกแบบให้ทำงานได้บนบริการระดับฟรี โดยไม่มีค่าใช้จ่ายเพิ่มจากแพ็กเกจ LINE OA ที่มีอยู่ (ดู `spec.md` หัวข้อ 9)

---

## โครงสร้างโปรเจกต์

```
.
├── public/                     # LIFF frontend (static)
│   ├── index.html              #   หน้าจอ: ยืนยันตัวตน → แจ้งเรื่อง → ติดตามสถานะ
│   ├── app.js                  #   ตรรกะ: liff.init, getIDToken, เรียก API
│   └── config.js               #   ★ ตั้งค่า liffId ที่นี่
├── netlify/functions/          # REST API + webhook + งานตามเวลา (Functions v2)
│   ├── _lib/                   #   โค้ดใช้ร่วม (db, line, auth, flex, constants, http, ...)
│   ├── auth-session.ts         #   POST /api/auth/session
│   ├── auth-verify-employee.ts #   POST /api/auth/verify-employee
│   ├── auth-link.ts            #   POST /api/auth/link
│   ├── masters.ts              #   GET  /api/masters
│   ├── tickets-create.ts       #   POST /api/tickets
│   ├── tickets-mine.ts         #   GET  /api/tickets/mine
│   ├── tickets-department.ts   #   GET  /api/tickets/department
│   ├── tickets-detail.ts       #   GET  /api/tickets/:id
│   ├── tickets-status.ts       #   PATCH /api/tickets/:id/status
│   ├── tickets-transfer.ts     #   PATCH /api/tickets/:id/transfer
│   ├── uploads.ts              #   POST /api/uploads
│   ├── admin-employees.ts      #   GET  /api/admin/employees
│   ├── admin-employee-suspend.ts # PATCH /api/admin/employees/:id/suspend
│   ├── line-webhook.ts         #   POST /api/line/webhook
│   ├── reminders.ts            #   งานตามเวลา: เตือนซ้ำ (ทุก 15 นาที)
│   ├── db-keepalive.ts         #   งานตามเวลา: กันฐานข้อมูลหยุด (รายวัน)
│   ├── backup.ts               #   งานตามเวลา: สำรองข้อมูล (รายสัปดาห์)
│   ├── cleanup-files.ts        #   งานตามเวลา: ลบไฟล์แนบหมดอายุ (รายเดือน)
│   └── usage-report.ts         #   งานตามเวลา: สรุปการใช้ Messaging API (ต้นเดือน)
├── db/
│   ├── schema.sql              # โครงสร้างตาราง (2 ชั้นตาม spec หัวข้อ 3)
│   └── seed.sql                # ข้อมูลตั้งต้น (ฝ่าย + พนักงานตัวอย่าง)
├── netlify.toml                # การตั้งค่า build/functions/publish
├── .env.example                # ตัวแปรสภาพแวดล้อม (คัดลอกเป็น .env)
└── tsconfig.json / package.json
```

---

## เริ่มต้นใช้งาน

### 1. ติดตั้ง dependency

```bash
npm install
```

### 2. เตรียมฐานข้อมูล

สร้างฐานข้อมูล PostgreSQL แล้วรันสคริปต์:

```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql
```

### 3. ตั้งค่าตัวแปรสภาพแวดล้อม

```bash
cp .env.example .env   # แล้วเติมค่าจริง
```

ค่าที่ต้องเตรียม: LINE Messaging API token/secret, LINE Login channel id (สำหรับตรวจ ID token),
LIFF ID, `DATABASE_URL`, ค่าที่เก็บไฟล์ (Supabase Storage), `ADMIN_EMPLOYEE_CODES`, `CRON_SECRET`
(รายละเอียดใน `.env.example` และ `spec.md` หัวข้อ 8)

### 4. ตั้งค่า LIFF ฝั่ง frontend

แก้ `public/config.js` ให้ระบุ `liffId` ของคุณ

### 5. รัน / deploy

```bash
npm run typecheck   # ตรวจชนิดข้อมูล TypeScript
npm run dev         # รันโลคัลด้วย netlify dev (ต้องมี Netlify CLI)
```

deploy ขึ้น Netlify แล้วตั้งค่า environment variables ให้ครบ · เชิญ LINE OA เข้ากลุ่มของแต่ละฝ่าย
แล้วนำ `groupId` ที่ได้จาก webhook (`join` event) ไปใส่ในคอลัมน์ `departments.line_group_id`

---

## ค่าคงที่หลัก (ดู `spec.md` หัวข้อ 4)

| หมวด (category) | ฝ่ายปลายทาง | คำนำหน้าเลขที่เรื่อง |
|---|---|---|
| `IT` IT Support / Help Desk | IT | `IT-` |
| `FAC` ระบบปรับอากาศ ประปา ไฟฟ้า | ฝ่าย Admin (ADM) | `ADM-` |
| `CLN` งานแม่บ้านและความสะอาด | ฝ่ายแม่บ้าน | `CLN-` |
| `GEN` เรื่องอื่น ๆ | ฝ่ายธุรการ | `GEN-` |

สถานะ: `pending → in_progress → completed → closed` (+ `cancelled`)

---

## สถานะการพัฒนา

**ทำแล้ว (โครงระบบตามสเปก)**
- โครงสร้างฐานข้อมูลครบ 2 ชั้น + seed ข้อมูลฝ่าย
- REST API ครบทุก endpoint ตาม `spec.md` หัวข้อ 6 (ยืนยันตัวตน, แจ้งเรื่อง, รับ/เปลี่ยนสถานะ, ส่งต่อฝ่าย, จัดการสิทธิ์)
- ตรวจ LINE ID token ฝั่ง server, ตรวจ signature ของ webhook, กันรับเรื่องซ้ำด้วย conditional update
- Flex Message + ปุ่ม postback, แจ้งกลุ่ม/รายบุคคล, บันทึก `message_logs`
- งานตามเวลาครบ 5 งาน (เตือนซ้ำ, keepalive, backup, cleanup, usage-report)
- Frontend LIFF สำหรับพนักงาน: ยืนยันตัวตน → แจ้งเรื่อง (บีบอัดภาพในเบราว์เซอร์) → ติดตามสถานะ

**ต้องตั้งค่า/ทำต่อก่อนใช้งานจริง**
- ใส่ค่า credential จริงทั้งหมดใน environment variables และ `public/config.js`
- ผูก `line_group_id` ของแต่ละฝ่าย และตั้งค่า Supabase Storage (สำหรับ `/api/uploads` และ backup/cleanup)
- หน้าจอเจ้าหน้าที่ (คิวงานของฝ่าย) และผู้ดูแล (จัดการสิทธิ์) — API พร้อมแล้ว เหลือต่อ UI
- ทดสอบตามเกณฑ์ใน `spec.md` หัวข้อ 12 กับผู้ใช้จริงหนึ่งฝ่ายก่อนเปิดทั้งองค์กร
