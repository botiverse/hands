-- Hands Installer consumer auth, explicit catalog admission, subscriptions,
-- and verified package metadata.
--
-- 0066 belongs to the already-in-flight generic CLI Agent Login work. This
-- migration deliberately starts at 0067 and must not land ahead of 0066.

ALTER TABLE apps ADD COLUMN installer_catalog_public INTEGER NOT NULL DEFAULT 0
  CHECK (installer_catalog_public IN (0, 1));
ALTER TABLE apps ADD COLUMN installer_package_id TEXT;
ALTER TABLE apps ADD COLUMN installer_publisher_name TEXT;

CREATE TRIGGER apps_installer_catalog_insert_guard
BEFORE INSERT ON apps
WHEN NEW.installer_catalog_public = 1 AND (
  NEW.public_history != 1 OR
  NEW.platform NOT IN ('android', 'ohos') OR
  NEW.installer_package_id IS NULL OR trim(NEW.installer_package_id) = '' OR
  NEW.installer_publisher_name IS NULL OR trim(NEW.installer_publisher_name) = ''
)
BEGIN
  SELECT RAISE(ABORT, 'installer catalog requires public history, android/ohos platform, package id, and publisher');
END;

CREATE TRIGGER apps_installer_catalog_update_guard
BEFORE UPDATE OF installer_catalog_public, public_history, platform,
  installer_package_id, installer_publisher_name ON apps
WHEN NEW.installer_catalog_public = 1 AND (
  NEW.public_history != 1 OR
  NEW.platform NOT IN ('android', 'ohos') OR
  NEW.installer_package_id IS NULL OR trim(NEW.installer_package_id) = '' OR
  NEW.installer_publisher_name IS NULL OR trim(NEW.installer_publisher_name) = ''
)
BEGIN
  SELECT RAISE(ABORT, 'installer catalog requires public history, android/ohos platform, package id, and publisher');
END;

CREATE INDEX idx_apps_installer_catalog
  ON apps(installer_catalog_public, archived, slug, id)
  WHERE installer_catalog_public = 1;

-- Browser authorization state. The browser cookie contains only the random
-- id; client, redirect and PKCE bindings stay server-side.
CREATE TABLE installer_login_requests (
  id                    TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  state                 TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (length(code_challenge) = 43)
);

CREATE INDEX idx_installer_login_requests_expiry
  ON installer_login_requests(expires_at);

-- One-time browser codes. Only token digests are stored. The callback URI is
-- part of the binding, as are the Raft human account and installer client.
CREATE TABLE installer_login_codes (
  id                    TEXT PRIMARY KEY,
  code_hash             TEXT NOT NULL UNIQUE,
  account_id            TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  state                 TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER,
  consumed_by           TEXT UNIQUE,
  CHECK (expires_at > created_at),
  CHECK (length(code_challenge) = 43)
);

CREATE INDEX idx_installer_login_codes_expiry
  ON installer_login_codes(expires_at)
  WHERE consumed_at IS NULL;

-- Opaque access tokens have a separate table and audience by construction;
-- admin auth middleware cannot parse or accept them as Hands dashboard JWTs.
CREATE TABLE installer_access_tokens (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  family_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_installer_access_token_lookup
  ON installer_access_tokens(token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE installer_refresh_tokens (
  id             TEXT PRIMARY KEY,
  family_id      TEXT NOT NULL,
  account_id     TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  consumed_at    INTEGER,
  consumed_by    TEXT UNIQUE,
  replaced_by_id TEXT REFERENCES installer_refresh_tokens(id),
  revoked_at     INTEGER,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_installer_refresh_token_lookup
  ON installer_refresh_tokens(token_hash, expires_at);
CREATE INDEX idx_installer_refresh_family
  ON installer_refresh_tokens(family_id, created_at DESC);

CREATE TABLE installer_subscriptions (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  app_id              TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  channel_id          TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  auto_download       INTEGER NOT NULL DEFAULT 0 CHECK (auto_download IN (0, 1)),
  revision            INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER,
  UNIQUE (account_id, app_id, channel_id)
);

CREATE INDEX idx_installer_subscriptions_account
  ON installer_subscriptions(account_id, deleted_at, updated_at DESC, id);

-- Populated only by a package inspector after exact artifact bytes have been
-- sealed. Publisher-supplied metadata alone can never satisfy manifest admission.
CREATE TABLE installer_asset_metadata (
  asset_id             TEXT PRIMARY KEY REFERENCES build_assets(id) ON DELETE CASCADE,
  platform             TEXT NOT NULL,
  filetype             TEXT NOT NULL,
  package_id           TEXT NOT NULL,
  version_code         INTEGER NOT NULL CHECK (version_code >= 0),
  -- JSON array of independent signer lineages. Each lineage is an array of
  -- lowercase SHA-256 certificate fingerprints ordered oldest -> current.
  -- Bounds are enforced by the guards below (8 signers, 16 certs each).
  signer_lineages_json TEXT NOT NULL,
  inspected_file_hash  TEXT NOT NULL,
  inspector_version    TEXT NOT NULL,
  inspected_at         INTEGER NOT NULL,
  CHECK (
    (platform = 'android' AND filetype = 'apk') OR
    (platform = 'ohos' AND filetype = 'hap')
  ),
  CHECK (length(signer_lineages_json) <= 10000),
  CHECK (json_valid(signer_lineages_json)
    AND json_type(signer_lineages_json) = 'array'
    AND json_array_length(signer_lineages_json) BETWEEN 1 AND 8),
  CHECK (length(inspected_file_hash) = 64 AND inspected_file_hash = lower(inspected_file_hash)
    AND inspected_file_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (trim(package_id) != ''),
  CHECK (trim(inspector_version) != '')
);

CREATE INDEX idx_installer_asset_metadata_identity
  ON installer_asset_metadata(platform, filetype, package_id, version_code);

-- SQLite CHECK constraints cannot conveniently validate every nested JSON
-- element. Reject non-array lineages, empty/unbounded lineages, non-canonical
-- fingerprints, and duplicates anywhere in the signer set.
CREATE TRIGGER installer_asset_metadata_lineages_insert_guard
BEFORE INSERT ON installer_asset_metadata
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.signer_lineages_json) AS lineage
  WHERE lineage.type != 'array'
     OR json_array_length(lineage.value) NOT BETWEEN 1 AND 16
) OR EXISTS (
  SELECT 1
  FROM json_each(NEW.signer_lineages_json) AS lineage,
       json_each(lineage.value) AS certificate
  WHERE certificate.type != 'text'
     OR length(certificate.value) != 64
     OR certificate.value != lower(certificate.value)
     OR certificate.value GLOB '*[^0-9a-f]*'
) OR (
  SELECT count(*) FROM json_tree(NEW.signer_lineages_json) WHERE type = 'text'
) != (
  SELECT count(DISTINCT atom) FROM json_tree(NEW.signer_lineages_json) WHERE type = 'text'
)
BEGIN
  SELECT RAISE(ABORT, 'installer signer lineages must be bounded, ordered canonical fingerprints');
END;

CREATE TRIGGER installer_asset_metadata_lineages_update_guard
BEFORE UPDATE OF signer_lineages_json ON installer_asset_metadata
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.signer_lineages_json) AS lineage
  WHERE lineage.type != 'array'
     OR json_array_length(lineage.value) NOT BETWEEN 1 AND 16
) OR EXISTS (
  SELECT 1
  FROM json_each(NEW.signer_lineages_json) AS lineage,
       json_each(lineage.value) AS certificate
  WHERE certificate.type != 'text'
     OR length(certificate.value) != 64
     OR certificate.value != lower(certificate.value)
     OR certificate.value GLOB '*[^0-9a-f]*'
) OR (
  SELECT count(*) FROM json_tree(NEW.signer_lineages_json) WHERE type = 'text'
) != (
  SELECT count(DISTINCT atom) FROM json_tree(NEW.signer_lineages_json) WHERE type = 'text'
)
BEGIN
  SELECT RAISE(ABORT, 'installer signer lineages must be bounded, ordered canonical fingerprints');
END;

-- Cross-table admission cannot be expressed as a CHECK. Seal the inspector row
-- to the exact immutable artifact bytes and build version before it can satisfy
-- an installer manifest query. App package opt-in is checked later at admission,
-- so inspection can safely happen before a publisher opts into the catalog.
CREATE TRIGGER installer_asset_metadata_insert_guard
BEFORE INSERT ON installer_asset_metadata
WHEN NOT EXISTS (
  SELECT 1
  FROM build_assets ba
  JOIN builds b ON b.id = ba.build_id
  WHERE ba.id = NEW.asset_id
    AND ba.artifact_kind = 'installable'
    AND ba.platform = NEW.platform
    AND ba.filetype = NEW.filetype
    AND ba.file_hash = NEW.inspected_file_hash
    AND b.version_code = NEW.version_code
)
BEGIN
  SELECT RAISE(ABORT, 'installer metadata must match exact installable asset and build identity');
END;

CREATE TRIGGER installer_asset_metadata_update_guard
BEFORE UPDATE ON installer_asset_metadata
WHEN NOT EXISTS (
  SELECT 1
  FROM build_assets ba
  JOIN builds b ON b.id = ba.build_id
  WHERE ba.id = NEW.asset_id
    AND ba.artifact_kind = 'installable'
    AND ba.platform = NEW.platform
    AND ba.filetype = NEW.filetype
    AND ba.file_hash = NEW.inspected_file_hash
    AND b.version_code = NEW.version_code
)
BEGIN
  SELECT RAISE(ABORT, 'installer metadata must match exact installable asset and build identity');
END;
