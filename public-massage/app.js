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

function show(id) {
  $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  window.scrollTo(0, 0);
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
function dialog({ icon = "warn", title, body = "", confirm = "ตกลง", cancel = null, danger = false }) {
  return new Promise((resolve) => {
    $("#m-ic").className = `ic ${icon}`;
    $("#m-ic").textContent = icon === "ok" ? "✓" : icon === "err" ? "✕" : "!";
    $("#m-title").textContent = title;
    $("#m-body").textContent = body;
    $("#m-body").style.display = body ? "" : "none";

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
    go.onclick = () => done(true);
    btns.appendChild(go);

    $("#backdrop").classList.add("on");
    $("#backdrop").onclick = (e) => {
      if (e.target === $("#backdrop")) done(false);
    };
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
    // เปิดจากปุ่ม "ฟอร์มเช็คชื่อคิวนวด" ในหน้าจัดการของระบบกลาง
    if (p.get("admin") === "1" && state.canManage) return goAdmin();
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

function goBook() {
  const emp = (session && session.employee) || {};
  $("#welcome").innerHTML = `สวัสดีคุณ ${escapeHtml(emp.full_name || "")}<small>${escapeHtml(
    emp.department_name || "",
  )}</small>`;

  const left = Math.max(0, state.quota - state.used);
  const q = $("#quota");
  q.className = left === 0 ? "quota out" : "quota";
  q.innerHTML =
    left === 0
      ? `เดือนนี้ใช้สิทธิ์ครบ <b>${state.quota}</b> ครั้งแล้ว`
      : `เดือนนี้เหลือสิทธิ์อีก <b>${left}</b> จาก <b>${state.quota}</b> ครั้ง`;

  const mine = activeBookings();
  $("#btn-mine").style.display = mine.length ? "" : "none";
  $("#btn-mine").textContent = `ดูคิวของฉัน (${mine.length})`;

  if (left === 0) return goMine({ justBooked: false });

  show("s-book");
  renderDays();
}

function renderDays() {
  // วันที่จองไปแล้วเลือกซ้ำไม่ได้ เพราะจองได้วันละคิวเดียว
  const booked = new Set(activeBookings().map((b) => b.day));

  $("#days").innerHTML = state.days
    .map((d) => {
      const mine = booked.has(d.day);
      const full = d.free === 0;
      const note = mine ? "จองแล้ว" : full ? "เต็มแล้ว" : `ว่าง ${d.free} คิว`;
      return `<button class="day" data-day="${escapeHtml(d.day)}" aria-pressed="false"${
        mine || full ? " disabled" : ""
      }>${escapeHtml(d.chip)}<small>${note}</small></button>`;
    })
    .join("");

  const first = state.days.find((d) => d.free > 0 && !booked.has(d.day));
  if (first) selectDay(first.day);
  else {
    currentDay = null;
    $("#slots").innerHTML = `<div class="empty">ไม่มีวันที่จองได้เหลืออยู่<br>ลองดูใหม่เดือนหน้าได้เลย</div>`;
    $("#legend").style.display = "none";
    clearPick();
  }
}

async function selectDay(day) {
  currentDay = day;
  clearPick();
  $$("#days .day").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.day === day)));
  $("#slots").innerHTML = `<div class="empty">กำลังตรวจสอบคิวว่าง...</div>`;
  $("#legend").style.display = "none";
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

  const head = `<tr><th class="tcol"></th>${th
    .map((t) => `<th>${headName(t.name)}</th>`)
    .join("")}</tr>`;

  const body = availability.rows
    .map((r) => {
      const cells = r.cells
        .map((c) => {
          // รอบที่เลยเวลาแล้วยังโชว์ไว้ให้เห็นภาพทั้งวัน แต่กดไม่ได้
          const label = c.mine ? "ของคุณ" : c.taken ? "จอง" : r.bookable ? "ว่าง" : "ปิด";
          const dis = c.taken || !r.bookable ? " disabled" : "";
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
}

function clearPick() {
  pick = null;
  $("#pickinfo").classList.remove("on");
  $("#btn-book").disabled = true;
}

function updatePick() {
  if (!pick) return clearPick();
  const day = state.days.find((d) => d.day === currentDay);
  $("#pickinfo").classList.add("on");
  $("#pickinfo").innerHTML = `<b>${escapeHtml(day ? day.label : currentDay)}</b><br>
    เวลา <b>${escapeHtml(pick.slotLabel)}</b><br>
    โดย <b>${escapeHtml(pick.therapistName)}</b>`;
  $("#btn-book").disabled = false;
}

/* ---------- จอง ---------- */

async function doBook() {
  if (!pick) return;
  const day = state.days.find((d) => d.day === currentDay);
  const okGo = await dialog({
    icon: "warn",
    title: "ยืนยันการจอง",
    body: `${day ? day.label : currentDay}\nเวลา ${pick.slotLabel}\n${pick.therapistName}`,
    confirm: "ยืนยัน",
    cancel: "แก้ไข",
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
    btn.textContent = "ยืนยันการจอง";
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
          (b) => `<div class="mycard${b.past ? " off" : ""}">
            <div class="myday">${escapeHtml(b.dayLabel)}</div>
            <div class="mytime">${escapeHtml(b.slotLabel)}</div>
            <div class="mywho">${escapeHtml(b.therapistName)}</div>
            ${
              b.cancellable
                ? `<button class="btn-cancel" data-cancel="${escapeHtml(b.id)}">ยกเลิกคิวนี้</button>`
                : `<div class="mynote">${
                    b.past ? "ผ่านไปแล้ว" : "เลยเวลายกเลิกแล้ว — ยกเลิกได้ถึงก่อนรอบเริ่ม 15 นาที"
                  }</div>`
            }
          </div>`,
        )
        .join("")
    : `<div class="empty">ยังไม่ได้จองคิวไหนไว้</div>`;

  const left = Math.max(0, state.quota - state.used);
  const more = $("#btn-book-more");
  more.style.display = state.open && left > 0 ? "" : "none";
  more.textContent = list.length ? `จองคิวเพิ่ม (เหลือสิทธิ์อีก ${left} ครั้ง)` : "ไปหน้าจองคิว";

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
    t.textContent = "คิวเต็มทุกช่วงเวลาแล้ว";
    b.innerHTML = "ขออภัยในความไม่สะดวก<br>คิวนวดของเดือนนี้ถูกจองเต็มทุกรอบแล้ว";
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
  $("#sheet-tally").innerHTML = `
    <div><b>${sheet.booked}</b>จองแล้ว</div>
    <div><b>${sheet.total - sheet.booked}</b>ว่าง</div>
    <div><b>${sheet.present}</b>มาแล้ว</div>
    <div><b>${sheet.noShow}</b>ไม่มา</div>`;

  const rows = [];
  for (const r of sheet.rows) {
    r.cells.forEach((c, i) => {
      if (!c.bookingId) return;
      const who = sheet.therapists[i];
      rows.push(`<div class="srow">
        <div class="head">
          <span class="t">${escapeHtml(r.label)}</span>
          <span class="who">${escapeHtml(who ? who.name : "")}</span>
        </div>
        <div class="nm">${escapeHtml(c.name || "")}</div>
        <div class="who">${escapeHtml(c.dept || "")}</div>
        <div class="acts">
          <button data-att="${escapeHtml(c.bookingId)}" data-v="present"
            aria-pressed="${c.attended === "present"}">มา</button>
          <button data-att="${escapeHtml(c.bookingId)}" data-v="no_show"
            aria-pressed="${c.attended === "no_show"}">ไม่มา</button>
        </div>
      </div>`);
    });
  }
  $("#sheet-rows").innerHTML = rows.length
    ? rows.join("")
    : `<div class="empty">วันนี้ยังไม่มีใครจองคิว</div>`;
  show("s-admin");
}

async function markAttend(id, value) {
  // กดปุ่มเดิมซ้ำ = ล้างการเช็คกลับไปเป็นยังไม่ได้เช็ค
  const cell = sheet.rows.flatMap((r) => r.cells).find((c) => c.bookingId === id);
  const next = cell && cell.attended === value ? null : value;
  try {
    await api("/api/massage/admin/attend", { method: "POST", body: { id, attended: next } });
    await goAdmin(sheet.day);
  } catch (e) {
    if (e && e.handled) return;
    toast(e.message || "บันทึกไม่สำเร็จ");
  }
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

function bind() {
  // โลโก้: ใช้ไฟล์ถ้ามี ถ้าไม่มีคงตัวอักษรไว้
  const logo = $("#logo");
  logo.onload = () => {
    logo.style.display = "";
    $("#wordmark").style.display = "none";
  };
  logo.onerror = () => logo.remove();

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
  $("#btn-mine").onclick = () => goMine({ justBooked: false });
  $("#closed-mine").onclick = () => goMine({ justBooked: false });
  $("#btn-book-more").onclick = () => goBook();
  $("#btn-mine-close").onclick = closeWindow;

  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-cancel]");
    if (c) cancelBooking(c.dataset.cancel);
    const a = e.target.closest("[data-att]");
    if (a) markAttend(a.dataset.att, a.dataset.v);
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
