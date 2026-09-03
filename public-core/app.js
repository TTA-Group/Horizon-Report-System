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

/**
 * คัดลอกข้อความลงคลิปบอร์ด แล้วบอกบนปุ่มว่าสำเร็จ
 *
 * navigator.clipboard ใช้ไม่ได้ทุกที่ (ต้อง https และบางเบราว์เซอร์ในแอปไม่ให้สิทธิ์)
 * จึงมีทางสำรองด้วย textarea + execCommand ซึ่งเก่าแต่ยังทำงานในเบราว์เซอร์ของแอปไลน์
 */
async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* ตกไปใช้ทางสำรอง */ }
  if (!ok) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch { ok = false; }
  }
  if (btn) {
    const was = btn.textContent;
    btn.textContent = ok ? "คัดลอกแล้ว" : "คัดลอกไม่ได้";
    btn.classList.toggle("done", ok);
    setTimeout(() => { btn.textContent = was; btn.classList.remove("done"); }, 1600);
  }
  if (!ok) toast("คัดลอกไม่สำเร็จ กดค้างที่รหัสเพื่อคัดลอกเองได้");
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
 * เกิดได้สองแบบ และทั้งสองแบบผู้ใช้แก้เองไม่ได้ ต้องกู้ให้จากตรงนี้
 *
 * แบบที่หนึ่ง "code_verifier does not match" เกิดเมื่อการล็อกอินรอบก่อนค้างครึ่งทาง
 * (ปิดหน้าไปกลางคัน · เปิดซ้ำเร็วเกินไป · เปิดตอนที่ยังตั้งค่า LIFF ไม่เสร็จ)
 * ตัวยืนยันที่เก็บไว้ในเครื่องจึงไม่ตรงกับรหัสที่ไลน์ส่งกลับมา
 *
 * แบบที่สอง "ตั๋วเข้าระบบหมดอายุ" เกิดกับคนที่เปิดลิงก์ค้างไว้นาน ๆ แล้วกลับมากดใหม่
 * ไลน์คืนตั๋วใบเดิมที่หมดอายุแล้วมาให้ ทั้งที่ยังบอกว่าล็อกอินอยู่ (ดู idTokenUsable)
 *
 * ของเดิมขึ้นหน้า "เกิดข้อผิดพลาด" แล้วจบ ผู้ใช้ต้องไปปิดแอปไลน์ทั้งแอปเองถึงจะหาย
 * ซึ่งไม่มีทางเดาได้ จึงล้างสถานะแล้วโหลดใหม่ให้เลย ทำครั้งเดียวพอ
 * ถ้าครั้งที่สองยังพังก็แปลว่าเป็นปัญหาอื่นจริง ๆ ต้องให้เห็นข้อความจริงไม่ใช่วนซ้ำ
 */
const LOGIN_RETRY_KEY = "liff-login-retried";
const LOGIN_STATE_ERROR = /code[_ ]?verifier|invalid_grant|state does not match/i;

// รหัสที่เซิร์ฟเวอร์ตอบกลับมาเมื่อ "ตั๋วเข้าระบบ" ที่แนบไปใช้ไม่ได้ — ขอตั๋วใบใหม่แล้วหาย
// ไม่รวม token_config เพราะนั่นคือค่าตั้งค่าไม่ตรงกัน ขอใบใหม่กี่รอบก็ไม่หาย
// ต้องปล่อยให้ข้อความจริงขึ้นหน้าจอ คนที่แก้ได้คือคนที่เข้าไปตั้งค่า Worker ตัวนั้น
const LOGIN_TOKEN_ERROR = ["token_expired", "bad_token"];

/**
 * ตั๋วที่ไลน์ให้มายังใช้ได้อยู่ไหม — ดูวันหมดอายุที่เขียนอยู่ในตัวตั๋วเอง
 *
 * ไลน์เก็บตั๋วไว้ในเครื่องแล้วคืนใบเดิมมาให้แม้หมดอายุไปแล้ว โดยที่ liff.isLoggedIn()
 * ยังตอบว่าล็อกอินอยู่ (สองอย่างนี้คนละใบกัน อายุไม่เท่ากัน) ใครเปิดลิงก์ค้างไว้นาน ๆ
 * แล้วกลับมากดใหม่ จึงแนบใบที่หมดอายุไปเจอ "เกิดข้อผิดพลาด" โดยไม่มีทางแก้เองได้เลย
 *
 * ไม่ได้ตรวจลายเซ็นและไม่ต้องตรวจ — เซิร์ฟเวอร์ตรวจของจริงอยู่แล้ว ตรงนี้แค่ดูว่า
 * ควรขอใบใหม่ก่อนส่งออกไปหรือเปล่า
 */
function idTokenUsable(token) {
  const mid = String(token || "").split(".")[1];
  if (!mid) return false; // ไม่มีตั๋ว หรือไม่ใช่รูปแบบที่อ่านได้
  let exp = 0;
  try {
    const raw = atob(mid.replace(/-/g, "+").replace(/_/g, "/"));
    const m = raw.match(/"exp"\s*:\s*(\d+)/);
    exp = m ? Number(m[1]) * 1000 : 0;
  } catch {
    return true; // อ่านไม่ออกก็ปล่อยให้เซิร์ฟเวอร์เป็นคนตัดสิน ดีกว่าไล่ผู้ใช้ไปล็อกอินใหม่ฟรี ๆ
  }
  if (!exp) return true;
  return exp - Date.now() > 60000; // เหลือไม่ถึงหนึ่งนาที ถือว่าใช้ไม่ได้แล้ว
}

/** ล้างล็อกอินของไลน์แล้วเริ่มใหม่ — ทำได้ครั้งเดียวต่อการเปิดหนึ่งรอบ คืน false ถ้าเคยลองแล้ว */
function restartLineLogin() {
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

function recoverFromStaleLogin(err) {
  const msg = (err && (err.message || err.toString())) || "";
  const code = (err && err.code) || "";
  if (!LOGIN_STATE_ERROR.test(msg) && !LOGIN_TOKEN_ERROR.includes(code)) return false;
  return restartLineLogin();
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
    // ตั๋วหมดอายุตั้งแต่ยังไม่ได้ส่ง — ขอใบใหม่เลย ดีกว่าปล่อยให้ไปโดนปฏิเสธที่ปลายทาง
    if (!idTokenUsable(idToken) && restartLineLogin()) return;
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
  showAlreadyRegistered();
}

/**
 * คนที่ผูกบัญชีไว้แล้วและไม่ใช่ผู้ดูแล เปิดระบบกลางเข้ามาเอง
 *
 * เดิมใช้เส้นทางเดียวกับ "เพิ่งลงทะเบียนเสร็จ" ซึ่งผิดสองข้อ
 *   1. ถ้าลิงก์ที่กดมามี back= ติดมาด้วย จะถูกพาออกไปที่ระบบนั้นทันทีโดยไม่ทันเห็นอะไรเลย
 *      อาการคือ "กดระบบกลางแล้วเด้งไปหน้าแจ้งปัญหา" ทั้งที่ตั้งใจกดเข้ามาที่นี่
 *      และถ้าระบบปลายทางดันคิดว่าคนนี้ยังไม่ลงทะเบียน สองหน้าจะโยนกันไปมาไม่จบ
 *   2. ถ้าไม่มี back= จะขึ้นว่า "ลงทะเบียนสำเร็จ" แล้วปิดตัวเอง ทั้งที่เขาไม่ได้เพิ่งลงทะเบียน
 *      หน้าต่างหายไปเฉย ๆ โดยไม่มีคำอธิบาย
 *
 * การพากลับยังมีอยู่ แต่เปลี่ยนเป็นปุ่มให้กดเอง — ระบบไม่ตัดสินใจแทนคนที่ตั้งใจเปิดมาเอง
 */
function showAlreadyRegistered() {
  const emp = session.employee || {};
  $("#al-who").textContent = [emp.full_name, emp.employee_code].filter(Boolean).join(" · ");
  const back = readBackTarget();
  const btn = $("#al-back");
  btn.style.display = back ? "" : "none";
  if (back) btn.onclick = () => { location.href = `https://liff.line.me/${back}`; };
  $("#al-close").style.display = canCloseWindow() ? "" : "none";
  show("s-already");
}

/**
 * เปิดหน้าผู้ดูแลของแอปจองคิวนวด
 *
 * ที่นี่เป็นแค่ทางเข้า ไม่ได้ย้ายหน้าพวกนั้นมา เพราะข้อมูลคิวนวดเป็นของระบบจองคิว
 * ระบบกลางไม่ควรรู้จักตารางคิว สิทธิ์ หรือวันให้บริการของระบบนั้น
 * ใครเปิดได้ให้แอปจองคิวตัดสินเอง — ที่นี่เปิดลิงก์ให้เฉย ๆ
 *
 * which: "1" = ฟอร์มเช็คชื่อ (ค่าเดิม ห้ามเปลี่ยน มีคนบุ๊กมาร์กไว้) · "book" = จองแทน · "days" = วันให้บริการ
 *
 * ปุ่มที่หน้าจัดการเปิดหน้าฟอร์มเช็คชื่อ แล้วให้สลับไปอีกสองหน้าด้วยแท็บในแอปจองคิวเอง
 * อีกสองค่ายังรับอยู่เพราะเป็นลิงก์ตรงที่บันทึกไว้ใช้ซ้ำได้
 */
function openMassageAdmin(which) {
  const id = CFG.massageLiffId;
  if (!id || id.includes("ตั้งค่า")) return toast("ยังไม่ได้ตั้งค่าแอปจองคิวนวด");
  const url = `https://liff.line.me/${id}?admin=${encodeURIComponent(which)}`;
  if (window.liff && liff.openWindow) liff.openWindow({ url, external: false });
  else window.location.href = url;
}

/**
 * เปิดคิวงานของระบบแจ้งปัญหา — ให้เข้าถึงทุกระบบได้จากหน้าจัดการที่เดียว
 *
 * ส่ง tab=queue ไปด้วย เพื่อลงที่คิวงานเลย ไม่ต้องเข้าไปแล้วกดแท็บล่างเอง
 * ฝั่งนั้นเช็คสิทธิ์เองอยู่แล้ว คนที่ไม่ได้เป็นเจ้าหน้าที่ฝ่ายไหนจะตกไปหน้าแจ้งเรื่องตามปกติ
 */
function openReportAdmin() {
  const id = CFG.reportLiffId;
  if (!id || id.includes("ตั้งค่า")) return toast("ยังไม่ได้ตั้งค่าแอปแจ้งปัญหา");
  const url = `https://liff.line.me/${id}?tab=queue`;
  if (window.liff && liff.openWindow) liff.openWindow({ url, external: false });
  else window.location.href = url;
}

/** หน้าสรุปของคนที่ลงทะเบียนแล้ว — ใช้เมื่อปิดหน้าต่างเองไม่ได้ และเป็นแท็บของฝ่ายบุคคล */
/**
 * หน้าก่อนปิด — ขึ้นแวบเดียวให้รู้ว่าสำเร็จ ไม่ต้องมีอะไรให้อ่าน
 * ปุ่มปิดมีไว้เผื่อกรณีที่สั่งปิดเองไม่ได้ (เปิดจากเบราว์เซอร์ปกติ) ไม่งั้นจะค้างโดยไม่มีทางออก
 */
function showDone() {
  $("#btn-close").style.display = canCloseWindow() ? "" : "none";
  show("s-done");
}

/** หน้าจัดการของฝ่ายบุคคล — งานที่ทำบ่อยที่สุดอยู่เป็นปุ่มใหญ่ปุ่มเดียว ไม่ต้องไปหาในแท็บอื่น */
function goMe() {
  // ชื่อ รหัส ฝ่าย ของคนที่ล็อกอินอยู่ ขึ้นที่แถบบนสุดตลอดเวลาอยู่แล้ว (enterApp)
  // เขียนซ้ำในหน้านี้อีกชุดมีแต่ดันปุ่มที่ต้องกดจริงให้ลงไปอยู่ครึ่งล่างของจอ
  $("#mg-close").style.display = canCloseWindow() ? "" : "none";
  setTab("me");
  show("s-manage");
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

/**
 * ส่งรหัสพนักงานเข้าห้องแชทในนามผู้ใช้ เพื่อให้ auto-reply ของ LINE OA ตอบข้อความต้อนรับ
 *
 * ต้องเป็นผู้ใช้ส่งเองเท่านั้น — ข้อความที่ระบบ push เข้าไปไม่ทำให้ auto-reply ทำงาน
 * เพราะ LINE ไม่ถือว่าเป็นข้อความขาเข้า จึงใช้ liff.sendMessages ไม่ใช่ push จากเซิร์ฟเวอร์
 *
 * ส่งเฉพาะคนที่เข้ามาจาก rich menu เท่านั้น (ไม่มี back= ติดมา) — คนที่กดลิงก์ลงทะเบียน
 * มาจากแอปจองคิวนวดหรือแจ้งปัญหา กำลังทำงานอื่นค้างอยู่ ไม่ควรมีข้อความต้อนรับมาคั่น
 * แล้วเด้งเขาออกจากสิ่งที่กำลังทำ
 *
 * ต้องส่งรหัสเปล่า ๆ ไม่มีคำอื่นนำหน้าหรือต่อท้าย เพราะ auto-reply จับคำแบบตรงตัว
 * และห้ามให้ล้มเหลวไปขวางการลงทะเบียน — ข้อมูลถูกบันทึกไปแล้วก่อนถึงบรรทัดนี้
 */
async function sendCodeToChat(code) {
  if (readBackTarget()) return;
  try {
    if (!window.liff || !liff.isApiAvailable || !liff.isApiAvailable("sendMessages")) return;
    await liff.sendMessages([{ type: "text", text: code }]);
  } catch (err) {
    console.error("sendMessages failed:", err);
  }
}

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
function leaveAfterRegister() {
  const back = readBackTarget();
  if (back) {
    location.href = `https://liff.line.me/${back}`;
    return;
  }
  // ขึ้นหน้าสรุปก่อนเสมอ แล้วค่อยปิด — สั่งปิดทันทีผู้ใช้จะไม่ทันเห็นว่าลงทะเบียนสำเร็จ
  // และถ้าปิดไม่ได้ (เปิดจากเบราว์เซอร์ปกติ) ก็ยังมีหน้าค้างไว้พร้อมปุ่ม ไม่ใช่จอเปล่า
  showDone();
  if (!canCloseWindow()) return;
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
    await sendCodeToChat(code);
    toast("ยืนยันตัวตนเรียบร้อยแล้ว");
    // ลงทะเบียนเสร็จแล้วออกจากหน้านี้เสมอ ไม่เว้นแม้แต่ฝ่ายบุคคล
    //
    // เคยกันฝ่ายบุคคลไว้ให้อยู่ต่อเพราะมีหน้าทะเบียนพนักงานให้ใช้ แต่คนละจังหวะกัน —
    // การลงทะเบียนเป็นงานที่ทำครั้งเดียวจบ พอเสร็จก็ควรพ้นไป ส่วนงานจัดการทะเบียน
    // ค่อยเปิดแอปเข้ามาใหม่เมื่อจะใช้ ข้อยกเว้นเรื่องฝ่ายบุคคลอยู่ที่ enterApp()
    // ซึ่งเป็นเส้นทางของคนที่ลงทะเบียนไว้อยู่แล้ว ไม่ใช่คนที่เพิ่งลงทะเบียนเสร็จ
    $("#appbar").style.display = "none";
    leaveAfterRegister();
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
      // ตัวเลขข้างกลุ่มบอก "ผูกบัญชีไลน์แล้วกี่คน จากทั้งหมดกี่คน" ไม่ใช่จำนวนคนเฉย ๆ
      //
      // งานหลักของหน้านี้ช่วงเริ่มใช้ระบบคือไล่ให้ทุกคนผูกบัญชีให้ครบ ตัวเลขรวมอย่างเดียว
      // จึงไม่ได้บอกว่ายังเหลืออีกกี่คน ต้องกางกลุ่มออกมานับเองทีละคน
      // กลุ่มที่ครบแล้วเปลี่ยนเป็นป้ายเขียวไปเลย จะได้กวาดตาหาเฉพาะกลุ่มที่ยังไม่ครบ
      const done = g.rows.filter((e) => e.linked).length;
      const count =
        done === g.rows.length && g.rows.length > 0
          ? '<span class="gct full">ผูกครบแล้ว</span>'
          : `<span class="gct">${done}/${g.rows.length}</span>`;
      return `${label}${deptLabel}
        <button class="grp" data-grp="${esc(g.key)}" aria-expanded="${open}">
          <svg class="gcv" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
          <span class="gnm">${esc(g.name)}</span>
          ${count}
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
  // ต้องมีรายชื่อฝ่ายก่อนถึงจะแปลงรหัสฝ่ายเป็นชื่อได้ — โหลดพลาดก็ยังเปิดแผ่นต่อได้
  // (จะขึ้นเป็นรหัสฝ่ายแทนชื่อ) เพราะการเปลี่ยนสถานะต้องทำได้เสมอ แม้ข้อมูลตั้งต้นจะโหลดไม่ขึ้น
  await getMasters().catch(() => null);
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
  await getMasters().catch(() => null);
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
    const opts = ((masters && masters.departments) || []).map((d) => ({
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

/**
 * ชื่อเต็มของฝ่ายจากรหัส — ฝ่ายที่ถูกปิดใช้งานไปแล้วจะไม่มีในรายการ ก็แสดงรหัสไปตรง ๆ
 *
 * ต้องทนกับกรณีที่ masters ยังไม่ถูกโหลด (เป็น null) ด้วย ไม่ใช่แค่กรณีที่โหลดแล้วไม่เจอฝ่าย
 * เคยพังมาแล้ว: หน้าทะเบียนพนักงานเรียกฟังก์ชันนี้เฉพาะคนที่ "มีตำแหน่งอยู่แล้ว" เท่านั้น
 * พอ masters ยังเป็น null แผ่นจัดการของคนกลุ่มนั้นจึงเปิดไม่ขึ้นเลย ทั้งที่คนที่ยังไม่มี
 * ตำแหน่งเปิดได้ปกติ — อาการเลยดูเหมือน "เปลี่ยนสถานะคนที่เคยกำหนดไว้แล้วไม่ได้"
 */
function deptName(code) {
  const d = ((masters && masters.departments) || []).find((x) => x.code === code);
  return d ? d.name : code;
}

// รหัสผู้ใช้ไลน์เป็นสตริงยาวที่ไม่ได้ใช้ในงานประจำวัน ขึ้นค้างไว้มีแต่ทำให้แผ่นรก
// ซ่อนไว้ก่อนแล้วให้กดแสดงเมื่อต้องใช้จริง
const UID_MASK = "••••••••••••";

/* ---------- ตรวจและตั้งเมนูไลน์ (rich menu) ----------
 *
 * มีเพราะการสลับเมนูล้มแบบเงียบได้หลายทาง และทุกทางหน้าจอเหมือนกันหมดคือ "เมนูไม่เปลี่ยน"
 * หน้านี้จึงต้องบอกให้ได้ว่าติดตรงไหน ไม่ใช่บอกแค่ว่าสำเร็จหรือไม่สำเร็จ
 */

/** หนึ่งบรรทัดของผลตรวจ — mark: good | bad | warn */
function checkRow(mark, text, sub) {
  const icon = { good: "✓", bad: "✕", warn: "!" }[mark] || "?";
  return `<div class="crow">
    <span class="cmark ${mark}">${icon}</span>
    <span class="ctext">${text}${sub ? `<span class="sub">${sub}</span>` : ""}</span>
  </div>`;
}

/**
 * สรุปผลตรวจเป็นบรรทัดเดียว แล้วซ่อนรายละเอียดไว้ในกล่องพับ
 *
 * หน้านี้เคยกางทุกอย่างออกมาหมดจนต้องเลื่อนยาวกว่าจะเจอปุ่ม สิ่งที่ต้องเห็นทันทีคือ
 * "ตอนนี้ปกติหรือมีปัญหา" ส่วนรายละเอียดว่าทำไม เก็บไว้ให้กดอ่านตอนต้องไล่หาสาเหตุจริง ๆ
 */
function fold(tone, title, summary, body) {
  return `<details class="fold">
    <summary><span class="fdot ${tone}"></span><span>${title}</span>
      <span class="fsum">${summary}</span></summary>
    <div class="fbody">${body}</div>
  </details>`;
}

function renderMenuStatus(r) {
  const rows = [];
  let worst = "good";
  const note = (tone) => {
    if (tone === "bad") worst = "bad";
    else if (tone === "warn" && worst !== "bad") worst = "warn";
  };

  // 1. ค่าตั้งค่าครบไหม — ขาดตัวไหนก็เงียบเหมือนกันหมด ต้องแยกให้เห็นทีละตัว
  const miss = Object.entries(r.config).filter(([, v]) => !v).map(([k]) => k);
  note(miss.length === 0 ? "good" : "bad");
  rows.push(
    miss.length === 0
      ? checkRow("good", "ตั้งค่าครบทั้งสามตัวแล้ว")
      : checkRow("bad", `ยังไม่ได้ตั้งค่า <b>${miss.join(" และ ")}</b>`,
          "ตั้งที่ Cloudflare → Worker <b>core</b> → Settings → Variables ชนิด Secret เท่านั้น " +
          "และต้องตั้งที่ Worker <b>report</b> ด้วย ไม่งั้นตอนมีคนแอดเพื่อนจะไม่ได้เมนู"),
  );

  // 2. ถาม LINE ได้ไหม — ถามไม่ได้แปลว่าโทเคนผิดหรือหมดอายุ คนละเรื่องกับยังไม่ได้ตั้ง
  note(r.line.ok ? "good" : "bad");
  rows.push(r.line.ok
    ? checkRow("good", `ต่อกับ LINE ได้ · มีเมนูอยู่ทั้งหมด ${r.line.count} ใบ`)
    : checkRow("bad", "ถาม LINE ไม่ได้", esc(r.line.error || "")));

  // 3. รหัสที่ตั้งไว้ มีเมนูใบนั้นอยู่จริงไหม — ก๊อปรหัสผิดตัวคือสาเหตุที่ LINE ปฏิเสธเงียบ ๆ
  if (r.menus && r.line.ok) {
    for (const [key, label] of [["fresh", "เมนูของคนที่ยังไม่ลงทะเบียน"], ["member", "เมนูของคนที่ลงทะเบียนแล้ว"]]) {
      const m = r.menus[key];
      note(m.exists ? "good" : "bad");
      rows.push(
        m.exists
          ? checkRow("good", `${label} — <b>${esc(m.name || "ไม่มีชื่อ")}</b>`, `<span class="mono">${esc(m.id)}</span>`)
          : checkRow("bad", `${label} — ไม่พบเมนูรหัสนี้บน LINE`,
              `<span class="mono">${esc(m.id)}</span><br>รหัสที่ตั้งไว้ไม่ตรงกับเมนูใบไหนเลย ` +
              "อาจก๊อปมาผิดตัว หรือเมนูใบนั้นถูกลบไปแล้ว ดูรายชื่อเมนูจริงด้านล่าง"),
      );
    }
  }

  // 4. เมนูตั้งต้นของ OA — ใช้กับทุกคนที่ไม่มีเมนูผูกไว้เป็นรายคน ซึ่งรวมคนที่ถูกถอดด้วย
  //    จึงอยู่ร่วมกับปุ่มถอดไม่ได้ ต้องบอกให้ชัดว่าตอนนี้เลือกทางไหนอยู่
  const excluded = r.excluded || [];
  if (r.defaultMenu && r.defaultMenu.ok) {
    if (excluded.length > 0 && r.defaultMenu.id) {
      note("bad");
      rows.push(checkRow("bad", `มีเมนูตั้งต้นของ OA อยู่ ทั้งที่ถอดเมนูไว้ ${excluded.length} คน`,
        "เมนูตั้งต้นใช้กับทุกคนที่ไม่มีเมนูรายคน คนที่ถูกถอดจึงกลับมาเห็นเมนูนี้แทน " +
        "เท่ากับปุ่มถอดไม่มีผล · กดปุ่ม “ถอดเมนูตั้งต้นของ OA” ด้านล่างถ้าต้องการให้การถอดมีผลจริง"));
    } else if (r.defaultMenu.correct) {
      note("good");
      rows.push(checkRow("good", `ทุกคนใน OA ได้เมนูหลักแล้ว — <b>${esc(r.defaultMenu.name || "ไม่ทราบชื่อ")}</b>`,
        "ตั้งเป็นเมนูตั้งต้นของ OA ไว้ ทุกคนจึงได้เมนูนี้ แม้คนที่ระบบไม่รู้จัก"));
    } else if (r.defaultMenu.id) {
      note("bad");
      rows.push(checkRow("bad", `เมนูที่ทุกคนได้ ยังเป็นใบอื่นอยู่ — <b>${esc(r.defaultMenu.name || "ไม่ทราบชื่อ")}</b>`,
        `<span class="mono">${esc(r.defaultMenu.id)}</span><br>` +
        "ควรเป็นเมนูหลัก · กดปุ่มเปลี่ยนให้ทุกคนแล้วระบบจะตั้งให้เอง"));
    } else {
      note(excluded.length > 0 ? "good" : "warn");
      rows.push(excluded.length > 0
        ? checkRow("good", "ไม่ได้ตั้งเมนูตั้งต้นของ OA ไว้",
            `ถูกต้องแล้วเมื่อมีคนถูกถอดเมนู (ตอนนี้ ${excluded.length} คน) ` +
            "แลกกับการที่คนซึ่งระบบยังไม่รู้จักจะไม่มีเมนูจนกว่าจะทักเข้ามา")
        : checkRow("warn", "ยังไม่ได้ตั้งเมนูให้ทุกคน",
            "คนที่ระบบไม่รู้จักจะไม่มีเมนูเลย · กดปุ่มเปลี่ยนให้ทุกคนแล้วระบบจะตั้งให้เอง"));
    }
  }

  // 5. เมนูของคนที่กำลังดูอยู่ — คำตอบสุดท้ายว่าตอนนี้ LINE ผูกใบไหนไว้ให้จริง
  let mineLine = "";
  if (r.mine && r.mine.ok) {
    const now = r.mine.name || (r.mine.id ? "ไม่ทราบชื่อ" : "ไม่มีเมนูผูกอยู่");
    const want = r.mine.expectedId === null ? "ไม่มีเมนู (ถูกระงับสิทธิ์)" : r.mine.expectedName || "ไม่ทราบชื่อ";
    mineLine = now;
    if (r.mine.matches === true) {
      note("good");
      rows.push(checkRow("good", `เมนูที่คุณได้อยู่ตอนนี้ — <b>${esc(now)}</b>`, "ตรงกับที่ควรได้แล้ว"));
    } else if (r.mine.matches === false) {
      // ชื่อเมนูตั้งซ้ำกันได้ ถ้าโชว์แต่ชื่อจะกลายเป็น "ได้ ก แต่ควรได้ ก" ซึ่งไม่ได้อะไรเลย
      note("bad");
      const sameName = Boolean(r.mine.id) && now === want;
      rows.push(checkRow("bad", `เมนูที่คุณได้อยู่ตอนนี้ — <b>${esc(now)}</b>`,
        (r.mine.id ? `<span class="mono">${esc(r.mine.id)}</span><br>` : "") +
        `แต่ที่ควรได้คือ <b>${esc(want)}</b>` +
        (r.mine.expectedId ? `<br><span class="mono">${esc(r.mine.expectedId)}</span>` : "") +
        (sameName ? "<br>สองใบนี้<b>ชื่อเหมือนกันแต่คนละใบ</b> ให้ดูที่รหัสเป็นหลัก" : "") +
        "<br>กดปุ่ม “เปลี่ยนให้ทุกคน” ด้านล่างเพื่อแก้ให้ตรง"));
    } else {
      note("warn");
      rows.push(checkRow("warn", `เมนูที่คุณได้อยู่ตอนนี้ — <b>${esc(now)}</b>`,
        "ยังบอกไม่ได้ว่าตรงหรือไม่ตรง เพราะตั้งค่ารหัสเมนูยังไม่ครบ"));
    }
  }

  // 6. ขอรายชื่อเพื่อนทั้งหมดจาก LINE ได้ไหม — ชี้ขาดว่าปุ่มไปถึงทุกคนจริงหรือไม่
  if (r.followers) {
    note(r.followers.ok ? "good" : "warn");
    rows.push(r.followers.ok
      ? checkRow("good", "ขอรายชื่อเพื่อนทั้งหมดจาก LINE ได้",
          "กดปุ่มแล้วจะดึงรายชื่อมาใหม่ก่อนเสมอ เมนูจึงเปลี่ยนให้ทุกคนที่เป็นเพื่อนจริง ๆ")
      : checkRow("bad", "ขอรายชื่อเพื่อนทั้งหมดจาก LINE ไม่ได้",
          `${esc(r.followers.error || "")}<br>` +
          "LINE เปิดให้ขอรายชื่อเพื่อนเฉพาะบัญชีที่ผ่านการยืนยัน (Verified) หรือ Premium เท่านั้น " +
          "ระหว่างนี้ปุ่มจะไปถึงเฉพาะคนที่ระบบรู้จัก คือคนที่ลงทะเบียนแล้ว " +
          "คนที่ฝ่ายบุคคลนำเข้ามา และคนที่เคยทักแชทมา"));
  }

  // 7. เคยกดไล่ตั้งเมนูไปหรือยัง — คำถามแรกเสมอเวลาเมนูไม่เปลี่ยน
  rows.push(r.lastApply
    ? checkRow("good", "เคยไล่ตั้งเมนูให้ทุกคนแล้ว",
        `ครั้งล่าสุด ${esc(r.lastApply.at)} น. โดย ${esc(r.lastApply.by)}`)
    : checkRow("warn", "ยังไม่เคยกดไล่ตั้งเมนูให้ทุกคนเลย",
        "การเปลี่ยนรหัสเมนูหรือแก้ flow ไม่ทำให้เมนูของคนที่ผูกไว้แล้วเปลี่ยนตาม ต้องกดปุ่มหนึ่งครั้ง"));

  const bad = rows.filter((x) => x.includes('cmark bad')).length;
  const warn = rows.filter((x) => x.includes('cmark warn')).length;
  const sum = bad ? `${bad} จุดที่ต้องแก้` : warn ? `${warn} จุดที่ควรดู` : "ปกติทุกอย่าง";

  // รายการเมนูบนบัญชีมาจาก LINE โดยตรง (ถาม /v2/bot/richmenu/list) จึงรวมทุกใบที่เคยสร้างไว้
  // ทั้งที่ใช้อยู่และที่เลิกใช้แล้ว — ปกติจึงมีหลายสิบใบ กางทั้งหมดแล้วหาด้วยตาไม่ไหว
  const inUse = r.menus && r.line.ok
    ? [r.menus.member, r.menus.fresh].filter((m) => m && m.exists)
    : [];
  const list = r.line.ok && r.line.richmenus.length
    ? fold(inUse.length ? "good" : "warn", "เมนูที่มีอยู่บนบัญชี LINE",
        `ใช้อยู่ ${inUse.length} ใบ จากทั้งหมด ${r.line.count} ใบ`,
        `<p class="hintnote">รายการนี้มาจาก LINE โดยตรง จึงรวม<b>ทุกใบที่เคยสร้างไว้</b>
           ทั้งที่ใช้อยู่และที่เลิกใช้แล้ว ลบทิ้งได้ที่ LINE Official Account Manager<br>
           รหัสพวกนี้เอาไปวางใน RICHMENU_NEW_ID / RICHMENU_MEMBER_ID ได้เลย ·
           <b>ชื่อซ้ำกันได้</b> ให้ยึดรหัสเป็นหลัก</p>
         <input type="text" class="searchbox" id="menu-find" placeholder="ค้นชื่อเมนูหรือรหัส" />
         <div class="plist" id="menu-list">${r.line.richmenus.map((m) => {
           const used = inUse.find((u) => u.id === m.id);
           return `<div class="irow" data-find="${esc(((m.name || "") + " " + m.id).toLowerCase())}">
             <div class="iw"><div class="inm">${esc(m.name || "ไม่มีชื่อ")}</div>
             <div class="isub mono">${esc(m.id)}</div></div>
             ${used ? '<span class="itag ok">ใช้อยู่</span>' : ""}
             <button class="copybtn" data-copy="${esc(m.id)}">คัดลอก</button></div>`;
         }).join("")}</div>`)
    : "";

  // คนที่ถูกถอดเมนูไว้ — ปุ่มเปลี่ยนให้ทุกคนข้ามคนกลุ่มนี้ ต้องมีที่ให้ดูว่ามีใครบ้าง
  const exList = excluded.length
    ? fold("warn", "คนที่ถอดเมนูไว้", `${excluded.length} คน — ปุ่มเปลี่ยนให้ทุกคนจะข้ามไป`,
        `<p class="hintnote">กดปุ่ม “เปลี่ยนเฉพาะบุคคล” แล้วเลือกคนนี้ เพื่อคืนเมนูให้และเอาออกจากรายการนี้</p>
         <div class="plist">${excluded.map((x) => `<div class="irow">
           <div class="iw"><div class="inm">${esc(x.name || "ไม่ทราบชื่อ")}</div>
           <div class="isub">${esc(x.code || "")}${x.code ? " · " : ""}ถอดเมื่อ ${esc(x.at)}</div></div>
           <button class="copybtn" data-copy="${esc(x.lineUserId)}">คัดลอก</button></div>`).join("")}</div>`)
    : "";

  $("#menu-body").innerHTML = `
    ${fold(worst, "ผลตรวจ", sum, `<div class="plist" style="padding:2px 14px;border:0;background:transparent">${rows.join("")}</div>`)}
    ${mineLine ? `<p class="hintnote">เมนูที่คุณได้อยู่ตอนนี้ — <b>${esc(mineLine)}</b></p>` : ""}
    ${exList}
    ${list}

    <div class="section" style="margin-top:22px">สั่งงาน</div>

    <button class="send" id="menu-apply"${r.ready ? "" : " disabled"}>1 · เปลี่ยน rich menu ให้ทุกคน</button>
    <p class="hintnote">
      ${r.ready
        ? `ทุกคนได้<b>เมนูหลักเหมือนกันหมด</b> ไม่ว่าจะลงทะเบียนแล้วหรือยัง` +
          (excluded.length ? `<br><b>ข้าม ${excluded.length} คน</b>ที่ถอดเมนูไว้` : "") +
          `<br>คนที่ถูกระงับสิทธิ์ยังถูกถอดเมนูตามเดิม`
        : "ตั้งค่าให้ครบก่อนถึงจะกดได้"}
    </p>
    <div id="menu-progress"></div>

    <button class="send" id="menu-apply-one" style="margin-top:14px"${r.ready ? "" : " disabled"}>2 · เปลี่ยนเฉพาะบุคคล</button>
    <p class="hintnote">ตั้งเมนูหลักให้คนเดียว · ถ้าคนนั้นเคยถูกถอดไว้ จะถูกเอาออกจากรายการที่ถอดด้วย</p>

    <button class="send" id="menu-unlink" style="margin-top:14px">3 · ถอด rich menu เฉพาะบางคน</button>
    <p class="hintnote">คนที่ถูกถอดจะไม่เห็นเมนูเลย และปุ่มข้อ 1 จะข้ามคนนี้ไปตลอดจนกว่าจะกดข้อ 2 คืนให้</p>

    ${r.defaultMenu && r.defaultMenu.ok && r.defaultMenu.id
      ? `<button class="ghost" id="menu-cleardef" style="margin-top:14px">ถอดเมนูตั้งต้นของ OA</button>
         <p class="hintnote">ใช้เมื่อต้องการให้การถอดเมนูรายคนมีผลจริง ๆ · แลกกับการที่คนซึ่งระบบยังไม่รู้จักจะไม่มีเมนู</p>`
      : ""}`;
}

async function goMenuCheck() {
  setTab("me");
  show("s-menu");
  $("#menu-body").innerHTML = '<p class="hintnote">กำลังตรวจ...</p>';
  try {
    renderMenuStatus(await api("/api/admin/richmenu"));
  } catch (e) {
    $("#menu-body").innerHTML = `<p class="hintnote">ตรวจไม่สำเร็จ: ${esc(e.message || "")}</p>`;
  }
}

/**
 * ไล่ตั้งเมนูทีละชุดจนครบ
 *
 * วนเรียกจากหน้าจอ ไม่ใช่วนในเซิร์ฟเวอร์ เพราะ Worker ยิงคำขอย่อยได้จำกัดต่อหนึ่งคำขอ
 * และการเห็นความคืบหน้าระหว่างทางสำคัญ องค์กรหลายร้อยคนใช้เวลาหลายรอบกว่าจะจบ
 */
async function applyRichMenus() {
  const ok = await confirmDialog({
    title: "ตั้งเมนูใหม่ให้ทุกคน?",
    message:
      "ระบบจะไล่ผูกเมนูให้ตรงกับสถานะของแต่ละคน — คนที่ลงทะเบียนแล้วได้เมนูใช้งาน " +
      "คนที่ยังไม่ลงทะเบียนได้เมนูที่มีปุ่มลงทะเบียน ส่วนคนที่ถูกระงับสิทธิ์จะถูกถอดเมนูออก",
    confirmLabel: "ตั้งเมนูใหม่",
    cancelLabel: "ไม่ใช่",
  });
  if (!ok) return;

  const btn = $("#menu-apply");
  const box = $("#menu-progress");
  btn.disabled = true;
  let after = "", total = 0, failed = 0, rounds = 0;
  try {
    // ดึงรายชื่อเพื่อนทั้งหมดจาก LINE มาก่อนเสมอ ไม่งั้น "ทุกคน" จะแปลว่าเฉพาะคนที่ระบบรู้จัก
    // ขอไม่ได้ก็ไม่หยุด — ไล่ตั้งให้เท่าที่รู้จักดีกว่าไม่ทำอะไรเลย แต่ต้องบอกให้รู้ว่าไม่ครบ
    let known = 0, partial = false;
    for (let start = "", page = 0; page < 60; page++) {
      let r;
      try {
        r = await api("/api/admin/richmenu", { method: "POST", body: { action: "sync_followers", start } });
      } catch (e) {
        partial = true;
        box.innerHTML = `<p class="hintnote">ขอรายชื่อเพื่อนจาก LINE ไม่ได้ · ${esc(e.message || "")}<br>
          จะตั้งให้เท่าที่ระบบรู้จักแทน</p>`;
        break;
      }
      known += r.fetched;
      box.innerHTML = `<p class="hintnote">ดึงรายชื่อเพื่อนมาแล้ว <b>${known}</b> คน...</p>`;
      if (r.done || !r.next) break;
      start = r.next;
    }
    if (!partial && known > 0) box.innerHTML = `<p class="hintnote">เป็นเพื่อนทั้งหมด <b>${known}</b> คน · กำลังตั้งเมนู...</p>`;

    for (;;) {
      const r = await api("/api/admin/richmenu", { method: "POST", body: { after } });
      total += r.processed;
      failed += r.failed;
      rounds += 1;
      box.innerHTML = `<p class="hintnote">ตั้งไปแล้ว <b>${total}</b> คน${failed ? ` · ไม่สำเร็จ ${failed} คน` : ""}</p>`;
      if (r.done || !r.next || rounds > 100) break;
      after = r.next;
    }
    // เลข "ผูกรายคน" น้อยกว่าจำนวนสมาชิกจริงเสมอ เพราะระบบผูกรายคนได้เฉพาะคนที่รู้จัก
    // ถ้าไม่อธิบายคู่กัน คนอ่านจะเข้าใจว่าเปลี่ยนไปแค่เท่านั้นคน ทั้งที่เมนูตั้งต้นถึงทุกคนแล้ว
    box.innerHTML =
      `<p class="hintnote">
         <b>เสร็จแล้ว</b><br>
         • ตั้งเมนูหลักให้ <b>ทุกคนใน OA</b> แล้ว รวมคนที่ระบบไม่รู้จัก<br>
         • ผูกเมนูรายคนทับให้อีก <b>${total}</b> บัญชีที่ระบบรู้จัก${failed ? ` (ไม่สำเร็จ ${failed} บัญชี — มักเป็นคนที่บล็อกหรือลบ OA ไปแล้ว)` : ""}<br>
         ให้พนักงานปิดแล้วเปิดห้องแชทใหม่ ถ้ายังเห็นของเดิม
       </p>`;
    toast(`ตั้งเมนูให้ ${total} คนแล้ว`);
  } catch (e) {
    box.innerHTML = `<p class="hintnote">หยุดกลางคัน: ${esc(e.message || "")}</p>`;
  } finally {
    btn.disabled = false;
  }
}

/** ถอดเมนูตั้งต้นของ OA ออก — ระบบนี้ตั้งใจไม่ใช้ ให้ทุกคนได้เมนูตามสถานะของตัวเองแทน */
async function clearDefaultMenu() {
  const ok = await confirmDialog({
    title: "ถอดเมนูตั้งต้นของ OA?",
    message:
      "หลังถอดแล้ว คนที่ไม่มีเมนูผูกไว้เป็นรายคนจะไม่เห็นเมนูใด ๆ จนกว่าระบบจะตั้งให้ " +
      "ซึ่งเกิดตอนแอดเพื่อน ตอนลงทะเบียนเสร็จ หรือตอนกดตั้งเมนูจากหน้านี้",
    confirmLabel: "ถอดออก",
    cancelLabel: "ไม่ใช่",
  });
  if (!ok) return;
  try {
    await api("/api/admin/richmenu", { method: "POST", body: { action: "clear_default" } });
    toast("ถอดเมนูตั้งต้นแล้ว");
    await goMenuCheck();
  } catch (e) {
    toast(e.message || "ถอดไม่สำเร็จ");
  }
}

/* ---------- ถอดเมนูเฉพาะบางคน ---------- */

/**
 * ช่องค้นหาคนสำหรับสั่งงานรายคน — ใช้ร่วมกันทั้งปุ่มตั้งเมนูและปุ่มถอด
 *
 * ทำเป็นช่องเดียวเพราะขั้นตอนเหมือนกันเป๊ะ (ค้นชื่อ → เลือกคน → ยืนยัน) ต่างกันแค่
 * สิ่งที่เกิดขึ้นตอนกด ถ้าแยกเป็นสองช่องคนละที่ หน้าจะยาวขึ้นโดยไม่ได้อะไรเพิ่ม
 */
let menuEmpMode = "unlink";   // "unlink" = ถอดเมนู · "apply" = ตั้งเมนูให้

function openMenuEmpFinder(mode) {
  menuEmpMode = mode;
  $("#menu-emp-title").textContent = mode === "apply" ? "ตั้งเมนูให้ใคร" : "ถอดเมนูของใคร";
  $("#menu-find-emp").style.display = "";
  $("#menu-emp-q").value = "";
  $("#menu-emp-hits").innerHTML = '<div class="empty">พิมพ์อย่างน้อย 2 ตัวอักษร</div>';
  $("#menu-find-emp").scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => $("#menu-emp-q").focus(), 50);
}

async function searchMenuUnlinkTarget(q) {
  if (q.trim().length < 2) {
    $("#menu-emp-hits").innerHTML = '<div class="empty">พิมพ์อย่างน้อย 2 ตัวอักษร</div>';
    return;
  }
  try {
    // ไม่กรองเฉพาะคนที่ยังทำงานอยู่ เพราะเหตุผลที่ต้องถอดเมนูมักเป็นคนที่ลาออกไปแล้ว
    const r = await api("/api/admin/employees?q=" + encodeURIComponent(q.trim()));
    const list = (r.employees || []).slice(0, 12);
    $("#menu-emp-hits").innerHTML = list.length
      ? `<div class="plist">${list
          .map(
            (e) => `<div class="prow" data-unlink-emp="${esc(e.id)}" data-name="${esc(e.full_name)}">
              <div class="pw">
                <div class="pnm">${esc(e.full_name)}</div>
                <div class="psub"><b>${esc(e.employee_code)}</b>${
                  e.department_name ? " · " + esc(e.department_name) : ""
                }</div>
              </div>
              ${e.linked ? "" : '<span class="rtag nolink">ยังไม่ผูก LINE</span>'}
            </div>`,
          )
          .join("")}</div>`
      : '<div class="empty">ไม่พบพนักงานที่ตรงกับที่ค้น</div>';
  } catch (e) {
    $("#menu-emp-hits").innerHTML = `<div class="empty">${esc(e.message || "ค้นหาไม่สำเร็จ")}</div>`;
  }
}

async function menuActFor(employeeId, name) {
  const apply = menuEmpMode === "apply";
  const ok = await confirmDialog({
    title: apply ? `ตั้งเมนูหลักให้ ${name}?` : `ถอดเมนูของ ${name}?`,
    message: apply
      ? "คนนี้จะได้เมนูหลักทันที และถ้าเคยถูกถอดไว้ จะถูกเอาออกจากรายการที่ถอดด้วย " +
        "ปุ่มเปลี่ยนให้ทุกคนจะนับคนนี้ตามปกติอีกครั้ง"
      : "คนนี้จะไม่เห็นเมนูด้านล่างห้องแชทเลย และปุ่ม “เปลี่ยน rich menu ให้ทุกคน” " +
        "จะข้ามคนนี้ไปตลอด จนกว่าจะกดปุ่ม “เปลี่ยนเฉพาะบุคคล” คืนให้ · " +
        "เรื่องที่เคยแจ้งและคิวที่จองไว้ยังอยู่ครบ",
    confirmLabel: apply ? "ตั้งเมนูให้" : "ถอดเมนู",
    cancelLabel: "ไม่ใช่",
  });
  if (!ok) return;
  try {
    await api("/api/admin/richmenu", {
      method: "POST",
      body: { action: apply ? "apply_one" : "unlink", employeeId },
    });
    toast(apply ? `ตั้งเมนูให้ ${name} แล้ว` : `ถอดเมนูของ ${name} แล้ว`);
    $("#menu-find-emp").style.display = "none";
    // โหลดผลตรวจใหม่ ไม่งั้นรายชื่อคนที่ถูกถอดกับตัวเลขบนปุ่มจะเป็นของเก่า
    goMenuCheck();
  } catch (e) {
    toast(e.message || (apply ? "ตั้งเมนูไม่สำเร็จ" : "ถอดเมนูไม่สำเร็จ"));
  }
}

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

/**
 * เปิดฟอร์มเพิ่มพนักงาน
 *
 * ต้องรอรายชื่อชั้นให้มาก่อน — รายการชั้นเป็นของฝั่งเซิร์ฟเวอร์ (FLOORS ใน _lib/constants.ts)
 * ไม่ใช่รายการที่เขียนไว้ในหน้าเว็บเหมือนฝ่าย/แผนก ถ้าเปิดฟอร์มก่อนที่ข้อมูลจะมาถึง
 * ช่องเลือกชั้นจะเหลือแค่ "เลือกชั้น" กับ "ชั้นอื่น" คือไม่มีชั้นให้เลือกเลย
 * ซึ่งต่างจากหน้าแจ้งปัญหาที่ขึ้นครบทุกชั้น ทั้งที่ควรเป็นรายการเดียวกัน
 */
async function openEmpForm() {
  await getMasters().catch(() => null);
  fillSelect($("#n-dept"), "เลือกฝ่าย/แผนก", ORG_DEPTS, "อื่น ๆ (ระบุเอง)");
  fillSelect($("#n-floor"), "เลือกชั้น", (masters && masters.floors) || [], "ชั้นอื่น");
  $("#admin-new").style.display = "block";
  $("#n-code").focus();
}

function closeEmpForm() {
  ["#n-code", "#n-name", "#n-deptOther", "#n-floorOther"].forEach((s) => ($(s).value = ""));
  $("#n-deptOther").style.display = "none";
  $("#n-floorOther").style.display = "none";
  $("#admin-new").style.display = "none";
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
/* ---------- หน้าผู้ดูแลระบบ ----------
 *
 * ทะเบียนพนักงานเริ่มจาก "คน" แล้วดูว่าคนนั้นมีสิทธิ์อะไร หน้านี้กลับด้าน — เริ่มจาก "สิทธิ์"
 * แล้วดูว่าใครถืออยู่ ซึ่งเป็นคำถามที่ตอบไม่ได้เลยเมื่อมีพนักงานหลายร้อยคน
 *
 * ไม่มีตารางสิทธิ์แยกอีกชุด การเพิ่ม/แก้/ถอด ยิงเข้าเส้นทางเดียวกับที่ทะเบียนพนักงานใช้
 * (employees/:id/departments) เพื่อให้กติกาอย่าง "ต้องเหลือผู้ดูแลหนึ่งคน" อยู่ที่เดียว
 */

let rolesData = null;
let rolesFindTimer = null;

/**
 * รหัสฝ่ายที่ให้สิทธิ์ผู้ดูแลระบบ — ถามจาก /api/masters ไม่เขียน "HR" ทับไว้ตรงนี้
 * แหล่งความจริงอยู่ที่ ADMIN_DEPARTMENT_CODE ฝั่งเซิร์ฟเวอร์ ที่นี่แค่รับค่ามาใช้
 */
function adminDeptCode() {
  const d = ((masters && masters.departments) || []).find((x) => x.grants_admin);
  return d ? d.code : "HR";
}

/** add: true = เข้ามาจากปุ่ม "เพิ่มผู้ดูแลระบบ" ที่หน้าจัดการ ให้เปิดช่องค้นหารอไว้เลย */
async function goRoles({ add = false } = {}) {
  setTab("roles");
  show("s-roles");
  if (add) openRolesFinder();
  else closeRolesFinder();
  $("#rolesList").innerHTML = '<div class="empty">กำลังโหลดข้อมูล…</div>';
  try {
    rolesData = await api("/api/admin/admins");
    renderRoles();
  } catch (e) {
    $("#rolesList").innerHTML = `<div class="empty">${esc(e.message || "โหลดข้อมูลไม่สำเร็จ")}</div>`;
  }
}

/** ป้ายขวาสุด — บอกเฉพาะเรื่องที่ทำให้สิทธิ์ใช้ไม่ได้จริง ตำแหน่งในฝ่ายไม่เกี่ยวกับหน้านี้ */
function roleTag(m) {
  if (m.status === "suspended") return '<span class="rtag susp">ระงับสิทธิ์</span>';
  if (!m.linked) return '<span class="rtag nolink">ยังไม่ผูก LINE</span>';
  return "";
}

function renderRoles() {
  const admins = rolesData.admins || [];
  const rows = admins
    .map(
      (m) => `<div class="prow" data-role-emp="${esc(m.id)}">
        <div class="pw">
          <div class="pnm">${esc(m.full_name)}${m.id === rolesData.me ? " (คุณ)" : ""}</div>
          <div class="psub"><b>${esc(m.employee_code)}</b>${
            m.department_name ? " · " + esc(m.department_name) : ""
          }</div>
        </div>${roleTag(m)}
      </div>`,
    )
    .join("");

  // ทางสำรองที่ตั้งไว้ในค่า env — ถอดในหน้านี้ไม่ได้ ต้องไปแก้ที่ Cloudflare
  // แต่ต้องบอกให้รู้ว่ามีอยู่ ไม่งั้นจะงงว่าทำไมคนที่ไม่อยู่ในรายชื่อยังเข้าหน้าผู้ดูแลได้
  const fall = (rolesData.fallbackCodes || []).length
    ? `<div class="rfall">มีรหัสพนักงานที่ตั้งเป็นผู้ดูแลสำรองไว้ในค่าระบบด้วย:
        <b>${rolesData.fallbackCodes.map(esc).join(", ")}</b><br>
        รหัสเหล่านี้เป็นผู้ดูแลเสมอ ถอดในหน้านี้ไม่ได้ ต้องแก้ค่า ADMIN_EMPLOYEE_CODES ที่ Cloudflare</div>`
    : "";

  $("#rolesList").innerHTML = admins.length
    ? `<div class="rhead"><span class="rnm">ผู้ดูแลระบบ</span><span class="rct">${admins.length} คน</span></div>
       <div class="plist">${rows}</div>${fall}`
    : `<div class="empty">ยังไม่มีผู้ดูแลระบบในรายชื่อ</div>${fall}`;
}

/* ---------- เพิ่มผู้ดูแล ---------- */

function openRolesFinder() {
  $("#roles-find").style.display = "";
  $("#roles-q").value = "";
  $("#roles-hits").innerHTML = '<div class="empty">พิมพ์อย่างน้อย 2 ตัวอักษร</div>';
  setTimeout(() => $("#roles-q").focus(), 50);
}
function closeRolesFinder() {
  $("#roles-find").style.display = "none";
}

async function searchRolesEmployee(q) {
  if (q.trim().length < 2) {
    $("#roles-hits").innerHTML = '<div class="empty">พิมพ์อย่างน้อย 2 ตัวอักษร</div>';
    return;
  }
  try {
    const r = await api("/api/admin/employees?status=active&q=" + encodeURIComponent(q.trim()));
    const already = new Set((rolesData.admins || []).map((a) => a.id));
    const list = (r.employees || []).filter((e) => !already.has(e.id)).slice(0, 12);
    $("#roles-hits").innerHTML = list.length
      ? `<div class="plist">${list
          .map(
            (e) => `<div class="prow" data-pick-emp="${esc(e.id)}" data-name="${esc(e.full_name)}">
              <div class="pw">
                <div class="pnm">${esc(e.full_name)}</div>
                <div class="psub"><b>${esc(e.employee_code)}</b>${
                  e.department_name ? " · " + esc(e.department_name) : ""
                }</div>
              </div>
            </div>`,
          )
          .join("")}</div>`
      : '<div class="empty">ไม่พบพนักงานที่ตรงกับที่ค้น</div>';
  } catch (e) {
    $("#roles-hits").innerHTML = `<div class="empty">${esc(e.message || "ค้นหาไม่สำเร็จ")}</div>`;
  }
}

/**
 * เพิ่มผู้ดูแลระบบ — ไม่ต้องถามว่าฝ่ายไหนหรือตำแหน่งอะไร เพราะหน้านี้มีสิทธิ์แบบเดียว
 *
 * เบื้องหลังคือการใส่คนเข้าฝ่ายบุคคล ซึ่งเป็นสิ่งที่ auth.ts แปลเป็น "เข้าถึงได้ทุกอย่าง"
 * แต่คนที่กดไม่ต้องรู้เรื่องนั้น เขาแค่ต้องการให้คนนี้เป็นผู้ดูแล
 */
async function addRole(employeeId, name) {
  await getMasters();
  const ok = await confirmDialog({
    title: `ตั้ง ${name} เป็นผู้ดูแลระบบ?`,
    message:
      "หลังจากนี้จะเข้าถึงได้ทุกอย่าง — ทะเบียนพนักงานทั้งองค์กร หน้าผู้ดูแลระบบ " +
      "คิวงานทุกฝ่าย และหน้าผู้ดูแลคิวนวด",
    confirmLabel: "ตั้งเป็นผู้ดูแล",
    cancelLabel: "ไม่ใช่",
  });
  if (!ok) return;
  try {
    await api(`/api/admin/employees/${employeeId}/departments`, {
      method: "PATCH",
      body: { department_code: adminDeptCode(), role: "staff" },
    });
    toast(`ตั้ง ${name} เป็นผู้ดูแลระบบแล้ว`);
    goRoles();
  } catch (e) {
    toast(e.message || "บันทึกไม่สำเร็จ");
  }
}

/* ---------- แก้ไข / ถอดสิทธิ์ ---------- */

async function editRole(employeeId) {
  const m = (rolesData.admins || []).find((x) => x.id === employeeId);
  if (!m) return;
  const self = employeeId === rolesData.me;

  const meta = `<div class="sub">${esc(m.employee_code)}${
    m.department_name ? " · " + esc(m.department_name) : ""
  }</div>
    <div class="kv"><i>สิทธิ์</i><b>ผู้ดูแลระบบ — เข้าถึงได้ทุกอย่าง</b></div>
    ${self ? '<div class="kv"><i>หมายเหตุ</i><b>นี่คือสิทธิ์ของคุณเอง</b></div>' : ""}`;

  const act = await openSheet(m.full_name, [
    { label: "ถอดสิทธิ์ผู้ดูแลระบบ", value: "drop", danger: true },
  ], { meta });
  if (act !== "drop") return;

  const ok = await confirmDialog({
    title: `ถอด ${m.full_name} ออกจากผู้ดูแลระบบ?`,
    message: self
      ? "คุณกำลังถอดสิทธิ์ของตัวเอง หลังจากนี้จะเข้าหน้าผู้ดูแลไม่ได้อีก " +
        "และต้องให้ผู้ดูแลคนอื่นใส่สิทธิ์คืนให้"
      : "คนนี้จะเข้าหน้าผู้ดูแลไม่ได้อีก ทั้งทะเบียนพนักงาน หน้านี้ และหน้าผู้ดูแลคิวนวด " +
        "ถ้ายังต้องให้รับเรื่องของฝ่ายอยู่ ให้ไปกำหนดที่แท็บทะเบียนพนักงาน",
    confirmLabel: "ถอดสิทธิ์",
    cancelLabel: "ไม่ใช่",
  });
  if (!ok) return;
  try {
    await api(`/api/admin/employees/${employeeId}/departments`, {
      method: "PATCH",
      body: { department_code: adminDeptCode(), role: "" },
    });
    toast("ถอดสิทธิ์เรียบร้อยแล้ว");
    goRoles();
  } catch (e) {
    toast(e.message || "บันทึกไม่สำเร็จ");
  }
}

/* ---------- ผูกบัญชีไลน์ให้พนักงาน ----------
 *
 * LINE ไม่บอกว่า userId ไหนเป็นของใคร บอกได้แค่ชื่อที่เจ้าตัวตั้งไว้กับรูปโปรไฟล์
 * คนที่รู้จริงคือฝ่ายบุคคลซึ่งเห็นรายชื่อแชทใน OA Manager อยู่แล้ว หน้านี้จึงกางรายชื่อ
 * ให้ดู แล้วให้คนเป็นคนจับคู่ ระบบไม่เดาให้เอง — เดาผิดแปลว่าคนหนึ่งได้คิวนวดและ
 * เรื่องแจ้งของอีกคน ส่วนเจ้าตัวจริงจะเข้าระบบไม่ได้เลยจนกว่าจะมีคนมาปลดให้
 */

let linkWaiting = [];
let fillLeft = 0;      // เหลือกี่คนที่ยังไม่รู้ชื่อ — ปุ่มดึงชื่อขึ้นเมื่อมีมากกว่าศูนย์

async function goLinkAccounts() {
  show("s-link");
  $("#linkList").innerHTML = '<div class="empty">กำลังโหลดข้อมูล…</div>';
  $("#link-tally").textContent = "—";
  $("#imp-box").style.display = "none";
  $("#imp-open").style.display = "";
  $("#imp-result").innerHTML = "";
  try {
    const r = await api("/api/admin/followers");
    linkWaiting = r.waiting || [];
    $("#link-tally").innerHTML =
      `เป็นเพื่อนกับ LINE OA ทั้งหมด <b>${r.total}</b> คน · ผูกรหัสพนักงานแล้ว <b>${r.linked}</b> คน`;
    renderFillBox(r.nameless || 0);
    renderLinkList();
  } catch (e) {
    $("#linkList").innerHTML = `<div class="empty">${esc(e.message || "โหลดข้อมูลไม่สำเร็จ")}</div>`;
  }
}

/**
 * ปุ่มดึงชื่อ — ขึ้นเฉพาะตอนมีคนที่ยังไม่มีชื่อจริง ๆ
 *
 * คนกลุ่มนี้คือคนที่ทักเข้ามาเอง ระบบเก็บได้แค่ userId เพราะตอนนั้นยังไม่ได้ถามชื่อ
 * ปุ่มนี้ไปถาม LINE ทีหลังให้ ไม่ต้องรอให้ฝ่ายบุคคลไปหาชื่อมาวางเอง
 */
function renderFillBox(nameless) {
  fillLeft = nameless;
  $("#fill-box").style.display = nameless > 0 ? "" : "none";
  if (nameless <= 0) return;
  $("#fill-go").disabled = false;
  $("#fill-go").textContent = `ดึงชื่อไลน์ที่ยังไม่มี (${nameless} คน)`;
  $("#fill-note").innerHTML =
    `มี <b>${nameless}</b> คนที่ระบบรู้จักแต่ยังไม่รู้ชื่อ — เป็นคนที่เคยทักเข้ามาในไลน์<br>` +
    "กดปุ่มแล้วระบบจะไปถามชื่อกับรูปจาก LINE มาให้เอง ทำได้ครั้งละ 25 คน กดซ้ำจนหมดได้";
}

/**
 * กดแล้ววนดึงจนหมด ไม่ใช่กดครั้งเดียวได้ 25 คน
 *
 * ทำเป็นชุดเพราะ Worker แผนฟรียิงคำขอย่อยได้จำกัดต่อหนึ่งคำขอ หน้าจอจึงเป็นคนวนเรียกซ้ำ
 * และรายงานความคืบหน้าระหว่างทาง ไม่ใช่ค้างเป็นปุ่มกดไม่ได้เฉย ๆ จนกว่าจะจบ
 */
async function fillFollowerNames() {
  const btn = $("#fill-go");
  if (btn.disabled) return;
  btn.disabled = true;

  let filled = 0;
  let gone = 0;
  try {
    for (let round = 0; round < 40; round++) {
      btn.textContent = `กำลังดึงชื่อ… (ได้แล้ว ${filled} คน)`;
      const r = await api("/api/admin/followers/names", { method: "POST" });
      filled += r.filled || 0;
      gone += r.gone || 0;
      fillLeft = r.remaining || 0;
      if (r.error) {
        await confirmDialog({
          title: "ถาม LINE ไม่สำเร็จ",
          message: `ดึงชื่อได้ ${filled} คนก่อนจะติดปัญหา — ${r.error}`,
          confirmLabel: "เข้าใจแล้ว",
          cancelLabel: "ปิด",
        });
        break;
      }
      if (fillLeft === 0) break;
    }
  } catch (e) {
    await confirmDialog({
      title: "ดึงชื่อไม่สำเร็จ",
      message: e.message || "",
      confirmLabel: "เข้าใจแล้ว",
      cancelLabel: "ปิด",
    });
  }

  const parts = [`ดึงชื่อมาได้ ${filled} คน`];
  if (gone > 0) parts.push(`อีก ${gone} คนไม่ได้เป็นเพื่อนกับ OA แล้ว จึงไม่มีชื่อให้ดึง`);
  if (filled > 0 || gone > 0) toast(parts.join(" · "));
  await goLinkAccounts();
}

function renderLinkList() {
  if (!linkWaiting.length) {
    $("#linkList").innerHTML =
      `<div class="empty">ไม่มีใครรอผูกรหัส<br>ถ้ารายชื่อยังไม่ครบ ให้ดึงรายชื่อผู้ติดตามเข้ามาใหม่อีกรอบ</div>`;
    return;
  }
  $("#linkList").innerHTML = `<div class="section">รอผูกรหัสพนักงาน ${linkWaiting.length} คน</div>
    <div class="plist">${linkWaiting
      .map(
        (f) => `<div class="frow${f.gone ? " gone" : ""}" data-follower="${esc(f.line_user_id)}">
          ${
            f.picture_url
              ? `<img class="fav" src="${esc(f.picture_url)}" alt="" referrerpolicy="no-referrer" />`
              : `<div class="fav none">?</div>`
          }
          <div class="fw">
            <div class="fnm${f.display_name ? "" : " nameless"}">${esc(
              f.display_name || (f.gone ? "ไม่ได้เป็นเพื่อนกับ OA แล้ว" : "ยังไม่ได้ดึงชื่อ"),
            )}</div>
            <div class="fid">${esc(f.line_user_id)}</div>
          </div>
          <button class="copybtn" data-copy="${esc(f.line_user_id)}">คัดลอก</button>
        </div>`,
      )
      .join("")}</div>`;
}

/** เลือกพนักงานให้บัญชีไลน์นี้ แล้วผูกให้เลย */
async function linkFollower(lineUserId) {
  const f = linkWaiting.find((x) => x.line_user_id === lineUserId);
  if (!f) return;

  const picked = await pickEmployeeFor(f);
  if (!picked) return;

  // ให้เห็นทั้งสองฝั่งพร้อมกันก่อนกดยืนยัน เพราะจับคู่ผิดแล้วเจ้าตัวจริงจะเข้าระบบไม่ได้
  const ok = await confirmDialog({
    title: "ผูกบัญชีนี้ใช่หรือไม่",
    message:
      `บัญชีไลน์: ${f.display_name || "(ยังไม่รู้ชื่อ — " + f.line_user_id + ")"}\n` +
      `พนักงาน: ${picked.name} · ${picked.code}${picked.dept ? " · " + picked.dept : ""}\n\n` +
      "หลังจากนี้เจ้าตัวเปิดแอปใช้งานได้ทันทีโดยไม่ต้องลงทะเบียนเอง " +
      "ถ้าผูกผิด ปลดได้ที่ทะเบียนพนักงาน",
    confirmLabel: "ผูกบัญชี",
    cancelLabel: "ไม่ใช่",
  });
  if (!ok) return;

  try {
    const r = await api("/api/admin/followers/link", {
      method: "POST",
      body: { lineUserId, employeeId: picked.id },
    });
    toast(`ผูกบัญชีให้ ${r.name} แล้ว`);
    goLinkAccounts();
  } catch (e) {
    toast(e.message || "ผูกบัญชีไม่สำเร็จ");
  }
}

/** กล่องค้นชื่อพนักงาน — โชว์บัญชีไลน์ที่กำลังจับคู่ค้างไว้ข้างบนตลอด */
function pickEmployeeFor(follower) {
  return new Promise((resolve) => {
    let chosen = null;
    let timer;

    $("#sheet-title").textContent = "จับคู่กับพนักงานคนไหน";
    $("#sheet-meta").innerHTML =
      `<div class="sub">บัญชีไลน์: ${esc(follower.display_name || "ยังไม่รู้ชื่อ · " + follower.line_user_id)}</div>
       <div class="finder">
         <input id="lk-find" type="text" placeholder="พิมพ์ชื่อ หรือรหัสพนักงาน" autocomplete="off" />
         <div class="hits" id="lk-hits"><div class="empty">พิมพ์อย่างน้อย 2 ตัวอักษร</div></div>
       </div>`;
    $("#sheet-opts").innerHTML = "";

    const done = (v) => {
      $("#sheet").classList.remove("on");
      $("#backdrop").classList.remove("on");
      $("#sheet-meta").innerHTML = "";
      $("#backdrop").onclick = null;
      // คืนปุ่มยกเลิกให้กล่องเลือกปกติ ไม่งั้นกล่องอื่นที่เปิดทีหลังจะปิดไม่ลง
      $("#sheet-cancel").onclick = () => finishSheet(null);
      resolve(v);
    };
    $("#sheet-cancel").onclick = () => done(null);
    $("#backdrop").onclick = () => done(null);

    const search = async (q) => {
      if (q.trim().length < 2) {
        $("#lk-hits").innerHTML = '<div class="empty">พิมพ์อย่างน้อย 2 ตัวอักษร</div>';
        return;
      }
      try {
        const r = await api("/api/admin/employees?status=active&q=" + encodeURIComponent(q.trim()));
        // คนที่ผูกบัญชีไลน์ไว้แล้วไม่ต้องขึ้น ผูกซ้ำไม่ได้อยู่แล้ว
        const list = (r.employees || []).filter((e) => !e.linked).slice(0, 12);
        $("#lk-hits").innerHTML = list.length
          ? `<div class="plist">${list
              .map(
                (e) => `<div class="prow" data-pick="${esc(e.id)}" data-name="${esc(e.full_name)}"
                  data-code="${esc(e.employee_code)}" data-dept="${esc(e.department_name || "")}">
                  <div class="pw">
                    <div class="pnm">${esc(e.full_name)}</div>
                    <div class="psub"><b>${esc(e.employee_code)}</b>${
                      e.department_name ? " · " + esc(e.department_name) : ""
                    }</div>
                  </div>
                </div>`,
              )
              .join("")}</div>`
          : '<div class="empty">ไม่พบพนักงานที่ยังไม่ได้ผูกบัญชี</div>';
      } catch (e) {
        $("#lk-hits").innerHTML = `<div class="empty">${esc(e.message || "ค้นหาไม่สำเร็จ")}</div>`;
      }
    };

    $("#lk-find").oninput = (e) => {
      clearTimeout(timer);
      const q = e.target.value;
      timer = setTimeout(() => search(q), 250);
    };
    $("#lk-hits").onclick = (e) => {
      const row = e.target.closest("[data-pick]");
      if (!row) return;
      chosen = { id: row.dataset.pick, name: row.dataset.name, code: row.dataset.code, dept: row.dataset.dept };
      done(chosen);
    };

    $("#sheet").classList.add("on");
    $("#backdrop").classList.add("on");
    setTimeout(() => $("#lk-find").focus(), 50);
  });
}

/* ---------- วางข้อมูลทีละหลายคน ----------
 *
 * ฝ่ายบุคคลรวบรวมรหัสพนักงานคู่กับบัญชีไลน์มาเองในไฟล์ตาราง ก่อนหน้านี้ต้องเอาไปแปะ
 * เป็นคำสั่ง SQL รันที่ฐานข้อมูลทุกครั้ง ซึ่งเป็นงานที่คนไม่ได้เขียนโปรแกรมไม่ควรต้องทำ
 * และพลาดครั้งเดียวก็แก้ยาก
 */

const IMPORT_TAG = {
  ready: { cls: "ok", text: "พร้อมผูก" },
  done: { cls: "ok", text: "ผูกแล้ว" },
  duplicate: { cls: "skip", text: "ซ้ำในรายการ" },
  emp_taken: { cls: "skip", text: "ผูกบัญชีอื่นแล้ว" },
  line_taken: { cls: "skip", text: "ไลน์นี้มีเจ้าของ" },
  not_found: { cls: "bad", text: "ไม่พบรหัสนี้" },
  suspended: { cls: "bad", text: "ถูกระงับสิทธิ์" },
  bad_user_id: { cls: "bad", text: "userId ไม่ถูกต้อง" },
  bad_row: { cls: "bad", text: "ข้อมูลไม่ครบ" },
};

/**
 * แยกคอลัมน์จากข้อความที่วางมา โดยดูจากหน้าตาของข้อมูล ไม่ใช่จากลำดับคอลัมน์
 *
 * ไฟล์ตารางของแต่ละคนเรียงคอลัมน์ไม่เหมือนกัน และการบังคับลำดับแปลว่าคนวางต้อง
 * ไปจัดคอลัมน์ใหม่ก่อนทุกครั้ง ซึ่งเป็นอีกจุดที่พลาดได้ — ดูจากหน้าตาแทน
 * รหัสไลน์ขึ้นต้นด้วย U และยาว 33 ตัว · รหัสพนักงานเป็นตัวเลขล้วน · ที่เหลือคือชื่อ
 */
function parseImportLine(line) {
  const parts = line.split(/[\t,;]+|\s{2,}/).map((x) => x.trim()).filter(Boolean);
  const flat = parts.length > 1 ? parts : line.trim().split(/\s+/);
  let userId = "", code = "";
  const rest = [];
  for (const p of flat) {
    if (!userId && /^U[0-9a-f]{32}$/i.test(p)) userId = p;
    else if (!code && /^\d+$/.test(p)) code = p;
    else rest.push(p);
  }
  return { code, userId, lineName: rest.join(" ") };
}

function readImportRows() {
  return $("#imp-text").value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parseImportLine);
}

function renderImportRows(rows, applied) {
  const ready = rows.filter((r) => r.status === "ready").length;
  const list = rows
    .map((r) => {
      const tag = IMPORT_TAG[r.status] || { cls: "skip", text: r.status };
      return `<div class="irow">
        <div class="iw">
          <div class="inm">${esc(r.employeeName || r.lineName || "—")}</div>
          <div class="isub"><b>${esc(r.code || "ไม่มีรหัส")}</b>${
            r.lineName && r.employeeName ? " · ไลน์: " + esc(r.lineName) : ""
          }</div>
        </div>
        <span class="itag ${tag.cls}">${tag.text}</span>
      </div>`;
    })
    .join("");

  $("#imp-result").innerHTML = `
    <div class="section" style="margin-top:16px">ผลการตรวจสอบ ${rows.length} บรรทัด</div>
    <p class="hintnote">ดูให้แน่ใจว่า <b>ชื่อในทะเบียน</b> กับ <b>ชื่อในไลน์</b> เป็นคนเดียวกันจริง
      ผูกผิดแล้วคนหนึ่งจะได้คิวนวดและเรื่องแจ้งของอีกคน</p>
    <div class="plist">${list}</div>
    ${
      applied
        ? `<p class="hintnote" style="margin-top:12px">ผูกให้แล้ว ${ready} คน</p>`
        : ready > 0
          ? `<button class="send" id="imp-apply" style="margin-top:12px">ผูกบัญชีให้ ${ready} คน</button>`
          : `<p class="hintnote" style="margin-top:12px">ไม่มีบรรทัดไหนที่ผูกได้</p>`
    }`;
}

async function checkImport() {
  const rows = readImportRows();
  if (!rows.length) return toast("ยังไม่ได้วางข้อมูล");
  if (rows.length > 30) return toast("ครั้งละไม่เกิน 30 คน กรุณาแบ่งวางเป็นชุด");
  try {
    const r = await api("/api/admin/followers/import", { method: "POST", body: { rows } });
    renderImportRows(r.rows || [], false);
  } catch (e) {
    toast(e.message || "ตรวจสอบไม่สำเร็จ");
  }
}

async function applyImport() {
  const rows = readImportRows();
  const ok = await confirmDialog({
    title: "ผูกบัญชีตามรายการนี้?",
    message:
      "ระบบจะผูกเฉพาะบรรทัดที่ขึ้นว่า “พร้อมผูก” เจ้าตัวจะเปิดแอปใช้งานได้ทันที " +
      "โดยไม่ต้องลงทะเบียนเอง ถ้าผูกผิด ปลดได้ที่ทะเบียนพนักงาน",
    confirmLabel: "ผูกบัญชี",
    cancelLabel: "ไม่ใช่",
  });
  if (!ok) return;
  try {
    const r = await api("/api/admin/followers/import", { method: "POST", body: { rows, apply: true } });
    renderImportRows(r.rows || [], true);
    toast(`ผูกบัญชีให้ ${r.linked} คนแล้ว`);
    $("#imp-text").value = "";
    // ตัวเลขสรุปกับรายชื่อที่รอจับคู่ด้านล่างเปลี่ยนไปแล้ว ต้องโหลดใหม่
    const fresh = await api("/api/admin/followers");
    linkWaiting = fresh.waiting || [];
    $("#link-tally").innerHTML =
      `เป็นเพื่อนกับ LINE OA ทั้งหมด <b>${fresh.total}</b> คน · ผูกรหัสพนักงานแล้ว <b>${fresh.linked}</b> คน`;
    renderLinkList();
  } catch (e) {
    toast(e.message || "ผูกบัญชีไม่สำเร็จ");
  }
}

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
    b.addEventListener("click", () => {
      if (b.dataset.tab === "admin") return goAdmin();
      if (b.dataset.tab === "roles") return goRoles();
      return goMe();
    }),
  );

  // ── หน้าผู้ดูแลระบบ ──
  $("#mg-role").onclick = () => goRoles({ add: true });
  $("#mg-link").onclick = goLinkAccounts;
  $("#link-back").onclick = goMe;
  $("#fill-go").onclick = fillFollowerNames;
  $("#imp-open").onclick = () => {
    $("#imp-open").style.display = "none";
    $("#imp-box").style.display = "";
    $("#imp-result").innerHTML = "";
    setTimeout(() => $("#imp-text").focus(), 50);
  };
  $("#imp-cancel").onclick = () => {
    $("#imp-box").style.display = "none";
    $("#imp-open").style.display = "";
  };
  $("#imp-check").onclick = checkImport;
  $("#imp-result").addEventListener("click", (e) => {
    if (e.target.closest("#imp-apply")) applyImport();
  });
  $("#linkList").addEventListener("click", (e) => {
    // ปุ่มคัดลอกอยู่ในแถวเดียวกับพื้นที่กดจับคู่ ต้องหยุดไว้ก่อน ไม่งั้นกดคัดลอกแล้วกล่องจับคู่เด้งตาม
    const cp = e.target.closest("[data-copy]");
    if (cp) {
      e.stopPropagation();
      copyText(cp.dataset.copy, cp);
      return;
    }
    const row = e.target.closest("[data-follower]");
    if (row) linkFollower(row.dataset.follower);
  });
  $("#roles-cancel").onclick = closeRolesFinder;
  $("#roles-q").oninput = (e) => {
    clearTimeout(rolesFindTimer);
    const q = e.target.value;
    rolesFindTimer = setTimeout(() => searchRolesEmployee(q), 250);
  };
  $("#roles-hits").addEventListener("click", (e) => {
    const row = e.target.closest("[data-pick-emp]");
    if (!row) return;
    closeRolesFinder();
    addRole(row.dataset.pickEmp, row.dataset.name);
  });
  $("#rolesList").addEventListener("click", (e) => {
    const row = e.target.closest("[data-role-emp]");
    if (row) editRole(row.dataset.roleEmp);
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
  $("#mg-add").onclick = async () => {
    await goAdmin();
    await openEmpForm();
  };
  $("#mg-close").onclick = closeWindow;
  $("#mg-massage").onclick = () => openMassageAdmin("1");
  $("#mg-report").onclick = openReportAdmin;
  $("#mg-menu").onclick = goMenuCheck;
  $("#al-close").onclick = closeWindow;
  $("#menu-back").onclick = () => { setTab("me"); show("s-manage"); };
  $("#menu-body").addEventListener("click", (e) => {
    const cp = e.target.closest("[data-copy]");
    if (cp) return copyText(cp.dataset.copy, cp);
    if (e.target.closest("#menu-apply")) applyRichMenus();
    if (e.target.closest("#menu-apply-one")) openMenuEmpFinder("apply");
    if (e.target.closest("#menu-unlink")) openMenuEmpFinder("unlink");
    if (e.target.closest("#menu-cleardef")) clearDefaultMenu();
  });
  $("#menu-body").addEventListener("input", (e) => {
    if (e.target.id !== "menu-find") return;
    const q = e.target.value.trim().toLowerCase();
    $$("#menu-list .irow").forEach((row) => {
      row.style.display = !q || row.dataset.find.includes(q) ? "" : "none";
    });
  });
  // กล่องเลือกกว้างจำกัด รหัสยาว 42 ตัวจึงถูกตัดทิ้งเสมอไม่ว่าจะเขียนยังไง
  // โชว์รหัสเต็มของใบที่เลือกอยู่ไว้ใต้กล่อง เพื่อให้ตรวจได้ก่อนกดว่าเลือกถูกใบจริง
  $("#menu-emp-cancel").onclick = () => { $("#menu-find-emp").style.display = "none"; };
  $("#menu-emp-q").oninput = debounce(() => searchMenuUnlinkTarget($("#menu-emp-q").value), 300);
  $("#menu-emp-hits").addEventListener("click", (e) => {
    const row = e.target.closest("[data-unlink-emp]");
    if (row) menuActFor(row.dataset.unlinkEmp, row.dataset.name);
  });
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
