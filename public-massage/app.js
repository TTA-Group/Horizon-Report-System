/* TTA Wellness — ระบบจองคิวนวด (LIFF frontend)
 *
 * ใช้ทะเบียนพนักงานที่ลงทะเบียนไว้แล้วผ่านระบบกลาง จึงไม่มีช่องให้กรอกชื่อ แผนก หรืออีเมล
 * ระบบเดิมให้กรอกใหม่ทุกครั้งแล้วนับสิทธิ์จากอีเมลที่พิมพ์เอง ซึ่งพิมพ์ของคนอื่นก็ได้
 *
 * กติกาทุกข้อบังคับที่เซิร์ฟเวอร์ หน้านี้ทำแค่ "ทำให้กดผิดยาก" — ช่องที่เต็มแล้วกดไม่ได้
 * ปุ่มยืนยันติดจนกว่าจะเลือกครบ ฯลฯ ไม่ใช่ที่กันจริง ถ้าใครข้ามหน้านี้ไปยิงตรง เซิร์ฟเวอร์ปฏิเสธเอง
 *
 * หน้าจองกับหน้าคิวของฉันแยกกันคนละหน้า ไม่เอามาต่อกันในหน้าเดียว เพราะสองเรื่องนี้
 * ตอบคนละคำถาม ("จะจองเมื่อไหร่" กับ "ตอนนี้ฉันมีคิวอะไรอยู่") เอามารวมกันแล้วหน้ายาว
 * และหลังจองเสร็จผู้ใช้ต้องการเห็นแค่ผลลัพธ์ ไม่ใช่ตารางจองที่เพิ่งใช้ไป
 */
const CFG = window.APP_CONFIG || {};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let idToken = null;
let session = null;
let state = null; // ผลจาก /api/massage/state
let currentDay = null;
let availability = null;
let pick = null; // { slot, slotLabel, therapistId, therapistName }
let sheet = null; // ฟอร์มเช็คชื่อที่กำลังเปิดอยู่ (ฝั่งผู้ดูแล)
let sheetOptions = [];
let downloadPath = null;

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
    if (data.code === "not_linked") return accessLost("not_linked");
    if (data.code === "suspended") return accessLost("suspended");
    // เซิร์ฟเวอร์ส่งสาเหตุจริงมาใน detail เฉพาะตอนพังแบบไม่คาดคิด (500) — เอามาต่อท้ายด้วย
    // ไม่งั้นหน้าจอขึ้นแค่ "internal error" ซึ่งไม่ช่วยอะไรเลยเวลาต้องไล่หาสาเหตุ
    const base = data.error || `เกิดข้อผิดพลาด (${res.status})`;
    const err = new Error(data.detail ? `${base} — ${data.detail}` : base);
    err.code = data.code;
    throw err;
  }
  return data;
}

/** สิทธิ์ถูกถอนระหว่างใช้งาน — พาไปหน้าที่ถูกต้องแทนที่จะปล่อยให้กดต่อแล้วเจอข้อความปฏิเสธซ้ำ ๆ */
function accessLost(code) {
  show(code === "suspended" ? "s-suspended" : "s-register");
  const e = new Error("access lost");
  e.handled = true;
  throw e;
}

/** ชิปสิทธิ์คงเหลือมีความหมายเฉพาะตอนจอง หน้าอื่นไม่ต้องโชว์ให้รก */
const QUOTA_SCREENS = new Set(["s-book", "s-mine"]);

function show(id) {
  $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  window.scrollTo(0, 0);
  $("#quota").style.display = QUOTA_SCREENS.has(id) && state ? "" : "none";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 3600);
}

/**
 * กล่องข้อความกลางจอ — เขียนเองแทน SweetAlert2 ที่ระบบเดิมดึงมาจาก CDN
 * คืน true เมื่อกดปุ่มยืนยัน · false เมื่อยกเลิกหรือแตะพื้นหลัง
 */
/** เงื่อนไขการใช้บริการ — ขึ้นในกล่องยืนยันตอนกดจอง เพราะเป็นวินาทีที่ต้องอ่านจริง ๆ */
/** เงื่อนไขของคิวด่วน — ต่างจากคิวปกติที่ข้อแรกเป็นข้อห้าม ไม่ใช่ข้อแนะนำ */
const FLASH_TERMS = [
  "กดแล้ว <b>ยกเลิกในระบบไม่ได้</b>",
  "หากมาไม่ได้ ต้องหาคนมาแทนเอง แล้วแจ้งฝ่ายบุคคลให้เปลี่ยนชื่อ",
  "เป็นคิวที่เหลือของวันนี้ ใครกดก่อนได้ก่อน",
];

const BOOKING_TERMS = [
  "จำกัดสิทธิ์ 2 ครั้ง / ท่าน / เดือน",
  "หากไม่สามารถมาใช้บริการได้ กรุณายกเลิกคิวล่วงหน้าอย่างน้อย 15 นาที",
  "กรณีไม่แสดงตนใช้บริการเกิน 10 นาที เจ้าหน้าที่จะทำการปล่อยคิวให้ท่านอื่นโดยที่ไม่ต้องแจ้งให้ทราบ",
];

/**
 * input: { placeholder, value } = มีช่องให้พิมพ์ในกล่อง แล้วคืนข้อความที่พิมพ์แทน true
 * ใช้ตอนถามเหตุผลที่ปิดวัน ซึ่งเหตุผลนั้นถูกส่งต่อไปในข้อความที่แจ้งพนักงานทุกคน
 * ถ้าไม่ถามตรงนี้ ผู้ดูแลต้องไปพิมพ์บอกทีละคนเองในไลน์
 */
function dialog({ icon = "warn", title, body = "", confirm = "ตกลง", cancel = null, danger = false, terms = false, input = null }) {
  return new Promise((resolve) => {
    $("#m-ic").className = `ic ${icon}`;
    $("#m-ic").textContent =
      icon === "ok" ? "✓" : icon === "err" ? "✕" : icon === "flash" ? "⚡" : "!";
    $("#m-title").textContent = title;
    const rules = terms === "flash" ? FLASH_TERMS : BOOKING_TERMS;
    $("#m-body").innerHTML =
      escapeHtml(body) +
      (terms
        ? `<ul class="terms${terms === "flash" ? " flash" : ""}">${rules
            .map((t) => `<li>${t}</li>`)
            .join("")}</ul>`
        : "") +
      (input
        ? `<div class="finder"><input id="m-input" type="text" maxlength="120"
             placeholder="${escapeHtml(input.placeholder || "")}" value="${escapeHtml(input.value || "")}" /></div>`
        : "");
    $("#m-body").style.display = body || terms || input ? "" : "none";

    const btns = $("#m-btns");
    btns.innerHTML = "";
    const done = (v) => {
      $("#backdrop").classList.remove("on");
      $("#backdrop").onclick = null;
      resolve(v);
    };
    if (cancel) {
      const no = document.createElement("button");
      no.className = "no";
      no.textContent = cancel;
      no.onclick = () => done(false);
      btns.appendChild(no);
    }
    const go = document.createElement("button");
    go.className = danger ? "go danger" : "go";
    go.textContent = confirm;
    go.onclick = () => done(input ? $("#m-input").value.trim() || true : true);
    btns.appendChild(go);

    $("#backdrop").classList.add("on");
    $("#backdrop").onclick = (e) => {
      if (e.target === $("#backdrop")) done(false);
    };
    if (input) setTimeout(() => $("#m-input").focus(), 50);
  });
}

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
    if (window.liff && liff.closeWindow) liff.closeWindow();
  } catch {
    /* noop */
  }
}

/* ---------- กู้สถานะล็อกอินที่ค้าง ---------- */

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
  const url = new URL(location.href);
  for (const k of ["code", "state", "error", "error_description", "liffClientId", "liffRedirectUri"]) {
    url.searchParams.delete(k);
  }
  location.replace(url.toString());
  return true;
}

/** พารามิเตอร์อาจถูกห่อมาใน liff.state เมื่อเปิดจากลิงก์ในแชท */
function params() {
  const direct = new URLSearchParams(location.search);
  const wrapped = direct.get("liff.state");
  if (!wrapped) return direct;
  return new URLSearchParams(wrapped.startsWith("?") ? wrapped.slice(1) : wrapped);
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
    session = await api("/api/auth/session", { method: "POST" });
    try {
      sessionStorage.removeItem(LOGIN_RETRY_KEY);
    } catch {
      /* noop */
    }

    if (!session.linked) return show("s-register");
    if (session.employee && session.employee.status === "suspended") return show("s-suspended");

    const p = params();
    const cancelId = (p.get("cancel") || "").trim();
    await loadState();
    if (cancelId) return openCancel(cancelId);
    // เปิดจากปุ่มในหน้าจัดการของระบบกลาง — admin=1 คือฟอร์มเช็คชื่อ (ลิงก์เดิม ห้ามเปลี่ยน)
    const adm = (p.get("admin") || "").trim();
    if (adm && state.canManage) {
      if (adm === "book") return goAbook();
      if (adm === "days") return goADays();
      return goAdmin();
    }
    route();
  } catch (e) {
    if (e && e.handled) return;
    if (recoverFromStaleLogin(e)) return;
    console.error(e);
    show("s-mine");
    $("#ok-badge").style.display = "none";
    $("#mine-title").textContent = "เปิดระบบไม่สำเร็จ";
    $("#mine-list").innerHTML = `<div class="empty">${escapeHtml(e.message || "")}</div>`;
    $("#btn-book-more").style.display = "none";
  }
}

async function loadState() {
  state = await api("/api/massage/state");
  renderHeader();
}

/**
 * หัวเรื่องอยู่นอกหน้าจอทั้งเจ็ดหน้า จึงต้องเติมค่าตรงนี้ที่เดียว
 * ไม่ใช่ให้แต่ละหน้าเติมเอง ไม่งั้นเข้าหน้าคิวของฉันตรง ๆ แล้วหัวเรื่องจะยังว่าง
 */
function renderHeader() {
  const emp = (session && session.employee) || {};
  if (emp.full_name) {
    $("#welcome").innerHTML =
      `${escapeHtml(emp.full_name)}<span>${escapeHtml(emp.department_name || "")}</span>`;
  }

  // สิทธิ์คงเหลือเป็นชิปเล็กข้างหัวเรื่อง ไม่ใช่แถบเต็มความกว้าง
  // ของที่ต้องรู้แค่ "เหลือกี่ครั้ง" ไม่ควรกินพื้นที่เท่ากับตารางที่ต้องอ่านทั้งวัน
  const left = Math.max(0, state.quota - state.used);
  const q = $("#quota");
  q.className = left === 0 ? "pill out" : "pill";
  q.innerHTML = left === 0
    ? `<span>สิทธิ์เดือนนี้</span><b>ใช้ครบแล้ว</b>`
    : `<span>สิทธิ์คงเหลือเดือนนี้</span><b>${left} / ${state.quota}</b>`;
}

const activeBookings = () => (state.mine || []).filter((b) => b.status === "booked");

/** เปิดแอปมาแล้วควรเห็นหน้าไหนก่อน */
function route() {
  if (!state.open) return renderClosed();
  // มีคิวอยู่แล้วมักเข้ามาเพื่อดูหรือยกเลิก ไม่ใช่เพื่อจองใหม่ จึงพาไปหน้าคิวของฉันก่อน
  if (activeBookings().length > 0) return goMine({ justBooked: false });
  goBook();
}

/* ---------- หน้าจอง ---------- */

/** มีวันไหนเข้าโหมดคิวด่วนและยังเหลือช่องอยู่ไหม */
const hasFlashDay = () => (state.days || []).some((d) => d.flash && d.free > 0);

function goBook() {
  const left = Math.max(0, state.quota - state.used);

  const mine = activeBookings();
  $("#btn-mine").style.display = mine.length ? "" : "none";
  $("#btn-mine").textContent = `ดูคิวของฉัน (${mine.length})`;

  // สิทธิ์หมดแล้วก็ยังเข้าหน้าจองได้ ถ้ามีคิวด่วนเปิดอยู่ — ไม่ยิงไลน์บอก
  // คนจะรู้ว่ามีของเหลือก็ต่อเมื่อเปิดแอปเจอเอง ถ้าเด้งออกตั้งแต่แรกก็ไม่มีทางเจอเลย
  if (left === 0 && !hasFlashDay()) return goMine({ justBooked: false });

  show("s-book");
  renderDays();
}

/** วันที่เราจองไว้แล้ว — เปิดดูได้ แต่จองซ้ำไม่ได้เพราะกติกาคือวันละหนึ่งคิว */
const isMyDay = (day) => activeBookings().some((b) => b.day === day);

function renderDays() {
  const booked = new Set(activeBookings().map((b) => b.day));
  const noQuota = state.used >= state.quota;

  $("#days").innerHTML = state.days
    .map((d) => {
      const mine = booked.has(d.day);
      const full = d.free === 0;
      const note = mine
        ? "จองแล้ว"
        : full
          ? "เต็มแล้ว"
          : d.flash
            ? `คิวด่วน · เหลือ ${d.free}`
            : noQuota
              ? "ใช้สิทธิ์ครบแล้ว"
              : `ว่าง ${d.free} คิว`;
      // ทุกวันกดเข้าไปดูตารางได้หมด ปิดแค่การจอง — พนักงานเปิดดูแทนเพื่อนกันว่าวันไหนเหลือรอบอะไร
      // ปิดจริงเฉพาะวันที่เต็มแล้ว เพราะไม่มีอะไรให้ดู
      const cls = d.flash ? " flash" : mine ? " mine" : "";
      return `<button class="day${cls}" data-day="${escapeHtml(d.day)}" aria-pressed="false"${
        full ? " disabled" : ""
      }>${d.flash ? "⚡ " : ""}${escapeHtml(d.chip)}<small>${note}</small></button>`;
    })
    .join("");

  const canBookDay = (d) => d.free > 0 && !booked.has(d.day) && (d.flash || !noQuota);
  const first = state.days.find(canBookDay) || state.days.find((d) => d.free > 0);
  if (first) selectDay(first.day);
  else {
    currentDay = null;
    $("#slots").innerHTML = `<div class="empty">ไม่มีวันที่จองได้เหลืออยู่<br>ลองดูใหม่เดือนหน้าได้เลย</div>`;
    $("#legend").style.display = "none";
    $("#viewnote").style.display = "none";
    clearPick();
  }
}

async function selectDay(day) {
  currentDay = day;
  clearPick();
  $$("#days .day").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.day === day)));
  $("#slots").innerHTML = `<div class="empty">กำลังตรวจสอบคิวว่าง...</div>`;
  $("#legend").style.display = "none";
  $("#viewnote").style.display = "none";
  try {
    availability = await api(`/api/massage/day?day=${encodeURIComponent(day)}`);
    renderGrid();
  } catch (e) {
    if (e && e.handled) return;
    $("#slots").innerHTML = `<div class="empty">${escapeHtml(e.message || "โหลดคิวไม่สำเร็จ")}</div>`;
    $("#legend").style.display = "none";
  }
}

/**
 * ชื่อหมอนวดในหัวตารางต้องขึ้นบรรทัดใหม่ตรงที่อ่านแล้วไม่สะดุด
 *
 * ช่องกว้างราว 60px พอได้ 6-7 ตัวอักษรไทย ชื่อเกือบทุกชื่อจึงต้องตัดสองบรรทัด
 * ถ้าปล่อยให้เบราว์เซอร์ตัดเอง จะได้ "หมอนวดผู้ช / าย" ซึ่งอ่านแล้วสะดุด
 * จึงใส่จุดตัดที่มองไม่เห็นไว้หลังคำว่า "หมอนวด" ให้ก่อน ส่วนชื่อที่มีเว้นวรรคตัดตรงนั้นอยู่แล้ว
 */
function headName(name) {
  return escapeHtml(name).replace(/^หมอนวด(?=\S)/, "หมอนวด\u200B");
}

function renderGrid() {
  const th = availability.therapists;
  const flash = availability.flash === true;
  // ดูได้อย่างเดียวเมื่อ: จองวันนี้ไปแล้ว · หรือสิทธิ์หมดและวันนี้ยังไม่ใช่คิวด่วน
  const noQuota = state.used >= state.quota;
  const viewOnly = isMyDay(currentDay) || (noQuota && !flash);

  $("#viewnote").style.display = viewOnly ? "" : "none";
  $("#viewnote").textContent = isMyDay(currentDay)
    ? "โปรดเลือกวันอื่น คุณสามารถจองคิวนวดผ่อนคลายได้เพียง 1 คิว/วัน"
    : "เดือนนี้ใช้สิทธิ์ครบแล้ว วันนี้ดูได้อย่างเดียว — รอคิวด่วนเปิดตอนบ่ายสามของวันก่อนหน้า";
  $("#flashnote").style.display = flash && !viewOnly ? "" : "none";
  $("#slots").classList.toggle("flash", flash && !viewOnly);
  $("#book-bar").classList.toggle("flash", flash && !viewOnly);
  $$("#legend em").forEach((el) => el.classList.toggle("f", flash && !viewOnly));

  const head = `<tr><th class="tcol"></th>${th
    .map((t) => `<th>${headName(t.name)}</th>`)
    .join("")}</tr>`;

  const body = availability.rows
    .map((r) => {
      const cells = r.cells
        .map((c) => {
          // รอบที่เลยเวลาแล้วยังโชว์ไว้ให้เห็นภาพทั้งวัน แต่กดไม่ได้
          const label = c.mine ? "ของคุณ" : c.taken ? "จอง" : r.bookable ? "ว่าง" : "ปิด";
          const dis = viewOnly || c.taken || !r.bookable ? " disabled" : "";
          return `<td><button class="cell${c.mine ? " mine" : ""}" aria-pressed="false"${dis}
            data-slot="${escapeHtml(r.slot)}" data-th="${escapeHtml(c.therapistId)}" data-label="${label}"
            aria-label="${escapeHtml(r.label)} ${escapeHtml(
              th.find((t) => t.id === c.therapistId)?.name ?? "",
            )} ${label}">${label}</button></td>`;
        })
        .join("");
      const [from, to] = r.label.split("-");
      return `<tr${r.bookable ? "" : ' class="off"'} data-slot="${escapeHtml(r.slot)}">
        <td class="time">${escapeHtml(from)}<br>${escapeHtml(to ?? "")}</td>${cells}</tr>`;
    })
    .join("");

  $("#slots").innerHTML = `<table class="grid">${head}${body}</table>`;
  $("#legend").style.display = "";
  $("#btn-book").textContent = flash && !viewOnly ? "จองคิวด่วน" : "ยืนยันการจอง";
  if (viewOnly) clearPick();
}

function clearPick() {
  pick = null;
  $("#pickinfo").innerHTML = `<span class="none">ยังไม่ได้เลือกรอบ</span>`;
  $("#btn-clear").classList.remove("on");
  $("#btn-book").disabled = true;
}

function updatePick() {
  if (!pick) return clearPick();
  const day = state.days.find((d) => d.day === currentDay);
  $("#pickinfo").innerHTML = `
    <div class="t">${escapeHtml(day ? day.label : currentDay)} · ${escapeHtml(pick.slotLabel)}</div>
    <div class="s">${escapeHtml(pick.therapistName)}</div>`;
  $("#btn-clear").classList.add("on");
  $("#btn-book").disabled = false;
}

/** ยกเลิกการเลือกจากปุ่ม "ล้าง" บนแถบด้านล่าง */
function unpick() {
  $$("#slots .cell").forEach((x) => {
    x.setAttribute("aria-pressed", "false");
    x.textContent = x.dataset.label;
  });
  clearPick();
}

/* ---------- จอง ---------- */

async function doBook() {
  if (!pick) return;
  const day = state.days.find((d) => d.day === currentDay);
  const flash = availability && availability.flash === true;
  const okGo = await dialog({
    icon: flash ? "flash" : "warn",
    title: flash ? "คิวด่วน — ยกเลิกไม่ได้" : "ยืนยันการจอง",
    body: `${day ? day.label : currentDay}\nเวลา ${pick.slotLabel}\n${pick.therapistName}`,
    confirm: flash ? "รับทราบ กดจองเลย" : "ยืนยัน",
    cancel: flash ? "ไม่เอาแล้ว" : "แก้ไข",
    terms: flash ? "flash" : true,
  });
  if (!okGo) return;

  const btn = $("#btn-book");
  btn.disabled = true;
  btn.textContent = "กำลังบันทึก...";
  try {
    await api("/api/massage/book", {
      method: "POST",
      body: { day: currentDay, slot: pick.slot, therapistId: pick.therapistId },
    });
    clearPick();
    await loadState();
    goMine({ justBooked: true });
  } catch (e) {
    if (e && e.handled) return;
    await dialog({ icon: "err", title: "จองไม่สำเร็จ", body: e.message || "", confirm: "เข้าใจแล้ว" });
    // คิวถูกคนอื่นตัดหน้าไป — โหลดตารางใหม่ให้เห็นสถานะจริงทันที
    clearPick();
    await loadState();
    goBook();
  } finally {
    btn.textContent = flash ? "จองคิวด่วน" : "ยืนยันการจอง";
  }
}

/* ---------- คิวของฉัน ---------- */

function goMine({ justBooked }) {
  const list = activeBookings();

  $("#ok-badge").style.display = justBooked ? "" : "none";
  $("#mine-title").textContent = list.length ? "คิวของคุณเดือนนี้" : "เดือนนี้คุณยังไม่มีคิว";

  $("#mine-list").innerHTML = list.length
    ? list
        .map(
          (b) => {
            // ป้ายบอก "สถานะของคิวนี้" อย่างเดียว — ยกเลิกไปแล้ว · ใช้บริการไปแล้ว · ยังอยู่
            // ส่วนเรื่องยกเลิกทันหรือไม่ทัน อยู่ในบรรทัดใต้การ์ดซึ่งบอกได้ละเอียดกว่าป้ายคำเดียว
            const tag =
              b.status === "cancelled"
                ? { cls: "void", text: "ยกเลิกแล้ว" }
                : b.past
                  ? { cls: "done", text: "ใช้แล้ว" }
                  : b.flash
                    ? { cls: "flash", text: "⚡ ยืนยันแล้ว" }
                    : { cls: "", text: "ยืนยันแล้ว" };
            return `<div class="mycard${b.past ? " off" : ""}">
            <div class="mytop">
              <div class="myday">${escapeHtml(b.dayLabel)}</div>
              <span class="mytag ${tag.cls}">${tag.text}</span>
            </div>
            <div class="mytime">${escapeHtml(b.slotLabel)}</div>
            <div class="mywho">${escapeHtml(b.therapistName)}</div>
            ${
              b.cancellable
                ? `<button class="btn-cancel" data-cancel="${escapeHtml(b.id)}">ยกเลิกคิวนี้</button>`
                : b.past
                  ? ""
                  : b.flash
                    ? `<div class="mynote flashwarn">ยกเลิกในระบบไม่ได้ — หากมาไม่ได้ ต้องหาคนมาแทนเอง แล้วแจ้งฝ่ายบุคคลให้เปลี่ยนชื่อผู้จอง</div>`
                    : `<div class="mynote">ยกเลิกได้ถึงก่อนรอบเริ่ม 15 นาที — ตอนนี้เลยเวลานั้นแล้ว</div>`
            }
          </div>`;
          },
        )
        .join("")
    : `<div class="empty">ยังไม่ได้จองคิวไหนไว้</div>`;

  // สิทธิ์หมดแล้วแต่มีคิวด่วนเปิดอยู่ ต้องยังมีทางกลับไปหน้าจอง
  // ไม่งั้นคนที่มีคิวอยู่แล้วจะถูกพามาหน้านี้แล้วตันอยู่ตรงนี้ ไม่มีทางไปเจอคิวด่วนเลย
  const left = Math.max(0, state.quota - state.used);
  const flash = hasFlashDay();
  const more = $("#btn-book-more");
  more.style.display = state.open && (left > 0 || flash) ? "" : "none";
  more.textContent = !list.length
    ? "ไปหน้าจองคิว"
    : left > 0
      ? `จองคิวเพิ่ม (เหลือสิทธิ์อีก ${left} ครั้ง)`
      : "⚡ ดูคิวด่วนของวันนี้";

  $("#btn-mine-close").style.display = canCloseWindow() ? "" : "none";
  show("s-mine");
}

async function cancelBooking(id) {
  const b = (state.mine || []).find((x) => x.id === id);
  const okGo = await dialog({
    icon: "warn",
    title: "ยืนยันการยกเลิก",
    body: b
      ? `${b.dayLabel}\nเวลา ${b.slotLabel}\n${b.therapistName}\n\nคิวนี้จะว่างให้เพื่อนจองแทนทันที`
      : "คิวนี้จะว่างให้เพื่อนจองแทนทันที",
    confirm: "ยกเลิกคิว",
    cancel: "เก็บไว้ก่อน",
    danger: true,
  });
  if (!okGo) return;

  try {
    await api("/api/massage/cancel", { method: "POST", body: { id } });
    toast("ยกเลิกคิวเรียบร้อยแล้ว");
    await loadState();
    if (state.open) goMine({ justBooked: false });
    else renderClosed();
  } catch (e) {
    if (e && e.handled) return;
    await dialog({ icon: "err", title: "ยกเลิกไม่สำเร็จ", body: e.message || "", confirm: "เข้าใจแล้ว" });
    await loadState();
    route();
  }
}

/* ---------- หน้าปิดระบบ ---------- */

function renderClosed() {
  const t = $("#closed-title");
  const b = $("#closed-body");
  const w = $("#closed-when");

  if (state.reason === "not_yet") {
    t.textContent = "ยังไม่ถึงเวลาเปิดจอง";
    b.innerHTML = "คิวนวดรอบถัดไปจะเปิดให้จองตามเวลาด้านล่าง<br>กรุณากลับมาใหม่อีกครั้ง";
  } else if (state.reason === "manual") {
    t.textContent = "ปิดปรับปรุงระบบชั่วคราว";
    b.innerHTML = "ขออภัยในความไม่สะดวก<br>ขณะนี้ระบบจองคิวนวดปิดให้บริการชั่วคราว";
  } else {
    // ใช้ถ้อยคำเดิมจากหน้าปิดระบบของระบบเก่า พนักงานคุ้นตาอยู่แล้ว
    // ต่างกันตรงที่ของเดิมบอกแค่ "เร็ว ๆ นี้" ส่วนของใหม่บอกวันเวลาที่จะเปิดจริงในกล่องด้านล่าง
    const m = closedMonthName(state.opensAt);
    t.textContent = "ปิดปรับปรุงระบบชั่วคราว";
    b.innerHTML =
      `ขออภัยในความไม่สะดวก<br>ขณะนี้คิวนวด${m ? `เดือน${escapeHtml(m)} ` : ""}เต็มทุกช่วงเวลาแล้ว<br>` +
      "ระบบจะทำการปิดปรับปรุง<br>เพื่อเพิ่มประสิทธิภาพการใช้งาน<br><br>" +
      "<b>สำหรับคิวนวดเดือนใหม่จะเปิดให้จองเร็วๆ นี้</b>";
  }

  if (state.opensAt) {
    w.style.display = "";
    w.innerHTML = `เปิดจองอีกครั้ง<br><b>${escapeHtml(thaiWhen(state.opensAt))}</b>`;
  } else {
    w.style.display = "none";
  }

  // คิวที่จองไว้แล้วต้องยกเลิกได้เสมอ แม้ระบบปิดรับจองใหม่
  // (หน้าปิดของระบบเดิมแทนที่ทั้งหน้า คนที่จองไว้จึงเข้าไปยกเลิกไม่ได้เลย)
  const mine = activeBookings();
  const link = $("#closed-mine");
  link.style.display = mine.length ? "" : "none";
  link.textContent = `ดูคิวของฉัน (${mine.length})`;

  $$("#s-closed [data-close]").forEach((el) => {
    el.style.display = canCloseWindow() ? "" : "none";
  });
  show("s-closed");
}

const TH_MONTH_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

/**
 * เดือนที่คิวเต็ม = เดือนก่อนหน้าเดือนที่จะเปิดจองรอบใหม่
 *
 * คิดจากเวลาที่เซิร์ฟเวอร์ส่งมา ไม่ใช่นาฬิกาของเครื่อง เครื่องที่ตั้งเขตเวลาหรือวันที่ผิด
 * จะได้ชื่อเดือนถูกอยู่ดี และไม่มีทางขึ้นชื่อเดือนคนละเดือนกับที่เซิร์ฟเวอร์ตัดสิน
 */
function closedMonthName(opensAtIso) {
  if (!opensAtIso) return "";
  const d = new Date(new Date(opensAtIso).getTime() + 7 * 3600 * 1000);
  return TH_MONTH_FULL[(d.getUTCMonth() + 11) % 12];
}

/** "2026-09-01T02:00:00.000Z" -> "1 ก.ย. 2569 เวลา 09.00 น." */
function thaiWhen(iso) {
  const M = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const d = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear() + 543} เวลา ${hh}.${mm} น.`;
}

/* ---------- ยกเลิกจากปุ่มบนการ์ดในไลน์ ---------- */

function openCancel(id) {
  const b = (state.mine || []).find((x) => x.id === id);
  const box = $("#cancel-detail");

  if (!b || b.status !== "booked") {
    box.innerHTML = "ไม่พบคิวนี้ หรือคิวถูกยกเลิกไปแล้ว";
    $("#btn-cancel-confirm").style.display = "none";
  } else if (!b.cancellable) {
    box.innerHTML = `<b>${escapeHtml(b.dayLabel)}</b><br>เวลา ${escapeHtml(b.slotLabel)}<br>${escapeHtml(
      b.therapistName,
    )}<br><br>เลยเวลายกเลิกแล้ว — ยกเลิกได้ถึงก่อนรอบเริ่ม 15 นาที`;
    $("#btn-cancel-confirm").style.display = "none";
  } else {
    box.innerHTML = `<b>${escapeHtml(b.dayLabel)}</b><br>เวลา ${escapeHtml(b.slotLabel)}<br>${escapeHtml(
      b.therapistName,
    )}`;
    $("#btn-cancel-confirm").style.display = "";
    $("#btn-cancel-confirm").dataset.id = id;
  }
  show("s-cancel");
}

/* ---------- ฟอร์มเช็คชื่อของผู้ดูแล ---------- */

async function goAdmin(day) {
  show("s-loading");
  $("#loading-text").textContent = "กำลังโหลดฟอร์มเช็คชื่อ...";
  try {
    const r = await api(`/api/massage/admin/sheet${day ? `?day=${encodeURIComponent(day)}` : ""}`);
    sheetOptions = r.options || [];
    sheet = r.sheet;
    downloadPath = r.downloadPath || null;
    renderSheet();
  } catch (e) {
    if (e && e.handled) return;
    await dialog({ icon: "err", title: "เปิดฟอร์มไม่สำเร็จ", body: e.message || "", confirm: "เข้าใจแล้ว" });
    route();
  }
}

function renderSheet() {
  const sel = $("#sheet-day");
  sel.innerHTML = sheetOptions
    .map((o) => `<option value="${escapeHtml(o.day)}"${sheet && o.day === sheet.day ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");

  if (!sheet) {
    $("#sheet-tally").innerHTML = "";
    $("#sheet-rows").innerHTML = `<div class="empty">ยังไม่มีวันให้บริการในช่วงนี้</div>`;
    $("#btn-download").style.display = "none";
    show("s-admin");
    return;
  }

  $("#btn-download").style.display = downloadPath ? "" : "none";
  // เหลือแค่สองตัวเลขที่ยังมีความหมาย — การเช็คว่ามา/ไม่มา ทำบนกระดาษ ไม่ได้ทำในแอป
  $("#sheet-tally").innerHTML = `
    <div><b>${sheet.booked}</b>จองแล้ว</div>
    <div><b>${sheet.total - sheet.booked}</b>ว่าง</div>`;

  // เรียงตามเวลาของรอบก่อน แล้วค่อยเรียงตามลำดับหมอนวด เพื่อให้อ่านไล่ลงมาได้ตรงกับหน้างาน
  const list = [];
  sheet.rows.forEach((r, ri) => {
    r.cells.forEach((c, i) => {
      if (c.bookingId) list.push({ ...c, slot: r.slot, label: r.label, ri, ti: i, who: sheet.therapists[i] });
    });
  });
  list.sort((a, b) => a.ri - b.ri || a.ti - b.ti);

  $("#sheet-rows").innerHTML = list.length
    ? list
        .map(
          (c) => `<div class="srow" data-id="${escapeHtml(c.bookingId)}">
        <div class="head">
          <span class="t">${escapeHtml(c.label)}</span>
          <span class="who">${escapeHtml(c.who ? c.who.name : "")}</span>
        </div>
        <div class="nm">${escapeHtml(c.name || "")}</div>
        <div class="who">${escapeHtml(c.dept || "")}</div>
        <div class="acts">
          <button data-edit="${escapeHtml(c.bookingId)}">ย้ายรอบ</button>
          <button data-swap="${escapeHtml(c.bookingId)}">เปลี่ยนคน</button>
          <button class="danger" data-drop="${escapeHtml(c.bookingId)}">ยกเลิก</button>
        </div>
      </div>`,
        )
        .join("")
    : `<div class="empty">วันนี้ยังไม่มีใครจองคิว</div>`;
  show("s-admin");
}

/** ช่องที่ยังว่างของวันที่กำลังเปิดอยู่ ใช้เป็นตัวเลือกตอนย้ายคิว */
function freeSlots(exceptId) {
  const out = [];
  for (const r of sheet.rows) {
    r.cells.forEach((c, i) => {
      if (!c.bookingId || c.bookingId === exceptId) {
        out.push({ slot: r.slot, label: r.label, therapistId: sheet.therapists[i].id, therapistName: sheet.therapists[i].name });
      }
    });
  }
  return out;
}

async function editBooking(id) {
  const cur = sheet.rows.flatMap((r) => r.cells).find((c) => c.bookingId === id);
  const options = freeSlots(id);
  if (options.length === 0) return toast("วันนี้ไม่มีช่องว่างให้ย้าย");

  const value = await chooseSlot(cur, options);
  if (!value) return;
  const [slot, therapistId] = value.split("|");
  try {
    await api("/api/massage/admin/move", { method: "POST", body: { id, slot, therapistId } });
    toast("ย้ายคิวเรียบร้อย ระบบแจ้งเจ้าตัวทางไลน์แล้ว");
    await goAdmin(sheet.day);
  } catch (e) {
    if (e && e.handled) return;
    toast(e.message || "ย้ายคิวไม่สำเร็จ");
  }
}

/**
 * เปลี่ยนชื่อผู้จอง — รองรับกติกาคิวด่วนที่ว่า "มาไม่ได้ให้หาคนมาแทนแล้วแจ้งฝ่ายบุคคล"
 *
 * ต้องมีเส้นทางนี้จริง ๆ ไม่ใช่ให้ยกเลิกแล้วให้คนใหม่กดเอง เพราะพอยกเลิกช่องจะกลับเข้าคิวด่วน
 * แล้วคนอื่นตัดหน้าคนที่รับปากไว้ได้ กลายเป็นระบบผิดสัญญาที่ตัวเองบอก
 */
async function swapBooking(id) {
  const cur = sheet.rows.flatMap((r) => r.cells).find((c) => c.bookingId === id);
  const to = await pickEmployee(cur);
  if (!to) return;
  try {
    await api("/api/massage/admin/reassign", { method: "POST", body: { id, employeeId: to } });
    toast("เปลี่ยนคนจองเรียบร้อย ระบบแจ้งทั้งสองฝ่ายทางไลน์แล้ว");
    await goAdmin(sheet.day);
  } catch (e) {
    if (e && e.handled) return;
    toast(e.message || "เปลี่ยนคนจองไม่สำเร็จ");
  }
}

/** กล่องค้นชื่อพนักงาน — ค้นจากเซิร์ฟเวอร์ ไม่โหลดทะเบียนทั้งบริษัทมาไว้ในเครื่อง */
function pickEmployee(cur) {
  return new Promise((resolve) => {
    let chosen = null;
    let timer;

    $("#m-ic").className = "ic warn";
    $("#m-ic").textContent = "!";
    $("#m-title").textContent = "เปลี่ยนคนจอง";
    $("#m-body").style.display = "";
    $("#m-body").innerHTML = `${escapeHtml(cur && cur.name ? "คิวของ " + cur.name : "")}
      <div class="finder">
        <input id="m-find" type="text" placeholder="พิมพ์ชื่อ หรือรหัสพนักงาน" autocomplete="off" />
        <div class="hits" id="m-hits"><div class="none">พิมพ์อย่างน้อย 2 ตัวอักษร</div></div>
      </div>`;

    const btns = $("#m-btns");
    btns.innerHTML = "";
    const done = (v) => {
      $("#backdrop").classList.remove("on");
      $("#backdrop").onclick = null;
      $("#m-body").innerHTML = "";
      resolve(v);
    };
    const no = document.createElement("button");
    no.className = "no";
    no.textContent = "ไม่ใช่ตอนนี้";
    no.onclick = () => done(null);
    btns.appendChild(no);
    const go = document.createElement("button");
    go.className = "go";
    go.textContent = "เปลี่ยนคนจอง";
    go.disabled = true;
    go.onclick = () => done(chosen);
    btns.appendChild(go);

    const search = async (q) => {
      if (q.trim().length < 2) {
        $("#m-hits").innerHTML = `<div class="none">พิมพ์อย่างน้อย 2 ตัวอักษร</div>`;
        return;
      }
      try {
        const r = await api(`/api/massage/admin/employees?q=${encodeURIComponent(q.trim())}`);
        const list = r.employees || [];
        $("#m-hits").innerHTML = list.length
          ? list
              .map(
                (e) => `<button class="hit" data-emp="${escapeHtml(e.id)}" aria-pressed="false">
                  <b>${escapeHtml(e.full_name)}</b>
                  <span>${escapeHtml(e.employee_code)}${e.dept ? " · " + escapeHtml(e.dept) : ""}</span>
                </button>`,
              )
              .join("")
          : `<div class="none">ไม่พบพนักงานที่ตรงกับที่ค้น</div>`;
      } catch {
        $("#m-hits").innerHTML = `<div class="none">ค้นหาไม่สำเร็จ ลองใหม่อีกครั้ง</div>`;
      }
    };

    $("#m-find").oninput = (e) => {
      chosen = null;
      go.disabled = true;
      clearTimeout(timer);
      const q = e.target.value;
      timer = setTimeout(() => search(q), 250);
    };
    $("#m-hits").onclick = (e) => {
      const b = e.target.closest("[data-emp]");
      if (!b) return;
      $$("#m-hits .hit").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      chosen = b.dataset.emp;
      go.disabled = false;
    };

    $("#backdrop").classList.add("on");
    $("#backdrop").onclick = (e) => {
      if (e.target === $("#backdrop")) done(null);
    };
    setTimeout(() => $("#m-find").focus(), 50);
  });
}

async function dropBooking(id) {
  const cur = sheet.rows.flatMap((r) => r.cells).find((c) => c.bookingId === id);
  const yes = await dialog({
    icon: "warn",
    title: "ยกเลิกคิวนี้",
    body: `${cur && cur.name ? cur.name + "\n" : ""}ช่องนี้จะกลับมาว่างให้คนอื่นจองได้ทันที และระบบจะแจ้งเจ้าตัวทางไลน์`,
    confirm: "ยกเลิกคิว",
    cancel: "ไม่ใช่ตอนนี้",
    danger: true,
  });
  if (!yes) return;
  try {
    await api("/api/massage/admin/cancel", { method: "POST", body: { id } });
    toast("ยกเลิกคิวเรียบร้อย");
    await goAdmin(sheet.day);
  } catch (e) {
    if (e && e.handled) return;
    toast(e.message || "ยกเลิกไม่สำเร็จ");
  }
}

/** กล่องเลือกช่องใหม่ — ใช้ select ธรรมดาเพราะตัวเลือกมีได้ถึง 32 ช่อง ปุ่มเรียงจะยาวเกินจอ */
function chooseSlot(cur, options) {
  return new Promise((resolve) => {
    $("#m-ic").className = "ic warn";
    $("#m-ic").textContent = "!";
    $("#m-title").textContent = "ย้ายคิวไปช่องอื่น";
    $("#m-body").style.display = "";
    $("#m-body").innerHTML = `${escapeHtml(cur && cur.name ? cur.name : "")}
      <select class="form-select" id="m-slot" style="margin-top:12px">${options
        .map((o) => `<option value="${escapeHtml(o.slot)}|${escapeHtml(o.therapistId)}">${escapeHtml(o.label)} · ${escapeHtml(o.therapistName)}</option>`)
        .join("")}</select>`;

    const btns = $("#m-btns");
    btns.innerHTML = "";
    const done = (v) => {
      $("#backdrop").classList.remove("on");
      $("#backdrop").onclick = null;
      $("#m-body").innerHTML = "";
      resolve(v);
    };
    const no = document.createElement("button");
    no.className = "no";
    no.textContent = "ไม่ใช่ตอนนี้";
    no.onclick = () => done(null);
    btns.appendChild(no);
    const go = document.createElement("button");
    go.className = "go";
    go.textContent = "ย้ายคิว";
    go.onclick = () => done($("#m-slot").value);
    btns.appendChild(go);

    $("#backdrop").classList.add("on");
    $("#backdrop").onclick = (e) => {
      if (e.target === $("#backdrop")) done(null);
    };
  });
}

/**
 * เปิดฟอร์มพร้อมพิมพ์ที่เบราว์เซอร์ของเครื่อง
 *
 * ต้องออกไปข้างนอกเพราะเบราว์เซอร์ในแอปไลน์สั่งพิมพ์และบันทึกไฟล์ได้ไม่แน่นอน
 * พอเปิดข้างนอกแล้วหน้าจะเด้งหน้าต่างสั่งพิมพ์ให้เอง เลือก "บันทึกเป็น PDF" ได้เลย
 */
function downloadSheet() {
  if (!downloadPath) return;
  const url = location.origin + downloadPath;
  if (window.liff && liff.openWindow) liff.openWindow({ url, external: true });
  else window.open(url, "_blank");
}

/* ---------- wiring ---------- */

/* ---------- ผู้ดูแล: จองแทนพนักงาน ---------- */
//
// มีไว้สำหรับสิ่งที่เกิดขึ้นจริงหน้างาน: พนักงานเดินมาขอคิวที่หน้าห้อง โทรมาฝากจอง
// หรือคิวว่างอยู่ตอนบ่ายแล้วไม่มีใครจองผ่านแอปทัน ผู้ดูแลจึงกดให้ได้โดยไม่ติดกติกา
// ที่มีไว้กำกับการกดเองของพนักงาน (เส้นตัด 15 นาที · สิทธิ์รายเดือน · เวลาเปิดจอง)

let aDayOptions = [];  // วันที่ยังเปิดและยังไม่ผ่าน สำหรับกล่องเลือกวัน
let aGrid = null;      // ตารางทั้งวันของวันที่เลือกอยู่
let aPick = null;      // { slot, label, therapistId, therapistName }
let aWho = null;       // { id, name, code, dept, used }
let aFindTimer;

/** เดือนถัดไปในรูปแบบ YYYY-MM */
function nextMonthOf(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** เดือนก่อนหน้าในรูปแบบ YYYY-MM */
function prevMonthOf(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/**
 * รวมวันของเดือนนี้กับเดือนหน้า
 *
 * ต้องมีเดือนหน้าด้วย ไม่งั้นพอถึงศุกร์สุดท้ายของเดือน กล่องเลือกวันจะว่างเปล่า
 * ทั้งที่เดือนหน้ามีวันให้จองอยู่ — ซึ่งเป็นช่วงที่ผู้ดูแลต้องใช้หน้านี้พอดี
 */
async function loadAdminDayOptions() {
  const cur = await api("/api/massage/admin/days");
  const nxt = await api(`/api/massage/admin/days?month=${encodeURIComponent(nextMonthOf(cur.month))}`);
  aDayOptions = [...(cur.days || []), ...(nxt.days || [])].filter((d) => d.status === "open" && !d.past);
}

async function goAbook(day) {
  show("s-loading");
  $("#loading-text").textContent = "กำลังโหลดตารางคิว...";
  try {
    if (!aDayOptions.length) await loadAdminDayOptions();
    const target = day || (aGrid && aGrid.day) || (aDayOptions[0] && aDayOptions[0].day);
    if (!target) {
      aGrid = null;
      renderAbook();
      return show("s-abook");
    }
    aGrid = await api(`/api/massage/admin/day?day=${encodeURIComponent(target)}`);
    aPick = null;
    renderAbook();
    show("s-abook");
  } catch (e) {
    if (e && e.handled) return;
    await dialog({ icon: "err", title: "เปิดหน้าจองแทนไม่สำเร็จ", body: e.message || "", confirm: "เข้าใจแล้ว" });
    route();
  }
}

function renderAbook() {
  $("#abook-day").innerHTML = aDayOptions
    .map((o) => `<option value="${escapeHtml(o.day)}"${aGrid && o.day === aGrid.day ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");

  // คนที่เลือกไว้ต้องค้างอยู่บนจอระหว่างไล่หาช่องว่าง ไม่งั้นต้องเลื่อนขึ้นไปดูซ้ำ
  $("#abook-picked").innerHTML = aWho
    ? `<div class="picked">
         <div><b>${escapeHtml(aWho.name)}</b>
           <span>${escapeHtml(aWho.code)}${aWho.dept ? " · " + escapeHtml(aWho.dept) : ""} · ใช้สิทธิ์เดือนนี้ ${aWho.used}/${state.quota}</span></div>
         <button id="abook-change">เปลี่ยนคน</button>
       </div>`
    : "";
  $("#abook-finder").style.display = aWho ? "none" : "";

  if (!aGrid) {
    $("#abook-grid").innerHTML = `<div class="empty">ยังไม่มีวันให้บริการที่เปิดอยู่<br>เปิดวันได้ที่แท็บ “วันให้บริการ”</div>`;
    return updateAbookBar();
  }

  const th = aGrid.therapists;
  const head = `<tr><th class="tcol"></th>${th.map((t) => `<th>${headName(t.name)}</th>`).join("")}</tr>`;
  const body = aGrid.rows
    .map((r) => {
      const cells = r.cells
        .map((c) => {
          // ช่องที่มีคนแล้วโชว์ชื่อ ผู้ดูแลจะได้รู้ว่าใครอยู่ตรงไหนโดยไม่ต้องสลับไปหน้าเช็คชื่อ
          // ช่องกว้างราว 60px ใส่ได้แค่ชื่อจริง ชื่อเต็มจะถูกตัดจนเหลือแต่คำแรกที่ซ้ำกันทุกช่อง
          const label = c.name ? c.name.trim().split(/\s+/)[0] : r.past ? "ผ่านแล้ว" : "ว่าง";
          const dis = c.name || r.past ? " disabled" : "";
          return `<td><button class="cell${c.name ? " who" : ""}" aria-pressed="false"${dis}
            data-aslot="${escapeHtml(r.slot)}" data-ath="${escapeHtml(c.therapistId)}"
            title="${escapeHtml(label)}">${escapeHtml(label)}</button></td>`;
        })
        .join("");
      const [from, to] = r.label.split("-");
      return `<tr${r.past ? ' class="off"' : ""} data-slot="${escapeHtml(r.slot)}">
        <td class="time">${escapeHtml(from)}<br>${escapeHtml(to ?? "")}</td>${cells}</tr>`;
    })
    .join("");
  // ติดวันที่ไว้กับตาราง — ตอนสลับวัน ตารางเก่ายังค้างอยู่หนึ่งจังหวะระหว่างรอข้อมูลใหม่
  // มีวันติดไว้จึงบอกได้ว่าที่เห็นอยู่เป็นตารางของวันไหนแล้ว
  $("#abook-grid").innerHTML = `<table class="grid" data-day="${escapeHtml(aGrid.day)}">${head}${body}</table>`;
  updateAbookBar();
}

function updateAbookBar() {
  const info = $("#abook-info");
  if (!aPick) info.innerHTML = `<span class="none">ยังไม่ได้เลือกช่อง</span>`;
  else {
    info.innerHTML = `<div class="t">${escapeHtml(aPick.label)}</div>
      <div class="s">${escapeHtml(aGrid.label)} · ${escapeHtml(aPick.therapistName)}</div>`;
  }
  $("#abook-clear").classList.toggle("on", Boolean(aPick));
  $("#abook-go").disabled = !(aPick && aWho && aGrid);
  $("#abook-go").textContent = aWho ? `จองให้ ${aWho.name}` : "จองให้พนักงาน";
}

function clearAbookPick() {
  aPick = null;
  $$("#abook-grid .cell").forEach((b) => b.setAttribute("aria-pressed", "false"));
  updateAbookBar();
}

/** ค้นพนักงานบนหน้าจอ (ไม่ใช่ในกล่อง) เพราะต้องเลือกคนก่อนแล้วยังต้องเลือกช่องต่ออีก */
async function searchAbookEmployee(q) {
  if (q.trim().length < 2) {
    $("#abook-hits").innerHTML = `<div class="none">พิมพ์อย่างน้อย 2 ตัวอักษร</div>`;
    return;
  }
  try {
    const r = await api(`/api/massage/admin/employees?q=${encodeURIComponent(q.trim())}`);
    const list = r.employees || [];
    $("#abook-hits").innerHTML = list.length
      ? list
          .map(
            (e) => `<button class="hit" data-aemp="${escapeHtml(e.id)}"
              data-name="${escapeHtml(e.full_name)}" data-code="${escapeHtml(e.employee_code)}"
              data-dept="${escapeHtml(e.dept || "")}" data-used="${e.used ?? 0}" aria-pressed="false">
              <b>${escapeHtml(e.full_name)}</b>
              <span>${escapeHtml(e.employee_code)}${e.dept ? " · " + escapeHtml(e.dept) : ""} · ใช้สิทธิ์ ${e.used ?? 0}/${state.quota}</span>
            </button>`,
          )
          .join("")
      : `<div class="none">ไม่พบพนักงานที่ตรงกับที่ค้น</div>`;
  } catch {
    $("#abook-hits").innerHTML = `<div class="none">ค้นหาไม่สำเร็จ ลองใหม่อีกครั้ง</div>`;
  }
}

async function doAdminBook() {
  if (!(aPick && aWho && aGrid)) return;
  const over = aWho.used >= state.quota;
  const yes = await dialog({
    icon: over ? "flash" : "warn",
    title: over ? "จองแทน (เกินสิทธิ์)" : "จองแทนพนักงาน",
    body: `${aWho.name}\n${aGrid.label}\n${aPick.label} (${aPick.therapistName})\n\n` +
      (over
        ? `ใช้สิทธิ์ครบ ${state.quota} ครั้งแล้ว คิวนี้จะบันทึกเป็นคิวด่วน ไม่หักสิทธิ์ และเจ้าตัวยกเลิกเองไม่ได้`
        : `จะหักสิทธิ์เป็นครั้งที่ ${aWho.used + 1} จาก ${state.quota} และระบบจะแจ้งเจ้าตัวทางไลน์`),
    confirm: "ยืนยันจองให้",
    cancel: "ไม่ใช่ตอนนี้",
  });
  if (!yes) return;

  try {
    const r = await api("/api/massage/admin/book", {
      method: "POST",
      body: { employeeId: aWho.id, day: aGrid.day, slot: aPick.slot, therapistId: aPick.therapistId },
    });
    toast(`จองให้ ${r.name} แล้ว${r.flash ? " (คิวด่วน)" : ""}`);
    aWho = { ...aWho, used: r.used };
    await goAbook(aGrid.day);
  } catch (e) {
    if (e && e.handled) return;
    await dialog({ icon: "err", title: "จองไม่สำเร็จ", body: e.message || "", confirm: "เข้าใจแล้ว" });
    await goAbook(aGrid.day);
  }
}

/* ---------- ผู้ดูแล: เปิดปิดวันให้บริการ ---------- */
//
// แทนการเข้าไปรัน SQL เอง ซึ่งเป็นทางเดียวที่เคยทำได้ ทั้งที่เป็นงานที่ต้องทำทุกครั้ง
// ที่บริษัทประกาศวันหยุดหรือหมอนวดลาทั้งวัน

let aMonth = null;
let aMonthDays = [];

async function goADays(month) {
  show("s-loading");
  $("#loading-text").textContent = "กำลังโหลดวันให้บริการ...";
  try {
    const r = await api(`/api/massage/admin/days${month ? `?month=${encodeURIComponent(month)}` : ""}`);
    aMonth = r.month;
    aMonthDays = r.days || [];
    renderADays();
    show("s-adays");
  } catch (e) {
    if (e && e.handled) return;
    await dialog({ icon: "err", title: "เปิดหน้าวันให้บริการไม่สำเร็จ", body: e.message || "", confirm: "เข้าใจแล้ว" });
    route();
  }
}

function renderADays() {
  const [y, m] = aMonth.split("-").map(Number);
  $("#adays-month").textContent = `${TH_MONTH_FULL[m - 1]} ${y + 543}`;

  $("#adays-list").innerHTML = aMonthDays.length
    ? aMonthDays
        .map((d) => {
          const shut = d.status === "closed";
          const note = shut
            ? `ปิด${d.closedReason ? " — " + escapeHtml(d.closedReason) : ""}`
            : `เปิดให้บริการ · จองแล้ว ${d.booked}/${d.total}`;
          return `<div class="drow${shut ? " shut" : ""}${d.past ? " gone" : ""}">
            <div class="info">
              <div class="d">${escapeHtml(d.label)}</div>
              <div class="s">${note}</div>
            </div>
            <button class="go ${shut ? "open" : "shut"}" data-aday="${escapeHtml(d.day)}"
              data-status="${shut ? "closed" : "open"}"${d.past ? " disabled" : ""}>
              ${shut ? "เปิดวัน" : "ปิดวัน"}
            </button>
          </div>`;
        })
        .join("")
    : `<div class="empty">เดือนนี้ยังไม่มีวันให้บริการ<br>เพิ่มวันเองได้ที่ช่องด้านล่าง</div>`;

}

async function toggleServiceDay(day, status) {
  const row = aMonthDays.find((d) => d.day === day);
  const label = row ? row.label : day;

  if (status === "closed") {
    const yes = await dialog({
      icon: "ok",
      title: "เปิดวันนี้ให้บริการ",
      body: `${label}\n\nพนักงานจะจองวันนี้ได้ทันที คิวที่ถูกยกเลิกไปตอนปิดวันจะไม่ถูกคืนให้`,
      confirm: "เปิดวัน",
      cancel: "ไม่ใช่ตอนนี้",
    });
    if (!yes) return;
    return saveServiceDay({ day, status: "open" });
  }

  const booked = row ? row.booked : 0;
  const reason = await dialog({
    icon: "warn",
    title: "ปิดวันนี้",
    body: `${label}\n\n` +
      (booked > 0
        ? `วันนี้มีคนจองอยู่ ${booked} คิว ปิดแล้วคิวทั้งหมดจะถูกยกเลิก และระบบจะแจ้งเจ้าตัวทุกคนทางไลน์`
        : "ยังไม่มีใครจองวันนี้ ปิดได้เลย"),
    input: { placeholder: "เหตุผล เช่น วันหยุดบริษัท", value: "" },
    confirm: booked > 0 ? `ปิดวันและยกเลิก ${booked} คิว` : "ปิดวัน",
    cancel: "ไม่ใช่ตอนนี้",
    danger: true,
  });
  if (!reason) return;
  return saveServiceDay({
    day, status: "closed", force: true,
    reason: typeof reason === "string" ? reason : "ปิดให้บริการ",
  });
}

async function saveServiceDay(body) {
  try {
    const r = await api("/api/massage/admin/days", { method: "POST", body });
    toast(
      body.status === "open"
        ? "เปิดวันเรียบร้อย"
        : `ปิดวันเรียบร้อย${r.cancelled ? ` · ยกเลิกไป ${r.cancelled} คิว` : ""}`,
    );
    aDayOptions = [];  // กล่องเลือกวันของหน้าจองแทนต้องโหลดใหม่ เพราะวันที่เปิดอยู่เปลี่ยนไปแล้ว
    await goADays(aMonth);
  } catch (e) {
    if (e && e.handled) return;
    await dialog({ icon: "err", title: "บันทึกไม่สำเร็จ", body: e.message || "", confirm: "เข้าใจแล้ว" });
  }
}

async function addServiceDay() {
  const day = $("#adays-new").value;
  if (!day) return toast("เลือกวันที่ก่อน");
  const yes = await dialog({
    icon: "ok",
    title: "เพิ่มวันให้บริการ",
    body: `${day}\n\nวันนี้จะเปิดให้พนักงานจองได้ทันที`,
    confirm: "เพิ่มวัน",
    cancel: "ไม่ใช่ตอนนี้",
  });
  if (!yes) return;
  $("#adays-new").value = "";
  // เด้งไปที่เดือนของวันที่เพิ่ง เพิ่ม เพื่อให้เห็นผลทันที ไม่ใช่ค้างอยู่เดือนเดิมแล้วนึกว่าไม่ติด
  aMonth = day.slice(0, 7);
  await saveServiceDay({ day, status: "open" });
}

/** สลับสามหน้าของผู้ดูแล */
function goAdminTab(tab) {
  if (tab === "book") return goAbook();
  if (tab === "days") return goADays(aMonth);
  return goAdmin(sheet ? sheet.day : undefined);
}

function bind() {
  $("#days").onclick = (e) => {
    const b = e.target.closest(".day");
    if (b && !b.disabled) selectDay(b.dataset.day);
  };

  $("#slots").onclick = (e) => {
    const c = e.target.closest(".cell");
    if (!c || c.disabled) return;
    const already = c.getAttribute("aria-pressed") === "true";
    // คืนทุกช่องกลับเป็นคำเดิมก่อน แล้วค่อยทำเครื่องหมายช่องที่เลือก
    // เปลี่ยนแค่สีไม่พอ คนที่แยกสีเขียวไม่ออกจะไม่รู้ว่าตัวเองเลือกช่องไหนอยู่
    $$("#slots .cell").forEach((x) => {
      x.setAttribute("aria-pressed", "false");
      x.textContent = x.dataset.label;
    });
    if (already) return clearPick();

    c.setAttribute("aria-pressed", "true");
    c.textContent = "เลือก";
    const row = availability.rows.find((r) => r.slot === c.dataset.slot);
    const who = availability.therapists.find((x) => x.id === c.dataset.th);
    pick = { slot: row.slot, slotLabel: row.label, therapistId: who.id, therapistName: who.name };
    updatePick();
  };

  $("#btn-book").onclick = doBook;
  $("#btn-clear").onclick = unpick;
  $("#btn-mine").onclick = () => goMine({ justBooked: false });
  $("#closed-mine").onclick = () => goMine({ justBooked: false });
  $("#btn-book-more").onclick = () => goBook();
  $("#btn-mine-close").onclick = closeWindow;

  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-cancel]");
    if (c) cancelBooking(c.dataset.cancel);
    const ed = e.target.closest("[data-edit]");
    if (ed) editBooking(ed.dataset.edit);
    const sw = e.target.closest("[data-swap]");
    if (sw) swapBooking(sw.dataset.swap);
    const dp = e.target.closest("[data-drop]");
    if (dp) dropBooking(dp.dataset.drop);

    // แท็บสลับสามหน้าของผู้ดูแล
    const tab = e.target.closest("[data-atab]");
    if (tab) goAdminTab(tab.dataset.atab);

    // เลือกช่องในตารางจองแทน
    const ac = e.target.closest("[data-aslot]");
    if (ac && !ac.disabled) {
      $$("#abook-grid .cell").forEach((b) => b.setAttribute("aria-pressed", "false"));
      ac.setAttribute("aria-pressed", "true");
      const row = aGrid.rows.find((r) => r.slot === ac.dataset.aslot);
      const th = aGrid.therapists.find((t) => t.id === ac.dataset.ath);
      aPick = { slot: row.slot, label: row.label, therapistId: th.id, therapistName: th.name };
      updateAbookBar();
    }

    // เลือกพนักงานที่จะจองให้
    const ae = e.target.closest("[data-aemp]");
    if (ae) {
      aWho = { id: ae.dataset.aemp, name: ae.dataset.name, code: ae.dataset.code,
        dept: ae.dataset.dept, used: Number(ae.dataset.used) || 0 };
      $("#abook-find").value = "";
      $("#abook-hits").innerHTML = `<div class="none">พิมพ์อย่างน้อย 2 ตัวอักษร</div>`;
      renderAbook();
    }
    if (e.target.closest("#abook-change")) {
      aWho = null;
      renderAbook();
      setTimeout(() => $("#abook-find").focus(), 50);
    }

    // เปิดหรือปิดวันให้บริการ
    const ad = e.target.closest("[data-aday]");
    if (ad && !ad.disabled) toggleServiceDay(ad.dataset.aday, ad.dataset.status);
    const x = e.target.closest("[data-close]");
    if (x) closeWindow();
  });

  $("#btn-cancel-confirm").onclick = async () => {
    const id = $("#btn-cancel-confirm").dataset.id;
    if (id) await cancelBooking(id);
  };
  $("#btn-cancel-back").onclick = () => route();

  $("#btn-admin-back").onclick = () => route();
  $("#sheet-day").onchange = (e) => goAdmin(e.target.value);
  $("#btn-download").onclick = downloadSheet;

  // ── ผู้ดูแล: จองแทนพนักงาน ──
  $("#abook-back").onclick = () => route();
  $("#abook-day").onchange = (e) => goAbook(e.target.value);
  $("#abook-clear").onclick = clearAbookPick;
  $("#abook-go").onclick = doAdminBook;
  $("#abook-find").oninput = (e) => {
    clearTimeout(aFindTimer);
    const q = e.target.value;
    aFindTimer = setTimeout(() => searchAbookEmployee(q), 250);
  };

  // ── ผู้ดูแล: วันให้บริการ ──
  $("#adays-back").onclick = () => route();
  $("#adays-prev").onclick = () => goADays(prevMonthOf(aMonth));
  $("#adays-next").onclick = () => goADays(nextMonthOf(aMonth));
  $("#adays-add").onclick = addServiceDay;

  $("#btn-go-core").onclick = () => {
    const url = `https://liff.line.me/${CFG.coreLiffId}?back=${encodeURIComponent(CFG.liffId || "")}`;
    if (window.liff && liff.openWindow) liff.openWindow({ url, external: false });
    else window.location.href = url;
  };

  const coreReady = Boolean(CFG.coreLiffId) && !CFG.coreLiffId.includes("ตั้งค่า");
  $("#btn-go-core").style.display = coreReady ? "" : "none";
  $("#core-missing").style.display = coreReady ? "none" : "";

  $$("[data-close]").forEach((b) => {
    if (!canCloseWindow()) b.style.display = "none";
  });
}

bind();
boot();
