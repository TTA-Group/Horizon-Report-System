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
let queueDept = null; // ฝ่ายที่กำลังดูในหน้าคิวงาน (รหัสฝ่าย)
let queueFilter = ""; // ตัวกรองคิวงาน: "" | "pending" | "me"
let adminQ = ""; // คำค้นหน้าผู้ดูแล
let adminStatus = ""; // ตัวกรองสถานะหน้าผู้ดูแล
let detailReturnTab = "mine"; // แท็บที่จะกลับไปหลังปิดหน้ารายละเอียด
let sheetPick = null; // ตัวรับค่าเมื่อเลือกจาก bottom sheet

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
  const code = $("#empid").value.trim();
  if (!code) return toast("กรุณากรอกรหัสพนักงาน");
  if (!/^\d{5}$/.test(code)) return toast("รหัสพนักงานต้องเป็นตัวเลข 5 หลัก");
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
  // เผยแท็บตามสิทธิ์: เจ้าหน้าที่เห็น "คิวงาน", ผู้ดูแลเห็น "ผู้ดูแล"
  if (session.dept_roles && session.dept_roles.length) {
    $('.tabbar button[data-tab="queue"]').style.display = "";
    queueDept = session.dept_roles[0].code;
    renderQueueDepts();
  }
  if (session.is_admin) {
    $('.tabbar button[data-tab="admin"]').style.display = "";
  }
  goForm();
}

// ไอคอนของแต่ละหมวด (svg path เดียวกับต้นแบบ mockup) — ธีมสีคุมด้วย CSS (.cat .ic)
const CATEGORY_ICONS = {
  IT: '<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  FAC: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/></svg>',
  CLN: '<svg viewBox="0 0 24 24"><path d="M3 21h6l11-11a2.8 2.8 0 0 0-4-4L5 17z"/><path d="M14 4l6 6M6 15l3 3"/></svg>',
  GEN: '<svg viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/></svg>',
};

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
function renderQueueDepts() {
  const wrap = $("#queue-depts");
  const roles = session.dept_roles || [];
  if (roles.length <= 1) {
    wrap.style.display = "none";
    return;
  }
  const dm = new Map((masters.departments || []).map((d) => [d.code, d.name]));
  wrap.style.display = "flex";
  wrap.innerHTML = roles
    .map((r) => `<button class="chip" data-dept="${esc(r.code)}" aria-pressed="${r.code === queueDept}">${esc(dm.get(r.code) || r.code)}</button>`)
    .join("");
}

async function goQueue() {
  setTab("queue");
  show("s-queue");
  const list = $("#queueList");
  list.innerHTML = '<div class="empty">กำลังโหลด…</div>';
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
    actions = '<button class="fill" data-act="claim">รับเรื่อง</button><button data-act="transfer">ส่งต่อฝ่าย</button>';
  } else if (t.status === "in_progress") {
    actions = '<button class="fill" data-act="complete">แล้วเสร็จ</button><button data-act="transfer">ส่งต่อฝ่าย</button>';
  } else if (t.status === "completed") {
    actions = '<button class="fill" data-act="closed">ปิดเรื่อง</button>';
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

async function doStatus(id, to, okMsg) {
  try {
    await api(`/api/tickets/${id}/status`, { method: "PATCH", body: { to_status: to } });
    toast(okMsg || "อัปเดตสถานะเรียบร้อย");
    goQueue();
  } catch (e) {
    toast(e.message);
  }
}

async function openTransferSheet(id, currentDeptCode) {
  const opts = (masters.departments || [])
    .filter((d) => d.code !== currentDeptCode)
    .map((d) => ({ label: d.name, value: d.code }));
  if (!opts.length) return toast("ไม่มีฝ่ายให้ส่งต่อ");
  const to = await openSheet("ส่งต่อไปยังฝ่าย", opts);
  if (!to) return;
  try {
    await api(`/api/tickets/${id}/transfer`, { method: "PATCH", body: { to_dept: to } });
    toast("ส่งต่อเรียบร้อย");
    goQueue();
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- admin (ผู้ดูแล) ---------- */
async function goAdmin() {
  setTab("admin");
  show("s-admin");
  const list = $("#adminList");
  list.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  const params = new URLSearchParams();
  if (adminQ) params.set("q", adminQ);
  if (adminStatus) params.set("status", adminStatus);
  try {
    const r = await api("/api/admin/employees?" + params.toString());
    if (!r.employees.length) {
      list.innerHTML = '<div class="empty">ไม่พบผู้ใช้งาน</div>';
      return;
    }
    list.innerHTML = r.employees.map(renderEmployee).join("");
  } catch (e) {
    list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderEmployee(e) {
  const suspended = e.status === "suspended";
  const btn = suspended
    ? '<button class="fill" data-act="restore">คืนสิทธิ์การใช้งาน</button>'
    : '<button data-act="suspend">ระงับสิทธิ์</button>';
  return `<div class="card" data-id="${e.id}">
    <div class="cardtop">
      <div>
        <div class="tid">${esc(e.employee_code)}</div>
        <div class="ttl">${esc(e.full_name)}</div>
        <div class="meta">${esc(e.department_name || "-")}${e.floor ? " · " + esc(e.floor) : ""} · แจ้งเรื่องสะสม ${e.reported_count} รายการ${suspended && e.suspend_reason ? "<br>เหตุผล: " + esc(e.suspend_reason) : ""}</div>
      </div>
      <span class="pill ${suspended ? "p-suspend" : "p-done"}">${suspended ? "ระงับสิทธิ์" : "ใช้งานปกติ"}</span>
    </div>
    <div class="actions">${btn}</div>
  </div>`;
}

/* ---------- detail ---------- */
async function openDetail(id, fromTab) {
  detailReturnTab = fromTab || "mine";
  show("s-detail");
  $("#backbtn").style.display = "block";
  const body = $("#detailBody");
  body.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  try {
    const t = await api(`/api/tickets/${id}`);
    body.innerHTML = renderDetail(t);
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
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
    </div>
    ${shots ? `<div style="margin-top:10px">${shots}</div>` : ""}
    <div class="rail">${steps}</div>
  </div>`;
}

/* ---------- bottom sheet ---------- */
function openSheet(title, options) {
  return new Promise((resolve) => {
    sheetPick = resolve;
    $("#sheet-title").textContent = title;
    const c = $("#sheet-opts");
    c.innerHTML = "";
    options.forEach((o) => {
      const b = document.createElement("button");
      b.className = "opt";
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
  $$(".tabbar button").forEach((b) => (b.onclick = () => routeTab(b.dataset.tab)));

  // ปุ่มย้อนกลับจากหน้ารายละเอียด
  $("#backbtn").onclick = () => routeTab(detailReturnTab);

  // แตะการ์ดในหน้า "เรื่องที่แจ้ง" เพื่อดูรายละเอียด
  $("#mineList").addEventListener("click", (e) => {
    const card = e.target.closest(".card[data-id]");
    if (card) openDetail(card.dataset.id, "mine");
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
      if (act === "claim") doStatus(id, "in_progress", "รับเรื่องเรียบร้อย");
      else if (act === "complete") doStatus(id, "completed", "ปรับเป็นแล้วเสร็จเรียบร้อย");
      else if (act === "closed") doStatus(id, "closed", "ปิดเรื่องเรียบร้อย");
      else if (act === "transfer") openTransferSheet(id, card.dataset.dept);
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

  // ผู้ดูแล: ระงับ/คืนสิทธิ์ + ค้นหา + กรองสถานะ
  $("#adminList").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const card = e.target.closest(".card[data-id]");
    const id = card.dataset.id;
    try {
      if (btn.dataset.act === "suspend") {
        const reason = window.prompt("เหตุผลการระงับสิทธิ์ (ไม่บังคับ)") || "";
        await api(`/api/admin/employees/${id}/suspend`, { method: "PATCH", body: { action: "suspend", reason } });
        toast("ระงับสิทธิ์เรียบร้อย");
      } else {
        await api(`/api/admin/employees/${id}/suspend`, { method: "PATCH", body: { action: "restore" } });
        toast("คืนสิทธิ์เรียบร้อย");
      }
      goAdmin();
    } catch (err) {
      toast(err.message);
    }
  });
  $("#admin-q").addEventListener(
    "input",
    debounce(() => {
      adminQ = $("#admin-q").value.trim();
      goAdmin();
    }, 350),
  );
  $("#admin-filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-s]");
    if (!b) return;
    adminStatus = b.dataset.s;
    $$("#admin-filters .chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    goAdmin();
  });

  // bottom sheet ยกเลิก
  $("#sheet-cancel").onclick = () => finishSheet(null);
  $("#backdrop").onclick = () => finishSheet(null);

  boot();
});
