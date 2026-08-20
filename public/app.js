/* Horizon Report System — LIFF frontend logic
 * ครอบคลุมกระแสงานหลักของพนักงาน: ยืนยันตัวตน -> แจ้งเรื่อง -> ติดตามสถานะ
 * (หน้าเจ้าหน้าที่/ผู้ดูแลใช้ API ชุดเดียวกัน สามารถต่อยอดเพิ่มได้)
 */
const CFG = window.APP_CONFIG || {};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ค่าหมายจับของตัวเลือก "อื่น ๆ" ในรายการเลือก (ชั้น ฝ่าย) — ตั้งใจให้เป็นค่าที่ไม่มีวันตรงกับของจริง
// สิ่งที่ส่งขึ้นระบบคือข้อความที่ผู้ใช้พิมพ์เอง ไม่ใช่ค่านี้
const PICK_OTHER = "__other__";

// ฝ่าย/แผนกต้นสังกัดของพนักงาน — คนละเรื่องกับฝ่ายผู้รับเรื่องใน departments
// สะกดตามทะเบียนพนักงานของฝ่ายบุคคล เพื่อให้ชื่อฝ่ายของคนที่กรอกเองตรงกับคนที่นำเข้ามาเป็นชุด
// ใช้ทั้งหน้าผูกบัญชีและหน้าเพิ่มพนักงานของผู้ดูแล จึงเก็บไว้ที่เดียวไม่ให้สะกดต่างกัน
//
// รายการนี้ตรงกับหัวข้อที่พับในหน้าผู้ดูแล — ฝ่ายย่อยของ PMTA รวมเป็น "PMTA" และ
// Finance & Accounting รวมอยู่ใน Corporate Finance & Accounting แล้ว
// คนที่บันทึกไว้ด้วยชื่อฝ่ายย่อยเดิมยังอยู่ครบ ไม่ได้ถูกแก้ และยังถูกจัดเข้ากลุ่มเดียวกันอยู่ดี
const ORG_DEPTS = [
  "Administration",
  "Business Development",
  "CEO Office",
  "CEO PROJECT -1",
  "CEO PROJECT -2",
  "CEO PROJECT -3",
  "CEO PROJECT -4",
  "Corporate Accounting & BPA",
  "Corporate Affairs",
  "Corporate Communication",
  "Corporate Finance & Accounting",
  "Corporate Human Resources",
  "DIGITAL TEAM",
  "Executive Driver",
  "Executive Secretary",
  "Information Technology",
  "Internal Audit",
  "Investor Relations & Treasury",
  "LEGAL",
  "Legal - CEO Office",
  "PMTA",
  "Water Project",
];

let idToken = null;
let masters = null;
let session = null;
let picked = null; // ปุ่มหมวดที่เลือก
let pendingFiles = []; // ไฟล์แนบที่บีบอัดแล้ว { base64, type }
let queueDept = null; // ฝ่ายที่กำลังดูในหน้าคิวงาน (รหัสฝ่าย)
let queueFilter = ""; // ตัวกรองคิวงาน: "" | "pending" | "me"
let adminQ = ""; // คำค้นหน้าผู้ดูแล
let adminView = "active"; // หน้าที่กำลังดูในผู้ดูแล: "active" (พนักงานปัจจุบัน) | "suspended" (ถูกระงับสิทธิ์)
// ข้อมูลพนักงานที่แสดงอยู่ในหน้าผู้ดูแล คีย์ด้วย id — ใช้อ่านฝ่ายที่แต่ละคนดูแลตอนเปิดแผ่นเลือก
// โดยไม่ต้องยิงถามเซิร์ฟเวอร์ซ้ำ (รายการนี้เพิ่งโหลดมาหมาด ๆ อยู่แล้ว)
const adminEmployeeIndex = new Map();
let detailReturnTab = "mine"; // แท็บที่จะกลับไปหลังปิดหน้ารายละเอียด
let sheetPick = null; // ตัวรับค่าเมื่อเลือกจาก bottom sheet
let mastersPromise = null; // /api/masters ไม่ต้องใช้สิทธิ์ ยิงคู่ขนานได้ตั้งแต่ต้น ไม่ต้องรอ session ก่อน

/* ---------- helpers ---------- */
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch((CFG.apiBase || "") + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(idToken ? { authorization: `Bearer ${idToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* noop */
  }
  if (!res.ok) {
    // ผู้ดูแลเพิ่งปลดสิทธิ์หรือระงับสิทธิ์ระหว่างที่เปิดแอปค้างไว้ — พาไปหน้าที่ถูกต้องเลย
    // ไม่ปล่อยให้กดต่อแล้วเจอข้อความปฏิเสธซ้ำ ๆ โดยไม่รู้ว่าเกิดอะไรขึ้น
    if (data.code === "not_linked" || data.code === "suspended") accessLost(data.code);
    const err = new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
    err.code = data.code;
    throw err;
  }
  return data;
}

/** สิทธิ์ถูกถอนระหว่างใช้งาน — เก็บแถบบน/แถบล่าง แล้วกลับไปหน้าตั้งต้นของกรณีนั้น */
function accessLost(code) {
  $("#appbar").style.display = "none";
  $("#tabbar").style.display = "none";
  if (code === "suspended") return show("s-suspended");
  session = { linked: false };
  $("#empid").value = "";
  showRegister();
}

function show(id) {
  $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  window.scrollTo(0, 0);
}

let toastTimer;
/**
 * ข้อความแจ้งเตือนมุมจอ — ปกติใส่เป็นข้อความล้วน เพราะหลายข้อความมีชื่อคนหรือค่าที่ผู้ใช้กรอกปนมา
 * ที่อยากได้ตัวหนาจริง ๆ ต้องส่ง { html: true } มาเอง แล้วรับผิดชอบ escape ให้เรียบร้อย
 */
function toast(msg, { html = false } = {}) {
  const el = $("#toast");
  if (html) el.innerHTML = msg;
  else el.textContent = msg;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 3600);
}

function setTab(id) {
  $$(".tabbar button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.tab === id)));
}

/* ---------- boot ---------- */
async function boot() {
  try {
    if (!CFG.liffId || CFG.liffId.includes("PUT-YOUR")) {
      show("s-config");
      return;
    }
    await liff.init({ liffId: CFG.liffId });
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    idToken = liff.getIDToken();
    // ยิงข้อมูลตั้งต้น (หมวด/ฝ่าย/ชั้น) คู่ขนานไปกับการขอ session — ทั้งคู่ต้องใช้ token
    // จึงเริ่มได้ทันทีที่ได้ token ไม่ต้องรอให้ session เสร็จก่อน
    mastersPromise = api("/api/masters").catch(() => null);
    session = await api("/api/auth/session", { method: "POST" });
    routeBySession();
  } catch (e) {
    $("#err-msg").textContent = e.message || String(e);
    show("s-error");
  }
}

/** คืนข้อมูลตั้งต้น (หมวด/ฝ่าย/ชั้น/โดเมนอีเมล) — ใช้ผลที่ยิงคู่ขนานไว้ตอน boot() ถ้ามี */
async function getMasters() {
  if (!masters) masters = (await mastersPromise) || (await api("/api/masters"));
  return masters;
}

function routeBySession() {
  if (session.suspended) return show("s-suspended");
  if (!session.linked) return showRegister();
  enterApp();
}

/* ---------- register ---------- */
function showRegister() {
  show("s-register");
  showRegPart("reg-input");
}
function showRegPart(id) {
  ["reg-input", "reg-found", "reg-notfound"].forEach((x) => {
    $("#" + x).style.display = x === id ? "block" : "none";
  });
}

/** หน้าบอกว่าทำไมลงทะเบียนต่อไม่ได้ — ใช้ทั้งกรณีไม่พบรหัส และกรณีรหัสถูกผูกไปแล้ว */
function showRegBlocked(code, title, sub, tip) {
  $("#nf-title").textContent = title;
  $("#nf-sub").textContent = sub;
  $("#nf-code").textContent = code;
  $("#nf-tip").textContent = tip;
  showRegPart("reg-notfound");
}

const BLOCKED_NOT_FOUND = {
  title: "ไม่พบรหัสพนักงานนี้ในระบบ",
  sub: "ระบบใช้ได้เฉพาะพนักงานที่ฝ่ายทรัพยากรบุคคลลงทะเบียนไว้แล้ว",
  tip:
    "ตรวจดูว่าพิมพ์รหัสถูกต้องครบ 5 หลักหรือไม่ ถ้าถูกแล้วแต่ยังไม่พบ " +
    "กรุณาติดต่อฝ่ายทรัพยากรบุคคลเพื่อเพิ่มข้อมูลของท่านเข้าระบบก่อน แล้วจึงกลับมายืนยันตัวตนอีกครั้ง",
};

const BLOCKED_ALREADY_LINKED = {
  title: "รหัสนี้ลงทะเบียนไปแล้ว",
  sub: "รหัสพนักงานหนึ่งรหัสผูกกับบัญชีไลน์ได้เพียงบัญชีเดียว",
  tip:
    "ถ้านี่เป็นรหัสของท่านเองและเพิ่งเปลี่ยนมือถือหรือเปลี่ยนบัญชีไลน์ " +
    "กรุณาติดต่อฝ่ายทรัพยากรบุคคลให้ปลดสิทธิ์ของบัญชีเดิมก่อน แล้วจึงกลับมาลงทะเบียนใหม่",
};

async function checkEmp() {
  const code = $("#empid").value.trim();
  if (!code) return toast("กรุณากรอกรหัสพนักงาน");
  if (!/^\d{5}$/.test(code)) return toast("รหัสพนักงานต้องเป็นตัวเลข 5 หลัก");
  try {
    const r = await api("/api/auth/verify-employee", { method: "POST", body: { employee_code: code } });
    // ระบบเปิดให้เฉพาะคนที่ฝ่ายบุคคลลงทะเบียนไว้แล้ว — ไม่มีทางกรอกข้อมูลเข้ามาเอง
    if (!r.found) return showRegBlocked(code, BLOCKED_NOT_FOUND.title, BLOCKED_NOT_FOUND.sub, BLOCKED_NOT_FOUND.tip);
    // เคยขึ้นเป็นข้อความลอยที่หายไปใน 3 วินาที ทั้งที่เป็นเหตุที่ไปต่อไม่ได้ จึงทำเป็นหน้าเต็มเหมือนกัน
    if (r.already_linked) {
      return showRegBlocked(code, BLOCKED_ALREADY_LINKED.title, BLOCKED_ALREADY_LINKED.sub, BLOCKED_ALREADY_LINKED.tip);
    }
    const e = r.employee;
    $("#f-id").textContent = e.employee_code;
    $("#f-name").textContent = e.full_name;
    $("#f-dept").textContent = e.department_name || "-";
    $("#f-floor").textContent = e.floor || "-";
    $("#f-mail").textContent = e.email || "-";
    $("#reg-found").dataset.code = e.employee_code;
    showRegPart("reg-found");
  } catch (e) {
    toast(e.message);
  }
}

/**
 * ถามย้ำก่อนผูกบัญชี — เพราะผูกแล้วรหัสจะถูกล็อกกับบัญชีไลน์นี้ ปลดได้เฉพาะฝ่ายบุคคล
 * และเรื่องที่แจ้งไว้จะไปผูกกับชื่อคนอื่นถ้ากรอกรหัสของคนอื่น จึงต้องให้เจ้าตัวยืนยันเองก่อน
 */
async function confirmFound() {
  const code = $("#reg-found").dataset.code;
  const ok = await confirmDialog({
    title: "รหัสพนักงานตรงกับชื่อของคุณหรือไม่",
    message:
      "เมื่อกดยืนยันแล้ว รหัสพนักงานนี้จะถูกล็อกกับบัญชีไลน์ของคุณ\n\n" +
      "หากพบว่ารหัสกับชื่อไม่ตรงกันโปรดติดต่อฝ่ายบุคคล",
    note:
      "*หมายเหตุ:\n" +
      "• บริษัทฯ มิได้เก็บรวบรวมข้อมูลส่วนบุคคลอื่นของท่านนอกเหนือจากที่ระบุไว้ข้างต้น\n" +
      "• ระบบผูก LINE เข้ากับรหัสพนักงานเท่านั้น",
    confirmLabel: "ใช่ ยืนยันตัวตน",
    cancelLabel: "ไม่ใช่",
  });
  if (!ok) return;
  try {
    await api("/api/auth/link", { method: "POST", body: { employee_code: code } });
    session = await api("/api/auth/session", { method: "POST" });
    toast("ยืนยันตัวตนเรียบร้อยแล้ว");
    enterApp();
  } catch (e) {
    // มีคนผูกรหัสนี้ตัดหน้าไประหว่างที่ยังค้างหน้ายืนยันอยู่
    if (e.code === "already_linked") {
      return showRegBlocked(code, BLOCKED_ALREADY_LINKED.title, BLOCKED_ALREADY_LINKED.sub, BLOCKED_ALREADY_LINKED.tip);
    }
    toast(e.message);
  }
}

/* ---------- app (form + mine) ---------- */
async function enterApp() {
  $("#appbar").style.display = "flex";
  $("#tabbar").style.display = "flex";
  const emp = session.employee || {};
  $("#me-name").textContent = emp.full_name || session.display_name || "พนักงาน";
  $("#me-dept").textContent = [emp.department_name, emp.floor].filter(Boolean).join(" · ") || "";
  $("#me-av").textContent = (emp.full_name || "?").trim().charAt(0);
  if (!masters) {
    try {
      await getMasters();
      renderMasters();
    } catch (e) {
      toast(e.message);
    }
  }
  // เผยแท็บตามสิทธิ์: เจ้าหน้าที่เห็น "คิวงาน", ผู้ดูแลเห็น "ผู้ดูแล"
  const myDepts = activeDepts();
  if (myDepts.length) {
    $('.tabbar button[data-tab="queue"]').style.display = "";
    queueDept = myDepts[0].code;
    renderQueueDepts();
  }
  if (session.is_admin) {
    $('.tabbar button[data-tab="admin"]').style.display = "";
  }
  goForm();
}

// ไอคอนของแต่ละหมวด (ตามที่ระบุ: จอคอม / หลอดไฟ / ไม้กวาด / เครื่องหมายข้อมูล)
// ทุกไอคอนวาดด้วยรูปทรงพื้นฐาน (สี่เหลี่ยม วงกลม เส้นตรง) และสมมาตรรอบแกน x=12 ทั้งหมด
// เลี่ยงเส้นโค้งที่ลากเอง เพราะทำให้รูปเบี้ยวและดูไม่เท่ากันเมื่อย่อลงเหลือ 20px
const CATEGORY_ICONS = {
  // จอคอมพิวเตอร์ — จอ + ขาตั้ง + ฐาน
  IT: '<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M12 17v3.5M8.5 20.5h7"/></svg>',
  // หลอดไฟ — วงกลมเป็นตัวหลอด + ขีดสองเส้นเป็นขั้ว
  FAC: '<svg viewBox="0 0 24 24"><circle cx="12" cy="9.5" r="5.5"/><path d="M9.5 16h5M10.5 19h3"/></svg>',
  // ไม้กวาด — ด้ามตรงกลาง + หัวทรงบานออก + เส้นแบ่งขนไม้กวาด
  CLN: '<svg viewBox="0 0 24 24"><path d="M12 2.5v9"/><path d="M7.5 11.5h9l1 8H6.5Z"/><path d="M10 11.5v8M14 11.5v8"/></svg>',
  // เครื่องหมายข้อมูล (i)
  GEN: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11.5v5M12 7.8h.01"/></svg>',
};
const CATEGORY_CLASS = { IT: "c-it", FAC: "c-fac", CLN: "c-cln", GEN: "c-gen" };

function renderMasters() {
  // หมวด
  const cats = $("#cats");
  cats.innerHTML = "";
  masters.categories.forEach((c) => {
    const b = document.createElement("button");
    b.className = "cat " + (CATEGORY_CLASS[c.code] || "");
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.dataset.code = c.code;
    b.innerHTML = `<span class="ic">${CATEGORY_ICONS[c.code] || ""}</span><span class="nm">${c.label}</span>`;
    b.onclick = () => {
      $$("#cats .cat").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      picked = c;
      const send = $("#sendBtn");
      send.disabled = false;
      send.textContent = "ส่งเรื่อง";
    };
    cats.appendChild(b);
  });
  // ชั้น — มีตัวเลือก "ชั้นอื่น" ปิดท้าย สำหรับจุดที่ไม่อยู่ในรายการ (เช่น ลานจอดรถ ดาดฟ้า ชั้นใต้ดิน)
  const fl = $("#floor");
  fl.innerHTML =
    '<option value="">เลือกชั้น</option>' +
    masters.floors.map((f) => `<option>${esc(f)}</option>`).join("") +
    `<option value="${PICK_OTHER}">ชั้นอื่น</option>`;
  // ความเร่งด่วน
  const urg = $("#urg");
  urg.innerHTML = "";
  masters.urgencies.forEach((u, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.u = u.code;
    b.setAttribute("aria-pressed", String(i === 0));
    b.innerHTML = `${u.label}<small>${u.note}</small>`;
    b.onclick = () => {
      $$("#urg button").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
    };
    urg.appendChild(b);
  });
}

function currentUrgency() {
  const b = $('#urg button[aria-pressed="true"]');
  return b ? b.dataset.u : "normal";
}

function goForm() {
  setTab("form");
  show("s-form");
}

async function submitTicket() {
  if (!picked) return toast("กรุณาเลือกประเภทเรื่องที่แจ้ง");
  const picked_floor = $("#floor").value;
  const floor = picked_floor === PICK_OTHER ? $("#floorOther").value.trim() : picked_floor;
  const detail = $("#detail").value.trim();
  if (!picked_floor) return toast("กรุณาเลือกชั้นที่เกิดเหตุ");
  if (!floor) return toast("กรุณาระบุว่าเป็นชั้นไหน");
  if (!detail) return toast("กรุณาระบุรายละเอียดของปัญหา");

  const btn = $("#sendBtn");
  btn.disabled = true;
  btn.textContent = "กำลังส่ง…";
  try {
    // อัปโหลดไฟล์แนบ — ถ้าพลาด ยังส่งเรื่องต่อ (ไม่ทิ้งเรื่องที่พิมพ์มาแล้ว) แต่ต้องบอกผู้ใช้ให้รู้
    // ห้ามเงียบ ไม่งั้นผู้ใช้จะเข้าใจว่าแนบรูปสำเร็จทั้งที่รูปหายไป
    const attachments = [];
    let uploadError = null;
    for (const f of pendingFiles) {
      try {
        const up = await api("/api/uploads", {
          method: "POST",
          body: { content_type: f.type, content_base64: f.base64, filename: "photo" },
        });
        if (up.url) attachments.push(up.url);
      } catch (err) {
        uploadError = err.message || "อัปโหลดภาพไม่สำเร็จ";
      }
    }
    const failedCount = pendingFiles.length - attachments.length;

    const r = await api("/api/tickets", {
      method: "POST",
      body: {
        category_code: picked.code,
        floor,
        location_note: $("#room").value.trim(),
        detail,
        urgency: currentUrgency(),
        attachments,
      },
    });
    resetForm();
    if (failedCount > 0) {
      toast(
        `ส่งเรื่องเรียบร้อยแล้ว เลขที่ <b>${r.ticket_no}</b><br>` +
          `แต่ไม่สามารถแนบภาพได้ ${failedCount} ภาพ${uploadError ? " (" + esc(uploadError) + ")" : ""}`,
      );
    } else {
      toast(`ส่งเรื่องเรียบร้อยแล้ว เลขที่ <b>${esc(r.ticket_no)}</b>`, { html: true });
    }
    goMine();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = picked ? "ส่งเรื่อง" : "กรุณาเลือกประเภทเรื่องที่แจ้ง";
  }
}

function resetForm() {
  picked = null;
  pendingFiles = [];
  $("#thumbs").innerHTML = "";
  $("#room").value = "";
  $("#detail").value = "";
  $("#floor").value = "";
  $("#floorOther").value = "";
  $("#floorOther").style.display = "none";
  $$("#cats .cat").forEach((x) => x.setAttribute("aria-pressed", "false"));
  const send = $("#sendBtn");
  send.disabled = true;
  send.textContent = "กรุณาเลือกประเภทเรื่องที่แจ้ง";
}

/* ---------- mine ---------- */
async function goMine() {
  setTab("mine");
  show("s-mine");
  const list = $("#mineList");
  list.innerHTML = '<div class="empty">กำลังโหลดข้อมูล…</div>';
  try {
    const r = await api("/api/tickets/mine");
    if (!r.tickets.length) {
      list.innerHTML = '<div class="empty">ยังไม่มีรายการเรื่องที่แจ้ง</div>';
      return;
    }
    list.innerHTML = r.tickets.map(renderTicketCard).join("");
  } catch (e) {
    list.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

const PILL = {
  pending: "p-wait",
  in_progress: "p-doing",
  completed: "p-done",
  closed: "p-closed",
  cancelled: "p-suspend",
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function renderTicketCard(t) {
  const steps = t.timeline
    .map(
      (e, i) =>
        `<div class="step ${i === t.timeline.length - 1 ? "now" : "ok"}"><span class="dot"></span>
          <div><div class="lbl">${esc(e.status_label)}${e.note ? " · " + esc(e.note) : ""}</div></div></div>`,
    )
    .join("");
  // ยกเลิกได้เฉพาะตอนที่ยังไม่มีเจ้าหน้าที่รับเรื่อง (แจ้งผิด/แจ้งซ้ำแล้วอยากถอน)
  const cancelBtn =
    t.status === "pending" ? '<div class="actions"><button data-act="cancel">ยกเลิกเรื่อง</button></div>' : "";
  return `<div class="card clickable" data-id="${t.id}">
    <div class="cardtop">
      <div>
        <div class="tid">${esc(t.ticket_no)}</div>
        <div class="ttl">${esc(t.detail)}</div>
        <div class="meta">${esc(t.category_label)} · ${esc(t.floor)}${t.location_note ? " · " + esc(t.location_note) : ""}</div>
      </div>
      <span class="pill ${PILL[t.status] || "p-closed"}">${esc(t.status_label)}</span>
    </div>
    <div class="rail">${steps}</div>
    ${cancelBtn}
  </div>`;
}

/* ---------- routing ---------- */
function routeTab(tab) {
  $("#backbtn").style.display = "none";
  if (tab === "form") goForm();
  else if (tab === "mine") goMine();
  else if (tab === "queue") goQueue();
  else if (tab === "admin") goAdmin();
}

/* ---------- queue (เจ้าหน้าที่) ---------- */

/**
 * ฝ่ายที่เรารับผิดชอบ เฉพาะที่ยังเปิดใช้งานอยู่ พร้อมชื่อสำหรับแสดงบนชิป
 * /api/masters คืนเฉพาะฝ่ายที่เปิดใช้งาน — ฝ่ายที่ปิดไปแล้ว (เช่น CLN ที่ยุบไปรวมกับ ADMIN)
 * จึงหลุดออกไปเอง ไม่ต้องขึ้นชิปให้กดค้างไว้ทั้งที่ไม่มีวันมีงานเข้า
 */
function activeDepts() {
  const names = new Map(
    (masters?.departments || []).filter((d) => d.receives_tickets).map((d) => [d.code, d.name]),
  );
  return (session.dept_roles || [])
    .filter((r) => names.has(r.code))
    .map((r) => ({ code: r.code, name: names.get(r.code) }));
}

function renderQueueDepts() {
  const wrap = $("#queue-depts");
  const depts = activeDepts();
  if (depts.length <= 1) {
    wrap.style.display = "none";
    return;
  }
  wrap.style.display = "flex";
  wrap.innerHTML = depts
    .map((d) => `<button class="chip" data-dept="${esc(d.code)}" aria-pressed="${d.code === queueDept}">${esc(d.name)}</button>`)
    .join("");
}

async function goQueue() {
  setTab("queue");
  show("s-queue");
  const list = $("#queueList");
  list.innerHTML = '<div class="empty">กำลังโหลดข้อมูล…</div>';
  const params = new URLSearchParams();
  if (queueDept) params.set("dept", queueDept);
  if (queueFilter === "pending") params.set("status", "pending");
  if (queueFilter === "me") params.set("assignee", "me");
  try {
    const r = await api("/api/tickets/department?" + params.toString());
    if (!r.tickets.length) {
      list.innerHTML = '<div class="empty">ไม่มีรายการ</div>';
      return;
    }
    list.innerHTML = r.tickets.map((t) => renderQueueCard(t, queueDept)).join("");
  } catch (e) {
    list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderQueueCard(t, deptCode) {
  let actions = "";
  if (t.status === "pending") {
    actions =
      '<button class="fill" data-act="claim">รับเรื่อง</button><button data-act="transfer">ส่งต่อฝ่าย</button><button data-act="cancel">ยกเลิก</button>';
  } else if (t.status === "in_progress") {
    actions = '<button class="fill" data-act="complete">แล้วเสร็จ</button><button data-act="transfer">ส่งต่อฝ่าย</button>';
  } else if (t.status === "completed") {
    actions = ""; // ดำเนินการเสร็จสิ้นคือจุดจบของงานแล้ว ไม่มีขั้นปิดเรื่องต่อ
  }
  const tag = t.urgency === "critical" ? " · เร่งด่วนมาก" : t.urgency === "urgent" ? " · เร่งด่วน" : "";
  return `<div class="card clickable" data-id="${t.id}" data-dept="${esc(deptCode || "")}">
    <div class="cardtop">
      <div>
        <div class="tid">${esc(t.ticket_no)}${tag}</div>
        <div class="ttl">${esc(t.detail)}</div>
        <div class="meta">${esc(t.reporter_name)}${t.reporter_dept ? " · " + esc(t.reporter_dept) : ""} · ${esc(t.floor)}${t.location_note ? " · " + esc(t.location_note) : ""}</div>
      </div>
      <span class="pill ${PILL[t.status] || "p-closed"}">${esc(t.status_label)}</span>
    </div>
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </div>`;
}

async function doStatus(id, to, okMsg, note) {
  try {
    await api(`/api/tickets/${id}/status`, { method: "PATCH", body: { to_status: to, note } });
    toast(okMsg || "อัปเดตสถานะเรียบร้อยแล้ว");
    goQueue();
  } catch (e) {
    toast(e.message);
  }
}

async function openTransferSheet(id, currentDeptCode) {
  const opts = (masters.departments || [])
    .filter((d) => d.receives_tickets && d.code !== currentDeptCode)
    .map((d) => ({ label: d.name, value: d.code }));
  if (!opts.length) return toast("ไม่มีฝ่ายปลายทางให้ส่งต่อ");
  const to = await openSheet("เลือกฝ่ายปลายทาง", opts);
  if (!to) return;
  try {
    await api(`/api/tickets/${id}/transfer`, { method: "PATCH", body: { to_dept: to } });
    toast("ส่งต่อเรื่องเรียบร้อยแล้ว");
    goQueue();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- admin (ผู้ดูแล) ---------- */

/**
 * รายชื่อพนักงานจัดกลุ่มตามฝ่ายต้นสังกัด พับเก็บไว้ก่อนทั้งหมด
 *
 * ทั้งองค์กรมีร้อยกว่าคน ถ้าเรียงเป็นรายการเดียวจะยาวหลายสิบหน้าจอจนหาอะไรไม่เจอ
 * พับเป็นฝ่ายแล้วทั้งองค์กรจบในไม่กี่หน้าจอ กดฝ่ายไหนจึงคลี่เฉพาะฝ่ายนั้น
 * ส่วนกลุ่ม "ทีมงานระบบ" (คนที่ดูแลฝ่ายผู้รับเรื่อง) ยกขึ้นบนสุดและคลี่ไว้ตั้งแต่แรก
 * เพราะเป็นกลุ่มที่ผู้ดูแลเข้ามาดูบ่อยที่สุด
 */
const TEAM_GROUP = "__team__";
const NO_DEPT_GROUP = "__nodept__";
let adminRows = []; // รายชื่อรอบล่าสุดที่โหลดมา ใช้วาดใหม่ตอนพับ/คลี่โดยไม่ต้องยิงเซิร์ฟเวอร์ซ้ำ
const adminOpen = new Set([TEAM_GROUP]); // ฝ่ายที่กำลังคลี่อยู่

async function goAdmin() {
  setTab("admin");
  show("s-admin");
  // ฟอร์มเพิ่มพนักงานเกี่ยวกับรายชื่อพนักงานปัจจุบันเท่านั้น หน้าผู้ถูกระงับสิทธิ์ไม่ต้องมี
  if (adminView !== "active") closeEmpForm();
  $("#admin-add").style.display =
    adminView === "active" && $("#admin-new").style.display === "none" ? "" : "none";
  const list = $("#adminList");
  list.innerHTML = '<div class="empty">กำลังโหลดข้อมูล…</div>';
  const params = new URLSearchParams();
  if (adminQ) params.set("q", adminQ);
  try {
    params.set("status", adminView);
    const r = await api("/api/admin/employees?" + params.toString());
    adminRows = r.employees;
    adminEmployeeIndex.clear();
    adminRows.forEach((e) => adminEmployeeIndex.set(e.id, e));
    renderAdminList();
  } catch (e) {
    list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/**
 * ฝ่ายที่ยุบรวมเป็นหัวข้อพับเดียวกัน — เฉพาะหัวข้อที่พับเท่านั้น
 * ชื่อฝ่ายจริงของแต่ละคนยังขึ้นในบรรทัดใต้ชื่อตามเดิม ข้อมูลในระบบไม่ถูกแก้
 *
 * ฝ่ายของบริษัท PMTA แตกย่อยจนเหลือฝ่ายละคนสองคน พับแยกทีละฝ่ายเลยได้แต่หัวข้อเปล่า ๆ
 * ส่วน Finance & Accounting กับ Corporate Finance & Accounting เป็นงานสายเดียวกัน
 */
const DEPT_MERGE = { "Finance & Accounting": "Corporate Finance & Accounting" };
function deptGroupOf(name) {
  const dept = (name || "").trim();
  if (!dept) return NO_DEPT_GROUP;
  if (dept.startsWith("PM ")) return "PMTA";
  return DEPT_MERGE[dept] || dept;
}

/** แบ่งรายชื่อเป็นกลุ่ม — ทีมงานระบบขึ้นก่อน แล้วไล่ฝ่ายตามตัวอักษร คนที่ไม่ระบุฝ่ายไว้ท้ายสุด */
function groupEmployees(rows) {
  const team = rows.filter((e) => (e.depts || []).length);
  const byDept = new Map();
  rows.forEach((e) => {
    const key = deptGroupOf(e.department_name);
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(e);
  });
  const byName = (a, b) => a.full_name.localeCompare(b.full_name, "th");
  const groups = [];
  if (team.length) groups.push({ key: TEAM_GROUP, name: "ผู้รับผิดชอบและหัวหน้าฝ่าย", rows: team.sort(byName) });
  [...byDept.keys()]
    .sort((a, b) =>
      a === NO_DEPT_GROUP ? 1 : b === NO_DEPT_GROUP ? -1 : a.localeCompare(b, "th"),
    )
    .forEach((key) => {
      groups.push({
        key,
        name: key === NO_DEPT_GROUP ? "ไม่ได้ระบุฝ่าย" : key,
        rows: byDept.get(key).sort(byName),
        dept: true,
      });
    });
  return { groups, teamCount: team.length };
}

function renderAdminList() {
  const list = $("#adminList");
  const toggle =
    adminView === "active"
      ? '<button class="linkbtn" id="admin-toggle">รายชื่อผู้ถูกระงับสิทธิ์ →</button>'
      : '<button class="linkbtn" id="admin-toggle">← กลับไปรายชื่อพนักงานปัจจุบัน</button>';

  if (!adminRows.length) {
    const msg = adminQ
      ? `ไม่พบใครที่ตรงกับ “${esc(adminQ)}”`
      : adminView === "active"
        ? "ไม่พบข้อมูลพนักงาน"
        : "ไม่มีรายชื่อผู้ถูกระงับสิทธิ์";
    list.innerHTML = `<div class="empty">${msg}</div>${toggle}`;
    return;
  }

  // กำลังค้นหา หรือดูหน้าผู้ถูกระงับสิทธิ์ — แสดงเป็นรายการเรียบ ไม่ต้องพับเป็นฝ่าย
  // เพราะทั้งสองกรณีมีคนไม่กี่คน การพับกลับทำให้ต้องกดเพิ่มโดยไม่ได้อะไร
  if (adminQ || adminView !== "active") {
    const head = adminQ
      ? `<div class="section">พบ ${adminRows.length} คน</div>`
      : '<div class="section">ระงับสิทธิ์</div>';
    list.innerHTML = `${head}<div class="plist">${adminRows.map(personRow).join("")}</div>${toggle}`;
    return;
  }

  const { groups } = groupEmployees(adminRows);
  const html = groups
    .map((g, i) => {
      const open = adminOpen.has(g.key);
      const label = i === 0 && g.key === TEAM_GROUP ? '<div class="section">ทีมงานระบบ</div>' : "";
      const deptLabel = g.dept && !groups.slice(0, i).some((x) => x.dept) ? '<div class="section">ตามฝ่าย</div>' : "";
      const body = open ? `<div class="grp-body">${g.rows.map(personRow).join("")}</div>` : "";
      return `${label}${deptLabel}
        <button class="grp" data-grp="${esc(g.key)}" aria-expanded="${open}">
          <svg class="gcv" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
          <span class="gnm">${esc(g.name)}</span>
          <span class="gct">${g.rows.length}</span>
        </button>${body}`;
    })
    .join("");
  list.innerHTML = `${html}<div class="section" style="margin-top:14px">รวม ${adminRows.length} คน</div>${toggle}`;
}

/** ป้ายขวาสุดของแถว — บอกได้แค่เรื่องเดียว จึงเลือกเรื่องที่สำคัญที่สุดของคนนั้น */
function personTag(e) {
  if (e.status === "suspended") return '<span class="rtag susp">ระงับสิทธิ์</span>';
  const head = (e.depts || []).find((d) => d.role === "head");
  if (head) return `<span class="rtag head">หัวหน้าฝ่าย ${esc(head.code)}</span>`;
  const staff = (e.depts || [])[0];
  if (staff) return `<span class="rtag staff">ผู้รับผิดชอบ ${esc(staff.code)}</span>`;
  if (!e.linked) return '<span class="rtag nolink">ยังไม่ผูก LINE</span>';
  return "";
}

function personRow(e) {
  return `<div class="prow" data-id="${e.id}">
    <div class="pw">
      <div class="pnm">${esc(e.full_name)}</div>
      <div class="psub"><b>${esc(e.employee_code)}</b>${e.department_name ? " · " + esc(e.department_name) : ""}</div>
    </div>${personTag(e)}
  </div>`;
}

/**
 * แผ่นจัดการของพนักงานหนึ่งคน — เปิดเมื่อแตะที่แถว
 * ย้ายปุ่มทั้งหมดมาไว้ตรงนี้ เพื่อให้รายชื่อเหลือแค่ข้อมูลที่ใช้กวาดตาหา
 */
async function openEmployeeSheet(id) {
  const e = adminEmployeeIndex.get(id);
  if (!e) return;
  const suspended = e.status === "suspended";
  const roles = (e.depts || []).map((d) => `${deptName(d.code)} (${ROLE_LABEL[d.role] || d.role})`).join("<br>");
  // บัญชีไลน์ที่ผูกไว้ — ชื่อที่โชว์คือชื่อในไลน์จริงของเจ้าตัว (ปรับตามทุกครั้งที่เขาเปิดแอป)
  // ส่วนรหัสยาว ๆ เก็บไว้ก่อน กดแสดงเมื่อต้องก๊อปไปไล่ปัญหาว่าข้อความไปไม่ถึงใคร
  const line = e.line
    ? `<div class="kv"><i>บัญชีไลน์ที่ผูก</i><b>${esc(e.line.display_name || "ไม่ทราบชื่อ")}</b></div>
       <div class="kv"><i>ผูกบัญชีเมื่อ</i><b>${esc(e.line.linked_at || "-")}</b></div>
       <div class="kv"><i>รหัสผู้ใช้ไลน์</i>
         <span class="uidwrap">
           <b class="uid" data-uid="${esc(e.line.user_id)}">${UID_MASK}</b>
           <button class="uidbtn" data-uid-toggle>แสดง</button>
         </span>
       </div>`
    : '<div class="kv"><i>บัญชี LINE</i><b>ยังไม่ได้ผูก</b></div>';
  const meta = `
    <div class="sub">${esc(e.employee_code)}${e.department_name ? " · " + esc(e.department_name) : ""}</div>
    <div class="kv"><i>ชั้นที่ประจำ</i><b>${esc(e.floor || "ไม่ได้ระบุ")}</b></div>
    ${line}
    <div class="kv"><i>สถานะในระบบ</i><b>${roles || "พนักงาน"}</b></div>
    <div class="kv"><i>แจ้งเรื่องสะสม</i><b>${e.reported_count} รายการ</b></div>
    ${suspended && e.suspend_reason ? `<div class="kv"><i>เหตุผลที่ระงับ</i><b>${esc(e.suspend_reason)}</b></div>` : ""}`;

  const opts = [];
  if (!suspended) opts.push({ label: "เปลี่ยนสถานะ", value: "depts" });
  if (e.linked) opts.push({ label: "ปลดสิทธิ์ · ต้องลงทะเบียนใหม่", value: "unlink" });
  opts.push(
    suspended
      ? { label: "คืนสิทธิ์การใช้งาน", value: "restore" }
      : { label: "ระงับสิทธิ์การใช้งาน", value: "suspend", danger: true },
  );

  const act = await openSheet(e.full_name, opts, { meta });
  if (!act) return;
  try {
    if (act === "depts") return openDeptSheet(e.id, e.full_name, e.depts || []);
    if (act === "unlink") return actUnlink(e.id, e.full_name);
    if (act === "suspend") return actSuspend(e.id, e.full_name);
    if (act === "restore") return actRestore(e.id);
  } catch (err) {
    toast(err.message);
  }
}

async function actUnlink(id, name) {
  const ok = await confirmDialog({
    title: `ปลดสิทธิ์ ${name}?`,
    message:
      "บัญชีไลน์ที่ผูกไว้จะถูกปลดออก ครั้งต่อไปที่เปิดแอปจะกลับไปหน้าลงทะเบียน " +
      "และต้องยืนยันด้วยรหัสพนักงานอีกครั้ง เรื่องที่เคยแจ้งไว้ยังอยู่ครบ",
    confirmLabel: "ปลดสิทธิ์",
    cancelLabel: "ไม่ใช่",
  });
  if (!ok) return;
  await api(`/api/admin/employees/${id}/unlink`, { method: "PATCH" });
  toast("ปลดสิทธิ์เรียบร้อยแล้ว · ต้องลงทะเบียนใหม่ก่อนใช้งาน");
  goAdmin();
}

async function actSuspend(id, name) {
  const reason = await promptDialog({
    title: `ระงับสิทธิ์ ${name}?`,
    message: "พนักงานจะไม่สามารถแจ้งเรื่องใหม่ได้ เรื่องที่แจ้งไว้เดิมยังดำเนินการต่อจนแล้วเสร็จ",
    placeholder: "เหตุผล (ไม่บังคับ)",
    confirmLabel: "ระงับสิทธิ์",
    cancelLabel: "ไม่ใช่",
  });
  if (reason === null) return;
  await api(`/api/admin/employees/${id}/suspend`, { method: "PATCH", body: { action: "suspend", reason } });
  toast("ระงับสิทธิ์เรียบร้อยแล้ว · ย้ายไปรายชื่อผู้ถูกระงับสิทธิ์");
  goAdmin();
}

async function actRestore(id) {
  await api(`/api/admin/employees/${id}/suspend`, { method: "PATCH", body: { action: "restore" } });
  toast("คืนสิทธิ์เรียบร้อยแล้ว · ย้ายไปรายชื่อพนักงานปัจจุบัน");
  goAdmin();
}

const ROLE_LABEL = { head: "หัวหน้าฝ่าย", staff: "ผู้รับผิดชอบฝ่าย" };

/**
 * กำหนดสถานะให้พนักงานหนึ่งคน — เลือกสถานะก่อน แล้วค่อยเลือกฝ่าย
 *
 * สถานะมีสามอย่างคือ พนักงาน / ผู้รับผิดชอบฝ่าย / หัวหน้าฝ่าย
 * สองอย่างหลังต้องบอกด้วยว่าฝ่ายไหน ส่วน "พนักงาน" คือไม่ดูแลฝ่ายใดเลย
 *
 * แยกเป็นสองจังหวะเพราะบนมือถือการกดทีละอย่างอ่านง่ายกว่าตารางที่ต้องเล็งให้ตรงช่อง
 */
async function openDeptSheet(id, name, current) {
  const mine = current || [];
  const have = new Map(mine.map((d) => [d.code, d.role]));
  // สถานะปัจจุบันของคนคนนี้ — เป็นหัวหน้าที่ไหนสักฝ่ายถือว่าเป็นหัวหน้าฝ่าย
  const now = !mine.length ? "none" : mine.some((d) => d.role === "head") ? "head" : "staff";
  const mark = (v) => (v === now ? "✓ " : "");

  const status = await openSheet(`กำหนดสถานะของ ${name}`, [
    { label: `${mark("none")}พนักงาน — ไม่ต้องดูแลฝ่ายใด`, value: "none" },
    { label: `${mark("staff")}ผู้รับผิดชอบฝ่าย — รับเรื่องของฝ่าย`, value: "staff" },
    { label: `${mark("head")}หัวหน้าฝ่าย — รับเรื่อง และรับการเตือนเมื่อเรื่องค้าง`, value: "head" },
  ]);
  if (!status) return;

  let body = null;
  if (status === "none") {
    if (!mine.length) return toast(`${name} เป็นพนักงานอยู่แล้ว`);
    // ดูแลอยู่หลายฝ่ายก็ให้เลือกได้ว่าจะถอดฝ่ายไหน ไม่ใช่ล้างทิ้งทั้งหมดโดยไม่ถาม
    if (mine.length > 1) {
      const pick = await openSheet(`ถอด ${name} ออกจากฝ่ายไหน`, [
        ...mine.map((d) => ({ label: `${deptName(d.code)} — ${ROLE_LABEL[d.role] || d.role}`, value: d.code })),
        { label: "ถอดออกจากทุกฝ่าย", value: "__all__" },
      ]);
      if (!pick) return;
      body = pick === "__all__" ? { clear_all: true } : { department_code: pick, role: "" };
    } else {
      const ok = await confirmDialog({
        title: `ให้ ${name} เป็นพนักงาน?`,
        message: `จะถอดออกจาก ${deptName(mine[0].code)} และจะไม่เห็นคิวงานของฝ่ายอีก เรื่องที่เคยแจ้งไว้ยังอยู่ครบ`,
        confirmLabel: "เปลี่ยนเป็นพนักงาน",
        cancelLabel: "ไม่ใช่",
      });
      if (!ok) return;
      body = { clear_all: true };
    }
  } else {
    // ฝ่ายที่ให้สิทธิ์ผู้ดูแลต้องบอกไว้ตรงนี้ ไม่งั้นการเพิ่มคนเข้าฝ่ายนั้นดูเหมือนงานธรรมดา
    // ทั้งที่ผลคือคนนั้นเห็นและแก้ข้อมูลพนักงานทั้งองค์กรได้
    const opts = (masters.departments || []).map((d) => ({
      label:
        `${d.name}${d.grants_admin ? " · ให้สิทธิ์ผู้ดูแลระบบ" : ""}` +
        `${have.get(d.code) ? ` — ปัจจุบัน: ${ROLE_LABEL[have.get(d.code)]}` : ""}`,
      value: d.code,
    }));
    if (!opts.length) return toast("ยังไม่มีฝ่ายที่เปิดใช้งาน");
    const code = await openSheet(`${ROLE_LABEL[status]} — เลือกฝ่าย`, opts);
    if (!code) return;
    body = { department_code: code, role: status };

    // ดูแลฝ่ายอื่นอยู่แล้ว ต้องถามว่าย้ายหรือดูแลเพิ่ม — ถ้าเดาเอาว่า "เพิ่ม" เสมอ คนที่ตั้งใจ
    // จะย้ายฝ่ายจะกลายเป็นดูแลสองฝ่ายเงียบ ๆ แล้วรับคิวงานกับการเตือนของฝ่ายเดิมต่อไป
    const others = mine.filter((d) => d.code !== code);
    if (others.length) {
      const keep = others.map((d) => deptName(d.code)).join(" และ ");
      const choice = await openSheet(`${deptName(code)} — ฝ่ายเดิมเอาอย่างไร`, [
        { label: `ย้ายมาที่ ${deptName(code)} อย่างเดียว`, value: "move" },
        { label: `ดูแลเพิ่ม โดยยังอยู่ ${keep} ด้วย`, value: "add" },
      ]);
      if (!choice) return;
      if (choice === "move") body.replace = true;
    }
  }

  try {
    await api(`/api/admin/employees/${id}/departments`, { method: "PATCH", body });
    toast(status === "none" ? "เปลี่ยนเป็นพนักงานเรียบร้อยแล้ว" : `กำหนดเป็น${ROLE_LABEL[status]}เรียบร้อยแล้ว`);
    // แก้สิทธิ์ของตัวเองแล้วต้องโหลด session ใหม่ ไม่งั้นแท็บคิวงานจะยังเป็นชุดเดิม
    if (session.employee && session.employee.id === id) {
      session = await api("/api/auth/session", { method: "POST" });
    }
    goAdmin();
  } catch (e) {
    toast(e.message);
  }
}

/** ชื่อเต็มของฝ่ายจากรหัส — ฝ่ายที่ถูกปิดใช้งานไปแล้วจะไม่มีในรายการ ก็แสดงรหัสไปตรง ๆ */
function deptName(code) {
  const d = (masters.departments || []).find((x) => x.code === code);
  return d ? d.name : code;
}

// รหัสผู้ใช้ไลน์เป็นสตริงยาวที่ไม่ได้ใช้ในงานประจำวัน ขึ้นค้างไว้มีแต่ทำให้แผ่นรก
// ซ่อนไว้ก่อนแล้วให้กดแสดงเมื่อต้องใช้จริง
const UID_MASK = "••••••••••••";

/* ---------- เพิ่มพนักงานเข้าระบบ (ผู้ดูแล) ---------- */

/** ใส่ตัวเลือกลงใน select พร้อมบรรทัดหัวข้อว่าง และตัวเลือก "อื่น ๆ" ปิดท้ายถ้าต้องการ */
function fillSelect(el, placeholder, options, other) {
  el.innerHTML =
    `<option value="">${esc(placeholder)}</option>` +
    options.map((o) => `<option>${esc(o)}</option>`).join("") +
    (other ? `<option value="${PICK_OTHER}">${esc(other)}</option>` : "");
}

/** เผยช่องพิมพ์เองเมื่อเลือก "อื่น ๆ" — ซ่อนไว้ก่อนเพื่อไม่ให้ฟอร์มรกด้วยช่องที่แทบไม่ได้ใช้ */
function revealOther(sel, input) {
  const other = sel.value === PICK_OTHER;
  input.style.display = other ? "" : "none";
  if (other) input.focus();
  else input.value = "";
}

/** ค่าที่เลือกไว้ โดยถ้าเลือก "อื่น ๆ" ให้ใช้ข้อความที่พิมพ์เองแทน */
function pickedValue(sel, input) {
  return sel.value === PICK_OTHER ? input.value.trim() : sel.value;
}

function openEmpForm() {
  fillSelect($("#n-dept"), "เลือกฝ่าย/แผนก", ORG_DEPTS, "อื่น ๆ (ระบุเอง)");
  fillSelect($("#n-floor"), "เลือกชั้น", (masters && masters.floors) || [], "ชั้นอื่น");
  $("#admin-add").style.display = "none";
  $("#admin-new").style.display = "block";
  $("#n-code").focus();
}

function closeEmpForm() {
  ["#n-code", "#n-name", "#n-deptOther", "#n-floorOther"].forEach((s) => ($(s).value = ""));
  $("#n-deptOther").style.display = "none";
  $("#n-floorOther").style.display = "none";
  $("#admin-new").style.display = "none";
  $("#admin-add").style.display = "";
}

async function saveEmployee() {
  const code = $("#n-code").value.trim();
  const name = $("#n-name").value.trim();
  const dept = pickedValue($("#n-dept"), $("#n-deptOther"));
  const floor = pickedValue($("#n-floor"), $("#n-floorOther"));

  // รหัสต้องเป็นตัวเลข 5 หลักให้ตรงกับที่หน้าผูกบัญชียอมรับ ไม่งั้นเจ้าตัวจะผูกบัญชีไม่ได้
  if (!/^\d{5}$/.test(code)) return toast("รหัสพนักงานต้องเป็นตัวเลข 5 หลัก");
  if (!name) return toast("กรุณากรอกชื่อ–สกุล");
  if (!dept) return toast("กรุณาเลือกหรือระบุฝ่าย/แผนก");
  // ตั้งใจให้ชื่อเป็นภาษาอังกฤษเหมือนกันทั้งระบบ แต่ไม่ปิดกั้นถ้ายืนยันว่าจะใช้ภาษาไทยจริง ๆ
  if (/[\u0E00-\u0E7F]/.test(name)) {
    const ok = await confirmDialog({
      title: "ชื่อที่กรอกเป็นภาษาไทย",
      message: "ระบบใช้ชื่อ–สกุลภาษาอังกฤษเป็นหลัก ต้องการบันทึกตามที่กรอกไว้หรือไม่",
      confirmLabel: "บันทึกตามนี้",
      cancelLabel: "กลับไปแก้",
    });
    if (!ok) return;
  }

  const btn = $("#n-save");
  btn.disabled = true;
  try {
    const r = await api("/api/admin/employees", {
      method: "POST",
      body: { employee_code: code, full_name: name, department_name: dept, floor },
    });
    closeEmpForm();
    toast(`เพิ่ม ${r.employee.full_name} เรียบร้อยแล้ว`);
    // ค้นด้วยรหัสที่เพิ่งเพิ่ม เพื่อให้เห็นการ์ดของคนนั้นทันที แม้จะมีคำค้นเดิมค้างอยู่ในช่องค้นหา
    adminQ = r.employee.employee_code;
    $("#admin-q").value = adminQ;
    adminView = "active";
    goAdmin();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- detail ---------- */
async function openDetail(id, fromTab) {
  detailReturnTab = fromTab || "mine";
  show("s-detail");
  $("#backbtn").style.display = "block";
  const body = $("#detailBody");
  body.innerHTML = '<div class="empty">กำลังโหลดข้อมูล…</div>';
  try {
    const t = await api(`/api/tickets/${id}`);
    body.innerHTML = renderDetail(t);
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/**
 * ผลตรวจสอบหลังรับเรื่อง — กำหนดเสร็จเน้นสีเขียว เพราะเป็นคำตอบที่ผู้แจ้งเปิดมาหาก่อนอย่างอื่น
 * เรื่องที่ยังไม่ได้แจ้งผลจะไม่มีบล็อกนี้เลย ไม่ต้องขึ้นช่องว่างให้รก
 */
function renderAssessment(a) {
  if (!a) return "";
  const when = [a.due_label, a.due_date_label].filter(Boolean).join(" · ");
  return `
    <div class="dkv"><b>${a.waiting_parts ? "รออะไหล่ ถึง" : "คาดว่าเสร็จ"}</b><span class="due">${esc(when || "-")}</span></div>
    ${a.note ? `<div class="dkv"><b>อาการที่พบ</b><span>${esc(a.note)}</span></div>` : ""}`;
}

function renderDetail(t) {
  const steps = (t.timeline || [])
    .map(
      (e, i) =>
        `<div class="step ${i === t.timeline.length - 1 ? "now" : "ok"}"><span class="dot"></span><div><div class="lbl">${esc(e.status_label)}${e.note ? " · " + esc(e.note) : ""}</div></div></div>`,
    )
    .join("");
  const shots = (t.attachments || [])
    .filter((a) => a.file_url)
    .map((a) => `<img class="shot" src="${esc(a.file_url)}" alt="ภาพประกอบ" />`)
    .join("");
  return `<div class="card">
    <div class="cardtop"><div>
      <div class="tid">${esc(t.ticket_no)}</div>
      <div class="ttl">${esc(t.category_label)}</div>
    </div><span class="pill ${PILL[t.status] || "p-closed"}">${esc(t.status_label)}</span></div>
    <div style="margin-top:10px">
      <div class="dkv"><b>ผู้แจ้ง</b><span>${esc(t.reporter_name)}</span></div>
      <div class="dkv"><b>สถานที่</b><span>${esc(t.floor)}${t.location_note ? " · " + esc(t.location_note) : ""}</span></div>
      <div class="dkv"><b>รายละเอียด</b><span>${esc(t.detail)}</span></div>
      ${t.assignee_name ? `<div class="dkv"><b>ผู้รับผิดชอบ</b><span>${esc(t.assignee_name)}</span></div>` : ""}
      ${renderAssessment(t.assessment)}
    </div>
    ${shots ? `<div style="margin-top:10px">${shots}</div>` : ""}
    <div class="rail">${steps}</div>
  </div>`;
}

/* ---------- bottom sheet ---------- */
/**
 * แผ่นเลือกจากด้านล่าง — คืนค่าที่เลือก หรือ null เมื่อปิดทิ้ง
 * meta คือบล็อกข้อมูลเหนือรายการตัวเลือก (เป็น HTML จึงต้อง escape มาจากผู้เรียก)
 * ตัวเลือกที่ตั้ง danger ไว้จะขึ้นเป็นสีแดง สำหรับการกระทำที่ย้อนกลับยาก
 */
function openSheet(title, options, { meta = "" } = {}) {
  return new Promise((resolve) => {
    sheetPick = resolve;
    $("#sheet-title").textContent = title;
    $("#sheet-meta").innerHTML = meta;
    const c = $("#sheet-opts");
    c.innerHTML = "";
    options.forEach((o) => {
      const b = document.createElement("button");
      b.className = o.danger ? "opt danger" : "opt";
      b.textContent = o.label;
      b.onclick = () => finishSheet(o.value);
      c.appendChild(b);
    });
    $("#sheet").classList.add("on");
    $("#backdrop").classList.add("on");
  });
}
function finishSheet(v) {
  $("#sheet").classList.remove("on");
  $("#backdrop").classList.remove("on");
  const r = sheetPick;
  sheetPick = null;
  if (r) r(v);
}

/* ---------- หน้าต่างยืนยัน ----------
 * ใช้แทน window.confirm เพราะหน้าต่างของเบราว์เซอร์แต่งข้อความไม่ได้
 * และมีบรรทัดชื่อเว็บติดมาด้วยเสมอ
 */
let confirmResolve = null;
let modalHasInput = false;

function openModal({ title, message = "", note = "", confirmLabel = "ยืนยัน", cancelLabel = "ไม่ใช่", input = null }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    modalHasInput = !!input;
    $("#modal-title").textContent = title;
    const msg = $("#modal-msg");
    msg.textContent = message;
    msg.style.display = message ? "" : "none";
    // ต้องล้างทุกครั้ง ไม่งั้นหมายเหตุของหน้าต่างก่อนหน้าจะค้างมาโผล่ในหน้าต่างถัดไป
    const noteEl = $("#modal-note");
    noteEl.textContent = note;
    noteEl.style.display = note ? "" : "none";

    const field = $("#modal-input");
    if (input) {
      field.value = "";
      field.placeholder = input.placeholder || "";
      field.style.display = "";
    } else {
      field.style.display = "none";
    }

    $("#modal-yes").textContent = confirmLabel;
    $("#modal-no").textContent = cancelLabel;
    $("#modal").classList.add("on");
    $("#backdrop").classList.add("on");
    if (input) setTimeout(() => field.focus(), 60);
  });
}

/** ถามยืนยัน — คืนค่า true/false */
function confirmDialog(opts) {
  return openModal(opts);
}

/** ถามพร้อมให้กรอกข้อความ — คืนค่าข้อความที่กรอก หรือ null เมื่อยกเลิก */
function promptDialog(opts) {
  return openModal({ ...opts, input: { placeholder: opts.placeholder || "" } });
}

function closeConfirm(ok) {
  $("#modal").classList.remove("on");
  $("#backdrop").classList.remove("on");
  const r = confirmResolve;
  const hadInput = modalHasInput;
  const value = $("#modal-input").value.trim();
  confirmResolve = null;
  modalHasInput = false;
  if (!r) return;
  // โหมดกรอกข้อความคืนข้อความ (หรือ null เมื่อยกเลิก) ส่วนโหมดยืนยันคืน true/false
  r(hadInput ? (ok ? value : null) : ok);
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/* ---------- attachments (client-side compress) ---------- */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => (img.src = reader.result);
    reader.onerror = reject;
    img.onload = () => {
      const max = 1600;
      let { width, height } = img;
      if (width > max || height > max) {
        const s = max / Math.max(width, height);
        width = Math.round(width * s);
        height = Math.round(height * s);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      resolve({ base64: dataUrl.split(",")[1], type: "image/jpeg" });
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function onPickFiles(input) {
  const files = [...input.files].slice(0, 3 - pendingFiles.length);
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    try {
      const c = await compressImage(f);
      pendingFiles.push(c);
      // แสดงภาพจริงที่แนบ แทนไอคอนตัวแทน — ผู้ใช้ตรวจได้ว่าแนบถูกภาพ
      const d = document.createElement("div");
      d.className = "thumb";
      d.style.backgroundImage = `url("data:${c.type};base64,${c.base64}")`;
      d.style.backgroundSize = "cover";
      d.style.backgroundPosition = "center";
      $("#thumbs").appendChild(d);
    } catch {
      toast("ไม่สามารถอ่านไฟล์ภาพได้");
    }
  }
  input.value = "";
}

/* ---------- wire up ---------- */
window.addEventListener("DOMContentLoaded", () => {
  $("#btn-check").onclick = checkEmp;
  $("#btn-confirm-found").onclick = confirmFound;
  $("#btn-not-me").onclick = () => showRegPart("reg-input");
  $("#btn-notfound-back").onclick = () => showRegPart("reg-input");
  $("#sendBtn").onclick = submitTicket;

  // เลือก "ชั้นอื่น" แล้วค่อยเผยช่องให้พิมพ์ — ไม่งั้นฟอร์มจะรกด้วยช่องที่แทบไม่ได้ใช้
  $("#floor").onchange = () => revealOther($("#floor"), $("#floorOther"));
  $("#file").onchange = (e) => onPickFiles(e.target);
  $$(".tabbar button").forEach((b) => (b.onclick = () => routeTab(b.dataset.tab)));

  // ปุ่มย้อนกลับจากหน้ารายละเอียด
  $("#backbtn").onclick = () => routeTab(detailReturnTab);

  // หน้า "เรื่องที่แจ้ง": ปุ่มยกเลิก + แตะการ์ดเพื่อดูรายละเอียด
  $("#mineList").addEventListener("click", async (e) => {
    const card = e.target.closest(".card[data-id]");
    if (!card) return;
    const btn = e.target.closest("button[data-act]");
    if (btn && btn.dataset.act === "cancel") {
      e.stopPropagation();
      const ok = await confirmDialog({
        title: "ยกเลิกเรื่องนี้?",
        message: "เมื่อยกเลิกแล้ว จะไม่มีเจ้าหน้าที่ดำเนินการต่อ",
        confirmLabel: "ยกเลิกเรื่อง",
        cancelLabel: "ไม่ใช่",
      });
      if (!ok) return;
      try {
        await api(`/api/tickets/${card.dataset.id}/status`, { method: "PATCH", body: { to_status: "cancelled" } });
        toast("ยกเลิกเรื่องเรียบร้อยแล้ว");
        goMine();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    openDetail(card.dataset.id, "mine");
  });

  // คิวงาน: ปุ่มดำเนินการ + แตะการ์ดดูรายละเอียด
  $("#queueList").addEventListener("click", (e) => {
    const card = e.target.closest(".card[data-id]");
    if (!card) return;
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      e.stopPropagation();
      const id = card.dataset.id;
      const act = btn.dataset.act;
      if (act === "claim") doStatus(id, "in_progress", "รับเรื่องเรียบร้อยแล้ว");
      else if (act === "complete") doStatus(id, "completed", "ปรับสถานะเป็นดำเนินการแล้วเสร็จ");
      else if (act === "transfer") openTransferSheet(id, card.dataset.dept);
      else if (act === "cancel") {
        // ยกเลิกงานของคนอื่นต้องบอกเหตุผลได้เสมอ — เหตุผลถูกบันทึกลงประวัติ ส่งให้ผู้แจ้ง
        // และขึ้นบนการ์ดในกลุ่ม เหมือนกับการยกเลิกผ่านปุ่มในกลุ่ม
        promptDialog({
          title: "ยกเลิกเรื่องนี้?",
          message: "ระบบจะแจ้งเหตุผลให้ผู้แจ้งทราบโดยอัตโนมัติ",
          placeholder: "เหตุผลที่ยกเลิก เช่น แจ้งซ้ำกับเรื่องเดิม",
          confirmLabel: "ยกเลิกเรื่อง",
          cancelLabel: "ไม่ใช่",
        }).then((reason) => {
          if (reason === null) return;
          if (!reason) return toast("กรุณาระบุเหตุผลที่ยกเลิก");
          doStatus(id, "cancelled", "ยกเลิกเรื่องเรียบร้อยแล้ว", reason);
        });
      }
      return;
    }
    openDetail(card.dataset.id, "queue");
  });
  $("#queue-depts").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-dept]");
    if (!b) return;
    queueDept = b.dataset.dept;
    $$("#queue-depts .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    goQueue();
  });
  $("#queue-filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-f]");
    if (!b) return;
    queueFilter = b.dataset.f;
    $$("#queue-filters .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    goQueue();
  });

  // ผู้ดูแล: พับ/คลี่ฝ่าย · แตะแถวเพื่อเปิดแผ่นจัดการ · สลับไปหน้าผู้ถูกระงับสิทธิ์
  $("#adminList").addEventListener("click", (e) => {
    if (e.target.closest("#admin-toggle")) {
      adminView = adminView === "active" ? "suspended" : "active";
      goAdmin();
      return;
    }
    const grp = e.target.closest(".grp[data-grp]");
    if (grp) {
      const key = grp.dataset.grp;
      // วาดใหม่จากรายชื่อที่โหลดไว้แล้ว ไม่ต้องยิงเซิร์ฟเวอร์ซ้ำทุกครั้งที่พับ/คลี่
      if (adminOpen.has(key)) adminOpen.delete(key);
      else adminOpen.add(key);
      renderAdminList();
      return;
    }
    const row = e.target.closest(".prow[data-id]");
    if (row) openEmployeeSheet(row.dataset.id);
  });
  $("#admin-q").addEventListener(
    "input",
    debounce(() => {
      adminQ = $("#admin-q").value.trim();
      goAdmin();
    }, 350),
  );

  // ผู้ดูแล: ฟอร์มเพิ่มพนักงานเข้าระบบ
  $("#admin-add").onclick = openEmpForm;
  $("#n-cancel").onclick = closeEmpForm;
  $("#n-save").onclick = saveEmployee;
  $("#n-dept").onchange = () => revealOther($("#n-dept"), $("#n-deptOther"));
  $("#n-floor").onchange = () => revealOther($("#n-floor"), $("#n-floorOther"));
  // สลับแสดง/ซ่อนรหัสผู้ใช้ไลน์ — ผูกที่กล่องแม่ครั้งเดียว เพราะเนื้อในถูกวาดใหม่ทุกครั้งที่เปิดแผ่น
  $("#sheet-meta").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-uid-toggle]");
    if (!btn) return;
    const val = btn.parentElement.querySelector(".uid");
    const shown = val.textContent !== UID_MASK;
    val.textContent = shown ? UID_MASK : val.dataset.uid;
    btn.textContent = shown ? "แสดง" : "ซ่อน";
  });

  // bottom sheet ยกเลิก
  $("#sheet-cancel").onclick = () => finishSheet(null);

  // หน้าต่างยืนยัน
  $("#modal-yes").onclick = () => closeConfirm(true);
  $("#modal-no").onclick = () => closeConfirm(false);

  // ฉากหลังใช้ร่วมกัน — ปิดอันที่เปิดอยู่ (ถือว่าไม่ยืนยัน)
  $("#backdrop").onclick = () => {
    if (confirmResolve) closeConfirm(false);
    else finishSheet(null);
  };

  boot();
});
