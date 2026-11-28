-- Quedamos on Cloudflare D1. Apply with:
--   npx wrangler d1 execute nota-ai --remote --file worker/schema.sql
CREATE TABLE IF NOT EXISTS users (
  sub TEXT PRIMARY KEY,          -- Google account id
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  picture TEXT NOT NULL DEFAULT '',
  cal_token TEXT UNIQUE,         -- secret for the /cal/<token>.ics feed
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,   -- sha256 of the cookie; the raw token is never stored
  sub TEXT NOT NULL REFERENCES users(sub),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS notes (
  sub TEXT NOT NULL,             -- owner: every query filters by it
  uid TEXT NOT NULL,             -- same id on every device
  data TEXT,                     -- the note as JSON, without audio/files (those live in R2)
  cal TEXT,                      -- small JSON slice for the calendar feed
  updated_at INTEGER NOT NULL,   -- client edit time, for last-write-wins
  deleted INTEGER NOT NULL DEFAULT 0,
  server_at INTEGER NOT NULL,    -- server write time, the sync cursor
  remind_fire INTEGER,           -- when to send the reminder push (remindAt - advance)
  notified INTEGER,              -- remind_fire value already sent (resets when the time changes)
  PRIMARY KEY (sub, uid)
);
CREATE INDEX IF NOT EXISTS notes_remind ON notes (remind_fire) WHERE remind_fire IS NOT NULL;

-- Browsers/phones that want reminder notifications (Web Push).
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (sub);
CREATE INDEX IF NOT EXISTS notes_sync ON notes (sub, server_at);

-- Web trial: one per person. "who" is sha256(ip + secret salt); the raw IP is never stored.
CREATE TABLE IF NOT EXISTS trials (
  who TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trials_at ON trials (at);

-- Size of every file in R2, to enforce the per-user space limit.
CREATE TABLE IF NOT EXISTS blobs (
  sub TEXT NOT NULL,
  key TEXT NOT NULL,             -- "<note uid>/<uuid>"; the R2 object is "<sub>/<key>"
  size INTEGER NOT NULL,
  PRIMARY KEY (sub, key)
);
