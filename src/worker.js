/**
 * Finanzierung — مدیریت حقوق ماهانه
 * Cloudflare Worker: API روی D1 + سرو فایل‌های ثابت PWA از باندینگ ASSETS.
 *
 * مسیرها:
 *   GET    /api/health                 وضعیت سرویس
 *   GET    /api/pockets?month=YYYY-MM  فهرست پاکت‌ها به همراه ورودی/خروجی دوره و موجودی کل
 *   POST   /api/pockets                ساخت پاکت جدید
 *   PUT    /api/pockets/:id            ویرایش پاکت
 *   DELETE /api/pockets/:id            حذف پاکت (و تراکنش‌هایش)
 *   GET    /api/summary?month=YYYY-MM  جمع کل ورودی/خروجی/موجودی
 *   GET    /api/transactions?month=&pocket_id=&limit=   فهرست تراکنش‌ها
 *   POST   /api/transactions           ثبت تراکنش (income | expense)
 *   DELETE /api/transactions/:id       حذف تراکنش
 *   POST   /api/distribute             تقسیم حقوق بین پاکت‌ها (ثبت ورودی)
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function badRequest(message) {
  return json({ error: message }, 400);
}
function notFound(message = "یافت نشد") {
  return json({ error: message }, 404);
}

// ---- اطمینان از وجود طرح پایگاه‌داده (idempotent، یک‌بار در هر ایزوله) ----
let schemaReady = null;
async function ensureSchema(db) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS pockets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '💰',
        min_percent REAL NOT NULL DEFAULT 0,
        max_percent REAL NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pocket_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('income','expense')),
        amount REAL NOT NULL CHECK (amount >= 0),
        note TEXT NOT NULL DEFAULT '',
        occurred_on TEXT NOT NULL DEFAULT (date('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (pocket_id) REFERENCES pockets(id) ON DELETE CASCADE
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tx_pocket ON transactions(pocket_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(occurred_on)`),
    ]);

    const { count } = await db
      .prepare(`SELECT COUNT(*) AS count FROM pockets`)
      .first();
    if (!count) {
      const defaults = [
        ["اجاره و هزینه‌های ثابت", "🏠", 35, 45, 1],
        ["غذا و خرید روزمره", "🛒", 10, 15, 2],
        ["حمل‌ونقل", "🚆", 5, 10, 3],
        ["قبض و اشتراک‌ها", "📱", 5, 5, 4],
        ["تفریح و خرید شخصی", "🎉", 10, 10, 5],
        ["پس‌انداز اضطراری", "💰", 10, 15, 6],
        ["سرمایه‌گذاری / پس‌انداز هدفمند", "📈", 5, 10, 7],
      ];
      const stmt = db.prepare(
        `INSERT INTO pockets (name, emoji, min_percent, max_percent, sort_order) VALUES (?, ?, ?, ?, ?)`
      );
      await db.batch(defaults.map((d) => stmt.bind(...d)));
    }
  })();
  return schemaReady;
}

// ---- کمک‌ها ----
// بازه‌ی یک ماه به صورت [شروع، شروعِ ماه بعد) برای مقایسه‌ی رشته‌ای تاریخ.
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// ---- منطق پاکت‌ها ----
async function getPockets(db, month) {
  const { start, end } = monthRange(month);
  const { results } = await db
    .prepare(
      `SELECT p.id, p.name, p.emoji, p.min_percent, p.max_percent, p.sort_order,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.amount END), 0) AS all_income,
        COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount END), 0) AS all_expense,
        COALESCE(SUM(CASE WHEN t.type='income'  AND t.occurred_on >= ?1 AND t.occurred_on < ?2 THEN t.amount END), 0) AS period_income,
        COALESCE(SUM(CASE WHEN t.type='expense' AND t.occurred_on >= ?1 AND t.occurred_on < ?2 THEN t.amount END), 0) AS period_expense
      FROM pockets p
      LEFT JOIN transactions t ON t.pocket_id = p.id
      GROUP BY p.id
      ORDER BY p.sort_order, p.id`
    )
    .bind(start, end)
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
    balance: r.all_income - r.all_expense, // موجودی فعلی = ورودی کل − خروجی کل
  }));
}

async function getSummary(db, month) {
  const { start, end } = monthRange(month);
  const row = await db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN type='income'  THEN amount END), 0) AS all_income,
        COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS all_expense,
        COALESCE(SUM(CASE WHEN type='income'  AND occurred_on >= ?1 AND occurred_on < ?2 THEN amount END), 0) AS period_income,
        COALESCE(SUM(CASE WHEN type='expense' AND occurred_on >= ?1 AND occurred_on < ?2 THEN amount END), 0) AS period_expense
      FROM transactions`
    )
    .bind(start, end)
    .first();
  return {
    balance: row.all_income - row.all_expense,
    total_income: row.all_income,
    total_expense: row.all_expense,
    period_income: row.period_income,
    period_expense: row.period_expense,
  };
}

// ---- روتر API ----
async function handleApi(request, env, path) {
  const db = env.DB;
  await ensureSchema(db);

  const url = new URL(request.url);
  const method = request.method;
  const segments = path.split("/").filter(Boolean); // مثلا ["api","pockets","3"]
  const resource = segments[1];
  const id = segments[2];

  // GET /api/health
  if (resource === "health") {
    return json({ ok: true, name: "finanzierung", time: new Date().toISOString() });
  }

  // ---- پاکت‌ها ----
  if (resource === "pockets") {
    if (method === "GET" && !id) {
      const month = url.searchParams.get("month");
      return json({ pockets: await getPockets(db, month) });
    }

    if (method === "POST" && !id) {
      const body = await request.json().catch(() => ({}));
      const name = (body.name || "").toString().trim();
      if (!name) return badRequest("نام پاکت الزامی است");
      const emoji = (body.emoji || "💰").toString().slice(0, 8);
      const min = num(body.min_percent) || 0;
      const max = num(body.max_percent) || 0;
      const { order } = await db
        .prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS "order" FROM pockets`)
        .first();
      const res = await db
        .prepare(
          `INSERT INTO pockets (name, emoji, min_percent, max_percent, sort_order) VALUES (?, ?, ?, ?, ?)`
        )
        .bind(name, emoji, min, max, order)
        .run();
      return json({ id: res.meta.last_row_id }, 201);
    }

    if (method === "PUT" && id) {
      const body = await request.json().catch(() => ({}));
      const existing = await db.prepare(`SELECT * FROM pockets WHERE id = ?`).bind(id).first();
      if (!existing) return notFound("پاکت یافت نشد");
      const name = body.name != null ? body.name.toString().trim() : existing.name;
      const emoji = body.emoji != null ? body.emoji.toString().slice(0, 8) : existing.emoji;
      const min = body.min_percent != null ? num(body.min_percent) : existing.min_percent;
      const max = body.max_percent != null ? num(body.max_percent) : existing.max_percent;
      if (!name) return badRequest("نام پاکت نمی‌تواند خالی باشد");
      await db
        .prepare(`UPDATE pockets SET name=?, emoji=?, min_percent=?, max_percent=? WHERE id=?`)
        .bind(name, emoji, min, max, id)
        .run();
      return json({ ok: true });
    }

    if (method === "DELETE" && id) {
      const res = await db.prepare(`DELETE FROM pockets WHERE id = ?`).bind(id).run();
      // حذف دستی تراکنش‌ها برای اطمینان (اگر کلید خارجی فعال نباشد)
      await db.prepare(`DELETE FROM transactions WHERE pocket_id = ?`).bind(id).run();
      if (!res.meta.changes) return notFound("پاکت یافت نشد");
      return json({ ok: true });
    }
  }

  // ---- خلاصه ----
  if (resource === "summary" && method === "GET") {
    const month = url.searchParams.get("month");
    return json(await getSummary(db, month));
  }

  // ---- تراکنش‌ها ----
  if (resource === "transactions") {
    if (method === "GET" && !id) {
      const month = url.searchParams.get("month");
      const pocketId = url.searchParams.get("pocket_id");
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const clauses = [];
      const binds = [];
      if (month && /^\d{4}-\d{2}$/.test(month)) {
        const { start, end } = monthRange(month);
        clauses.push(`t.occurred_on >= ? AND t.occurred_on < ?`);
        binds.push(start, end);
      }
      if (pocketId) {
        clauses.push(`t.pocket_id = ?`);
        binds.push(pocketId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const { results } = await db
        .prepare(
          `SELECT t.id, t.pocket_id, t.type, t.amount, t.note, t.occurred_on, t.created_at,
                  p.name AS pocket_name, p.emoji AS pocket_emoji
           FROM transactions t
           JOIN pockets p ON p.id = t.pocket_id
           ${where}
           ORDER BY t.occurred_on DESC, t.id DESC
           LIMIT ?`
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
      if (type !== "income" && type !== "expense") return badRequest("نوع تراکنش باید income یا expense باشد");
      if (!Number.isFinite(amount) || amount < 0) return badRequest("مبلغ نامعتبر است");
      const pocket = await db.prepare(`SELECT id FROM pockets WHERE id = ?`).bind(pocketId).first();
      if (!pocket) return notFound("پاکت یافت نشد");
      const note = (body.note || "").toString().slice(0, 500);
      const occurred = /^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on || "")
        ? body.occurred_on
        : new Date().toISOString().slice(0, 10);
      const res = await db
        .prepare(
          `INSERT INTO transactions (pocket_id, type, amount, note, occurred_on) VALUES (?, ?, ?, ?, ?)`
        )
        .bind(pocketId, type, amount, note, occurred)
        .run();
      return json({ id: res.meta.last_row_id }, 201);
    }

    if (method === "DELETE" && id) {
      const res = await db.prepare(`DELETE FROM transactions WHERE id = ?`).bind(id).run();
      if (!res.meta.changes) return notFound("تراکنش یافت نشد");
      return json({ ok: true });
    }
  }

  // ---- تقسیم حقوق ----
  if (resource === "distribute" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const amount = num(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return badRequest("مبلغ حقوق نامعتبر است");
    const occurred = /^\d{4}-\d{2}-\d{2}$/.test(body.occurred_on || "")
      ? body.occurred_on
      : new Date().toISOString().slice(0, 10);
    const noteBase = (body.note || "تقسیم حقوق").toString().slice(0, 200);

    const pockets = (await db.prepare(`SELECT id, name, min_percent, max_percent FROM pockets ORDER BY sort_order, id`).all()).results;
    if (!pockets.length) return badRequest("هیچ پاکتی برای تقسیم وجود ندارد");

    // درصدها: یا از کلاینت (allocations) یا نقطه‌ی میانی بازه‌ی هر پاکت که نرمال‌سازی می‌شود.
    let allocations;
    if (Array.isArray(body.allocations) && body.allocations.length) {
      allocations = body.allocations
        .map((a) => ({ pocket_id: num(a.pocket_id), percent: num(a.percent) }))
        .filter((a) => Number.isFinite(a.pocket_id) && Number.isFinite(a.percent) && a.percent > 0);
    } else {
      allocations = pockets.map((p) => ({
        pocket_id: p.id,
        percent: (Number(p.min_percent) + Number(p.max_percent)) / 2,
      }));
    }
    const totalPercent = allocations.reduce((s, a) => s + a.percent, 0);
    if (totalPercent <= 0) return badRequest("مجموع درصدها نامعتبر است");

    const stmt = db.prepare(
      `INSERT INTO transactions (pocket_id, type, amount, note, occurred_on) VALUES (?, 'income', ?, ?, ?)`
    );
    const inserts = [];
    const distributed = [];
    for (const a of allocations) {
      // نرمال‌سازی نسبت به مجموع درصدها تا کل مبلغ حقوق تقسیم شود.
      const share = Math.round((amount * (a.percent / totalPercent)) * 100) / 100;
      if (share <= 0) continue;
      inserts.push(stmt.bind(a.pocket_id, share, noteBase, occurred));
      distributed.push({ pocket_id: a.pocket_id, amount: share, percent: a.percent });
    }
    if (inserts.length) await db.batch(inserts);
    return json({ ok: true, distributed, total_percent: totalPercent }, 201);
  }

  return notFound("مسیر API یافت نشد");
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
    // بقیه‌ی درخواست‌ها → فایل‌های ثابت PWA
    return env.ASSETS.fetch(request);
  },
};
