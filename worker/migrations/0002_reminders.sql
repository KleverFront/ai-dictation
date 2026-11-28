-- Reminders with push notifications. Run once on the existing database:
--   npx wrangler d1 execute nota-ai --remote --file worker/migrations/0002_reminders.sql
ALTER TABLE notes ADD COLUMN remind_fire INTEGER;
ALTER TABLE notes ADD COLUMN notified INTEGER;
CREATE INDEX IF NOT EXISTS notes_remind ON notes (remind_fire) WHERE remind_fire IS NOT NULL;
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (sub);
