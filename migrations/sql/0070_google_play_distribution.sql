-- Google Play distribution P0.
--
-- The mobile producer declares one immutable Android build identity with exactly
-- one AAB and one APK. build_assets holds the byte objects; this table holds the
-- shared identity that must never drift between them.
CREATE TABLE android_release_artifact_bundles (
  build_id                    TEXT PRIMARY KEY REFERENCES builds(id) ON DELETE CASCADE,
  app_id                      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  package_name                TEXT NOT NULL,
  version_name                TEXT NOT NULL,
  version_code                INTEGER NOT NULL CHECK (version_code > 0),
  source_repository           TEXT NOT NULL,
  source_commit               TEXT NOT NULL CHECK (
    length(source_commit) = 40 AND source_commit NOT GLOB '*[^0-9a-f]*'
  ),
  ci_run_id                   TEXT NOT NULL,
  upload_key_cert_sha256      TEXT NOT NULL CHECK (
    length(upload_key_cert_sha256) = 64
    AND upload_key_cert_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state                       TEXT NOT NULL DEFAULT 'uploading'
                               CHECK (state IN ('uploading', 'ready', 'failed')),
  created_by                  TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  completed_at                INTEGER,
  UNIQUE (app_id, package_name, version_code),
  UNIQUE (app_id, build_id)
);

CREATE INDEX idx_android_release_bundles_source
  ON android_release_artifact_bundles(app_id, source_commit, ci_run_id);

-- Only the lifecycle projection may change. Artifact identity is append-only.
CREATE TRIGGER trg_android_release_bundle_identity_immutable
BEFORE UPDATE OF app_id, package_name, version_name, version_code,
  source_repository, source_commit, ci_run_id, upload_key_cert_sha256,
  created_by, created_at
ON android_release_artifact_bundles
BEGIN
  SELECT RAISE(ABORT, 'android release artifact identity is immutable');
END;

-- Receipts are the immutable evidence chain. They intentionally contain only
-- public metadata and never credentials or private key material.
CREATE TABLE release_receipts (
  id                TEXT PRIMARY KEY,
  app_id            TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  release_id        TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('acceptance', 'play-promotion')),
  verdict           TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'success', 'failed-closed')),
  artifact_id       TEXT REFERENCES build_assets(id) ON DELETE RESTRICT,
  artifact_sha256   TEXT CHECK (
    artifact_sha256 IS NULL OR (
      length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  artifact_size     INTEGER,
  package_name      TEXT NOT NULL,
  source_commit     TEXT NOT NULL,
  version_code      INTEGER NOT NULL,
  action            TEXT,
  track             TEXT,
  play_edit_id      TEXT,
  payload_json      TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX idx_release_receipts_chain
  ON release_receipts(app_id, release_id, created_at, id);
CREATE INDEX idx_release_receipts_artifact
  ON release_receipts(app_id, release_id, artifact_id, created_at DESC);

CREATE TRIGGER trg_release_receipts_no_update
BEFORE UPDATE ON release_receipts
BEGIN
  SELECT RAISE(ABORT, 'release receipts are immutable');
END;

CREATE TRIGGER trg_release_receipts_no_delete
BEFORE DELETE ON release_receipts
BEGIN
  SELECT RAISE(ABORT, 'release receipts are immutable');
END;

CREATE TABLE play_distribution_state (
  app_id              TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  release_id          TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  package_name        TEXT NOT NULL,
  track               TEXT NOT NULL CHECK (track IN ('internal', 'closed', 'production')),
  version_code        INTEGER NOT NULL,
  rollout_percent     INTEGER CHECK (rollout_percent BETWEEN 0 AND 100),
  state               TEXT NOT NULL CHECK (state IN ('active', 'halted', 'failed-closed')),
  last_edit_id        TEXT,
  last_receipt_id     TEXT NOT NULL REFERENCES release_receipts(id) ON DELETE RESTRICT,
  revision            INTEGER NOT NULL DEFAULT 1,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (app_id, release_id)
);

-- A primary-key row is the lock. Acquisition is one INSERT; conflicts are
-- surfaced to the caller and are never retried automatically.
CREATE TABLE play_edit_locks (
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  package_name    TEXT NOT NULL,
  release_id      TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  operation_id    TEXT NOT NULL UNIQUE,
  acquired_by     TEXT NOT NULL,
  acquired_at     INTEGER NOT NULL,
  PRIMARY KEY (app_id, package_name)
);

-- Holds are an explicit operator surface. P0 only consumes this table as a
-- fail-closed gate; hold administration is deliberately a separate concern.
CREATE TABLE release_distribution_holds (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  release_id    TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  opened_by     TEXT NOT NULL,
  opened_at     INTEGER NOT NULL,
  closed_by     TEXT,
  closed_at     INTEGER
);

CREATE INDEX idx_release_distribution_holds_open
  ON release_distribution_holds(app_id, release_id)
  WHERE closed_at IS NULL;
