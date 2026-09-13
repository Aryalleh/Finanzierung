-- طرح پایگاه‌داده مدیریت حقوق ماهانه (Finanzierung)
-- جداول به صورت idempotent ساخته می‌شوند تا اجرای دوباره مشکلی ایجاد نکند.

CREATE TABLE IF NOT EXISTS pockets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  emoji       TEXT    NOT NULL DEFAULT '💰',
  min_percent REAL    NOT NULL DEFAULT 0,
  max_percent REAL    NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pocket_id   INTEGER NOT NULL,
  type        TEXT    NOT NULL CHECK (type IN ('income','expense')),
  amount      REAL    NOT NULL CHECK (amount >= 0),
  note        TEXT    NOT NULL DEFAULT '',
  occurred_on TEXT    NOT NULL DEFAULT (date('now')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (pocket_id) REFERENCES pockets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tx_pocket ON transactions(pocket_id);
CREATE INDEX IF NOT EXISTS idx_tx_date   ON transactions(occurred_on);

-- پاکت‌های پیش‌فرض بر اساس درصدهای پیشنهادی. فقط زمانی درج می‌شوند که جدول خالی باشد.
INSERT INTO pockets (name, emoji, min_percent, max_percent, sort_order)
SELECT * FROM (
  SELECT 'اجاره و هزینه‌های ثابت'          AS name, '🏠' AS emoji, 35 AS min_percent, 45 AS max_percent, 1 AS sort_order
  UNION ALL SELECT 'غذا و خرید روزمره',        '🛒', 10, 15, 2
  UNION ALL SELECT 'حمل‌ونقل',                 '🚆',  5, 10, 3
  UNION ALL SELECT 'قبض و اشتراک‌ها',          '📱',  5,  5, 4
  UNION ALL SELECT 'تفریح و خرید شخصی',        '🎉', 10, 10, 5
  UNION ALL SELECT 'پس‌انداز اضطراری',         '💰', 10, 15, 6
  UNION ALL SELECT 'سرمایه‌گذاری / پس‌انداز هدفمند', '📈', 5, 10, 7
)
WHERE NOT EXISTS (SELECT 1 FROM pockets);
