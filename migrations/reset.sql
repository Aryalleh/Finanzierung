-- ⚠️ پاک‌کردن کامل همه‌ی جدول‌ها (همه‌ی داده‌ها حذف می‌شوند)
-- بعد از این، migrations/0001_init.sql را اجرا کنید (npm run db:reset این کار را می‌کند).
DROP TABLE IF EXISTS login_requests;
DROP TABLE IF EXISTS otp_codes;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS pocket_members;
DROP TABLE IF EXISTS loans;
DROP TABLE IF EXISTS pockets;
DROP TABLE IF EXISTS users;
