-- Share links become durable and recoverable:
-- 1. expires_at is now nullable — NULL means the link lives until explicitly
--    revoked, and creating a share without a ttl no longer defaults to 7 days.
--    Old-version links handed out in chats must not silently die.
-- 2. The share token is stored so the URL can be re-copied from the console
--    later (owner-accepted trade-off: tokens readable by DB admins; shares are
--    unlisted-public download links, optionally password-protected). Legacy
--    rows only have the hash, so their URLs stay unrecoverable.
-- SQLite cannot drop NOT NULL in place, so rebuild the table.
PRAGMA defer_foreign_keys = true;

CREATE TABLE release_shares_new (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  token TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  password_hash TEXT
);

INSERT INTO release_shares_new (id, release_id, token, token_hash, created_by, created_at, expires_at, revoked_at, password_hash)
SELECT id, release_id, NULL, token_hash, created_by, created_at, expires_at, revoked_at, password_hash FROM release_shares;

DROP TABLE release_shares;
ALTER TABLE release_shares_new RENAME TO release_shares;

CREATE INDEX IF NOT EXISTS idx_release_shares_release
  ON release_shares(release_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_release_shares_token_active
  ON release_shares(token_hash, expires_at, revoked_at);
