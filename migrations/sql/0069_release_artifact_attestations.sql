-- Migration 0069: shared release-artifact integrity and publisher attestation.
-- Private signing keys never enter D1/Worker; only public trust metadata and
-- immutable signed payloads are stored here.

ALTER TABLE apps ADD COLUMN update_attestation_required INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS update_attestation_keys (
  key_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL,
  public_key_spki_b64url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  revoked_at INTEGER,
  UNIQUE (app_id, public_key_spki_b64url)
);

CREATE INDEX IF NOT EXISTS idx_update_attestation_keys_app_status
  ON update_attestation_keys(app_id, status);

CREATE TABLE IF NOT EXISTS release_artifact_attestation_requests (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  key_id TEXT NOT NULL REFERENCES update_attestation_keys(key_id) ON DELETE RESTRICT,
  payload_b64url TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (release_id, artifact_kind, artifact_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_release_attestation_requests_expiry
  ON release_artifact_attestation_requests(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS release_artifact_attestations (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  algorithm TEXT NOT NULL,
  key_id TEXT NOT NULL REFERENCES update_attestation_keys(key_id) ON DELETE RESTRICT,
  payload_b64url TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  signature_b64url TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (release_id, artifact_kind, artifact_id),
  UNIQUE (payload_sha256)
);

CREATE INDEX IF NOT EXISTS idx_release_attestations_release
  ON release_artifact_attestations(release_id, artifact_kind);
