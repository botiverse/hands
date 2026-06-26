-- Migration 0001: Initial schema for quiver
-- Creates: apps, channels, versions, audit_logs

PRAGMA foreign_keys = ON;

-- An "app" is a logical application, e.g. "myapp-android".
CREATE TABLE IF NOT EXISTS apps (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,        -- e.g. "myapp-android"
  name          TEXT NOT NULL,               -- human-readable
  platform      TEXT NOT NULL,               -- "android" | "ios" | future
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apps_slug ON apps(slug);

-- A "channel" is a label grouping versions, e.g. "production" / "beta" / "internal".
CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL,
  slug          TEXT NOT NULL,               -- e.g. "production"
  name          TEXT NOT NULL,               -- human-readable
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
  UNIQUE (app_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_channels_app_id ON channels(app_id);

-- A "version" is one uploaded APK with metadata + R2 storage reference.
CREATE TABLE IF NOT EXISTS versions (
  id                TEXT PRIMARY KEY,
  app_id            TEXT NOT NULL,
  channel           TEXT NOT NULL,           -- channel slug (denormalized for fast list queries)
  version_name      TEXT NOT NULL,           -- e.g. "1.2.3"
  version_code      INTEGER NOT NULL,        -- Android versionCode
  package_name      TEXT NOT NULL,           -- e.g. "com.example.myapp"
  signature_sha256  TEXT NOT NULL,
  min_sdk           INTEGER,
  target_sdk        INTEGER,
  size_bytes        INTEGER NOT NULL,
  file_hash         TEXT NOT NULL,           -- SHA-256 of the APK bytes
  r2_key            TEXT NOT NULL,           -- path inside the R2 bucket
  enabled           INTEGER NOT NULL DEFAULT 1,  -- 0 = disabled, 1 = enabled
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_versions_app_id ON versions(app_id);
CREATE INDEX IF NOT EXISTS idx_versions_app_channel ON versions(app_id, channel);
CREATE INDEX IF NOT EXISTS idx_versions_app_enabled ON versions(app_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_app_code_channel
  ON versions(app_id, channel, version_code);

-- Append-only audit log
CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL,
  action      TEXT NOT NULL,                 -- "app.create" | "version.create" | "version.update" | ...
  actor       TEXT NOT NULL,                 -- who did it ("admin" | email from Cloudflare Access)
  payload     TEXT NOT NULL,                 -- JSON-encoded details
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_app_created ON audit_logs(app_id, created_at DESC);