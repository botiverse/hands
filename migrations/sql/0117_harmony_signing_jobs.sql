-- Signing a HarmonyOS .hap/.app in Hands with an app's current profile and
-- its identity (routes/harmony_signing.ts). Same lifecycle as signing_jobs:
-- the client uploads the unsigned file to a presigned URL, asks Hands to sign,
-- and downloads the result.
CREATE TABLE IF NOT EXISTS harmony_signing_jobs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('debug', 'release')),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('hap', 'app')),
  profile_id TEXT REFERENCES harmony_signing_profiles(id) ON DELETE SET NULL,
  sign_code INTEGER NOT NULL DEFAULT 1 CHECK (sign_code IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('awaiting_upload', 'signing', 'succeeded', 'failed')),
  filename TEXT NOT NULL,
  input_r2_key TEXT NOT NULL,
  input_size INTEGER NOT NULL,
  input_sha256 TEXT NOT NULL,
  output_r2_key TEXT,
  output_size INTEGER,
  output_sha256 TEXT,
  error_code TEXT,
  error_message TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harmony_signing_jobs_app ON harmony_signing_jobs(app_id, created_at);
