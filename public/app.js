/* Finanzierung — منطق سمت کلاینت PWA */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  month: currentMonth(),
  currency: localStorage.getItem("fin_currency") || "EUR",
  pockets: [],
};

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ---- قالب‌بندی مبلغ ---- */
function fmt(amount) {
  const cur = state.currency;
  const n = Number(amount) || 0;
  if (cur === "IRT") {
    return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 }).format(n) + " تومان";
  }
  const opts = { style: "currency", currency: cur === "IRR" ? "IRR" : cur, maximumFractionDigits: cur === "IRR" ? 0 : 2 };
  try {
    return new Intl.NumberFormat("fa-IR", opts).format(n);
  } catch {
    return new Intl.NumberFormat("fa-IR").format(n) + " " + cur;
  }
}
function faPct(n) {
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 }).format(Number(n) || 0) + "٪";
}
function faDate(iso) {
  try {
    return new Intl.DateTimeFormat("fa-IR", { year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/* ---- ارتباط با API ---- */
async function api(path, options) {
  const res = await fetch("/api" + path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
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

/* ---- بارگذاری و رندر ---- */
async function refresh() {
  try {
    const [pocketsRes, summaryRes, txRes] = await Promise.all([
      api(`/pockets?month=${state.month}`),
      api(`/summary?month=${state.month}`),
      api(`/transactions?month=${state.month}&limit=50`),
    ]);
    state.pockets = pocketsRes.pockets;
    renderSummary(summaryRes);
    renderPockets(pocketsRes.pockets);
    renderTx(txRes.transactions);
  } catch (err) {
    toast(err.message);
  }
}

function renderSummary(s) {
  $("#sumBalance").textContent = fmt(s.balance);
  $("#sumIncome").textContent = fmt(s.period_income);
  $("#sumExpense").textContent = fmt(s.period_expense);
}

function renderPockets(pockets) {
  const grid = $("#pockets");
  const empty = $("#pocketsEmpty");
  grid.querySelectorAll(".pocket").forEach((el) => el.remove());
  empty.hidden = pockets.length > 0;

  for (const p of pockets) {
    const pctLabel = p.min_percent === p.max_percent
      ? faPct(p.min_percent)
      : `${faPct(p.min_percent)}–${faPct(p.max_percent)}`;
    const neg = p.balance < 0 ? "neg" : "";
    const el = document.createElement("article");
    el.className = "pocket";
    el.innerHTML = `
      <div class="pocket-head">
        <div class="pocket-emoji">${escapeHtml(p.emoji)}</div>
        <div class="pocket-title">
          <div>${escapeHtml(p.name)}</div>
          <div class="pocket-pct">درصد پیشنهادی: ${pctLabel}</div>
        </div>
        <button class="pocket-edit" title="ویرایش" data-edit="${p.id}">✏️</button>
      </div>
      <div class="pocket-balance ${neg}">${fmt(p.balance)}</div>
      <div class="pocket-stats">
        <div class="stat in"><span class="k">ورودی این ماه</span><span class="v">${fmt(p.period_income)}</span></div>
        <div class="stat out"><span class="k">خروجی این ماه</span><span class="v">${fmt(p.period_expense)}</span></div>
      </div>
      <div class="pocket-actions">
        <button class="btn" data-add-income="${p.id}">➕ ورودی</button>
        <button class="btn" data-add-expense="${p.id}">➖ خروجی</button>
      </div>`;
    grid.appendChild(el);
  }
}

function renderTx(list) {
  const ul = $("#txList");
  ul.innerHTML = "";
  $("#txEmpty").hidden = list.length > 0;
  for (const t of list) {
    const li = document.createElement("li");
    li.className = "tx-item";
    const sign = t.type === "income" ? "+" : "−";
    li.innerHTML = `
      <div class="tx-emoji">${escapeHtml(t.pocket_emoji)}</div>
      <div class="tx-main">
        <div class="tx-name">${escapeHtml(t.pocket_name)}${t.note ? " · " + escapeHtml(t.note) : ""}</div>
        <div class="tx-meta">${faDate(t.occurred_on)}</div>
      </div>
      <div class="tx-amount ${t.type}">${sign} ${fmt(t.amount)}</div>
      <button class="tx-del" title="حذف" data-del-tx="${t.id}">🗑️</button>`;
    ul.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ---- مودال تراکنش ---- */
const txDialog = $("#txDialog");
function openTx(type = "expense", pocketId = null) {
  fillPocketSelect($("#txPocket"), pocketId);
  $$("#txForm input[name=txType]").forEach((r) => (r.checked = r.value === type));
  $("#txAmount").value = "";
  $("#txNote").value = "";
  $("#txDate").value = today();
  $("#txDialogTitle").textContent = type === "income" ? "ثبت ورودی" : "ثبت خروجی";
  txDialog.showModal();
  setTimeout(() => $("#txAmount").focus(), 50);
}
function fillPocketSelect(select, selectedId) {
  select.innerHTML = "";
  for (const p of state.pockets) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.emoji} ${p.name}`;
    if (selectedId != null && String(p.id) === String(selectedId)) opt.selected = true;
    select.appendChild(opt);
  }
}
$("#txForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    pocket_id: Number($("#txPocket").value),
    type: $$("#txForm input[name=txType]").find((r) => r.checked).value,
    amount: Number($("#txAmount").value),
    note: $("#txNote").value.trim(),
    occurred_on: $("#txDate").value,
  };
  if (!(body.amount >= 0)) return toast("مبلغ نامعتبر است");
  try {
    await api("/transactions", { method: "POST", body: JSON.stringify(body) });
    txDialog.close();
    toast("ثبت شد ✅");
    refresh();
  } catch (err) { toast(err.message); }
});

/* ---- مودال تقسیم حقوق ---- */
const distDialog = $("#distDialog");
function openDistribute() {
  $("#distAmount").value = "";
  $("#distDate").value = today();
  buildDistRows(true);
  distDialog.showModal();
  setTimeout(() => $("#distAmount").focus(), 50);
}
function buildDistRows(useDefault) {
  const wrap = $("#distRows");
  wrap.innerHTML = "";
  for (const p of state.pockets) {
    const def = (Number(p.min_percent) + Number(p.max_percent)) / 2;
    const row = document.createElement("div");
    row.className = "dist-row";
    row.innerHTML = `
      <span class="name">${escapeHtml(p.emoji)} ${escapeHtml(p.name)}</span>
      <input type="number" min="0" max="100" step="0.5" data-pocket="${p.id}" value="${useDefault ? def : 0}" />
      <span class="pct-sign">٪</span>`;
    wrap.appendChild(row);
  }
  wrap.querySelectorAll("input").forEach((i) => i.addEventListener("input", updateDistTotal));
  updateDistTotal();
}
function updateDistTotal() {
  let total = 0;
  $$("#distRows input").forEach((i) => (total += Number(i.value) || 0));
  $("#distTotalPct").textContent = faPct(total);
}
$("#distReset").addEventListener("click", () => buildDistRows(true));
$("#distForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = Number($("#distAmount").value);
  if (!(amount > 0)) return toast("مبلغ حقوق نامعتبر است");
  const allocations = $$("#distRows input")
    .map((i) => ({ pocket_id: Number(i.dataset.pocket), percent: Number(i.value) || 0 }))
    .filter((a) => a.percent > 0);
  if (!allocations.length) return toast("حداقل یک درصد را وارد کنید");
  try {
    await api("/distribute", {
      method: "POST",
      body: JSON.stringify({ amount, occurred_on: $("#distDate").value, allocations }),
    });
    distDialog.close();
    toast("حقوق تقسیم شد 💸");
    refresh();
  } catch (err) { toast(err.message); }
});

/* ---- مودال پاکت ---- */
const pocketDialog = $("#pocketDialog");
function openPocket(pocket = null) {
  const isEdit = !!pocket;
  $("#pocketDialogTitle").textContent = isEdit ? "ویرایش پاکت" : "پاکت جدید";
  $("#pocketId").value = isEdit ? pocket.id : "";
  $("#pocketEmoji").value = isEdit ? pocket.emoji : "💰";
  $("#pocketName").value = isEdit ? pocket.name : "";
  $("#pocketMin").value = isEdit ? pocket.min_percent : 0;
  $("#pocketMax").value = isEdit ? pocket.max_percent : 0;
  $("#pocketDelete").hidden = !isEdit;
  pocketDialog.showModal();
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
    pocketDialog.close();
    toast("ذخیره شد ✅");
    refresh();
  } catch (err) { toast(err.message); }
});
$("#pocketDelete").addEventListener("click", async () => {
  const id = $("#pocketId").value;
  if (!id) return;
  if (!confirm("این پاکت و همه‌ی تراکنش‌هایش حذف شوند؟")) return;
  try {
    await api(`/pockets/${id}`, { method: "DELETE" });
    pocketDialog.close();
    toast("حذف شد");
    refresh();
  } catch (err) { toast(err.message); }
});

/* ---- رویدادهای عمومی ---- */
$("#btnAddTx").addEventListener("click", () => openTx("expense"));
$("#btnDistribute").addEventListener("click", openDistribute);
$("#btnAddPocket").addEventListener("click", () => openPocket());

document.body.addEventListener("click", (e) => {
  const t = e.target.closest("[data-close]");
  if (t) { t.closest("dialog").close(); return; }

  const addIn = e.target.closest("[data-add-income]");
  if (addIn) return openTx("income", addIn.dataset.addIncome);
  const addOut = e.target.closest("[data-add-expense]");
  if (addOut) return openTx("expense", addOut.dataset.addExpense);

  const edit = e.target.closest("[data-edit]");
  if (edit) {
    const p = state.pockets.find((x) => String(x.id) === edit.dataset.edit);
    if (p) openPocket(p);
    return;
  }
  const del = e.target.closest("[data-del-tx]");
  if (del) return deleteTx(del.dataset.delTx);
});

async function deleteTx(id) {
  if (!confirm("این تراکنش حذف شود؟")) return;
  try {
    await api(`/transactions/${id}`, { method: "DELETE" });
    toast("حذف شد");
    refresh();
  } catch (err) { toast(err.message); }
}

/* ---- کنترل‌های هدر ---- */
const monthInput = $("#monthInput");
monthInput.value = state.month;
monthInput.addEventListener("change", () => {
  state.month = monthInput.value || currentMonth();
  refresh();
});
const currencySelect = $("#currencySelect");
currencySelect.value = state.currency;
currencySelect.addEventListener("change", () => {
  state.currency = currencySelect.value;
  localStorage.setItem("fin_currency", state.currency);
  refresh();
});

/* ---- وضعیت آفلاین ---- */
function updateOnline() {
  $("#offlineBadge").hidden = navigator.onLine;
}
window.addEventListener("online", updateOnline);
window.addEventListener("offline", updateOnline);
updateOnline();

/* ---- Service Worker ---- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

/* ---- شروع ---- */
refresh();
