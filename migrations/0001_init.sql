-- طرح پایگاه‌داده مدیریت حقوق ماهانه (Finanzierung) — نسخه‌ی چندکاربره
-- جداول به صورت idempotent ساخته می‌شوند. پاکت‌های پیش‌فرض هنگام ثبت‌نام هر کاربر
-- توسط Worker ساخته می‌شوند (نه به صورت سراسری).

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  password_salt TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,           -- توکن نشست تصادفی
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pockets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  emoji       TEXT    NOT NULL DEFAULT '💰',
  min_percent REAL    NOT NULL DEFAULT 0,
  max_percent REAL    NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  pocket_id   INTEGER NOT NULL,
  type        TEXT    NOT NULL CHECK (type IN ('income','expense')),
  amount      REAL    NOT NULL CHECK (amount >= 0),
  note        TEXT    NOT NULL DEFAULT '',
  occurred_on TEXT    NOT NULL DEFAULT (date('now')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pocket_id) REFERENCES pockets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_pockets_user  ON pockets(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_user       ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_pocket     ON transactions(pocket_id);
CREATE INDEX IF NOT EXISTS idx_tx_date       ON transactions(occurred_on);
