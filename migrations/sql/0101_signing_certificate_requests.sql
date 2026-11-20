-- Apple certificate requests made by Hands. The private key is generated
-- inside Hands and kept here (encrypted) until the certificate Apple issues for
-- the request is uploaded; then it becomes a signing identity and the key is
-- cleared from this row.
CREATE TABLE signing_certificate_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('apple_developer_id', 'apple_ios_distribution')),
  name TEXT NOT NULL,
  -- The .certSigningRequest (PEM); public.
  csr_pem TEXT NOT NULL,
  -- Public facts kept for the identity: api_key_from_app, asc_key_id.
  metadata_json TEXT NOT NULL,
  -- AES-GCM over { key_pem, api_key }; NULL once completed or cancelled.
  secret_ciphertext_b64 TEXT,
  secret_iv_b64 TEXT,
  identity_id TEXT REFERENCES signing_identities(id) ON DELETE SET NULL,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  cancelled_at INTEGER
);

CREATE INDEX idx_signing_certificate_requests_org ON signing_certificate_requests(org_id, completed_at, cancelled_at);
