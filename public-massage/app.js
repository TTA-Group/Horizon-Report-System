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
let openSlot = null; // รอบเวลาที่กางอยู่
let pick = null; // { slot, slotLabel, therapistId, therapistName }

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

    const cancelId = (params().get("cancel") || "").trim();
    await loadState();
    if (cancelId) return openCancel(cancelId);
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
    clearPick();
  }
}

async function selectDay(day) {
  currentDay = day;
  openSlot = null;
  clearPick();
  $$("#days .day").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.day === day)));
  $("#slots").innerHTML = `<div class="empty">กำลังตรวจสอบคิวว่าง...</div>`;
  try {
    availability = await api(`/api/massage/day?day=${encodeURIComponent(day)}`);
    renderSlots();
  } catch (e) {
    if (e && e.handled) return;
    $("#slots").innerHTML = `<div class="empty">${escapeHtml(e.message || "โหลดคิวไม่สำเร็จ")}</div>`;
  }
}

function renderSlots() {
  const th = availability.therapists;

  $("#slots").innerHTML = availability.rows
    .map((r) => {
      const free = r.bookable ? r.cells.filter((c) => !c.taken).length : 0;
      const closed = free === 0;
      const note = !r.bookable ? "เลยเวลาแล้ว" : closed ? "เต็มแล้ว" : `ว่าง ${free} คิว`;

      const list = r.cells
        .map((c) => {
          const name = th.find((t) => t.id === c.therapistId)?.name ?? "";
          const cls = c.mine ? "mine" : c.taken ? "taken" : "";
          const tag = c.mine ? "คิวของคุณ" : c.taken ? "จองแล้ว" : "ว่าง";
          const dis = c.taken || !r.bookable ? " disabled" : "";
          return `<button class="tbtn ${cls}" aria-pressed="false"${dis}
            data-slot="${escapeHtml(r.slot)}" data-th="${escapeHtml(c.therapistId)}">
            <span>${escapeHtml(name)}</span><span class="tag">${tag}</span></button>`;
        })
        .join("");

      return `<div class="slot${closed ? " full" : ""}" data-slot="${escapeHtml(r.slot)}">
        <button class="slothead" data-head="${escapeHtml(r.slot)}"${closed ? " disabled" : ""}>
          <span class="t">${escapeHtml(r.label)}</span>
          <span class="r"><span class="f">${note}</span><span class="caret"></span></span>
        </button>
        <div class="tlist">${list}</div>
      </div>`;
    })
    .join("");
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
    // กางหรือพับรอบเวลา
    const head = e.target.closest(".slothead");
    if (head && !head.disabled) {
      const slot = head.dataset.head;
      openSlot = openSlot === slot ? null : slot;
      $$("#slots .slot").forEach((el) => el.classList.toggle("on", el.dataset.slot === openSlot));
      if (pick && pick.slot !== openSlot) {
        $$("#slots .tbtn").forEach((x) => x.setAttribute("aria-pressed", "false"));
        clearPick();
      }
      return;
    }

    // เลือกหมอนวด
    const t = e.target.closest(".tbtn");
    if (!t || t.disabled) return;
    const already = t.getAttribute("aria-pressed") === "true";
    $$("#slots .tbtn").forEach((x) => x.setAttribute("aria-pressed", "false"));
    if (already) return clearPick();

    t.setAttribute("aria-pressed", "true");
    const row = availability.rows.find((r) => r.slot === t.dataset.slot);
    const who = availability.therapists.find((x) => x.id === t.dataset.th);
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
    const x = e.target.closest("[data-close]");
    if (x) closeWindow();
  });

  $("#btn-cancel-confirm").onclick = async () => {
    const id = $("#btn-cancel-confirm").dataset.id;
    if (id) await cancelBooking(id);
  };
  $("#btn-cancel-back").onclick = () => route();

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
