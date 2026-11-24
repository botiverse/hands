-- Hands-managed HarmonyOS signing (routes/harmony_signing.ts). A signing
-- identity is an ECDSA P-256 key made in Hands plus the debug or release
-- certificate AppGallery Connect issued for it; a profile binds an identity to
-- one Hands app's AGC app (and, for debug, its registered devices).
CREATE TABLE IF NOT EXISTS harmony_signing_identities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cert_kind TEXT NOT NULL CHECK (cert_kind IN ('debug', 'release')),
  agc_cert_id TEXT NOT NULL,
  -- The Hands app whose AGC credentials issued (and can revoke) the certificate.
  credential_app_id TEXT REFERENCES apps(id) ON DELETE SET NULL,
  -- Public facts only (subject, issuer, fingerprint, validity).
  metadata_json TEXT NOT NULL,
  -- AES-GCM over {key_pem, chain_pem} (lib/signing.ts encryptSigningSecret).
  secret_ciphertext_b64 TEXT NOT NULL,
  secret_iv_b64 TEXT NOT NULL,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_harmony_signing_identities_org ON harmony_signing_identities(org_id, revoked_at);

CREATE TABLE IF NOT EXISTS harmony_signing_profiles (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES harmony_signing_identities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('debug', 'release')),
  agc_app_id TEXT NOT NULL,
  agc_profile_id TEXT NOT NULL,
  -- The .p7b itself: signed by Huawei and not secret.
  profile_b64 TEXT NOT NULL,
  device_ids_json TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  replaced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_harmony_signing_profiles_app ON harmony_signing_profiles(app_id, kind, replaced_at);
