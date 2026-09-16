-- طرح پایگاه‌داده مدیریت حقوق ماهانه (Finanzierung)
-- چندکاربره + تلگرام + چند‌ارزی + پاکت مشترک + قرض. جداول به‌صورت idempotent ساخته می‌شوند.
-- پاکت‌های پیش‌فرض هنگام ثبت‌نام هر کاربر (در ارز پیش‌فرض) توسط Worker ساخته می‌شوند.

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT UNIQUE,
  password_hash      TEXT,
  password_salt      TEXT,
  telegram_id        TEXT UNIQUE,
  telegram_username  TEXT,
  telegram_chat_id   TEXT,
  telegram_photo_url TEXT,
  display_name       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- درخواست‌های ورود تلگرام (تأیید/رد با دکمه)
CREATE TABLE IF NOT EXISTS login_requests (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied
  consumed   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pockets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '💰',
  min_percent REAL NOT NULL DEFAULT 0,
  max_percent REAL NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'IRT',
  kind        TEXT NOT NULL DEFAULT 'discretionary',  -- essential | discretionary | savings | investment | emergency
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pocket_members (
  pocket_id  INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',   -- owner | member
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pocket_id, user_id),
  FOREIGN KEY (pocket_id) REFERENCES pockets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pocket_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,                -- سازنده‌ی تراکنش
  type        TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount      REAL NOT NULL CHECK (amount >= 0),
  note        TEXT NOT NULL DEFAULT '',
  currency    TEXT NOT NULL DEFAULT 'IRT',
  loan_id     INTEGER,                          -- تراکنش مرتبط با قرض (از نمره‌دهی حذف می‌شود)
  occurred_on TEXT NOT NULL DEFAULT (date('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pocket_id) REFERENCES pockets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lender_id   INTEGER NOT NULL,
  borrower_id INTEGER NOT NULL,
  amount      REAL NOT NULL CHECK (amount > 0),
  repaid      REAL NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'IRT',
  note        TEXT NOT NULL DEFAULT '',
  source_pocket_id INTEGER,                    -- پاکت مبدأِ وام‌دهنده (null = از موجودی کل)
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | active | settled | declined
  created_by  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (lender_id)   REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (borrower_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_pockets_owner   ON pockets(owner_id);
CREATE INDEX IF NOT EXISTS idx_pm_user         ON pocket_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_pocket       ON transactions(pocket_id);
CREATE INDEX IF NOT EXISTS idx_tx_date         ON transactions(occurred_on);
CREATE INDEX IF NOT EXISTS idx_loans_lender    ON loans(lender_id);
CREATE INDEX IF NOT EXISTS idx_loans_borrower  ON loans(borrower_id);
