/**
 * Finanzierung — مدیریت حقوق ماهانه (چند‌کاربره + ورود)
 * Cloudflare Worker: API روی D1 + سرو فایل‌های ثابت PWA از باندینگ ASSETS.
 *
 * احراز هویت:
 *   POST /api/auth/register  ثبت‌نام (ایمیل + رمز) → کوکی نشست + ساخت پاکت‌های پیش‌فرض
 *   POST /api/auth/login     ورود → کوکی نشست
 *   POST /api/auth/logout    خروج (حذف نشست)
 *   GET  /api/auth/me        کاربر جاری
 *
 * داده‌ها (نیازمند نشست معتبر، محدود به کاربر جاری):
 *   GET/POST/PUT/DELETE /api/pockets[/:id]
 *   GET  /api/summary
 *   GET/POST/DELETE /api/transactions[/:id]
 *   POST /api/distribute
 */

const COOKIE_NAME = "fin_session";
const SESSION_TTL_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;

const DEFAULT_POCKETS = [
  ["اجاره و هزینه‌های ثابت", "🏠", 35, 45, 1],
  ["غذا و خرید روزمره", "🛒", 10, 15, 2],
  ["حمل‌ونقل", "🚆", 5, 10, 3],
  ["قبض و اشتراک‌ها", "📱", 5, 5, 4],
  ["تفریح و خرید شخصی", "🎉", 10, 10, 5],
  ["پس‌انداز اضطراری", "💰", 10, 15, 6],
  ["سرمایه‌گذاری / پس‌انداز هدفمند", "📈", 5, 10, 7],
];

// ---------- پاسخ‌ها ----------
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
const badRequest = (m) => json({ error: m }, 400);
const unauthorized = (m = "ابتدا وارد شوید") => json({ error: m }, 401);
const notFound = (m = "یافت نشد") => json({ error: m }, 404);

// ---------- کمک‌های رمزنگاری ----------
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}
function randomToken(len = 32) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(len)));
}
async function derivePassword(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt);
  return { hash, salt: bytesToHex(salt) };
}
async function verifyPassword(password, saltHex, expectedHex) {
  const hash = await derivePassword(password, hexToBytes(saltHex));
  return safeEqual(hash, expectedHex);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- کوکی ----------
function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === "https:";
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
function clearCookie(request) {
  const secure = new URL(request.url).protocol === "https:";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

// ---------- طرح پایگاه‌داده (idempotent) ----------
let schemaReady = null;
async function ensureSchema(db) {
  if (schemaReady) return schemaReady;
  schemaReady = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pockets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '💰',
      min_percent REAL NOT NULL DEFAULT 0,
      max_percent REAL NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pocket_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      amount REAL NOT NULL CHECK (amount >= 0),
      note TEXT NOT NULL DEFAULT '',
      occurred_on TEXT NOT NULL DEFAULT (date('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (pocket_id) REFERENCES pockets(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pockets_user ON pockets(user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tx_pocket ON transactions(pocket_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(occurred_on)`),
  ]);
  return schemaReady;
}

async function seedPockets(db, userId) {
  const stmt = db.prepare(
    `INSERT INTO pockets (user_id, name, emoji, min_percent, max_percent, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
  );
  await db.batch(DEFAULT_POCKETS.map((p) => stmt.bind(userId, ...p)));
}

// ---------- نشست/کاربر ----------
async function getUser(request, db) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`
    )
    .bind(token)
    .first();
  return row || null;
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// ---------- کمک‌ها ----------
function monthRange(month) {
  const now = new Date();
  let year, mon;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    [year, mon] = month.split("-").map(Number);
  } else {
    year = now.getUTCFullYear();
    mon = now.getUTCMonth() + 1;
  }
  const start = `${year}-${String(mon).padStart(2, "0")}-01`;
  const nextY = mon === 12 ? year + 1 : year;
  const nextM = mon === 12 ? 1 : mon + 1;
  const end = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  return { start, end };
}
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

// ---------- منطق داده (محدود به user_id) ----------
async function getPockets(db, userId, month) {
  const { start, end } = monthRange(month);
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.emoji, p.min_percent, p.max_percent, p.sort_order,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.amount END), 0) AS all_income,
        COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount END), 0) AS all_expense,
        COALESCE(SUM(CASE WHEN t.type='income'  AND t.occurred_on >= ?2 AND t.occurred_on < ?3 THEN t.amount END), 0) AS period_income,
        COALESCE(SUM(CASE WHEN t.type='expense' AND t.occurred_on >= ?2 AND t.occurred_on < ?3 THEN t.amount END), 0) AS period_expense
      FROM pockets p
      LEFT JOIN transactions t ON t.pocket_id = p.id AND t.user_id = ?1
      WHERE p.user_id = ?1
      GROUP BY p.id
      ORDER BY p.sort_order, p.id`
    )
    .bind(userId, start, end)
    .all();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    min_percent: r.min_percent,
    max_percent: r.max_percent,
    sort_order: r.sort_order,
    period_income: r.period_income,
    period_expense: r.period_expense,
    balance: r.all_income - r.all_expense,
  }));
}

async function getSummary(db, userId, month) {
  const { start, end } = monthRange(month);
  const row = await db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN type='income'  THEN amount END), 0) AS all_income,
        COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS all_expense,
        COALESCE(SUM(CASE WHEN type='income'  AND occurred_on >= ?2 AND occurred_on < ?3 THEN amount END), 0) AS period_income,
        COALESCE(SUM(CASE WHEN type='expense' AND occurred_on >= ?2 AND occurred_on < ?3 THEN amount END), 0) AS period_expense
      FROM transactions WHERE user_id = ?1`
    )
    .bind(userId, start, end)
    .first();
  return {
    balance: row.all_income - row.all_expense,
    total_income: row.all_income,
    total_expense: row.all_expense,
    period_income: row.period_income,
    period_expense: row.period_expense,
  };
}

// ---------- روتر احراز هویت ----------
async function handleAuth(request, db, action) {
  const method = request.method;

  if (action === "register" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || "").toString().trim().toLowerCase();
    const password = (body.password || "").toString();
    if (!isValidEmail(email)) return badRequest("ایمیل نامعتبر است");
    if (password.length < 8) return badRequest("رمز عبور باید حداقل ۸ کاراکتر باشد");
    const exists = await db.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
    if (exists) return json({ error: "این ایمیل قبلاً ثبت شده است" }, 409);
    const { hash, salt } = await hashPassword(password);
    const res = await db
      .prepare(`INSERT INTO users (email, password_hash, password_salt) VALUES (?, ?, ?)`)
      .bind(email, hash, salt)
      .run();
    const userId = res.meta.last_row_id;
    await seedPockets(db, userId);
    const token = randomToken();
    const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString();
    await db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).bind(token, userId, expires).run();
    return json({ user: { id: userId, email } }, 201, { "Set-Cookie": sessionCookie(token, request) });
  }

  if (action === "login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const email = (body.email || "").toString().trim().toLowerCase();
    const password = (body.password || "").toString();
    const user = await db
      .prepare(`SELECT id, email, password_hash, password_salt FROM users WHERE email = ?`)
      .bind(email)
      .first();
    if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
      return json({ error: "ایمیل یا رمز عبور نادرست است" }, 401);
    }
    const token = randomToken();
    const expires = new Date(Date.now() + SESSION_TTL_DAYS * 864e5).toISOString();
    await db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).bind(token, user.id, expires).run();
    return json({ user: { id: user.id, email: user.email } }, 200, { "Set-Cookie": sessionCookie(token, request) });
  }

  if (action === "logout" && method === "POST") {
    const token = parseCookies(request)[COOKIE_NAME];
    if (token) await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(token).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie(request) });
  }

  if (action === "me" && method === "GET") {
    const user = await getUser(request, db);
    if (!user) return unauthorized();
    return json({ user });
  }

  return notFound("مسیر یافت نشد");
}

// ---------- روتر داده (نیازمند کاربر) ----------
async function handleData(request, db, userId, segments) {
  const url = new URL(request.url);
  const method = request.method;
  const resource = segments[1];
  const id = segments[2];

  if (resource === "pockets") {
    if (method === "GET" && !id) {
      return json({ pockets: await getPockets(db, userId, url.searchParams.get("month")) });
    }
    if (method === "POST" && !id) {
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").toString().trim();
      if (!name) return badRequest("نام پاکت الزامی است");
      const emoji = (body.emoji || "💰").toString().slice(0, 8);
      const min = num(body.min_percent) || 0;
      const max = num(body.max_percent) || 0;
      const { order } = await db
        .prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS "order" FROM pockets WHERE user_id = ?`)
        .bind(userId)
        .first();
      const res = await db
        .prepare(`INSERT INTO pockets (user_id, name, emoji, min_percent, max_percent, sort_order) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(userId, name, emoji, min, max, order)
        .run();
      return json({ id: res.meta.last_row_id }, 201);
    }
    if (method === "PUT" && id) {
      const body = await request.json().catch(() => ({}));
      const existing = await db.prepare(`SELECT * FROM pockets WHERE id = ? AND user_id = ?`).bind(id, userId).first();
      if (!existing) return notFound("پاکت یافت نشد");
      const name = body.name != null ? body.name.toString().trim() : existing.name;
      const emoji = body.emoji != null ? body.emoji.toString().slice(0, 8) : existing.emoji;
      const min = body.min_percent != null ? num(body.min_percent) : existing.min_percent;
      const max = body.max_percent != null ? num(body.max_percent) : existing.max_percent;
      if (!name) return badRequest("نام پاکت نمی‌تواند خالی باشد");
      await db.prepare(`UPDATE pockets SET name=?, emoji=?, min_percent=?, max_percent=? WHERE id=? AND user_id=?`)
        .bind(name, emoji, min, max, id, userId)
        .run();
      return json({ ok: true });
    }
    if (method === "DELETE" && id) {
      const res = await db.prepare(`DELETE FROM pockets WHERE id = ? AND user_id = ?`).bind(id, userId).run();
      await db.prepare(`DELETE FROM transactions WHERE pocket_id = ? AND user_id = ?`).bind(id, userId).run();
      if (!res.meta.changes) return notFound("پاکت یافت نشد");
      return json({ ok: true });
    }
  }

  if (resource === "summary" && method === "GET") {
    return json(await getSummary(db, userId, url.searchParams.get("month")));
  }

  if (resource === "transactions") {
    if (method === "GET" && !id) {
      const month = url.searchParams.get("month");
      const pocketId = url.searchParams.get("pocket_id");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const clauses = [`t.user_id = ?`];
      const binds = [userId];
      if (month && /^\d{4}-\d{2}$/.test(month)) {
        const { start, end } = monthRange(month);
        clauses.push(`t.occurred_on >= ? AND t.occurred_on < ?`);
        binds.push(start, end);
      }
      if (pocketId) {
        clauses.push(`t.pocket_id = ?`);
        binds.push(pocketId);
      }
      const { results } = await db
        .prepare(
          `SELECT t.id, t.pocket_id, t.type, t.amount, t.note, t.occurred_on, t.created_at,
                  p.name AS pocket_name, p.emoji AS pocket_emoji
           FROM transactions t JOIN pockets p ON p.id = t.pocket_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY t.occurred_on DESC, t.id DESC LIMIT ?`
        )
        .bind(...binds, limit)
        .all();
      return json({ transactions: results });
    }
    if (method === "POST" && !id) {
      const body = await request.json().catch(() => ({}));
      const pocketId = num(body.pocket_id);
      const type = (body.type || "").toString();
      const amount = num(body.amount);
      if (!Number.isFinite(pocketId)) return badRequest("پاکت نامعتبر است");
      if (type !== "income" && type !== "expense") return badRequest("نوع تراکنش نامعتبر است");
      if (!Number.isFinite(amount) || amount < 0) return badRequest("مبلغ نامعتبر است");
      const pocket = await db.prepare(`SELECT id FROM pockets WHERE id = ? AND user_id = ?`).bind(pocketId, userId).first();
      if (!pocket) return notFound("پاکت یافت نشد");
      const note = (body.note || "").toString().slice(0, 500);
      const occurred = /^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on || "")
        ? body.occurred_on
        : new Date().toISOString().slice(0, 10);
      const res = await db
        .prepare(`INSERT INTO transactions (user_id, pocket_id, type, amount, note, occurred_on) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(userId, pocketId, type, amount, note, occurred)
        .run();
      return json({ id: res.meta.last_row_id }, 201);
    }
    if (method === "DELETE" && id) {
      const res = await db.prepare(`DELETE FROM transactions WHERE id = ? AND user_id = ?`).bind(id, userId).run();
      if (!res.meta.changes) return notFound("تراکنش یافت نشد");
      return json({ ok: true });
    }
  }

  if (resource === "distribute" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const amount = num(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return badRequest("مبلغ حقوق نامعتبر است");
    const occurred = /^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on || "")
      ? body.occurred_on
      : new Date().toISOString().slice(0, 10);
    const noteBase = (body.note || "تقسیم حقوق").toString().slice(0, 200);
    const pockets = (await db.prepare(`SELECT id, min_percent, max_percent FROM pockets WHERE user_id = ? ORDER BY sort_order, id`).bind(userId).all()).results;
    if (!pockets.length) return badRequest("هیچ پاکتی برای تقسیم وجود ندارد");

    let allocations;
    if (Array.isArray(body.allocations) && body.allocations.length) {
      const allowed = new Set(pockets.map((p) => p.id));
      allocations = body.allocations
        .map((a) => ({ pocket_id: num(a.pocket_id), percent: num(a.percent) }))
        .filter((a) => allowed.has(a.pocket_id) && Number.isFinite(a.percent) && a.percent > 0);
    } else {
      allocations = pockets.map((p) => ({
        pocket_id: p.id,
        percent: (Number(p.min_percent) + Number(p.max_percent)) / 2,
      }));
    }
    const totalPercent = allocations.reduce((s, a) => s + a.percent, 0);
    if (totalPercent <= 0) return badRequest("مجموع درصدها نامعتبر است");

    const stmt = db.prepare(
      `INSERT INTO transactions (user_id, pocket_id, type, amount, note, occurred_on) VALUES (?, ?, 'income', ?, ?, ?)`
    );
    const inserts = [];
    const distributed = [];
    for (const a of allocations) {
      const share = Math.round(amount * (a.percent / totalPercent) * 100) / 100;
      if (share <= 0) continue;
      inserts.push(stmt.bind(userId, a.pocket_id, share, noteBase, occurred));
      distributed.push({ pocket_id: a.pocket_id, amount: share, percent: a.percent });
    }
    if (inserts.length) await db.batch(inserts);
    return json({ ok: true, distributed, total_percent: totalPercent }, 201);
  }

  return notFound("مسیر API یافت نشد");
}

async function handleApi(request, env, path) {
  const db = env.DB;
  await ensureSchema(db);
  const segments = path.split("/").filter(Boolean); // ["api", ...]

  if (segments[0] === "api" && segments[1] === "health") {
    return json({ ok: true, name: "finanzierung", time: new Date().toISOString() });
  }

  // مسیرهای احراز هویت — عمومی
  if (segments[1] === "auth") {
    return handleAuth(request, db, segments[2]);
  }

  // بقیه — نیازمند نشست معتبر
  const user = await getUser(request, db);
  if (!user) return unauthorized();
  return handleData(request, db, user.id, segments);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url.pathname);
      } catch (err) {
        return json({ error: "خطای سرور", detail: String(err && err.message ? err.message : err) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
