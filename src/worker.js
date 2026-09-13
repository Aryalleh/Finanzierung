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
const OTP_TTL_MIN = 5;
const CURRENCIES = ["IRT", "IRR", "EUR", "USD", "TRY"];
const DEFAULT_CURRENCY = "IRT";

const DEFAULT_POCKETS = [
  ["اجاره و هزینه‌های ثابت", "🏠", 35, 45, 1],
  ["غذا و خرید روزمره", "🛒", 10, 15, 2],
  ["حمل‌ونقل", "🚆", 5, 10, 3],
  ["قبض و اشتراک‌ها", "📱", 5, 5, 4],
  ["تفریح و خرید شخصی", "🎉", 10, 10, 5],
  ["پس‌انداز اضطراری", "💰", 10, 15, 6],
  ["سرمایه‌گذاری / پس‌انداز هدفمند", "📈", 5, 10, 7],
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
  schemaReady = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password_hash TEXT,
      password_salt TEXT,
      telegram_id TEXT UNIQUE,
      telegram_username TEXT,
      telegram_chat_id TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS otp_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pockets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL,
      name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '💰',
      min_percent REAL NOT NULL DEFAULT 0, max_percent REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'IRT', sort_order INTEGER NOT NULL DEFAULT 0,
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
  return schemaReady;
}

async function seedPockets(db, userId, currency) {
  for (const [name, emoji, min, max, order] of DEFAULT_POCKETS) {
    const res = await db.prepare(
      `INSERT INTO pockets (owner_id, name, emoji, min_percent, max_percent, currency, sort_order) VALUES (?,?,?,?,?,?,?)`
    ).bind(userId, name, emoji, min, max, currency, order).run();
    await db.prepare(`INSERT INTO pocket_members (pocket_id, user_id, role) VALUES (?,?, 'owner')`)
      .bind(res.meta.last_row_id, userId).run();
  }
}

/* ---------- کاربر / نشست ---------- */
async function getUser(req, db) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.email, u.telegram_username, u.telegram_id, u.display_name
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
  return { id: u.id, email: u.email || null, telegram_username: u.telegram_username || null, display_name: u.display_name || null };
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
async function sendTelegramMessage(botToken, chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return res.ok;
  } catch {
    return false; // خطای شبکه نباید صدور کد را متوقف کند
  }
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

      const tgId = String(tgUser.id);
      const uname = tgUser.username || null;
      const display = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(" ") || uname || "کاربر تلگرام";
      let u = await db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).bind(tgId).first();
      if (u) {
        await db.prepare(`UPDATE users SET telegram_username=?, telegram_chat_id=?, display_name=COALESCE(display_name,?) WHERE id=?`)
          .bind(uname, tgId, display, u.id).run();
      } else {
        const res = await db.prepare(`INSERT INTO users (telegram_id, telegram_username, telegram_chat_id, display_name) VALUES (?,?,?,?)`)
          .bind(tgId, uname, tgId, display).run();
        u = { id: res.meta.last_row_id, email: null, telegram_username: uname, display_name: display };
        await seedPockets(db, u.id, DEFAULT_CURRENCY);
      }
      const cookie = await createSession(db, u.id, req);
      return json({ user: publicUser(u) }, 200, { "Set-Cookie": cookie });
    }

    if (sub === "request-otp" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const u = await userByIdentifier(db, b.identifier);
      if (!u || !u.telegram_chat_id)
        return json({ error: "کاربر تلگرامی با این مشخصات یافت نشد؛ ابتدا از مینی‌اپ تلگرام وارد شوید" }, 404);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeHash = await sha256hex(code + ":" + u.id);
      const expires = new Date(Date.now() + OTP_TTL_MIN * 60000).toISOString();
      await db.prepare(`DELETE FROM otp_codes WHERE user_id = ?`).bind(u.id).run();
      await db.prepare(`INSERT INTO otp_codes (user_id, code_hash, expires_at) VALUES (?,?,?)`).bind(u.id, codeHash, expires).run();
      let sent = false;
      if (token) sent = await sendTelegramMessage(token, u.telegram_chat_id, `کد ورود شما به مدیریت حقوق ماهانه:\n\n${code}\n\nاعتبار: ${OTP_TTL_MIN} دقیقه`);
      const out = { ok: true, sent };
      if (devMode) out.dev_code = code; // فقط در حالت توسعه
      return json(out);
    }

    if (sub === "verify-otp" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const u = await userByIdentifier(db, b.identifier);
      if (!u) return json({ error: "کاربر یافت نشد" }, 404);
      const row = await db.prepare(`SELECT * FROM otp_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1`).bind(u.id).first();
      if (!row || row.consumed || row.expires_at <= new Date().toISOString()) return json({ error: "کد منقضی شده است؛ دوباره درخواست کنید" }, 400);
      if (row.attempts >= 5) return json({ error: "تعداد تلاش بیش از حد؛ دوباره درخواست کنید" }, 429);
      await db.prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`).bind(row.id).run();
      const codeHash = await sha256hex((b.code || "").toString().trim() + ":" + u.id);
      if (!safeEqual(codeHash, row.code_hash)) return json({ error: "کد نادرست است" }, 401);
      await db.prepare(`UPDATE otp_codes SET consumed = 1 WHERE id = ?`).bind(row.id).run();
      const cookie = await createSession(db, u.id, req);
      return json({ user: publicUser(u) }, 200, { "Set-Cookie": cookie });
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

  /* --- فهرست ارزها --- */
  if (resource === "currencies" && method === "GET") {
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

  /* --- پاکت‌ها --- */
  if (resource === "pockets") {
    if (method === "GET" && !id) {
      const currency = validCurrency(url.searchParams.get("currency"));
      const { start, end } = monthRange(url.searchParams.get("month"));
      const { results } = await db.prepare(
        `SELECT p.id, p.owner_id, p.name, p.emoji, p.min_percent, p.max_percent, p.currency, p.sort_order,
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
          currency: r.currency, sort_order: r.sort_order,
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
      const { order } = await db.prepare(`SELECT COALESCE(MAX(sort_order),0)+1 AS "order" FROM pockets WHERE owner_id=? AND currency=?`).bind(uid, currency).first();
      const res = await db.prepare(`INSERT INTO pockets (owner_id, name, emoji, min_percent, max_percent, currency, sort_order) VALUES (?,?,?,?,?,?,?)`)
        .bind(uid, name, emoji, min, max, currency, order).run();
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
      if (!name) return badRequest("نام نمی‌تواند خالی باشد");
      await db.prepare(`UPDATE pockets SET name=?, emoji=?, min_percent=?, max_percent=? WHERE id=?`).bind(name, emoji, min, max, id).run();
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

  return notFound("مسیر API یافت نشد");
}

async function handleApi(req, env, path) {
  const db = env.DB;
  await ensureSchema(db);
  const segments = path.split("/").filter(Boolean);
  if (segments[1] === "health") return json({ ok: true, name: "finanzierung", time: new Date().toISOString() });
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
