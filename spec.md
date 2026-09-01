# สเปกระบบแจ้งเรื่องภายในสำนักงานผ่าน LINE LIFF

เอกสารนี้ใช้เป็นข้อกำหนดสำหรับการพัฒนา ครอบคลุมโครงสร้างข้อมูล API กระบวนการทำงาน และกฎเกณฑ์ทางธุรกิจ  
ไฟล์ต้นแบบหน้าจอ: `liff-report-mockup.html`

---

## 1. ภาพรวม

พนักงานแจ้งปัญหาภายในสำนักงานผ่าน LIFF ที่ผูกกับ LINE Official Account ของบริษัท เมื่อส่งเรื่องแล้วระบบจะแจ้งเตือนไปยังฝ่ายที่รับผิดชอบทันที ทั้งในกลุ่ม LINE ของฝ่ายและถึงผู้รับผิดชอบรายบุคคล พร้อมให้ผู้แจ้งติดตามสถานะได้ตลอดเวลา

**ผู้ใช้งาน 3 กลุ่ม**

| กลุ่ม | สิทธิ์ |
|---|---|
| พนักงานทั่วไป | แจ้งเรื่อง ดูเรื่องของตนเอง |
| เจ้าหน้าที่ประจำฝ่าย | รับเรื่อง เปลี่ยนสถานะ ส่งต่อฝ่ายอื่น ดูรายการงานของฝ่าย |
| ผู้ดูแลระบบ (HR) | ดูข้อมูลผู้ใช้งานทั้งหมด ระงับและคืนสิทธิ์ |

**ขอบเขตเวอร์ชันแรก**  
ยืนยันตัวตนด้วยรหัสพนักงาน · แจ้งเรื่อง 4 หมวด · แจ้งเตือนเข้ากลุ่มและรายบุคคล · ติดตามสถานะ · เตือนซ้ำอัตโนมัติ · จัดการสิทธิ์ผู้ใช้งาน

**นอกขอบเขตเวอร์ชันแรก**  
ระบบจองคิวนวด (พัฒนาแยก แต่ใช้โครงข้อมูลชั้นที่ 1 ร่วมกันได้ในอนาคต) · การอนุมัติงบประมาณ · การประเมินความพึงพอใจ · รายงานเชิงลึก

---

## 2. สถาปัตยกรรม

```
LINE App
   └── Rich Menu → LIFF (Static site บน Netlify)
                      │
                      ├── Netlify Functions (REST API)
                      │       ├── PostgreSQL (แนะนำ Supabase / Neon)
                      │       ├── LINE Messaging API (push, reply)
                      │       └── Object Storage (ไฟล์แนบ)
                      │
                      └── Netlify Scheduled Functions (งานเตือนซ้ำ)

LINE Platform → Webhook → Netlify Function (รับ postback จากปุ่มในข้อความ)
```

**เทคโนโลยีที่แนะนำ**

- Frontend: HTML/JS หรือ React + `@line/liff` SDK
- Backend: Netlify Functions (Node.js 20, TypeScript)
- Database: PostgreSQL
- Storage: Supabase Storage หรือ Cloudinary สำหรับภาพแนบ
- Scheduler: Netlify Scheduled Functions (cron ทุก 15 นาที)

---

## 3. โครงสร้างข้อมูล

แบ่งเป็น 2 ชั้น ชั้นที่ 1 ออกแบบให้ระบบอื่นในอนาคตใช้ร่วมกันได้ ห้ามใส่ตรรกะเฉพาะของระบบแจ้งเรื่องลงในชั้นนี้

### ชั้นที่ 1 — ข้อมูลกลางองค์กร

```sql
-- พนักงาน (แกนกลางของทุกระบบ ใช้ employee_code เป็นตัวอ้างอิงหลัก)
CREATE TABLE employees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code   VARCHAR(20) UNIQUE NOT NULL,
  full_name       VARCHAR(150) NOT NULL,
  department_id   UUID REFERENCES departments(id),
  department_name VARCHAR(100),          -- กรณีฝ่ายที่ไม่ใช่ฝ่ายผู้รับเรื่อง
  floor           VARCHAR(20),
  email           VARCHAR(150),
  source          VARCHAR(20) NOT NULL,  -- 'directory' = พบในฐาน HR, 'self' = กรอกเอง
  status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active | suspended
  suspended_at    TIMESTAMPTZ,
  suspended_by    UUID REFERENCES employees(id),
  suspend_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ผูกบัญชี LINE (แยกตารางเพราะ userId ผูกกับ channel ไม่ใช่กับคน)
-- ตารางนี้ทำให้ระบบอื่นที่ใช้ channel คนละตัวใช้ฐานพนักงานร่วมกันได้
CREATE TABLE line_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  line_user_id   VARCHAR(60) NOT NULL,
  channel_key    VARCHAR(50) NOT NULL,   -- 'report' | 'massage' | ระบบอื่นในอนาคต
  display_name   VARCHAR(150),           -- ชื่อใน LINE ใช้อ้างอิงเท่านั้น ห้ามใช้เป็นชื่อทางการ
  linked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_user_id, channel_key),
  UNIQUE (employee_id, channel_key)      -- 1 คน ผูกได้ 1 บัญชีต่อระบบ
);

-- ฝ่ายผู้รับเรื่อง (ตั้งค่าผ่านข้อมูล ห้าม hardcode ในโค้ด)
CREATE TABLE departments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              VARCHAR(10) UNIQUE NOT NULL,  -- IT | ADM | CLN | GEN
  name              VARCHAR(100) NOT NULL,
  line_group_id     VARCHAR(60),                  -- กลุ่มที่จะ push แจ้งเตือน
  sla_ack_minutes   INT NOT NULL DEFAULT 120,     -- เกินนี้ยังไม่มีคนรับ → เตือนซ้ำ
  sla_close_hours   INT NOT NULL DEFAULT 24,
  escalate_to       UUID REFERENCES employees(id),-- หัวหน้าฝ่าย
  is_active         BOOLEAN NOT NULL DEFAULT true
);

-- เจ้าหน้าที่ประจำฝ่าย (คนหนึ่งอยู่ได้หลายฝ่าย)
CREATE TABLE department_members (
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role          VARCHAR(20) NOT NULL DEFAULT 'staff', -- staff | head
  PRIMARY KEY (department_id, employee_id)
);
```

### ชั้นที่ 2 — เฉพาะระบบแจ้งเรื่อง

```sql
CREATE TABLE tickets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no      VARCHAR(20) UNIQUE NOT NULL,   -- IT-2608-014
  reporter_id    UUID NOT NULL REFERENCES employees(id),
  category_code  VARCHAR(10) NOT NULL,          -- ดูหัวข้อ 4
  department_id  UUID NOT NULL REFERENCES departments(id),
  floor          VARCHAR(20) NOT NULL,
  location_note  VARCHAR(200),
  detail         TEXT NOT NULL,
  urgency        VARCHAR(10) NOT NULL,          -- normal | urgent | critical
  status         VARCHAR(20) NOT NULL DEFAULT 'pending',
  assignee_id    UUID REFERENCES employees(id),
  acknowledged_at TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  closed_at      TIMESTAMPTZ,
  reminder_count INT NOT NULL DEFAULT 0,
  last_remind_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tickets_dept_status ON tickets(department_id, status);
CREATE INDEX idx_tickets_reporter ON tickets(reporter_id, created_at DESC);

-- ประวัติสถานะ เป็นแหล่งข้อมูลจริงของไทม์ไลน์ ห้ามลบหรือแก้ไขย้อนหลัง
CREATE TABLE ticket_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status   VARCHAR(20) NOT NULL,
  actor_id    UUID REFERENCES employees(id),     -- NULL = ระบบดำเนินการเอง
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_ticket ON ticket_events(ticket_id, created_at);

CREATE TABLE ticket_attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  file_url    TEXT NOT NULL,
  phase       VARCHAR(10) NOT NULL DEFAULT 'report', -- report | complete
  uploaded_by UUID REFERENCES employees(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. ค่าคงที่ของระบบ

**หมวดเรื่องและฝ่ายปลายทาง**

| category_code | ชื่อที่แสดง | ฝ่าย | รหัสเลขที่เรื่อง |
|---|---|---|---|
| `IT` | IT Support / Help Desk | IT Support / Help Desk | `IT-` |
| `FAC` | ระบบปรับอากาศ ประปา ไฟฟ้า | ฝ่าย Admin | `ADM-` |
| `CLN` | งานแม่บ้านและความสะอาด | ฝ่ายแม่บ้าน | `CLN-` |
| `GEN` | เรื่องอื่น ๆ | ฝ่ายธุรการ | `GEN-` |

**ชั้นที่เปิดใช้งาน** — ชั้น 15, ชั้น 9, ชั้น 8, ชั้น 7, ชั้น 5, ชั้นลอย

**ระดับความเร่งด่วน**

| ค่า | ชื่อที่แสดง | กรอบเวลา |
|---|---|---|
| `normal` | ปกติ | ภายใน 3 วันทำการ |
| `urgent` | เร่งด่วน | ภายในวันนี้ |
| `critical` | เร่งด่วนมาก | กระทบการทำงาน แจ้งรายบุคคลเพิ่ม |

**สถานะและการเปลี่ยนสถานะที่อนุญาต**

| ค่า | ชื่อที่แสดง | เปลี่ยนไปเป็น |
|---|---|---|
| `pending` | รอรับเรื่อง | `in_progress`, `cancelled` และการส่งต่อฝ่ายอื่น |
| `in_progress` | กำลังดำเนินการ | `completed`, `pending` (กรณีคืนคิว) |
| `completed` | ดำเนินการแล้วเสร็จ | `closed`, `in_progress` (กรณีเปิดใหม่) |
| `closed` | ปิดเรื่อง | — |
| `cancelled` | ยกเลิก | — |

**รูปแบบเลขที่เรื่อง** `{PREFIX}-{YYMM}-{ลำดับ 3 หลักต่อฝ่ายต่อเดือน}` เช่น `IT-2608-014`  
ต้องสร้างภายใน transaction เดียวกับการบันทึก ticket เพื่อกันเลขซ้ำ

---

## 5. กระบวนการทำงาน

### 5.1 ยืนยันตัวตนครั้งแรก

1. LIFF เรียก `liff.init()` แล้ว `liff.getIDToken()`
2. ส่ง ID token ไป backend **ห้ามส่ง userId จาก client มาใช้ตรง ๆ เพราะปลอมได้**
3. Backend ตรวจสอบ token ที่ `https://api.line.me/oauth2/v2.1/verify` แล้วจึงได้ `sub` (คือ userId) ที่เชื่อถือได้
4. ค้นหาใน `line_accounts` ด้วย userId + `channel_key = 'report'`
   - พบ → ตรวจ `employees.status` ถ้าเป็น `suspended` ให้แสดงหน้าถูกระงับสิทธิ์ ถ้าปกติให้เข้าใช้งานได้เลย
   - ไม่พบ → แสดงหน้ายืนยันตัวตน
5. ผู้ใช้กรอกรหัสพนักงาน → backend ค้นหาใน `employees`
   - พบ → แสดงข้อมูลให้ตรวจสอบ กดยืนยันแล้วสร้างแถวใน `line_accounts`
   - ไม่พบ → ให้กรอก ชื่อ–สกุล ฝ่าย ชั้น อีเมล แล้วสร้าง `employees` ด้วย `source = 'self'` และผูกบัญชีทันที **ไม่ต้องรออนุมัติ**
6. หากรหัสพนักงานนั้นถูกผูกกับ LINE บัญชีอื่นแล้ว ให้ปฏิเสธและแจ้งติดต่อฝ่ายทรัพยากรบุคคล

**ข้อความบนหน้าจอ** ให้สั้นและพูดถึงการยืนยันตัวตนเท่านั้น ไม่ต้องอธิบายว่าระบบเก็บข้อมูลอะไรหรือดึงจากแหล่งใด

### 5.2 แจ้งเรื่อง

1. ผู้ใช้เลือกหมวด → ระบบกำหนด `department_id` อัตโนมัติจากตาราง ไม่ให้ผู้ใช้เลือกฝ่ายเอง
2. กรอกชั้น จุดที่พบ รายละเอียด แนบภาพได้สูงสุด 3 ภาพ เลือกความเร่งด่วน
3. บันทึก ticket สถานะ `pending` พร้อมสร้าง `ticket_events` แถวแรก
4. Push Flex Message เข้ากลุ่ม LINE ของฝ่าย พร้อมปุ่ม postback
5. หาก `urgency = 'critical'` ให้ push ถึงสมาชิกฝ่ายรายบุคคลเพิ่มด้วย
6. ตอบกลับผู้แจ้งพร้อมเลขที่เรื่อง

### 5.3 รับเรื่องและเปลี่ยนสถานะ

- เจ้าหน้าที่กดปุ่มในข้อความ (postback) หรือกดจากหน้ารายการงานใน LIFF
- ทุกครั้งที่สถานะเปลี่ยน ต้องบันทึก `ticket_events` และ push แจ้งผู้แจ้งเสมอ
- การส่งต่อฝ่ายอื่น เปลี่ยน `department_id` คงสถานะ `pending` และ push เข้ากลุ่มฝ่ายใหม่
- กรณีมีคนกดรับพร้อมกัน ให้ใช้ conditional update และแจ้งคนที่กดทีหลังว่ามีผู้รับเรื่องแล้ว

### 5.4 เตือนซ้ำอัตโนมัติ

Scheduled Function ทำงานทุก 15 นาที ค้นหา ticket ที่ `status = 'pending'` และเกิน `sla_ack_minutes` ของฝ่ายนั้น

- ครั้งที่ 1: push ซ้ำเข้ากลุ่มฝ่าย
- ครั้งที่ 2 เป็นต้นไป: push ถึง `escalate_to` (หัวหน้าฝ่าย) ด้วย
- เตือนซ้ำได้ไม่เกิน 3 ครั้งต่อเรื่อง บันทึกใน `reminder_count` และ `last_remind_at`

### 5.5 ระงับสิทธิ์

- ผู้ดูแลกดระงับ → `employees.status = 'suspended'` พร้อมบันทึกผู้ดำเนินการและเหตุผล
- ผู้ถูกระงับเปิด LIFF จะเห็นหน้าแจ้งว่าถูกระงับสิทธิ์ และไม่สามารถสร้าง ticket ใหม่ได้
- **เรื่องที่แจ้งไว้ก่อนหน้ายังคงอยู่ในระบบและดำเนินการต่อจนแล้วเสร็จ**
- มีปุ่มคืนสิทธิ์ กลับเป็น `active` และแจ้งพนักงานทาง LINE
- ไม่มีขั้นตอนอนุมัติผู้ใช้งานใหม่ ทุกคนใช้งานได้ทันทีหลังยืนยันตัวตน

---

## 6. API

ทุก endpoint ยกเว้น webhook ต้องแนบ LINE ID token ใน header `Authorization: Bearer <id_token>` และ backend ต้องตรวจสอบทุกครั้ง

| Method | Path | คำอธิบาย |
|---|---|---|
| `POST` | `/api/auth/session` | ตรวจ token คืนข้อมูลพนักงานและสถานะการผูกบัญชี |
| `POST` | `/api/auth/verify-employee` | ค้นหาด้วยรหัสพนักงาน คืนข้อมูลให้ตรวจสอบ |
| `POST` | `/api/auth/link` | ยืนยันและผูกบัญชี LINE |
| `GET` | `/api/masters` | หมวด ฝ่าย ชั้น ระดับความเร่งด่วน |
| `POST` | `/api/tickets` | สร้างเรื่องใหม่ |
| `GET` | `/api/tickets/mine` | เรื่องของผู้ใช้ปัจจุบัน |
| `GET` | `/api/tickets/department` | รายการงานของฝ่าย รองรับ filter สถานะและผู้รับผิดชอบ |
| `GET` | `/api/tickets/:id` | รายละเอียดพร้อมไทม์ไลน์ |
| `PATCH` | `/api/tickets/:id/status` | เปลี่ยนสถานะ |
| `PATCH` | `/api/tickets/:id/transfer` | ส่งต่อฝ่ายอื่น |
| `POST` | `/api/uploads` | อัปโหลดภาพแนบ คืน URL |
| `GET` | `/api/admin/employees` | รายชื่อผู้ใช้งาน (เฉพาะผู้ดูแล) |
| `PATCH` | `/api/admin/employees/:id/suspend` | ระงับหรือคืนสิทธิ์ |
| `POST` | `/api/line/webhook` | รับ postback จาก LINE |
| `POST` | `/api/cron/reminders` | งานเตือนซ้ำ (Scheduled Function) |

**ตัวอย่าง request สร้างเรื่อง**

```json
POST /api/tickets
{
  "category_code": "FAC",
  "floor": "ชั้น 15",
  "location_note": "ห้องประชุม A",
  "detail": "เครื่องปรับอากาศไม่ทำความเย็น มีน้ำหยดบริเวณโต๊ะประชุม",
  "urgency": "urgent",
  "attachments": ["https://.../a1.jpg"]
}
```

**รูปแบบ postback data** `action=ack&ticket=<uuid>` · `action=complete&ticket=<uuid>` · `action=transfer&ticket=<uuid>&to=<dept_code>`

---

## 7. การเชื่อมต่อ LINE

- LIFF และ Messaging API channel ต้องอยู่ภายใต้ **provider เดียวกัน** มิฉะนั้น userId จะเป็นคนละชุด
- `channel_key` ของระบบนี้คือ `report` (ระบบจองคิวนวดเดิมแยกต่างหาก ไม่ใช้ข้อมูลร่วมกันในเวอร์ชันแรก)
- LIFF size: `full`
- การ push เข้ากลุ่มนับเป็น 1 ข้อความ ประหยัดโควตากว่าการ push รายบุคคล ให้ push รายบุคคลเฉพาะกรณี `critical` และการแจ้งกลับผู้แจ้ง
- ต้องเชิญ OA เข้ากลุ่มของแต่ละฝ่าย และเก็บ `groupId` ที่ได้จาก webhook `join` event ลงตาราง `departments`
- ตรวจสอบ signature ของ webhook ด้วย `X-Line-Signature` ทุกครั้ง

---

## 8. ตัวแปรสภาพแวดล้อม

```
LINE_CHANNEL_ACCESS_TOKEN=
LINE_CHANNEL_SECRET=
LINE_LOGIN_CHANNEL_ID=          # ใช้ตรวจสอบ ID token
LIFF_ID=
DATABASE_URL=
STORAGE_BUCKET_URL=
STORAGE_SERVICE_KEY=
ADMIN_EMPLOYEE_CODES=           # รหัสพนักงานที่มีสิทธิ์ผู้ดูแล คั่นด้วยจุลภาค
CRON_SECRET=                    # ป้องกันการเรียก endpoint เตือนซ้ำจากภายนอก
```

---

## 9. สแตกและข้อจำกัดของบริการฟรี

ระบบนี้ต้องทำงานได้โดยไม่มีค่าใช้จ่ายเพิ่มเติมจากค่าแพ็กเกจ LINE Official Account ที่บริษัทจ่ายอยู่แล้ว ทุกบริการที่เลือกใช้ต้องอยู่ในระดับฟรี และต้องออกแบบให้ไม่ชนเพดานของแต่ละบริการ

### 9.1 บริการที่ใช้

| ส่วนประกอบ | บริการ | ขีดจำกัดที่ต้องระวัง |
|---|---|---|
| หน้าเว็บ LIFF | Netlify | แบนด์วิดท์และจำนวน build ต่อเดือน |
| Backend API | Netlify Functions | จำนวนครั้งที่เรียกและเวลาประมวลผลรวมต่อเดือน |
| งานตามเวลา | Netlify Scheduled Functions | จำนวนงานที่ตั้งได้ |
| ฐานข้อมูล | Supabase (PostgreSQL) | ขนาดฐานข้อมูล และการหยุดทำงานเมื่อไม่มีการใช้งาน |
| ไฟล์แนบ | Supabase Storage | พื้นที่จัดเก็บรวม |

ขีดจำกัดของแต่ละบริการเปลี่ยนแปลงได้ ให้ตรวจสอบเงื่อนไขล่าสุดก่อนเริ่มพัฒนา และหลีกเลี่ยงการออกแบบที่ผูกกับผู้ให้บริการรายใดรายหนึ่งจนย้ายไม่ได้

### 9.2 ข้อกำหนดบังคับ

ข้อกำหนดในหัวข้อนี้ไม่ใช่ทางเลือก ผู้พัฒนาต้องดำเนินการให้ครบก่อนเปิดใช้งานจริง

**การบีบอัดภาพ**
- บีบอัดภาพในเบราว์เซอร์ก่อนอัปโหลดทุกครั้ง ห้ามส่งไฟล์ต้นฉบับจากกล้องขึ้น server
- ปรับขนาดให้ด้านยาวไม่เกิน 1600 px แปลงเป็น JPEG หรือ WebP คุณภาพประมาณ 0.7
- ปฏิเสธไฟล์ที่หลังบีบอัดแล้วยังเกิน 1 MB
- ใช้ `canvas.toBlob()` หรือไลบรารีขนาดเล็ก ไม่ต้องประมวลผลฝั่ง server

**การลบไฟล์เก่า**
- งานตามเวลารายเดือน ลบไฟล์แนบของ ticket ที่สถานะ `closed` และปิดมาแล้วเกิน 6 เดือน
- ลบเฉพาะไฟล์ ข้อมูลใน `tickets` และ `ticket_events` ให้คงไว้เพื่อใช้ทำรายงาน
- อัปเดต `ticket_attachments.file_url` เป็น `NULL` พร้อมบันทึกวันที่ลบ

**การป้องกันฐานข้อมูลหยุดทำงาน**
- ฐานข้อมูลระดับฟรีจะถูกพักการทำงานเมื่อไม่มีการเชื่อมต่อต่อเนื่องหลายวัน ซึ่งอาจเกิดขึ้นช่วงวันหยุดยาว
- ตั้งงานตามเวลาวันละครั้ง เรียก query เบา ๆ เช่น `SELECT 1` เพื่อรักษาการเชื่อมต่อ

**การสำรองข้อมูล**
- บริการระดับฟรีไม่มีการสำรองข้อมูลย้อนหลังให้ ต้องสำรองเอง
- งานตามเวลารายสัปดาห์ ส่งออกตาราง `employees`, `line_accounts`, `departments`, `tickets`, `ticket_events` เป็นไฟล์ JSON หรือ CSV
- จัดเก็บไว้นอกผู้ให้บริการเดิม เช่น SharePoint หรือ OneDrive ของบริษัท เก็บย้อนหลังอย่างน้อย 8 สัปดาห์
- ไฟล์สำรองมีข้อมูลส่วนบุคคล ต้องจำกัดสิทธิ์การเข้าถึงเฉพาะฝ่ายทรัพยากรบุคคลและผู้ดูแลระบบ

**การติดตามปริมาณการใช้งาน**
- บันทึกทุกครั้งที่เรียก Messaging API ลงตาราง `message_logs` ไว้ไล่ปัญหาเวลาข้อความไปไม่ถึงคน
  (เลิกส่งสรุปรายเดือนให้ผู้ดูแลแล้ว — ไม่มีใครใช้ และเป็นข้อความที่ถูกส่งเข้าไลน์ทุกต้นเดือน)
- ส่งสรุปให้ผู้ดูแลทุกต้นเดือน ใช้ประกอบการตัดสินใจว่าต้องปรับแพ็กเกจหรือไม่

```sql
CREATE TABLE message_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID REFERENCES tickets(id) ON DELETE SET NULL,
  channel    VARCHAR(20) NOT NULL,   -- group | user
  api_type   VARCHAR(20) NOT NULL,   -- push | reply | multicast
  target_id  VARCHAR(60),
  succeeded  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_msglog_month ON message_logs(created_at);
```

### 9.3 สรุปงานตามเวลาทั้งหมด

| งาน | ความถี่ | หน้าที่ |
|---|---|---|
| `reminders` | ทุก 15 นาที | เตือนซ้ำเรื่องที่เกิน SLA |
| `db-keepalive` | วันละ 1 ครั้ง | ป้องกันฐานข้อมูลถูกพักการทำงาน |
| `backup` | สัปดาห์ละ 1 ครั้ง | ส่งออกข้อมูลไปเก็บนอกระบบ |
| `cleanup-files` | เดือนละ 1 ครั้ง | ลบไฟล์แนบที่หมดอายุ |

ทุก endpoint ของงานตามเวลาต้องตรวจสอบ `CRON_SECRET` ก่อนทำงาน เพื่อป้องกันการเรียกจากภายนอก

---

## 10. ความปลอดภัยและข้อมูลส่วนบุคคล

- ตรวจสอบ ID token ฝั่ง server ทุก request ห้ามเชื่อ userId ที่ส่งมาจาก client
- ตรวจสิทธิ์ระดับข้อมูล พนักงานทั่วไปเห็นเฉพาะเรื่องของตนเอง เจ้าหน้าที่เห็นเฉพาะเรื่องของฝ่ายตน
- ตรวจ `employees.status` ก่อนดำเนินการทุกครั้งที่มีการเขียนข้อมูล
- จำกัดอัตราการสร้างเรื่อง เช่น ไม่เกิน 10 เรื่องต่อคนต่อชั่วโมง
- จำกัดไฟล์แนบเป็นภาพ ขนาดไม่เกิน 5 MB ต่อไฟล์ และตรวจสอบชนิดไฟล์ฝั่ง server
- เก็บข้อมูลเท่าที่จำเป็นต่อการดำเนินการ กำหนดระยะเวลาจัดเก็บเรื่องที่ปิดแล้ว เช่น 2 ปี แล้วลบไฟล์แนบ
- ห้ามบันทึกเนื้อหาข้อความหรือ token ลงใน log

---

## 11. ลำดับการพัฒนา

1. ตั้งค่า LINE channel, LIFF, ฐานข้อมูล และ seed ข้อมูลฝ่าย
2. ระบบยืนยันตัวตนและผูกบัญชี LINE
3. ฟอร์มแจ้งเรื่องและการบันทึก
4. Flex Message และ webhook รับ postback
5. หน้าติดตามสถานะและรายการงานของฝ่าย
6. งานเตือนซ้ำอัตโนมัติ และงานตามเวลาอื่นตามหัวข้อ 9.3
7. หน้าจัดการสิทธิ์สำหรับผู้ดูแล
8. ทดสอบกับผู้ใช้จริงหนึ่งฝ่ายก่อนเปิดใช้ทั้งองค์กร

---

## 12. เกณฑ์การทดสอบ

- ผู้ใช้ใหม่ยืนยันตัวตนด้วยรหัสที่มีในระบบ แล้วเข้าใช้งานได้โดยไม่ต้องกรอกซ้ำในครั้งถัดไป
- ผู้ใช้ที่รหัสไม่มีในระบบ กรอกข้อมูลเองแล้วใช้งานได้ทันที
- รหัสพนักงานเดียวกันผูกกับ LINE บัญชีที่สองไม่สำเร็จ
- สร้างเรื่องแล้วข้อความเข้ากลุ่มฝ่ายที่ถูกต้องภายใน 5 วินาที
- เรื่องระดับ critical ต้องมีการแจ้งรายบุคคลเพิ่ม
- กดรับเรื่องพร้อมกัน 2 คน มีผู้รับได้เพียงคนเดียว
- ทุกการเปลี่ยนสถานะมีแถวใน `ticket_events` และผู้แจ้งได้รับแจ้งเตือน
- เรื่องที่ค้างเกิน SLA ได้รับการเตือนซ้ำ และเตือนไม่เกิน 3 ครั้ง
- ผู้ถูกระงับสิทธิ์สร้างเรื่องใหม่ไม่ได้ แต่เรื่องเดิมยังดำเนินการต่อได้
- ผู้ใช้ทั่วไปเรียก API ของผู้ดูแลแล้วได้รับ 403
- อัปโหลดภาพจากกล้องมือถือแล้วไฟล์ที่เก็บจริงต้องมีขนาดไม่เกิน 1 MB
- เรียก endpoint ของงานตามเวลาโดยไม่มี `CRON_SECRET` แล้วได้รับ 401
- งานสำรองข้อมูลสร้างไฟล์ครบทุกตารางที่กำหนด และกู้คืนกลับได้จริง
