/* Finanzierung — منطق سمت کلاینت (نسخه‌ی طراحی جدید) */

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

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function today() { return new Date().toISOString().slice(0, 10); }

/* ---- تبدیل ارقام و قالب‌بندی ---- */
function toEnDigits(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}
function parseNum(v) {
  const n = Number(toEnDigits(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}
function cur() { return CURRENCIES.find((c) => c.code === state.currency) || CURRENCIES[0]; }
function fmtNum(n) {
  const c = cur();
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: c.dec, minimumFractionDigits: 0 }).format(Number(n) || 0);
}
function fmt(n) { return `${fmtNum(n)} ${cur().sym}`; }
function fmtSigned(n, sign) { return `${sign}${fmtNum(Math.abs(n))}`; }
function faPct(n) { return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 }).format(Number(n) || 0) + "٪"; }
function faInt(n) { return new Intl.NumberFormat("fa-IR").format(Number(n) || 0); }
function faDate(iso) {
  try {
    return new Intl.DateTimeFormat("fa-IR", { day: "numeric", month: "long" }).format(new Date(iso));
  } catch { return iso; }
}
function monthLabel(m) {
  try {
    const [y, mo] = m.split("-").map(Number);
    return new Intl.DateTimeFormat("fa-IR", { year: "numeric", month: "long" }).format(new Date(y, mo - 1, 1));
  } catch { return m; }
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- API ---- */
class AuthError extends Error {}
async function api(path, options) {
  const res = await fetch("/api" + path, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  if (res.status === 401) throw new AuthError("نیازمند ورود");
  if (!res.ok) {
    let msg = "خطا در ارتباط با سرور";
    try { const j = await res.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

/* ---- توست ---- */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ---- مودال‌ها ---- */
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
document.body.addEventListener("click", (e) => {
  const c = e.target.closest("[data-close]");
  if (c) { const m = c.closest(".fixed.z-50"); if (m) m.hidden = true; }
});

/* ============ بارگذاری داشبورد ============ */
async function refresh() {
  try {
    const [p, s, t] = await Promise.all([
      api(`/pockets?month=${state.month}`),
      api(`/summary?month=${state.month}`),
      api(`/transactions?month=${state.month}&limit=20`),
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
  $("#sumBalance").textContent = fmt(s.balance);
  $("#sumIncome").textContent = fmtSigned(s.period_income, "+") + " " + cur().sym;
  $("#sumExpense").textContent = fmtSigned(s.period_expense, "−") + " " + cur().sym;
}

function renderPockets(pockets) {
  $("#pocketCount").textContent = `${faInt(pockets.length)} پاکت`;
  $("#pocketsEmpty").hidden = pockets.length > 0;
  const grid = $("#pockets");
  grid.innerHTML = pockets.map(pocketCard).join("");
}

function pocketCard(p) {
  const allocated = p.period_income;          // بودجه‌ی این ماه = ورودی این ماه
  const spent = p.period_expense;             // خرج‌شده این ماه
  const remaining = allocated - spent;
  const over = spent > allocated;
  const pct = allocated > 0 ? Math.min(100, Math.round((spent / allocated) * 100)) : 0;
  const pctLabel = p.min_percent === p.max_percent ? faPct(p.min_percent) : `${faPct(p.min_percent)}–${faPct(p.max_percent)}`;
  const balClass = p.balance < 0 ? "text-red-500" : "text-brand-700";

  const progress = allocated > 0 ? `
    <div class="space-y-1.5 mb-5">
      <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
        <div class="h-full rounded-full ${over ? "bg-red-500" : "bg-brand-500"}" style="width:${over ? 100 : pct}%"></div>
      </div>
      <div class="flex justify-between text-[10px] font-bold ${over ? "text-red-600" : "text-muted"}">
        <span>${over ? "بیش از بودجه ماهانه" : `${faPct(pct)} از بودجه ماهانه`}</span>
        <span>${over ? `${fmtNum(Math.abs(remaining))} کسر بودجه` : `${fmtNum(remaining)} مانده`}</span>
      </div>
    </div>` : `
    <div class="mb-5"><div class="w-full h-2 bg-slate-100 rounded-full"></div>
      <p class="text-[10px] font-bold text-muted mt-1.5">این ماه هنوز بودجه‌ای دریافت نشده</p></div>`;

  return `
  <div class="bg-white rounded-[24px] p-5 border border-slate-100 shadow-sm relative overflow-hidden">
    <div class="flex items-start justify-between mb-4">
      <div class="flex items-center gap-3">
        <div class="w-12 h-12 bg-slate-50 rounded-2xl flex items-center justify-center text-2xl shadow-inner">${escapeHtml(p.emoji)}</div>
        <div>
          <h3 class="text-sm font-extrabold text-ink leading-tight">${escapeHtml(p.name)}</h3>
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
      <div class="bg-emerald-50/50 rounded-xl p-2.5 flex flex-col gap-0.5">
        <span class="text-[9px] font-bold text-emerald-700">ورودی این ماه</span>
        <span class="text-xs font-black text-emerald-600">${fmtSigned(p.period_income, "+")}</span>
      </div>
      <div class="bg-red-50/50 rounded-xl p-2.5 flex flex-col gap-0.5">
        <span class="text-[9px] font-bold text-red-700">خروجی این ماه</span>
        <span class="text-xs font-black text-red-500">${fmtSigned(p.period_expense, "−")}</span>
      </div>
    </div>
    <div class="grid grid-cols-2 gap-3 mt-4">
      <button class="h-10 bg-slate-50 hover:bg-slate-100 rounded-xl flex items-center justify-center gap-2 text-xs font-bold transition-colors" data-add-expense="${p.id}">
        <i class="fa-solid fa-minus text-[10px] text-red-500"></i> خروجی
      </button>
      <button class="h-10 bg-slate-50 hover:bg-slate-100 rounded-xl flex items-center justify-center gap-2 text-xs font-bold transition-colors" data-add-income="${p.id}">
        <i class="fa-solid fa-plus text-[10px] text-emerald-600"></i> ورودی
      </button>
    </div>
  </div>`;
}

function renderTx(list) {
  $("#txEmpty").hidden = list.length > 0;
  $("#txList").innerHTML = list.map((t) => {
    const inc = t.type === "income";
    return `
    <div class="bg-white rounded-2xl p-4 border border-slate-100 flex items-center gap-3">
      <div class="w-10 h-10 bg-slate-50 rounded-xl flex items-center justify-center text-lg">${escapeHtml(t.pocket_emoji)}</div>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-extrabold text-ink leading-tight truncate">${escapeHtml(t.note || t.pocket_name)}</p>
        <p class="text-[10px] font-bold text-muted mt-0.5">${escapeHtml(t.pocket_name)} · ${faDate(t.occurred_on)}</p>
      </div>
      <span class="text-xs font-black tracking-tighter ${inc ? "text-emerald-600" : "text-red-500"}">${fmtSigned(t.amount, inc ? "+" : "−")}</span>
      <button class="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-red-500 transition-colors" data-del-tx="${t.id}"><i class="fa-solid fa-trash-can text-[11px]"></i></button>
    </div>`;
  }).join("");
}

/* ============ مودال تراکنش ============ */
let txType = "expense";
function setTxType(type) {
  txType = type;
  $$("#txForm .txtype-btn").forEach((b) => {
    const active = b.dataset.txtype === type;
    b.className = "txtype-btn h-11 rounded-xl text-xs font-black flex items-center justify-center gap-2 transition-all " +
      (active ? (type === "income" ? "bg-emerald-500 text-white shadow" : "bg-red-500 text-white shadow") : "text-muted");
  });
}
function openTx(type = "expense", pocketId = null) {
  if (!state.pockets.length) return toast("ابتدا یک پاکت بسازید");
  setTxType(type);
  $("#txModalTitle").textContent = "ثبت تراکنش";
  $("#txPocket").innerHTML = state.pockets.map((p) =>
    `<option value="${p.id}" ${String(p.id) === String(pocketId) ? "selected" : ""}>${p.emoji} ${escapeHtml(p.name)}</option>`).join("");
  $("#txAmount").value = "";
  $("#txNote").value = "";
  $("#txDate").value = today();
  openModal("#txModal");
  setTimeout(() => $("#txAmount").focus(), 60);
}
$$("#txForm .txtype-btn").forEach((b) => b.addEventListener("click", () => setTxType(b.dataset.txtype)));
$("#txForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    pocket_id: Number($("#txPocket").value),
    type: txType,
    amount: parseNum($("#txAmount").value),
    note: $("#txNote").value.trim(),
    occurred_on: $("#txDate").value,
  };
  if (!(body.amount >= 0)) return toast("مبلغ نامعتبر است");
  try {
    await api("/transactions", { method: "POST", body: JSON.stringify(body) });
    closeModal("#txModal");
    toast("ثبت شد ✅");
    refresh();
  } catch (err) { toast(err.message); }
});

/* ============ مودال پاکت ============ */
function openPocket(pocket = null) {
  const edit = !!pocket;
  $("#pocketModalTitle").textContent = edit ? "ویرایش پاکت" : "پاکت جدید";
  $("#pocketId").value = edit ? pocket.id : "";
  $("#pocketEmoji").value = edit ? pocket.emoji : "💰";
  $("#pocketName").value = edit ? pocket.name : "";
  $("#pocketMin").value = edit ? pocket.min_percent : 0;
  $("#pocketMax").value = edit ? pocket.max_percent : 0;
  $("#pocketDelete").hidden = !edit;
  openModal("#pocketModal");
}
$("#pocketForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#pocketId").value;
  const body = {
    name: $("#pocketName").value.trim(),
    emoji: $("#pocketEmoji").value.trim() || "💰",
    min_percent: Number($("#pocketMin").value) || 0,
    max_percent: Number($("#pocketMax").value) || 0,
  };
  if (!body.name) return toast("نام پاکت الزامی است");
  try {
    if (id) await api(`/pockets/${id}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/pockets", { method: "POST", body: JSON.stringify(body) });
    closeModal("#pocketModal");
    toast("ذخیره شد ✅");
    refresh();
  } catch (err) { toast(err.message); }
});
$("#pocketDelete").addEventListener("click", async () => {
  const id = $("#pocketId").value;
  if (!id || !confirm("این پاکت و همه‌ی تراکنش‌هایش حذف شوند؟")) return;
  try {
    await api(`/pockets/${id}`, { method: "DELETE" });
    closeModal("#pocketModal");
    toast("حذف شد");
    refresh();
  } catch (err) { toast(err.message); }
});

/* ============ صفحه‌ی تقسیم حقوق ============ */
const DIST_COLORS = ["bg-brand-500", "bg-amber-400", "bg-blue-400", "bg-purple-400", "bg-rose-400", "bg-emerald-400", "bg-cyan-400", "bg-orange-400", "bg-indigo-400", "bg-pink-400"];
let distAlloc = {}; // pocket_id -> percent

function openDistribute() {
  if (!state.pockets.length) return toast("ابتدا یک پاکت بسازید");
  $("#distAmount").value = "";
  $("#distDate").value = today();
  $("#distCurrency").textContent = cur().sym;
  resetDistDefaults();
  $("#distributeScreen").hidden = false;
  setTimeout(() => $("#distAmount").focus(), 80);
}
function resetDistDefaults() {
  distAlloc = {};
  state.pockets.forEach((p) => { distAlloc[p.id] = (Number(p.min_percent) + Number(p.max_percent)) / 2; });
  renderDistRows();
}
function renderDistRows() {
  const amount = parseNum($("#distAmount").value) || 0;
  const totalPct = Object.values(distAlloc).reduce((s, v) => s + v, 0);
  const rows = $("#distRows");
  rows.innerHTML = state.pockets.map((p, i) => {
    const pct = distAlloc[p.id] || 0;
    const share = totalPct > 0 ? amount * (pct / totalPct) : 0;
    return `
    <div class="bg-slate-50/50 rounded-2xl p-4 border border-slate-100 flex items-center gap-4">
      <div class="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-2xl shadow-sm">${escapeHtml(p.emoji)}</div>
      <div class="flex-1 min-w-0">
        <h3 class="text-sm font-extrabold text-ink leading-tight truncate">${escapeHtml(p.name)}</h3>
        <p class="text-[10px] font-bold text-muted mt-0.5">${fmt(Math.round(share))}</p>
      </div>
      <div class="flex items-center gap-3">
        <button type="button" class="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-muted active:bg-brand active:text-white transition-all" data-dist-minus="${p.id}"><i class="fa-solid fa-minus text-[10px]"></i></button>
        <span class="text-sm font-black text-brand w-10 text-center">${faPct(pct)}</span>
        <button type="button" class="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-muted active:bg-brand active:text-white transition-all" data-dist-plus="${p.id}"><i class="fa-solid fa-plus text-[10px]"></i></button>
      </div>
    </div>`;
  }).join("");

  // نوار توزیع
  $("#distBar").innerHTML = state.pockets.map((p, i) => {
    const pct = distAlloc[p.id] || 0;
    const w = totalPct > 0 ? (pct / totalPct) * 100 : 0;
    return w > 0 ? `<div class="h-full ${DIST_COLORS[i % DIST_COLORS.length]} border-r border-white/20" style="width:${w}%"></div>` : "";
  }).join("");

  const badge = $("#distTotalBadge");
  const rounded = Math.round(totalPct);
  badge.textContent = `${faPct(rounded)} تخصیص‌یافته`;
  const ok = rounded === 100;
  badge.className = "text-xs font-black px-2 py-0.5 rounded-full " + (ok ? "text-emerald-600 bg-emerald-50" : "text-amber-600 bg-amber-50");
}
$("#distAmount").addEventListener("input", renderDistRows);
$("#distRows").addEventListener("click", (e) => {
  const plus = e.target.closest("[data-dist-plus]");
  const minus = e.target.closest("[data-dist-minus]");
  if (plus) { const id = plus.dataset.distPlus; distAlloc[id] = Math.min(100, (distAlloc[id] || 0) + 1); renderDistRows(); }
  if (minus) { const id = minus.dataset.distMinus; distAlloc[id] = Math.max(0, (distAlloc[id] || 0) - 1); renderDistRows(); }
});
$("#distReset").addEventListener("click", resetDistDefaults);
$("#distBack").addEventListener("click", () => ($("#distributeScreen").hidden = true));
async function doDistribute() {
  const amount = parseNum($("#distAmount").value);
  if (!(amount > 0)) return toast("مبلغ حقوق را وارد کنید");
  const allocations = state.pockets
    .map((p) => ({ pocket_id: p.id, percent: distAlloc[p.id] || 0 }))
    .filter((a) => a.percent > 0);
  if (!allocations.length) return toast("حداقل یک درصد را وارد کنید");
  try {
    await api("/distribute", { method: "POST", body: JSON.stringify({ amount, occurred_on: $("#distDate").value, allocations }) });
    $("#distributeScreen").hidden = true;
    toast("حقوق تقسیم شد 💸");
    refresh();
  } catch (err) { toast(err.message); }
}
$("#distConfirm").addEventListener("click", doDistribute);
$("#distConfirmTop").addEventListener("click", doDistribute);

/* ============ ماه و واحد پول ============ */
function applyMonth() {
  $("#monthLabel").textContent = monthLabel(state.month);
  $("#monthInput").value = state.month;
}
$("#monthBtn").addEventListener("click", () => {
  const inp = $("#monthInput");
  if (inp.showPicker) { try { inp.showPicker(); return; } catch {} }
  inp.click();
});
$("#monthInput").addEventListener("change", () => {
  state.month = $("#monthInput").value || currentMonth();
  applyMonth();
  refresh();
});
function renderCurrencyMenu() {
  $("#currencyOptions").innerHTML = CURRENCIES.map((c) => `
    <button data-cur="${c.code}" class="w-full flex items-center justify-between px-4 h-12 rounded-2xl border ${c.code === state.currency ? "border-brand bg-brand/5 text-brand" : "border-slate-100 bg-slate-50 text-ink"} font-bold text-sm transition-all">
      <span>${c.label}</span><span class="text-base">${c.sym}</span>
    </button>`).join("");
}
$("#currencyBtn").addEventListener("click", () => { renderCurrencyMenu(); openModal("#currencyMenu"); });
$("#currencyOptions").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cur]");
  if (!b) return;
  state.currency = b.dataset.cur;
  localStorage.setItem("fin_currency", state.currency);
  applyCurrencyLabel();
  closeModal("#currencyMenu");
  refresh();
});
function applyCurrencyLabel() {
  const c = cur();
  $("#currencyLabel").textContent = `${c.sym} ${c.label}`;
}

/* ============ ناوبری و پروفایل ============ */
$$("[data-nav]").forEach((b) => b.addEventListener("click", () => {
  const n = b.dataset.nav;
  if (n === "tx") openTx("expense");
  else if (n === "profile") openProfile();
  else if (n === "reports") toast("گزارش‌ها به‌زودی اضافه می‌شود");
  else window.scrollTo({ top: 0, behavior: "smooth" });
}));
$("#bellBtn").addEventListener("click", () => toast("اعلان جدیدی ندارید"));
$("#avatarBtn").addEventListener("click", openProfile);
function openProfile() {
  const email = state.user?.email || "";
  $("#profileEmail").textContent = email;
  $("#profileAvatar").textContent = (email[0] || "؟").toUpperCase();
  openModal("#profileMenu");
}
$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  closeModal("#profileMenu");
  $("#authForm").reset();
  setAuthMode("login");
  showAuth();
});

/* ============ رویدادهای عمومی داشبورد ============ */
$("#btnDistribute").addEventListener("click", openDistribute);
$("#btnAddTx").addEventListener("click", () => openTx("expense"));
$("#btnAddPocket").addEventListener("click", () => openPocket());
$("#pockets").addEventListener("click", (e) => {
  const inc = e.target.closest("[data-add-income]");
  const exp = e.target.closest("[data-add-expense]");
  const edit = e.target.closest("[data-edit]");
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
function showAuth() {
  $("#appScreen").hidden = true;
  $("#distributeScreen").hidden = true;
  $("#authScreen").hidden = false;
}
function showApp() {
  $("#authScreen").hidden = true;
  $("#appScreen").hidden = false;
  const email = state.user?.email || "";
  $("#userGreet").textContent = email ? "، " + email.split("@")[0] : "";
  $("#avatarBtn").textContent = (email[0] || "؟").toUpperCase();
  applyMonth();
  applyCurrencyLabel();
  refresh();
}
$("#authToggle").addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
$("#togglePw").addEventListener("click", () => {
  const inp = $("#authPassword");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  $("#togglePw").innerHTML = show ? '<i class="fa-regular fa-eye-slash"></i>' : '<i class="fa-regular fa-eye"></i>';
});
$("#forgotBtn").addEventListener("click", () => toast("بازیابی رمز به‌زودی اضافه می‌شود"));
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  const errEl = $("#authError");
  errEl.hidden = true;
  const btn = $("#authSubmit");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "لطفاً صبر کنید…";
  try {
    const path = authMode === "login" ? "/auth/login" : "/auth/register";
    const res = await fetch("/api" + path, {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "خطا در احراز هویت");
    state.user = data.user;
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

/* ============ شروع ============ */
async function init() {
  applyCurrencyLabel();
  try {
    const me = await api("/auth/me");
    state.user = me.user;
    showApp();
  } catch {
    setAuthMode("login");
    showAuth();
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
init();
