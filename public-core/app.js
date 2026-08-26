/* Horizon Core — ระบบกลางขององค์กร (LIFF frontend)
 *
 * ทำสองอย่าง: ให้พนักงานลงทะเบียนยืนยันตัวตนครั้งเดียว และให้ฝ่ายบุคคลจัดการทะเบียนพนักงาน
 * ไม่มีตรรกะของระบบแจ้งปัญหาหรือระบบจองคิวนวดอยู่ในนี้ — ระบบพวกนั้นอ่านผลการลงทะเบียนนี้
 * จากฐานข้อมูลกลางเอง ไม่ต้องเรียกผ่านหน้านี้
 *
 * ลงทะเบียนที่นี่ครั้งเดียวใช้ได้ทุกระบบบน LINE OA เดียวกัน เพราะการผูกบัญชีถูกเก็บด้วย
 * กุญแจกลาง ไม่ใช่กุญแจของระบบใดระบบหนึ่ง (ดู CHANNEL_KEY ใน src/api/_lib/constants.ts)
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
let adminQ = ""; // คำค้นหน้าผู้ดูแล
let adminView = "active"; // หน้าที่กำลังดู: "active" (พนักงานปัจจุบัน) | "suspended" (ถูกระงับสิทธิ์)
// ข้อมูลพนักงานที่แสดงอยู่ คีย์ด้วย id — ใช้อ่านฝ่ายที่แต่ละคนดูแลตอนเปิดแผ่นเลือก
// โดยไม่ต้องยิงถามเซิร์ฟเวอร์ซ้ำ (รายการนี้เพิ่งโหลดมาหมาด ๆ อยู่แล้ว)
const adminEmployeeIndex = new Map();
let sheetPick = null; // ตัวรับค่าเมื่อเลือกจาก bottom sheet
let mastersPromise = null; // /api/masters ไม่ต้องใช้สิทธิ์ ยิงคู่ขนานได้ตั้งแต่ต้น

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
    // เซิร์ฟเวอร์ส่งสาเหตุจริงมาใน detail เฉพาะตอนพังแบบไม่คาดคิด (500) — เอามาต่อท้ายด้วย
    // ไม่งั้นหน้าจอขึ้นแค่ "internal error" ซึ่งไม่ช่วยอะไรเลย ต้องไปเปิด /api/health เองถึงจะรู้
    // ค่านี้ผ่าน safeErrorText มาแล้ว จึงไม่มี connection string หลุดออกมา และถูกตัดที่ 200 ตัวอักษร
    const base = data.error || `เกิดข้อผิดพลาด (${res.status})`;
    const err = new Error(data.detail ? `${base} — ${data.detail}` : base);
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

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function setTab(id) {
  $$(".tabbar button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.tab === id)));
}


/**
 * ล็อกอินของไลน์ค้างสถานะเก่าไว้ — ล้างแล้วลองใหม่ให้หนึ่งครั้ง
 *
 * อาการคือ "code_verifier does not match" เกิดเมื่อการล็อกอินรอบก่อนค้างครึ่งทาง
 * (ปิดหน้าไปกลางคัน · เปิดซ้ำเร็วเกินไป · เปิดตอนที่ยังตั้งค่า LIFF ไม่เสร็จ)
 * ตัวยืนยันที่เก็บไว้ในเครื่องจึงไม่ตรงกับรหัสที่ไลน์ส่งกลับมา
 *
 * ของเดิมขึ้นหน้า "เกิดข้อผิดพลาด" แล้วจบ ผู้ใช้ต้องไปปิดแอปไลน์ทั้งแอปเองถึงจะหาย
 * ซึ่งไม่มีทางเดาได้ จึงล้างสถานะแล้วโหลดใหม่ให้เลย ทำครั้งเดียวพอ
 * ถ้าครั้งที่สองยังพังก็แปลว่าเป็นปัญหาอื่นจริง ๆ ต้องให้เห็นข้อความจริงไม่ใช่วนซ้ำ
 */
const LOGIN_RETRY_KEY = "liff-login-retried";
const LOGIN_STATE_ERROR = /code[_ ]?verifier|invalid_grant|state does not match/i;

function recoverFromStaleLogin(err) {
  const msg = (err && (err.message || err.toString())) || "";
  if (!LOGIN_STATE_ERROR.test(msg)) return false;
  try {
    if (sessionStorage.getItem(LOGIN_RETRY_KEY)) return false; // ลองไปแล้วรอบหนึ่ง
    sessionStorage.setItem(LOGIN_RETRY_KEY, "1");
  } catch {
    return false; // เบราว์เซอร์ปิด storage ไว้ — กันวนซ้ำไม่ได้ก็อย่าลองดีกว่า
  }
  try {
    if (window.liff && liff.logout) liff.logout();
  } catch {
    /* ล้างไม่ได้ก็ไม่เป็นไร โหลดใหม่อาจพอ */
  }
  // ตัดเฉพาะพารามิเตอร์ของ oauth ที่หมดอายุแล้วออก ของเราเก็บไว้ครบ
  // ไม่งั้นปุ่มบนการ์ดในไลน์จะพาเข้ามาแล้วลืมว่ากดมาจากเรื่องไหน
  const url = new URL(location.href);
  for (const k of ["code", "state", "error", "error_description", "liffClientId", "liffRedirectUri"]) {
    url.searchParams.delete(k);
  }
  location.replace(url.toString());
  return true;
}

/* ---------- boot ---------- */
async function boot() {
  try {
    if (!CFG.liffId || CFG.liffId.includes("PUT-YOUR") || CFG.liffId.includes("ตั้งค่า")) {
      show("s-config");
      return;
    }
    await liff.init({ liffId: CFG.liffId });
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    idToken = liff.getIDToken();
    // รายชื่อฝ่าย/ชั้น ใช้เฉพาะหน้าเพิ่มพนักงานของ HR แต่ยิงคู่ขนานไว้เลยไม่ต้องรอ session
    mastersPromise = api("/api/masters").catch(() => null);
    session = await api("/api/auth/session", { method: "POST" });
    try { sessionStorage.removeItem(LOGIN_RETRY_KEY); } catch { /* noop */ }
    routeBySession();
  } catch (e) {
    if (recoverFromStaleLogin(e)) return;
    $("#err-msg").textContent = e.message || String(e);
    show("s-error");
  }
}

/** คืนข้อมูลตั้งต้น (ฝ่าย/ชั้น) — ใช้ผลที่ยิงคู่ขนานไว้ตอน boot() ถ้ามี */
async function getMasters() {
  if (!masters) masters = (await mastersPromise) || (await api("/api/masters"));
  return masters;
}

function routeBySession() {
  if (session.suspended) return show("s-suspended");
  if (!session.linked) return showRegister();
  enterApp();
}

/**
 * ลงทะเบียนไว้อยู่แล้ว — ระบบกลางไม่มีอะไรให้พนักงานทั่วไปทำต่อ
 *
 * ถ้ามีระบบที่พามา ก็พากลับไปเลย · ถ้าเปิดตรงมาเองก็ปิดหน้าต่างให้
 * ไม่ปล่อยให้ค้างอยู่หน้าที่ไม่มีอะไรกด ซึ่งอ่านแล้วเหมือนแอปค้าง
 * ฝ่ายบุคคลเป็นข้อยกเว้น เพราะมีหน้าทะเบียนพนักงานให้ใช้จริง
 */
function enterApp() {
  const emp = session.employee || {};
  $("#appbar").style.display = "flex";
  $("#me-av").textContent = (emp.full_name || "?").trim().charAt(0).toUpperCase();
  $("#me-name").textContent = emp.full_name || "-";
  $("#me-dept").textContent = [emp.department_name, emp.floor].filter(Boolean).join(" · ") || "";

  if (session.is_admin) {
    $("#tabbar").style.display = "flex";
    return goMe();
  }
  $("#tabbar").style.display = "none";
  leaveAfterRegister();
}

/** หน้าสรุปของคนที่ลงทะเบียนแล้ว — ใช้เมื่อปิดหน้าต่างเองไม่ได้ และเป็นแท็บของฝ่ายบุคคล */
function showDone(justRegistered) {
  const emp = session.employee || {};
  $("#done-title").textContent = justRegistered ? "ลงทะเบียนเรียบร้อยแล้ว" : "ลงทะเบียนไว้แล้ว";
  $("#done-name").textContent = [emp.employee_code, emp.full_name].filter(Boolean).join(" · ");
  $("#done-hint").style.display = "none";
  // ปุ่มปิดใช้ได้เฉพาะตอนเปิดอยู่ในไลน์ เปิดจากเบราว์เซอร์ปกติกดแล้วไม่เกิดอะไรขึ้น
  $("#btn-close").style.display = canCloseWindow() ? "" : "none";
  show("s-done");
}

function goMe() {
  setTab("me");
  showDone();
}


/**
 * ระบบที่พาเรามาลงทะเบียน — ส่งมาเป็น ?back=<LIFF ID ของระบบนั้น>
 *
 * ระบบกลางไม่รู้จักและไม่ควรรู้จักระบบปลายทางไหนเป็นพิเศษ ใครพามาก็ส่งรหัสตัวเองมาด้วย
 * แล้วเราพากลับไปที่นั่น ระบบใหม่ที่จะมาต่อ (จองคิวนวด ฯลฯ) จึงใช้ได้เลยโดยไม่ต้องแก้ไฟล์นี้
 *
 * รับเฉพาะสิ่งที่หน้าตาเป็นรหัส LIFF จริง ๆ ปลายทางจึงเป็นได้แค่แอปในไลน์
 * ไม่ใช่เว็บอะไรก็ได้ที่ใครแนบมากับลิงก์
 */
const LIFF_ID_RE = /^\d{6,12}-[A-Za-z0-9]{4,20}$/;

function readBackTarget() {
  const direct = new URLSearchParams(location.search);
  // บางเส้นทางไลน์ห่อพารามิเตอร์ไว้ใน liff.state อีกชั้น ต้องรองรับทั้งสองแบบ
  const state = direct.get("liff.state");
  const p = state ? new URLSearchParams(state.startsWith("?") ? state.slice(1) : state) : direct;
  const back = (p.get("back") || "").trim();
  return LIFF_ID_RE.test(back) ? back : null;
}

/**
 * จบงานของหน้านี้ — ปลายทางขึ้นกับว่าใครพามา
 *
 * มาจากระบบอื่น = พากลับไปใช้งานต่อทันที ไม่ต้องให้ผู้ใช้หาทางกลับเอง
 * เปิดตรงมาเอง = ปิดหน้าต่างให้เลย เพราะลงทะเบียนคืองานทั้งหมดที่มาทำ ไม่มีอะไรต่อ
 * ปิดไม่ได้ (เปิดจากเบราว์เซอร์ปกติ) = ค่อยขึ้นหน้าสรุปพร้อมปุ่มปิดไว้ให้
 */
function leaveAfterRegister(justRegistered) {
  const back = readBackTarget();
  if (back) {
    location.href = `https://liff.line.me/${back}`;
    return;
  }
  // ขึ้นหน้าสรุปก่อนเสมอ แล้วค่อยปิด — สั่งปิดทันทีผู้ใช้จะไม่ทันเห็นว่าลงทะเบียนสำเร็จ
  // และถ้าปิดไม่ได้ (เปิดจากเบราว์เซอร์ปกติ) ก็ยังมีหน้าค้างไว้พร้อมปุ่ม ไม่ใช่จอเปล่า
  showDone(justRegistered);
  if (!canCloseWindow()) return;
  $("#done-hint").style.display = "";
  // หน่วงสั้น ๆ ก่อนสั่งปิด — สั่งติดกับการทำงานอื่นของ LIFF ไลน์มักเมินคำสั่งนี้ไปเฉย ๆ
  setTimeout(closeWindow, 1200);
}

/** ปิดหน้าต่างได้จริงไหม — ทำได้เฉพาะตอนเปิดอยู่ในไลน์ ไม่ใช่เบราว์เซอร์ปกติ */
function canCloseWindow() {
  try {
    if (!window.liff || !liff.closeWindow) return false;
    return typeof liff.isInClient === "function" ? liff.isInClient() : true;
  } catch {
    return false;
  }
}

function closeWindow() {
  try {
    liff.closeWindow();
  } catch {
    /* ปิดไม่ได้ก็ปล่อยให้ค้างที่หน้าสรุป ผู้ใช้กดปิดเองได้ */
  }
}

/* ---------- ลงทะเบียนพนักงาน ---------- */
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
    // ลงทะเบียนเสร็จแล้วออกจากหน้านี้เสมอ ไม่เว้นแม้แต่ฝ่ายบุคคล
    //
    // เคยกันฝ่ายบุคคลไว้ให้อยู่ต่อเพราะมีหน้าทะเบียนพนักงานให้ใช้ แต่คนละจังหวะกัน —
    // การลงทะเบียนเป็นงานที่ทำครั้งเดียวจบ พอเสร็จก็ควรพ้นไป ส่วนงานจัดการทะเบียน
    // ค่อยเปิดแอปเข้ามาใหม่เมื่อจะใช้ ข้อยกเว้นเรื่องฝ่ายบุคคลอยู่ที่ enterApp()
    // ซึ่งเป็นเส้นทางของคนที่ลงทะเบียนไว้อยู่แล้ว ไม่ใช่คนที่เพิ่งลงทะเบียนเสร็จ
    $("#appbar").style.display = "none";
    leaveAfterRegister(true);
  } catch (e) {
    // มีคนผูกรหัสนี้ตัดหน้าไประหว่างที่ยังค้างหน้ายืนยันอยู่
    if (e.code === "already_linked") {
      return showRegBlocked(code, BLOCKED_ALREADY_LINKED.title, BLOCKED_ALREADY_LINKED.sub, BLOCKED_ALREADY_LINKED.tip);
    }
    toast(e.message);
  }
}

/* ---------- ทะเบียนพนักงาน (ฝ่ายบุคคล) ---------- */

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

/* ---------- bottom sheet + หน้าต่างยืนยัน ---------- */
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

/* ---------- wire up ---------- */
function bind() {
  // ลงทะเบียน
  $("#btn-check").onclick = checkEmp;
  $("#empid").addEventListener("keydown", (e) => {
    if (e.key === "Enter") checkEmp();
  });
  $("#btn-confirm-found").onclick = confirmFound;
  $("#btn-not-me").onclick = () => showRegPart("reg-input");
  $("#btn-notfound-back").onclick = () => showRegPart("reg-input");
  $("#btn-close").onclick = closeWindow;

  // แถบล่างของฝ่ายบุคคล — พนักงานทั่วไปไม่เห็นแถบนี้
  $$(".tabbar button").forEach((b) =>
    b.addEventListener("click", () => (b.dataset.tab === "admin" ? goAdmin() : goMe())),
  );


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

}

bind();
boot();
