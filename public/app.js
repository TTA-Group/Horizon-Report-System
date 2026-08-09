/* Horizon Report System — LIFF frontend logic
 * ครอบคลุมกระแสงานหลักของพนักงาน: ยืนยันตัวตน -> แจ้งเรื่อง -> ติดตามสถานะ
 * (หน้าเจ้าหน้าที่/ผู้ดูแลใช้ API ชุดเดียวกัน สามารถต่อยอดเพิ่มได้)
 */
const CFG = window.APP_CONFIG || {};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let idToken = null;
let masters = null;
let session = null;
let picked = null; // ปุ่มหมวดที่เลือก
let pendingFiles = []; // ไฟล์แนบที่บีบอัดแล้ว { base64, type }

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
  if (!res.ok) throw new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
  return data;
}

function show(id) {
  $$(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.innerHTML = msg;
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
    session = await api("/api/auth/session", { method: "POST" });
    routeBySession();
  } catch (e) {
    $("#err-msg").textContent = e.message || String(e);
    show("s-error");
  }
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
  ["reg-input", "reg-found", "reg-manual"].forEach((x) => {
    $("#" + x).style.display = x === id ? "block" : "none";
  });
}

async function checkEmp() {
  const code = $("#empid").value.trim().toUpperCase();
  if (!code) return toast("กรุณากรอกรหัสพนักงาน");
  try {
    const r = await api("/api/auth/verify-employee", { method: "POST", body: { employee_code: code } });
    if (!r.found) {
      $("#m-id").value = code;
      showRegPart("reg-manual");
      return;
    }
    if (r.already_linked) return toast("รหัสนี้ถูกผูกกับบัญชี LINE อื่นแล้ว กรุณาติดต่อฝ่ายทรัพยากรบุคคล");
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

async function confirmFound() {
  const code = $("#reg-found").dataset.code;
  try {
    await api("/api/auth/link", { method: "POST", body: { employee_code: code } });
    session = await api("/api/auth/session", { method: "POST" });
    toast("ยืนยันตัวตนเรียบร้อย");
    enterApp();
  } catch (e) {
    toast(e.message);
  }
}

async function submitManual() {
  const body = {
    employee_code: $("#m-id").value.trim().toUpperCase(),
    full_name: $("#m-name").value.trim(),
    department_name: $("#m-dept").value,
    floor: $("#m-floor").value,
    email: $("#m-mail").value.trim(),
  };
  if (!body.full_name || !body.department_name) return toast("กรุณากรอกชื่อ–สกุล และเลือกฝ่าย/แผนก");
  try {
    await api("/api/auth/link", { method: "POST", body });
    session = await api("/api/auth/session", { method: "POST" });
    toast("ยืนยันตัวตนเรียบร้อย เริ่มแจ้งเรื่องได้ทันที");
    enterApp();
  } catch (e) {
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
      masters = await api("/api/masters");
      renderMasters();
    } catch (e) {
      toast(e.message);
    }
  }
  goForm();
}

function renderMasters() {
  // หมวด
  const cats = $("#cats");
  cats.innerHTML = "";
  masters.categories.forEach((c) => {
    const b = document.createElement("button");
    b.className = "cat";
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.dataset.code = c.code;
    b.innerHTML = `<span class="nm">${c.label}</span>`;
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
  // ชั้น
  const fl = $("#floor");
  fl.innerHTML = '<option value="">เลือกชั้น</option>' + masters.floors.map((f) => `<option>${f}</option>`).join("");
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
  const floor = $("#floor").value;
  const detail = $("#detail").value.trim();
  if (!floor) return toast("กรุณาเลือกชั้นที่เกิดเหตุ");
  if (!detail) return toast("กรุณาระบุรายละเอียดของปัญหา");

  const btn = $("#sendBtn");
  btn.disabled = true;
  btn.textContent = "กำลังส่ง…";
  try {
    // อัปโหลดไฟล์แนบ (best-effort — ถ้ายังไม่ตั้งค่าที่เก็บไฟล์จะข้ามไป)
    const attachments = [];
    for (const f of pendingFiles) {
      try {
        const up = await api("/api/uploads", {
          method: "POST",
          body: { content_type: f.type, content_base64: f.base64, filename: "photo" },
        });
        if (up.url) attachments.push(up.url);
      } catch {
        /* ข้ามไฟล์ที่อัปโหลดไม่สำเร็จ */
      }
    }

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
    toast(`ส่งเรื่องเรียบร้อย เลขที่ <b>${r.ticket_no}</b>`);
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
  list.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  try {
    const r = await api("/api/tickets/mine");
    if (!r.tickets.length) {
      list.innerHTML = '<div class="empty">ยังไม่มีเรื่องที่แจ้ง</div>';
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
  return `<div class="card">
    <div class="cardtop">
      <div>
        <div class="tid">${esc(t.ticket_no)}</div>
        <div class="ttl">${esc(t.detail)}</div>
        <div class="meta">${esc(t.category_label)} · ${esc(t.floor)}${t.location_note ? " · " + esc(t.location_note) : ""}</div>
      </div>
      <span class="pill ${PILL[t.status] || "p-closed"}">${esc(t.status_label)}</span>
    </div>
    <div class="rail">${steps}</div>
  </div>`;
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
      const d = document.createElement("div");
      d.className = "thumb";
      d.textContent = "🖼";
      $("#thumbs").appendChild(d);
    } catch {
      toast("อ่านไฟล์ภาพไม่สำเร็จ");
    }
  }
  input.value = "";
}

/* ---------- wire up ---------- */
window.addEventListener("DOMContentLoaded", () => {
  $("#btn-check").onclick = checkEmp;
  $("#btn-confirm-found").onclick = confirmFound;
  $("#btn-not-me").onclick = () => showRegPart("reg-input");
  $("#btn-manual").onclick = submitManual;
  $("#btn-manual-back").onclick = () => showRegPart("reg-input");
  $("#sendBtn").onclick = submitTicket;
  $("#file").onchange = (e) => onPickFiles(e.target);
  $$(".tabbar button").forEach((b) => (b.onclick = () => (b.dataset.tab === "form" ? goForm() : goMine())));
  boot();
});
