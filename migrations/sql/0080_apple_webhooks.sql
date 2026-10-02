-- Apple ingress receipts and outbound deliveries commit in one D1 batch.
CREATE TABLE apple_webhook_configs (
 id TEXT PRIMARY KEY,
 app_id TEXT NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
 apple_app_id TEXT NOT NULL,
 secret_ciphertext_b64 TEXT NOT NULL,
 secret_iv_b64 TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE apple_webhook_events (
 app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL,
 event_type TEXT NOT NULL,
 body_sha256 TEXT NOT NULL,
 receipt_nonce TEXT NOT NULL,
 received_at INTEGER NOT NULL,
 PRIMARY KEY(app_id,event_id)
);
