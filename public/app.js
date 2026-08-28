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

let idToken = null;
let masters = null;
let session = null;
let picked = null; // ปุ่มหมวดที่เลือก
let pendingFiles = []; // ไฟล์แนบที่บีบอัดแล้ว { base64, type }
let queueDept = null; // ฝ่ายที่กำลังดูในหน้าคิวงาน (รหัสฝ่าย)
let queueRows = []; // รายการคิวรอบล่าสุด — ปุ่มบนการ์ดต้องใช้ข้อมูลของเรื่อง ไม่ใช่แค่รหัส
let queueFilter = ""; // ตัวกรองคิวงาน: "" | "pending" | "me"
let detailReturnTab = "mine"; // แท็บที่จะกลับไปหลังปิดหน้ารายละเอียด
let sheetPick = null; // ตัวรับค่าเมื่อเลือกจาก bottom sheet
let deepLink = null; // เรื่องที่ถูกกดมาจากปุ่มบนการ์ดในไลน์ { ticket, todo }
let assessCtx = null; // เรื่องที่กำลังแจ้งผลตรวจสอบอยู่ { t, thenComplete }
let dueKey = null; // กรอบเวลาที่เลือกไว้ในหน้าแจ้งผล
let reportDept = ""; // ฝ่ายที่กำลังดูรายงาน (รหัสฝ่าย · ว่าง = ทุกฝ่ายที่มีสิทธิ์รวมกัน)
let reportPeriod = { period: "all", offset: 0 }; // ค่าเริ่มต้น: ทั้งหมด — ภาพรวมมาก่อน แล้วค่อยเจาะเป็นสัปดาห์/เดือน
let reportData = null; // ผลรอบล่าสุด ใช้ตอนกดปุ่มเปิด/คัดลอกลิงก์
let rateCtx = null; // เรื่องที่กำลังให้คะแนนอยู่
let rateStars = 0; // จำนวนดาวที่เลือกไว้
let rateNote = ""; // คำชมหรือสิ่งที่ควรปรับปรุงที่เลือกไว้
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
    // ตั๋วหมดอายุตั้งแต่ยังไม่ได้ส่ง — ขอใบใหม่เลย ดีกว่าปล่อยให้ไปโดนปฏิเสธที่ปลายทาง
    if (!idTokenUsable(idToken) && restartLineLogin()) return;
    // ยิงข้อมูลตั้งต้น (หมวด/ฝ่าย/ชั้น) คู่ขนานไปกับการขอ session — ทั้งคู่ต้องใช้ token
    // จึงเริ่มได้ทันทีที่ได้ token ไม่ต้องรอให้ session เสร็จก่อน
    mastersPromise = api("/api/masters").catch(() => null);
    deepLink = readDeepLink();
    session = await api("/api/auth/session", { method: "POST" });
    try { sessionStorage.removeItem(LOGIN_RETRY_KEY); } catch { /* noop */ }
    routeBySession();
  } catch (e) {
    if (recoverFromStaleLogin(e)) return;
    $("#err-msg").textContent = e.message || String(e);
    show("s-error");
  }
}

/** คืนข้อมูลตั้งต้น (หมวด/ฝ่าย/ชั้น/ความเร่งด่วน) — ใช้ผลที่ยิงคู่ขนานไว้ตอน boot() ถ้ามี */
async function getMasters() {
  if (!masters) masters = (await mastersPromise) || (await api("/api/masters"));
  return masters;
}

/**
 * เรื่องที่ถูกกดมาจากปุ่มบนการ์ดในไลน์
 *
 * ปุ่มบนการ์ดเป็นลิงก์ liff.line.me/<id>?ticket=...&do=... ไลน์ส่งพารามิเตอร์ต่อมาที่หน้านี้ตรง ๆ
 * ยกเว้นบางเส้นทางที่ห่อไว้ใน liff.state อีกชั้น จึงต้องรองรับทั้งสองแบบ ไม่งั้นกดจากบางที่แล้วเปิดมาเจอ
 * หน้าแรกเปล่า ๆ เหมือนปุ่มเสีย
 */
function readDeepLink() {
  const direct = new URLSearchParams(location.search);
  const state = direct.get("liff.state");
  const p = state ? new URLSearchParams(state.startsWith("?") ? state.slice(1) : state) : direct;
  const ticket = (p.get("ticket") || "").trim();
  if (!ticket) return null;
  return { ticket, todo: (p.get("do") || "").trim() };
}

/**
 * เปิดหน้าที่ตรงกับปุ่มที่กดมา
 *
 * ปุ่มในกลุ่มไลน์ซ่อนรายคนไม่ได้ ทุกคนในกลุ่มจึงกดได้ — คนที่ไม่ใช่เจ้าหน้าที่ของฝ่ายจะได้หน้ารายละเอียด
 * แบบดูอย่างเดียว ไม่ใช่ข้อความว่าไม่มีสิทธิ์ เพราะการเปิดดูสถานะเรื่องไม่ใช่เรื่องต้องห้าม
 */
async function openDeepLink(link) {
  let t;
  try {
    t = await api(`/api/tickets/${encodeURIComponent(link.ticket)}`);
  } catch (e) {
    toast(e.message);
    return goForm();
  }
  // ให้คะแนนเป็นสิทธิ์ของผู้แจ้ง ไม่ใช่เจ้าหน้าที่ จึงตรวจแยกจาก can_act
  if (link.todo === "rate") {
    if (t.can_rate) return openRate(t);
    if (t.rating) {
      toast("เรื่องนี้ให้คะแนนไปแล้ว ขอบคุณครับ");
      return showDetail(t, "mine");
    }
  }
  const live = t.can_act && t.status === "in_progress";
  if (live && link.todo === "assess") return openAssess(t, false);
  if (live && link.todo === "progress") return openProgress(t);
  if (live && link.todo === "complete") {
    if (!t.assessment) return openAssess(t, true);
    return completeTicket(t);
  }
  showDetail(t, "mine");
}

function routeBySession() {
  if (session.suspended) return show("s-suspended");
  if (!session.linked) return showRegister();
  enterApp();
}

/* ---------- ยังไม่ได้ลงทะเบียน ---------- */
/**
 * หน้าลงทะเบียนไม่ได้อยู่ในระบบนี้แล้ว — ย้ายไปเป็นระบบกลางของบริษัท
 *
 * พนักงานลงทะเบียนที่นั่นครั้งเดียวแล้วใช้ได้ทุกระบบ (แจ้งปัญหา · จองคิวนวด · ระบบอื่นที่จะมาต่อ)
 * เพราะทุกระบบอยู่บน LINE OA เดียวกันจึงเป็น userId เดียวกัน และอ่านการผูกบัญชีแถวเดียวกัน
 * ระบบนี้จึงมีหน้าที่แค่พาไปให้ถูกที่ ไม่ต้องมีฟอร์มกรอกรหัสพนักงานซ้ำอีกชุด
 */
function showRegister() {
  $("#appbar").style.display = "none";
  $("#tabbar").style.display = "none";
  show("s-register");
  // ยังไม่ได้ตั้งค่าปลายทาง — บอกให้ชัดว่าติดที่ตั้งค่า ไม่ใช่กดแล้วเงียบเหมือนปุ่มเสีย
  const ready = Boolean(CFG.coreLiffId) && !CFG.coreLiffId.includes("ตั้งค่า");
  $("#btn-go-core").style.display = ready ? "" : "none";
  $("#core-missing").style.display = ready ? "none" : "";
}

/**
 * เปิดหน้าลงทะเบียนของระบบกลาง — เป็น LIFF คนละตัว จึงเปิดด้วยลิงก์ liff.line.me
 *
 * แนบรหัส LIFF ของตัวเองไปกับ back= ด้วย ระบบกลางจะได้พากลับมาที่นี่ให้อัตโนมัติหลังลงทะเบียนเสร็จ
 * ไม่ใช่ปล่อยให้ผู้ใช้ค้างอยู่ที่นั่นแล้วต้องหาทางกลับเอง
 */
function goCoreRegister() {
  const url = `https://liff.line.me/${CFG.coreLiffId}?back=${encodeURIComponent(CFG.liffId || "")}`;
  if (window.liff && liff.openWindow) liff.openWindow({ url, external: false });
  else window.location.href = url;
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
  // สรุปงานเป็นเอกสารของฝ่ายบริหาร (มีตารางผลงานรายบุคคล) จึงเปิดให้หัวหน้าฝ่ายกับผู้ดูแลเท่านั้น
  if (session.is_admin || (session.dept_roles || []).some((r) => r.role === "head")) {
    $('.tabbar button[data-tab="report"]').style.display = "";
  }
  // กดปุ่มมาจากการ์ดในไลน์ — ไปที่เรื่องนั้นเลย ไม่ต้องให้เลื่อนหาเองในรายการ
  const link = deepLink;
  deepLink = null;
  if (link) return openDeepLink(link);
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
  // ส่วนงานที่ปิดแล้วยังไม่ได้ให้คะแนน ขึ้นปุ่มให้กดย้อนหลังได้ เผื่อเลื่อนการ์ดในไลน์ผ่านไปแล้ว
  const cancelBtn =
    t.status === "pending"
      ? '<div class="actions"><button data-act="cancel">ยกเลิกเรื่อง</button></div>'
      : t.can_rate
        ? '<div class="actions"><button class="fill" data-act="rate">ให้คะแนนการทำงาน</button></div>'
        : "";
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
  assessCtx = null; // ออกจากหน้าแจ้งผลด้วยการกดแท็บ ก็ถือว่าเลิกกรอก
  rateCtx = null;
  if (tab === "form") goForm();
  else if (tab === "mine") goMine();
  else if (tab === "queue") goQueue();
  else if (tab === "report") goReport();
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

const QUEUE_EMPTY = {
  "": "ไม่มีรายการ",
  pending: "ไม่มีเรื่องที่รอรับ",
  me: "ไม่มีงานที่ค้างอยู่",
  done: "ยังไม่มีงานที่จบ",
};

async function goQueue() {
  setTab("queue");
  show("s-queue");
  const list = $("#queueList");
  list.innerHTML = '<div class="empty">กำลังโหลดข้อมูล…</div>';
  const params = new URLSearchParams();
  if (queueDept) params.set("dept", queueDept);
  if (queueFilter === "pending") params.set("status", "pending");
  // งานของตัวเองแยกเป็นสองหน้า: ที่ยังต้องทำ กับที่จบไปแล้ว — งานที่ปิดแล้วเป็นประวัติ
  // ไม่ควรมาปนกับรายการที่ใช้ไล่ดูว่าเหลืออะไรต้องทำ
  if (queueFilter === "me") {
    params.set("assignee", "me");
    params.set("group", "active");
  }
  if (queueFilter === "done") {
    params.set("assignee", "me");
    params.set("group", "done");
  }
  try {
    const r = await api("/api/tickets/department?" + params.toString());
    if (!r.tickets.length) {
      list.innerHTML = `<div class="empty">${QUEUE_EMPTY[queueFilter] || "ไม่มีรายการ"}</div>`;
      return;
    }
    queueRows = r.tickets;
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
    // งานที่ยังไม่แจ้งผลคือสิ่งที่ค้างอยู่จริง เอาปุ่มนั้นขึ้นก่อน แล้วปุ่มปิดงานค่อยเป็นรอง
    actions = t.assessed
      ? '<button class="fill" data-act="complete">แล้วเสร็จ</button><button data-act="progress">อัปเดต</button><button data-act="transfer">ส่งต่อฝ่าย</button>'
      : '<button class="fill" data-act="assess">แจ้งผลตรวจสอบ</button><button data-act="complete">แล้วเสร็จ</button><button data-act="transfer">ส่งต่อฝ่าย</button>';
  } else if (t.status === "completed") {
    actions = ""; // ดำเนินการเสร็จสิ้นคือจุดจบของงานแล้ว ไม่มีขั้นปิดเรื่องต่อ
  }
  const tag = t.urgency === "critical" ? " · เร่งด่วนมาก" : t.urgency === "urgent" ? " · เร่งด่วน" : "";
  const when = [t.due_label, t.due_date_label].filter(Boolean).join(" · ");
  // งานที่จบแล้วสนใจว่าจบเมื่อไหร่ ส่วนงานที่ยังทำอยู่สนใจว่าจะเสร็จเมื่อไหร่
  const due = t.finished_date_label
    ? `<div class="meta">${t.status === "cancelled" ? "ยกเลิกเมื่อ" : "จบเมื่อ"} ${esc(t.finished_date_label)}</div>`
    : when
      ? `<div class="meta" style="color:var(--green-deep);font-weight:600">${t.waiting_parts ? "รออะไหล่ ถึง" : "คาดว่าเสร็จ"} ${esc(when)}</div>`
      : "";
  return `<div class="card clickable" data-id="${t.id}" data-dept="${esc(deptCode || "")}">
    <div class="cardtop">
      <div>
        <div class="tid">${esc(t.ticket_no)}${tag}</div>
        <div class="ttl">${esc(t.detail)}</div>
        <div class="meta">${esc(t.reporter_name)}${t.reporter_dept ? " · " + esc(t.reporter_dept) : ""} · ${esc(t.floor)}${t.location_note ? " · " + esc(t.location_note) : ""}</div>
        ${due}
      </div>
      <span class="pill ${PILL[t.status] || "p-closed"}">${esc(t.status_label)}</span>
    </div>
    ${actions ? `<div class="actions">${actions}</div>` : ""}
  </div>`;
}

/** เรื่องในคิวรอบล่าสุดจากรหัส — ปุ่มแจ้งผล/ปิดงานต้องใช้เลขที่และรายละเอียดไปขึ้นหัวหน้าจอ */
function queueTicket(id) {
  return queueRows.find((t) => t.id === id) || { id };
}

async function doStatus(id, to, okMsg, note) {
  try {
    await api(`/api/tickets/${id}/status`, { method: "PATCH", body: { to_status: to, note } });
    toast(okMsg || "อัปเดตสถานะเรียบร้อยแล้ว");
    routeTab("queue");
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
    routeTab("queue");
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- ให้คะแนนการทำงาน (ผู้แจ้ง) ---------- */

/**
 * เปิดจากปุ่มบนการ์ดที่ส่งให้ผู้แจ้งหลังปิดงาน
 *
 * ทำในแอปไม่ใช่บนการ์ด เพราะการ์ดถาม-ตอบต้องส่งใบใหม่ทุกครั้งที่ตอบ และบนการ์ดใส่ดาว
 * กับชิปพร้อมกันไม่ไหว ในหน้าเดียวของแอปเห็นทุกอย่างพร้อมกันและกดจบในครั้งเดียว
 */
function openRate(t) {
  rateCtx = t;
  rateStars = 0;
  rateNote = "";
  show("s-rate");
  $("#backbtn").style.display = "block";
  $("#rt-head").innerHTML = `<div class="tid">${esc(t.ticket_no)}</div>
    <div class="ttl">${esc(t.detail)}</div>
    <div class="meta">${esc(t.floor)}${t.location_note ? " · " + esc(t.location_note) : ""}${
      t.assignee_name ? " · ผู้ดูแล " + esc(t.assignee_name) : ""
    }</div>`;
  renderStars();
  syncRateChips();
}

function renderStars() {
  $("#rt-stars").innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<button type="button" data-star="${n}" class="${n <= rateStars ? "on" : ""}" aria-label="${n} ดาว">★</button>`)
    .join("");
  const labels = (masters && masters.rating_labels) || {};
  $("#rt-word").textContent = rateStars ? labels[rateStars] || "" : "";
}

/** ชิปเปลี่ยนชุดตามคะแนน — พอใจได้ชิปคำชม ไม่พอใจได้ชิปสิ่งที่ควรปรับปรุง */
function syncRateChips() {
  const block = $("#rt-chipblock");
  if (!rateStars) {
    block.style.display = "none";
    return;
  }
  const good = rateStars >= 4;
  const list = (masters && (good ? masters.praise_chips : masters.improve_chips)) || [];
  block.style.display = "";
  $("#rt-chiplabel").innerHTML = good
    ? 'อยากชมเรื่องอะไรเป็นพิเศษ <span class="hint">(เลือกได้ 1 ข้อ)</span>'
    : 'ควรปรับปรุงเรื่องอะไร <span class="hint">(เลือกได้ 1 ข้อ)</span>';
  // บอกตรง ๆ ว่าจะไปโผล่ที่ไหน ก่อนกดส่ง ไม่ใช่รู้ทีหลังตอนเห็นในกลุ่มแล้ว
  $("#rt-chiptip").textContent = good
    ? "คะแนนและคำชมจะถูกส่งเข้ากลุ่มให้ทีมงานเห็นด้วย"
    : "คะแนนและความเห็นจะถูกส่งเข้ากลุ่มให้ทีมงานรับทราบ";
  $("#rt-chips").innerHTML = list
    .map((c) => `<button data-note="${esc(c)}" aria-pressed="${c === rateNote}">${esc(c)}</button>`)
    .join("");
}

async function saveRate() {
  if (!rateCtx) return;
  if (!rateStars) return toast("กรุณาเลือกจำนวนดาว");
  const btn = $("#rt-save");
  btn.disabled = true;
  try {
    const r = await api(`/api/tickets/${rateCtx.id}/rate`, {
      method: "POST",
      body: { rating: rateStars, note: rateNote || undefined },
    });
    toast(r.shared ? "ขอบคุณครับ ส่งผลประเมินเข้ากลุ่มแล้ว" : "ขอบคุณสำหรับคะแนนครับ");
    rateCtx = null;
    routeTab("mine");
  } catch (e) {
    if (e.code === "already_rated") {
      toast("เรื่องนี้ให้คะแนนไปแล้ว");
      rateCtx = null;
      return routeTab("mine");
    }
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- สรุปงาน (หัวหน้าฝ่าย / ผู้ดูแล) ---------- */

/**
 * หน้านี้เป็นแค่หน้าปกของรายงาน — ตัวเลขหลักไม่กี่ตัวให้ดูจากมือถือได้ทันที
 * ส่วนรายงานฉบับเต็ม (รายชื่องานค้าง ผลงานรายบุคคล กราฟ) อยู่ในไฟล์ที่เปิดจากปุ่มด้านล่าง
 * เพราะตารางยาว ๆ อ่านบนจอมือถือไม่ไหว และปลายทางจริงคือเอาไปเสนอผู้บริหาร
 */
async function goReport() {
  setTab("report");
  show("s-report");
  const body = $("#rp-body");
  body.innerHTML = '<div class="empty">กำลังสรุปข้อมูล…</div>';
  const params = new URLSearchParams({ period: reportPeriod.period, offset: String(reportPeriod.offset) });
  if (reportDept) params.set("dept", reportDept);
  try {
    reportData = await api("/api/reports/summary?" + params.toString());
    reportDept = reportData.department_code;
    renderReportFilters();
    body.innerHTML = renderReportBody(reportData);
  } catch (e) {
    $("#rp-depts").innerHTML = "";
    $("#rp-periods").innerHTML = "";
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderReportFilters() {
  const depts = reportData.departments || [];
  const dw = $("#rp-depts");
  // ฝ่ายเดียวไม่ต้องขึ้นชิปให้เลือก เพราะไม่มีอะไรให้สลับ
  dw.style.display = depts.length > 1 ? "flex" : "none";
  dw.innerHTML = depts
    .map((d) => `<button class="chip" data-rd="${esc(d.code)}" aria-pressed="${d.code === reportDept}">${esc(d.name)}</button>`)
    .join("");
  $("#rp-periods").innerHTML = (reportData.period_options || [])
    .map((o) => {
      const on = o.period === reportPeriod.period && o.offset === reportPeriod.offset;
      return `<button class="chip" data-rp="${esc(o.period)}:${o.offset}" aria-pressed="${on}">${esc(o.label)}</button>`;
    })
    .join("");
}

function rtile(value, label, note, tone) {
  return `<div class="rt ${tone || ""}"><div class="l">${esc(label)}</div><div class="v">${esc(value)}</div>${
    note ? `<div class="n ${tone || ""}">${esc(note)}</div>` : ""
  }</div>`;
}

/**
 * ตัวเลขสี่ตัวที่บอกภาพรวมได้ครบ — เข้ามาเท่าไหร่ ปิดไปเท่าไหร่ เหลือเท่าไหร่ และเลยกำหนดเท่าไหร่
 * รายชื่องานทั้งหมดอยู่ในรายงานฉบับเต็ม เพราะตารางยาว ๆ อ่านบนจอมือถือไม่ไหว
 */
function renderReportBody(r) {
  const open = r.now.pending + r.now.in_progress;
  return `
    <div class="rtiles">
      ${rtile(r.flow.created, "แจ้งเข้ามาในช่วงนี้", r.flow.cancelled ? `ยกเลิก ${r.flow.cancelled} เรื่อง` : "")}
      ${rtile(r.flow.completed, "ปิดจบไปแล้ว", r.flow.created ? Math.round((r.flow.completed / r.flow.created) * 100) + "% ของที่แจ้งเข้ามา" : "", "good")}
      ${rtile(open, "ยังค้างอยู่ตอนนี้", r.now.pending ? `ยังไม่มีผู้รับ ${r.now.pending} เรื่อง` : "มีผู้รับผิดชอบครบแล้ว", r.now.pending ? "bad" : "good")}
      ${rtile(r.now.overdue, "เลยกำหนดที่แจ้งไว้", r.now.overdue ? "ต้องตามด่วน" : "ไม่มีงานเลยกำหนด", r.now.overdue ? "bad" : "good")}
    </div>

    <button class="send" id="rp-open">เปิดรายงานฉบับเต็ม</button>
    <button class="ghost" id="rp-copy">คัดลอกลิงก์รายงาน</button>
    <p class="tip">รายงานฉบับเต็มมีรายชื่องานทุกเรื่องพร้อมสถานะ ปุ่มบันทึกเป็น PDF และปุ่มส่งออก CSV
      ลิงก์เปิดได้โดยไม่ต้องล็อกอิน ส่งต่อได้เลย และหมดอายุใน 14 วัน</p>`;
}

/** เปิดรายงานในเบราว์เซอร์ของเครื่อง ไม่ใช่ในหน้าต่างของไลน์ — จะได้สั่งพิมพ์และแชร์ต่อได้ */
function openReport() {
  if (!reportData) return;
  if (window.liff && liff.openWindow) liff.openWindow({ url: reportData.share_url, external: true });
  else window.open(reportData.share_url, "_blank");
}

async function copyReportLink() {
  if (!reportData) return;
  try {
    await navigator.clipboard.writeText(reportData.share_url);
    toast("คัดลอกลิงก์แล้ว นำไปวางในอีเมลหรือแชทได้เลย");
  } catch {
    // เบราว์เซอร์ในไลน์บางเวอร์ชันไม่ให้เขียนคลิปบอร์ด — แสดงลิงก์ให้กดค้างคัดลอกเองแทน
    openModal({
      title: "ลิงก์รายงาน",
      message: reportData.share_url,
      note: "กดค้างที่ลิงก์เพื่อคัดลอก",
      confirmLabel: "ปิด",
      cancelLabel: "ยกเลิก",
    });
  }
}


/** เติมตัวเลือกลงในรายการเลือก พร้อมตัวเลือก "อื่น ๆ" ท้ายสุดถ้ามี */
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

/* ---------- detail ---------- */
let detailTicket = null; // เรื่องที่กำลังเปิดอยู่ ใช้ตอนกดปุ่มดำเนินการบนหน้านี้

async function openDetail(id, fromTab) {
  detailReturnTab = fromTab || "mine";
  show("s-detail");
  $("#backbtn").style.display = "block";
  const body = $("#detailBody");
  body.innerHTML = '<div class="empty">กำลังโหลดข้อมูล…</div>';
  try {
    showDetail(await api(`/api/tickets/${id}`), detailReturnTab);
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

/** แสดงเรื่องที่โหลดมาแล้ว — ใช้ตอนเปิดจากลิงก์ในไลน์ซึ่งอ่านข้อมูลไปก่อนแล้ว ไม่ต้องยิงซ้ำ */
function showDetail(t, fromTab) {
  detailTicket = t;
  detailReturnTab = fromTab || "mine";
  show("s-detail");
  $("#backbtn").style.display = "block";
  $("#detailBody").innerHTML = renderDetail(t);
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
    ${detailActions(t)}
  </div>`;
}

/**
 * ปุ่มดำเนินการบนหน้ารายละเอียด
 *
 * นี่คือปลายทางของปุ่มบนการ์ดในไลน์ ถ้าหน้านี้ไม่มีปุ่มให้กดต่อ คนที่กดมาจะเจอทางตัน
 * ผู้แจ้ง (ไม่ใช่เจ้าหน้าที่ฝ่าย) ไม่มีปุ่มชุดนี้ เพราะหน้านี้ของเขาคือหน้าติดตามสถานะ
 */
function detailActions(t) {
  // ผู้แจ้งไม่มีปุ่มของเจ้าหน้าที่ แต่มีปุ่มให้คะแนนของตัวเอง
  if (t.can_rate) return '<div class="actions"><button class="fill" data-d="rate">ให้คะแนนการทำงาน</button></div>';
  if (!t.can_act) return "";
  if (t.status === "pending") {
    return '<div class="actions"><button class="fill" data-d="claim">รับเรื่อง</button>' +
      '<button data-d="transfer">ส่งต่อฝ่าย</button></div>';
  }
  if (t.status !== "in_progress") return "";
  // สองแถว — คำบนปุ่มของหน้านี้ยาวกว่าหน้าคิวงาน เพราะต้องตรงกับปุ่มที่เพิ่งกดมาจากการ์ดในไลน์
  // ยัดสามปุ่มแถวเดียวแล้วคำจะขึ้นบรรทัดใหม่กลางปุ่มจนอ่านสะดุด
  const first = t.assessment
    ? '<button class="fill" data-d="complete">ดำเนินการเสร็จสิ้น</button><button data-d="progress">อัปเดตความคืบหน้า</button>'
    : '<button class="fill" data-d="assess">แจ้งผลตรวจสอบ</button><button data-d="complete">ดำเนินการเสร็จสิ้น</button>';
  return `<div class="actions">${first}</div>
    <div class="actions"><button data-d="transfer">ส่งต่อฝ่ายอื่น</button></div>`;
}

/* ---------- แจ้งผลตรวจสอบ ---------- */

/**
 * หน้าแจ้งผลตรวจสอบ — อาการที่พบ + กรอบเวลาที่คาดว่าจะเสร็จ
 *
 * thenComplete = มาจากปุ่ม "ดำเนินการเสร็จสิ้น" ของเรื่องที่ยังไม่เคยแจ้งผล ระบบพามากรอกก่อน
 * แล้วบันทึกกับปิดงานให้ในครั้งเดียว จะได้ไม่ต้องกดสองรอบ
 */
function openAssess(t, thenComplete) {
  assessCtx = { t, thenComplete: !!thenComplete };
  dueKey = null;
  show("s-assess");
  $("#backbtn").style.display = "block";
  $("#as-title").textContent = thenComplete ? "แจ้งผลก่อนปิดงาน" : "แจ้งผลตรวจสอบ";
  $("#as-head").innerHTML = `<div class="tid">${esc(t.ticket_no)}</div>
    <div class="ttl">${esc(t.detail)}</div>
    <div class="meta">${esc(t.floor)}${t.location_note ? " · " + esc(t.location_note) : ""}</div>`;
  $("#as-note").value = t.assessment && t.assessment.note ? t.assessment.note : "";
  $("#as-nonote").checked = false;
  $("#as-date").value = "";
  $("#as-save").textContent = thenComplete ? "บันทึกแล้วปิดงาน" : "บันทึกผลตรวจสอบ";
  renderDueChips();
  syncDueExtras();
}

function dueOptions() {
  return (masters && masters.due_options) || [];
}

function renderDueChips() {
  $("#as-due").innerHTML = dueOptions()
    .map(
      (o) =>
        `<button data-due="${esc(o.key)}" data-special="${esc(o.special || "")}" aria-pressed="${o.key === dueKey}">${esc(o.chip)}</button>`,
    )
    .join("");
}

/** ตัวเลือกที่ต้องระบุวันเอง (เลือกวันเอง / รออะไหล่) จะเผยช่องวันที่กับคำอธิบายเพิ่ม */
function syncDueExtras() {
  const opt = dueOptions().find((o) => o.key === dueKey);
  const needDate = !!opt && (opt.special === "pick" || opt.special === "wait");
  const date = $("#as-date");
  date.style.display = needDate ? "" : "none";
  if (needDate && !date.min) date.min = new Date().toISOString().slice(0, 10);
  const note = $("#as-duenote");
  if (opt && opt.special === "wait") {
    note.textContent = "งานรออะไหล่ต้องระบุวันที่ให้ชัดเจน ระบบจะถามความคืบหน้าทุก 7 วันจนกว่าจะดำเนินการต่อ";
    note.className = "duenote warn";
    note.style.display = "";
  } else if (needDate) {
    note.textContent = "เลือกวันที่คาดว่าจะแก้ไขเสร็จ ระบบนับถึงเวลา 18:00 ของวันนั้น";
    note.className = "duenote";
    note.style.display = "";
  } else {
    note.style.display = "none";
  }
}

async function saveAssess() {
  const ctx = assessCtx;
  if (!ctx) return;
  const opt = dueOptions().find((o) => o.key === dueKey);
  if (!opt) return toast("กรุณาเลือกกรอบเวลาที่คาดว่าจะเสร็จ");
  const needDate = opt.special === "pick" || opt.special === "wait";
  const dueDate = $("#as-date").value;
  if (needDate && !dueDate) return toast("กรุณาเลือกวันที่คาดว่าจะเสร็จ");

  const noNote = $("#as-nonote").checked;
  const note = $("#as-note").value.trim();
  if (!noNote && !note) return toast("กรุณาระบุอาการที่พบ หรือติ๊กว่าไม่มีคำอธิบายเพิ่มเติม");

  const btn = $("#as-save");
  btn.disabled = true;
  try {
    await api(`/api/tickets/${ctx.t.id}/assess`, {
      method: "POST",
      body: { due_key: dueKey, due_date: dueDate || undefined, note, no_note: noNote, then_complete: ctx.thenComplete },
    });
    toast(ctx.thenComplete ? "บันทึกและปิดงานเรียบร้อยแล้ว" : "แจ้งผลตรวจสอบเรียบร้อยแล้ว");
    assessCtx = null;
    backFromAssess();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

/**
 * ออกจากหน้าแจ้งผล — กลับไปหน้าคิวงานถ้ามีสิทธิ์ ไม่งั้นกลับหน้าแรก
 *
 * ผ่าน routeTab ไม่ใช่ goQueue ตรง ๆ เพื่อให้ปุ่มย้อนกลับหายไปและแท็บล่างสว่างให้ถูกอันด้วย
 * ไม่งั้นหน้าคิวงานจะมีลูกศรย้อนกลับค้างอยู่ทั้งที่ไม่ได้เปิดมาจากหน้าไหน
 */
function backFromAssess() {
  assessCtx = null;
  routeTab(activeDepts().length ? "queue" : "form");
}

async function openProgress(t) {
  const note = await promptDialog({
    title: "อัปเดตความคืบหน้า",
    message: `${t.ticket_no} · ระบบจะแจ้งผู้แจ้งให้ทราบด้วย`,
    placeholder: "เช่น ถอดล้างคอยล์แล้ว รอทดสอบพรุ่งนี้เช้า",
    confirmLabel: "ส่งอัปเดต",
    cancelLabel: "ไม่ใช่",
  });
  if (note === null) return;
  if (!note) return toast("กรุณาระบุความคืบหน้า");
  try {
    await api(`/api/tickets/${t.id}/progress`, { method: "POST", body: { note } });
    toast("ส่งอัปเดตเรียบร้อยแล้ว");
    if (activeDepts().length) routeTab("queue");
  } catch (e) {
    toast(e.message);
  }
}

/**
 * ปิดงาน — เรื่องที่ยังไม่เคยแจ้งผลตรวจสอบจะถูกพาไปกรอกก่อนแล้วปิดให้ในคราวเดียว
 * (เซิร์ฟเวอร์ตอบรหัส need_assessment มาบอก) เรื่องที่เปิดแล้วปิดโดยไม่มีใครรู้ว่าเกิดอะไรขึ้น
 * คือช่องโหว่ที่ตั้งใจอุด
 */
async function completeTicket(t) {
  try {
    await api(`/api/tickets/${t.id}/status`, { method: "PATCH", body: { to_status: "completed" } });
    toast("ปรับสถานะเป็นดำเนินการแล้วเสร็จ");
    if (activeDepts().length) routeTab("queue");
    else routeTab("mine");
  } catch (e) {
    if (e.code === "need_assessment") return openAssess(t, true);
    toast(e.message);
  }
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
  $("#btn-go-core").onclick = goCoreRegister;
  $("#sendBtn").onclick = submitTicket;

  // เลือก "ชั้นอื่น" แล้วค่อยเผยช่องให้พิมพ์ — ไม่งั้นฟอร์มจะรกด้วยช่องที่แทบไม่ได้ใช้
  $("#floor").onchange = () => revealOther($("#floor"), $("#floorOther"));
  $("#file").onchange = (e) => onPickFiles(e.target);
  $$(".tabbar button").forEach((b) => (b.onclick = () => routeTab(b.dataset.tab)));

  // ปุ่มย้อนกลับจากหน้ารายละเอียดและหน้าแจ้งผล
  $("#backbtn").onclick = () => {
    if (assessCtx) return backFromAssess();
    if (rateCtx) {
      rateCtx = null;
      return routeTab("mine");
    }
    routeTab(detailReturnTab);
  };

  // หน้า "เรื่องที่แจ้ง": ปุ่มยกเลิก + แตะการ์ดเพื่อดูรายละเอียด
  $("#mineList").addEventListener("click", async (e) => {
    const card = e.target.closest(".card[data-id]");
    if (!card) return;
    const btn = e.target.closest("button[data-act]");
    if (btn && btn.dataset.act === "rate") {
      e.stopPropagation();
      try {
        openRate(await api(`/api/tickets/${card.dataset.id}`));
      } catch (err) {
        toast(err.message);
      }
      return;
    }
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
      else if (act === "complete") completeTicket(queueTicket(id));
      else if (act === "assess") openAssess(queueTicket(id), false);
      else if (act === "progress") openProgress(queueTicket(id));
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

  // ให้คะแนน: แตะดาว เลือกชิป และส่ง
  $("#rt-stars").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-star]");
    if (!b) return;
    const n = Number(b.dataset.star);
    // แตะดาวดวงเดิมซ้ำ = ยกเลิกคะแนน เผื่อกดพลาด
    rateStars = rateStars === n ? 0 : n;
    // เปลี่ยนคะแนนข้ามฝั่งพอใจ/ไม่พอใจ ชิปที่เลือกไว้ใช้ไม่ได้แล้ว
    rateNote = "";
    renderStars();
    syncRateChips();
  });
  $("#rt-chips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-note]");
    if (!b) return;
    rateNote = rateNote === b.dataset.note ? "" : b.dataset.note;
    $$("#rt-chips button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.note === rateNote)));
  });
  $("#rt-save").onclick = saveRate;
  $("#rt-cancel").onclick = () => {
    rateCtx = null;
    routeTab("mine");
  };

  // สรุปงาน: เลือกฝ่าย เลือกช่วงเวลา และปุ่มเปิด/คัดลอกลิงก์
  $("#rp-depts").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rd]");
    if (!b) return;
    reportDept = b.dataset.rd;
    goReport();
  });
  $("#rp-periods").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rp]");
    if (!b) return;
    const [period, offset] = b.dataset.rp.split(":");
    reportPeriod = { period, offset: Number(offset) };
    goReport();
  });
  $("#rp-body").addEventListener("click", (e) => {
    if (e.target.closest("#rp-open")) openReport();
    else if (e.target.closest("#rp-copy")) copyReportLink();
  });


  // หน้าแจ้งผลตรวจสอบ
  $("#as-due").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-due]");
    if (!b) return;
    dueKey = b.dataset.due;
    $$("#as-due button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    syncDueExtras();
  });
  // ติ๊กว่าไม่มีคำอธิบาย = ปิดช่องพิมพ์ไปเลย จะได้ไม่มีทั้งติ๊กทั้งพิมพ์แล้วงงว่าอันไหนถูกบันทึก
  $("#as-nonote").onchange = () => {
    const off = $("#as-nonote").checked;
    const box = $("#as-note");
    box.disabled = off;
    box.style.opacity = off ? ".5" : "";
    if (off) box.value = "";
  };
  $("#as-save").onclick = saveAssess;
  $("#as-cancel").onclick = backFromAssess;

  // ปุ่มดำเนินการบนหน้ารายละเอียด (ปลายทางของปุ่มบนการ์ดในไลน์)
  $("#detailBody").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-d]");
    if (!b || !detailTicket) return;
    const t = detailTicket;
    if (b.dataset.d === "rate") openRate(t);
    else if (b.dataset.d === "assess") openAssess(t, false);
    else if (b.dataset.d === "progress") openProgress(t);
    else if (b.dataset.d === "complete") completeTicket(t);
    else if (b.dataset.d === "claim") doStatus(t.id, "in_progress", "รับเรื่องเรียบร้อยแล้ว");
    else if (b.dataset.d === "transfer") openTransferSheet(t.id, t.dept_code);
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
