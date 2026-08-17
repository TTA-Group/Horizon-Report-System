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
let adminView = "active"; // หน้าที่กำลังดูในผู้ดูแล: "active" (พนักงานปัจจุบัน) | "suspended" (ถูกระงับสิทธิ์)
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
      // ถ้าองค์กรกำหนดโดเมนอีเมลไว้ อีเมลจะกลายเป็นช่องบังคับ (ใช้ยืนยันว่าเป็นคนในองค์กร)
      const domains = (await getMasters().catch(() => null))?.company_email_domains || [];
      if (domains.length) {
        $("#m-mail-label").innerHTML = 'อีเมลบริษัท <span>*</span>';
        $("#m-mail").placeholder = "xxxx@" + domains[0];
      }
      showRegPart("reg-manual");
      return;
    }
    if (r.already_linked) return toast("รหัสพนักงานนี้ผูกกับบัญชี LINE อื่นแล้ว กรุณาติดต่อฝ่ายทรัพยากรบุคคล");
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
    toast("ยืนยันตัวตนเรียบร้อยแล้ว");
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
  if (!body.full_name || !body.department_name) return toast("กรุณากรอกชื่อ–นามสกุล และเลือกฝ่าย/แผนก");

  // ผู้ที่ไม่มีรหัสในระบบต้องยืนยันด้วยอีเมลบริษัท (เซิร์ฟเวอร์ตรวจซ้ำอีกชั้นเสมอ)
  const domains = (await getMasters().catch(() => null))?.company_email_domains || [];
  if (domains.length) {
    const label = "@" + domains.join(" หรือ @");
    if (!body.email) return toast(`กรุณากรอกอีเมลบริษัท (${label})`);
    const at = body.email.lastIndexOf("@");
    const domain = at > 0 ? body.email.slice(at + 1).toLowerCase() : "";
    if (!domains.includes(domain)) return toast(`กรุณาใช้อีเมลบริษัท (${label}) เท่านั้น`);
  }

  try {
    await api("/api/auth/link", { method: "POST", body });
    session = await api("/api/auth/session", { method: "POST" });
    toast("บันทึกข้อมูลเรียบร้อยแล้ว สามารถเริ่มใช้งานได้ทันที");
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
      await getMasters();
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
      toast(`ส่งเรื่องเรียบร้อยแล้ว เลขที่ <b>${r.ticket_no}</b>`);
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
    .filter((d) => d.code !== currentDeptCode)
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
async function goAdmin() {
  setTab("admin");
  show("s-admin");
  const list = $("#adminList");
  list.innerHTML = '<div class="empty">กำลังโหลดข้อมูล…</div>';
  const params = new URLSearchParams();
  if (adminQ) params.set("q", adminQ);
  try {
    params.set("status", adminView);
    const r = await api("/api/admin/employees?" + params.toString());
    const rows = r.employees.length
      ? r.employees.map(renderEmployee).join("")
      : `<div class="empty">${adminView === "active" ? "ไม่พบข้อมูลพนักงาน" : "ไม่มีรายชื่อผู้ถูกระงับสิทธิ์"}</div>`;

    // แยกเป็นคนละหน้า: หน้าหลักคือพนักงานปัจจุบันเท่านั้น ส่วนคนที่ถูกระงับ (เช่น ลาออกแล้ว)
    // อยู่อีกหน้า เข้าถึงผ่านลิงก์เล็ก ๆ ด้านล่าง ไม่ปนกันและไม่เด่นในหน้าหลัก
    list.innerHTML =
      adminView === "active"
        ? `<div id="admin-rows">${rows}</div>
           <button class="linkbtn" id="admin-toggle">รายชื่อผู้ถูกระงับสิทธิ์ →</button>`
        : `<button class="linkbtn" id="admin-toggle">← กลับไปรายชื่อพนักงานปัจจุบัน</button>
           <div class="section">ระงับสิทธิ์</div>
           <div id="admin-rows">${rows}</div>`;
  } catch (e) {
    list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// หลังระงับ/คืนสิทธิ์ พนักงานคนนั้นจะไปอยู่อีกหน้าหนึ่ง จึงเอาการ์ดออกจากหน้าปัจจุบันทันที
function removeEmployeeCard(card) {
  const rows = $("#admin-rows");
  card.remove();
  if (rows && !rows.children.length) {
    rows.innerHTML = `<div class="empty">${adminView === "active" ? "ไม่พบข้อมูลพนักงาน" : "ไม่มีรายชื่อผู้ถูกระงับสิทธิ์"}</div>`;
  }
}

function renderEmployee(e) {
  const suspended = e.status === "suspended";
  const btn = suspended
    ? '<button class="fill" data-act="restore">คืนสิทธิ์การใช้งาน</button>'
    : '<button data-act="suspend">ระงับสิทธิ์</button>';
  // ปุ่มปลดการผูกบัญชีไลน์ แสดงเฉพาะคนที่ผูกไว้แล้ว (ใช้ตอนพนักงานเปลี่ยนมือถือ/บัญชีไลน์)
  const unlinkBtn = e.linked ? '<button data-act="unlink">ปลดการผูกบัญชี</button>' : "";
  return `<div class="card" data-id="${e.id}">
    <div class="cardtop">
      <div>
        <div class="tid">${esc(e.employee_code)}${e.linked ? "" : " · ยังไม่ได้ผูกบัญชี LINE"}</div>
        <div class="ttl">${esc(e.full_name)}</div>
        <div class="meta">${esc(e.department_name || "-")}${e.floor ? " · " + esc(e.floor) : ""} · แจ้งเรื่องสะสม ${e.reported_count} รายการ${suspended && e.suspend_reason ? "<br>เหตุผล: " + esc(e.suspend_reason) : ""}</div>
      </div>
    </div>
    <div class="actions">${btn}${unlinkBtn}</div>
  </div>`;
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

/* ---------- หน้าต่างยืนยัน ----------
 * ใช้แทน window.confirm เพราะหน้าต่างของเบราว์เซอร์แต่งข้อความไม่ได้
 * และมีบรรทัดชื่อเว็บติดมาด้วยเสมอ
 */
let confirmResolve = null;
let modalHasInput = false;

function openModal({ title, message = "", confirmLabel = "ยืนยัน", cancelLabel = "ไม่ใช่", input = null }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    modalHasInput = !!input;
    $("#modal-title").textContent = title;
    const msg = $("#modal-msg");
    msg.textContent = message;
    msg.style.display = message ? "" : "none";

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
  $("#btn-manual").onclick = submitManual;
  $("#btn-manual-back").onclick = () => showRegPart("reg-input");
  $("#sendBtn").onclick = submitTicket;
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
      else if (act === "closed") doStatus(id, "closed", "ปิดเรื่องเรียบร้อยแล้ว");
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

  // ผู้ดูแล: สลับหน้า + ระงับ/คืนสิทธิ์
  $("#adminList").addEventListener("click", async (e) => {
    // สลับระหว่างหน้า "พนักงานปัจจุบัน" กับ "ถูกระงับสิทธิ์"
    if (e.target.closest("#admin-toggle")) {
      adminView = adminView === "active" ? "suspended" : "active";
      goAdmin();
      return;
    }

    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const card = e.target.closest(".card[data-id]");
    const id = card.dataset.id;
    const act = btn.dataset.act;
    try {
      if (act === "unlink") {
        const name = card.querySelector(".ttl")?.textContent || "พนักงานคนนี้";
        const ok = await confirmDialog({
          title: `ปลดการผูกบัญชีของ ${name}?`,
          message: "พนักงานต้องยืนยันตัวตนด้วยรหัสพนักงานอีกครั้ง ข้อมูลเรื่องที่เคยแจ้งไว้ยังคงอยู่ครบถ้วน",
          confirmLabel: "ปลดการผูกบัญชี",
          cancelLabel: "ไม่ใช่",
        });
        if (!ok) return;
        await api(`/api/admin/employees/${id}/unlink`, { method: "PATCH" });
        toast("ปลดการผูกบัญชี LINE เรียบร้อยแล้ว");
        goAdmin();
        return;
      }
      if (act === "suspend") {
        const name = card.querySelector(".ttl")?.textContent || "พนักงานคนนี้";
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
      } else {
        await api(`/api/admin/employees/${id}/suspend`, { method: "PATCH", body: { action: "restore" } });
        toast("คืนสิทธิ์เรียบร้อยแล้ว · ย้ายไปรายชื่อพนักงานปัจจุบัน");
      }
      removeEmployeeCard(card);
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
