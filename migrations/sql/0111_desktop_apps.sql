-- Desktop apps (platform `desktop`): any desktop runtime, released per
-- `<os>-<arch>` target. See docs/public/desktop-apps.md.
--
-- `runtime` is descriptive only (jvm, electron, native, tauri, other). Nothing
-- branches on it; NULL for every existing app.
ALTER TABLE apps ADD COLUMN runtime TEXT;

-- Content-addressed bundle files. One row per (app, sha256): the bytes live at
-- apps/{app_id}/files/sha256/{sha256} and are shared by every version of the app
-- that ships them, so an unchanged file is stored once.
CREATE TABLE desktop_files (
  app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes  INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, sha256)
);

-- Which content-addressed files a validated desktop manifest references. Written
-- in the same transaction that seals the manifest asset, so a file is publicly
-- reachable only through a manifest that passed validation.
CREATE TABLE desktop_manifest_files (
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  build_asset_id  TEXT NOT NULL REFERENCES build_assets(id) ON DELETE CASCADE,
  sha256          TEXT NOT NULL,
  PRIMARY KEY (build_asset_id, sha256)
);
CREATE INDEX idx_desktop_manifest_files_app_sha
  ON desktop_manifest_files(app_id, sha256);
