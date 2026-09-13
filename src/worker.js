/**
 * Finanzierung — مدیریت حقوق ماهانه
 * Cloudflare Worker: API روی D1 + سرو فایل‌های ثابت PWA.
 *
 * امکانات: ورود با ایمیل/رمز و تلگرام (مینی‌اپ + OTP رباتی)، حساب مجزا برای هر ارز،
 * پاکت‌های مشترک بین کاربران، و دفتر قرض بین کاربران.
 */

const COOKIE_NAME = "fin_session";
const SESSION_TTL_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;
const LOGIN_REQUEST_TTL_MIN = 3;
const CURRENCIES = ["IRT", "IRR", "EUR", "USD", "TRY"];
const DEFAULT_CURRENCY = "IRT";

// نوع هر پاکت برای نمره‌دهی: essential | discretionary | savings | investment
const POCKET_KINDS = ["essential", "discretionary", "savings", "investment"];
const DEFAULT_POCKETS = [
  ["اجاره و هزینه‌های ثابت", "🏠", 35, 45, 1, "essential"],
  ["غذا و خرید روزمره", "🛒", 10, 15, 2, "essential"],
  ["حمل‌ونقل", "🚆", 5, 10, 3, "essential"],
  ["قبض و اشتراک‌ها", "📱", 5, 5, 4, "essential"],
  ["تفریح و خرید شخصی", "🎉", 10, 10, 5, "discretionary"],
  ["پس‌انداز اضطراری", "💰", 10, 15, 6, "savings"],
  ["سرمایه‌گذاری / پس‌انداز هدفمند", "📈", 5, 10, 7, "investment"],
];

/* ---------- پاسخ‌ها ---------- */
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
const badRequest = (m) => json({ error: m }, 400);
const unauthorized = (m = "ابتدا وارد شوید") => json({ error: m }, 401);
const forbidden = (m = "دسترسی مجاز نیست") => json({ error: m }, 403);
const notFound = (m = "یافت نشد") => json({ error: m }, 404);

/* ---------- رمزنگاری ---------- */
const enc = new TextEncoder();
function bytesToHex(b) { return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
function randomToken(len = 32) { return bytesToHex(crypto.getRandomValues(new Uint8Array(len))); }
function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function hmac(keyBytes, msgBytes) {
  const k = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, msgBytes));
}
async function derivePassword(pw, salt) {
  const km = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, km, 256);
  return bytesToHex(new Uint8Array(bits));
}
async function hashPassword(pw) { const salt = crypto.getRandomValues(new Uint8Array(16)); return { hash: await derivePassword(pw, salt), salt: bytesToHex(salt) }; }
async function verifyPassword(pw, saltHex, expected) { return safeEqual(await derivePassword(pw, hexToBytes(saltHex)), expected); }
async function sha256hex(s) { return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))); }

/* ---------- کوکی ---------- */
function parseCookies(req) {
  const h = req.headers.get("Cookie") || "";
  const out = {};
  h.split(";").forEach((p) => { const i = p.indexOf("="); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function sessionCookie(token, req) {
  const secure = new URL(req.url).protocol === "https:";
  const maxAge = SESSION_TTL_DAYS * 86400;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
function clearCookie(req) {
  const secure = new URL(req.url).protocol === "https:";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/* ---------- طرح پایگاه‌داده ---------- */
let schemaReady = null;
async function ensureSchema(db) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password_hash TEXT,
      password_salt TEXT,
      telegram_id TEXT UNIQUE,
      telegram_username TEXT,
      telegram_chat_id TEXT,
      telegram_photo_url TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_requests (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', consumed INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pockets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL,
      name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '💰',
      min_percent REAL NOT NULL DEFAULT 0, max_percent REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'IRT', kind TEXT NOT NULL DEFAULT 'discretionary',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pocket_members (
      pocket_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (pocket_id, user_id),
      FOREIGN KEY (pocket_id) REFERENCES pockets(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pocket_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income','expense')), amount REAL NOT NULL CHECK (amount >= 0),
      note TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'IRT',
      occurred_on TEXT NOT NULL DEFAULT (date('now')), created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (pocket_id) REFERENCES pockets(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lender_id INTEGER NOT NULL, borrower_id INTEGER NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0), repaid REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'IRT', note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (lender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (borrower_id) REFERENCES users(id) ON DELETE CASCADE)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pockets_owner ON pockets(owner_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pm_user ON pocket_members(user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tx_pocket ON transactions(pocket_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(occurred_on)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_loans_lender ON loans(lender_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower_id)`),
  ]);

  // ---- ترمیم خودکار دیتابیس‌های قدیمی: افزودن ستون‌های جدید (هر کدام جدا و بی‌خطر) ----
  const alters = [
    "ALTER TABLE users ADD COLUMN telegram_id TEXT",
    "ALTER TABLE users ADD COLUMN telegram_username TEXT",
    "ALTER TABLE users ADD COLUMN telegram_chat_id TEXT",
    "ALTER TABLE users ADD COLUMN telegram_photo_url TEXT",
    "ALTER TABLE users ADD COLUMN display_name TEXT",
    "ALTER TABLE users ADD COLUMN password_hash TEXT",
    "ALTER TABLE users ADD COLUMN password_salt TEXT",
    "ALTER TABLE pockets ADD COLUMN owner_id INTEGER",
    "ALTER TABLE pockets ADD COLUMN currency TEXT NOT NULL DEFAULT 'IRT'",
    "ALTER TABLE pockets ADD COLUMN kind TEXT NOT NULL DEFAULT 'discretionary'",
    "ALTER TABLE transactions ADD COLUMN user_id INTEGER",
    "ALTER TABLE transactions ADD COLUMN currency TEXT NOT NULL DEFAULT 'IRT'",
  ];
  for (const sql of alters) { try { await db.prepare(sql).run(); } catch (e) { /* ستون از قبل هست */ } }

  // بازپرکردن داده‌های لازم برای مدل جدید (بی‌خطر و idempotent)
  try { await db.prepare(`UPDATE pockets SET owner_id = user_id WHERE owner_id IS NULL AND user_id IS NOT NULL`).run(); } catch (e) {}
  try { await db.prepare(`INSERT OR IGNORE INTO pocket_members (pocket_id, user_id, role) SELECT id, owner_id, 'owner' FROM pockets WHERE owner_id IS NOT NULL`).run(); } catch (e) {}
  try { await db.prepare(`UPDATE transactions SET user_id = (SELECT owner_id FROM pockets WHERE pockets.id = transactions.pocket_id) WHERE user_id IS NULL`).run(); } catch (e) {}
  try { await db.prepare(`UPDATE transactions SET currency = (SELECT currency FROM pockets WHERE pockets.id = transactions.pocket_id) WHERE currency IS NULL OR currency = ''`).run(); } catch (e) {}
  })();
  // اگر مهاجرت شکست خورد، cache را پاک کن تا درخواست بعدی دوباره تلاش کند (نه اینکه برای همیشه ۵۰۰ بدهد)
  schemaReady.catch(() => { schemaReady = null; });
  return schemaReady;
}

async function seedPockets(db, userId, currency) {
  for (const [name, emoji, min, max, order, kind] of DEFAULT_POCKETS) {
    const res = await db.prepare(
      `INSERT INTO pockets (owner_id, name, emoji, min_percent, max_percent, currency, kind, sort_order) VALUES (?,?,?,?,?,?,?,?)`
    ).bind(userId, name, emoji, min, max, currency, kind, order).run();
    await db.prepare(`INSERT INTO pocket_members (pocket_id, user_id, role) VALUES (?,?, 'owner')`)
      .bind(res.meta.last_row_id, userId).run();
  }
}
function validKind(k) { return POCKET_KINDS.includes(k) ? k : "discretionary"; }

/* ---------- کاربر / نشست ---------- */
async function getUser(req, db) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.email, u.telegram_username, u.telegram_id, u.display_name, u.telegram_photo_url
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();
}
async function createSession(db, userId, req) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString();
  await db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)`).bind(token, userId, expires).run();
  return sessionCookie(token, req);
}
function publicUser(u) {
  return { id: u.id, email: u.email || null, telegram_username: u.telegram_username || null, display_name: u.display_name || null, photo_url: u.telegram_photo_url || null };
}
async function userByIdentifier(db, idRaw) {
  const id = (idRaw || "").toString().trim();
  if (!id) return null;
  // «@username» تلگرام یا ایمیل. اگر با @ شروع شود یا ایمیل معتبر نباشد → نام کاربری تلگرام.
  if (!id.startsWith("@") && isValidEmail(id))
    return db.prepare(`SELECT * FROM users WHERE email = ?`).bind(id.toLowerCase()).first();
  const uname = id.replace(/^@/, "").toLowerCase();
  return db.prepare(`SELECT * FROM users WHERE lower(telegram_username) = ?`).bind(uname).first();
}
function isValidEmail(e) { return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254; }
function validCurrency(c) { return CURRENCIES.includes(c) ? c : DEFAULT_CURRENCY; }

/* ---------- کمک‌ها ---------- */
function monthRange(month) {
  const now = new Date();
  let y, m;
  if (month && /^\d{4}-\d{2}$/.test(month)) [y, m] = month.split("-").map(Number);
  else { y = now.getUTCFullYear(); m = now.getUTCMonth() + 1; }
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return { start, end: `${ny}-${String(nm).padStart(2, "0")}-01` };
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function monthAdd(month, delta) {
  let [y, m] = month.split("-").map(Number);
  m += delta;
  while (m <= 0) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

/* ============ موتور نمره‌دهی مدیریت مالی ============ */
// جداول امتیاز (بر پایه‌ی الگوریتم مورد توافق)
const catScore = (d) => (d <= 0 ? 100 : d <= 0.1 ? 95 : d <= 0.25 ? 85 : d <= 0.5 ? 70 : d <= 1 ? 45 : 0);
const savingsBase = (r) => (r < 0 ? 0 : r < 0.05 ? 8 : r < 0.1 ? 15 : r < 0.15 ? 21 : r < 0.2 ? 25 : r < 0.25 ? 28 : 30);
const savingsBonus = (imp) => (imp <= 0 ? 0 : imp <= 0.05 ? 1 : imp <= 0.1 ? 3 : 5);
const liquidityScore = (r) => (r >= 1.2 ? 15 : r >= 1 ? 13 : r >= 0.9 ? 8 : r >= 0.75 ? 4 : 0);
const stabilityScore = (g) => (g <= 0 ? 10 : g <= 0.1 ? 9 : g <= 0.2 ? 7 : g <= 0.4 ? 5 : g <= 0.7 ? 3 : 0);
const lifestyleScore = (rate, target) => (rate <= target ? 10 : rate <= target + 0.05 ? 8 : rate <= target + 0.1 ? 6 : rate <= target + 0.2 ? 3 : 0);
function scoreLabel(s) {
  if (s >= 90) return { label: "عالی", emoji: "🌟", tone: "great" };
  if (s >= 75) return { label: "خوب", emoji: "✅", tone: "good" };
  if (s >= 60) return { label: "متوسط", emoji: "⚠️", tone: "ok" };
  if (s >= 40) return { label: "نیاز به بهبود", emoji: "🟠", tone: "warn" };
  return { label: "پرخرج", emoji: "🔴", tone: "bad" };
}

async function aggregateMonth(db, uid, currency, month) {
  const { start, end } = monthRange(month);
  const { results } = await db.prepare(
    `SELECT p.id, p.name, p.kind, p.min_percent, p.max_percent,
       COALESCE(SUM(CASE WHEN t.type='income'  AND t.occurred_on>=?2 AND t.occurred_on<?3 THEN t.amount END),0) AS inc,
       COALESCE(SUM(CASE WHEN t.type='expense' AND t.occurred_on>=?2 AND t.occurred_on<?3 THEN t.amount END),0) AS exp
     FROM pockets p JOIN pocket_members pm ON pm.pocket_id=p.id AND pm.user_id=?1
     LEFT JOIN transactions t ON t.pocket_id=p.id
     WHERE p.currency=?4 GROUP BY p.id`
  ).bind(uid, start, end, currency).all();

  const loan = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN lender_id=?1 THEN amount END),0) AS lent,
       COALESCE(SUM(CASE WHEN borrower_id=?1 THEN amount END),0) AS borrowed
     FROM loans WHERE currency=?2 AND status IN ('active','settled') AND created_at>=?3 AND created_at<?4`
  ).bind(uid, currency, start, end).first();

  let income = 0, essential_out = 0, discretionary_out = 0, saved = 0, disc_budget_rate = 0;
  const spending = [];
  for (const r of results) {
    income += r.inc;
    const mid = (Number(r.min_percent) + Number(r.max_percent)) / 2 / 100;
    if (r.kind === "essential" || r.kind === "discretionary") {
      spending.push({ name: r.name, kind: r.kind, weight: mid, out: r.exp });
      if (r.kind === "essential") essential_out += r.exp;
      else { discretionary_out += r.exp; disc_budget_rate += mid; }
    } else { saved += (r.inc - r.exp); } // savings + investment: خالص کنارگذاشته‌شده
  }
  return { income, essential_out, discretionary_out, saved, disc_budget_rate, spending,
    lent: loan.lent, borrowed: loan.borrowed,
    has_data: income > 0 || essential_out > 0 || discretionary_out > 0 || saved !== 0 };
}

async function savingBaseline(db, uid, currency, month) {
  let sum = 0, n = 0;
  for (let i = 1; i <= 3; i++) {
    const a = await aggregateMonth(db, uid, currency, monthAdd(month, -i));
    if (a.income > 0) { sum += a.saved / a.income; n++; }
  }
  return n ? sum / n : null;
}

async function computeScore(db, uid, currency, month, withMomentum = true) {
  const agg = await aggregateMonth(db, uid, currency, month);
  if (!agg.has_data) return { month, currency, score: null, has_data: false };
  const income = agg.income || 0;

  // ۱) کنترل بودجه (۳۵)
  let bw = 0, bAcc = 0, worst = null;
  for (const p of agg.spending) {
    const budget = income * p.weight;
    let cs;
    if (budget <= 0) cs = p.out > 0 ? 0 : 100;
    else { const dev = (p.out - budget) / budget; cs = catScore(dev); if (dev > 0 && (!worst || dev > worst.dev)) worst = { name: p.name, dev }; }
    const w = p.weight > 0 ? p.weight : 0.01;
    bAcc += cs * w; bw += w;
  }
  const budgetScore = (bw > 0 ? bAcc / bw : 100) / 100 * 35;

  // ۲) پس‌انداز (۳۰) + پاداش (۵)
  const savingRate = income > 0 ? agg.saved / income : 0;
  const baseline = await savingBaseline(db, uid, currency, month);
  const improvement = baseline == null ? 0 : savingRate - baseline;
  const savBase = savingsBase(savingRate);
  const bonus = savingsBonus(improvement);
  const savingsTotal = savBase + bonus;

  // ۳) نقدینگی (۱۵)
  const availForEssentials = income - agg.discretionary_out - Math.max(0, agg.saved);
  const liqRatio = agg.essential_out > 0 ? availForEssentials / agg.essential_out : (availForEssentials >= 0 ? 1.5 : 0);
  let liq = liquidityScore(liqRatio);
  if (agg.borrowed > 0) liq = Math.min(liq, 5);

  // ۴) ثبات (۱۰)
  const prev = await aggregateMonth(db, uid, currency, monthAdd(month, -1));
  const dGrowth = prev.discretionary_out > 0 ? (agg.discretionary_out - prev.discretionary_out) / prev.discretionary_out : (agg.discretionary_out > 0 ? 1 : 0);
  const incGrowth = prev.income > 0 ? (income - prev.income) / prev.income : 0;
  const stab = stabilityScore(dGrowth - Math.max(0, incGrowth));

  // ۵) ولخرجی (۱۰)
  const discRate = income > 0 ? agg.discretionary_out / income : 0;
  const target = agg.disc_budget_rate > 0 ? agg.disc_budget_rate : 0.15;
  const life = lifestyleScore(discRate, target);

  // قرض: دادن مثبت، گرفتن منفی
  const loanFactor = income > 0 ? (agg.lent - agg.borrowed) / income : 0;
  const loanAdj = clamp(loanFactor * 20, -10, 5);

  let raw = budgetScore + savingsTotal + liq + stab + life + loanAdj;
  let final = clamp(raw, 0, 100);
  if (liqRatio < 0.9) final = Math.min(final, 59);   // هزینه‌های ضروری تأمین نشده
  if (agg.borrowed > 0) final = Math.min(final, 69);  // برای هزینه‌ی عادی قرض گرفته
  final = Math.round(final);

  // توصیه‌ها
  const recs = [];
  if (worst && worst.dev > 0.1) recs.push({ type: "budget", text: `این ماه ${Math.round(worst.dev * 100)}٪ بیشتر از بودجه‌ی «${worst.name}» خرج کردی.` });
  if (agg.borrowed > 0) recs.push({ type: "loan", text: "این ماه قرض گرفتی؛ نمره را کاهش داد. سعی کن ماه بعد بدون قرض هزینه‌ها را پوشش دهی." });
  if (savBase < 21) recs.push({ type: "savings", text: `نرخ پس‌اندازت ${Math.round(savingRate * 100)}٪ بود؛ افزایش آن نمره را بالا می‌برد.` });
  if (liq < 13) recs.push({ type: "liquidity", text: "پوشش هزینه‌های ضروری‌ات این ماه ضعیف بود." });
  if (life < 8) recs.push({ type: "lifestyle", text: `هزینه‌های اختیاری ${Math.round(discRate * 100)}٪ درآمدت را تشکیل داد.` });
  const positives = [];
  if (bonus > 0 && improvement > 0) positives.push(`این ماه ${Math.round(improvement * 100)} واحد درصد بهتر از میانگین معمولت پس‌انداز کردی. 👏`);
  if (agg.lent > agg.borrowed && agg.lent > 0) positives.push("این ماه قرض دادی؛ نشانه‌ی مدیریت خوب نقدینگی. 👍");

  const meta = scoreLabel(final);
  const result = {
    month, currency, score: final, has_data: true, label: meta.label, label_emoji: meta.emoji, tone: meta.tone,
    breakdown: {
      budget: { score: Math.round(budgetScore * 10) / 10, max: 35 },
      savings: { score: savBase, bonus, max: 30, saving_rate: Math.round(savingRate * 1000) / 10, baseline: baseline == null ? null : Math.round(baseline * 1000) / 10 },
      liquidity: { score: liq, max: 15, ratio: Math.round(liqRatio * 100) / 100 },
      stability: { score: stab, max: 10 },
      lifestyle: { score: life, max: 10, discretionary_rate: Math.round(discRate * 1000) / 10 },
      loan_adjustment: Math.round(loanAdj * 10) / 10,
    },
    recommendations: recs.slice(0, 2),
    positives: positives.slice(0, 2),
  };
  if (withMomentum) {
    result.momentum = [];
    for (let i = 2; i >= 0; i--) {
      const m = monthAdd(month, -i);
      const s = i === 0 ? final : (await computeScore(db, uid, currency, m, false)).score;
      result.momentum.push({ month: m, score: s });
    }
  }
  return result;
}

/* ---------- تلگرام ---------- */
async function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dcs = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  const mac = bytesToHex(await hmac(secret, enc.encode(dcs)));
  if (!safeEqual(mac, hash)) return null;
  const authDate = Number(params.get("auth_date")) * 1000;
  if (!authDate || Date.now() - authDate > 86400 * 1000) return null; // حداکثر یک روز
  try { return JSON.parse(params.get("user")); } catch { return null; }
}
// اعتبارسنجی داده‌ی Telegram Login Widget (secret = SHA256(token))
async function verifyLoginWidget(data, botToken) {
  if (!data || !data.hash) return null;
  const pairs = Object.keys(data).filter((k) => k !== "hash").sort().map((k) => `${k}=${data[k]}`).join("\n");
  const secret = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(botToken)));
  const mac = bytesToHex(await hmac(secret, enc.encode(pairs)));
  if (!safeEqual(mac, String(data.hash))) return null;
  const authDate = Number(data.auth_date) * 1000;
  if (!authDate || Date.now() - authDate > 86400 * 1000) return null;
  return { id: data.id, username: data.username, first_name: data.first_name, last_name: data.last_name, photo_url: data.photo_url };
}
// ساخت/به‌روزرسانی کاربر تلگرام (مشترک بین مینی‌اپ و ویجت)
async function upsertTelegramUser(db, tgUser, req) {
  const tgId = String(tgUser.id);
  const uname = tgUser.username || null;
  const photo = tgUser.photo_url || null;
  const display = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || uname || "کاربر تلگرام";
  let u = await db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(tgId).first();
  if (u) {
    await db.prepare(`UPDATE users SET telegram_username=?, telegram_chat_id=?, telegram_photo_url=?, display_name=COALESCE(display_name,?) WHERE id=?`)
      .bind(uname, tgId, photo, display, u.id).run();
    u.telegram_photo_url = photo;
  } else {
    const res = await db.prepare(`INSERT INTO users (telegram_id, telegram_username, telegram_chat_id, telegram_photo_url, display_name) VALUES (?,?,?,?,?)`)
      .bind(tgId, uname, tgId, photo, display).run();
    u = { id: res.meta.last_row_id, email: null, telegram_username: uname, display_name: display, telegram_photo_url: photo };
    await seedPockets(db, u.id, DEFAULT_CURRENCY);
  }
  return u;
}
let botUsernameCache;
async function getBotUsername(token) {
  if (botUsernameCache !== undefined) return botUsernameCache;
  try { const r = await fetch(`https://api.telegram.org/bot${token}/getMe`); const j = await r.json(); botUsernameCache = j.result?.username || null; }
  catch { botUsernameCache = null; }
  return botUsernameCache;
}
async function sendTelegramMessage(botToken, chatId, text, replyMarkup) {
  try {
    const body = { chat_id: chatId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return res.ok;
  } catch { return false; }
}
async function telegramApi(botToken, method, payload) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
  } catch {}
}

/* ============ روتر احراز هویت ============ */
async function handleAuth(req, env, db, segments) {
  const method = req.method;
  const action = segments[2];

  // ---- ایمیل ----
  if (action === "register" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const email = (b.email || "").toString().trim().toLowerCase();
    const password = (b.password || "").toString();
    if (!isValidEmail(email)) return badRequest("ایمیل نامعتبر است");
    if (password.length < 8) return badRequest("رمز عبور باید حداقل ۸ کاراکتر باشد");
    if (await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first()) return json({ error: "این ایمیل قبلاً ثبت شده است" }, 409);
    const { hash, salt } = await hashPassword(password);
    const res = await db.prepare(`INSERT INTO users (email, password_hash, password_salt, display_name) VALUES (?,?,?,?)`)
      .bind(email, hash, salt, email.split("@")[0]).run();
    const uid = res.meta.last_row_id;
    await seedPockets(db, uid, DEFAULT_CURRENCY);
    const cookie = await createSession(db, uid, req);
    return json({ user: { id: uid, email } }, 201, { "Set-Cookie": cookie });
  }

  if (action === "login" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const email = (b.email || "").toString().trim().toLowerCase();
    const u = await db.prepare(`SELECT id, email, password_hash, password_salt FROM users WHERE email = ?`).bind(email).first();
    if (!u || !u.password_hash || !(await verifyPassword((b.password || "").toString(), u.password_salt, u.password_hash)))
      return json({ error: "ایمیل یا رمز عبور نادرست است" }, 401);
    const cookie = await createSession(db, u.id, req);
    return json({ user: { id: u.id, email: u.email } }, 200, { "Set-Cookie": cookie });
  }

  if (action === "logout" && method === "POST") {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(token).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(req) });
  }

  if (action === "me" && method === "GET") {
    const u = await getUser(req, db);
    if (!u) return unauthorized();
    return json({ user: publicUser(u) });
  }

  // ---- تلگرام ----
  if (action === "telegram") {
    const sub = segments[3];
    const token = env.TELEGRAM_BOT_TOKEN;
    const devMode = env.DEV_MODE === "1";

    if (sub === "miniapp" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const initData = (b.initData || "").toString();
      if (!initData) return badRequest("initData ارسال نشد");
      let tgUser = null;
      if (token) tgUser = await verifyTelegramInitData(initData, token);
      else if (devMode) { try { tgUser = JSON.parse(new URLSearchParams(initData).get("user")); } catch {} }
      if (!tgUser || !tgUser.id) return json({ error: "اعتبارسنجی تلگرام ناموفق بود" }, 401);
      const u = await upsertTelegramUser(db, tgUser, req);
      const cookie = await createSession(db, u.id, req);
      return json({ user: publicUser(u) }, 200, { "Set-Cookie": cookie });
    }

    // ورود با Telegram Login Widget (در مرورگر — بدون وب‌هوک)
    if (sub === "widget" && method === "POST") {
      if (!token) return json({ error: "ورود تلگرام روی سرور پیکربندی نشده (TELEGRAM_BOT_TOKEN)" }, 400);
      const b = await req.json().catch(() => ({}));
      const tgUser = await verifyLoginWidget(b, token);
      if (!tgUser || !tgUser.id) return json({ error: "اعتبارسنجی تلگرام ناموفق بود" }, 401);
      const u = await upsertTelegramUser(db, tgUser, req);
      const cookie = await createSession(db, u.id, req);
      return json({ user: publicUser(u) }, 200, { "Set-Cookie": cookie });
    }

    // درخواست ورود: پیام تأیید/رد به تلگرام کاربر می‌رود
    if (sub === "request-login" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const u = await userByIdentifier(db, b.identifier);
      if (!u || !u.telegram_chat_id)
        return json({ error: "کاربر تلگرامی با این مشخصات یافت نشد؛ ابتدا از مینی‌اپ تلگرام وارد شوید" }, 404);
      const reqToken = randomToken();
      const expires = new Date(Date.now() + LOGIN_REQUEST_TTL_MIN * 60000).toISOString();
      await db.prepare(`DELETE FROM login_requests WHERE user_id = ? AND status='pending'`).bind(u.id).run();
      await db.prepare(`INSERT INTO login_requests (id, user_id, expires_at) VALUES (?,?,?)`).bind(reqToken, u.id, expires).run();
      if (token) {
        await sendTelegramMessage(token, u.telegram_chat_id,
          `درخواست ورود به «مدیریت حقوق ماهانه»\n\nاگر شما هستید تأیید کنید، در غیر این صورت رد کنید. (اعتبار ${LOGIN_REQUEST_TTL_MIN} دقیقه)`,
          { inline_keyboard: [[
            { text: "✅ تأیید ورود", callback_data: "approve:" + reqToken },
            { text: "❌ رد", callback_data: "deny:" + reqToken },
          ]] });
      }
      const out = { ok: true, token: reqToken };
      if (devMode) out.dev = true; // در حالت توسعه می‌توان مستقیم تأیید کرد
      return json(out);
    }

    // نتیجه‌ی درخواست ورود (کلاینت poll می‌کند)
    if (sub === "login-status" && method === "GET") {
      const reqToken = new URL(req.url).searchParams.get("token");
      if (!reqToken) return badRequest("توکن ارسال نشد");
      const lr = await db.prepare(`SELECT * FROM login_requests WHERE id = ?`).bind(reqToken).first();
      if (!lr || lr.consumed) return json({ status: "expired" });
      if (lr.expires_at <= new Date().toISOString()) return json({ status: "expired" });
      if (lr.status === "approved") {
        await db.prepare(`UPDATE login_requests SET consumed = 1 WHERE id = ?`).bind(reqToken).run();
        const u = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(lr.user_id).first();
        const cookie = await createSession(db, u.id, req);
        return json({ status: "approved", user: publicUser(u) }, 200, { "Set-Cookie": cookie });
      }
      return json({ status: lr.status });
    }

    // فقط برای حالت توسعه: تأیید مستقیم بدون تلگرام
    if (sub === "dev-approve" && method === "POST" && devMode) {
      const b = await req.json().catch(() => ({}));
      await db.prepare(`UPDATE login_requests SET status='approved' WHERE id = ? AND status='pending'`).bind(b.token).run();
      return json({ ok: true });
    }
  }

  return notFound("مسیر یافت نشد");
}

/* ---------- عضویت پاکت ---------- */
async function isMember(db, pocketId, userId) {
  return !!(await db.prepare(`SELECT 1 FROM pocket_members WHERE pocket_id=? AND user_id=?`).bind(pocketId, userId).first());
}
async function pocketOwned(db, pocketId, userId) {
  return db.prepare(`SELECT * FROM pockets WHERE id=? AND owner_id=?`).bind(pocketId, userId).first();
}

/* ============ روتر داده ============ */
async function handleData(req, db, uid, segments) {
  const url = new URL(req.url);
  const method = req.method;
  const resource = segments[1];
  const id = segments[2];
  const sub = segments[3];

  /* --- ارزها --- */
  if (resource === "currencies") {
    if (method === "GET" && !id) {
      const { results } = await db.prepare(
        `SELECT p.currency AS currency,
                COUNT(DISTINCT p.id) AS pockets,
                COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount END),0) - COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount END),0) AS balance
         FROM pockets p JOIN pocket_members pm ON pm.pocket_id=p.id AND pm.user_id=?1
         LEFT JOIN transactions t ON t.pocket_id=p.id
         GROUP BY p.currency ORDER BY p.currency`
      ).bind(uid).all();
      return json({ currencies: results });
    }
    // ساخت حساب یک ارز (با پاکت‌های پیش‌فرض)
    if (method === "POST" && !id) {
      const b = await req.json().catch(() => ({}));
      const currency = validCurrency(b.currency);
      const existing = await db.prepare(`SELECT COUNT(*) AS c FROM pockets WHERE owner_id=? AND currency=?`).bind(uid, currency).first();
      if (existing.c === 0) await seedPockets(db, uid, currency);
      return json({ ok: true, currency }, 201);
    }
    // حذف حساب یک ارز: پاکت‌های متعلق به کاربر در آن ارز و عضویت‌های او در پاکت‌های مشترک همان ارز
    if (method === "DELETE" && id) {
      const currency = validCurrency(id);
      const { results: owned } = await db.prepare(`SELECT id FROM pockets WHERE owner_id=? AND currency=?`).bind(uid, currency).all();
      for (const p of owned) {
        await db.prepare(`DELETE FROM transactions WHERE pocket_id=?`).bind(p.id).run();
        await db.prepare(`DELETE FROM pocket_members WHERE pocket_id=?`).bind(p.id).run();
        await db.prepare(`DELETE FROM pockets WHERE id=?`).bind(p.id).run();
      }
      // خروج از پاکت‌های مشترکِ متعلق به دیگران در این ارز
      await db.prepare(
        `DELETE FROM pocket_members WHERE user_id=? AND role<>'owner' AND pocket_id IN (SELECT id FROM pockets WHERE currency=?)`
      ).bind(uid, currency).run();
      return json({ ok: true });
    }
  }

  /* --- پاکت‌ها --- */
  if (resource === "pockets") {
    if (method === "GET" && !id) {
      const currency = validCurrency(url.searchParams.get("currency"));
      const { start, end } = monthRange(url.searchParams.get("month"));
      const { results } = await db.prepare(
        `SELECT p.id, p.owner_id, p.name, p.emoji, p.min_percent, p.max_percent, p.currency, p.kind, p.sort_order,
          (SELECT COUNT(*) FROM pocket_members pm2 WHERE pm2.pocket_id=p.id) AS member_count,
          COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount END),0) AS all_income,
          COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount END),0) AS all_expense,
          COALESCE(SUM(CASE WHEN t.type='income'  AND t.occurred_on>=?2 AND t.occurred_on<?3 THEN t.amount END),0) AS period_income,
          COALESCE(SUM(CASE WHEN t.type='expense' AND t.occurred_on>=?2 AND t.occurred_on<?3 THEN t.amount END),0) AS period_expense
         FROM pockets p
         JOIN pocket_members pm ON pm.pocket_id=p.id AND pm.user_id=?1
         LEFT JOIN transactions t ON t.pocket_id=p.id
         WHERE p.currency=?4
         GROUP BY p.id ORDER BY p.sort_order, p.id`
      ).bind(uid, start, end, currency).all();
      return json({
        pockets: results.map((r) => ({
          id: r.id, name: r.name, emoji: r.emoji, min_percent: r.min_percent, max_percent: r.max_percent,
          currency: r.currency, kind: r.kind, sort_order: r.sort_order,
          member_count: r.member_count, is_shared: r.member_count > 1, is_owner: r.owner_id === uid,
          period_income: r.period_income, period_expense: r.period_expense,
          balance: r.all_income - r.all_expense,
        })),
      });
    }

    if (method === "POST" && !id) {
      const b = await req.json().catch(() => ({}));
      const name = (b.name || "").toString().trim();
      if (!name) return badRequest("نام پاکت الزامی است");
      const currency = validCurrency(b.currency);
      const emoji = (b.emoji || "💰").toString().slice(0, 8);
      const min = num(b.min_percent) || 0, max = num(b.max_percent) || 0;
      const kind = validKind(b.kind);
      const { order } = await db.prepare(`SELECT COALESCE(MAX(sort_order),0)+1 AS "order" FROM pockets WHERE owner_id=? AND currency=?`).bind(uid, currency).first();
      const res = await db.prepare(`INSERT INTO pockets (owner_id, name, emoji, min_percent, max_percent, currency, kind, sort_order) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(uid, name, emoji, min, max, currency, kind, order).run();
      await db.prepare(`INSERT INTO pocket_members (pocket_id, user_id, role) VALUES (?,?, 'owner')`).bind(res.meta.last_row_id, uid).run();
      return json({ id: res.meta.last_row_id }, 201);
    }

    // POST /api/pockets/seed-defaults
    if (method === "POST" && id === "seed-defaults") {
      const b = await req.json().catch(() => ({}));
      const currency = validCurrency(b.currency);
      const existing = await db.prepare(`SELECT COUNT(*) AS c FROM pockets WHERE owner_id=? AND currency=?`).bind(uid, currency).first();
      if (existing.c > 0) return json({ ok: true, skipped: true });
      await seedPockets(db, uid, currency);
      return json({ ok: true }, 201);
    }

    if (id && sub === "members" && method === "GET") {
      if (!(await isMember(db, id, uid))) return notFound("پاکت یافت نشد");
      const { results } = await db.prepare(
        `SELECT u.id, u.display_name, u.email, u.telegram_username, pm.role
         FROM pocket_members pm JOIN users u ON u.id=pm.user_id WHERE pm.pocket_id=? ORDER BY pm.role DESC, pm.created_at`
      ).bind(id).all();
      return json({ members: results });
    }

    if (id && sub === "share" && method === "POST") {
      const p = await pocketOwned(db, id, uid);
      if (!p) return forbidden("فقط مالک پاکت می‌تواند آن را به اشتراک بگذارد");
      const b = await req.json().catch(() => ({}));
      const other = await userByIdentifier(db, b.identifier);
      if (!other) return notFound("کاربری با این مشخصات یافت نشد");
      if (other.id === uid) return badRequest("نمی‌توانید با خودتان به اشتراک بگذارید");
      if (await isMember(db, id, other.id)) return json({ error: "این کاربر عضو است" }, 409);
      await db.prepare(`INSERT INTO pocket_members (pocket_id, user_id, role) VALUES (?,?, 'member')`).bind(id, other.id).run();
      return json({ ok: true, member: publicUser(other) }, 201);
    }

    if (id && sub === "members" && method === "DELETE") {
      // segments: pockets/:id/members/:memberId
      const memberId = Number(segments[4]);
      const p = await pocketOwned(db, id, uid);
      const removingSelf = memberId === uid;
      if (!p && !removingSelf) return forbidden("مجاز نیست");
      if (p && memberId === p.owner_id) return badRequest("مالک را نمی‌توان حذف کرد");
      await db.prepare(`DELETE FROM pocket_members WHERE pocket_id=? AND user_id=? AND role<>'owner'`).bind(id, memberId).run();
      return json({ ok: true });
    }

    if (method === "PUT" && id) {
      const p = await pocketOwned(db, id, uid);
      if (!p) return forbidden("فقط مالک می‌تواند ویرایش کند");
      const b = await req.json().catch(() => ({}));
      const name = b.name != null ? b.name.toString().trim() : p.name;
      const emoji = b.emoji != null ? b.emoji.toString().slice(0, 8) : p.emoji;
      const min = b.min_percent != null ? num(b.min_percent) : p.min_percent;
      const max = b.max_percent != null ? num(b.max_percent) : p.max_percent;
      const kind = b.kind != null ? validKind(b.kind) : p.kind;
      if (!name) return badRequest("نام نمی‌تواند خالی باشد");
      await db.prepare(`UPDATE pockets SET name=?, emoji=?, min_percent=?, max_percent=?, kind=? WHERE id=?`).bind(name, emoji, min, max, kind, id).run();
      return json({ ok: true });
    }

    if (method === "DELETE" && id) {
      const p = await pocketOwned(db, id, uid);
      if (!p) return forbidden("فقط مالک می‌تواند حذف کند");
      await db.prepare(`DELETE FROM pockets WHERE id=?`).bind(id).run();
      await db.prepare(`DELETE FROM transactions WHERE pocket_id=?`).bind(id).run();
      await db.prepare(`DELETE FROM pocket_members WHERE pocket_id=?`).bind(id).run();
      return json({ ok: true });
    }
  }

  /* --- خلاصه --- */
  if (resource === "summary" && method === "GET") {
    const currency = validCurrency(url.searchParams.get("currency"));
    const { start, end } = monthRange(url.searchParams.get("month"));
    const row = await db.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount END),0) AS all_income,
        COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount END),0) AS all_expense,
        COALESCE(SUM(CASE WHEN t.type='income'  AND t.occurred_on>=?2 AND t.occurred_on<?3 THEN t.amount END),0) AS period_income,
        COALESCE(SUM(CASE WHEN t.type='expense' AND t.occurred_on>=?2 AND t.occurred_on<?3 THEN t.amount END),0) AS period_expense
       FROM transactions t
       JOIN pockets p ON p.id=t.pocket_id
       JOIN pocket_members pm ON pm.pocket_id=p.id AND pm.user_id=?1
       WHERE p.currency=?4`
    ).bind(uid, start, end, currency).first();
    return json({
      balance: row.all_income - row.all_expense, total_income: row.all_income, total_expense: row.all_expense,
      period_income: row.period_income, period_expense: row.period_expense,
    });
  }

  /* --- تراکنش‌ها --- */
  if (resource === "transactions") {
    if (method === "GET" && !id) {
      const currency = validCurrency(url.searchParams.get("currency"));
      const month = url.searchParams.get("month");
      const pocketId = url.searchParams.get("pocket_id");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const clauses = [`pm.user_id=?`, `p.currency=?`];
      const binds = [uid, currency];
      if (month && /^\d{4}-\d{2}$/.test(month)) { const { start, end } = monthRange(month); clauses.push(`t.occurred_on>=? AND t.occurred_on<?`); binds.push(start, end); }
      if (pocketId) { clauses.push(`t.pocket_id=?`); binds.push(pocketId); }
      const { results } = await db.prepare(
        `SELECT t.id, t.pocket_id, t.type, t.amount, t.note, t.occurred_on, t.user_id,
                p.name AS pocket_name, p.emoji AS pocket_emoji,
                u.display_name AS author_name, u.telegram_username AS author_username
         FROM transactions t
         JOIN pockets p ON p.id=t.pocket_id
         JOIN pocket_members pm ON pm.pocket_id=p.id
         JOIN users u ON u.id=t.user_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY t.occurred_on DESC, t.id DESC LIMIT ?`
      ).bind(...binds, limit).all();
      return json({ transactions: results.map((r) => ({ ...r, mine: r.user_id === uid })) });
    }

    if (method === "POST" && !id) {
      const b = await req.json().catch(() => ({}));
      const pocketId = num(b.pocket_id);
      const type = (b.type || "").toString();
      const amount = num(b.amount);
      if (!Number.isFinite(pocketId)) return badRequest("پاکت نامعتبر است");
      if (type !== "income" && type !== "expense") return badRequest("نوع تراکنش نامعتبر است");
      if (!Number.isFinite(amount) || amount < 0) return badRequest("مبلغ نامعتبر است");
      const p = await db.prepare(`SELECT id, currency FROM pockets WHERE id=?`).bind(pocketId).first();
      if (!p || !(await isMember(db, pocketId, uid))) return notFound("پاکت یافت نشد");
      const note = (b.note || "").toString().slice(0, 500);
      const occurred = /^\d{4}-\d{2}-\d{2}$/.test(b.occurred_on || "") ? b.occurred_on : new Date().toISOString().slice(0, 10);
      const res = await db.prepare(`INSERT INTO transactions (pocket_id, user_id, type, amount, note, currency, occurred_on) VALUES (?,?,?,?,?,?,?)`)
        .bind(pocketId, uid, type, amount, note, p.currency, occurred).run();
      return json({ id: res.meta.last_row_id }, 201);
    }

    if (method === "DELETE" && id) {
      const t = await db.prepare(`SELECT t.*, p.owner_id FROM transactions t JOIN pockets p ON p.id=t.pocket_id WHERE t.id=?`).bind(id).first();
      if (!t) return notFound("تراکنش یافت نشد");
      if (t.user_id !== uid && t.owner_id !== uid) return forbidden("فقط سازنده یا مالک پاکت می‌تواند حذف کند");
      await db.prepare(`DELETE FROM transactions WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }
  }

  /* --- تقسیم حقوق --- */
  if (resource === "distribute" && method === "POST") {
    const b = await req.json().catch(() => ({}));
    const amount = num(b.amount);
    const currency = validCurrency(b.currency);
    if (!Number.isFinite(amount) || amount <= 0) return badRequest("مبلغ حقوق نامعتبر است");
    const occurred = /^\d{4}-\d{2}-\d{2}$/.test(b.occurred_on || "") ? b.occurred_on : new Date().toISOString().slice(0, 10);
    const note = (b.note || "تقسیم حقوق").toString().slice(0, 200);
    const { results: pockets } = await db.prepare(
      `SELECT p.id, p.min_percent, p.max_percent FROM pockets p
       JOIN pocket_members pm ON pm.pocket_id=p.id AND pm.user_id=?1 WHERE p.currency=?2 ORDER BY p.sort_order, p.id`
    ).bind(uid, currency).all();
    if (!pockets.length) return badRequest("هیچ پاکتی در این ارز نیست");
    const allowed = new Set(pockets.map((p) => p.id));
    let allocations = Array.isArray(b.allocations) && b.allocations.length
      ? b.allocations.map((a) => ({ pocket_id: num(a.pocket_id), percent: num(a.percent) })).filter((a) => allowed.has(a.pocket_id) && a.percent > 0)
      : pockets.map((p) => ({ pocket_id: p.id, percent: (Number(p.min_percent) + Number(p.max_percent)) / 2 }));
    const totalPercent = allocations.reduce((s, a) => s + a.percent, 0);
    if (totalPercent <= 0) return badRequest("مجموع درصدها نامعتبر است");
    const stmt = db.prepare(`INSERT INTO transactions (pocket_id, user_id, type, amount, note, currency, occurred_on) VALUES (?,?, 'income', ?,?,?,?)`);
    const inserts = [], distributed = [];
    for (const a of allocations) {
      const share = Math.round(amount * (a.percent / totalPercent) * 100) / 100;
      if (share <= 0) continue;
      inserts.push(stmt.bind(a.pocket_id, uid, share, note, currency, occurred));
      distributed.push({ pocket_id: a.pocket_id, amount: share });
    }
    if (inserts.length) await db.batch(inserts);
    return json({ ok: true, distributed }, 201);
  }

  /* --- قرض‌ها --- */
  if (resource === "loans") {
    if (method === "GET" && !id) {
      const { results } = await db.prepare(
        `SELECT l.*, lu.display_name AS lender_name, lu.telegram_username AS lender_username, lu.email AS lender_email,
                bu.display_name AS borrower_name, bu.telegram_username AS borrower_username, bu.email AS borrower_email
         FROM loans l JOIN users lu ON lu.id=l.lender_id JOIN users bu ON bu.id=l.borrower_id
         WHERE l.lender_id=?1 OR l.borrower_id=?1 ORDER BY l.updated_at DESC, l.id DESC`
      ).bind(uid).all();
      const loans = results.map((l) => ({
        id: l.id, amount: l.amount, repaid: l.repaid, outstanding: Math.max(0, l.amount - l.repaid),
        currency: l.currency, note: l.note, status: l.status, created_at: l.created_at,
        i_am_lender: l.lender_id === uid, i_created: l.created_by === uid,
        counterparty: l.lender_id === uid
          ? { name: l.borrower_name, username: l.borrower_username, email: l.borrower_email }
          : { name: l.lender_name, username: l.lender_username, email: l.lender_email },
        can_respond: l.status === "pending" && l.created_by !== uid && (l.lender_id === uid || l.borrower_id === uid),
      }));
      return json({ loans });
    }

    if (method === "POST" && !id) {
      const b = await req.json().catch(() => ({}));
      const amount = num(b.amount);
      const currency = validCurrency(b.currency);
      const direction = b.direction === "borrowed" ? "borrowed" : "lent";
      if (!Number.isFinite(amount) || amount <= 0) return badRequest("مبلغ نامعتبر است");
      const other = await userByIdentifier(db, b.identifier);
      if (!other) return notFound("کاربری با این مشخصات یافت نشد");
      if (other.id === uid) return badRequest("طرف مقابل نمی‌تواند خودتان باشد");
      const lender = direction === "lent" ? uid : other.id;
      const borrower = direction === "lent" ? other.id : uid;
      const note = (b.note || "").toString().slice(0, 300);
      const res = await db.prepare(`INSERT INTO loans (lender_id, borrower_id, amount, currency, note, status, created_by) VALUES (?,?,?,?,?, 'pending', ?)`)
        .bind(lender, borrower, amount, currency, note, uid).run();
      return json({ id: res.meta.last_row_id }, 201);
    }

    if (method === "POST" && id && sub === "respond") {
      const b = await req.json().catch(() => ({}));
      const l = await db.prepare(`SELECT * FROM loans WHERE id=?`).bind(id).first();
      if (!l || (l.lender_id !== uid && l.borrower_id !== uid)) return notFound("قرض یافت نشد");
      if (l.status !== "pending" || l.created_by === uid) return badRequest("این قرض قابل تأیید نیست");
      const status = b.accept ? "active" : "declined";
      await db.prepare(`UPDATE loans SET status=?, updated_at=datetime('now') WHERE id=?`).bind(status, id).run();
      return json({ ok: true, status });
    }

    if (method === "POST" && id && sub === "repay") {
      const b = await req.json().catch(() => ({}));
      const amount = num(b.amount);
      const l = await db.prepare(`SELECT * FROM loans WHERE id=?`).bind(id).first();
      if (!l || (l.lender_id !== uid && l.borrower_id !== uid)) return notFound("قرض یافت نشد");
      if (l.status !== "active") return badRequest("فقط قرض فعال قابل بازپرداخت است");
      if (!Number.isFinite(amount) || amount <= 0) return badRequest("مبلغ نامعتبر است");
      const repaid = Math.min(l.amount, l.repaid + amount);
      const status = repaid >= l.amount ? "settled" : "active";
      await db.prepare(`UPDATE loans SET repaid=?, status=?, updated_at=datetime('now') WHERE id=?`).bind(repaid, status, id).run();
      return json({ ok: true, repaid, status });
    }

    if (method === "DELETE" && id) {
      const l = await db.prepare(`SELECT * FROM loans WHERE id=?`).bind(id).first();
      if (!l) return notFound("قرض یافت نشد");
      if (l.created_by !== uid || l.status !== "pending") return forbidden("فقط سازنده می‌تواند قرض در انتظار را لغو کند");
      await db.prepare(`DELETE FROM loans WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }
  }

  /* --- نمره‌ی مدیریت مالی --- */
  if (resource === "score" && method === "GET") {
    const currency = validCurrency(url.searchParams.get("currency"));
    const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    return json(await computeScore(db, uid, currency, month));
  }

  /* --- رتبه‌بندی بین کاربران (به تفکیک ارز، ماهانه) --- */
  if (resource === "rank" && method === "GET") {
    const currency = validCurrency(url.searchParams.get("currency"));
    const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    const { results: users } = await db.prepare(
      `SELECT DISTINCT pm.user_id FROM pocket_members pm JOIN pockets p ON p.id=pm.pocket_id WHERE p.currency=?`
    ).bind(currency).all();
    const rows = [];
    for (const { user_id } of users) {
      const s = await computeScore(db, user_id, currency, month, false);
      if (!s.has_data || s.score == null) continue;
      const u = await db.prepare(`SELECT id, display_name, email, telegram_username, telegram_photo_url FROM users WHERE id=?`).bind(user_id).first();
      rows.push({ user_id, score: s.score, label: s.label, label_emoji: s.label_emoji,
        name: u.display_name || (u.telegram_username ? "@" + u.telegram_username : (u.email ? u.email.split("@")[0] : "کاربر")),
        photo_url: u.telegram_photo_url || null, is_me: user_id === uid });
    }
    rows.sort((a, b) => b.score - a.score);
    rows.forEach((r, i) => (r.rank = i + 1));
    return json({ month, currency, rank: rows, me: rows.find((r) => r.is_me) || null });
  }

  return notFound("مسیر API یافت نشد");
}

// وب‌هوک تلگرام: مدیریت دکمه‌های تأیید/رد ورود
async function handleTelegramWebhook(req, env, db) {
  if (req.method !== "POST") return notFound();
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return unauthorized("secret نامعتبر");
  const update = await req.json().catch(() => ({}));
  const cq = update.callback_query;
  if (!cq || !cq.data) return json({ ok: true });
  const [action, reqToken] = cq.data.split(":");
  const fromId = String(cq.from?.id || "");
  const token = env.TELEGRAM_BOT_TOKEN;
  if (action === "approve" || action === "deny") {
    const lr = await db.prepare(`SELECT lr.*, u.telegram_id FROM login_requests lr JOIN users u ON u.id=lr.user_id WHERE lr.id=?`).bind(reqToken).first();
    let text = "این درخواست معتبر نیست یا منقضی شده.";
    if (lr && !lr.consumed && lr.status === "pending" && lr.expires_at > new Date().toISOString() && String(lr.telegram_id) === fromId) {
      const status = action === "approve" ? "approved" : "denied";
      await db.prepare(`UPDATE login_requests SET status=? WHERE id=?`).bind(status, reqToken).run();
      text = action === "approve" ? "✅ ورود تأیید شد. به مرورگر برگردید." : "❌ ورود رد شد.";
    }
    if (token) {
      await telegramApi(token, "answerCallbackQuery", { callback_query_id: cq.id, text });
      if (cq.message) await telegramApi(token, "editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text });
    }
  }
  return json({ ok: true });
}

async function handleApi(req, env, path) {
  const db = env.DB;
  await ensureSchema(db);
  const segments = path.split("/").filter(Boolean);
  if (segments[1] === "health") return json({ ok: true, name: "finanzierung", time: new Date().toISOString() });
  if (segments[1] === "config") {
    const token = env.TELEGRAM_BOT_TOKEN;
    return json({ telegram_enabled: !!token, telegram_bot: token ? await getBotUsername(token) : null });
  }
  if (segments[1] === "telegram" && segments[2] === "webhook") return handleTelegramWebhook(req, env, db);
  if (segments[1] === "auth") return handleAuth(req, env, db, segments);
  const user = await getUser(req, db);
  if (!user) return unauthorized();
  return handleData(req, db, user.id, segments);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(req, env, url.pathname); }
      catch (err) { return json({ error: "خطای سرور", detail: String(err && err.message ? err.message : err) }, 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
