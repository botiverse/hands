-- Immutable Hands producer receipt for Stamp's Android App Update cleanup
-- terminal.  The operation, server-side inactive readback, exact event bytes,
-- subscriber, and signing generation are frozen in one D1 batch.

CREATE TABLE app_update_cleanup_terminal_receipts (
  operation_id TEXT PRIMARY KEY
    REFERENCES operation_logs(id) ON DELETE RESTRICT,
  receipt_digest TEXT NOT NULL UNIQUE
    CHECK (substr(receipt_digest, 1, 7) = 'sha256:' AND length(receipt_digest) = 71
      AND substr(receipt_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  run_case_id TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  artifact_bundle_digest TEXT NOT NULL
    CHECK (length(artifact_bundle_digest) = 64
      AND artifact_bundle_digest NOT GLOB '*[^0-9a-f]*'),
  app_id TEXT NOT NULL,
  release_id TEXT NOT NULL UNIQUE,
  release_revision INTEGER NOT NULL CHECK (release_revision >= 0),
  build_id TEXT NOT NULL,
  app_slug TEXT NOT NULL,
  channel_slug TEXT NOT NULL,
  target_artifact_sha256 TEXT NOT NULL
    CHECK (length(target_artifact_sha256) = 64
      AND target_artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
  target_version_code INTEGER NOT NULL CHECK (target_version_code > 0),
  target_installation_digest TEXT NOT NULL
    CHECK (substr(target_installation_digest, 1, 7) = 'sha256:' AND length(target_installation_digest) = 71
      AND substr(target_installation_digest, 8) NOT GLOB '*[^0-9a-f]*'),
  cancel_readback TEXT NOT NULL CHECK (cancel_readback = 'inactive'),
  scope_deactivated INTEGER NOT NULL CHECK (scope_deactivated = 1),
  scope_readback_json TEXT NOT NULL CHECK (json_valid(scope_readback_json)),
  delivery_bindings_json TEXT NOT NULL CHECK (json_valid(delivery_bindings_json)),
  canonical_request_json TEXT NOT NULL CHECK (json_valid(canonical_request_json)),
  event_payload_json TEXT NOT NULL CHECK (json_valid(event_payload_json)),
  canonical_receipt_json TEXT NOT NULL CHECK (json_valid(canonical_receipt_json)),
  created_at INTEGER NOT NULL
);

-- Keep trigger bodies on one physical line for Cloudflare's remote D1 parser.
CREATE TRIGGER app_update_cleanup_terminal_receipts_no_update BEFORE UPDATE ON app_update_cleanup_terminal_receipts BEGIN SELECT RAISE(ABORT, 'App Update cleanup terminal receipts are immutable'); END;

CREATE TRIGGER app_update_cleanup_terminal_receipts_no_delete BEFORE DELETE ON app_update_cleanup_terminal_receipts BEGIN SELECT RAISE(ABORT, 'App Update cleanup terminal receipts are immutable'); END;

-- A delivery references the immutable producer receipt instead of overloading
-- feedback event foreign keys.  One subscriber can receive a receipt once.
ALTER TABLE webhook_deliveries
  ADD COLUMN app_update_terminal_receipt_id TEXT
    REFERENCES app_update_cleanup_terminal_receipts(operation_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_webhook_deliveries_app_update_terminal
  ON webhook_deliveries(webhook_id, app_update_terminal_receipt_id)
  WHERE app_update_terminal_receipt_id IS NOT NULL;

-- Generic operation mutation endpoints must never rewrite or delete the
-- durable intent/receipt identity, even if a future handler forgets the guard.
CREATE TRIGGER app_update_cleanup_terminal_operation_no_update BEFORE UPDATE ON operation_logs WHEN OLD.kind = 'app-update-cleanup-terminal' BEGIN SELECT RAISE(ABORT, 'App Update cleanup terminal operations are immutable'); END;

CREATE TRIGGER app_update_cleanup_terminal_operation_no_delete BEFORE DELETE ON operation_logs WHEN OLD.kind = 'app-update-cleanup-terminal' BEGIN SELECT RAISE(ABORT, 'App Update cleanup terminal operations are immutable'); END;
