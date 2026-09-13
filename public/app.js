/* Finanzierung — منطق سمت کلاینت */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const CURRENCIES = [
  { code: "IRT", label: "تومان", sym: "تومان", dec: 0 },
  { code: "IRR", label: "ریال", sym: "﷼", dec: 0 },
  { code: "EUR", label: "یورو", sym: "€", dec: 2 },
  { code: "USD", label: "دلار", sym: "$", dec: 2 },
  { code: "TRY", label: "لیر", sym: "₺", dec: 2 },
];

const state = {
  month: currentMonth(),
  currency: localStorage.getItem("fin_currency") || "IRT",
  pockets: [],
  user: null,
};

const tg = window.Telegram?.WebApp;
const inTelegram = !!(tg && tg.initData && tg.initData.length > 10);

function currentMonth() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function today() { return new Date().toISOString().slice(0, 10); }

/* ---- ارقام و قالب‌بندی ---- */
function toEnDigits(s) {
  return String(s).replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}
function parseNum(v) { const n = Number(toEnDigits(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : NaN; }
function curBy(code) { return CURRENCIES.find((c) => c.code === code) || CURRENCIES[0]; }
function cur() { return curBy(state.currency); }
function fmtNumC(n, code) { const c = curBy(code); return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: c.dec }).format(Number(n) || 0); }
function fmtNum(n) { return fmtNumC(n, state.currency); }
function fmtC(n, code) { return `${fmtNumC(n, code)} ${curBy(code).sym}`; }
function fmt(n) { return fmtC(n, state.currency); }
function fmtSigned(n, sign) { return `${sign}${fmtNum(Math.abs(n))}`; }
function faPct(n) { return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 }).format(Number(n) || 0) + "٪"; }
function faInt(n) { return new Intl.NumberFormat("fa-IR").format(Number(n) || 0); }
function faDate(iso) { try { return new Intl.DateTimeFormat("fa-IR", { day: "numeric", month: "long" }).format(new Date(iso)); } catch { return iso; } }
function monthLabel(m) { try { const [y, mo] = m.split("-").map(Number); return new Intl.DateTimeFormat("fa-IR", { year: "numeric", month: "long" }).format(new Date(y, mo - 1, 1)); } catch { return m; } }
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function personName(o) { return o.name || o.display_name || (o.username || o.telegram_username ? "@" + (o.username || o.telegram_username) : null) || o.email || "کاربر"; }

/* ---- صف آفلاین ---- */
const QKEY = "fin_queue";
function loadQueue() { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch { return []; } }
function saveQueue(q) { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch {} }
function enqueue(item) { const q = loadQueue(); q.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), ...item }); saveQueue(q); }
function queueCount() { return loadQueue().length; }

/* ---- API ---- */
class AuthError extends Error {}
async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  // آفلاین + نوشتن → در صف بگذار و بعداً همگام کن
  if (method !== "GET" && !path.startsWith("/auth/") && !navigator.onLine) {
    enqueue({ method, path, body: options.body || null });
    updateSyncUI();
    return { queued: true };
  }
  let res;
  try {
    res = await fetch("/api" + path, { headers: { "content-type": "application/json" }, credentials: "same-origin", ...options });
  } catch (e) {
    // خطای شبکه: نوشتن‌ها را صف کن، خواندن‌ها خطا بده
    if (method !== "GET" && !path.startsWith("/auth/")) { enqueue({ method, path, body: options.body || null }); updateSyncUI(); return { queued: true }; }
    throw new Error("آفلاین — به اینترنت وصل نیستید");
  }
  if (res.status === 401 && !path.startsWith("/auth/")) throw new AuthError("نیازمند ورود");
  if (!res.ok) {
    let m = "خطا در ارتباط با سرور", detail = "";
    try { const j = await res.json(); m = j.error || m; detail = j.detail || ""; } catch {}
    if (res.status === 503) throw new Error("آفلاین — داده‌ی ذخیره‌شده نمایش داده می‌شود");
    if (detail) { console.error("API error", path, res.status, detail); m = m + " — " + detail; }
    const e = new Error(m); e.status = res.status; throw e;
  }
  return res.status === 204 ? null : res.json();
}

/* ---- همگام‌سازی صف با سرور ---- */
let flushing = false;
async function flushQueue() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    let q = loadQueue();
    while (q.length) {
      const item = q[0];
      let res;
      try {
        res = await fetch("/api" + item.path, { method: item.method, headers: { "content-type": "application/json" }, credentials: "same-origin", body: item.body || undefined });
      } catch { break; } // هنوز آفلاین → بعداً دوباره تلاش کن
      if (!res.ok && res.status >= 500) break; // خطای سرور → بعداً
      q.shift(); saveQueue(q); // موفق یا خطای ۴xx (غیرقابل‌تکرار) → از صف بردار
    }
  } finally { flushing = false; }
  updateSyncUI();
  if (queueCount() === 0) { toast("همگام‌سازی شد ✅"); refresh(); }
}
function updateSyncUI() {
  const el = $("#syncBadge"); if (!el) return;
  const n = queueCount();
  if (!navigator.onLine) {
    el.hidden = false;
    el.className = "text-[10px] font-black px-2 py-1 rounded-full bg-red-50 text-red-600 flex items-center gap-1";
    el.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> ${n ? faInt(n) + " در صف" : "آفلاین"}`;
  } else if (n > 0) {
    el.hidden = false;
    el.className = "text-[10px] font-black px-2 py-1 rounded-full bg-amber-50 text-amber-600 flex items-center gap-1";
    el.innerHTML = `<i class="fa-solid fa-rotate"></i> ${faInt(n)} در حال همگام‌سازی`;
  } else { el.hidden = true; }
}
window.addEventListener("online", () => { updateSyncUI(); flushQueue(); });
window.addEventListener("offline", updateSyncUI);

/* ---- توست ---- */
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600); }

/* ---- مودال ---- */
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
document.body.addEventListener("click", (e) => { const c = e.target.closest("[data-close]"); if (c) { const m = c.closest(".fixed.z-50"); if (m) m.hidden = true; } });

/* ============ داشبورد ============ */
async function refresh() {
  try {
    const q = `currency=${state.currency}`;
    const [p, s, t] = await Promise.all([
      api(`/pockets?${q}&month=${state.month}`),
      api(`/summary?${q}&month=${state.month}`),
      api(`/transactions?${q}&month=${state.month}&limit=20`),
    ]);
    state.pockets = p.pockets;
    renderSummary(s);
    renderPockets(p.pockets);
    renderTx(t.transactions);
  } catch (err) {
    if (err instanceof AuthError) return showAuth();
    toast(err.message);
  }
}

function renderSummary(s) {
  const net = s.net_balance != null ? s.net_balance : s.balance;
  $("#sumBalance").textContent = fmt(net);
  $("#sumBalance").className = "text-base font-extrabold tracking-tighter " + (net < 0 ? "text-red-500" : "text-brand-700");
  $("#sumIncome").textContent = fmtSigned(s.period_income, "+") + " " + cur().sym;
  $("#sumExpense").textContent = fmtSigned(s.period_expense, "−") + " " + cur().sym;
  const note = $("#balanceNote");
  const lent = s.lent_outstanding || 0, borrowed = s.borrowed_outstanding || 0;
  if (lent > 0 || borrowed > 0) {
    note.hidden = false;
    note.innerHTML =
      (lent > 0 ? `<span class="text-red-500">− قرض داده ${fmtNum(lent)}</span>` : "") +
      (borrowed > 0 ? `<span class="text-emerald-600">+ قرض گرفته ${fmtNum(borrowed)}</span>` : "");
  } else note.hidden = true;
}

function renderPockets(pockets) {
  $("#pocketCount").textContent = `${faInt(pockets.length)} پاکت`;
  $("#pocketsEmpty").hidden = pockets.length > 0;
  $("#pockets").innerHTML = pockets.map(pocketCard).join("");
}

function pocketCard(p) {
  const allocated = p.period_income, spent = p.period_expense, remaining = allocated - spent, over = spent > allocated;
  const pct = allocated > 0 ? Math.min(100, Math.round((spent / allocated) * 100)) : 0;
  const pctLabel = p.min_percent === p.max_percent ? faPct(p.min_percent) : `${faPct(p.min_percent)}–${faPct(p.max_percent)}`;
  const balClass = p.balance < 0 ? "text-red-500" : "text-brand-700";
  const sharedBadge = p.is_shared ? `<span class="text-[10px] font-black text-brand bg-brand/10 px-2 py-0.5 rounded-full flex items-center gap-1"><i class="fa-solid fa-user-group text-[9px]"></i> مشترک · ${faInt(p.member_count)}</span>` : "";
  const progress = allocated > 0 ? `
    <div class="space-y-1.5 mb-5">
      <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden"><div class="h-full rounded-full ${over ? "bg-red-500" : "bg-brand-500"}" style="width:${over ? 100 : pct}%"></div></div>
      <div class="flex justify-between text-[10px] font-bold ${over ? "text-red-600" : "text-muted"}">
        <span>${over ? "بیش از بودجه ماهانه" : `${faPct(pct)} از بودجه ماهانه`}</span>
        <span>${over ? `${fmtNum(Math.abs(remaining))} کسر بودجه` : `${fmtNum(remaining)} مانده`}</span>
      </div>
    </div>` : `<div class="mb-5"><div class="w-full h-2 bg-slate-100 rounded-full"></div><p class="text-[10px] font-bold text-muted mt-1.5">این ماه هنوز بودجه‌ای دریافت نشده</p></div>`;
  return `
  <div class="bg-white rounded-[24px] p-5 border border-slate-100 shadow-sm relative overflow-hidden">
    <div class="flex items-start justify-between mb-4">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-2xl shadow-inner">${escapeHtml(p.emoji)}</div>
        <div>
          <div class="flex items-center gap-2 flex-wrap"><h3 class="text-sm font-extrabold text-ink leading-tight">${escapeHtml(p.name)}</h3>${sharedBadge}</div>
          <p class="text-[10px] font-bold text-muted mt-0.5">هدف پیشنهادی: ${pctLabel}</p>
        </div>
      </div>
      <button class="w-8 h-8 flex items-center justify-center text-muted hover:text-ink" data-edit="${p.id}"><i class="fa-solid fa-ellipsis-vertical"></i></button>
    </div>
    <div class="flex items-baseline justify-between mb-4">
      <span class="text-xs font-bold text-muted">مانده کل</span>
      <span class="text-2xl font-black tracking-tighter ${balClass}">${fmtNum(p.balance)} <span class="text-[10px] font-bold text-muted mr-1">${cur().sym}</span></span>
    </div>
    ${progress}
    <div class="grid grid-cols-2 gap-3">
      <div class="bg-emerald-50/50 rounded-xl p-2.5 flex flex-col gap-0.5"><span class="text-[9px] font-bold text-emerald-700">ورودی این ماه</span><span class="text-xs font-black text-emerald-600">${fmtSigned(p.period_income, "+")}</span></div>
      <div class="bg-red-50/50 rounded-xl p-2.5 flex flex-col gap-0.5"><span class="text-[9px] font-bold text-red-700">خروجی این ماه</span><span class="text-xs font-black text-red-500">${fmtSigned(p.period_expense, "−")}</span></div>
    </div>
    <div class="grid grid-cols-2 gap-3 mt-4">
      <button class="h-10 bg-slate-50 hover:bg-slate-100 rounded-xl flex items-center justify-center gap-2 text-xs font-bold transition-colors" data-add-expense="${p.id}"><i class="fa-solid fa-minus text-[10px] text-red-500"></i> خروجی</button>
      <button class="h-10 bg-slate-50 hover:bg-slate-100 rounded-xl flex items-center justify-center gap-2 text-xs font-bold transition-colors" data-add-income="${p.id}"><i class="fa-solid fa-plus text-[10px] text-emerald-600"></i> ورودی</button>
    </div>
  </div>`;
}

function renderTx(list) {
  $("#txEmpty").hidden = list.length > 0;
  $("#txList").innerHTML = list.map((t) => {
    const inc = t.type === "income";
    const who = t.mine ? "" : ` · ${escapeHtml(personName({ display_name: t.author_name, telegram_username: t.author_username }))}`;
    return `
    <div class="bg-white rounded-2xl p-4 border border-slate-100 flex items-center gap-3">
      <div class="w-10 h-10 bg-slate-50 rounded-xl flex items-center justify-center text-lg">${escapeHtml(t.pocket_emoji)}</div>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-extrabold text-ink leading-tight truncate">${escapeHtml(t.note || t.pocket_name)}</p>
        <p class="text-[10px] font-bold text-muted mt-0.5">${escapeHtml(t.pocket_name)} · ${faDate(t.occurred_on)}${who}</p>
      </div>
      <span class="text-xs font-black tracking-tighter ${inc ? "text-emerald-600" : "text-red-500"}">${fmtSigned(t.amount, inc ? "+" : "−")}</span>
      <button class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-red-500 transition-colors" data-del-tx="${t.id}"><i class="fa-solid fa-trash-can text-[11px]"></i></button>
    </div>`;
  }).join("");
}

$("#seedDefaultsBtn").addEventListener("click", async () => {
  try { await api("/pockets/seed-defaults", { method: "POST", body: JSON.stringify({ currency: state.currency }) }); toast("پاکت‌های پیش‌فرض ساخته شد ✅"); refresh(); }
  catch (err) { toast(err.message); }
});

/* ============ مودال تراکنش ============ */
let txType = "expense";
function setTxType(type) {
  txType = type;
  $$("#txForm .txtype-btn").forEach((b) => {
    const a = b.dataset.txtype === type;
    b.className = "txtype-btn h-11 rounded-xl text-xs font-black flex items-center justify-center gap-2 transition-all " + (a ? (type === "income" ? "bg-emerald-500 text-white shadow" : "bg-red-500 text-white shadow") : "text-muted");
  });
}
function openTx(type = "expense", pocketId = null) {
  if (!state.pockets.length) return toast("ابتدا یک پاکت بسازید");
  setTxType(type);
  $("#txModalTitle").textContent = "ثبت تراکنش";
  $("#txPocket").innerHTML = state.pockets.map((p) => `<option value="${p.id}" ${String(p.id) === String(pocketId) ? "selected" : ""}>${p.emoji} ${escapeHtml(p.name)}</option>`).join("");
  $("#txAmount").value = ""; $("#txNote").value = ""; $("#txDate").value = today();
  openModal("#txModal");
  setTimeout(() => $("#txAmount").focus(), 60);
}
$$("#txForm .txtype-btn").forEach((b) => b.addEventListener("click", () => setTxType(b.dataset.txtype)));
$("#txForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { pocket_id: Number($("#txPocket").value), type: txType, amount: parseNum($("#txAmount").value), note: $("#txNote").value.trim(), occurred_on: $("#txDate").value };
  if (!(body.amount >= 0)) return toast("مبلغ نامعتبر است");
  try { const r = await api("/transactions", { method: "POST", body: JSON.stringify(body) }); closeModal("#txModal"); toast(r?.queued ? "آفلاین: ثبت شد، بعداً همگام می‌شود ⏳" : "ثبت شد ✅"); refresh(); }
  catch (err) { toast(err.message); }
});

/* ============ مودال پاکت (+ اشتراک‌گذاری) ============ */
let editingPocket = null;
function openPocket(pocket = null) {
  editingPocket = pocket;
  const isOwner = pocket ? pocket.is_owner : true;
  $("#pocketModalTitle").textContent = pocket ? (isOwner ? "ویرایش پاکت" : "پاکت مشترک") : "پاکت جدید";
  $("#pocketId").value = pocket ? pocket.id : "";
  $("#pocketEmoji").value = pocket ? pocket.emoji : "💰";
  $("#pocketName").value = pocket ? pocket.name : "";
  $("#pocketMin").value = pocket ? pocket.min_percent : 0;
  $("#pocketMax").value = pocket ? pocket.max_percent : 0;
  $("#pocketKind").value = pocket ? (pocket.kind || "discretionary") : "discretionary";
  ["#pocketEmoji", "#pocketName", "#pocketMin", "#pocketMax", "#pocketKind"].forEach((s) => ($(s).disabled = !isOwner));
  $("#pocketDelete").hidden = !pocket || !isOwner;
  $("#pocketOwnerActions").hidden = !isOwner;
  // بخش اعضا برای هر پاکت موجود نمایش داده می‌شود (سهم هرکس)؛ افزودن عضو فقط برای مالک
  $("#pocketShare").hidden = !pocket;
  $("#shareAddRow").hidden = !(pocket && isOwner);
  $("#pocketLeave").hidden = !(pocket && !isOwner);
  if (pocket) loadMembers(pocket.id, isOwner);
  openModal("#pocketModal");
}
async function loadMembers(pocketId, isOwner) {
  try {
    const { members } = await api(`/pockets/${pocketId}/members`);
    $("#pocketMembers").innerHTML = members.map((m) => {
      const name = personName(m);
      const canRemove = isOwner && m.role !== "owner";
      const roleTag = m.role === "owner" ? `<span class="text-[9px] font-black text-brand bg-brand/10 px-1.5 py-0.5 rounded-full">مالک</span>` : "";
      const avatar = m.telegram_photo_url
        ? `<img src="${escapeHtml(m.telegram_photo_url)}" class="w-8 h-8 rounded-lg object-cover" referrerpolicy="no-referrer">`
        : `<div class="w-8 h-8 rounded-lg bg-brand/10 text-brand font-black flex items-center justify-center text-xs">${escapeHtml((name.replace(/^@/, "")[0] || "؟").toUpperCase())}</div>`;
      const netClass = m.net < 0 ? "text-red-500" : "text-brand-700";
      return `<div class="bg-slate-50 rounded-xl px-3 py-2.5 space-y-1.5">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-ink flex items-center gap-2">${avatar}<span>${escapeHtml(name)}${m.is_me ? " (شما)" : ""}</span> ${roleTag}</span>
          ${canRemove ? `<button class="text-red-400 hover:text-red-600 text-xs" data-remove-member="${m.id}"><i class="fa-solid fa-user-minus"></i></button>` : ""}
        </div>
        <div class="flex items-center justify-between text-[10px] font-bold pr-10">
          <span class="text-emerald-600">ورودی ${fmtSigned(m.income, "+")}</span>
          <span class="text-red-500">خروجی ${fmtSigned(m.expense, "−")}</span>
          <span class="${netClass}">سهم خالص ${fmtNum(m.net)}</span>
        </div>
      </div>`;
    }).join("");
  } catch (err) { $("#pocketMembers").innerHTML = ""; }
}
$("#pocketForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#pocketId").value;
  const body = { name: $("#pocketName").value.trim(), emoji: $("#pocketEmoji").value.trim() || "💰", min_percent: Number($("#pocketMin").value) || 0, max_percent: Number($("#pocketMax").value) || 0, kind: $("#pocketKind").value };
  if (!body.name) return toast("نام پاکت الزامی است");
  try {
    if (id) await api(`/pockets/${id}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/pockets", { method: "POST", body: JSON.stringify({ ...body, currency: state.currency }) });
    closeModal("#pocketModal"); toast("ذخیره شد ✅"); refresh();
  } catch (err) { toast(err.message); }
});
$("#pocketDelete").addEventListener("click", async () => {
  const id = $("#pocketId").value;
  if (!id || !confirm("این پاکت و همه‌ی تراکنش‌هایش حذف شوند؟")) return;
  try { await api(`/pockets/${id}`, { method: "DELETE" }); closeModal("#pocketModal"); toast("حذف شد"); refresh(); }
  catch (err) { toast(err.message); }
});
$("#shareAddBtn").addEventListener("click", async () => {
  const id = $("#pocketId").value;
  const identifier = $("#shareIdentifier").value.trim();
  if (!identifier) return;
  try { await api(`/pockets/${id}/share`, { method: "POST", body: JSON.stringify({ identifier }) }); $("#shareIdentifier").value = ""; toast("عضو اضافه شد ✅"); loadMembers(id, true); refresh(); }
  catch (err) { toast(err.message); }
});
$("#pocketMembers").addEventListener("click", async (e) => {
  const rm = e.target.closest("[data-remove-member]");
  if (!rm) return;
  const id = $("#pocketId").value;
  try { await api(`/pockets/${id}/members/${rm.dataset.removeMember}`, { method: "DELETE" }); toast("حذف شد"); loadMembers(id, true); refresh(); }
  catch (err) { toast(err.message); }
});
$("#pocketLeave").addEventListener("click", async () => {
  const id = $("#pocketId").value;
  if (!confirm("از این پاکت مشترک خارج می‌شوید؟")) return;
  try { await api(`/pockets/${id}/members/${state.user.id}`, { method: "DELETE" }); closeModal("#pocketModal"); toast("خارج شدید"); refresh(); }
  catch (err) { toast(err.message); }
});

/* ============ تقسیم حقوق ============ */
const DIST_COLORS = ["bg-brand-500", "bg-amber-400", "bg-blue-400", "bg-purple-400", "bg-rose-400", "bg-emerald-400", "bg-cyan-400", "bg-orange-400", "bg-indigo-400", "bg-pink-400"];
let distAlloc = {};
function openDistribute() {
  if (!state.pockets.length) return toast("ابتدا یک پاکت بسازید");
  $("#distAmount").value = ""; $("#distDate").value = today(); $("#distCurrency").textContent = cur().sym;
  resetDistDefaults();
  $("#distributeScreen").hidden = false;
  setTimeout(() => $("#distAmount").focus(), 80);
}
function resetDistDefaults() { distAlloc = {}; state.pockets.forEach((p) => (distAlloc[p.id] = (Number(p.min_percent) + Number(p.max_percent)) / 2)); renderDistRows(); }
function renderDistRows() {
  const amount = parseNum($("#distAmount").value) || 0;
  const totalPct = Object.values(distAlloc).reduce((s, v) => s + v, 0);
  $("#distRows").innerHTML = state.pockets.map((p) => {
    const pct = distAlloc[p.id] || 0, share = totalPct > 0 ? amount * (pct / totalPct) : 0;
    return `<div class="bg-slate-50/50 rounded-2xl p-4 border border-slate-100 flex items-center gap-4">
      <div class="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-2xl shadow-sm">${escapeHtml(p.emoji)}</div>
      <div class="flex-1 min-w-0"><h3 class="text-sm font-extrabold text-ink leading-tight truncate">${escapeHtml(p.name)}</h3><p class="text-[10px] font-bold text-muted mt-0.5">${fmt(Math.round(share))}</p></div>
      <div class="flex flex-col items-center gap-1">
        <button type="button" class="w-9 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-brand active:bg-brand active:text-white transition-all" data-dist-plus="${p.id}"><i class="fa-solid fa-plus text-xs"></i></button>
        <span class="text-base font-black text-brand w-12 text-center tabular-nums">${faPct(pct)}</span>
        <button type="button" class="w-9 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-red-500 active:bg-red-500 active:text-white transition-all" data-dist-minus="${p.id}"><i class="fa-solid fa-minus text-xs"></i></button>
      </div></div>`;
  }).join("");
  $("#distBar").innerHTML = state.pockets.map((p, i) => { const w = totalPct > 0 ? ((distAlloc[p.id] || 0) / totalPct) * 100 : 0; return w > 0 ? `<div class="h-full ${DIST_COLORS[i % DIST_COLORS.length]} border-r border-white/20" style="width:${w}%"></div>` : ""; }).join("");
  const rounded = Math.round(totalPct), ok = rounded === 100;
  const badge = $("#distTotalBadge");
  badge.textContent = `${faPct(rounded)} تخصیص‌یافته`;
  badge.className = "text-xs font-black px-2 py-0.5 rounded-full " + (ok ? "text-emerald-600 bg-emerald-50" : "text-amber-600 bg-amber-50");
}
$("#distAmount").addEventListener("input", renderDistRows);
$("#distRows").addEventListener("click", (e) => {
  const plus = e.target.closest("[data-dist-plus]"), minus = e.target.closest("[data-dist-minus]");
  if (plus) {
    const id = plus.dataset.distPlus;
    const total = Object.values(distAlloc).reduce((s, v) => s + v, 0);
    const room = 100 - total;
    if (room <= 0) { toast("مجموع درصدها نمی‌تواند بیش از ۱۰۰٪ شود"); return; }
    distAlloc[id] = Math.min(100, (distAlloc[id] || 0) + Math.min(1, room));
    renderDistRows();
  }
  if (minus) { const id = minus.dataset.distMinus; distAlloc[id] = Math.max(0, (distAlloc[id] || 0) - 1); renderDistRows(); }
});
$("#distReset").addEventListener("click", resetDistDefaults);
$("#distBack").addEventListener("click", () => ($("#distributeScreen").hidden = true));
async function doDistribute() {
  const amount = parseNum($("#distAmount").value);
  if (!(amount > 0)) return toast("مبلغ حقوق را وارد کنید");
  const allocations = state.pockets.map((p) => ({ pocket_id: p.id, percent: distAlloc[p.id] || 0 })).filter((a) => a.percent > 0);
  if (!allocations.length) return toast("حداقل یک درصد را وارد کنید");
  try { const r = await api("/distribute", { method: "POST", body: JSON.stringify({ amount, currency: state.currency, occurred_on: $("#distDate").value, allocations }) }); $("#distributeScreen").hidden = true; toast(r?.queued ? "آفلاین: ثبت شد، بعداً همگام می‌شود ⏳" : "حقوق تقسیم شد 💸"); refresh(); }
  catch (err) { toast(err.message); }
}
$("#distConfirm").addEventListener("click", doDistribute);
$("#distConfirmTop").addEventListener("click", doDistribute);

/* ============ قرض‌ها ============ */
let loanDir = "lent";
function setLoanDir(dir) {
  loanDir = dir;
  $$("#loanForm .loandir-btn").forEach((b) => {
    const a = b.dataset.loandir === dir;
    b.className = "loandir-btn h-11 rounded-xl text-xs font-black transition-all " + (a ? "bg-brand text-white shadow" : "text-muted");
  });
  $("#loanSourceRow").hidden = dir !== "lent"; // فقط هنگام «قرض دادم» انتخاب پاکت مبدأ
}
function populateLoanSource(pockets) {
  $("#loanSource").innerHTML = `<option value="">همه‌ی پاکت‌ها (موجودی کل)</option>` +
    (pockets || []).filter((p) => p.is_owner).map((p) => `<option value="${p.id}">${escapeHtml(p.emoji)} ${escapeHtml(p.name)}</option>`).join("");
}
async function openLoans() {
  $("#loansScreen").hidden = false;
  await loadLoans();
}
async function loadLoans() {
  try {
    const { loans } = await api("/loans");
    const owed = {}, owe = {};
    loans.forEach((l) => { if (l.status === "active") { const m = l.i_am_lender ? owed : owe; m[l.currency] = (m[l.currency] || 0) + l.outstanding; } });
    const sumStr = (m) => { const parts = Object.entries(m).filter(([, v]) => v > 0).map(([c, v]) => fmtC(v, c)); return parts.length ? parts.join(" + ") : "۰"; };
    $("#loansOwedToMe").textContent = sumStr(owed);
    $("#loansIOwe").textContent = sumStr(owe);
    $("#loansEmpty").hidden = loans.length > 0;
    $("#loansList").innerHTML = loans.map(loanCard).join("");
  } catch (err) { toast(err.message); }
}
function loanStatusBadge(l) {
  const map = {
    pending: ["text-amber-600 bg-amber-50", "در انتظار"],
    active: ["text-brand bg-brand/10", "فعال"],
    settled: ["text-emerald-600 bg-emerald-50", "تسویه‌شده"],
    declined: ["text-slate-500 bg-slate-100", "رد شده"],
  };
  const [cls, label] = map[l.status] || map.pending;
  return `<span class="text-[10px] font-black px-2 py-0.5 rounded-full ${cls}">${label}</span>`;
}
function loanCard(l) {
  const name = personName(l.counterparty);
  const dirText = l.i_am_lender ? "به شما بدهکار است" : "به او بدهکارید";
  const dirColor = l.i_am_lender ? "text-emerald-600" : "text-red-500";
  let actions = "";
  if (l.status === "pending" && l.can_respond) {
    actions = `<div class="flex gap-2 mt-3">
      <button class="flex-1 h-10 bg-brand text-white rounded-xl text-xs font-black active:scale-[0.98]" data-loan-accept="${l.id}">تأیید</button>
      <button class="flex-1 h-10 bg-slate-100 text-muted rounded-xl text-xs font-black active:scale-[0.98]" data-loan-decline="${l.id}">رد</button></div>`;
  } else if (l.status === "pending" && l.i_created) {
    actions = `<div class="flex gap-2 mt-3"><span class="flex-1 text-[10px] font-bold text-muted flex items-center">در انتظار تأیید طرف مقابل…</span>
      <button class="h-10 px-4 bg-red-50 text-red-600 rounded-xl text-xs font-black active:scale-[0.98]" data-loan-cancel="${l.id}">لغو</button></div>`;
  } else if (l.status === "active") {
    actions = `<div class="flex items-center justify-between mt-3">
      <span class="text-[10px] font-bold text-muted">بازپرداخت‌شده: ${fmtC(l.repaid, l.currency)}</span>
      <button class="h-10 px-4 bg-brand/10 text-brand rounded-xl text-xs font-black active:scale-[0.98]" data-loan-repay="${l.id}" data-loan-cur="${l.currency}">ثبت بازپرداخت</button></div>`;
  }
  return `<div class="bg-white rounded-2xl p-4 border border-slate-100 space-y-1">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2"><div class="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center text-muted"><i class="fa-solid fa-user"></i></div>
        <div><p class="text-xs font-extrabold text-ink">${escapeHtml(name)}</p><p class="text-[10px] font-bold ${dirColor}">${dirText}</p></div></div>
      ${loanStatusBadge(l)}
    </div>
    <div class="flex items-baseline justify-between pt-1">
      <span class="text-[10px] font-bold text-muted">${l.note ? escapeHtml(l.note) : "—"}</span>
      <span class="text-base font-black tracking-tighter text-ink">${fmtC(l.outstanding, l.currency)}${l.status === "active" && l.repaid > 0 ? ` <span class="text-[10px] text-muted">/ ${fmtC(l.amount, l.currency)}</span>` : ""}</span>
    </div>
    ${actions}
  </div>`;
}
$("#loansBack").addEventListener("click", () => ($("#loansScreen").hidden = true));
$("#loanAddBtn").addEventListener("click", () => {
  setLoanDir("lent");
  $("#loanCurrency").innerHTML = CURRENCIES.map((c) => `<option value="${c.code}" ${c.code === state.currency ? "selected" : ""}>${c.sym} ${c.label}</option>`).join("");
  populateLoanSource(state.pockets);
  $("#loanIdentifier").value = ""; $("#loanAmount").value = ""; $("#loanNote").value = "";
  openModal("#loanModal");
});
$("#loanCurrency").addEventListener("change", async () => {
  const c = $("#loanCurrency").value;
  if (c === state.currency) return populateLoanSource(state.pockets);
  try { const r = await api(`/pockets?currency=${c}`); populateLoanSource(r.pockets); } catch { populateLoanSource([]); }
});
$$("#loanForm .loandir-btn").forEach((b) => b.addEventListener("click", () => setLoanDir(b.dataset.loandir)));
$("#loanForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { identifier: $("#loanIdentifier").value.trim(), direction: loanDir, amount: parseNum($("#loanAmount").value), currency: $("#loanCurrency").value, note: $("#loanNote").value.trim() };
  if (loanDir === "lent") body.source_pocket_id = $("#loanSource").value || null;
  if (!body.identifier) return toast("طرف مقابل را وارد کنید");
  if (!(body.amount > 0)) return toast("مبلغ نامعتبر است");
  try { await api("/loans", { method: "POST", body: JSON.stringify(body) }); closeModal("#loanModal"); toast("قرض ثبت شد ✅"); loadLoans(); }
  catch (err) { toast(err.message); }
});
$("#loansList").addEventListener("click", async (e) => {
  const acc = e.target.closest("[data-loan-accept]"), dec = e.target.closest("[data-loan-decline]"), can = e.target.closest("[data-loan-cancel]"), rep = e.target.closest("[data-loan-repay]");
  try {
    if (acc) { await api(`/loans/${acc.dataset.loanAccept}/respond`, { method: "POST", body: JSON.stringify({ accept: true }) }); toast("تأیید شد"); loadLoans(); }
    else if (dec) { await api(`/loans/${dec.dataset.loanDecline}/respond`, { method: "POST", body: JSON.stringify({ accept: false }) }); toast("رد شد"); loadLoans(); }
    else if (can) { if (!confirm("این قرض لغو شود؟")) return; await api(`/loans/${can.dataset.loanCancel}`, { method: "DELETE" }); toast("لغو شد"); loadLoans(); }
    else if (rep) {
      const raw = prompt("مبلغ بازپرداخت را وارد کنید:");
      if (raw == null) return;
      const amount = parseNum(raw);
      if (!(amount > 0)) return toast("مبلغ نامعتبر است");
      await api(`/loans/${rep.dataset.loanRepay}/repay`, { method: "POST", body: JSON.stringify({ amount }) });
      toast("بازپرداخت ثبت شد ✅"); loadLoans();
    }
  } catch (err) { toast(err.message); }
});

/* ============ نمره و رتبه ============ */
const TONE = {
  great: { ring: "#10b981", bg: "bg-emerald-50", text: "text-emerald-600" },
  good: { ring: "#0ea5e9", bg: "bg-sky-50", text: "text-sky-600" },
  ok: { ring: "#f59e0b", bg: "bg-amber-50", text: "text-amber-600" },
  warn: { ring: "#f97316", bg: "bg-orange-50", text: "text-orange-600" },
  bad: { ring: "#ef4444", bg: "bg-red-50", text: "text-red-600" },
};
const KIND_LABEL = { essential: "ضروری", discretionary: "اختیاری", savings: "پس‌انداز", investment: "سرمایه‌گذاری" };
function gaugeSvg(score, color) {
  const R = 52, C = 2 * Math.PI * R, off = C * (1 - (score || 0) / 100);
  return `<svg viewBox="0 0 120 120" class="w-32 h-32 -rotate-90">
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="currentColor" class="text-slate-100" stroke-width="12"/>
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"/>
  </svg>`;
}
function barRow(label, score, max, extra) {
  const pct = max > 0 ? Math.round((score / max) * 100) : 0;
  return `<div class="space-y-1">
    <div class="flex justify-between text-[11px] font-bold"><span class="text-ink">${label}</span><span class="text-muted">${faInt(Math.round(score))}/${faInt(max)}${extra ? " · " + extra : ""}</span></div>
    <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden"><div class="h-full bg-brand-500 rounded-full" style="width:${pct}%"></div></div>
  </div>`;
}
async function openScore() {
  $("#scoreScreen").hidden = false;
  $("#scoreCurLabel").textContent = cur().label;
  $("#rankCurNote").textContent = `${monthLabel(state.month)} · ${cur().label}`;
  $("#scoreBody").innerHTML = `<div class="py-10 text-center text-sm font-bold text-muted">در حال محاسبه…</div>`;
  $("#rankList").innerHTML = "";
  try {
    const [s, rk] = await Promise.all([
      api(`/score?currency=${state.currency}&month=${state.month}`),
      api(`/rank?currency=${state.currency}&month=${state.month}`),
    ]);
    renderScore(s);
    renderRank(rk);
  } catch (err) { $("#scoreBody").innerHTML = `<div class="py-10 text-center text-sm font-bold text-red-500">${escapeHtml(err.message)}</div>`; }
}
function renderScore(s) {
  if (!s.has_data || s.score == null) {
    $("#scoreBody").innerHTML = `<div class="py-10 text-center space-y-2"><div class="text-4xl">📊</div><p class="text-sm font-bold text-muted">برای این ماه داده‌ای نیست.<br>حقوق را تقسیم کنید و چند تراکنش ثبت کنید.</p></div>`;
    return;
  }
  const tone = TONE[s.tone] || TONE.ok;
  const b = s.breakdown;
  const mome = (s.momentum || []).filter((m) => m.score != null);
  const first = mome.length ? mome[0].score : null, last = s.score;
  const delta = first != null && mome.length > 1 ? last - first : null;
  const momentumHtml = mome.length > 1 ? `
    <div class="flex items-center justify-center gap-3 mt-3 text-[11px] font-bold text-muted">
      ${s.momentum.map((m) => `<span class="flex flex-col items-center gap-0.5"><b class="${m.score == null ? "text-slate-300" : "text-ink"} text-sm">${m.score == null ? "—" : faInt(m.score)}</b><span>${monthLabel(m.month).split(" ")[0]}</span></span>`).join('<i class="fa-solid fa-chevron-left text-[8px] text-slate-300"></i>')}
      ${delta != null && delta !== 0 ? `<span class="${delta > 0 ? "text-emerald-600" : "text-red-500"} font-black">${delta > 0 ? "📈 +" : "📉 "}${faInt(delta)}</span>` : ""}
    </div>` : "";
  const recsHtml = (s.recommendations || []).map((r) => `<div class="flex gap-2 text-[12px] font-bold text-ink bg-slate-50 rounded-xl p-3"><i class="fa-solid fa-lightbulb text-amber-500 mt-0.5"></i><span>${escapeHtml(r.text)}</span></div>`).join("");
  const posHtml = (s.positives || []).map((t) => `<div class="flex gap-2 text-[12px] font-bold text-emerald-700 bg-emerald-50 rounded-xl p-3"><i class="fa-solid fa-circle-check text-emerald-500 mt-0.5"></i><span>${escapeHtml(t)}</span></div>`).join("");
  const loanAdj = b.loan_adjustment;
  $("#scoreBody").innerHTML = `
    <div class="flex flex-col items-center">
      <div class="relative">
        ${gaugeSvg(s.score, tone.ring)}
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          <span class="text-3xl font-black tracking-tighter text-ink">${faInt(s.score)}</span>
          <span class="text-[10px] font-bold text-muted">از ۱۰۰</span>
        </div>
      </div>
      <div class="mt-2 px-4 py-1 rounded-full ${tone.bg} ${tone.text} text-sm font-black">${s.label_emoji} ${s.label}</div>
      ${momentumHtml}
    </div>
    <div class="space-y-3 mt-6">
      ${barRow("کنترل بودجه", b.budget.score, b.budget.max)}
      ${barRow("پس‌انداز و سرمایه‌گذاری", b.savings.score + b.savings.bonus, b.savings.max, `نرخ ${faPct(b.savings.saving_rate)}${b.savings.bonus ? " · پاداش +" + faInt(b.savings.bonus) : ""}`)}
      ${barRow("نقدینگی", b.liquidity.score, b.liquidity.max)}
      ${barRow("ثبات مالی", b.stability.score, b.stability.max)}
      ${barRow("کنترل ولخرجی", b.lifestyle.score, b.lifestyle.max, `اختیاری ${faPct(b.lifestyle.discretionary_rate)}`)}
      <div class="flex justify-between text-[11px] font-bold pt-1"><span class="text-ink">اثر قرض</span><span class="${loanAdj >= 0 ? "text-emerald-600" : "text-red-500"}">${loanAdj >= 0 ? "+" : ""}${faInt(loanAdj)}</span></div>
    </div>
    ${posHtml ? `<div class="space-y-2 mt-4">${posHtml}</div>` : ""}
    ${recsHtml ? `<div class="space-y-2 mt-2">${recsHtml}</div>` : ""}`;
}
function renderRank(rk) {
  if (!rk.rank.length) { $("#rankList").innerHTML = `<p class="text-xs font-bold text-muted text-center py-4">داده‌ای برای رتبه‌بندی نیست.</p>`; return; }
  const medal = (n) => (n === 1 ? "🥇" : n === 2 ? "🥈" : n === 3 ? "🥉" : faInt(n));
  $("#rankList").innerHTML = rk.rank.map((r) => `
    <div class="flex items-center gap-3 rounded-2xl p-3 border ${r.is_me ? "border-brand bg-brand/5" : "border-slate-100 bg-white"}">
      <span class="w-7 text-center font-black ${r.rank <= 3 ? "text-lg" : "text-sm text-muted"}">${medal(r.rank)}</span>
      <div class="w-9 h-9 rounded-xl bg-brand/10 text-brand font-black flex items-center justify-center overflow-hidden">${r.photo_url ? `<img src="${escapeHtml(r.photo_url)}" class="w-full h-full object-cover" referrerpolicy="no-referrer">` : escapeHtml((r.name || "؟")[0].toUpperCase())}</div>
      <div class="flex-1 min-w-0"><p class="text-xs font-extrabold text-ink truncate">${escapeHtml(r.name)}${r.is_me ? " (شما)" : ""}</p><p class="text-[10px] font-bold text-muted">${r.label_emoji} ${escapeHtml(r.label)}</p></div>
      <span class="text-base font-black tracking-tighter text-ink">${faInt(r.score)}</span>
    </div>`).join("");
}
$("#scoreBack").addEventListener("click", () => ($("#scoreScreen").hidden = true));

/* ============ ماه و ارز ============ */
function applyMonth() { $("#monthLabel").textContent = monthLabel(state.month); $("#monthInput").value = state.month; }
$("#monthBtn").addEventListener("click", () => { const inp = $("#monthInput"); if (inp.showPicker) { try { inp.showPicker(); return; } catch {} } inp.click(); });
$("#monthInput").addEventListener("change", () => { state.month = $("#monthInput").value || currentMonth(); applyMonth(); refresh(); });
let ownedCurrencies = [];
async function renderCurrencyMenu() {
  let owned = [];
  try { owned = (await api("/currencies")).currencies; } catch {}
  ownedCurrencies = owned.map((c) => c.currency);
  // اطمینان از وجود ارز جاری در فهرست
  const ownedSet = new Set(ownedCurrencies);
  const ownedRows = owned.map((c) => {
    const info = curBy(c.currency);
    const active = c.currency === state.currency;
    return `<div class="w-full flex items-center gap-2">
      <button data-cur="${c.currency}" class="flex-1 flex items-center justify-between px-4 h-12 rounded-2xl border ${active ? "border-brand bg-brand/5 text-brand" : "border-slate-100 bg-slate-50 text-ink"} font-bold text-sm transition-all">
        <span>${info.label}</span><span class="text-base">${info.sym} · ${fmtC(c.balance, c.currency)}</span></button>
      <button data-del-cur="${c.currency}" class="w-11 h-12 rounded-2xl bg-red-50 text-red-500 flex items-center justify-center active:scale-95"><i class="fa-solid fa-trash-can text-xs"></i></button>
    </div>`;
  }).join("");
  const addable = CURRENCIES.filter((c) => !ownedSet.has(c.code));
  const addRows = addable.length ? `
    <p class="text-[10px] font-black text-muted uppercase tracking-widest pt-2">افزودن ارز جدید</p>
    <div class="grid grid-cols-2 gap-2">
      ${addable.map((c) => `<button data-add-cur="${c.code}" class="flex items-center justify-center gap-2 h-11 rounded-xl border border-dashed border-slate-200 bg-slate-50 text-ink text-sm font-bold active:scale-[0.98]"><i class="fa-solid fa-plus text-brand text-xs"></i> ${c.label} ${c.sym}</button>`).join("")}
    </div>` : "";
  $("#currencyOptions").innerHTML = (ownedRows || `<p class="text-xs font-bold text-muted text-center py-2">هنوز حسابی ندارید.</p>`) + addRows;
}
$("#currencyBtn").addEventListener("click", () => { renderCurrencyMenu(); openModal("#currencyMenu"); });
$("#currencyOptions").addEventListener("click", async (e) => {
  const sw = e.target.closest("[data-cur]");
  const add = e.target.closest("[data-add-cur]");
  const del = e.target.closest("[data-del-cur]");
  if (sw) {
    state.currency = sw.dataset.cur; localStorage.setItem("fin_currency", state.currency);
    applyCurrencyLabel(); closeModal("#currencyMenu"); refresh(); return;
  }
  if (add) {
    try {
      await api("/currencies", { method: "POST", body: JSON.stringify({ currency: add.dataset.addCur }) });
      state.currency = add.dataset.addCur; localStorage.setItem("fin_currency", state.currency);
      applyCurrencyLabel(); closeModal("#currencyMenu"); toast("حساب ارزی ساخته شد ✅"); refresh();
    } catch (err) { toast(err.message); }
    return;
  }
  if (del) {
    const code = del.dataset.delCur;
    if (!confirm(`حساب ${curBy(code).label} و همه‌ی پاکت‌ها و تراکنش‌های آن حذف شود؟`)) return;
    try {
      await api(`/currencies/${code}`, { method: "DELETE" });
      toast("حساب ارزی حذف شد");
      if (state.currency === code) {
        const rest = ownedCurrencies.filter((c) => c !== code);
        state.currency = rest[0] || "IRT";
        localStorage.setItem("fin_currency", state.currency);
        applyCurrencyLabel();
      }
      renderCurrencyMenu(); refresh();
    } catch (err) { toast(err.message); }
  }
});
function applyCurrencyLabel() { const c = cur(); $("#currencyLabel").textContent = `${c.sym} ${c.label}`; }

/* ============ ناوبری و پروفایل ============ */
$$("[data-nav]").forEach((b) => b.addEventListener("click", () => {
  const n = b.dataset.nav;
  if (n === "tx") openTx("expense");
  else if (n === "profile") openProfile();
  else if (n === "loans") openLoans();
  else if (n === "score") openScore();
  else window.scrollTo({ top: 0, behavior: "smooth" });
}));
$("#bellBtn").addEventListener("click", () => toast("اعلان جدیدی ندارید"));
$("#avatarBtn").addEventListener("click", openProfile);
function openProfile() {
  $("#profileEmail").textContent = userName(state.user);
  $("#profileAvatar").innerHTML = avatarInner(state.user);
  syncThemeButtons();
  openModal("#profileMenu");
}
$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  closeModal("#profileMenu"); $("#authForm").reset(); setAuthMode("login"); showAuth();
});

/* ============ داشبورد رویدادها ============ */
$("#btnDistribute").addEventListener("click", openDistribute);
$("#btnAddTx").addEventListener("click", () => openTx("expense"));
$("#btnAddPocket").addEventListener("click", () => openPocket());
$("#pockets").addEventListener("click", (e) => {
  const inc = e.target.closest("[data-add-income]"), exp = e.target.closest("[data-add-expense]"), edit = e.target.closest("[data-edit]");
  if (inc) return openTx("income", inc.dataset.addIncome);
  if (exp) return openTx("expense", exp.dataset.addExpense);
  if (edit) { const p = state.pockets.find((x) => String(x.id) === edit.dataset.edit); if (p) openPocket(p); }
});
$("#txList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-tx]");
  if (!del) return;
  if (!confirm("این تراکنش حذف شود؟")) return;
  try { await api(`/transactions/${del.dataset.delTx}`, { method: "DELETE" }); toast("حذف شد"); refresh(); }
  catch (err) { toast(err.message); }
});

/* ============ احراز هویت ============ */
let authMode = "login";
function setAuthMode(mode) {
  authMode = mode;
  const login = mode === "login";
  $("#authTitle").textContent = login ? "خوش آمدید" : "ساخت حساب جدید";
  $("#authSubtitle").textContent = login ? "برای دسترسی به حساب خود وارد شوید." : "برای شروع، یک حساب کاربری بسازید.";
  $("#authSubmit").textContent = login ? "ورود به حساب کاربری" : "ثبت‌نام";
  $("#authSwitchText").textContent = login ? "حساب کاربری ندارید؟" : "حساب کاربری دارید؟";
  $("#authToggle").textContent = login ? "ثبت‌نام کنید" : "وارد شوید";
  $("#authPassword").autocomplete = login ? "current-password" : "new-password";
  $("#authError").hidden = true;
}
function showEmailAuth() {
  stopTgPoll();
  $("#tgForm").hidden = true;
  $("#authForm").hidden = false; $("#authSwitch").hidden = false; $("#tgSection").hidden = false;
}
function showTgAuth() {
  $("#authForm").hidden = true; $("#authSwitch").hidden = true; $("#tgSection").hidden = true;
  $("#tgForm").hidden = false;
  renderTgWidget();
}
function showAuth() {
  $("#appScreen").hidden = true; $("#distributeScreen").hidden = true; $("#loansScreen").hidden = true; $("#scoreScreen").hidden = true;
  $("#authScreen").hidden = false; showEmailAuth();
}
function userName(u) { return u?.display_name || u?.email || (u?.telegram_username ? "@" + u.telegram_username : ""); }
function avatarInner(u) {
  if (u?.photo_url) return `<img src="${escapeHtml(u.photo_url)}" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer">`;
  return (userName(u).replace(/^@/, "")[0] || "؟").toUpperCase();
}
function showApp() {
  stopTgPoll();
  $("#authScreen").hidden = true; $("#appScreen").hidden = false;
  const name = userName(state.user);
  $("#userGreet").textContent = name ? "، " + name.replace(/^@/, "").split("@")[0] : "";
  $("#avatarBtn").innerHTML = avatarInner(state.user);
  applyMonth(); applyCurrencyLabel(); updateSyncUI(); refresh();
  if (navigator.onLine && queueCount() > 0) flushQueue();
}
$("#authToggle").addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
$("#togglePw").addEventListener("click", () => {
  const inp = $("#authPassword"), show = inp.type === "password";
  inp.type = show ? "text" : "password";
  $("#togglePw").innerHTML = show ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
});
$("#forgotBtn").addEventListener("click", () => toast("بازیابی رمز به‌زودی؛ می‌توانید با تلگرام وارد شوید"));
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#authEmail").value.trim(), password = $("#authPassword").value, errEl = $("#authError");
  errEl.hidden = true;
  const btn = $("#authSubmit"), orig = btn.textContent; btn.disabled = true; btn.textContent = "لطفاً صبر کنید…";
  try {
    const res = await fetch("/api/auth/" + (authMode === "login" ? "login" : "register"), { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ email, password }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "خطا در احراز هویت");
    state.user = data.user; showApp();
  } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
  finally { btn.disabled = false; btn.textContent = orig; }
});

/* ---- تلگرام ---- */
async function telegramMiniAppLogin() {
  try {
    const res = await fetch("/api/auth/telegram/miniapp", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ initData: tg.initData }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "ورود تلگرام ناموفق بود");
    state.user = data.user; showApp(); return true;
  } catch (err) { toast(err.message); return false; }
}
function stopTgPoll() {} // سازگاری با فراخوانی‌های قبلی
let tgWidgetLoaded = false;
$("#tgLoginBtn").addEventListener("click", () => { if (inTelegram) telegramMiniAppLogin(); else showTgAuth(); });
$("#tgBack").addEventListener("click", showEmailAuth);

// callback سراسری که ویجت تلگرام صدا می‌زند
window.onTelegramAuth = async (user) => {
  const errEl = $("#tgError"); errEl.hidden = true;
  $("#tgWaiting").hidden = false;
  try {
    const res = await fetch("/api/auth/telegram/widget", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(user) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "ورود تلگرام ناموفق بود");
    state.user = data.user; showApp();
  } catch (err) { $("#tgWaiting").hidden = true; errEl.textContent = err.message; errEl.hidden = false; }
};

async function renderTgWidget() {
  const host = $("#tgWidgetHost"), errEl = $("#tgError");
  $("#tgWaiting").hidden = true; errEl.hidden = true;
  const cfg = state.tgConfig || {};
  if (!cfg.telegram_enabled || !cfg.telegram_bot) {
    host.innerHTML = "";
    errEl.textContent = "ورود تلگرام روی سرور پیکربندی نشده است (TELEGRAM_BOT_TOKEN تنظیم نشده).";
    errEl.hidden = false;
    return;
  }
  // اسکریپت ویجت را یک‌بار برای هر یوزرنیم بساز
  host.innerHTML = "";
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://telegram.org/js/telegram-widget.js?22";
  s.setAttribute("data-telegram-login", cfg.telegram_bot);
  s.setAttribute("data-size", "large");
  s.setAttribute("data-radius", "12");
  s.setAttribute("data-request-access", "write");
  s.setAttribute("data-onauth", "onTelegramAuth(user)");
  host.appendChild(s);
  tgWidgetLoaded = true;
}

/* ============ تم و پالت ============ */
function currentThemePref() { return localStorage.getItem("fin_theme") || "system"; }
function currentPalette() { return localStorage.getItem("fin_palette") || "teal"; }
function applyTheme() {
  const pref = currentThemePref();
  const resolved = pref === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-palette", currentPalette());
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolved === "dark" ? "#0a0f1f" : "#0f766e");
}
function syncThemeButtons() {
  const pref = currentThemePref(), pal = currentPalette();
  $$("#themeOptions .theme-opt").forEach((b) => {
    const a = b.dataset.themeOpt === pref;
    b.classList.toggle("border-brand", a); b.classList.toggle("bg-brand/5", a); b.classList.toggle("text-brand", a);
    b.classList.toggle("border-slate-100", !a);
  });
  $$("#paletteOptions .palette-opt").forEach((b) => {
    b.classList.toggle("border-brand", b.dataset.paletteOpt === pal);
  });
}
$("#themeOptions").addEventListener("click", (e) => {
  const b = e.target.closest("[data-theme-opt]"); if (!b) return;
  localStorage.setItem("fin_theme", b.dataset.themeOpt); applyTheme(); syncThemeButtons();
});
$("#paletteOptions").addEventListener("click", (e) => {
  const b = e.target.closest("[data-palette-opt]"); if (!b) return;
  localStorage.setItem("fin_palette", b.dataset.paletteOpt); applyTheme(); syncThemeButtons();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (currentThemePref() === "system") applyTheme(); });

/* ============ شروع ============ */
async function init() {
  applyTheme();
  applyCurrencyLabel();
  if (tg) { try { tg.ready(); tg.expand(); } catch {} }
  try { state.tgConfig = await api("/config"); } catch { state.tgConfig = { telegram_enabled: false }; }
  if (!state.tgConfig.telegram_enabled && !inTelegram) { const b = $("#tgSection"); if (b) b.style.display = "none"; }
  try {
    const me = await api("/auth/me");
    state.user = me.user; showApp(); return;
  } catch {}
  if (inTelegram) { const okLogin = await telegramMiniAppLogin(); if (okLogin) return; }
  setAuthMode("login"); showAuth();
}
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
init();
