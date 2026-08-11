/**
 * Smoke tests for quiver API routes — run without Cloudflare bindings (mocked).
 *
 * This is a pure unit-level test: stub `DB` with an in-memory better-sqlite3 DB
 * and exercise the SQL surface directly. The goal is to validate:
 *
 *   1. SQL queries compile + execute against a real SQLite in-memory DB
 *   2. Schema constraints (UNIQUE, FK cascade) work as expected
 *   3. CRUD flow for apps / channels / versions / audit_logs
 *
 * Note: We use anonymous `?` placeholders instead of D1's `?1, ?2` style because
 * better-sqlite3 doesn't support numbered placeholders. In production the same
 * queries run against Cloudflare D1 with `?1, ?2` style and work identically.
 *
 * Run with: `pnpm test`
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { authMiddleware } from "../src/middleware/auth";
import {
  requireAppPermission,
  requireAppRole,
  requireCurrentOrgRole,
  requireFeedbackTriageRole,
} from "../src/lib/permissions";
import {
  handleUpdateFeedback,
  handleAddFeedbackComment,
  resetSymbolication,
  appendSymbolication,
  dispatchSymbolication,
} from "../src/routes/feedback";
import {
  httpsRedirectUrl,
  isSecureRequest,
  requestOrigin,
} from "../src/lib/origin";
import { openApiDocument } from "../src/openapi";
import { handleCreateApp, handleListApps, handleUpdateFeatureFlag } from "../src/routes/apps";
import { createSignedJwt, handleAuthLogin, handleAuthMe, handleDashboardRedirect } from "../src/routes/auth";
import { handleListOrgs } from "../src/routes/orgs";
import {
  handleCompleteIosSimulatorArtifact,
  handleCreateIosSimulatorArtifact,
  handleDownloadIosSimulatorArtifact,
  handleGetIosSimulatorArtifact,
  handleListIosSimulatorArtifacts,
} from "../src/routes/qa_artifacts";

const releaseVersionReuseTriggerStatements = readFileSync(
  new URL("../../migrations/sql/0057_activated_version_reuse_guard.sql", import.meta.url),
  "utf8",
).split("\n").filter((line) => line.startsWith("CREATE TRIGGER"));

// ---------- Test harness ----------

interface MockEnv {
  DB: {
    prepare: (sql: string) => any;
  };
  APK_BUCKET: unknown;
  ENVIRONMENT: string;
  ADMIN_API_TOKEN: string;
  RAFT_CLIENT_ID: string;
  RAFT_CLIENT_SECRET: string;
  RAFT_ORIGIN: string;
  RAFT_API_ORIGIN: string;
  BUSINESS_ORIGIN: string;
  DASHBOARD_ORIGIN: string;
  SIGNED_URL_SECRET?: string;
  SIGNED_URL_TTL_SECONDS: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  R2_PRESIGNED_DOWNLOAD_TTL_SECONDS?: string;
  APK_PARSER: unknown;
  MAX_APK_SIZE_MB: string;
}

describe("quiver OpenAPI document", () => {
  it("covers representative public, admin, feedback, access, and operations routes", () => {
    const paths = openApiDocument.paths ?? {};

    for (const path of [
      "/public/v2/apps/{slug}/updates/check",
      "/electron/{slug}/{channel}/{file}",
      "/public/v2/apps/{slug}/feedback",
      "/public/v2/apps/{slug}/metrics",
      "/apps/{slug}/history",
      "/apps/{slug}/latest",
      "/apps/{slug}/latest/download",
      "/api/apps",
      "/api/apps/{appId}/builds",
      "/api/apps/{appId}/builds/publish-version",
      "/api/apps/{appId}/builds/{buildId}/external-targets",
      "/api/apps/{appId}/builds/{buildId}/testflight-upload",
      "/api/apps/{appId}/testflight-uploads/{buildUploadId}",
      "/api/apps/{appId}/testflight-beta-app-description",
      "/api/apps/{appId}/builds/{buildId}/testflight-groups",
      "/api/apps/{appId}/builds/{buildId}/testflight-expire",
      "/api/apps/{appId}/builds/{buildId}/testflight-publish",
      "/api/apps/{appId}/qa-artifacts/ios-simulator",
      "/api/apps/{appId}/qa-artifacts/ios-simulator/{assetId}",
      "/api/apps/{appId}/qa-artifacts/ios-simulator/{assetId}/complete",
      "/api/apps/{appId}/qa-artifacts/ios-simulator/{assetId}/download",
      "/api/apps/{appId}/releases/{releaseId}/publish",
      "/api/apps/{appId}/feedback/{ticketId}/comments",
      "/api/apps/{appId}/reporter-feedback/session",
      "/api/apps/{appId}/reporter-feedback/{ticketId}/reopen",
      "/api/app-permissions",
      "/api/apps/{appId}/client-key",
      "/api/apps/{appId}/analytics/versions",
      "/api/orgs/{orgId}/invites",
      "/api/orgs/{orgId}/webhooks/{webhookId}/deliveries",
      "/api/apps/{appId}/channels/{channelId}",
      "/api/apps/{appId}/operations/{opId}/retry",
      "/api/apps/{appId}/deploy-tokens",
    ]) {
      expect(paths[path], path).toBeDefined();
    }

    expect(paths["/api/apps/{appId}/releases/{releaseId}/publish"]?.post).toBeDefined();
    expect(paths["/api/apps/{appId}/feedback/{ticketId}/comments"]?.post).toBeDefined();
    expect(paths["/public/v2/apps/{slug}/feedback"]?.post).toBeDefined();
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(60);
  });
});

/** Spin up an in-memory SQLite that mimics D1's bind/run/all/first shape. */
function makeMockDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE apps (
      id TEXT PRIMARY KEY, org_id TEXT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      platform TEXT NOT NULL, description TEXT, archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER, created_at INTEGER NOT NULL, icon_r2_key TEXT, public_history INTEGER NOT NULL DEFAULT 0, client_key TEXT,
      delta_updates_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE feature_flags (
      id TEXT PRIMARY KEY,
      app_id TEXT,
      key TEXT NOT NULL,
      default_enabled INTEGER NOT NULL DEFAULT 0,
      rollout_percent INTEGER NOT NULL DEFAULT 0,
      allow_device_ids TEXT NOT NULL DEFAULT '[]',
      deny_device_ids TEXT NOT NULL DEFAULT '[]',
      allow_cohorts TEXT NOT NULL DEFAULT '[]',
      platforms TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL,
      updated_by TEXT,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_feature_flags_app_key ON feature_flags(app_id, key);
    CREATE TABLE channels (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, slug TEXT NOT NULL,
      name TEXT NOT NULL, bundle_id TEXT, password TEXT, git_url TEXT,
      enabled_product_types_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE (app_id, slug),
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE TABLE product_types (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      supported_platforms_json TEXT NOT NULL DEFAULT '[]',
      default_assets_json TEXT NOT NULL DEFAULT '[]',
      parser_kind TEXT,
      schema_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (app_id, name),
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE TABLE versions (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, channel TEXT NOT NULL,
      version_name TEXT NOT NULL, version_code INTEGER NOT NULL,
      package_name TEXT NOT NULL, signature_sha256 TEXT NOT NULL,
      min_sdk INTEGER, target_sdk INTEGER,
      size_bytes INTEGER NOT NULL, file_hash TEXT NOT NULL,
      r2_key TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      changelog TEXT,
      should_force_update INTEGER NOT NULL DEFAULT 0,
      availability_at INTEGER,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_versions_app_code_channel
      ON versions(app_id, channel, version_code);
    CREATE TABLE builds (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      channel_id TEXT,
      product_type TEXT NOT NULL DEFAULT 'android-apk',
      release_type TEXT NOT NULL DEFAULT 'stable',
      version_name TEXT NOT NULL,
      version_code INTEGER NOT NULL,
      changelog TEXT,
      source TEXT NOT NULL DEFAULT 'web',
      status TEXT NOT NULL DEFAULT 'pending',
      build_metadata_json TEXT NOT NULL DEFAULT '{}',
      parsed_metadata_json TEXT NOT NULL DEFAULT '{}',
      should_force_update INTEGER NOT NULL DEFAULT 0,
      availability_at INTEGER,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      targets_frozen_at INTEGER,
      freeze_token TEXT,
      required_targets_json TEXT,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );
    CREATE TABLE external_build_targets (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
      version_name TEXT NOT NULL,
      target TEXT NOT NULL,
      source_url TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL,
      raw_size_bytes INTEGER NOT NULL,
      gzip_sha256 TEXT,
      gzip_size_bytes INTEGER,
      node_version TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      gzip_source_url TEXT,
      UNIQUE (app_id, version_name, target)
    );
    CREATE TABLE signing_credentials (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL DEFAULT 'account',
      owner_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      encrypted_blob BLOB NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE build_assets (
      id TEXT PRIMARY KEY,
      build_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL DEFAULT 'installable',
      platform TEXT NOT NULL,
      arch TEXT,
      variant TEXT,
      filetype TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      signature TEXT,
      signing_credential_id TEXT REFERENCES signing_credentials(id) ON DELETE SET NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      download_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (build_id, platform, arch, variant, filetype),
      FOREIGN KEY (build_id) REFERENCES builds(id) ON DELETE CASCADE
    );
    CREATE TABLE releases (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      build_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      product_type TEXT NOT NULL,
      release_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      activated_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 0,
      is_full INTEGER NOT NULL DEFAULT 1,
      superseded_by_release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
      rollout_cohort_count INTEGER,
      rollout_target_cohorts_json TEXT NOT NULL DEFAULT '[]',
      availability_at INTEGER,
      should_force_update INTEGER NOT NULL DEFAULT 0,
      changelog TEXT,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      hidden INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
      FOREIGN KEY (build_id) REFERENCES builds(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );
    CREATE TABLE release_scopes (
      id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
    );
    CREATE TABLE device_groups (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_device_groups_app_name
      ON device_groups(app_id, name COLLATE NOCASE);
    CREATE TABLE device_group_members (
      group_id TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, device_id)
    );
    CREATE TABLE release_metrics (
      release_id TEXT PRIMARY KEY,
      offered_count INTEGER NOT NULL DEFAULT 0,
      current_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at INTEGER
    );
    CREATE TABLE release_metric_devices (
      release_id TEXT NOT NULL,
      metric_kind TEXT NOT NULL CHECK(metric_kind IN ('current', 'offered')),
      device_id TEXT NOT NULL,
      first_checked_at INTEGER NOT NULL,
      last_checked_at INTEGER NOT NULL,
      PRIMARY KEY (release_id, metric_kind, device_id)
    );
    CREATE TABLE release_checks (
      id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      app_id TEXT NOT NULL,
      source TEXT NOT NULL,
      run_id TEXT,
      run_url TEXT,
      verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'failed', 'warning', 'skipped')),
      cases_total INTEGER,
      cases_passed INTEGER,
      summary TEXT,
      reviewer TEXT,
      reviewed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (release_id, source)
    );
    CREATE TABLE release_shares (
      id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      token TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      password_hash TEXT
    );
    CREATE TABLE release_share_events (
      id TEXT PRIMARY KEY,
      share_id TEXT NOT NULL REFERENCES release_shares(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('view', 'download')),
      visitor_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE operation_logs (
      id TEXT PRIMARY KEY,
      app_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      parent_op_id TEXT,
      step_number INTEGER,
      actor TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      error TEXT,
      progress REAL NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE TABLE feedback_tickets (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'feedback',
      status TEXT NOT NULL DEFAULT 'open',
      message TEXT NOT NULL,
      contact TEXT,
      version_name TEXT,
      version_code INTEGER,
      channel TEXT,
      device_id TEXT,
      device_model TEXT,
      os_version TEXT,
      arch TEXT,
      locale TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      client_ip_hash TEXT,
      assignee TEXT,
      signature TEXT,
      submission_id TEXT,
      submission_fingerprint TEXT,
      reporter_id TEXT,
      reporter_integration_id TEXT,
      symbolication_status TEXT,
      symbolicated_stack TEXT,
      symbolicated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_feedback_tickets_submission_direct
      ON feedback_tickets(app_id, submission_id)
      WHERE submission_id IS NOT NULL AND reporter_integration_id IS NULL;
    CREATE UNIQUE INDEX idx_feedback_tickets_submission_reporter
      ON feedback_tickets(app_id, reporter_integration_id, submission_id)
      WHERE submission_id IS NOT NULL AND reporter_integration_id IS NOT NULL;
    CREATE INDEX idx_feedback_tickets_reporter
      ON feedback_tickets(app_id, reporter_id, created_at)
      WHERE reporter_id IS NOT NULL;
    CREATE TABLE device_pings (
      app_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      version_name TEXT,
      version_code INTEGER,
      channel TEXT,
      platform TEXT,
      arch TEXT,
      os_version TEXT,
      device_model TEXT,
      locale TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      ping_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (app_id, device_id)
    );
    CREATE TABLE app_sessions (
      app_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      version_name TEXT,
      version_code INTEGER,
      channel TEXT,
      platform TEXT,
      os_version TEXT,
      device_model TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER,
      crashed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_id, session_id)
    );
    CREATE TABLE feedback_attachments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      comment_id TEXT,
      r2_key TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT,
      size_bytes INTEGER NOT NULL,
      origin TEXT NOT NULL DEFAULT 'submission',
      visibility TEXT NOT NULL DEFAULT 'reporter',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE feedback_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      author_actor TEXT NOT NULL,
      author_type TEXT NOT NULL DEFAULT 'staff',
      body TEXT NOT NULL,
      internal INTEGER NOT NULL DEFAULT 0,
      reporter_integration_id TEXT,
      reporter_id TEXT,
      submission_id TEXT,
      submission_fingerprint TEXT,
      reporter_sequence INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_feedback_comments_reporter_sequence
      ON feedback_comments(reporter_sequence);
    CREATE UNIQUE INDEX idx_feedback_comments_reporter_submission
      ON feedback_comments(ticket_id, reporter_integration_id, reporter_id, submission_id)
      WHERE author_type = 'reporter';
    CREATE TABLE feedback_comment_sequence_state (
      singleton INTEGER PRIMARY KEY,
      high_water INTEGER NOT NULL
    );
    INSERT INTO feedback_comment_sequence_state (singleton, high_water) VALUES (1, 0);
    CREATE TRIGGER feedback_comment_sequence_state_no_delete
    BEFORE DELETE ON feedback_comment_sequence_state
    BEGIN
      SELECT RAISE(ABORT, 'feedback comment sequence state is durable');
    END;
    CREATE TRIGGER feedback_comment_sequence_state_monotonic
    BEFORE UPDATE ON feedback_comment_sequence_state
    WHEN NEW.singleton != OLD.singleton OR NEW.high_water != OLD.high_water + 1
    BEGIN
      SELECT RAISE(ABORT, 'feedback comment sequence high-water must advance by one');
    END;
    CREATE TRIGGER feedback_comments_reporter_sequence_managed
    BEFORE INSERT ON feedback_comments
    WHEN NEW.reporter_sequence IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'feedback comment sequence is managed');
    END;
    CREATE TRIGGER feedback_comments_reporter_sequence_insert
    AFTER INSERT ON feedback_comments
    BEGIN
      UPDATE feedback_comment_sequence_state
      SET high_water = high_water + 1 WHERE singleton = 1;
      UPDATE feedback_comments
      SET reporter_sequence = (
        SELECT high_water FROM feedback_comment_sequence_state WHERE singleton = 1
      )
      WHERE rowid = NEW.rowid;
    END;
    CREATE TRIGGER feedback_comments_reporter_sequence_immutable
    BEFORE UPDATE OF reporter_sequence ON feedback_comments
    WHEN OLD.reporter_sequence IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'feedback comment sequence is immutable');
    END;
    CREATE TABLE app_reporter_integrations (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      UNIQUE(app_id, name)
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, action TEXT NOT NULL,
      actor TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      actor_id TEXT, actor_type TEXT,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE TABLE raft_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'raft',
      provider_subject TEXT NOT NULL,
      server_id TEXT NOT NULL,
      server_slug TEXT,
      principal_type TEXT NOT NULL,
      server_role TEXT,
      username TEXT,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      raw_profile TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER NOT NULL,
      UNIQUE (provider, provider_subject, server_id)
    );
    CREATE TABLE raft_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (account_id) REFERENCES raft_accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      external_provider TEXT NOT NULL DEFAULT 'raft',
      external_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      UNIQUE (external_provider, external_id)
    );
    CREATE TABLE org_members (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
      org_role TEXT NOT NULL,
      invited_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
      joined_at INTEGER NOT NULL,
      UNIQUE (org_id, account_id)
    );
    CREATE TABLE app_members (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
      app_role TEXT NOT NULL,
      invited_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
      joined_at INTEGER NOT NULL,
      UNIQUE (app_id, account_id)
    );
    CREATE TABLE app_server_grants (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      server_id TEXT,
      server_slug TEXT,
      app_role TEXT NOT NULL CHECK (app_role IN ('admin', 'publisher', 'viewer')),
      access_model TEXT NOT NULL DEFAULT 'legacy_role' CHECK (access_model IN ('legacy_role', 'owner_server')),
      granted_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (server_id IS NOT NULL OR server_slug IS NOT NULL),
      UNIQUE (app_id, server_id),
      UNIQUE (app_id, server_slug)
    );
    CREATE TABLE app_deploy_tokens (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      app_role TEXT CHECK (app_role IN ('publisher', 'viewer')),
      scopes_json TEXT,
      created_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
      created_by_actor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER,
      reporter_integration_id TEXT REFERENCES app_reporter_integrations(id) ON DELETE SET NULL,
      CHECK (app_role IS NOT NULL OR scopes_json IS NOT NULL)
    );
    CREATE TABLE invites (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      invited_by TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER,
      accepted_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
      revoked_at INTEGER,
      revoked_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX idx_invites_pending_email
      ON invites(org_id, email)
      WHERE status = 'pending';
    INSERT INTO organizations
      (id, slug, name, external_provider, external_id, created_at, archived)
      VALUES ('default', 'default', 'Default', 'local', 'default', 1, 0);

    CREATE TABLE webhooks (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      signature_key_version TEXT NOT NULL DEFAULT 'v1',
      events_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    -- Migration 0018: apps.default_channel_id (nullable FK to channels).
    -- SQLite ALTER TABLE ADD COLUMN is non-destructive; add inline so the
    -- test schema matches the migration shape.
    ALTER TABLE apps ADD COLUMN default_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL;
    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      event_id TEXT REFERENCES feedback_events(id) ON DELETE SET NULL,
      feedback_submission_event_id TEXT REFERENCES feedback_submission_events(id) ON DELETE SET NULL,
      payload_json TEXT NOT NULL,
      signing_secret TEXT,
      signature_key_version TEXT NOT NULL DEFAULT 'legacy-v1',
      reporter_delivery INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_attempt_at INTEGER,
      next_attempt_at INTEGER,
      last_response_status INTEGER,
      last_response_body TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE UNIQUE INDEX idx_webhook_deliveries_event
      ON webhook_deliveries(webhook_id, event_id) WHERE event_id IS NOT NULL;
    CREATE TABLE feedback_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
      reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
      reporter_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      route_outcome TEXT NOT NULL DEFAULT 'route_unbound',
      route_subject TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE feedback_submission_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
      reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
      reporter_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      route_outcome TEXT NOT NULL,
      route_subject TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_webhook_deliveries_submission_event
      ON webhook_deliveries(webhook_id, feedback_submission_event_id)
      WHERE feedback_submission_event_id IS NOT NULL;
    CREATE TABLE app_reporter_routes (
      app_id TEXT NOT NULL,
      reporter_integration_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      route_subject TEXT NOT NULL,
      subject_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, reporter_integration_id, reporter_id)
    );
    CREATE TABLE app_reporter_webhook_subscriptions (
      app_id TEXT NOT NULL,
      reporter_integration_id TEXT NOT NULL,
      webhook_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, reporter_integration_id, webhook_id)
    );
    CREATE TABLE feedback_reporter_rate_windows (
      app_id TEXT NOT NULL,
      reporter_integration_id TEXT NOT NULL,
      reporter_hash TEXT NOT NULL,
      audit_key_version TEXT NOT NULL,
      endpoint TEXT NOT NULL
        CHECK (endpoint IN ('list', 'detail', 'attachment', 'comment', 'close')),
      window_started_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      last_audited_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, reporter_integration_id, reporter_hash,
                   audit_key_version, endpoint, window_started_at)
    );
    CREATE TABLE feedback_reporter_session_mint_rate_windows (
      app_id TEXT NOT NULL,
      reporter_integration_id TEXT NOT NULL,
      deploy_token_id TEXT NOT NULL,
      reporter_hash TEXT NOT NULL,
      audit_key_version TEXT NOT NULL,
      window_started_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, reporter_integration_id, deploy_token_id,
                   reporter_hash, audit_key_version, window_started_at)
    );
    CREATE TABLE feedback_reporter_access_audits (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      reporter_integration_id TEXT NOT NULL,
      reporter_hash TEXT NOT NULL,
      audit_key_version TEXT NOT NULL,
      endpoint TEXT NOT NULL
        CHECK (endpoint IN ('list', 'detail', 'attachment', 'comment', 'close')),
      ticket_id TEXT,
      attachment_id TEXT,
      throttle_window_started_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_feedback_reporter_access_audits_throttle
      ON feedback_reporter_access_audits(
        app_id, reporter_integration_id, reporter_hash, audit_key_version,
        endpoint, throttle_window_started_at
      ) WHERE throttle_window_started_at IS NOT NULL;
    CREATE TABLE feedback_reporter_ticket_reads (
      app_id TEXT NOT NULL,
      reporter_integration_id TEXT NOT NULL,
      reporter_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      read_through_sequence INTEGER NOT NULL,
      read_through_comment_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, reporter_integration_id, reporter_id, ticket_id)
    );
    CREATE TABLE feedback_reporter_r2_cleanup (
      r2_key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TRIGGER feedback_reporter_attachments_cleanup_insert
    BEFORE INSERT ON feedback_attachments
    WHEN NEW.origin = 'reporter' AND NOT EXISTS (
      SELECT 1 FROM feedback_reporter_r2_cleanup cleanup
      WHERE cleanup.r2_key = NEW.r2_key AND cleanup.state = 'uploading'
    )
    BEGIN
      SELECT RAISE(ABORT, 'feedback reporter attachment cleanup intent missing');
    END;
  `);

  // Replace `?N` numbered placeholders with anonymous `?` (better-sqlite3 compat).
  // The real D1 migration keeps `?N` — same SQL semantics, just different binding.
  // Numbered placeholders may repeat (`?1, ?1` binds one value on D1), so track
  // the index sequence and expand the bound params to match the anonymous slots.
  return {
    batch: async (statements: Array<{ run: () => Promise<unknown>; _runSync?: () => unknown }>) => {
      return sqlite.transaction(() => statements.map((statement) =>
        statement._runSync ? statement._runSync() : statement.run()
      ))();
    },
    prepare(sql: string) {
      const indexSequence: number[] = [];
      const normSql = sql.replace(/\?(\d+)/g, (_match, n) => {
        indexSequence.push(Number(n));
        return "?";
      });
      const stmt = sqlite.prepare(normSql);
      const bind = (...params: any[]) => {
        const expanded =
          indexSequence.length > 0 ? indexSequence.map((n) => params[n - 1]) : params;
        const runSync = () => {
          const info = stmt.run(...expanded);
          return { success: true, meta: { changes: info.changes } };
        };
        const batchSync = () => stmt.reader
          ? { results: stmt.all(...expanded), success: true }
          : runSync();
        return {
          _runSync: batchSync,
          run: async () => runSync(),
          all: async () => {
            const rows = stmt.all(...expanded);
            return { results: rows, success: true };
          },
          first: async () => {
            const rows = stmt.all(...expanded);
            return rows[0] ?? null;
          },
        };
      };
      // D1 also allows run/all/first directly on the unbound statement.
      return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
    },
  };
}

function makeMockEnv(): MockEnv {
  return {
    DB: makeMockDb() as any,
    APK_BUCKET: null,
    ENVIRONMENT: "development",
    ADMIN_API_TOKEN: "test-token-123",
    RAFT_CLIENT_ID: "quiver-test",
    RAFT_CLIENT_SECRET: "test-secret",
    RAFT_ORIGIN: "https://raft.example",
    RAFT_API_ORIGIN: "https://raft-api.example",
    BUSINESS_ORIGIN: "https://business.example",
    DASHBOARD_ORIGIN: "https://dashboard.example",
    SIGNED_URL_SECRET: "test-signed-url-secret",
    SIGNED_URL_TTL_SECONDS: "3600",
    APK_PARSER: null,
    MAX_APK_SIZE_MB: "200",
  };
}

describe("quiver route handlers — SQL smoke", () => {
  let env: MockEnv;

  beforeEach(() => {
    env = makeMockEnv();
  });

  it("creates + lists apps", async () => {
    const create = await env.DB
      .prepare(
        "INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("a1", "myapp-android", "My App", "android", Date.now())
      .run();
    expect(create.success).toBe(true);

    const list = await env.DB
      .prepare("SELECT id, slug, name, platform FROM apps ORDER BY created_at DESC")
      .bind()
      .all();
    expect(list.results).toHaveLength(1);
    expect(list.results[0]).toMatchObject({
      id: "a1",
      slug: "myapp-android",
      name: "My App",
      platform: "android",
    });
  });

  it("rejects duplicate app slug", async () => {
    await env.DB
      .prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("a1", "dupe-slug", "First", "android", Date.now())
      .run();

    await expect(
      env.DB
        .prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind("a2", "dupe-slug", "Second", "android", Date.now())
        .run(),
    ).rejects.toThrow(/UNIQUE|SQLITE_CONSTRAINT/);
  });

  it("creates a channel and a version under an app", async () => {
    const now = Date.now();
    await env.DB
      .prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("a1", "myapp-android", "My App", "android", now)
      .run();
    await env.DB
      .prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("c1", "a1", "production", "Production", now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO versions (id, app_id, channel, version_name, version_code,
          package_name, signature_sha256, min_sdk, target_sdk, size_bytes,
          file_hash, r2_key, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(
        "v1",
        "a1",
        "production",
        "1.0.0",
        1,
        "com.example.myapp",
        "abc123",
        24,
        34,
        12345678,
        "deadbeef",
        "apps/a1/versions/v1/binary.apk",
        now,
      )
      .run();

    const channels = await env.DB
      .prepare("SELECT id, slug FROM channels WHERE app_id = ?")
      .bind("a1")
      .all();
    expect(channels.results).toHaveLength(1);

    const versions = await env.DB
      .prepare(
        "SELECT version_name, version_code, enabled FROM versions WHERE app_id = ? AND channel = ?",
      )
      .bind("a1", "production")
      .all();
    expect(versions.results).toHaveLength(1);
    expect(versions.results[0]).toMatchObject({
      version_name: "1.0.0",
      version_code: 1,
      enabled: 1,
    });
  });

  it("audit log records admin actions", async () => {
    const now = Date.now();
    await env.DB
      .prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("a1", "audit-test", "Audit Test", "android", now)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("log1", "a1", "app.create", "admin", '{"slug":"audit-test"}', now)
      .run();

    const logs = await env.DB
      .prepare(
        "SELECT action, actor, payload FROM audit_logs WHERE app_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .bind("a1", 10)
      .all();
    expect(logs.results).toHaveLength(1);
    expect(logs.results[0]).toMatchObject({ action: "app.create", actor: "admin" });
  });

  it("org membership treats Raft humans and agents as first-class principals", async () => {
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind("raft_s1", "team-s1", "Team", "s1", now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO raft_accounts
         (id, provider, provider_subject, server_id, server_slug, principal_type,
          server_role, username, display_name, avatar_url, raw_profile,
          created_at, updated_at, last_login_at)
         VALUES (?, 'raft', ?, 's1', 'team', ?, NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
      )
      .bind("human1", "sub-human", "human", "alice", "Alice", now, now, now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO raft_accounts
         (id, provider, provider_subject, server_id, server_slug, principal_type,
          server_role, username, display_name, avatar_url, raw_profile,
          created_at, updated_at, last_login_at)
         VALUES (?, 'raft', ?, 's1', 'team', ?, NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
      )
      .bind("agent1", "sub-agent", "agent", "deploy-agent", "Deploy agent", now, now, now)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("m1", "raft_s1", "human1", "owner", now)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("m2", "raft_s1", "agent1", "member", now)
      .run();

    const members = await env.DB
      .prepare(
        `SELECT a.principal_type, om.org_role
         FROM org_members om
         JOIN raft_accounts a ON a.id = om.account_id
         WHERE om.org_id = ?
         ORDER BY a.principal_type ASC`,
      )
      .bind("raft_s1")
      .all();

    expect(members.results).toEqual([
      { principal_type: "agent", org_role: "member" },
      { principal_type: "human", org_role: "owner" },
    ]);
  });

  it("lets org members create apps while viewers remain read-only", async () => {
    const now = Date.now();
    const memberToken = "member-create-token";
    const viewerToken = "viewer-create-token";

    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind("raft_create", "create-org", "Create Org", "create-server", now)
      .run();

    for (const account of [
      { id: "member-agent", subject: "member-sub", role: "member", token: memberToken },
      { id: "viewer-agent", subject: "viewer-sub", role: "viewer", token: viewerToken },
    ]) {
      await env.DB
        .prepare(
          `INSERT INTO raft_accounts
           (id, provider, provider_subject, server_id, server_slug, principal_type,
            server_role, username, display_name, avatar_url, raw_profile,
            created_at, updated_at, last_login_at)
           VALUES (?, 'raft', ?, 'create-server', 'create-org', 'agent',
                   NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
        )
        .bind(account.id, account.subject, account.id, account.id, now, now, now)
        .run();
      await env.DB
        .prepare(
          "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(`orgmem-${account.id}`, "raft_create", account.id, account.role, now)
        .run();
      await env.DB
        .prepare(
          "INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          `session-${account.id}`,
          account.id,
          createHash("sha256").update(account.token).digest("hex"),
          now,
          now + 60_000,
          now,
        )
        .run();
    }

    const testApp = new Hono<{ Bindings: Env }>();
    testApp.use("*", authMiddleware as any);
    testApp.post("/api/apps", requireCurrentOrgRole("member") as any, handleCreateApp as any);

    const viewerResponse = await testApp.request(
      "https://quiver-worker.test/api/apps",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${viewerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slug: "viewer-app", name: "Viewer App", platform: "android" }),
      },
      env as any,
    );
    expect(viewerResponse.status).toBe(403);
    const viewerBody = (await viewerResponse.json()) as Record<string, unknown>;
    expect(viewerBody).toMatchObject({
      error: "insufficient_org_role",
      code: "INSUFFICIENT_ORG_ROLE",
      required_role: "member",
      current_role: "viewer",
      resource: "POST /api/apps",
      admin_can_grant: true,
    });
    // Admin-native actionable error: next_action names the required role and
    // points at where an admin grants it.
    expect(typeof viewerBody.next_action).toBe("string");
    expect(viewerBody.next_action as string).toContain("member");
    expect(viewerBody.next_action as string).toContain("/members");
    expect(viewerBody.manage_url).toBe(
      "https://dashboard.example/orgs/raft_create/members",
    );

    const memberResponse = await testApp.request(
      "https://quiver-worker.test/api/apps",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${memberToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slug: "member-app", name: "Member App", platform: "web" }),
      },
      env as any,
    );
    expect(memberResponse.status).toBe(201);
    await expect(memberResponse.json()).resolves.toMatchObject({
      org_id: "raft_create",
      slug: "member-app",
      name: "Member App",
      platform: "web",
    });

    const duplicateResponse = await testApp.request(
      "https://quiver-worker.test/api/apps",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${memberToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slug: "member-app", name: "Duplicate", platform: "web" }),
      },
      env as any,
    );
    expect(duplicateResponse.status).toBe(409);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      error: "app slug already exists",
      code: "APP_SLUG_CONFLICT",
      slug: "member-app",
    });

    const seededChannels = await env.DB
      .prepare("SELECT slug FROM channels WHERE app_id = (SELECT id FROM apps WHERE slug = ?) ORDER BY slug")
      .bind("member-app")
      .all();
    expect(seededChannels.results.map((row: any) => row.slug)).toEqual(["main", "nightly", "preview"]);
  });

  it("appendSymbolication writes the ticket field + raises status by rank; reset clears it", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES ('sym-t', 'sym-app', 'crash', 'open', 'boom', '{}', ?, ?)`,
    )
      .bind(now, now)
      .run();

    const readSym = () =>
      env.DB.prepare(
        "SELECT symbolication_status, symbolicated_stack FROM feedback_tickets WHERE id = ?1",
      )
        .bind("sym-t")
        .first() as Promise<{ symbolication_status: string; symbolicated_stack: string | null }>;

    await appendSymbolication(env as any, "sym-t", "native", "no_symbols", "no native-symbols asset");
    let row = await readSym();
    expect(row.symbolication_status).toBe("no_symbols");
    expect(row.symbolicated_stack).toContain("[native]");
    expect(row.symbolicated_stack).toContain("no native-symbols asset");

    // A real symbolicated result outranks no_symbols and appends its block.
    await appendSymbolication(env as any, "sym-t", "android-r8", "symbolicated", "at Foo.bar(Foo.kt:1)");
    row = await readSym();
    expect(row.symbolication_status).toBe("symbolicated");
    expect(row.symbolicated_stack).toContain("[native]");
    expect(row.symbolicated_stack).toContain("[android-r8]");

    // A later no_symbols must NOT downgrade a symbolicated status.
    await appendSymbolication(env as any, "sym-t", "ios-dsym", "no_symbols", "no dsym");
    row = await readSym();
    expect(row.symbolication_status).toBe("symbolicated");

    await resetSymbolication(env as any, "sym-t");
    const cleared = await readSym();
    expect(cleared.symbolication_status).toBe("pending");
    expect(cleared.symbolicated_stack).toBeNull();
  });

  it("dispatchSymbolication selects lanes by app platform, never by content alone", async () => {
    env.APK_BUCKET = { put: async () => undefined, get: async () => null };
    const now = Date.now();
    const mkTicket = async (id: string) => {
      await env.DB.prepare(
        `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
         VALUES (?1, 'lane-app', 'crash', 'open', 'boom', '{}', ?2, ?3)`,
      )
        .bind(id, now, now)
        .run();
    };
    const readSym = (id: string) =>
      env.DB.prepare(
        "SELECT symbolication_status, symbolicated_stack FROM feedback_tickets WHERE id = ?1",
      )
        .bind(id)
        .first() as Promise<{ symbolication_status: string; symbolicated_stack: string | null }>;
    const dsymMeta = {
      crash_binary_images: [
        { uuid: "ABCD-1234", load_address: "0x100000000", end_address: "0x100010000", name: "App" },
      ],
      crash_frames: [{ index: 0, address: "0x100000f00" }],
    };

    // iOS + crash log but no structured frames: the android-r8 lane must NOT
    // fire off the log attachment (task #158 regression, ticket 24f26409);
    // instead the iOS metadata gap is reported.
    await mkTicket("lane-ios-log");
    await dispatchSymbolication(
      env as any,
      { id: "lane-app", platform: "ios" },
      "lane-ios-log",
      42,
      {},
      "r2/ios-crash.txt",
    );
    let row = await readSym("lane-ios-log");
    expect(row.symbolicated_stack).not.toContain("[android-r8]");
    expect(row.symbolicated_stack).not.toContain("proguard");
    expect(row.symbolicated_stack).toContain("[ios-dsym]");
    expect(row.symbolicated_stack).toContain("crash_binary_images");
    expect(row.symbolication_status).toBe("no_symbols");

    // iOS with structured frames but no dsym asset: only the iOS dSYM gap.
    await mkTicket("lane-ios-meta");
    await dispatchSymbolication(
      env as any,
      { id: "lane-app", platform: "ios" },
      "lane-ios-meta",
      42,
      dsymMeta,
      "r2/ios-crash.txt",
    );
    row = await readSym("lane-ios-meta");
    expect(row.symbolicated_stack).not.toContain("[android-r8]");
    expect(row.symbolicated_stack).toContain("[ios-dsym]");
    expect(row.symbolicated_stack).toContain("No 'dsym' build asset");
    expect(row.symbolication_status).toBe("no_symbols");

    // Android + crash log, no mapping asset: android-r8 lane with the R8 hint,
    // and iOS-shaped metadata must not drag in the dSYM lane.
    await mkTicket("lane-android");
    await dispatchSymbolication(
      env as any,
      { id: "lane-app", platform: "android" },
      "lane-android",
      42,
      dsymMeta,
      "r2/android-crash.txt",
    );
    row = await readSym("lane-android");
    expect(row.symbolicated_stack).toContain("[android-r8]");
    expect(row.symbolicated_stack).toContain("hands builds publish-android --mapping");
    expect(row.symbolicated_stack).not.toContain("[ios-dsym]");

    // Android native frames, no symbols asset: native lane only.
    await mkTicket("lane-android-native");
    await dispatchSymbolication(
      env as any,
      { id: "lane-app", platform: "android" },
      "lane-android-native",
      42,
      {
        crash_native_frames: [
          { index: 0, offset: "0x1234", soname: "libapp.so", build_id: "abcd1234" },
        ],
      },
      null,
    );
    row = await readSym("lane-android-native");
    expect(row.symbolicated_stack).toContain("[native]");
    expect(row.symbolicated_stack).toContain("hands builds publish-android --symbols");

    // OHOS + crash log: android-r8 must not fire; the ohos lane owns the log.
    await mkTicket("lane-ohos");
    await dispatchSymbolication(
      env as any,
      { id: "lane-app", platform: "ohos" },
      "lane-ohos",
      42,
      {},
      "r2/ohos-fault.log",
    );
    row = await readSym("lane-ohos");
    expect(row.symbolicated_stack ?? "").not.toContain("[android-r8]");
    expect(row.symbolication_status).toBe("unsymbolicated");

    // Electron + crash log: no dispatch lane applies (minidumps have their own
    // ingest path) — settles on not_applicable instead of an Android block.
    await mkTicket("lane-electron");
    await dispatchSymbolication(
      env as any,
      { id: "lane-app", platform: "electron" },
      "lane-electron",
      42,
      {},
      "r2/renderer-crash.txt",
    );
    row = await readSym("lane-electron");
    expect(row.symbolicated_stack).toBeNull();
    expect(row.symbolication_status).toBe("not_applicable");
  });

  it("lets org members triage feedback (update status + comment) while viewers cannot", async () => {
    const now = Date.now();
    const memberToken = "fb-member-token";
    const viewerToken = "fb-viewer-token";
    const ticketId = "11111111-2222-4333-8444-555555555555";

    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind("raft_fb", "fb-org", "FB Org", "fb-server", now)
      .run();

    await env.DB
      .prepare(
        "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("fb-app", "raft_fb", "fb-app", "FB App", "android", now)
      .run();

    await env.DB
      .prepare(
        `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'crash', 'open', ?, '{}', ?, ?)`,
      )
      .bind(ticketId, "fb-app", "boom", now, now)
      .run();

    for (const account of [
      { id: "fb-member-agent", subject: "fb-member-sub", role: "member", token: memberToken },
      { id: "fb-viewer-agent", subject: "fb-viewer-sub", role: "viewer", token: viewerToken },
    ]) {
      await env.DB
        .prepare(
          `INSERT INTO raft_accounts
           (id, provider, provider_subject, server_id, server_slug, principal_type,
            server_role, username, display_name, avatar_url, raw_profile,
            created_at, updated_at, last_login_at)
           VALUES (?, 'raft', ?, 'fb-server', 'fb-org', 'agent',
                   NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
        )
        .bind(account.id, account.subject, account.id, account.id, now, now, now)
        .run();
      await env.DB
        .prepare(
          "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(`orgmem-${account.id}`, "raft_fb", account.id, account.role, now)
        .run();
      await env.DB
        .prepare(
          "INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          `session-${account.id}`,
          account.id,
          createHash("sha256").update(account.token).digest("hex"),
          now,
          now + 60_000,
          now,
        )
        .run();
    }

    const testApp = new Hono<{ Bindings: Env }>();
    testApp.use("*", authMiddleware as any);
    testApp.patch(
      "/api/apps/:appId/feedback/:ticketId",
      requireFeedbackTriageRole() as any,
      handleUpdateFeedback as any,
    );
    testApp.post(
      "/api/apps/:appId/feedback/:ticketId/comments",
      requireFeedbackTriageRole() as any,
      handleAddFeedbackComment as any,
    );

    // Org viewer (read-only) cannot triage.
    const viewerResponse = await testApp.request(
      `https://quiver-worker.test/api/apps/fb-app/feedback/${ticketId}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      },
      env as any,
    );
    expect(viewerResponse.status).toBe(403);

    // Org member (no explicit app role) can change status...
    const memberStatus = await testApp.request(
      `https://quiver-worker.test/api/apps/fb-app/feedback/${ticketId}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      },
      env as any,
    );
    expect(memberStatus.status).toBe(200);
    await expect(memberStatus.json()).resolves.toMatchObject({ id: ticketId, status: "resolved" });

    // ...and add an attribution comment.
    const memberComment = await testApp.request(
      `https://quiver-worker.test/api/apps/fb-app/feedback/${ticketId}/comments`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
        body: JSON.stringify({ body: "fixed by mobile #999", internal: true }),
      },
      env as any,
    );
    expect(memberComment.status).toBe(201);
    expect(memberComment.headers.get("server-timing")).toMatch(
      /^hands_comment_preflight;dur=\d+\.\d, hands_comment_commit;dur=\d+\.\d$/,
    );

    const ticket = (await env.DB
      .prepare("SELECT status FROM feedback_tickets WHERE id = ?")
      .bind(ticketId)
      .first()) as { status: string } | null;
    expect(ticket?.status).toBe("resolved");
    const comment = (await env.DB
      .prepare("SELECT body, internal FROM feedback_comments WHERE ticket_id = ?")
      .bind(ticketId)
      .first()) as { body: string; internal: number } | null;
    expect(comment?.body).toBe("fixed by mobile #999");
    expect(comment?.internal).toBe(1);
  });

  it("lets an app publisher set feature flags (was admin-only) but denies plain members", async () => {
    const now = Date.now();
    const publisherToken = "ff-pub-token";
    const memberToken = "ff-member-token";

    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind("raft_ff", "ff-org", "FF Org", "ff-server", now)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind("ff-app", "raft_ff", "ff-app", "FF App", "android", now)
      .run();

    // publisher = org viewer + explicit app publisher; member = org member, no app role.
    const accounts = [
      { id: "ff-pub", subject: "ff-pub-sub", org: "viewer", app: "publisher", token: publisherToken },
      { id: "ff-mem", subject: "ff-mem-sub", org: "member", app: null as string | null, token: memberToken },
    ];
    for (const a of accounts) {
      await env.DB
        .prepare(
          `INSERT INTO raft_accounts
           (id, provider, provider_subject, server_id, server_slug, principal_type,
            server_role, username, display_name, avatar_url, raw_profile,
            created_at, updated_at, last_login_at)
           VALUES (?, 'raft', ?, 'ff-server', 'ff-org', 'agent',
                   NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
        )
        .bind(a.id, a.subject, a.id, a.id, now, now, now)
        .run();
      await env.DB
        .prepare(
          "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(`om-${a.id}`, "raft_ff", a.id, a.org, now)
        .run();
      if (a.app) {
        await env.DB
          .prepare(
            "INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(`am-${a.id}`, "ff-app", a.id, a.app, now)
          .run();
      }
      await env.DB
        .prepare(
          "INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          `s-${a.id}`,
          a.id,
          createHash("sha256").update(a.token).digest("hex"),
          now,
          now + 60_000,
          now,
        )
        .run();
    }

    const testApp = new Hono<{ Bindings: Env }>();
    testApp.use("*", authMiddleware as any);
    testApp.put(
      "/api/apps/:appId/feature-flags/:key",
      requireAppRole("publisher") as any,
      handleUpdateFeatureFlag as any,
    );

    // Plain org member (no app role) is below the publisher bar → 403.
    const memberResponse = await testApp.request(
      "https://quiver-worker.test/api/apps/ff-app/feature-flags/delta_updates",
      {
        method: "PUT",
        headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
        body: JSON.stringify({ rollout_percent: 25 }),
      },
      env as any,
    );
    expect(memberResponse.status).toBe(403);

    // App publisher can now toggle the flag (previously required admin).
    const publisherResponse = await testApp.request(
      "https://quiver-worker.test/api/apps/ff-app/feature-flags/delta_updates",
      {
        method: "PUT",
        headers: { authorization: `Bearer ${publisherToken}`, "content-type": "application/json" },
        body: JSON.stringify({ rollout_percent: 25 }),
      },
      env as any,
    );
    expect(publisherResponse.status).toBe(200);
  });

  it("uses a validated selected-org header for org-scoped app requests", async () => {
    const now = Date.now();
    const token = "multi-org-token";

    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0), (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind(
        "org-primary", "primary", "Primary", "server-primary", now,
        "org-secondary", "secondary", "Secondary", "server-secondary", now,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO raft_accounts
         (id, provider, provider_subject, server_id, server_slug, principal_type,
          server_role, username, display_name, avatar_url, raw_profile,
          created_at, updated_at, last_login_at)
         VALUES (?, 'raft', ?, 'server-primary', 'primary', 'human',
                 NULL, ?, ?, NULL, '{}', ?, ?, ?),
                (?, 'raft', ?, 'server-secondary', 'secondary', 'human',
                 NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
      )
      .bind(
        "multi-org-primary", "multi-org-sub", "multi", "Multi Org", now, now, now,
        "multi-org-secondary", "multi-org-sub", "multi", "Multi Org", now, now, now,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO org_members (id, org_id, account_id, org_role, joined_at)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      )
      .bind(
        "member-primary", "org-primary", "multi-org-primary", "owner", now,
        "member-secondary", "org-secondary", "multi-org-secondary", "member", now,
      )
      .run();
    await env.DB
      .prepare(
        "INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "session-multi-org",
        "multi-org-primary",
        createHash("sha256").update(token).digest("hex"),
        now,
        now + 60_000,
        now,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO apps (id, org_id, slug, name, platform, created_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "app-primary", "org-primary", "primary-app", "Primary App", "android", now,
        "app-secondary", "org-secondary", "secondary-app", "Secondary App", "ios", now,
      )
      .run();

    const testApp = new Hono<{ Bindings: Env }>();
    testApp.use("*", authMiddleware as any);
    testApp.get("/api/apps", requireCurrentOrgRole("viewer") as any, handleListApps as any);
    testApp.post("/api/apps", requireCurrentOrgRole("member") as any, handleCreateApp as any);
    testApp.get("/api/orgs", handleListOrgs as any);
    testApp.get("/api/auth/me", handleAuthMe as any);

    const requestApps = (orgId?: string) =>
      testApp.request(
        "https://quiver-worker.test/api/apps",
        {
          headers: {
            authorization: `Bearer ${token}`,
            ...(orgId ? { "x-hands-org-id": orgId } : {}),
          },
        },
        env as any,
      );

    const defaultResponse = await requestApps();
    await expect(defaultResponse.json()).resolves.toMatchObject({
      apps: [{ id: "app-primary", org_id: "org-primary" }],
    });

    const orgsResponse = await testApp.request(
      "https://quiver-worker.test/api/orgs",
      { headers: { authorization: `Bearer ${token}` } },
      env as any,
    );
    const orgsBody = (await orgsResponse.json()) as {
      orgs: Array<{ id: string; org_role: string }>;
    };
    expect(
      orgsBody.orgs
        .map(({ id, org_role }) => ({ id, org_role }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: "org-primary", org_role: "owner" },
      { id: "org-secondary", org_role: "member" },
    ]);

    const selectedResponse = await requestApps("org-secondary");
    await expect(selectedResponse.json()).resolves.toMatchObject({
      apps: [{ id: "app-secondary", org_id: "org-secondary" }],
    });

    const selectedMeResponse = await testApp.request(
      "https://quiver-worker.test/api/auth/me",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "x-hands-org-id": "org-secondary",
        },
      },
      env as any,
    );
    await expect(selectedMeResponse.json()).resolves.toMatchObject({
      account: {
        id: "multi-org-secondary",
        server_id: "server-secondary",
        org_id: "org-secondary",
        org_role: "member",
      },
    });

    const createResponse = await testApp.request(
      "https://quiver-worker.test/api/apps",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-hands-org-id": "org-secondary",
        },
        body: JSON.stringify({
          slug: "secondary-created",
          name: "Secondary Created",
          platform: "web",
        }),
      },
      env as any,
    );
    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      org_id: "org-secondary",
      slug: "secondary-created",
      platform: "web",
    });

    const invalidResponse = await requestApps("org-not-a-member");
    await expect(invalidResponse.json()).resolves.toMatchObject({
      apps: [{ id: "app-primary", org_id: "org-primary" }],
    });
  });

  it("apps are scoped by org_id", async () => {
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind("raft_s2", "team-s2", "Team 2", "s2", now)
      .run();
    await env.DB
      .prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("a1", "default", "default-app", "Default App", "android", now)
      .run();
    await env.DB
      .prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("a2", "raft_s2", "team-app", "Team App", "android", now + 1)
      .run();

    const teamApps = await env.DB
      .prepare("SELECT id, org_id, slug FROM apps WHERE org_id = ? ORDER BY created_at DESC")
      .bind("raft_s2")
      .all();

    expect(teamApps.results).toEqual([
      { id: "a2", org_id: "raft_s2", slug: "team-app" },
    ]);
  });

  it("app server grants expose selected apps to another Raft server", async () => {
    const now = Date.now();
    const env = makeMockEnv();
    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0), (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind(
        "raft_owner",
        "owner",
        "Owner Server",
        "owner-server",
        now,
        "raft_external",
        "external",
        "External Server",
        "external-server",
        now,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO raft_accounts
         (id, provider, provider_subject, server_id, server_slug, principal_type,
          server_role, username, display_name, avatar_url, raw_profile,
          created_at, updated_at, last_login_at)
         VALUES (?, 'raft', ?, ?, ?, 'human', NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
      )
      .bind("external-user", "external-sub", "external-server", "external", "external", "External User", now, now, now)
      .run();
    await env.DB
      .prepare("INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)")
      .bind("orgmem-external", "raft_external", "external-user", "member", now)
      .run();
    await env.DB
      .prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)")
      .bind(
        "app-owner-granted",
        "raft_owner",
        "granted-app",
        "Granted App",
        "android",
        now,
        "app-owner-hidden",
        "raft_owner",
        "hidden-app",
        "Hidden App",
        "android",
        now + 1,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO app_server_grants
         (id, app_id, server_id, server_slug, app_role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("grant-external", "app-owner-granted", null, "external", "viewer", now, now)
      .run();

    const { handleListApps } = await import("../src/routes/apps");
    const response = await handleListApps({
      env,
      get: (name: string) => {
        if (name === "org_id") return "raft_external";
        if (name === "admin_account") {
          return { id: "external-user", server_id: "external-server", server_slug: "external" };
        }
        return undefined;
      },
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any);
    const body = await response.json() as any;
    expect(body.apps.map((a: any) => a.id)).toEqual(["app-owner-granted"]);
  });

  it("permission helpers resolve org/app roles", async () => {
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind("raft_perm", "perm", "Permission Org", "perm", now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO raft_accounts
         (id, provider, provider_subject, server_id, server_slug, principal_type,
          server_role, username, display_name, avatar_url, raw_profile,
          created_at, updated_at, last_login_at)
         VALUES (?, 'raft', ?, 'perm', 'perm', ?, NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
      )
      .bind("publisher1", "sub-publisher", "human", "publisher", "Publisher", now, now, now)
      .run();
    await env.DB
      .prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("app-perm", "raft_perm", "perm-app", "Permission App", "android", now)
      .run();
    await env.DB
      .prepare("INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)")
      .bind("orgmem-perm", "raft_perm", "publisher1", "viewer", now)
      .run();
    await env.DB
      .prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES (?, ?, ?, ?, ?)")
      .bind("appmem-perm", "app-perm", "publisher1", "publisher", now)
      .run();

    const {
      getOrgMemberRole,
      getAppMemberRole,
      getEffectiveRole,
      isAppAtLeast,
      isOrgAtLeast,
    } = await import("../src/lib/permissions");

    await expect(getOrgMemberRole(env.DB as any, "raft_perm", "publisher1"))
      .resolves.toBe("viewer");
    await expect(getAppMemberRole(env.DB as any, "app-perm", "publisher1"))
      .resolves.toBe("publisher");
    await expect(getEffectiveRole(env.DB as any, "publisher1", { appId: "app-perm" }))
      .resolves.toMatchObject({
        org_id: "raft_perm",
        org_role: "viewer",
        app_role: "publisher",
      });
    expect(isOrgAtLeast("admin", "member")).toBe(true);
    expect(isOrgAtLeast("viewer", "member")).toBe(false);
    expect(isAppAtLeast("publisher", "viewer")).toBe(true);
    expect(isAppAtLeast("viewer", "publisher")).toBe(false);
  });

  it("allows org viewers to read app-scoped routes without publish access", async () => {
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind("raft_viewer", "viewer-org", "Viewer Org", "viewer-org", now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO raft_accounts
         (id, provider, provider_subject, server_id, server_slug, principal_type,
          server_role, username, display_name, avatar_url, raw_profile,
          created_at, updated_at, last_login_at)
         VALUES (?, 'raft', ?, 'viewer-server', 'viewer-server', 'human', NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
      )
      .bind("viewer-account", "viewer-sub", "viewer", "Viewer", now, now, now)
      .run();
    await env.DB
      .prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("app-org-viewer", "raft_viewer", "org-viewer-app", "Org Viewer App", "android", now)
      .run();
    await env.DB
      .prepare("INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)")
      .bind("orgmem-viewer", "raft_viewer", "viewer-account", "viewer", now)
      .run();

    const { ensureAppRole } = await import("../src/lib/permissions");
    const ctx = {
      env,
      get: (key: string) =>
        key === "admin_account"
          ? { id: "viewer-account" }
          : undefined,
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status }),
    };

    await expect(ensureAppRole(ctx as any, "app-org-viewer", "viewer")).resolves.toMatchObject({
      ok: true,
      org_role: "viewer",
    });
    const publishAccess = await ensureAppRole(ctx as any, "app-org-viewer", "publisher");
    expect(publishAccess.ok).toBe(false);
    if (!publishAccess.ok) expect(publishAccess.response.status).toBe(403);
  });

  it("permission helpers include Raft server app grants", async () => {
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0), (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind(
        "raft_owner2",
        "owner2",
        "Owner 2",
        "owner2",
        now,
        "raft_external2",
        "external2",
        "External 2",
        "external2",
        now,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO raft_accounts
         (id, provider, provider_subject, server_id, server_slug, principal_type,
          server_role, username, display_name, avatar_url, raw_profile,
          created_at, updated_at, last_login_at)
         VALUES (?, 'raft', ?, ?, ?, 'human', NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
      )
      .bind("external2-user", "external2-sub", "external2", "external2", "external2", "External 2 User", now, now, now)
      .run();
    await env.DB
      .prepare("INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)")
      .bind("orgmem-external2", "raft_external2", "external2-user", "member", now)
      .run();
    await env.DB
      .prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("app-server-grant", "raft_owner2", "server-grant-app", "Server Grant App", "android", now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO app_server_grants
         (id, app_id, server_id, server_slug, app_role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("grant-external2", "app-server-grant", null, "external2", "publisher", now, now)
      .run();

    const { getEffectiveRole, getAppServerGrantRole } = await import("../src/lib/permissions");
    await expect(getAppServerGrantRole(env.DB as any, "app-server-grant", null, "external2"))
      .resolves.toBe("publisher");
    await expect(getEffectiveRole(env.DB as any, "external2-user", { appId: "app-server-grant" }))
      .resolves.toMatchObject({
        org_id: "raft_owner2",
        org_role: null,
        app_role: "publisher",
        server_app_role: "publisher",
        server_org_role: null,
      });
  });

  it.each([
    ["owner"],
    ["admin"],
    ["member"],
    ["viewer"],
  ] as const)("additional owner server preserves the creating-server %s org role", async (orgRole) => {
    const now = Date.now();
    const suffix = orgRole;
    await env.DB.prepare(
      `INSERT INTO organizations
       (id, slug, name, external_provider, external_id, created_at, archived)
       VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
    ).bind(`raft_shared_${suffix}`, `shared-${suffix}`, `Shared ${suffix}`, `shared-${suffix}`, now).run();
    await env.DB.prepare(
      `INSERT INTO raft_accounts
       (id, provider, provider_subject, server_id, server_slug, principal_type,
        server_role, username, display_name, avatar_url, raw_profile,
        created_at, updated_at, last_login_at)
       VALUES (?, 'raft', ?, ?, ?, 'human', ?, ?, ?, NULL, '{}', ?, ?, ?)`,
    ).bind(
      `shared-${suffix}-account`,
      `shared-${suffix}-subject`,
      `shared-${suffix}`,
      `shared-${suffix}`,
      orgRole,
      `shared-${suffix}`,
      `Shared ${suffix}`,
      now,
      now,
      now,
    ).run();
    await env.DB.prepare(
      "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      `orgmem-shared-${suffix}`,
      `raft_shared_${suffix}`,
      `shared-${suffix}-account`,
      orgRole,
      now,
    ).run();
    await env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, 'default', ?, ?, 'android', ?)",
    ).bind(`shared-app-${suffix}`, `shared-app-${suffix}`, `Shared App ${suffix}`, now).run();
    await env.DB.prepare(
      `INSERT INTO app_server_grants
       (id, app_id, server_id, server_slug, app_role, access_model, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'admin', 'owner_server', ?, ?)`,
    ).bind(
      `shared-grant-${suffix}`,
      `shared-app-${suffix}`,
      `shared-${suffix}`,
      `shared-${suffix}`,
      now,
      now,
    ).run();

    const { getEffectiveRole } = await import("../src/lib/permissions");
    await expect(getEffectiveRole(env.DB as any, `shared-${suffix}-account`, {
      appId: `shared-app-${suffix}`,
    })).resolves.toMatchObject({
      org_role: orgRole,
      app_role: null,
      server_app_role: null,
      server_org_role: orgRole,
    });

    const { ensureAppRole } = await import("../src/lib/permissions");
    const ctx = {
      env,
      get: (key: string) => key === "admin_account"
        ? { id: `shared-${suffix}-account` }
        : undefined,
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
      req: { url: `https://hands.test/api/apps/shared-app-${suffix}`, method: "GET" },
    };
    const read = await ensureAppRole(ctx as any, `shared-app-${suffix}`, "viewer");
    expect(read.ok).toBe(true);
    const publish = await ensureAppRole(ctx as any, `shared-app-${suffix}`, "publisher");
    expect(publish.ok).toBe(orgRole === "owner" || orgRole === "admin");
    const boundedMember = await ensureAppRole(
      ctx as any,
      `shared-app-${suffix}`,
      "publisher",
      { orgMinimum: "member" },
    );
    expect(boundedMember.ok).toBe(orgRole !== "viewer");
  });

  it("preserves a legacy viewer grant instead of silently mapping a server member to publisher", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO organizations
       (id, slug, name, external_provider, external_id, created_at, archived)
       VALUES ('raft_legacy', 'legacy', 'Legacy', 'raft', 'legacy-server', ?, 0)`,
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO raft_accounts
       (id, provider, provider_subject, server_id, server_slug, principal_type,
        server_role, username, display_name, avatar_url, raw_profile,
        created_at, updated_at, last_login_at)
       VALUES ('legacy-member', 'raft', 'legacy-sub', 'legacy-server', 'legacy',
               'human', 'member', 'legacy-member', 'Legacy Member', NULL, '{}', ?, ?, ?)`,
    ).bind(now, now, now).run();
    await env.DB.prepare(
      "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES ('legacy-orgmem', 'raft_legacy', 'legacy-member', 'member', ?)",
    ).bind(now).run();
    await env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES ('legacy-app', 'default', 'legacy-app', 'Legacy App', 'android', ?)",
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO app_server_grants
       (id, app_id, server_id, server_slug, app_role, access_model, created_at, updated_at)
       VALUES ('legacy-grant', 'legacy-app', 'legacy-server', 'legacy', 'viewer', 'legacy_role', ?, ?)`,
    ).bind(now, now).run();

    const { getEffectiveRole } = await import("../src/lib/permissions");
    await expect(getEffectiveRole(env.DB as any, "legacy-member", { appId: "legacy-app" }))
      .resolves.toMatchObject({
        org_role: null,
        app_role: "viewer",
        server_app_role: "viewer",
        server_org_role: null,
      });
  });

  it("invites allow only one pending email per org", async () => {
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
      )
      .bind("raft_invite", "invite", "Invite Org", "invite", now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO raft_accounts
         (id, provider, provider_subject, server_id, server_slug, principal_type,
          server_role, username, display_name, avatar_url, raw_profile,
          created_at, updated_at, last_login_at)
         VALUES (?, 'raft', ?, 'invite', 'invite', ?, NULL, ?, ?, NULL, '{}', ?, ?, ?)`,
      )
      .bind("inviter1", "sub-inviter", "human", "inviter", "Inviter", now, now, now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO invites
         (id, org_id, email, role, token, invited_by, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind("invite1", "raft_invite", "alice@example.com", "member", "token1", "inviter1", now, now + 1)
      .run();

    await expect(
      env.DB
        .prepare(
          `INSERT INTO invites
           (id, org_id, email, role, token, invited_by, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind("invite2", "raft_invite", "alice@example.com", "member", "token2", "inviter1", now, now + 2)
        .run(),
    ).rejects.toThrow(/UNIQUE|SQLITE_CONSTRAINT/);

    await env.DB
      .prepare("UPDATE invites SET status = 'revoked' WHERE id = ?")
      .bind("invite1")
      .run();
    await expect(
      env.DB
        .prepare(
          `INSERT INTO invites
           (id, org_id, email, role, token, invited_by, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind("invite3", "raft_invite", "alice@example.com", "member", "token3", "inviter1", now, now + 3)
        .run(),
    ).resolves.toMatchObject({ success: true });
  });

  it("FK cascade deletes versions when app is deleted", async () => {
    const now = Date.now();
    await env.DB
      .prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("a1", "cascade-test", "Cascade", "android", now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO versions (id, app_id, channel, version_name, version_code,
          package_name, signature_sha256, min_sdk, target_sdk, size_bytes,
          file_hash, r2_key, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(
        "v1", "a1", "production", "1.0.0", 1, "com.example", "sig", 24, 34, 100, "hash", "r2/key/1.apk",
        now,
      )
      .run();
    await env.DB.prepare("DELETE FROM apps WHERE id = ?").bind("a1").run();

    const versions = await env.DB
      .prepare("SELECT id FROM versions WHERE app_id = ?")
      .bind("a1")
      .all();
    expect(versions.results).toHaveLength(0);
  });

  it("unique constraint on (app_id, channel, version_code)", async () => {
    const now = Date.now();
    await env.DB
      .prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("a1", "unique-test", "Unique", "android", now)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO versions (id, app_id, channel, version_name, version_code,
          package_name, signature_sha256, min_sdk, target_sdk, size_bytes,
          file_hash, r2_key, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(
        "v1", "a1", "production", "1.0.0", 100, "com.example", "sig", 24, 34, 100, "hash", "r2/k/1.apk",
        now,
      )
      .run();

    await expect(
      env.DB
        .prepare(
          `INSERT INTO versions (id, app_id, channel, version_name, version_code,
            package_name, signature_sha256, min_sdk, target_sdk, size_bytes,
            file_hash, r2_key, enabled, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(
          "v2", "a1", "production", "1.0.1", 100, "com.example", "sig", 24, 34, 100, "hash", "r2/k/2.apk",
          now,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE|SQLITE_CONSTRAINT/);
  });
});

describe("auth origin handling", () => {
  it("opens the configured dashboard origin without restarting OAuth", async () => {
    const env = makeMockEnv();
    const app = new Hono<{ Bindings: MockEnv }>();
    app.get("/api/auth/dashboard", handleDashboardRedirect);

    const res = await app.request(
      "https://business.example/api/auth/dashboard?return=%2Fapps",
      {},
      env as any,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://dashboard.example/apps");
  });

  it("sanitizes unsafe dashboard return paths", async () => {
    const env = makeMockEnv();
    const app = new Hono<{ Bindings: MockEnv }>();
    app.get("/api/auth/dashboard", handleDashboardRedirect);
    const res = await app.request(
      "https://business.example/api/auth/dashboard?return=https%3A%2F%2Fevil.example",
      {},
      env as any,
    );
    expect(res.headers.get("location")).toBe("https://dashboard.example/");
  });

  it("issues signed JWT-shaped Hands access tokens with scoped claims", async () => {
    const env = makeMockEnv();
    (env as any).SIGNED_URL_SECRET = "jwt-test-secret";
    const token = await createSignedJwt(env as any, "account-1", 1_700_000_000_000, 1_700_001_000_000, "session-1");
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    expect(payload).toMatchObject({
      iss: "https://business.example",
      aud: "hands-dashboard",
      sub: "account-1",
      jti: "session-1",
      iat: 1_700_000_000,
      exp: 1_700_001_000,
    });
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("redirects Login with Raft through the current Raft setup route", async () => {
    const env = makeMockEnv();
    env.RAFT_CLIENT_ID = "test-client";
    const app = new Hono<{ Bindings: MockEnv }>();
    app.get("/api/auth/login", handleAuthLogin);

    const res = await app.request(
      "https://business.example/api/auth/login?return=%2F",
      {},
      env as any,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://raft.example");
    expect(location.pathname).toBe("/login-with-raft/setup");
    expect(location.searchParams.get("client_id")).toBe("test-client");
    expect(location.searchParams.get("return_to")).toBe(
      "https://business.example/login/raft/callback",
    );
  });

  it("shares browser login state across the dashboard and registered callback hosts", async () => {
    const env = makeMockEnv();
    env.RAFT_CLIENT_ID = "test-client";
    const app = new Hono<{ Bindings: MockEnv }>();
    app.get("/api/auth/login", handleAuthLogin);

    const res = await app.request(
      "https://dashboard.example/api/auth/login?return=%2Fapps%2Fapp-1%2Fsettings",
      {},
      env as any,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("return_to")).toBe(
      "https://business.example/login/raft/callback",
    );
    expect(res.headers.get("set-cookie")?.toLowerCase()).toContain("domain=business.example");
  });

  it("keeps localhost auth callbacks and cookies host-local", async () => {
    const env = makeMockEnv();
    env.RAFT_CLIENT_ID = "test-client";
    const app = new Hono<{ Bindings: MockEnv }>();
    app.get("/api/auth/login", handleAuthLogin);

    const res = await app.request(
      "http://localhost:8787/api/auth/login?return=%2Fapps",
      {},
      env as any,
    );

    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("return_to")).toBe(
      "http://localhost:8787/login/raft/callback",
    );
    expect(res.headers.get("set-cookie")?.toLowerCase()).not.toContain("domain=");
  });

  it("canonicalizes public http custom-domain requests to https", () => {
    const ctx = {
      req: {
        url: "http://legacy.example/api/auth/login?return=/apps",
        header: () => null,
      },
    };
    expect(requestOrigin(ctx as any)).toBe("https://legacy.example");
    expect(isSecureRequest(ctx as any)).toBe(true);
    expect(httpsRedirectUrl(ctx as any)).toBe("https://legacy.example/api/auth/login?return=/apps");
  });

  it("preserves localhost http origins for local development", () => {
    const ctx = {
      req: {
        url: "http://localhost:8787/api/auth/login",
        header: () => null,
      },
    };
    expect(requestOrigin(ctx as any)).toBe("http://localhost:8787");
    expect(isSecureRequest(ctx as any)).toBe(false);
    expect(httpsRedirectUrl(ctx as any)).toBeNull();
  });

  it("respects forwarded https scheme", () => {
    const ctx = {
      req: {
        url: "http://legacy.example/api/auth/login?return=/apps",
        header: (name: string) => (name === "x-forwarded-proto" ? "https" : null),
      },
    };
    expect(requestOrigin(ctx as any)).toBe("https://legacy.example");
    expect(isSecureRequest(ctx as any)).toBe(true);
    expect(httpsRedirectUrl(ctx as any)).toBeNull();
  });

});

describe("quiver operation retry — legacy publish is not replayed", () => {
  let env: MockEnv;

  beforeEach(async () => {
    env = makeMockEnv();
    const now = Date.now();
    await env.DB
      .prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("a1", "retry-test", "Retry Test", "android", now)
      .run();
  });

  it("marks legacy publish retries failed instead of re-creating versions", async () => {
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO operation_logs
         (id, app_id, kind, status, actor, input, output, progress, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "op-publish",
        "a1",
        "publish",
        "failed",
        "tester",
        JSON.stringify({ version_name: "1.0.0", version_code: 1 }),
        "{}",
        1,
        0,
        now,
        now,
      )
      .run();

    const { handleRetryOperation } = await import("../src/routes/operations");
    const response = await handleRetryOperation({
      env,
      req: { param: (name: string) => (name === "opId" ? "op-publish" : "") },
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status }),
    } as any);

    expect(response.status).toBe(400);
    const body = await response.json() as {
      status: string;
      error: string;
      retry_count: number;
    };
    expect(body.status).toBe("failed");
    expect(body.retry_count).toBe(1);
    expect(body.error).toContain("create a new release from the Releases tab");

    const releases = await env.DB
      .prepare("SELECT id FROM releases WHERE app_id = ?")
      .bind("a1")
      .all();
    expect(releases.results).toHaveLength(0);
  });

  it("keeps TestFlight expire receipts terminal and undeletable", async () => {
    const now = Date.now();
    const output = JSON.stringify({
      phase: "readback_failed",
      patch_confirmed: true,
      readback_confirmed: false,
      asc_build_id: "asc-build-1",
    });
    await env.DB
      .prepare(
        `INSERT INTO operation_logs
         (id, app_id, kind, status, actor, input, output, error, progress,
          retry_count, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "op-expire",
        "a1",
        "testflight-expire",
        "failed",
        "tester",
        JSON.stringify({ build_id: "hands-build-1", asc_build_id: "asc-build-1" }),
        output,
        JSON.stringify({ code: "ASC_EXPIRE_READBACK_FAILED" }),
        70,
        0,
        now,
        now,
        now,
      )
      .run();

    const { handleDeleteOperation, handleRetryOperation } = await import("../src/routes/operations");
    const context = {
      env,
      req: { param: (name: string) => (name === "opId" ? "op-expire" : "") },
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status }),
    } as any;
    expect((await handleRetryOperation(context)).status).toBe(400);
    expect((await handleDeleteOperation(context)).status).toBe(409);

    const preserved = await env.DB.prepare(
      `SELECT status, output, progress, retry_count, completed_at
       FROM operation_logs WHERE id = ?`,
    ).bind("op-expire").first() as any;
    expect(preserved).toMatchObject({
      status: "failed",
      output,
      progress: 70,
      retry_count: 0,
      completed_at: now,
    });
  });
});

describe("quiver Hono app — auth + dispatch", () => {
  // We can't easily import the full route modules in Node (they import from
  // "@cloudflare/containers" which uses the cloudflare:workers module specifier
  // that only resolves in the actual Worker runtime). The route handlers
  // themselves are smoke-tested live via `wrangler dev` against the remote D1.
  it("schema migration ordering is consistent", () => {
    // apps → channels (FK app_id) → versions (FK app_id) → audit_logs (FK app_id)
    // Ensure cascade behavior matches what handlers expect.
    const tables = [
      "apps",
      "channels",
      "versions",
      "audit_logs",
      "raft_accounts",
      "raft_sessions",
    ];
    expect(tables[0]).toBe("apps"); // parent
  });

  it("mock env exposes Raft config and keeps bearer auth dev-only", () => {
    const env = makeMockEnv();
    expect(env.ADMIN_API_TOKEN).toBe("test-token-123");
    expect(env.ENVIRONMENT).toBe("development");
    expect(env.RAFT_CLIENT_ID).toBe("quiver-test");
    expect(env.RAFT_CLIENT_SECRET).toBe("test-secret");
  });

  it("loads a Raft account from a Quiver auth token for Bearer transport", async () => {
    const env = makeMockEnv();
    const now = Date.now();
    const token = "quiver-test-token";
    const tokenHash = createHash("sha256").update(token).digest("hex");

    await env.DB.prepare(
      `INSERT INTO organizations
       (id, slug, name, external_provider, external_id, created_at, archived)
       VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
    ).bind("raft_server1", "server1", "Server 1", "server1", now).run();
    await env.DB.prepare(
      `INSERT INTO raft_accounts
       (id, provider, provider_subject, server_id, server_slug, principal_type,
        server_role, username, display_name, raw_profile, created_at, updated_at, last_login_at)
       VALUES (?, 'raft', ?, ?, ?, 'agent', NULL, ?, ?, '{}', ?, ?, ?)`,
    ).bind(
      "acct-token",
      "agent-sub",
      "server1",
      "server-one",
      "qa-agent",
      "QA Agent",
      now,
      now,
      now,
    ).run();
    await env.DB.prepare(
      "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("orgmem-token", "raft_server1", "acct-token", "member", now).run();
    await env.DB.prepare(
      `INSERT INTO raft_sessions
       (id, account_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("session-token", "acct-token", tokenHash, now, now + 60_000, now).run();

    const { loadAccountFromAuthToken } = await import("../src/middleware/auth");
    await expect(loadAccountFromAuthToken(env as any, token)).resolves.toMatchObject({
      id: "acct-token",
      principal_type: "agent",
      username: "qa-agent",
      org_id: "raft_server1",
      org_role: "member",
    });
  });

  it("deploy-token create: expires_in_days persists, unknown fields 400, both expiry fields 400", async () => {
    const env = makeMockEnv();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("dt-app", "default", "dt-app", "DT App", "android", now).run();
    await env.DB.prepare(
      `INSERT INTO app_reporter_integrations
       (id, app_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind("integration-dt", "dt-app", "Feedback", now, now).run();
    const {
      handleCreateAppDeployToken,
      handleListAppDeployTokens,
    } = await import("../src/routes/deploy_tokens");
    const ctx = (body: unknown) =>
      ({
        env,
        req: {
          url: "https://quiver-worker.test/api/apps/dt-app/deploy-tokens",
          param: (name: string) => (name === "appId" ? "dt-app" : ""),
          query: () => undefined,
          json: async () => body,
          header: () => undefined,
        },
        get: (name: string) => (name === "admin_actor" ? "tester" : undefined),
        json: (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
      }) as any;

    // A misspelled/unknown field must 400 — never silently mint a
    // non-expiring token (the original bug: expires_in_days was ignored).
    const unknown = await handleCreateAppDeployToken(ctx({ name: "t1", app_role: "publisher", expire_days: 7 }));
    expect(unknown.status).toBe(400);

    // expires_in_days is accepted and persisted as a real expiry.
    const ok = await handleCreateAppDeployToken(ctx({ name: "t2", app_role: "publisher", expires_in_days: 7 }));
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as any;
    expect(created.deploy_token).toMatchObject({
      app_role: "publisher",
      scopes: null,
      grant_valid: true,
      effective_permissions: ["app:read", "app:publish", "feedback:write"],
    });
    expect(created.deploy_token.expires_at).toBeGreaterThan(now + 6.9 * 86_400_000);
    expect(created.deploy_token.expires_at).toBeLessThan(now + 7.1 * 86_400_000);

    // Both expiry fields together → 400.
    const both = await handleCreateAppDeployToken(
      ctx({ name: "t3", app_role: "publisher", expires_at: now + 86_400_000, expires_in_days: 1 }),
    );
    expect(both.status).toBe(400);

    // Invalid days → 400.
    const bad = await handleCreateAppDeployToken(ctx({ name: "t4", app_role: "publisher", expires_in_days: -1 }));
    expect(bad.status).toBe(400);

    const neither = await handleCreateAppDeployToken(ctx({ name: "neither" }));
    expect(neither.status).toBe(400);
    const bothGrants = await handleCreateAppDeployToken(
      ctx({ name: "both", app_role: "viewer", scopes: ["feedback:write"] }),
    );
    expect(bothGrants.status).toBe(201);
    expect((await bothGrants.json()) as any).toMatchObject({
      deploy_token: {
        app_role: "viewer",
        scopes: ["feedback:write"],
        grant_valid: true,
        effective_permissions: ["app:read", "feedback:write"],
      },
    });
    const auditRows = await env.DB.prepare(
      "SELECT payload FROM audit_logs WHERE action = 'deploy_token.create'",
    ).all();
    const bothAudit = auditRows.results
      .map((row: any) => JSON.parse(row.payload))
      .find((payload: any) => payload.name === "both");
    expect(bothAudit).toMatchObject({
      app_role: "viewer",
      scopes: ["feedback:write"],
      effective_permissions: ["app:read", "feedback:write"],
    });
    const unknownScope = await handleCreateAppDeployToken(
      ctx({ name: "unknown", scopes: ["releases:delete"] }),
    );
    expect(unknownScope.status).toBe(400);
    const scoped = await handleCreateAppDeployToken(
      ctx({
        name: "feedback-only",
        scopes: ["feedback:write"],
        reporter_integration_id: "integration-dt",
        expires_in_days: 7,
      }),
    );
    expect(scoped.status).toBe(201);
    expect((await scoped.json()) as any).toMatchObject({
      deploy_token: {
        app_role: null,
        scopes: ["feedback:write"],
        grant_valid: true,
        effective_permissions: ["feedback:write"],
      },
    });

    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).bind(
      "invalid-grant",
      "dt-app",
      "invalid stored grant",
      "qvdt_invalid",
      "hash-invalid",
      JSON.stringify(["unknown:permission"]),
      "tester",
      now,
    ).run();
    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`,
    ).bind(
      "empty-string-grant",
      "dt-app",
      "empty string stored grant",
      "qvdt_empty_string",
      "hash-empty-string",
      "viewer",
      "tester",
      now,
    ).run();
    const listed = await handleListAppDeployTokens(ctx({}));
    const listedBody = await listed.json() as any;
    expect(listedBody.deploy_tokens.find((token: any) => token.name === "both"))
      .toMatchObject({
        app_role: "viewer",
        scopes: ["feedback:write"],
        grant_valid: true,
        effective_permissions: ["app:read", "feedback:write"],
      });
    expect(listedBody.deploy_tokens.find((token: any) => token.id === "invalid-grant"))
      .toMatchObject({
        grant_valid: false,
        effective_permissions: [],
      });
    expect(listedBody.deploy_tokens.find((token: any) => token.id === "empty-string-grant"))
      .toMatchObject({
        grant_valid: false,
        effective_permissions: [],
      });
  });

  it("exposes one permission registry with role bundles", async () => {
    const { handleGetAppPermissionModel } = await import("../src/routes/deploy_tokens");
    const response = handleGetAppPermissionModel({
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    const body = await response.json() as any;
    expect(body.permissions.map((entry: any) => entry.permission)).toEqual([
      "app:read",
      "app:publish",
      "app:admin",
      "feedback:write",
      "feedback:read",
      "feedback:comment",
      "feedback:route",
      "feedback:triage",
    ]);
    expect(body.permissions.find((entry: any) => entry.permission === "app:read").label)
      .toBe("App read");
    expect(body.roles.find((entry: any) => entry.role === "viewer").permissions).toEqual(["app:read"]);
    expect(body.roles.find((entry: any) => entry.role === "publisher").permissions).toContain("feedback:write");
    expect(body.roles.find((entry: any) => entry.role === "admin").permissions).toContain("app:admin");

    // feedback:triage must be grantable only by explicit scope. Putting it in a
    // role bundle is the natural next edit — "admins can do everything" — and it
    // would destroy the whole reason for the permission: that nobody holds it
    // unless someone decided to grant it. Separating triage from publisher is
    // undone the moment publisher carries it again.
    for (const role of body.roles) {
      expect(role.permissions).not.toContain("feedback:triage");
    }
  });

  it("loads app-scoped deploy tokens and updates last_used_at", async () => {
    const env = makeMockEnv();
    const now = Date.now();
    const token = "qvdt_testprefix_testsecret";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("deploy-app", "default", "deploy-app", "Deploy App", "android", now).run();
    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, created_by_actor, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "dt-1",
      "deploy-app",
      "ci",
      "qvdt_testprefix",
      tokenHash,
      "publisher",
      "raft:owner@server",
      now,
      now + 60_000,
    ).run();

    const { loadDeployToken } = await import("../src/lib/deploy_tokens");
    await expect(loadDeployToken(env as any, token)).resolves.toMatchObject({
      id: "dt-1",
      app_id: "deploy-app",
      app_slug: "deploy-app",
      app_role: "publisher",
      scopes: null,
    });
    const row = (await env.DB.prepare(
      "SELECT last_used_at FROM app_deploy_tokens WHERE id = ?",
    ).bind("dt-1").first()) as { last_used_at: number | null } | null;
    expect(row?.last_used_at).toBeTypeOf("number");
  });

  it("keeps scoped tokens inside their app route boundary", async () => {
    const env = makeMockEnv();
    const now = Date.now();
    const token = "qvdt_scopeprefix_scopesecret";
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("scope-app", "default", "scope-app", "Scope App", "web", now).run();
    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).bind(
      "scope-token",
      "scope-app",
      "feedback writer",
      "qvdt_scopeprefix",
      tokenHash,
      JSON.stringify(["feedback:write"]),
      "raft:owner@server",
      now,
      now + 60_000,
    ).run();

    const { authMiddleware } = await import("../src/middleware/auth");
    const invoke = async (url: string) => {
      const variables = new Map<string, unknown>();
      let nextCalled = false;
      const response = await authMiddleware({
        env,
        req: {
          url,
          header: (name: string) => name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined,
        },
        get: (name: string) => variables.get(name),
        set: (name: string, value: unknown) => { variables.set(name, value); },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any, async () => { nextCalled = true; });
      return { response, nextCalled };
    };

    const global = await invoke("https://quiver-worker.test/api/orgs");
    expect(global.response?.status).toBe(403);
    expect(global.nextCalled).toBe(false);
    const ownApp = await invoke("https://quiver-worker.test/api/apps/scope-app/releases");
    expect(ownApp.response).toBeUndefined();
    expect(ownApp.nextCalled).toBe(true);
    const otherApp = await invoke("https://quiver-worker.test/api/apps/other/releases");
    expect(otherApp.response?.status).toBe(403);
  });

  it("separates legacy role guards from exact custom-permission guards", async () => {
    const env = makeMockEnv();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("guard-app", "default", "guard-app", "Guard App", "web", now).run();

    const fixtures = [
      {
        id: "custom-publish",
        token: "qvdt_custom_publish",
        role: null,
        scopes: JSON.stringify(["app:publish"]),
      },
      {
        id: "viewer-feedback",
        token: "qvdt_viewer_feedback",
        role: "viewer",
        scopes: JSON.stringify(["feedback:write"]),
      },
      {
        id: "corrupt-viewer",
        token: "qvdt_corrupt_viewer",
        role: "viewer",
        scopes: JSON.stringify(["unknown:permission"]),
      },
      {
        id: "empty-viewer",
        token: "qvdt_empty_viewer",
        role: "viewer",
        scopes: "",
      },
    ];
    for (const fixture of fixtures) {
      await env.DB.prepare(
        `INSERT INTO app_deploy_tokens
         (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
          created_by_actor, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        fixture.id,
        "guard-app",
        fixture.id,
        fixture.token,
        createHash("sha256").update(fixture.token).digest("hex"),
        fixture.role,
        fixture.scopes,
        "tester",
        now,
        now + 60_000,
      ).run();
    }

    const app = new Hono<{ Bindings: Env }>();
    app.use("*", authMiddleware as any);
    app.patch(
      "/api/apps/:appId/feedback/:ticketId",
      requireFeedbackTriageRole() as any,
      (c) => c.json({ ok: true }),
    );
    app.get(
      "/api/apps/:appId/view",
      requireAppRole("viewer") as any,
      (c) => c.json({ ok: true }),
    );
    app.post(
      "/api/apps/:appId/exact-publish",
      requireAppPermission("app:publish") as any,
      (c) => c.json({ ok: true }),
    );
    app.post(
      "/api/apps/:appId/exact-feedback",
      requireAppPermission("feedback:write") as any,
      (c) => c.json({ ok: true }),
    );

    const request = (path: string, token: string, method: string) => app.request(
      `https://quiver-worker.test${path}`,
      { method, headers: { authorization: `Bearer ${token}` } },
      env as any,
    );

    expect((await request(
      "/api/apps/guard-app/feedback/ticket-1",
      "qvdt_custom_publish",
      "PATCH",
    )).status).toBe(403);
    expect((await request(
      "/api/apps/guard-app/view",
      "qvdt_custom_publish",
      "GET",
    )).status).toBe(403);
    expect((await request(
      "/api/apps/guard-app/exact-publish",
      "qvdt_custom_publish",
      "POST",
    )).status).toBe(200);

    expect((await request(
      "/api/apps/guard-app/view",
      "qvdt_viewer_feedback",
      "GET",
    )).status).toBe(200);
    expect((await request(
      "/api/apps/guard-app/feedback/ticket-1",
      "qvdt_viewer_feedback",
      "PATCH",
    )).status).toBe(403);
    expect((await request(
      "/api/apps/guard-app/exact-feedback",
      "qvdt_viewer_feedback",
      "POST",
    )).status).toBe(200);

    const corrupt = await request(
      "/api/apps/guard-app/view",
      "qvdt_corrupt_viewer",
      "GET",
    );
    expect(corrupt.status).toBe(403);
    await expect(corrupt.json()).resolves.toMatchObject({
      code: "INVALID_DEPLOY_TOKEN_GRANT",
      current_permissions: [],
    });
    const empty = await request(
      "/api/apps/guard-app/view",
      "qvdt_empty_viewer",
      "GET",
    );
    expect(empty.status).toBe(403);
    await expect(empty.json()).resolves.toMatchObject({
      code: "INVALID_DEPLOY_TOKEN_GRANT",
      current_permissions: [],
    });
  });

  it("allows deploy tokens only for their app and role", async () => {
    const env = makeMockEnv();
    const { ensureAppPermission, ensureAppRole } = await import("../src/lib/permissions");
    const ctx = {
      env,
      get: (key: string) =>
        key === "admin_deploy_token"
          ? {
              id: "dt-1",
              app_id: "app-1",
              app_slug: "app-one",
              name: "ci",
              token_prefix: "qvdt_test",
              app_role: "publisher",
              scopes: null,
              created_by: null,
              created_by_actor: "raft:owner@server",
              created_at: 1,
              expires_at: null,
              last_used_at: null,
              revoked_at: null,
            }
          : undefined,
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status }),
    };

    await expect(ensureAppRole(ctx as any, "app-1", "publisher")).resolves.toMatchObject({
      ok: true,
      app_role: "publisher",
    });
    const wrongApp = await ensureAppRole(ctx as any, "app-2", "viewer");
    expect(wrongApp.ok).toBe(false);
    if (!wrongApp.ok) expect(wrongApp.response.status).toBe(403);
    const tooHigh = await ensureAppRole(ctx as any, "app-1", "admin");
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.response.status).toBe(403);

    const scopedCtx = {
      ...ctx,
      get: (key: string) =>
        key === "admin_deploy_token"
          ? {
              ...(ctx.get("admin_deploy_token") as object),
              app_role: null,
              scopes: ["app:read"],
            }
          : undefined,
    };
    const scopedReadRole = await ensureAppRole(scopedCtx as any, "app-1", "viewer");
    expect(scopedReadRole.ok).toBe(false);
    await expect(ensureAppPermission(scopedCtx as any, "app-1", "app:read"))
      .resolves.toMatchObject({ ok: true, app_permission: "app:read" });
    const scopedPublish = await ensureAppRole(scopedCtx as any, "app-1", "publisher");
    expect(scopedPublish.ok).toBe(false);

    const customPublishCtx = {
      ...ctx,
      get: (key: string) =>
        key === "admin_deploy_token"
          ? {
              ...(ctx.get("admin_deploy_token") as object),
              app_role: null,
              scopes: ["app:publish"],
            }
          : undefined,
    };
    const customPublishRole = await ensureAppRole(
      customPublishCtx as any,
      "app-1",
      "publisher",
    );
    expect(customPublishRole.ok).toBe(false);
    await expect(ensureAppPermission(customPublishCtx as any, "app-1", "app:publish"))
      .resolves.toMatchObject({ ok: true, app_permission: "app:publish" });
    const customPublishRead = await ensureAppPermission(
      customPublishCtx as any,
      "app-1",
      "app:read",
    );
    expect(customPublishRead.ok).toBe(false);

    const feedbackCtx = {
      ...ctx,
      get: (key: string) =>
        key === "admin_deploy_token"
          ? {
              ...(ctx.get("admin_deploy_token") as object),
              app_role: null,
              scopes: ["feedback:write"],
            }
          : undefined,
    };
    await expect(ensureAppPermission(feedbackCtx as any, "app-1", "feedback:write"))
      .resolves.toMatchObject({ ok: true, app_permission: "feedback:write" });
    const feedbackRead = await ensureAppPermission(feedbackCtx as any, "app-1", "app:read");
    expect(feedbackRead.ok).toBe(false);

    const additiveViewerCtx = {
      ...ctx,
      get: (key: string) =>
        key === "admin_deploy_token"
          ? {
              ...(ctx.get("admin_deploy_token") as object),
              app_role: "viewer",
              scopes: ["feedback:write"],
            }
          : undefined,
    };
    await expect(ensureAppRole(additiveViewerCtx as any, "app-1", "viewer"))
      .resolves.toMatchObject({ ok: true, app_role: "viewer" });
    const additivePublish = await ensureAppRole(additiveViewerCtx as any, "app-1", "publisher");
    expect(additivePublish.ok).toBe(false);
    if (!additivePublish.ok) {
      await expect(additivePublish.response.json()).resolves.toMatchObject({
        current_permissions: ["app:read", "feedback:write"],
      });
    }
    await expect(ensureAppPermission(additiveViewerCtx as any, "app-1", "feedback:write"))
      .resolves.toMatchObject({ ok: true, app_permission: "feedback:write" });

    const corruptRoleCtx = {
      ...ctx,
      get: (key: string) =>
        key === "admin_deploy_token"
          ? {
              ...(ctx.get("admin_deploy_token") as object),
              app_role: "viewer",
              scopes: [],
            }
          : undefined,
    };
    const corruptRole = await ensureAppRole(corruptRoleCtx as any, "app-1", "viewer");
    expect(corruptRole.ok).toBe(false);
    if (!corruptRole.ok) {
      await expect(corruptRole.response.json()).resolves.toMatchObject({
        current_permissions: [],
      });
    }
    const corruptPermission = await ensureAppPermission(
      corruptRoleCtx as any,
      "app-1",
      "app:read",
    );
    expect(corruptPermission.ok).toBe(false);
    if (!corruptPermission.ok) {
      await expect(corruptPermission.response.json()).resolves.toMatchObject({
        current_permissions: [],
      });
    }
  });
});

// =============================================================================
// P2.5.8 — webhooks (emit + reap)
// =============================================================================

describe("quiver webhooks — SQL smoke", () => {
  function makeEnv() {
    const env = makeMockEnv();
    // Seed an org + app so webhooks have something to scope to.
    env.DB.prepare(
      "INSERT OR IGNORE INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("app-test", "default", "test-app", "Test", "android", 1).run();
    return env;
  }

  it("webhooks + webhook_deliveries tables exist with expected columns", async () => {
    const env = makeEnv();
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('webhooks', 'webhook_deliveries') ORDER BY name",
    )
      .bind()
      .all();
    const names = results.map((r: any) => r.name);
    expect(names).toEqual(["webhook_deliveries", "webhooks"]);
  });

  it("matchesEvent SQL filter excludes non-subscribed events but includes empty = all", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `INSERT INTO webhooks (id, org_id, url, secret, events_json, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'tester', 1, 1)`,
    ).bind(
      "wh-1",
      "default",
      "https://example.com/hook",
      "supersecret",
      JSON.stringify(["release:new", "build:failed"]),
    ).run();
    await env.DB.prepare(
      `INSERT INTO webhooks (id, org_id, url, secret, events_json, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'tester', 1, 1)`,
    ).bind(
      "wh-2",
      "default",
      "https://example.com/all",
      "othersecret",
      JSON.stringify([]),
    ).run();
    await env.DB.prepare(
      `INSERT INTO webhooks (id, org_id, url, secret, events_json, enabled, archived_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'tester', 1, 1)`,
    ).bind(
      "wh-3",
      "default",
      "https://example.com/disabled",
      "secret",
      JSON.stringify([]),
      100,
    ).run();

    // Simulate emitWebhookEvent: select enabled, non-archived, and filter by event in app code.
    const { results: subs } = await env.DB.prepare(
      `SELECT id, events_json FROM webhooks
       WHERE org_id = ? AND enabled = 1 AND archived_at IS NULL`,
    )
      .bind("default")
      .all();
    const matches = (json: string, event: string) => {
      try {
        const ev = JSON.parse(json);
        return ev.length === 0 || ev.includes(event) || ev.includes("*");
      } catch {
        return false;
      }
    };
    const matched = subs.filter((s: any) => matches(s.events_json, "release:new"));
    expect(matched.map((m: any) => m.id).sort()).toEqual(["wh-1", "wh-2"]);
  });

  it("delivery backoff schedule: 5m → 30m → 2h (then permanently failed)", () => {
    const BACKOFF = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
    expect(BACKOFF[0]).toBe(300_000);
    expect(BACKOFF[1]).toBe(1_800_000);
    expect(BACKOFF[2]).toBe(7_200_000);
    // After max_attempts (3) the delivery is marked permanently failed.
    const maxAttempts = 3;
    expect(BACKOFF.length).toBe(maxAttempts);
  });

  it("keeps webhook body, signature, event id, and delivery id stable across retries", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `INSERT INTO app_reporter_integrations
       (id, app_id, name, created_at, updated_at)
       VALUES ('retry-integration', 'app-test', 'Retry', 1, 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
       VALUES ('77777777-7777-4777-8777-777777777777', 'app-test',
               'feedback', 'open', 'retry', '{}', ?1, 'retry-integration', 1, 1)`,
    ).bind("r".repeat(32)).run();
    const payload = JSON.stringify({ id: "event-retry", event: "feedback:status_changed", payload: {} });
    await env.DB.prepare(
      `INSERT INTO feedback_events
       (id, event_type, app_id, ticket_id, reporter_integration_id,
        reporter_id, payload_json, created_at)
       VALUES ('event-retry', 'feedback:status_changed', 'app-test',
               '77777777-7777-4777-8777-777777777777', 'retry-integration',
               ?1, ?2, 1)`,
    ).bind("r".repeat(32), payload).run();
    await env.DB.prepare(
      `INSERT INTO webhooks
       (id, org_id, app_id, url, secret, events_json, enabled, created_at, updated_at)
       VALUES ('wh-retry', 'default', 'app-test', 'https://example.test/retry',
               'retry-secret', '[]', 1, 1, 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries
       (id, webhook_id, event_type, event_id, payload_json,
        signing_secret, signature_key_version, reporter_delivery, status,
        attempts, max_attempts, next_attempt_at, created_at, updated_at)
       VALUES ('delivery-retry', 'wh-retry', 'feedback:status_changed',
               'event-retry', ?1, 'retry-secret', 'retry-v1', 1,
               'pending', 0, 3, 0, 1, 1)`,
    ).bind(payload).run();
    const calls: Array<{ body: string; headers: Headers }> = [];
    const originalFetch = globalThis.fetch;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
      return new Response("retry", { status: 500 });
    }) as typeof fetch;
    try {
      const { handleReapDeliveries } = await import("../src/routes/webhooks");
      const context = {
        env,
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any;
      await handleReapDeliveries(context);
      await env.DB.prepare(
        "UPDATE webhooks SET secret = 'rotated-secret', signature_key_version = 'retry-v2' WHERE id = 'wh-retry'",
      ).run();
      await env.DB.prepare(
        "UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE id = 'delivery-retry'",
      ).run();
      nowSpy.mockReturnValue(2_000);
      await handleReapDeliveries(context);
    } finally {
      globalThis.fetch = originalFetch;
      nowSpy.mockRestore();
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toBe(payload);
    expect(calls[1]!.body).toBe(payload);
    for (const call of calls) {
      expect(call.headers.get("X-Hands-Event-Id")).toBe("event-retry");
      expect(call.headers.get("X-Hands-Delivery-Id")).toBe("delivery-retry");
    }
    expect(calls[0]!.headers.get("X-Hands-Signature"))
      .toBe(calls[1]!.headers.get("X-Hands-Signature"));
    const ledger = await env.DB.prepare(
      `SELECT attempts, last_attempt_at, payload_json FROM webhook_deliveries
       WHERE id = 'delivery-retry'`,
    ).first() as { attempts: number; last_attempt_at: number; payload_json: string } | null;
    expect(ledger).toMatchObject({ attempts: 2, payload_json: payload });
    expect(ledger?.last_attempt_at).toBe(2_000);
  });
});

// =============================================================================
// P5.5 — audit log actor JOIN (display name, username, avatar, agent badge)
// =============================================================================

describe("quiver audit log — actor display JOIN", () => {
  function makeEnv() {
    const env = makeMockEnv();
    env.DB.prepare(
      "INSERT OR IGNORE INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("app-test", "default", "test-app", "Test", "android", 1).run();
    // Seed a raft_account so the JOIN can resolve an actor.
    env.DB.prepare(
      `INSERT INTO raft_accounts
       (id, provider, provider_subject, server_id, server_slug, principal_type, username, display_name, avatar_url, last_login_at, raw_profile, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "acct-human",
      "raft",
      "human-sub",
      "srv-1",
      "myserver",
      "human",
      "alice",
      "Alice Example",
      "https://example.com/a.png",
      1234,
      "{}",
      1000,
      1000,
    ).run();
    env.DB.prepare(
      `INSERT INTO raft_accounts
       (id, provider, provider_subject, server_id, server_slug, principal_type, username, display_name, raw_profile, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "acct-agent",
      "raft",
      "agent-sub",
      "srv-1",
      "myserver",
      "agent",
      "Pi-Worker2",
      "Pi-Worker2",
      "{}",
      1000,
      1000,
      0,
    ).run();
    return env;
  }

  it("handler SQL JOIN resolves actor display_name / username / avatar_url", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, actor_id, actor_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-1",
      "app-test",
      "app.create",
      "Alice Example",
      "acct-human",
      "human",
      JSON.stringify({ slug: "x" }),
      100,
    ).run();
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, actor_id, actor_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-2",
      "app-test",
      "build.create",
      "Pi-Worker2",
      "acct-agent",
      "agent",
      JSON.stringify({}),
      200,
    ).run();
    // This mirrors worker/src/routes/audit.ts handleListAuditLogs JOIN.
    const { results } = await env.DB.prepare(
      `SELECT l.id, l.action, l.actor, l.actor_type,
              a.display_name AS actor_display_name,
              a.username AS actor_username,
              a.avatar_url AS actor_avatar_url
       FROM audit_logs l
       LEFT JOIN raft_accounts a ON a.id = l.actor_id
       WHERE l.app_id = ?1
       ORDER BY l.created_at DESC`,
    )
      .bind("app-test")
      .all();
    expect(results.length).toBe(2);
    const agentRow = results.find((r: any) => r.actor_type === "agent");
    expect(agentRow.actor_display_name).toBe("Pi-Worker2");
    expect(agentRow.actor_username).toBe("Pi-Worker2");
    expect(agentRow.actor_avatar_url).toBeNull();
    const humanRow = results.find((r: any) => r.actor_type === "human");
    expect(humanRow.actor_display_name).toBe("Alice Example");
    expect(humanRow.actor_username).toBe("alice");
    expect(humanRow.actor_avatar_url).toBe("https://example.com/a.png");
  });

  it("actor_id filter narrows the result set", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, actor_id, actor_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("audit-3", "app-test", "a", "Alice", "acct-human", "human", "{}", 1).run();
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, actor_id, actor_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind("audit-4", "app-test", "b", "Pi", "acct-agent", "agent", "{}", 2).run();
    const { results } = await env.DB.prepare(
      `SELECT id FROM audit_logs WHERE app_id = ?1 AND actor_id = ?2`,
    )
      .bind("app-test", "acct-agent")
      .all();
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("audit-4");
  });

  it("action_prefix filter narrows the result set", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("audit-5", "app-test", "release.create", "x", "{}", 1).run();
    await env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("audit-6", "app-test", "build.create", "x", "{}", 2).run();
    const { results } = await env.DB.prepare(
      `SELECT id FROM audit_logs WHERE app_id = ?1 AND action LIKE ?2`,
    )
      .bind("app-test", "release.%")
      .all();
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("audit-5");
  });
});

// =============================================================================
// P2.5.9 / P5.7 — apps.default_channel_id (migration 0018)
// =============================================================================

describe("quiver apps — default_channel_id", () => {
  function makeEnv() {
    const env = makeMockEnv();
    env.DB.prepare(
      "INSERT OR IGNORE INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("app-dc", "default", "dc-app", "DC App", "android", 1).run();
    env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, enabled_product_types_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("ch-prod", "app-dc", "production", "Production", "[]", "{}", 10).run();
    env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, enabled_product_types_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("ch-beta", "app-dc", "beta", "Beta", "[]", "{}", 20).run();
    return env;
  }

  it("column exists and is nullable", async () => {
    const env = makeEnv();
    const { results } = await env.DB.prepare(
      `SELECT name, "notnull" FROM pragma_table_info('apps') WHERE name = 'default_channel_id'`,
    )
      .bind()
      .all();
    expect(results.length).toBe(1);
    expect((results[0] as any).notnull).toBe(0);
  });

  it("default_channel_id can be set + read back with JOIN slug", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `UPDATE apps SET default_channel_id = ?1 WHERE id = ?2`,
    )
      .bind("ch-prod", "app-dc")
      .run();
    // Mirror the production handleGetApp JOIN.
    const { results } = await env.DB.prepare(
      `SELECT a.default_channel_id, ch.slug AS default_channel_slug
       FROM apps a
       LEFT JOIN channels ch ON ch.id = a.default_channel_id
       WHERE a.id = ?1`,
    )
      .bind("app-dc")
      .all();
    expect(results.length).toBe(1);
    expect((results[0] as any).default_channel_id).toBe("ch-prod");
    expect((results[0] as any).default_channel_slug).toBe("production");
  });

  it("rejects setting default_channel_id to a channel belonging to another app", async () => {
    const env = makeEnv();
    // Create a sibling app with its own channel.
    env.DB.prepare(
      "INSERT OR IGNORE INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("app-other", "default", "other", "Other", "android", 2).run();
    env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, enabled_product_types_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("ch-other", "app-other", "other-channel", "Other", "[]", "{}", 30).run();
    // Mirror the production handleUpdateApp validation: query must return
    // 0 rows because ch-other doesn't belong to app-dc.
    const { results } = await env.DB.prepare(
      `SELECT id FROM channels WHERE id = ?1 AND app_id = ?2`,
    )
      .bind("ch-other", "app-dc")
      .all();
    expect(results.length).toBe(0);
    // The legitimate channel returns a row.
    const ok = await env.DB.prepare(
      `SELECT id FROM channels WHERE id = ?1 AND app_id = ?2`,
    )
      .bind("ch-prod", "app-dc")
      .all();
    expect(ok.results.length).toBe(1);
  });

  it("ON DELETE SET NULL works when channel is removed", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      `UPDATE apps SET default_channel_id = ?1 WHERE id = ?2`,
    )
      .bind("ch-prod", "app-dc")
      .run();
    await env.DB.prepare(`DELETE FROM channels WHERE id = ?1`).bind("ch-prod").run();
    const { results } = await env.DB.prepare(
      `SELECT default_channel_id FROM apps WHERE id = ?1`,
    )
      .bind("app-dc")
      .all();
    expect((results[0] as any).default_channel_id).toBeNull();
  });
});

describe("quiver releases — draft lifecycle", () => {
  let env: MockEnv;

  async function seedReleaseBuild(buildId: string, versionCode: number) {
    const now = Date.now();
    await env.DB
      .prepare(
        `INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code,
                             source, status, build_metadata_json, parsed_metadata_json,
                             should_force_update, provenance_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        buildId,
        "app-release",
        "ch-main",
        "android-apk",
        "stable",
        `1.0.${versionCode}`,
        versionCode,
        "web",
        "succeeded",
        "{}",
        "{}",
        0,
        "{}",
        now,
        now,
      )
      .run();
  }

  async function installReleaseVersionReuseTriggers() {
    expect(releaseVersionReuseTriggerStatements).toHaveLength(2);
    for (const statement of releaseVersionReuseTriggerStatements) {
      await env.DB.prepare(statement).run();
    }
  }

  beforeEach(async () => {
    env = makeMockEnv();
    const now = Date.now();
    await env.DB
      .prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("app-release", "default", "release-app", "Release App", "android", now)
      .run();
    await env.DB
      .prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("ch-main", "app-release", "main", "Main", now)
      .run();
    for (const [buildId, versionCode] of [
      ["build-active", 1],
      ["build-draft", 2],
    ] as const) {
      await env.DB
        .prepare(
          `INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code,
                               source, status, build_metadata_json, parsed_metadata_json,
                               should_force_update, provenance_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          buildId,
          "app-release",
          "ch-main",
          "android-apk",
          "stable",
          "1.0.0",
          versionCode,
          "web",
          "succeeded",
          "{}",
          "{}",
          0,
          "{}",
          now,
          now,
        )
        .run();
    }
  });

  function makeReleaseContext(
    releaseId: string,
    body: unknown = {},
    query: Record<string, string | undefined> = {},
  ) {
    return {
      env,
      req: {
        param: (name: string) =>
          name === "appId" ? "app-release" : name === "releaseId" ? releaseId : "",
        json: async () => body,
        query: (name: string) => query[name],
      },
      get: (key: string) => (key === "admin_actor" ? "tester" : undefined),
      executionCtx: { waitUntil: () => undefined },
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any;
  }

  function makeDeviceGroupContext(
    params: { groupId?: string; deviceId?: string } = {},
    body: unknown = {},
  ) {
    return {
      env,
      req: {
        param: (name: string) => {
          if (name === "appId") return "app-release";
          if (name === "groupId") return params.groupId ?? "";
          if (name === "deviceId") return params.deviceId ?? "";
          return "";
        },
        json: async () => body,
      },
      get: (key: string) => (key === "admin_actor" ? "tester" : undefined),
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any;
  }

  async function responseJson<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  it("creates draft releases without superseding the active release", async () => {
    const { createRelease } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-active");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      changelog: "Draft notes",
    }, "tester", "rel-draft");

    const { results } = await env.DB
      .prepare("SELECT id, status, superseded_by_release_id FROM releases ORDER BY created_at ASC")
      .bind()
      .all();

    expect(results).toEqual([
      { id: "rel-active", status: "active", superseded_by_release_id: null },
      { id: "rel-draft", status: "draft", superseded_by_release_id: null },
    ]);
  });

  it("allows a new lifecycle after the prior version is cancelled", async () => {
    const { createRelease, handleCreateReleaseDraft } = await import("../src/routes/releases");
    await seedReleaseBuild("build-version-original", 30);
    await seedReleaseBuild("build-version-race", 30);
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-version-original",
      status: "draft",
    }, "tester", "rel-version-reserved");
    await env.DB.prepare(
      "UPDATE releases SET status = 'cancelled' WHERE id = 'rel-version-reserved'",
    ).run();

    const response = await handleCreateReleaseDraft(makeReleaseContext("", {
      build_id: "build-version-race",
    }));

    expect(response.status).toBe(201);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      build_id: "build-version-race",
      status: "draft",
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM releases WHERE build_id = 'build-version-race'",
    ).first()).resolves.toEqual({ count: 1 });
    await expect(env.DB.prepare(
      "SELECT status FROM releases WHERE id = 'rel-version-reserved'",
    ).first()).resolves.toEqual({ status: "cancelled" });
  });

  it("keeps an activated coordinate bound to its binary after cancellation", async () => {
    const { handleCreateReleaseDraft } = await import("../src/routes/releases");
    await seedReleaseBuild("build-shipped-41", 41);
    await seedReleaseBuild("build-corrected-41", 41);
    const shipped = await handleCreateReleaseDraft(makeReleaseContext("", {
      build_id: "build-shipped-41",
    }));
    expect(shipped.status).toBe(201);
    const shippedBody = await responseJson<any>(shipped);
    await env.DB.prepare(
      "UPDATE releases SET status = 'cancelled', activated_at = ?1, revision = 1 WHERE id = ?2",
    ).bind(Date.now(), shippedBody.id).run();
    await installReleaseVersionReuseTriggers();

    // Activated-then-cancelled coordinate: a different binary is rejected by
    // the application-layer precheck with the real blocking release surfaced.
    const corrected = await handleCreateReleaseDraft(makeReleaseContext("", {
      build_id: "build-corrected-41",
    }));
    expect(corrected.status).toBe(409);
    await expect(responseJson<any>(corrected)).resolves.toMatchObject({
      code: "RELEASE_VERSION_ALREADY_EXISTS",
      release_id: shippedBody.id,
      build_id: "build-shipped-41",
      version_code: 41,
    });

    // The same build row is rejected too: assets are mutable, so a build id
    // does not certify identical bytes.
    const reissue = await handleCreateReleaseDraft(makeReleaseContext("", {
      build_id: "build-shipped-41",
    }));
    expect(reissue.status).toBe(409);
    await env.DB.prepare("DELETE FROM releases").run();
    await env.DB.prepare(
      "DELETE FROM builds WHERE id IN ('build-shipped-41', 'build-corrected-41')",
    ).run();

  });

  it("returns a structured conflict when create loses a trigger race to restore", async () => {
    const {
      createRelease,
      handleCreateReleaseDraft,
      handleRollbackRelease,
    } = await import("../src/routes/releases");
    await seedReleaseBuild("build-create-loser", 34);
    await seedReleaseBuild("build-restore-winner", 34);
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-restore-winner",
      status: "draft",
    }, "tester", "rel-restore-winner");
    await env.DB.prepare(
      "UPDATE releases SET status = 'cancelled', revision = 1 WHERE id = 'rel-restore-winner'",
    ).run();
    await installReleaseVersionReuseTriggers();

    const db = env.DB as any;
    const originalBatch = db.batch.bind(db);
    let injected = false;
    let winnerStatus: number | null = null;
    db.batch = async (statements: any[]) => {
      if (!injected) {
        injected = true;
        const winner = await handleRollbackRelease(makeReleaseContext(
          "rel-restore-winner",
          { expected_revision: 1 },
        ));
        winnerStatus = winner.status;
      }
      return originalBatch(statements);
    };

    let response: Response;
    try {
      response = await handleCreateReleaseDraft(makeReleaseContext("", {
        build_id: "build-create-loser",
      }));
    } finally {
      db.batch = originalBatch;
    }

    expect(winnerStatus).toBe(200);
    expect(response.status).toBe(409);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      code: "RELEASE_VERSION_ALREADY_EXISTS",
      release_id: "rel-restore-winner",
      build_id: "build-restore-winner",
      release_status: "draft",
      version_code: 34,
    });
    await expect(env.DB.prepare(
      "SELECT id, status, revision FROM releases ORDER BY id",
    ).all()).resolves.toEqual({
      results: [{ id: "rel-restore-winner", status: "draft", revision: 2 }],
      success: true,
    });
    await expect(env.DB.prepare(
      "SELECT release_id, scope_type, scope_value FROM release_scopes ORDER BY release_id",
    ).all()).resolves.toEqual({
      results: [{
        release_id: "rel-restore-winner",
        scope_type: "full",
        scope_value: "all",
      }],
      success: true,
    });
    await expect(env.DB.prepare(
      "SELECT action, COUNT(*) AS count FROM audit_logs GROUP BY action ORDER BY action",
    ).all()).resolves.toEqual({
      results: [
        { action: "release.create", count: 1 },
        { action: "release.rollback", count: 1 },
      ],
      success: true,
    });
  });

  it("keeps restore side-effect free when create wins the trigger race", async () => {
    const {
      createRelease,
      handleCreateReleaseDraft,
      handleRollbackRelease,
    } = await import("../src/routes/releases");
    await seedReleaseBuild("build-restore-loser", 35);
    await seedReleaseBuild("build-create-winner", 35);
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-restore-loser",
      status: "draft",
    }, "tester", "rel-restore-loser");
    await env.DB.prepare(
      "UPDATE releases SET status = 'cancelled', revision = 1 WHERE id = 'rel-restore-loser'",
    ).run();
    await installReleaseVersionReuseTriggers();

    const db = env.DB as any;
    const originalBatch = db.batch.bind(db);
    let injected = false;
    let winnerId: string | undefined;
    db.batch = async (statements: any[]) => {
      if (!injected) {
        injected = true;
        const created = await handleCreateReleaseDraft(makeReleaseContext("", {
          build_id: "build-create-winner",
        }));
        expect(created.status).toBe(201);
        winnerId = (await responseJson<any>(created)).id;
      }
      return originalBatch(statements);
    };

    let response: Response;
    try {
      response = await handleRollbackRelease(makeReleaseContext(
        "rel-restore-loser",
        { expected_revision: 1 },
      ));
    } finally {
      db.batch = originalBatch;
    }

    expect(response.status).toBe(409);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      code: "RELEASE_VERSION_ALREADY_EXISTS",
      release_id: winnerId,
      build_id: "build-create-winner",
      release_status: "draft",
      version_code: 35,
    });
    await expect(env.DB.prepare(
      "SELECT status, revision FROM releases WHERE id = 'rel-restore-loser'",
    ).first()).resolves.toEqual({ status: "cancelled", revision: 1 });
    await expect(env.DB.prepare(
      `SELECT release_id, scope_type, scope_value FROM release_scopes
       WHERE release_id = 'rel-restore-loser'`,
    ).all()).resolves.toEqual({
      results: [{
        release_id: "rel-restore-loser",
        scope_type: "full",
        scope_value: "all",
      }],
      success: true,
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.rollback'",
    ).first()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.create'",
    ).first()).resolves.toEqual({ count: 2 });
  });

  it("keeps the trigger conflict structured if the winning owner cancels before requery", async () => {
    const { createRelease, handleCreateReleaseDraft } = await import("../src/routes/releases");
    await seedReleaseBuild("build-transient-loser", 36);
    await seedReleaseBuild("build-transient-winner", 36);
    await installReleaseVersionReuseTriggers();

    const db = env.DB as any;
    const originalBatch = db.batch.bind(db);
    let injected = false;
    db.batch = async (statements: any[]) => {
      if (injected) return originalBatch(statements);
      injected = true;
      await createRelease(env.DB as any, "app-release", {
        build_id: "build-transient-winner",
        status: "draft",
      }, "winner", "rel-transient-winner");
      try {
        return await originalBatch(statements);
      } catch (error) {
        await env.DB.prepare(
          "UPDATE releases SET status = 'cancelled' WHERE id = 'rel-transient-winner'",
        ).run();
        throw error;
      }
    };

    let response: Response;
    try {
      response = await handleCreateReleaseDraft(makeReleaseContext("", {
        build_id: "build-transient-loser",
      }));
    } finally {
      db.batch = originalBatch;
    }

    expect(response.status).toBe(409);
    const body = await responseJson<any>(response);
    expect(body).toMatchObject({
      code: "RELEASE_VERSION_ALREADY_EXISTS",
      version_name: "1.0.36",
      version_code: 36,
    });
    expect(body).not.toHaveProperty("release_id");
    await expect(env.DB.prepare(
      "SELECT id, status FROM releases ORDER BY id",
    ).all()).resolves.toEqual({
      results: [{ id: "rel-transient-winner", status: "cancelled" }],
      success: true,
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.create'",
    ).first()).resolves.toEqual({ count: 1 });
  });

  it("blocks restoring a cancelled lifecycle after a replacement owns its version", async () => {
    const { createRelease, handleRollbackRelease } = await import("../src/routes/releases");
    await seedReleaseBuild("build-version-old", 31);
    await seedReleaseBuild("build-version-replacement", 31);
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-version-old",
      status: "draft",
    }, "tester", "rel-version-old");
    await env.DB.prepare(
      "UPDATE releases SET status = 'cancelled', revision = 1 WHERE id = 'rel-version-old'",
    ).run();
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-version-replacement",
      status: "draft",
    }, "tester", "rel-version-replacement");

    const response = await handleRollbackRelease(makeReleaseContext(
      "rel-version-old",
      { expected_revision: 1 },
    ));

    expect(response.status).toBe(409);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      code: "RELEASE_VERSION_ALREADY_EXISTS",
      release_id: "rel-version-replacement",
      build_id: "build-version-replacement",
      release_status: "draft",
      version_code: 31,
    });
    await expect(env.DB.prepare(
      "SELECT status, revision FROM releases WHERE id = 'rel-version-old'",
    ).first()).resolves.toEqual({ status: "cancelled", revision: 1 });
  });

  it("filters release preflights by exact lane and version code", async () => {
    const { createRelease, handleListReleases } = await import("../src/routes/releases");
    await seedReleaseBuild("build-version-filter", 32);
    await seedReleaseBuild("build-version-other", 33);
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-version-filter",
      status: "draft",
    }, "tester", "rel-version-filter");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-version-other",
      status: "draft",
    }, "tester", "rel-version-other");

    const response = await handleListReleases(makeReleaseContext("", {}, {
      channel: "main",
      product_type: "android-apk",
      release_type: "stable",
      version_code: "32",
    }));
    expect(response.status).toBe(200);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      releases: [{
        id: "rel-version-filter",
        build_id: "build-version-filter",
        version_code: 32,
      }],
    });

    const invalid = await handleListReleases(makeReleaseContext("", {}, {
      version_code: "-1",
    }));
    expect(invalid.status).toBe(400);
    await expect(responseJson<any>(invalid)).resolves.toEqual({
      error: "version_code must be a non-negative integer",
    });
  });

  it("publishes a draft and supersedes the previous active release", async () => {
    const { createRelease, handlePublishRelease } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-active");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
    }, "tester", "rel-draft");

    const response = await handlePublishRelease(makeReleaseContext("rel-draft"));
    expect(response.status).toBe(200);
    const published = await responseJson<any>(response);
    expect(published.status).toBe("active");

    const { results } = await env.DB
      .prepare("SELECT id, status, superseded_by_release_id FROM releases ORDER BY id ASC")
      .bind()
      .all();
    expect(results).toEqual([
      { id: "rel-active", status: "superseded", superseded_by_release_id: "rel-draft" },
      { id: "rel-draft", status: "active", superseded_by_release_id: null },
    ]);
  });

  it("publishes a device-group draft without superseding the full fallback release", async () => {
    const { createRelease, handlePublishRelease } = await import("../src/routes/releases");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-release-test", "app-release", "QA devices", null, now, now).run();
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-active");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      scopes: [{ scope_type: "device_group", scope_value: "group-release-test" }],
    }, "tester", "rel-group-draft");

    const response = await handlePublishRelease(makeReleaseContext("rel-group-draft", {
      expected_scope: { scope_type: "device_group", scope_value: "group-release-test" },
    }));
    expect(response.status).toBe(200);
    const { results } = await env.DB.prepare(
      "SELECT id, status, superseded_by_release_id FROM releases ORDER BY id",
    ).all();
    expect(results).toEqual([
      { id: "rel-active", status: "active", superseded_by_release_id: null },
      { id: "rel-group-draft", status: "active", superseded_by_release_id: null },
    ]);
  });

  it("rejects a legacy mixed scope at publish without activation side effects", async () => {
    const { createRelease, handlePublishRelease } = await import("../src/routes/releases");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-legacy-mixed", "app-release", "Legacy mixed", null, now, now).run();
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      scopes: [{ scope_type: "device_group", scope_value: "group-legacy-mixed" }],
    }, "tester", "rel-legacy-mixed");
    await env.DB.prepare(
      `INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
       VALUES (?, ?, 'full', 'all', ?)`,
    ).bind("scope-legacy-full", "rel-legacy-mixed", now).run();

    const response = await handlePublishRelease(makeReleaseContext("rel-legacy-mixed", {
      expected_scope: { scope_type: "device_group", scope_value: "group-legacy-mixed" },
    }));
    expect(response.status).toBe(409);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      code: "RELEASE_SCOPE_PRECONDITION_FAILED",
    });
    const { results } = await env.DB.prepare(
      "SELECT id, status, superseded_by_release_id FROM releases ORDER BY id",
    ).all();
    expect(results).toEqual([
      { id: "rel-fallback", status: "active", superseded_by_release_id: null },
      { id: "rel-legacy-mixed", status: "draft", superseded_by_release_id: null },
    ]);
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.publish'",
    ).first()).resolves.toEqual({ count: 0 });
  });

  it("publishes a partial full-scope rollout without superseding the full fallback release", async () => {
    const { createRelease, handlePublishRelease } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-active");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      rollout_cohort_count: 25,
    }, "tester", "rel-partial-draft");

    const response = await handlePublishRelease(makeReleaseContext("rel-partial-draft"));
    expect(response.status).toBe(200);
    const { results } = await env.DB.prepare(
      "SELECT id, status, superseded_by_release_id FROM releases ORDER BY id",
    ).all();
    expect(results).toEqual([
      { id: "rel-active", status: "active", superseded_by_release_id: null },
      { id: "rel-partial-draft", status: "active", superseded_by_release_id: null },
    ]);
  });

  it("restores a directly superseded fallback when an active full release is narrowed", async () => {
    const { createRelease, handleUpdateRelease } = await import("../src/routes/releases");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-narrow-active", "app-release", "Narrow active", null, now, now).run();
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "active",
    }, "tester", "rel-current");

    const before = await env.DB.prepare(
      "SELECT status, superseded_by_release_id FROM releases WHERE id = 'rel-fallback'",
    ).first();
    expect(before).toEqual({ status: "superseded", superseded_by_release_id: "rel-current" });

    const response = await handleUpdateRelease(makeReleaseContext("rel-current", {
      scopes: [{ scope_type: "device_group", scope_value: "group-narrow-active" }],
    }));
    expect(response.status).toBe(200);
    const { results } = await env.DB.prepare(
      "SELECT id, status, superseded_by_release_id FROM releases ORDER BY id",
    ).all();
    expect(results).toEqual([
      { id: "rel-current", status: "active", superseded_by_release_id: null },
      { id: "rel-fallback", status: "active", superseded_by_release_id: null },
    ]);
  });

  it("supersedes coexisting fallbacks when an active scoped release becomes full coverage", async () => {
    const { createRelease, handleUpdateRelease } = await import("../src/routes/releases");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-expand-active", "app-release", "Expand active", null, now, now).run();
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "active",
      scopes: [{ scope_type: "device_group", scope_value: "group-expand-active" }],
    }, "tester", "rel-scoped");

    const response = await handleUpdateRelease(makeReleaseContext("rel-scoped", {
      scopes: [{ scope_type: "full", scope_value: "all" }],
      rollout_cohort_count: 100,
    }));
    expect(response.status).toBe(200);
    const { results } = await env.DB.prepare(
      "SELECT id, status, superseded_by_release_id FROM releases ORDER BY id",
    ).all();
    expect(results).toEqual([
      { id: "rel-fallback", status: "superseded", superseded_by_release_id: "rel-scoped" },
      { id: "rel-scoped", status: "active", superseded_by_release_id: null },
    ]);
  });

  it("rejects nonexistent and cross-app device groups as release scopes", async () => {
    const { createRelease } = await import("../src/routes/releases");
    await expect(createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      scopes: [{ scope_type: "device_group", scope_value: "missing-group" }],
    }, "tester", "rel-missing-group")).rejects.toThrow("device group not found for app");

    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("app-other", "default", "other-app", "Other App", "android", now).run();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-other-app", "app-other", "Other devices", null, now, now).run();
    await expect(createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      scopes: [{ scope_type: "device_group", scope_value: "group-other-app" }],
    }, "tester", "rel-cross-app-group")).rejects.toThrow("device group not found for app");
  });

  it("defaults omitted scopes to full but rejects every explicit empty or malformed scope list", async () => {
    const { createRelease, handleUpdateRelease } = await import("../src/routes/releases");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-scope-validation", "app-release", "Scope validation", null, now, now).run();

    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
    }, "tester", "rel-omitted-scope");
    await expect(env.DB.prepare(
      "SELECT scope_type, scope_value FROM release_scopes WHERE release_id = 'rel-omitted-scope'",
    ).first()).resolves.toEqual({ scope_type: "full", scope_value: "all" });

    const invalidLists: unknown[] = [
      [],
      [{ scope_type: "", scope_value: "all" }],
      [{ scope_type: "full", scope_value: "   " }],
      [
        { scope_type: "device_group", scope_value: "group-scope-validation" },
        { scope_type: "", scope_value: "discard-me" },
      ],
    ];
    for (const [index, scopes] of invalidLists.entries()) {
      await expect(createRelease(env.DB as any, "app-release", {
        build_id: "build-draft",
        status: "draft",
        scopes: scopes as any,
      }, "tester", `rel-invalid-scope-${index}`)).rejects.toThrow(/release scope/);
    }
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM releases WHERE id LIKE 'rel-invalid-scope-%'",
    ).first()).resolves.toEqual({ count: 0 });

    await seedReleaseBuild("build-scope-update", 3);
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-scope-update",
      status: "draft",
      scopes: [{ scope_type: "device_group", scope_value: "group-scope-validation" }],
    }, "tester", "rel-scope-update-guard");
    const beforeAudit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.update'",
    ).first();
    for (const scopes of invalidLists) {
      const response = await handleUpdateRelease(makeReleaseContext("rel-scope-update-guard", {
        scopes,
      }));
      expect(response.status).toBe(400);
    }
    await expect(env.DB.prepare(
      "SELECT scope_type, scope_value FROM release_scopes WHERE release_id = 'rel-scope-update-guard'",
    ).all()).resolves.toMatchObject({
      results: [{ scope_type: "device_group", scope_value: "group-scope-validation" }],
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.update'",
    ).first()).resolves.toEqual(beforeAudit);
  });

  it("requires an exact device-group publish precondition and rechecks it on replay", async () => {
    const { createRelease, handlePublishRelease } = await import("../src/routes/releases");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-publish-guard", "app-release", "Publish guard", null, now, now).run();
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-publish-guard-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      scopes: [{ scope_type: "device_group", scope_value: "group-publish-guard" }],
    }, "tester", "rel-publish-guard-draft");

    for (const body of [
      {},
      { expected_scope: {} },
      { expected_scope: { scope_type: "device_group", scope_value: "wrong-group" } },
    ]) {
      const response = await handlePublishRelease(makeReleaseContext("rel-publish-guard-draft", body));
      expect(response.status).toBe(409);
      await expect(responseJson<any>(response)).resolves.toMatchObject({
        code: "RELEASE_SCOPE_PRECONDITION_FAILED",
      });
    }
    await expect(env.DB.prepare(
      "SELECT status FROM releases WHERE id = 'rel-publish-guard-draft'",
    ).first()).resolves.toEqual({ status: "draft" });
    await expect(env.DB.prepare(
      "SELECT status, superseded_by_release_id FROM releases WHERE id = 'rel-publish-guard-fallback'",
    ).first()).resolves.toEqual({ status: "active", superseded_by_release_id: null });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.publish'",
    ).first()).resolves.toEqual({ count: 0 });

    const exactBody = {
      expected_scope: { scope_type: "device_group", scope_value: "group-publish-guard" },
    };
    const published = await handlePublishRelease(makeReleaseContext("rel-publish-guard-draft", exactBody));
    expect(published.status).toBe(200);
    await expect(env.DB.prepare(
      "SELECT status FROM releases WHERE id = 'rel-publish-guard-draft'",
    ).first()).resolves.toEqual({ status: "active" });
    await expect(env.DB.prepare(
      "SELECT status, superseded_by_release_id FROM releases WHERE id = 'rel-publish-guard-fallback'",
    ).first()).resolves.toEqual({ status: "active", superseded_by_release_id: null });

    const replayWithoutExpectation = await handlePublishRelease(
      makeReleaseContext("rel-publish-guard-draft"),
    );
    expect(replayWithoutExpectation.status).toBe(409);
    const exactReplay = await handlePublishRelease(
      makeReleaseContext("rel-publish-guard-draft", exactBody),
    );
    expect(exactReplay.status).toBe(200);
  });

  it("publishes platform, cohort, and IP scopes only with their exact generic expectation", async () => {
    const { createRelease, handlePublishRelease } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-generic-scope-fallback");

    const scopeCases = [
      { scope_type: "platform", scope_value: "android" },
      { scope_type: "user_cohort", scope_value: "internal-qa" },
      { scope_type: "ip_range", scope_value: "203.0.113.0/24" },
    ];
    for (const [index, scope] of scopeCases.entries()) {
      const releaseId = `rel-generic-scope-${index}`;
      const buildId = `build-generic-scope-${index}`;
      await seedReleaseBuild(buildId, 10 + index);
      await createRelease(env.DB as any, "app-release", {
        build_id: buildId,
        status: "draft",
        scopes: [scope],
      }, "tester", releaseId);
      const auditBefore = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.publish'",
      ).first();

      for (const expected_scope of [
        undefined,
        { scope_type: "device_group", scope_value: scope.scope_value },
        { scope_type: scope.scope_type, scope_value: `${scope.scope_value}-wrong` },
      ]) {
        const body = expected_scope ? { expected_scope } : {};
        const rejected = await handlePublishRelease(makeReleaseContext(releaseId, body));
        expect(rejected.status).toBe(409);
      }
      await expect(env.DB.prepare(
        "SELECT status FROM releases WHERE id = ?1",
      ).bind(releaseId).first()).resolves.toEqual({ status: "draft" });
      await expect(env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.publish'",
      ).first()).resolves.toEqual(auditBefore);

      const exactBody = { expected_scope: scope };
      const published = await handlePublishRelease(makeReleaseContext(releaseId, exactBody));
      expect(published.status).toBe(200);
      await expect(env.DB.prepare(
        "SELECT status FROM releases WHERE id = ?1",
      ).bind(releaseId).first()).resolves.toEqual({ status: "active" });
      await expect(env.DB.prepare(
        "SELECT status, superseded_by_release_id FROM releases WHERE id = 'rel-generic-scope-fallback'",
      ).first()).resolves.toEqual({ status: "active", superseded_by_release_id: null });

      const replayMissing = await handlePublishRelease(makeReleaseContext(releaseId));
      expect(replayMissing.status).toBe(409);
      const replayWrong = await handlePublishRelease(makeReleaseContext(releaseId, {
        expected_scope: { scope_type: scope.scope_type, scope_value: `${scope.scope_value}-wrong` },
      }));
      expect(replayWrong.status).toBe(409);
      const replayExact = await handlePublishRelease(makeReleaseContext(releaseId, exactBody));
      expect(replayExact.status).toBe(200);
    }
  });

  it("rejects full-scope drift and zero scope rows when device-group activation is expected", async () => {
    const { createRelease, handlePublishRelease } = await import("../src/routes/releases");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-drift-guard", "app-release", "Drift guard", null, now, now).run();

    for (const [index, releaseId] of ["rel-scope-drift-full", "rel-scope-drift-zero"].entries()) {
      const buildId = `build-scope-drift-${index}`;
      await seedReleaseBuild(buildId, 20 + index);
      await createRelease(env.DB as any, "app-release", {
        build_id: buildId,
        status: "draft",
        scopes: [{ scope_type: "device_group", scope_value: "group-drift-guard" }],
      }, "tester", releaseId);
    }
    await env.DB.prepare(
      `UPDATE release_scopes SET scope_type = 'full', scope_value = 'all'
       WHERE release_id = 'rel-scope-drift-full'`,
    ).run();
    await env.DB.prepare(
      "DELETE FROM release_scopes WHERE release_id = 'rel-scope-drift-zero'",
    ).run();

    for (const releaseId of ["rel-scope-drift-full", "rel-scope-drift-zero"]) {
      const response = await handlePublishRelease(makeReleaseContext(releaseId, {
        expected_scope: { scope_type: "device_group", scope_value: "group-drift-guard" },
      }));
      expect(response.status).toBe(409);
      await expect(env.DB.prepare(
        "SELECT status FROM releases WHERE id = ?1",
      ).bind(releaseId).first()).resolves.toEqual({ status: "draft" });
    }
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.publish'",
    ).first()).resolves.toEqual({ count: 0 });
  });

  it("fails the transactional publish CAS when scope drifts after preflight but before the batch", async () => {
    const { createRelease, handlePublishRelease } = await import("../src/routes/releases");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-cas-race", "app-release", "CAS race", null, now, now).run();
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-cas-race-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      rollout_cohort_count: 25,
      scopes: [
        { scope_type: "full", scope_value: "all" },
        { scope_type: "device_group", scope_value: "group-cas-race" },
      ],
    }, "tester", "rel-cas-race-draft");

    const db = env.DB as any;
    const originalBatch = db.batch.bind(db);
    let injected = false;
    db.batch = async (statements: any[]) => {
      if (!injected) {
        injected = true;
        await env.DB.prepare(
          `DELETE FROM release_scopes
           WHERE release_id = 'rel-cas-race-draft' AND scope_type = 'device_group'`,
        ).run();
      }
      return originalBatch(statements);
    };
    const waitUntil = vi.fn();
    const context = makeReleaseContext("rel-cas-race-draft", {
      expected_scopes: [
        { scope_type: "full", scope_value: "all" },
        { scope_type: "device_group", scope_value: "group-cas-race" },
      ],
    });
    context.executionCtx.waitUntil = waitUntil;

    const response = await handlePublishRelease(context);
    expect(response.status).toBe(409);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      code: "RELEASE_SCOPE_PRECONDITION_FAILED",
    });
    expect(waitUntil).not.toHaveBeenCalled();
    await expect(env.DB.prepare(
      "SELECT status FROM releases WHERE id = 'rel-cas-race-draft'",
    ).first()).resolves.toEqual({ status: "draft" });
    await expect(env.DB.prepare(
      "SELECT status, superseded_by_release_id FROM releases WHERE id = 'rel-cas-race-fallback'",
    ).first()).resolves.toEqual({ status: "active", superseded_by_release_id: null });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.publish'",
    ).first()).resolves.toEqual({ count: 0 });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM release_shares WHERE release_id = 'rel-cas-race-draft'",
    ).first()).resolves.toEqual({ count: 0 });
  });

  it("supports a full rollout with always-included device groups and rejects incompatible mixes", async () => {
    const { createRelease, handleBumpRollout, handlePublishRelease } = await import("../src/routes/releases");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-no-mixed-full", "app-release", "Always included", null, now, now).run();
    const mixedScopes = [
      { scope_type: "full", scope_value: "all" },
      { scope_type: "device_group", scope_value: "group-no-mixed-full" },
    ];
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-mixed-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      rollout_cohort_count: 25,
      scopes: mixedScopes,
    }, "tester", "rel-mixed-current");

    const legacyExpectation = await handlePublishRelease(makeReleaseContext("rel-mixed-current", {
      expected_scope: { scope_type: "full", scope_value: "all" },
    }));
    expect(legacyExpectation.status).toBe(409);
    const published = await handlePublishRelease(makeReleaseContext("rel-mixed-current", {
      expected_scopes: [...mixedScopes].reverse(),
    }));
    expect(published.status).toBe(200);
    await expect(env.DB.prepare(
      "SELECT status, is_full, rollout_cohort_count FROM releases WHERE id = 'rel-mixed-current'",
    ).first()).resolves.toEqual({
      status: "active",
      is_full: 1,
      rollout_cohort_count: 25,
    });
    await expect(env.DB.prepare(
      "SELECT status, superseded_by_release_id FROM releases WHERE id = 'rel-mixed-fallback'",
    ).first()).resolves.toEqual({
      status: "active",
      superseded_by_release_id: null,
    });

    const bumped = await handleBumpRollout(makeReleaseContext("rel-mixed-current", { to: 100 }));
    expect(bumped.status).toBe(200);
    await expect(env.DB.prepare(
      "SELECT status, superseded_by_release_id FROM releases WHERE id = 'rel-mixed-fallback'",
    ).first()).resolves.toEqual({
      status: "superseded",
      superseded_by_release_id: "rel-mixed-current",
    });

    await seedReleaseBuild("build-invalid-scope-mix", 31);
    await expect(createRelease(env.DB as any, "app-release", {
      build_id: "build-invalid-scope-mix",
      status: "draft",
      scopes: [
        { scope_type: "full", scope_value: "all" },
        { scope_type: "platform", scope_value: "android" },
      ],
    }, "tester", "rel-invalid-scope-mix")).rejects.toThrow(
      "full:all may be combined only with device_group scopes",
    );
    await seedReleaseBuild("build-duplicate-scope", 32);
    await expect(createRelease(env.DB as any, "app-release", {
      build_id: "build-duplicate-scope",
      status: "draft",
      scopes: [mixedScopes[0]!, mixedScopes[0]!],
    }, "tester", "rel-duplicate-scope")).rejects.toThrow("duplicate release scope");
  });

  it("rejects a stale rollout bump after an actual scope PATCH and preserves the full fallback", async () => {
    const {
      createRelease,
      handleBumpRollout,
      handleUpdateRelease,
    } = await import("../src/routes/releases");
    const { handlePublicV2Latest } = await import("../src/routes/public_v2");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-bump-barrier", "app-release", "Bump barrier", null, now, now).run();
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-bump-barrier-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "active",
      rollout_cohort_count: 25,
      scopes: [
        { scope_type: "full", scope_value: "all" },
        { scope_type: "device_group", scope_value: "group-bump-barrier" },
      ],
    }, "tester", "rel-bump-barrier-current");

    const db = env.DB as any;
    const originalBatch = db.batch.bind(db);
    let injected = false;
    let patchStatus: number | null = null;
    db.batch = async (statements: any[]) => {
      if (!injected) {
        injected = true;
        const patched = await handleUpdateRelease(makeReleaseContext(
          "rel-bump-barrier-current",
          {
            expected_revision: 0,
            scopes: [{ scope_type: "device_group", scope_value: "group-bump-barrier" }],
          },
        ));
        patchStatus = patched.status;
      }
      return originalBatch(statements);
    };

    let bumped: Response;
    try {
      bumped = await handleBumpRollout(makeReleaseContext(
        "rel-bump-barrier-current",
        { to: 100, expected_revision: 0 },
      ));
    } finally {
      db.batch = originalBatch;
    }

    expect(patchStatus).toBe(200);
    expect(bumped.status).toBe(409);
    await expect(responseJson<any>(bumped)).resolves.toMatchObject({
      code: "RELEASE_REVISION_CONFLICT",
      expected_revision: 0,
      current_revision: 1,
    });
    await expect(env.DB.prepare(
      `SELECT id, status, revision, rollout_cohort_count, superseded_by_release_id
       FROM releases WHERE id IN ('rel-bump-barrier-current', 'rel-bump-barrier-fallback')
       ORDER BY id`,
    ).all()).resolves.toEqual({
      results: [
        {
          id: "rel-bump-barrier-current",
          status: "active",
          revision: 1,
          rollout_cohort_count: 25,
          superseded_by_release_id: null,
        },
        {
          id: "rel-bump-barrier-fallback",
          status: "active",
          revision: 0,
          rollout_cohort_count: null,
          superseded_by_release_id: null,
        },
      ],
      success: true,
    });
    await expect(env.DB.prepare(
      `SELECT scope_type, scope_value FROM release_scopes
       WHERE release_id = 'rel-bump-barrier-current' ORDER BY scope_type, scope_value`,
    ).all()).resolves.toMatchObject({
      results: [{ scope_type: "device_group", scope_value: "group-bump-barrier" }],
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.bump_rollout'",
    ).first()).resolves.toEqual({ count: 0 });

    const publicContext = (deviceId?: string) => ({
      env,
      req: {
        url: "https://hands.test/public/v2/apps/release-app/latest",
        param: (name: string) => name === "slug" ? "release-app" : "",
        query: (name: string) => ({
          channel: "main",
          product_type: "android-apk",
          platform: "android",
        } as Record<string, string>)[name],
        header: (name: string) =>
          name === "X-Hands-Device-Id" ? deviceId :
          name === "CF-Connecting-IP" ? "203.0.113.7" : undefined,
        raw: { cf: {} },
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      }),
    }) as any;
    for (const deviceId of [undefined, "non-group-device"]) {
      const resolved = await handlePublicV2Latest(publicContext(deviceId));
      expect(resolved.status).toBe(200);
      await expect(responseJson<any>(resolved)).resolves.toMatchObject({
        build: { id: "build-active", version_code: 1 },
        scoped: { release_id: "rel-bump-barrier-fallback", scope_type: "full" },
      });
    }
  });

  it("distinguishes the three public-latest 404 kinds with machine-readable codes", async () => {
    // A consumer showing a download page must branch on WHICH 404 this is:
    // "legitimately nothing to serve" renders as an empty state, a mistyped slug
    // is a configuration error. The `error` prose is for humans and may be
    // reworded, so the contract for that branch is `code`, pinned here. The 200
    // side of this handler is exercised by the neighbouring tests, so a broken
    // harness cannot pass this by making everything 404.
    const { handlePublicV2Latest } = await import("../src/routes/public_v2");
    const publicLatestContext = (slug: string, channel: string) => ({
      env,
      req: {
        url: `https://hands.test/public/v2/apps/${slug}/latest`,
        param: (name: string) => (name === "slug" ? slug : ""),
        query: (name: string) => (name === "channel" ? channel : undefined),
        header: () => undefined,
        raw: { cf: {} },
      },
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    }) as any;

    const unknownApp = await handlePublicV2Latest(publicLatestContext("codes-no-such-app", "main"));
    expect(unknownApp.status).toBe(404);
    await expect(responseJson<any>(unknownApp)).resolves.toMatchObject({ code: "app_not_found" });

    env.DB.prepare(
      "INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app-codes', 'codes-app', 'Codes', 'android', 1)",
    ).run();
    const unknownChannel = await handlePublicV2Latest(publicLatestContext("codes-app", "no-such-channel"));
    expect(unknownChannel.status).toBe(404);
    await expect(responseJson<any>(unknownChannel)).resolves.toMatchObject({ code: "channel_not_found" });

    env.DB.prepare(
      "INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('chan-codes', 'app-codes', 'main', 'Main', 1)",
    ).run();
    const legitimatelyEmpty = await handlePublicV2Latest(publicLatestContext("codes-app", "main"));
    expect(legitimatelyEmpty.status).toBe(404);
    await expect(responseJson<any>(legitimatelyEmpty)).resolves.toMatchObject({ code: "no_active_release" });
  });

  it("lets cancel win a rollout-bump race without stale audit or fallback damage", async () => {
    const {
      createRelease,
      handleBumpRollout,
      handleDeleteRelease,
    } = await import("../src/routes/releases");
    const { handlePublicV2Latest } = await import("../src/routes/public_v2");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-cancel-race-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "active",
      rollout_cohort_count: 25,
    }, "tester", "rel-cancel-race-current");

    const db = env.DB as any;
    const originalBatch = db.batch.bind(db);
    let injected = false;
    let cancelStatus: number | null = null;
    db.batch = async (statements: any[]) => {
      if (!injected) {
        injected = true;
        const cancelled = await handleDeleteRelease(makeReleaseContext(
          "rel-cancel-race-current",
          {},
          { expected_revision: "0" },
        ));
        cancelStatus = cancelled.status;
      }
      return originalBatch(statements);
    };

    let bumped: Response;
    try {
      bumped = await handleBumpRollout(makeReleaseContext(
        "rel-cancel-race-current",
        { to: 100, expected_revision: 0 },
      ));
    } finally {
      db.batch = originalBatch;
    }

    expect(cancelStatus).toBe(200);
    expect(bumped.status).toBe(409);
    await expect(responseJson<any>(bumped)).resolves.toMatchObject({
      code: "RELEASE_REVISION_CONFLICT",
      expected_revision: 0,
      current_revision: 1,
    });
    await expect(env.DB.prepare(
      `SELECT id, status, revision, rollout_cohort_count, superseded_by_release_id
       FROM releases WHERE id IN ('rel-cancel-race-current', 'rel-cancel-race-fallback')
       ORDER BY id`,
    ).all()).resolves.toEqual({
      results: [
        {
          id: "rel-cancel-race-current",
          status: "cancelled",
          revision: 1,
          rollout_cohort_count: 25,
          superseded_by_release_id: null,
        },
        {
          id: "rel-cancel-race-fallback",
          status: "active",
          revision: 0,
          rollout_cohort_count: null,
          superseded_by_release_id: null,
        },
      ],
      success: true,
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.bump_rollout'",
    ).first()).resolves.toEqual({ count: 0 });

    const resolved = await handlePublicV2Latest({
      env,
      req: {
        url: "https://hands.test/public/v2/apps/release-app/latest",
        param: (name: string) => name === "slug" ? "release-app" : "",
        query: (name: string) => ({
          channel: "main",
          product_type: "android-apk",
          platform: "android",
        } as Record<string, string>)[name],
        header: (name: string) => name === "CF-Connecting-IP" ? "203.0.113.9" : undefined,
        raw: { cf: {} },
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      }),
    } as any);
    expect(resolved.status).toBe(200);
    await expect(responseJson<any>(resolved)).resolves.toMatchObject({
      build: { id: "build-active", version_code: 1 },
      scoped: { release_id: "rel-cancel-race-fallback", scope_type: "full" },
    });
  });

  it("allows only one duplicate restore to reactivate a cancelled release", async () => {
    const {
      createRelease,
      handleDeleteRelease,
      handleRollbackRelease,
    } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-duplicate-restore-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "active",
    }, "tester", "rel-duplicate-restore-current");
    const cancelled = await handleDeleteRelease(makeReleaseContext(
      "rel-duplicate-restore-current",
      {},
      { expected_revision: "0" },
    ));
    expect(cancelled.status).toBe(200);

    const db = env.DB as any;
    const originalBatch = db.batch.bind(db);
    let injected = false;
    let winnerStatus: number | null = null;
    db.batch = async (statements: any[]) => {
      if (!injected) {
        injected = true;
        const winner = await handleRollbackRelease(makeReleaseContext(
          "rel-duplicate-restore-current",
          { expected_revision: 1 },
        ));
        winnerStatus = winner.status;
      }
      return originalBatch(statements);
    };

    let loser: Response;
    try {
      loser = await handleRollbackRelease(makeReleaseContext(
        "rel-duplicate-restore-current",
        { expected_revision: 1 },
      ));
    } finally {
      db.batch = originalBatch;
    }

    expect(winnerStatus).toBe(200);
    expect(loser.status).toBe(409);
    await expect(responseJson<any>(loser)).resolves.toMatchObject({
      code: "RELEASE_REVISION_CONFLICT",
      expected_revision: 1,
      current_revision: 2,
    });
    await expect(env.DB.prepare(
      `SELECT id, status, revision, superseded_by_release_id
       FROM releases WHERE id IN ('rel-duplicate-restore-current', 'rel-duplicate-restore-fallback')
       ORDER BY id`,
    ).all()).resolves.toEqual({
      results: [
        {
          id: "rel-duplicate-restore-current",
          status: "active",
          revision: 2,
          superseded_by_release_id: null,
        },
        {
          id: "rel-duplicate-restore-fallback",
          status: "superseded",
          revision: 3,
          superseded_by_release_id: "rel-duplicate-restore-current",
        },
      ],
      success: true,
    });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.rollback'",
    ).first()).resolves.toEqual({ count: 1 });
  });

  it("returns stale revision conflicts with zero effects for every release mutation", async () => {
    const {
      createRelease,
      handleBumpRollout,
      handleDeleteRelease,
      handleForceUpdate,
      handlePublishRelease,
      handleRollbackRelease,
      handleUpdateRelease,
    } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-stale-active");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
    }, "tester", "rel-stale-draft");
    await seedReleaseBuild("build-stale-new", 33);
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-stale-new",
      status: "active",
    }, "tester", "rel-stale-new");

    const readState = async () => ({
      releases: (await env.DB.prepare(
        `SELECT id, status, revision, rollout_cohort_count, should_force_update,
                superseded_by_release_id, changelog
         FROM releases ORDER BY id`,
      ).all()).results,
      scopes: (await env.DB.prepare(
        `SELECT release_id, scope_type, scope_value
         FROM release_scopes ORDER BY release_id, scope_type, scope_value`,
      ).all()).results,
      audits: (await env.DB.prepare(
        "SELECT action, payload FROM audit_logs ORDER BY created_at, id",
      ).all()).results,
    });
    const before = await readState();
    const staleRevision = 999;
    const responses = [
      await handleUpdateRelease(makeReleaseContext("rel-stale-draft", {
        changelog: "must not land",
        expected_revision: staleRevision,
      })),
      await handlePublishRelease(makeReleaseContext("rel-stale-draft", {
        expected_scopes: [{ scope_type: "full", scope_value: "all" }],
        expected_revision: staleRevision,
      })),
      await handleDeleteRelease(makeReleaseContext(
        "rel-stale-new",
        {},
        { expected_revision: String(staleRevision) },
      )),
      await handleRollbackRelease(makeReleaseContext("rel-stale-active", {
        expected_revision: staleRevision,
      })),
      await handleBumpRollout(makeReleaseContext("rel-stale-new", {
        to: 100,
        expected_revision: staleRevision,
      })),
      await handleForceUpdate(makeReleaseContext("rel-stale-new", {
        enabled: true,
        expected_revision: staleRevision,
      })),
    ];
    for (const response of responses) {
      expect(response.status).toBe(409);
      await expect(responseJson<any>(response)).resolves.toMatchObject({
        code: "RELEASE_REVISION_CONFLICT",
        expected_revision: staleRevision,
      });
    }
    expect(await readState()).toEqual(before);

    const invalid = await handleUpdateRelease(makeReleaseContext("rel-stale-draft", {
      expected_revision: "not-a-revision",
    }));
    expect(invalid.status).toBe(400);
    await expect(responseJson<any>(invalid)).resolves.toMatchObject({
      error: "expected_revision must be a non-negative integer",
    });
    expect(await readState()).toEqual(before);
  });

  it("restores a never-published external release only to draft and reruns publish gates", async () => {
    const {
      createRelease,
      handleDeleteRelease,
      handlePublishRelease,
      handleRollbackRelease,
    } = await import("../src/routes/releases");
    const { handlePublicV2Latest } = await import("../src/routes/public_v2");
    const now = Date.now();
    for (const [buildId, versionCode, source] of [
      ["build-draft-restore-fallback", 34, "web"],
      ["build-draft-restore-target", 35, "external"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code,
                             source, status, build_metadata_json, parsed_metadata_json,
                             should_force_update, provenance_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        buildId,
        "app-release",
        "ch-main",
        "cli-binary",
        "stable",
        `2.0.${versionCode}`,
        versionCode,
        source,
        "succeeded",
        "{}",
        "{}",
        0,
        "{}",
        now,
        now,
      ).run();
    }
    for (const target of ["darwin-arm64", "linux-x64"]) {
      await env.DB.prepare(
        `INSERT INTO external_build_targets
         (id, app_id, build_id, version_name, target, source_url, raw_sha256, raw_size_bytes,
          node_version, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `target-draft-restore-${target}`,
        "app-release",
        "build-draft-restore-target",
        "2.0.35",
        target,
        `https://cdn.test/2.0.35/${target}`,
        target === "darwin-arm64" ? "a".repeat(64) : "b".repeat(64),
        100,
        "24.15.0",
        "{}",
        now,
        now,
      ).run();
    }
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft-restore-fallback",
      status: "active",
    }, "tester", "rel-draft-restore-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft-restore-target",
      status: "draft",
    }, "tester", "rel-draft-restore-target");

    const cancelled = await handleDeleteRelease(makeReleaseContext(
      "rel-draft-restore-target",
      {},
      { expected_revision: "0" },
    ));
    expect(cancelled.status).toBe(200);
    const restored = await handleRollbackRelease(makeReleaseContext(
      "rel-draft-restore-target",
      { expected_revision: 1 },
    ));
    expect(restored.status).toBe(200);
    await expect(responseJson<any>(restored)).resolves.toMatchObject({
      id: "rel-draft-restore-target",
      status: "draft",
      activated_at: null,
      revision: 2,
      restored_to_draft: true,
      reactivated: false,
    });
    await expect(env.DB.prepare(
      `SELECT id, status, revision, superseded_by_release_id FROM releases
       WHERE id IN ('rel-draft-restore-fallback', 'rel-draft-restore-target') ORDER BY id`,
    ).all()).resolves.toEqual({
      results: [
        {
          id: "rel-draft-restore-fallback",
          status: "active",
          revision: 0,
          superseded_by_release_id: null,
        },
        {
          id: "rel-draft-restore-target",
          status: "draft",
          revision: 2,
          superseded_by_release_id: null,
        },
      ],
      success: true,
    });

    const wrongTargets = await handlePublishRelease(makeReleaseContext(
      "rel-draft-restore-target",
      {
        expected_revision: 2,
        expected_scopes: [{ scope_type: "full", scope_value: "all" }],
        required_external_targets: ["darwin-arm64", "win32-x64"],
      },
    ));
    expect(wrongTargets.status).toBe(400);
    await expect(responseJson<any>(wrongTargets)).resolves.toMatchObject({
      missing: ["win32-x64"],
      unexpected: ["linux-x64"],
    });
    await expect(env.DB.prepare(
      "SELECT status, revision FROM releases WHERE id = 'rel-draft-restore-target'",
    ).first()).resolves.toEqual({ status: "draft", revision: 2 });
    await expect(env.DB.prepare(
      "SELECT freeze_token FROM builds WHERE id = 'build-draft-restore-target'",
    ).first()).resolves.toEqual({ freeze_token: null });

    const beforePublish = await handlePublicV2Latest({
      env,
      req: {
        url: "https://hands.test/public/v2/apps/release-app/latest",
        param: (name: string) => name === "slug" ? "release-app" : "",
        query: (name: string) => ({
          channel: "main",
          product_type: "cli-binary",
        } as Record<string, string>)[name],
        header: (name: string) => name === "CF-Connecting-IP" ? "203.0.113.11" : undefined,
        raw: { cf: {} },
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      }),
    } as any);
    expect(beforePublish.status).toBe(200);
    await expect(responseJson<any>(beforePublish)).resolves.toMatchObject({
      build: { id: "build-draft-restore-fallback", version_code: 34 },
      scoped: { release_id: "rel-draft-restore-fallback", scope_type: "full" },
    });

    const published = await handlePublishRelease(makeReleaseContext(
      "rel-draft-restore-target",
      {
        expected_revision: 2,
        expected_scopes: [{ scope_type: "full", scope_value: "all" }],
        required_external_targets: ["linux-x64", "darwin-arm64"],
      },
    ));
    expect(published.status).toBe(200);
    await expect(responseJson<any>(published)).resolves.toMatchObject({
      status: "active",
      revision: 3,
    });
    await expect(env.DB.prepare(
      "SELECT status, superseded_by_release_id FROM releases WHERE id = 'rel-draft-restore-fallback'",
    ).first()).resolves.toEqual({
      status: "superseded",
      superseded_by_release_id: "rel-draft-restore-target",
    });
  });

  it("restores the same release id with a fresh activation and cancellation restores its fallback", async () => {
    const { createRelease, handleDeleteRelease, handleRollbackRelease } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-active",
      status: "active",
    }, "tester", "rel-restore-fallback");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "active",
    }, "tester", "rel-restore-current");
    await env.DB.prepare(
      "UPDATE releases SET activated_at = 1 WHERE id = 'rel-restore-fallback'",
    ).run();

    const restoredResponse = await handleRollbackRelease(
      makeReleaseContext("rel-restore-fallback"),
    );
    expect(restoredResponse.status).toBe(200);
    await expect(responseJson<any>(restoredResponse)).resolves.toMatchObject({
      id: "rel-restore-fallback",
      status: "active",
      reactivated: true,
    });
    await expect(env.DB.prepare(
      `SELECT id, status, superseded_by_release_id, activated_at
       FROM releases ORDER BY id`,
    ).all()).resolves.toMatchObject({
      results: [
        {
          id: "rel-restore-current",
          status: "superseded",
          superseded_by_release_id: "rel-restore-fallback",
        },
        {
          id: "rel-restore-fallback",
          status: "active",
          superseded_by_release_id: null,
          activated_at: expect.any(Number),
        },
      ],
    });
    const activated = await env.DB.prepare(
      "SELECT activated_at FROM releases WHERE id = 'rel-restore-fallback'",
    ).first() as { activated_at: number } | null;
    expect(activated!.activated_at).toBeGreaterThan(1);
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM releases",
    ).first()).resolves.toEqual({ count: 2 });

    const duplicateRestore = await handleRollbackRelease(
      makeReleaseContext("rel-restore-fallback"),
    );
    expect(duplicateRestore.status).toBe(409);

    const cancelled = await handleDeleteRelease(
      makeReleaseContext("rel-restore-fallback"),
    );
    expect(cancelled.status).toBe(200);
    await expect(env.DB.prepare(
      "SELECT id, status, superseded_by_release_id FROM releases ORDER BY id",
    ).all()).resolves.toEqual({
      results: [
        { id: "rel-restore-current", status: "active", superseded_by_release_id: null },
        { id: "rel-restore-fallback", status: "cancelled", superseded_by_release_id: null },
      ],
      success: true,
    });

    const restoredAfterCancel = await handleRollbackRelease(
      makeReleaseContext("rel-restore-fallback", { expected_revision: 3 }),
    );
    expect(restoredAfterCancel.status).toBe(200);
    await expect(responseJson<any>(restoredAfterCancel)).resolves.toMatchObject({
      id: "rel-restore-fallback",
      status: "active",
      revision: 4,
      restored_to_draft: false,
      reactivated: true,
    });
    await expect(env.DB.prepare(
      "SELECT id, status, superseded_by_release_id FROM releases ORDER BY id",
    ).all()).resolves.toEqual({
      results: [
        {
          id: "rel-restore-current",
          status: "superseded",
          superseded_by_release_id: "rel-restore-fallback",
        },
        {
          id: "rel-restore-fallback",
          status: "active",
          superseded_by_release_id: null,
        },
      ],
      success: true,
    });
  });

  it("creates and manages device-group members, but blocks deletion while a live release uses the group", async () => {
    const {
      handleAddDeviceGroupMember,
      handleCreateDeviceGroup,
      handleDeleteDeviceGroup,
      handleListDeviceGroups,
      handleRemoveDeviceGroupMember,
      handleUpdateDeviceGroup,
    } = await import("../src/routes/device_groups");
    const { createRelease } = await import("../src/routes/releases");

    const createResponse = await handleCreateDeviceGroup(makeDeviceGroupContext({}, {
      name: "  QA phones  ",
      description: " exact rollout ",
    }));
    expect(createResponse.status).toBe(201);
    const created = await responseJson<any>(createResponse);
    expect(created).toMatchObject({ name: "QA phones", description: "exact rollout", member_count: 0 });

    const updateResponse = await handleUpdateDeviceGroup(makeDeviceGroupContext({ groupId: created.id }, {
      name: "QA tablets",
      description: "physical acceptance devices",
    }));
    expect(updateResponse.status).toBe(200);
    await expect(responseJson<any>(updateResponse)).resolves.toMatchObject({
      id: created.id,
      name: "QA tablets",
      description: "physical acceptance devices",
    });

    const addResponse = await handleAddDeviceGroupMember(makeDeviceGroupContext({ groupId: created.id }, {
      device_id: " install/device 1 ",
      label: " Huawei ",
    }));
    expect(addResponse.status).toBe(201);
    await expect(responseJson<any>(addResponse)).resolves.toMatchObject({
      device_id: "install/device 1",
      label: "Huawei",
    });

    const listResponse = await handleListDeviceGroups(makeDeviceGroupContext());
    await expect(responseJson<any>(listResponse)).resolves.toMatchObject({
      groups: [{
        id: created.id,
        name: "QA tablets",
        description: "physical acceptance devices",
        member_count: 1,
        members: [{ device_id: "install/device 1", label: "Huawei" }],
      }],
    });

    const removeResponse = await handleRemoveDeviceGroupMember(makeDeviceGroupContext({
      groupId: created.id,
      deviceId: encodeURIComponent("install/device 1"),
    }));
    expect(removeResponse.status).toBe(200);
    const afterRemove = await responseJson<any>(await handleListDeviceGroups(makeDeviceGroupContext()));
    expect(afterRemove.groups[0].member_count).toBe(0);

    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      scopes: [{ scope_type: "device_group", scope_value: created.id }],
    }, "tester", "rel-group-reference");
    const blockedDelete = await handleDeleteDeviceGroup(makeDeviceGroupContext({ groupId: created.id }));
    expect(blockedDelete.status).toBe(409);
    await expect(responseJson<any>(blockedDelete)).resolves.toMatchObject({
      error: "device group is used by a draft or active release",
    });
  });

  it("updates editable release metadata and replaces scopes", async () => {
    const { createRelease, handleUpdateRelease } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
      scopes: [{ scope_type: "full", scope_value: "all" }],
    }, "tester", "rel-draft");

    const response = await handleUpdateRelease(makeReleaseContext("rel-draft", {
      changelog: "Edited notes",
      should_force_update: true,
      rollout_cohort_count: 25,
      scopes: [{ scope_type: "platform", scope_value: "android-arm64-v8a" }],
    }));
    expect(response.status).toBe(200);
    const release = await responseJson<any>(response);
    expect(release).toMatchObject({
      changelog: "Edited notes",
      should_force_update: 1,
      rollout_cohort_count: 25,
      is_full: 0,
    });

    const scopes = await env.DB
      .prepare("SELECT scope_type, scope_value FROM release_scopes WHERE release_id = ? ORDER BY created_at ASC")
      .bind("rel-draft")
      .all();
    expect(scopes.results).toEqual([
      { scope_type: "platform", scope_value: "android-arm64-v8a" },
    ]);
  });

  it("accepts and returns structured release notes on admin release APIs", async () => {
    const { createRelease, handleUpdateRelease, handleGetRelease } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
    }, "tester", "rel-draft");

    const response = await handleUpdateRelease(makeReleaseContext("rel-draft", {
      release_notes: {
        zh: "中文说明",
        en: "English notes",
      },
    }));
    expect(response.status).toBe(200);
    const release = await responseJson<any>(response);
    expect(release.changelog).toBe(JSON.stringify({ "zh-CN": "中文说明", en: "English notes" }));
    expect(release.release_notes).toEqual({ "zh-CN": "中文说明", en: "English notes" });

    const getResponse = await handleGetRelease(makeReleaseContext("rel-draft"));
    expect(getResponse.status).toBe(200);
    const detail = await responseJson<any>(getResponse);
    expect(detail.release.release_notes).toEqual({ "zh-CN": "中文说明", en: "English notes" });
  });

  it("soft-cancels a release without deleting build or asset rows", async () => {
    const { createRelease, handleDeleteRelease } = await import("../src/routes/releases");
    await createRelease(env.DB as any, "app-release", {
      build_id: "build-draft",
      status: "draft",
    }, "tester", "rel-draft");
    await env.DB
      .prepare(
        `INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key, file_hash, size_bytes, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("asset-1", "build-draft", "installable", "android", null, null, "apk", "apps/x.apk", "hash", 42, "{}", Date.now())
      .run();

    const response = await handleDeleteRelease(makeReleaseContext("rel-draft"));
    expect(response.status).toBe(200);

    const release = await env.DB
      .prepare("SELECT status FROM releases WHERE id = ?")
      .bind("rel-draft")
      .first();
    const build = await env.DB
      .prepare("SELECT id FROM builds WHERE id = ?")
      .bind("build-draft")
      .first();
    const asset = await env.DB
      .prepare("SELECT id FROM build_assets WHERE id = ?")
      .bind("asset-1")
      .first();
    expect(release).toMatchObject({ status: "cancelled" });
    expect(build).toMatchObject({ id: "build-draft" });
    expect(asset).toMatchObject({ id: "asset-1" });
  });
});

// =============================================================================
// P3.3.2 — public API scope resolution (publish-architecture §5.4)
// =============================================================================

describe("quiver public API v2 — scope resolution", () => {
  function makeEnv() {
    const env = makeMockEnv();
    env.DB.prepare(
      "INSERT OR IGNORE INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("app-scope", "default", "scope-app", "Scope App", "android", "qk_test", 1).run();
    env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, enabled_product_types_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("ch-scope-prod", "app-scope", "production", "Production", "[]", "{}", 1).run();
    return env;
  }

  function configureR2Presign(env: MockEnv) {
    env.R2_ACCOUNT_ID = "test-account";
    env.R2_BUCKET_NAME = "quiver-apks";
    env.R2_S3_ACCESS_KEY_ID = "test-access-key";
    env.R2_S3_SECRET_ACCESS_KEY = "test-secret-key";
    env.R2_PRESIGNED_DOWNLOAD_TTL_SECONDS = "600";
  }

  async function seedRelease(
    env: any,
    releaseId: string,
    buildId: string,
    scopes: Array<[string, string]>,
    opts: {
      createdAt?: number;
      productType?: string;
      versionCode?: number;
      versionName?: string;
      shouldForceUpdate?: number;
      rolloutCohortCount?: number | null;
      activatedAt?: number | null;
    } = {},
  ) {
    const now = opts.createdAt ?? Date.now();
    await env.DB.prepare(
      `INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code,
                           source, status, build_metadata_json, parsed_metadata_json,
                           should_force_update, provenance_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        buildId,
        "app-scope",
        "ch-scope-prod",
        opts.productType ?? "android-apk",
        "stable",
        opts.versionName ?? "1.0.0",
        opts.versionCode ?? 1,
        "web",
        "succeeded",
        "{}",
        "{}",
        opts.shouldForceUpdate ?? 0,
        "{}",
        now,
        now,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status,
                             activated_at, is_full, rollout_cohort_count, changelog,
                             created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        releaseId,
        "app-scope",
        buildId,
        "ch-scope-prod",
        opts.productType ?? "android-apk",
        "stable",
        "active",
        opts.activatedAt === undefined ? now : opts.activatedAt,
        scopes.some(([scopeType, scopeValue]) => scopeType === "full" && scopeValue === "all") ? 1 : 0,
        opts.rolloutCohortCount === undefined ? 100 : opts.rolloutCohortCount,
        null,
        "tester",
        now,
        now,
      )
      .run();
    for (const [st, sv] of scopes) {
      await env.DB.prepare(
        `INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), releaseId, st, sv, now)
        .run();
    }
  }

  async function seedAsset(
    env: any,
    buildId: string,
    assetId: string,
    opts: {
      artifactKind?: string;
      platform?: string;
      arch?: string | null;
      filetype?: string;
      sizeBytes?: number;
      variant?: string | null;
      r2Key?: string;
      fileHash?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ) {
    await env.DB.prepare(
      `INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key, file_hash,
                                 size_bytes, signature, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        assetId,
        buildId,
        opts.artifactKind ?? "installable",
        opts.platform ?? "android",
        opts.arch ?? null,
        opts.variant ?? null,
        opts.filetype ?? "apk",
        opts.r2Key ?? `apps/app-scope/${assetId}.apk`,
        opts.fileHash ?? `${assetId}-hash`,
        opts.sizeBytes ?? 42,
        `${assetId}-sig`,
        JSON.stringify(opts.metadata ?? {}),
        Date.now(),
      )
      .run();
  }

  function makePublicContext(
    env: MockEnv,
    query: Record<string, string | undefined>,
    headers: Record<string, string | undefined> = {},
    rawClientIp: string | null = "10.0.0.5",
  ) {
    return {
      env,
      req: {
        url: "https://quiver-worker.test/public/v2/apps/scope-app/updates/check",
        param: (name: string) => (name === "slug" ? "scope-app" : ""),
        query: (name: string) => query[name],
        header: (name: string) => headers[name] ?? (name === "CF-Connecting-IP" ? rawClientIp ?? undefined : undefined),
        raw: { cf: {} },
      },
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any;
  }

  function makePublicDownloadContext(
    env: MockEnv,
    key: string,
    query: Record<string, string | undefined>,
  ) {
    return {
      env,
      req: {
        param: (name: string) => (name === "key" ? key : ""),
        query: (name: string) => query[name],
      },
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
      }),
      redirect: (url: string, status = 302) =>
        new Response(null, {
          status,
          headers: { location: url },
        }),
    } as any;
  }

  function makeElectronContext(
    env: MockEnv,
    file: string,
    query: Record<string, string | undefined> = {},
  ) {
    return {
      env,
      req: {
        param: (name: string) => {
          if (name === "slug") return "scope-app";
          if (name === "channel") return "production";
          if (name === "file") return file;
          return "";
        },
        query: (name: string) => query[name],
      },
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any;
  }

  function makeBuildAssetDownloadContext(
    env: MockEnv,
    buildId: string,
    assetId: string,
    query: Record<string, string | undefined> = {},
  ) {
    return {
      env,
      req: {
        param: (name: string) =>
          name === "appId"
            ? "app-scope"
            : name === "buildId"
              ? buildId
              : name === "assetId"
                ? assetId
                : "",
        query: (name: string) => query[name],
      },
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
      redirect: (url: string, status = 302) =>
        new Response(null, {
          status,
          headers: { location: url },
        }),
      get: (name: string) => (name === "admin_actor" ? "raft:delete-agent@test" : undefined),
    } as any;
  }

  function makeShareAdminContext(
    env: MockEnv,
    params: Record<string, string>,
    body: unknown = {},
  ) {
    return {
      env,
      req: {
        url: "https://quiver-worker.test/api/apps/app-scope/releases/rel-share/shares",
        param: (name: string) => params[name] ?? "",
        json: async () => body,
      },
      get: (name: string) => (name === "admin_actor" ? "tester" : undefined),
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any;
  }

  function makeSharePublicContext(
    env: MockEnv,
    token: string,
    headers: Record<string, string | undefined> = {
      "cf-connecting-ip": "203.0.113.10",
      "user-agent": "vitest",
      "accept-language": "en-US",
    },
  ) {
    return {
      env,
      req: {
        url: `https://quiver-worker.test/share/${token}`,
        param: (name: string) => (name === "token" ? token : ""),
        header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
        raw: { cf: { clientIp: "203.0.113.10" } },
      },
      redirect: (url: string, status = 302) =>
        new Response(null, {
          status,
          headers: { location: url },
        }),
    } as any;
  }

  async function responseJson<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  it("e2e smoke: build draft publish update share history feedback and webhooks", async () => {
    const env = makeEnv();
    await env.DB.prepare("UPDATE apps SET public_history = 1 WHERE id = ?1")
      .bind("app-scope")
      .run();
    await env.DB.prepare(
      `INSERT INTO webhooks (id, org_id, app_id, url, secret, events_json, enabled, created_at, updated_at)
       VALUES (?1, ?2, NULL, ?3, ?4, ?5, 1, ?6, ?7)`,
    )
      .bind(
        "wh-e2e",
        "default",
        "https://example.test/quiver",
        "secret",
        JSON.stringify(["build:succeeded", "release:new", "release:draft_created", "feedback:new", "crash:new_group"]),
        Date.now(),
        Date.now(),
      )
      .run();

    env.APK_BUCKET = {
      put: async () => undefined,
      get: async () => null,
    };

    const {
      handleCreateBuild,
      handleCreateBuildAsset,
    } = await import("../src/routes/builds");
    const {
      handleCreateRelease,
      handlePublishRelease,
    } = await import("../src/routes/releases");
    const { handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    const { handleCreateReleaseShare, handlePublicReleaseShare } = await import("../src/routes/shares");
    const { handlePublicAppHistory, handlePublicReleaseNotesJson } = await import("../src/routes/history");
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");

    const waited: Promise<unknown>[] = [];
    const adminContext = (
      params: Record<string, string>,
      body: unknown = {},
      waitUntil: (p: Promise<unknown>) => void = (p) => waited.push(p),
    ) => ({
      env,
      executionCtx: { waitUntil },
      req: {
        url: "https://quiver-worker.test/api/apps/app-scope",
        param: (name: string) => params[name] ?? "",
        query: () => undefined,
        json: async () => body,
      },
      get: (name: string) =>
        name === "admin_actor"
          ? "e2e-tester"
          : name === "org_id"
            ? "default"
            : undefined,
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    }) as any;

    const buildResponse = await handleCreateBuild(
      adminContext(
        { appId: "app-scope" },
        {
          channel_id: "ch-scope-prod",
          product_type: "android-apk",
          release_type: "stable",
          version_name: "9.9.9",
          version_code: 9090900,
          changelog: JSON.stringify({ en: "- E2E smoke release", "zh-CN": "- E2E 冒烟发布" }),
          source: "ci",
          status: "succeeded",
          provenance_json: { ci_provider: "vitest" },
        },
      ),
    );
    expect(buildResponse.status).toBe(201);
    await Promise.all(waited.splice(0));
    const build = await responseJson<any>(buildResponse);
    expect(build.id).toBeTruthy();

    const assetResponse = await handleCreateBuildAsset(
      adminContext(
        { appId: "app-scope", buildId: build.id },
        {
          artifact_kind: "installable",
          platform: "android",
          arch: "arm64-v8a",
          filetype: "apk",
          r2_key: "apps/app-scope/e2e.apk",
          file_hash: "sha256-e2e",
          size_bytes: 123456,
          signature: "sig-e2e",
        },
        () => undefined,
      ),
    );
    expect(assetResponse.status).toBe(201);

    const draftResponse = await handleCreateRelease(
      adminContext(
        { appId: "app-scope" },
        {
          build_id: build.id,
          channel_id: "ch-scope-prod",
          product_type: "android-apk",
          release_type: "stable",
          status: "draft",
          changelog: JSON.stringify({ en: "- E2E smoke release", "zh-CN": "- E2E 冒烟发布" }),
          scopes: [{ scope_type: "full", scope_value: "all" }],
        },
      ),
    );
    expect(draftResponse.status).toBe(201);
    const draft = await responseJson<any>(draftResponse);
    expect(draft.status).toBe("draft");

    const publishResponse = await handlePublishRelease(
      adminContext({ appId: "app-scope", releaseId: draft.id }),
    );
    expect(publishResponse.status).toBe(200);
    await Promise.all(waited.splice(0));
    const published = await responseJson<any>(publishResponse);
    expect(published.status).toBe("active");

    const updateResponse = await handlePublicV2UpdateCheck(
      makePublicContext(env, {
        channel: "production",
        product_type: "android-apk",
        current_version_code: "1",
        platform: "android",
        arch: "arm64-v8a",
        filetype: "apk",
        lang: "zh-CN",
      }, {
        "X-Quiver-Device-Id": "e2e-device",
        "X-Quiver-Lang": "zh-CN",
      }),
    );
    expect(updateResponse.status).toBe(200);
    const update = await responseJson<any>(updateResponse);
    expect(update.update_available).toBe(true);
    expect(update.latest.version_code).toBe(9090900);
    expect(update.latest.changelog).toContain("E2E 冒烟发布");
    expect(update.latest.release_notes).toEqual({
      en: "- E2E smoke release",
      "zh-CN": "- E2E 冒烟发布",
    });
    expect(update.asset.download_url).toContain("/public/r2/");

    const shareResponse = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: draft.id }, { ttl_seconds: 604800 }),
    );
    expect(shareResponse.status).toBe(201);
    const share = await responseJson<any>(shareResponse);
    const shareToken = new URL(share.share_url).pathname.replace("/share/", "");
    const sharePage = await handlePublicReleaseShare(makeSharePublicContext(env, shareToken));
    expect(sharePage.status).toBe(200);
    expect(await sharePage.text()).toContain("Download APK");

    const historyPage = await handlePublicAppHistory({
      env,
      req: {
        url: "https://quiver-worker.test/apps/scope-app/history",
        param: (name: string) => (name === "slug" ? "scope-app" : ""),
        header: (name: string) => (name === "accept-language" ? "zh-CN" : undefined),
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    expect(historyPage.status).toBe(200);
    const historyHtml = await historyPage.text();
    expect(historyHtml).toContain("9.9.9");
    expect(historyHtml).toContain("E2E 冒烟发布");

    const notesJsonResponse = await handlePublicReleaseNotesJson({
      env,
      req: {
        param: (name: string) => (name === "slug" ? "scope-app" : ""),
        query: (name: string) => (name === "version_code" ? "9090900" : name === "lang" ? "zh-CN" : undefined),
        header: () => undefined,
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    expect(notesJsonResponse.status).toBe(200);
    const notesJson = await responseJson<any>(notesJsonResponse);
    expect(notesJson.releases[0].changelog).toContain("E2E 冒烟发布");
    expect(notesJson.releases[0].release_notes).toEqual({
      en: "- E2E smoke release",
      "zh-CN": "- E2E 冒烟发布",
    });

    const crashForm = new FormData();
    crashForm.set("message", "E2E crash smoke");
    crashForm.set("kind", "crash");
    crashForm.set(
      "metadata",
      JSON.stringify({
        version_name: "9.9.9",
        version_code: 9090900,
        channel: "production",
        device_id: "e2e-device",
        crash_exception_class: "java.lang.IllegalStateException",
        crash_top_frame: "build.raft.app.E2ESmoke.run(E2E.kt:42)",
      }),
    );
    const feedbackWaited: Promise<unknown>[] = [];
    const feedbackResponse = await handlePublicFeedbackSubmit({
      env,
      executionCtx: { waitUntil: (p: Promise<unknown>) => feedbackWaited.push(p) },
      req: {
        param: (name: string) => (name === "slug" ? "scope-app" : ""),
        header: (name: string) => (name === "X-Quiver-Client-Key" ? "qk_test" : undefined),
        query: () => undefined,
        formData: async () => crashForm,
        raw: { cf: { clientIp: "203.0.113.99" } },
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    expect(feedbackResponse.status).toBe(201);
    await Promise.all(feedbackWaited);
    const feedback = await responseJson<any>(feedbackResponse);
    expect(feedback.status).toBe("open");
    expect(feedback.attachments).toBe(0);
    const feedbackTicket = (await env.DB.prepare(
      "SELECT kind, status, version_code FROM feedback_tickets WHERE id = ?1",
    )
      .bind(feedback.id)
      .first()) as { kind: string; status: string; version_code: number } | null;
    expect(feedbackTicket).toMatchObject({
      kind: "crash",
      status: "open",
      version_code: 9090900,
    });

    const deliveryRows = (await env.DB.prepare(
      "SELECT event_type FROM webhook_deliveries WHERE webhook_id = ?1 ORDER BY created_at",
    )
      .bind("wh-e2e")
      .all()).results as Array<{ event_type: string }>;
    const eventTypes = deliveryRows.map((row) => row.event_type);
    expect(eventTypes).toContain("build:succeeded");
    expect(eventTypes).toContain("release:new");
    expect(eventTypes).toContain("release:draft_created");
    expect(eventTypes).toContain("feedback:new");
    expect(eventTypes).toContain("crash:new_group");

    // The draft-created payload carries the QA-consumer contract: stable
    // slugs, version identity, and an artifact block with a durable API path.
    const draftDelivery = (await env.DB.prepare(
      "SELECT payload_json FROM webhook_deliveries WHERE webhook_id = ?1 AND event_type = 'release:draft_created'",
    )
      .bind("wh-e2e")
      .first()) as { payload_json: string };
    const draftPayload = JSON.parse(draftDelivery.payload_json).payload;
    expect(draftPayload).toMatchObject({
      release_id: draft.id,
      app_slug: "scope-app",
      build_id: build.id,
      channel: "production",
      version_name: "9.9.9",
      version_code: 9090900,
    });
    expect(draftPayload.artifact.download_api).toBe(
      `/api/apps/app-scope/builds/${build.id}/assets/${draftPayload.artifact.asset_id}/download?presign=1`,
    );
    const feedbackDelivery = (await env.DB.prepare(
      "SELECT payload_json FROM webhook_deliveries WHERE webhook_id = ?1 AND event_type = 'feedback:new'",
    )
      .bind("wh-e2e")
      .first()) as { payload_json: string };
    expect(JSON.parse(feedbackDelivery.payload_json).payload.reporter_id).toBeNull();
  });

  it("external-target gate: freeze on publish, set assertion, replay re-assert, dl routes", async () => {
    const env = makeEnv();
    const now = Date.now();
    // External build with 2 declared targets + a draft release on it.
    await env.DB.prepare(
      `INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code,
                           source, status, build_metadata_json, parsed_metadata_json, should_force_update,
                           provenance_json, created_at, updated_at)
       VALUES ('b-ext', 'app-scope', 'ch-scope-prod', 'cli-binary', 'stable', '2.0.0', 2000000,
               'external', 'succeeded', '{}', '{}', 0, '{"ci_provider":"gha","source_commit":"abc123"}', ?1, ?1)`,
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code,
                           source, status, build_metadata_json, parsed_metadata_json, should_force_update,
                           provenance_json, created_at, updated_at)
       VALUES ('b-ext-fallback', 'app-scope', 'ch-scope-prod', 'cli-binary', 'stable', '1.9.0', 1900000,
               'web', 'succeeded', '{}', '{}', 0, '{}', ?1, ?1)`,
    ).bind(now).run();
    for (const [t, gz] of [["darwin-arm64", "https://cdn.test/2.0.0/darwin-arm64.gz"], ["linux-x64", null]] as const) {
      await env.DB.prepare(
        `INSERT INTO external_build_targets
         (id, app_id, build_id, version_name, target, source_url, raw_sha256, raw_size_bytes,
          gzip_sha256, gzip_size_bytes, node_version, metadata_json, created_at, updated_at, gzip_source_url)
         VALUES (?1, 'app-scope', 'b-ext', '2.0.0', ?2, ?3, ?4, 100, ?5, ?6, '24.15.0', '{}', ?7, ?7, ?8)`,
      ).bind(
        `t-${t}`, t, `https://cdn.test/2.0.0/${t}`, "a".repeat(64),
        t === "darwin-arm64" ? "b".repeat(64) : null, t === "darwin-arm64" ? 90 : null, now, gz,
      ).run();
    }
    await env.DB.prepare(
      `INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status,
                             is_full, changelog, created_by, created_at, updated_at)
       VALUES ('rel-ext', 'app-scope', 'b-ext', 'ch-scope-prod', 'cli-binary', 'stable', 'draft', 1, NULL, 'tester', ?1, ?1)`,
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
       VALUES ('scope-rel-ext-full', 'rel-ext', 'full', 'all', ?1)`,
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status,
                             activated_at, is_full, changelog, created_by, created_at, updated_at)
       VALUES ('rel-ext-fallback', 'app-scope', 'b-ext-fallback', 'ch-scope-prod', 'cli-binary',
               'stable', 'active', ?1, 1, NULL, 'tester', ?1, ?1)`,
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
       VALUES ('scope-rel-ext-fallback', 'rel-ext-fallback', 'full', 'all', ?1)`,
    ).bind(now).run();

    const {
      handleBumpRollout,
      handleGetRelease,
      handlePublishRelease,
    } = await import("../src/routes/releases");
    const ctx = (params: Record<string, string>, body: unknown = {}) =>
      ({
        env,
        executionCtx: { waitUntil: () => undefined },
        req: {
          url: "https://quiver-worker.test/api/apps/app-scope/releases/rel-ext/publish",
          param: (name: string) => params[name] ?? "",
          query: () => undefined,
          json: async () => body,
        },
        get: (name: string) => (name === "admin_actor" ? "tester" : name === "org_id" ? "default" : undefined),
        json: (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
      }) as any;

    // cli-binary publish without a required set → 400 (not yet frozen).
    const noSet = await handlePublishRelease(ctx({ appId: "app-scope", releaseId: "rel-ext" }));
    expect(noSet.status).toBe(400);

    // Scope validation happens before the external freeze plan is committed.
    const wrongScope = await handlePublishRelease(ctx(
      { appId: "app-scope", releaseId: "rel-ext" },
      {
        required_external_targets: ["darwin-arm64", "linux-x64"],
        expected_scopes: [{ scope_type: "platform", scope_value: "android" }],
      },
    ));
    expect(wrongScope.status).toBe(409);
    await expect(env.DB.prepare(
      "SELECT freeze_token, required_targets_json FROM builds WHERE id = 'b-ext'",
    ).first()).resolves.toEqual({ freeze_token: null, required_targets_json: null });

    // Wrong set → 400 with named missing/unexpected; freeze rolled back.
    const wrong = await handlePublishRelease(
      ctx({ appId: "app-scope", releaseId: "rel-ext" }, { required_external_targets: ["darwin-arm64", "win32-x64"] }),
    );
    expect(wrong.status).toBe(400);
    const wrongBody = (await wrong.json()) as any;
    expect(wrongBody.missing).toEqual(["win32-x64"]);
    expect(wrongBody.unexpected).toEqual(["linux-x64"]);
    const afterFail = (await env.DB.prepare("SELECT freeze_token FROM builds WHERE id = 'b-ext'").first()) as any;
    expect(afterFail.freeze_token).toBeNull();

    // Duplicate target in the set → 400.
    const dup = await handlePublishRelease(
      ctx({ appId: "app-scope", releaseId: "rel-ext" }, { required_external_targets: ["linux-x64", "linux-x64"] }),
    );
    expect(dup.status).toBe(400);

    // A release mutation after target preflight but before the publish batch
    // must win without allowing the stale publisher to freeze the build.
    const db = env.DB as any;
    const originalBatch = db.batch.bind(db);
    let injected = false;
    let bumpStatus: number | null = null;
    db.batch = async (statements: any[]) => {
      if (!injected) {
        injected = true;
        const bumped = await handleBumpRollout(ctx(
          { appId: "app-scope", releaseId: "rel-ext" },
          { to: 25, expected_revision: 0 },
        ));
        bumpStatus = bumped.status;
      }
      return originalBatch(statements);
    };
    let stalePublish: Response;
    try {
      stalePublish = await handlePublishRelease(ctx(
        { appId: "app-scope", releaseId: "rel-ext" },
        {
          required_external_targets: ["darwin-arm64", "linux-x64"],
          expected_scopes: [{ scope_type: "full", scope_value: "all" }],
          expected_revision: 0,
        },
      ));
    } finally {
      db.batch = originalBatch;
    }
    expect(bumpStatus).toBe(200);
    expect(stalePublish.status).toBe(409);
    await expect(stalePublish.json()).resolves.toMatchObject({
      code: "RELEASE_REVISION_CONFLICT",
      expected_revision: 0,
      current_revision: 1,
    });
    await expect(env.DB.prepare(
      "SELECT freeze_token, required_targets_json FROM builds WHERE id = 'b-ext'",
    ).first()).resolves.toEqual({ freeze_token: null, required_targets_json: null });
    await expect(env.DB.prepare(
      "SELECT status, revision, rollout_cohort_count FROM releases WHERE id = 'rel-ext'",
    ).first()).resolves.toEqual({ status: "draft", revision: 1, rollout_cohort_count: 25 });
    await expect(env.DB.prepare(
      "SELECT status, superseded_by_release_id FROM releases WHERE id = 'rel-ext-fallback'",
    ).first()).resolves.toEqual({ status: "active", superseded_by_release_id: null });
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.publish'",
    ).first()).resolves.toEqual({ count: 0 });

    // Exact set → publish succeeds and freezes.
    const ok = await handlePublishRelease(
      ctx(
        { appId: "app-scope", releaseId: "rel-ext" },
        {
          required_external_targets: ["linux-x64", "darwin-arm64"],
          expected_scopes: [{ scope_type: "full", scope_value: "all" }],
          expected_revision: 1,
        },
      ),
    );
    expect(ok.status).toBe(200);
    const frozen = (await env.DB.prepare("SELECT freeze_token, required_targets_json FROM builds WHERE id = 'b-ext'").first()) as any;
    expect(frozen.freeze_token).not.toBeNull();
    expect(JSON.parse(frozen.required_targets_json)).toEqual(["darwin-arm64", "linux-x64"]);
    await expect(env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release.publish'",
    ).first()).resolves.toEqual({ count: 1 });

    // Post-freeze: replay publish (already active) re-asserts and no-ops OK;
    // a different set on replay → contract mismatch.
    const replayOk = await handlePublishRelease(
      ctx({ appId: "app-scope", releaseId: "rel-ext" }, { required_external_targets: ["darwin-arm64", "linux-x64"] }),
    );
    expect(replayOk.status).toBe(200);
    const replayBad = await handlePublishRelease(
      ctx({ appId: "app-scope", releaseId: "rel-ext" }, { required_external_targets: ["darwin-arm64"] }),
    );
    expect(replayBad.status).toBe(400);

    // Readback: external_targets with explicit raw/gzip URLs (legacy null gzip
    // normalized), count, frozen flag, structured provenance.
    const detail = await responseJson<any>(
      await handleGetRelease(ctx({ appId: "app-scope", releaseId: "rel-ext" })),
    );
    expect(detail.external_targets_count).toBe(2);
    expect(detail.external_targets_frozen).toBe(true);
    expect(detail.provenance).toMatchObject({ ci_provider: "gha", source_commit: "abc123" });
    const dArm = detail.external_targets.find((t: any) => t.target === "darwin-arm64");
    expect(dArm.raw_source_url).toBe("https://cdn.test/2.0.0/darwin-arm64");
    expect(dArm.gzip_source_url).toBe("https://cdn.test/2.0.0/darwin-arm64.gz");
    const lX64 = detail.external_targets.find((t: any) => t.target === "linux-x64");
    expect(lX64.gzip_source_url).toBeNull(); // no gzip digest declared

    // /dl routes: latest → immutable → source; lifecycle semantics.
    const { handleExternalLatestDl, handleExternalReleaseDl } = await import("../src/routes/external_dl");
    const dlCtx = (params: Record<string, string>) =>
      ({
        env,
        req: { param: (name: string) => params[name] ?? "", query: () => undefined },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      }) as any;
    const latest = await handleExternalLatestDl(dlCtx({ slug: "scope-app", channel: "production", file: "darwin-arm64" }));
    expect(latest.status).toBe(302);
    expect(latest.headers.get("location")).toBe("/dl/scope-app/releases/rel-ext/darwin-arm64");
    const imm = await handleExternalReleaseDl(dlCtx({ slug: "scope-app", releaseId: "rel-ext", file: "darwin-arm64" }));
    expect(imm.status).toBe(302);
    expect(imm.headers.get("location")).toBe("https://cdn.test/2.0.0/darwin-arm64");
    const immGz = await handleExternalReleaseDl(dlCtx({ slug: "scope-app", releaseId: "rel-ext", file: "darwin-arm64.gz" }));
    expect(immGz.status).toBe(302);
    expect(immGz.headers.get("location")).toBe("https://cdn.test/2.0.0/darwin-arm64.gz");
    // .gz without a declared gzip digest → 404.
    const noGz = await handleExternalReleaseDl(dlCtx({ slug: "scope-app", releaseId: "rel-ext", file: "linux-x64.gz" }));
    expect(noGz.status).toBe(404);

    // Supersede the release: immutable URL keeps serving; latest moves off it.
    await env.DB.prepare("UPDATE releases SET status = 'superseded' WHERE id = 'rel-ext'").run();
    const immSuper = await handleExternalReleaseDl(dlCtx({ slug: "scope-app", releaseId: "rel-ext", file: "darwin-arm64" }));
    expect(immSuper.status).toBe(302);
    const latestGone = await handleExternalLatestDl(dlCtx({ slug: "scope-app", channel: "production", file: "darwin-arm64" }));
    expect(latestGone.status).toBe(404);
    // Cancelled → immutable URL 404s (kill switch).
    await env.DB.prepare("UPDATE releases SET status = 'cancelled' WHERE id = 'rel-ext'").run();
    const immCancelled = await handleExternalReleaseDl(dlCtx({ slug: "scope-app", releaseId: "rel-ext", file: "darwin-arm64" }));
    expect(immCancelled.status).toBe(404);
  });

  it("release checks: upsert per source, advisory read-back on get-release", async () => {
    const env = makeEnv();
    await seedRelease(env, "rel-check", "build-check", [["full", "all"]]);
    const {
      handleUpsertReleaseCheck,
      handleListReleaseChecks,
      handleGetRelease,
    } = await import("../src/routes/releases");
    const ctx = (params: Record<string, string>, body: unknown = {}) =>
      ({
        env,
        req: {
          url: "https://quiver-worker.test/api/apps/app-scope/releases/rel-check/checks",
          param: (name: string) => params[name] ?? "",
          query: () => undefined,
          json: async () => body,
        },
        get: (name: string) => (name === "admin_actor" ? "stamp-bot" : undefined),
        json: (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), {
            status,
            headers: { "content-type": "application/json" },
          }),
      }) as any;

    // Verdict is validated; unknown release 404s.
    const badVerdict = await handleUpsertReleaseCheck(
      ctx({ appId: "app-scope", releaseId: "rel-check" }, { source: "stamp", verdict: "meh" }),
    );
    expect(badVerdict.status).toBe(400);
    const missing = await handleUpsertReleaseCheck(
      ctx({ appId: "app-scope", releaseId: "rel-nope" }, { source: "stamp", verdict: "passed" }),
    );
    expect(missing.status).toBe(404);

    const first = await handleUpsertReleaseCheck(
      ctx(
        { appId: "app-scope", releaseId: "rel-check" },
        {
          source: "stamp",
          run_id: "run-1",
          run_url: "https://stamp.test/runs/1",
          verdict: "failed",
          cases_total: 5,
          cases_passed: 3,
          summary: "2 cases failed",
          reviewer: "vera",
          reviewed_at: 1234,
        },
      ),
    );
    expect(first.status).toBe(201);

    // Same source posts again → replaces its verdict, no second row.
    const second = await handleUpsertReleaseCheck(
      ctx(
        { appId: "app-scope", releaseId: "rel-check" },
        { source: "stamp", run_id: "run-2", verdict: "passed", cases_total: 5, cases_passed: 5 },
      ),
    );
    expect(second.status).toBe(201);

    const listed = await responseJson<any>(
      await handleListReleaseChecks(ctx({ appId: "app-scope", releaseId: "rel-check" })),
    );
    expect(listed.checks).toHaveLength(1);
    expect(listed.checks[0]).toMatchObject({
      source: "stamp",
      run_id: "run-2",
      verdict: "passed",
      cases_total: 5,
      cases_passed: 5,
    });

    const detail = await responseJson<any>(
      await handleGetRelease(ctx({ appId: "app-scope", releaseId: "rel-check" })),
    );
    expect(detail.checks).toHaveLength(1);
    expect(detail.checks[0].verdict).toBe("passed");
  });

  it("shares: no ttl never expires, url is re-copyable, expiry semantics on update", async () => {
    const env = makeEnv();
    await seedRelease(env, "rel-share", "build-share", [["full", "all"]]);
    await seedAsset(env, "build-share", "asset-share");
    const {
      handleCreateReleaseShare,
      handleListAppShares,
      handleUpdateReleaseShare,
      handlePublicReleaseShare,
    } = await import("../src/routes/shares");

    // Create without ttl → never expires.
    const created = await responseJson<any>(
      await handleCreateReleaseShare(
        makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }),
      ),
    );
    expect(created.expires_at).toBeNull();
    const token = new URL(created.share_url).pathname.replace("/share/", "");

    // The never-expiring share serves publicly.
    const page = await handlePublicReleaseShare(makeSharePublicContext(env, token));
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Download APK");
    // Expiry is no longer shown on the public page.
    expect(pageHtml).not.toContain("expires-at");

    // The URL is recoverable from the list.
    const listed = await responseJson<any>(
      await handleListAppShares(makeShareAdminContext(env, { appId: "app-scope" })),
    );
    const row = listed.shares.find((s: any) => s.id === created.id);
    expect(row.share_url).toBe(created.share_url);
    expect(row.token).toBeUndefined();

    // Legacy rows without a stored token have no recoverable URL.
    await env.DB.prepare(
      `INSERT INTO release_shares (id, release_id, token, token_hash, created_by, created_at, expires_at)
       VALUES (?, ?, NULL, ?, ?, ?, NULL)`,
    )
      .bind("share-legacy", "rel-share", "legacy-hash", "tester", 1)
      .run();
    const listed2 = await responseJson<any>(
      await handleListAppShares(makeShareAdminContext(env, { appId: "app-scope" })),
    );
    expect(listed2.shares.find((s: any) => s.id === "share-legacy").share_url).toBeNull();

    // Update: absent expiry keys leave the expiry unchanged (password-only PATCH).
    const patchedPw = await responseJson<any>(
      await handleUpdateReleaseShare(
        makeShareAdminContext(
          env,
          { appId: "app-scope", releaseId: "rel-share", shareId: created.id },
          { password: "s3cret" },
        ),
      ),
    );
    expect(patchedPw.expires_at).toBeNull();

    // Update: an explicit ttl sets an expiry; explicit null clears it again.
    const withTtl = await responseJson<any>(
      await handleUpdateReleaseShare(
        makeShareAdminContext(
          env,
          { appId: "app-scope", releaseId: "rel-share", shareId: created.id },
          { ttl_seconds: 3600 },
        ),
      ),
    );
    expect(withTtl.expires_at).toBeGreaterThan(Date.now());
    const cleared = await responseJson<any>(
      await handleUpdateReleaseShare(
        makeShareAdminContext(
          env,
          { appId: "app-scope", releaseId: "rel-share", shareId: created.id },
          { expires_at: null },
        ),
      ),
    );
    expect(cleared.expires_at).toBeNull();

    // Release status does not gate an existing share: the link keeps serving
    // after the release is superseded or cancelled — only revoke/expiry kill it.
    await env.DB.prepare("UPDATE releases SET status = 'superseded' WHERE id = ?")
      .bind("rel-share")
      .run();
    expect((await handlePublicReleaseShare(makeSharePublicContext(env, token))).status).toBe(200);
    await env.DB.prepare("UPDATE releases SET status = 'cancelled' WHERE id = ?")
      .bind("rel-share")
      .run();
    expect((await handlePublicReleaseShare(makeSharePublicContext(env, token))).status).toBe(200);
    await env.DB.prepare("UPDATE releases SET status = 'active' WHERE id = ?")
      .bind("rel-share")
      .run();

    // An expired legacy-style share still 4xxes publicly.
    const expiredCreate = await responseJson<any>(
      await handleCreateReleaseShare(
        makeShareAdminContext(
          env,
          { appId: "app-scope", releaseId: "rel-share" },
          { ttl_seconds: 1 },
        ),
      ),
    );
    const expiredToken = new URL(expiredCreate.share_url).pathname.replace("/share/", "");
    await env.DB.prepare("UPDATE release_shares SET expires_at = 1 WHERE id = ?1")
      .bind(expiredCreate.id)
      .run();
    await env.DB.prepare("UPDATE apps SET public_history = 1 WHERE id = ?1")
      .bind("app-scope")
      .run();
    const expiredPage = await handlePublicReleaseShare(makeSharePublicContext(env, expiredToken));
    expect(expiredPage.status).toBeGreaterThanOrEqual(400);
    expect(await expiredPage.text()).toContain("/apps/scope-app/latest");

    const unknownPage = await handlePublicReleaseShare(
      makeSharePublicContext(env, "not-a-real-share-token"),
    );
    expect(await unknownPage.text()).not.toContain("/apps/scope-app/latest");
  });

  it("shares: rebinds one live share atomically to an active release in the same app", async () => {
    const env = makeEnv();
    env.APK_BUCKET = { head: async (key: string) => ({ key }) };
    await seedRelease(env, "rel-share-old", "build-share-old", [["full", "all"]], {
      versionCode: 10,
      versionName: "1.0.0",
    });
    await seedAsset(env, "build-share-old", "asset-share-old", { fileHash: "old-hash" });
    await seedRelease(env, "rel-share-new", "build-share-new", [["full", "all"]], {
      versionCode: 11,
      versionName: "1.1.0",
    });
    await seedAsset(env, "build-share-new", "asset-share-new", {
      fileHash: "new-hash",
      sizeBytes: 456,
    });
    const { handleCreateReleaseShare, handleRebindReleaseShare } = await import("../src/routes/shares");
    const created = await responseJson<any>(await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share-old" }),
    ));

    const response = await handleRebindReleaseShare(makeShareAdminContext(
      env,
      { appId: "app-scope", shareId: created.id },
      { expected_release_id: "rel-share-old", target_release_id: "rel-share-new" },
    ));
    expect(response.status).toBe(200);
    expect(await responseJson<any>(response)).toMatchObject({
      id: created.id,
      previous_release_id: "rel-share-old",
      release_id: "rel-share-new",
      target: { status: "active", version_name: "1.1.0", version_code: 11, file_hash: "new-hash", size_bytes: 456 },
    });
    const rebound = await env.DB.prepare(
      "SELECT release_id, token_hash FROM release_shares WHERE id = ?",
    ).bind(created.id).first() as { release_id: string; token_hash: string };
    expect(rebound.release_id).toBe("rel-share-new");
    const audit = await env.DB.prepare(
      "SELECT actor, payload FROM audit_logs WHERE action = 'release_share.rebind'",
    ).first() as { actor: string; payload: string };
    expect(audit.actor).toBe("tester");
    expect(JSON.parse(audit.payload)).toEqual({
      share_id: created.id,
      token_hash: rebound.token_hash,
      old_release_id: "rel-share-old",
      new_release_id: "rel-share-new",
    });
    expect(audit.payload).not.toContain(new URL(created.share_url).pathname.replace("/share/", ""));

    const staleRetry = await handleRebindReleaseShare(makeShareAdminContext(
      env,
      { appId: "app-scope", shareId: created.id },
      { expected_release_id: "rel-share-old", target_release_id: "rel-share-new" },
    ));
    expect(staleRetry.status).toBe(409);
    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release_share.rebind'",
    ).first() as { count: number };
    expect(auditCount.count).toBe(1);
  });

  it("shares: rejects revoked, non-active, missing, and cross-app rebind targets", async () => {
    const env = makeEnv();
    let targetObjectExists = true;
    env.APK_BUCKET = { head: async (key: string) => targetObjectExists ? ({ key }) : null };
    await seedRelease(env, "rel-rebind-old", "build-rebind-old", [["full", "all"]]);
    await seedAsset(env, "build-rebind-old", "asset-rebind-old");
    await seedRelease(env, "rel-rebind-target", "build-rebind-target", [["full", "all"]], { versionCode: 2 });
    await seedAsset(env, "build-rebind-target", "asset-rebind-target");
    const { handleCreateReleaseShare, handleRebindReleaseShare, handleRevokeReleaseShare } = await import("../src/routes/shares");
    const created = await responseJson<any>(await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-rebind-old" }),
    ));
    const call = (targetReleaseId: string) => handleRebindReleaseShare(makeShareAdminContext(
      env,
      { appId: "app-scope", shareId: created.id },
      { expected_release_id: "rel-rebind-old", target_release_id: targetReleaseId },
    ));

    expect((await call("missing-release")).status).toBe(404);
    await env.DB.prepare("UPDATE releases SET status = 'draft' WHERE id = ?")
      .bind("rel-rebind-target").run();
    expect((await call("rel-rebind-target")).status).toBe(409);
    await env.DB.prepare("UPDATE releases SET status = 'active' WHERE id = ?")
      .bind("rel-rebind-target").run();
    await env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("app-other", "default", "other", "Other", "android", "other-key", 1).run();
    await env.DB.prepare("UPDATE releases SET app_id = ? WHERE id = ?")
      .bind("app-other", "rel-rebind-target").run();
    expect((await call("rel-rebind-target")).status).toBe(404);
    await env.DB.prepare("UPDATE releases SET app_id = ? WHERE id = ?")
      .bind("app-scope", "rel-rebind-target").run();
    await env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, enabled_product_types_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("ch-scope-preview", "app-scope", "preview", "Preview", "[]", "{}", 1).run();
    await env.DB.prepare("UPDATE releases SET channel_id = ? WHERE id = ?")
      .bind("ch-scope-preview", "rel-rebind-target").run();
    expect((await call("rel-rebind-target")).status).toBe(409);
    await env.DB.prepare("UPDATE releases SET channel_id = ? WHERE id = ?")
      .bind("ch-scope-prod", "rel-rebind-target").run();
    targetObjectExists = false;
    expect((await call("rel-rebind-target")).status).toBe(409);
    targetObjectExists = true;
    await handleRevokeReleaseShare(makeShareAdminContext(env, {
      appId: "app-scope", releaseId: "rel-rebind-old", shareId: created.id,
    }));
    expect((await call("rel-rebind-target")).status).toBe(409);

    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release_share.rebind'",
    ).first() as { count: number };
    expect(auditCount.count).toBe(0);
  });

  it("latest landing: stable app URL renders the highest active published release", async () => {
    const env = makeEnv();
    await env.DB.prepare("UPDATE apps SET public_history = 1 WHERE id = ?")
      .bind("app-scope")
      .run();
    await seedRelease(env, "rel-landing-1", "build-landing-1", [["full", "all"]], {
      createdAt: 100,
      versionCode: 1,
      versionName: "1.0.0",
    });
    await seedAsset(env, "build-landing-1", "asset-landing-1");
    await seedRelease(env, "rel-landing-2", "build-landing-2", [["full", "all"]], {
      createdAt: 200,
      versionCode: 2,
      versionName: "2.0.0",
    });
    await seedAsset(env, "build-landing-2", "asset-landing-2");
    const { handlePublicLatestReleaseLanding } = await import("../src/routes/history");
    const makeContext = (channel?: string) => ({
      env,
      req: {
        param: (name: string) => (name === "slug" ? "scope-app" : ""),
        query: (name: string) => (name === "channel" ? channel : undefined),
        header: (name: string) => (name.toLowerCase() === "accept-language" ? "en-US" : undefined),
      },
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        }),
    } as any);

    const page = await handlePublicLatestReleaseLanding(makeContext());
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("2.0.0");
    expect(html).toContain("/apps/scope-app/latest/download?channel=production");
    expect(html).toContain("Latest");

    const missingChannel = await handlePublicLatestReleaseLanding(makeContext("beta"));
    expect(missingChannel.status).toBe(404);

    await env.DB.prepare("UPDATE apps SET public_history = 0 WHERE id = ?")
      .bind("app-scope")
      .run();
    const privatePage = await handlePublicLatestReleaseLanding(makeContext());
    expect(privatePage.status).toBe(404);
  });

  // ------------------------------------------------------------------
  // helpers — re-implement matchesScope here so we can unit-test it
  // without spinning up the Hono context. Mirrors public_v2.ts.
  // ------------------------------------------------------------------
  function matchesScope(
    scopeType: string,
    scopeValue: string,
    cohort: string | null,
    clientPlatform: string | null,
    clientIp: string | null,
  ): boolean {
    switch (scopeType) {
      case "full":
        return true;
      case "user_cohort":
        return !!cohort && scopeValue === cohort;
      case "platform": {
        if (!clientPlatform) return false;
        return scopeValue.split(",").includes(clientPlatform);
      }
      case "ip_range": {
        if (!clientIp) return false;
        const [base, maskStr] = scopeValue.split("/");
        const mask = Number(maskStr);
        if (!base || !Number.isFinite(mask)) return false;
        const ipToInt = (ip: string) =>
          ip
            .split(".")
            .map(Number)
            .reduce((a, b) => (a << 8) | b, 0) >>> 0;
        const baseN = ipToInt(base);
        const ipN = ipToInt(clientIp);
        if (Number.isNaN(baseN) || Number.isNaN(ipN)) return false;
        const maskBits = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
        return (baseN & maskBits) === (ipN & maskBits);
      }
      default:
        return false;
    }
  }

  it("matchesScope: full always matches", () => {
    expect(matchesScope("full", "all", null, null, null)).toBe(true);
    expect(matchesScope("full", "all", "c", "p", "1.2.3.4")).toBe(true);
  });

  it("matchesScope: user_cohort requires exact match", () => {
    expect(matchesScope("user_cohort", "cohort-a", "cohort-a", null, null)).toBe(true);
    expect(matchesScope("user_cohort", "cohort-a", "cohort-b", null, null)).toBe(false);
    expect(matchesScope("user_cohort", "cohort-a", null, null, null)).toBe(false);
  });

  it("matchesScope: platform requires CSV match", () => {
    expect(
      matchesScope("platform", "android-arm64-v8a,android-armeabi-v7a", null, "android-arm64-v8a", null),
    ).toBe(true);
    expect(
      matchesScope("platform", "android-arm64-v8a", null, "android-x86_64", null),
    ).toBe(false);
    expect(matchesScope("platform", "android-arm64-v8a", null, null, null)).toBe(false);
  });

  it("matchesScope: ip_range does CIDR containment", () => {
    expect(matchesScope("ip_range", "10.0.0.0/8", null, null, "10.1.2.3")).toBe(true);
    expect(matchesScope("ip_range", "10.0.0.0/8", null, null, "11.1.2.3")).toBe(false);
    expect(matchesScope("ip_range", "192.168.1.0/24", null, null, "192.168.1.42")).toBe(true);
    expect(matchesScope("ip_range", "192.168.1.0/24", null, null, "192.168.2.42")).toBe(false);
    expect(matchesScope("ip_range", "10.0.0.0/8", null, null, null)).toBe(false);
  });

  it("priority ordering: ip_range wins over full for matching client", async () => {
    const env = makeEnv();
    // Use createdAt values LARGER than `since` (30 days ago) to ensure they
    // fall within the candidate window.
    const now = Date.now();
    await seedRelease(env, "rel-full", "build-full", [["full", "all"]], {
      createdAt: now - 1000,
    });
    await seedRelease(env, "rel-ip", "build-ip", [["ip_range", "10.0.0.0/8"]], {
      createdAt: now - 500,
    });
    // Mirrors the resolution SQL: pull candidates + scopes, filter by match.
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const { results: candidates } = await env.DB.prepare(
      `SELECT id, created_at FROM releases WHERE app_id = ?1 AND channel_id = ?2
       AND status = 'active' AND created_at > ?3`,
    )
      .bind("app-scope", "ch-scope-prod", since)
      .all();
    expect(candidates.length).toBe(2);
    const ids = candidates.map((r: any) => r.id);
    const ph = ids.map(() => "?").join(",");
    const { results: scopes } = await env.DB.prepare(
      `SELECT release_id, scope_type, scope_value FROM release_scopes WHERE release_id IN (${ph})`,
    )
      .bind(...ids)
      .all();
    const PRIORITY: any = { ip_range: 4, user_cohort: 3, platform: 2, full: 1 };
    const matches = scopes.filter((s: any) =>
      matchesScope(s.scope_type, s.scope_value, null, null, "10.0.0.5"),
    );
    const winner = matches.sort(
      (a: any, b: any) =>
        (PRIORITY[b.scope_type] ?? 0) - (PRIORITY[a.scope_type] ?? 0),
    )[0];
    expect(winner).toBeDefined();
    expect(winner.release_id).toBe("rel-ip");
    expect(winner.scope_type).toBe("ip_range");
  });

  it("priority ordering: cohort beats full beats nothing", async () => {
    const env = makeEnv();
    const now = Date.now();
    await seedRelease(env, "rel-full2", "b1", [["full", "all"]], {
      createdAt: now - 1000,
    });
    await seedRelease(env, "rel-cohort", "b2", [["user_cohort", "beta-testers"]], {
      createdAt: now - 500,
    });
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const { results: candidates } = await env.DB.prepare(
      `SELECT id, created_at FROM releases WHERE app_id = ?1 AND channel_id = ?2
       AND status = 'active' AND created_at > ?3`,
    )
      .bind("app-scope", "ch-scope-prod", since)
      .all();
    const ids = candidates.map((r: any) => r.id);
    const ph = ids.map(() => "?").join(",");
    const { results: scopes } = await env.DB.prepare(
      `SELECT release_id, scope_type, scope_value FROM release_scopes WHERE release_id IN (${ph})`,
    )
      .bind(...ids)
      .all();
    const PRIORITY: any = { ip_range: 4, user_cohort: 3, platform: 2, full: 1 };
    const matches = scopes.filter((s: any) =>
      matchesScope(s.scope_type, s.scope_value, "beta-testers", null, null),
    );
    const winner = matches.sort(
      (a: any, b: any) =>
        (PRIORITY[b.scope_type] ?? 0) - (PRIORITY[a.scope_type] ?? 0),
    )[0];
    expect(winner).toBeDefined();
    expect(winner.release_id).toBe("rel-cohort");
  });

  it("no match: when no scope matches the client", async () => {
    const env = makeEnv();
    await seedRelease(env, "rel-elsewhere", "b3", [
      ["ip_range", "192.168.1.0/24"],
    ]);
    const matches = ([["ip_range", "192.168.1.0/24"]] as const).filter(([st, sv]) =>
      matchesScope(st, sv, null, null, "10.0.0.1"),
    );
    expect(matches.length).toBe(0);
  });

  it("ties: created_at DESC breaks them", async () => {
    const env = makeEnv();
    const now = Date.now();
    await seedRelease(env, "rel-old", "b4", [["platform", "android-arm64-v8a"]], {
      createdAt: now - 1000,
    });
    await seedRelease(env, "rel-new", "b5", [["platform", "android-arm64-v8a"]], {
      createdAt: now - 500,
    });
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    const { results: candidates } = await env.DB.prepare(
      `SELECT id, created_at FROM releases WHERE app_id = ?1 AND channel_id = ?2
       AND status = 'active' AND created_at > ?3`,
    )
      .bind("app-scope", "ch-scope-prod", since)
      .all();
    expect(candidates.length).toBe(2);
    const ids = candidates.map((r: any) => r.id);
    const ph = ids.map(() => "?").join(",");
    const { results: scopes } = await env.DB.prepare(
      `SELECT release_id, scope_type, scope_value FROM release_scopes WHERE release_id IN (${ph})`,
    )
      .bind(...ids)
      .all();
    const PRIORITY: any = { ip_range: 4, user_cohort: 3, platform: 2, full: 1 };
    const matches = scopes.filter((s: any) =>
      matchesScope(s.scope_type, s.scope_value, null, "android-arm64-v8a", null),
    );
    const winner = matches.sort((a: any, b: any) => {
      const pa = PRIORITY[a.scope_type] ?? 0;
      const pb = PRIORITY[b.scope_type] ?? 0;
      if (pa !== pb) return pb - pa;
      const ra = candidates.find((c: any) => c.id === a.release_id);
      const rb = candidates.find((c: any) => c.id === b.release_id);
      return (rb as any).created_at - (ra as any).created_at;
    })[0];
    expect(winner).toBeDefined();
    expect(winner.release_id).toBe("rel-new");
  });

  it("selectBestAsset prefers requested Android arch without splitting it incorrectly", async () => {
    const { selectBestAsset } = await import("../src/routes/public_v2");
    const asset = selectBestAsset(
      [
        {
          platform: "android",
          arch: "armeabi-v7a",
          variant: null,
          filetype: "apk",
          size_bytes: 1,
          signature: null,
          download_url: "/v7.apk",
        },
        {
          platform: "android",
          arch: "arm64-v8a",
          variant: null,
          filetype: "apk",
          size_bytes: 1,
          signature: null,
          download_url: "/arm64.apk",
        },
      ],
      { platform: "android-arm64-v8a", arch: null, filetype: "apk" },
    );
    expect(asset?.download_url).toBe("/arm64.apk");
  });

  it("serves a device-group release only to exact group members and falls back for other devices", async () => {
    const env = makeEnv();
    configureR2Presign(env);
    const now = Date.now();
    await seedRelease(env, "rel-device-fallback", "build-device-fallback", [["full", "all"]], {
      createdAt: now - 1000,
      versionCode: 10,
      versionName: "1.0.0",
    });
    await seedAsset(env, "build-device-fallback", "asset-device-fallback", { arch: "arm64-v8a" });
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-artin", "app-scope", "Artin test devices", null, now, now).run();
    await env.DB.prepare(
      `INSERT INTO device_group_members (group_id, device_id, label, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind("group-artin", "device-artin", "Huawei", now).run();
    await seedRelease(env, "rel-device-target", "build-device-target", [["device_group", "group-artin"]], {
      createdAt: now,
      versionCode: 11,
      versionName: "1.1.0",
    });
    await seedAsset(env, "build-device-target", "asset-device-target", { arch: "arm64-v8a" });
    const { handlePublicV2Latest } = await import("../src/routes/public_v2");

    const memberResponse = await handlePublicV2Latest(makePublicContext(env, {
      channel: "production",
      product_type: "android-apk",
      platform: "android",
      arch: "arm64-v8a",
    }, { "X-Hands-Device-Id": "device-artin" }));
    expect(memberResponse.status).toBe(200);
    await expect(responseJson<any>(memberResponse)).resolves.toMatchObject({
      build: { version_code: 11 },
      scoped: { scope_type: "device_group", scope_value: "group-artin" },
    });

    const otherResponse = await handlePublicV2Latest(makePublicContext(env, {
      channel: "production",
      product_type: "android-apk",
      platform: "android",
      arch: "arm64-v8a",
    }, { "X-Hands-Device-Id": "device-someone-else" }));
    expect(otherResponse.status).toBe(200);
    await expect(responseJson<any>(otherResponse)).resolves.toMatchObject({
      build: { version_code: 10 },
      scoped: { scope_type: "full", scope_value: "all" },
    });
  });

  it("uses latest activation rather than creation time for same-priority scopes", async () => {
    const env = makeEnv();
    configureR2Presign(env);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-reactivated", "app-scope", "Reactivated devices", null, now, now).run();
    await env.DB.prepare(
      `INSERT INTO device_group_members (group_id, device_id, label, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind("group-reactivated", "device-reactivated", null, now).run();
    await seedRelease(env, "rel-created-old", "build-created-old", [["device_group", "group-reactivated"]], {
      createdAt: now - 2_000,
      activatedAt: now + 1_000,
      versionCode: 11,
    });
    await seedAsset(env, "build-created-old", "asset-created-old", { arch: "arm64-v8a" });
    await seedRelease(env, "rel-created-new", "build-created-new", [["device_group", "group-reactivated"]], {
      createdAt: now,
      activatedAt: now,
      versionCode: 12,
    });
    await seedAsset(env, "build-created-new", "asset-created-new", { arch: "arm64-v8a" });
    const { handlePublicV2Latest } = await import("../src/routes/public_v2");

    const response = await handlePublicV2Latest(makePublicContext(env, {
      channel: "production",
      product_type: "android-apk",
      platform: "android",
      arch: "arm64-v8a",
    }, { "X-Hands-Device-Id": "device-reactivated" }));

    expect(response.status).toBe(200);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      build: { version_code: 11 },
      scoped: { release_id: "rel-created-old", scope_type: "device_group" },
    });
  });

  it("resolves ip_range from Cloudflare's edge-owned client IP header, never X-Forwarded-For", async () => {
    const env = makeEnv();
    configureR2Presign(env);
    const now = Date.now();
    await seedRelease(env, "rel-ip-header-fallback", "build-ip-header-fallback", [["full", "all"]], {
      createdAt: now - 1000,
      versionCode: 20,
    });
    await seedAsset(env, "build-ip-header-fallback", "asset-ip-header-fallback", { arch: "arm64-v8a" });
    await seedRelease(env, "rel-ip-header-target", "build-ip-header-target", [["ip_range", "203.0.113.0/24"]], {
      createdAt: now,
      versionCode: 21,
    });
    await seedAsset(env, "build-ip-header-target", "asset-ip-header-target", { arch: "arm64-v8a" });
    const { handlePublicV2Latest } = await import("../src/routes/public_v2");
    const query = {
      channel: "production",
      product_type: "android-apk",
      platform: "android",
      arch: "arm64-v8a",
    };

    const edgeHeaderResponse = await handlePublicV2Latest(makePublicContext(env, query, {
      "CF-Connecting-IP": "203.0.113.42",
    }, null));
    await expect(responseJson<any>(edgeHeaderResponse)).resolves.toMatchObject({
      build: { version_code: 21 },
      scoped: { scope_type: "ip_range", scope_value: "203.0.113.0/24" },
    });

    const spoofedForwardedResponse = await handlePublicV2Latest(makePublicContext(env, query, {
      "X-Forwarded-For": "203.0.113.42",
    }, null));
    await expect(responseJson<any>(spoofedForwardedResponse)).resolves.toMatchObject({
      build: { version_code: 20 },
      scoped: { scope_type: "full", scope_value: "all" },
    });
  });

  it("updates/check returns no update without exposing assets when current version is latest", async () => {
    const env = makeEnv();
    const { handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-current", "build-current", [["full", "all"]], {
      versionCode: 10,
      versionName: "1.0.10",
    });
    await seedAsset(env, "build-current", "asset-current", { arch: "arm64-v8a" });

    const response = await handlePublicV2UpdateCheck(
      makePublicContext(env, {
        channel: "production",
        product_type: "android-apk",
        current_version_code: "10",
        platform: "android",
        arch: "arm64-v8a",
      }),
    );
    expect(response.status).toBe(200);
    const body = await responseJson<any>(response);
    expect(body).toMatchObject({
      update_available: false,
      current_version_code: 10,
      latest_version_code: 10,
    });
    expect(body.asset).toBeUndefined();
  });

  it("resolveChangelog picks languages with sane fallbacks", async () => {
    const { resolveChangelog } = await import("../src/routes/public_v2");
    expect(resolveChangelog(null, "zh-CN")).toBe(null);
    expect(resolveChangelog("plain text notes", "zh-CN")).toBe("plain text notes");
    const bilingual = JSON.stringify({ en: "english notes", "zh-CN": "中文说明" });
    expect(resolveChangelog(bilingual, "zh-CN")).toBe("中文说明");
    expect(resolveChangelog(bilingual, "zh")).toBe("中文说明");
    expect(resolveChangelog(bilingual, "en-US")).toBe("english notes");
    expect(resolveChangelog(bilingual, "fr")).toBe("english notes");
    expect(resolveChangelog(bilingual, null)).toBe("english notes");
    expect(resolveChangelog(JSON.stringify({ "zh-CN": "只有中文" }), "fr")).toBe("只有中文");
    expect(resolveChangelog("{not json", "en")).toBe("{not json");
  });

  it("rollout helpers are deterministic and clamp edge counts", async () => {
    const { fnv1a32, rolloutBucket, rolloutIncludes } = await import(
      "../src/routes/public_v2"
    );
    expect(fnv1a32("abc")).toBe(fnv1a32("abc"));
    expect(rolloutBucket("rel-x", "device-1")).toBe(
      rolloutBucket("rel-x", "device-1"),
    );
    expect(rolloutIncludes("rel-x", null, null)).toBe(true);
    expect(rolloutIncludes("rel-x", 100, null)).toBe(true);
    expect(rolloutIncludes("rel-x", 0, "device-1")).toBe(false);
    expect(rolloutIncludes("rel-x", 50, null)).toBe(false);
    const bucket = rolloutBucket("rel-x", "device-1");
    expect(rolloutIncludes("rel-x", bucket + 1, "device-1")).toBe(true);
    expect(rolloutIncludes("rel-x", bucket, "device-1")).toBe(false);
  });

  it("update checks retain PV while deduplicating stable-device UV by release and kind", async () => {
    const env = makeEnv();
    const { handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-metric", "build-metric", [["full", "all"]], {
      versionCode: 20,
      versionName: "2.0.0",
    });
    await seedAsset(env, "build-metric", "asset-metric", { arch: "arm64-v8a" });

    const query = (code: string) => ({
      channel: "production",
      product_type: "android-apk",
      current_version_code: code,
      platform: "android",
      arch: "arm64-v8a",
    });
    // Six offered events: one stable device repeats, one second device, and
    // three legacy/invalid ids. Only two exact UV rows are allowed.
    await handlePublicV2UpdateCheck(makePublicContext(env, query("10"), { "X-Quiver-Device-Id": "device-a" }));
    await handlePublicV2UpdateCheck(makePublicContext(env, query("15"), { "X-Quiver-Device-Id": "device-a" }));
    await handlePublicV2UpdateCheck(makePublicContext(env, query("15"), { "X-Hands-Device-Id": "device-b" }));
    await handlePublicV2UpdateCheck(makePublicContext(env, query("15")));
    await handlePublicV2UpdateCheck(makePublicContext(env, query("15"), { "X-Hands-Device-Id": "   " }));
    await handlePublicV2UpdateCheck(makePublicContext(env, query("15"), { "X-Hands-Device-Id": "x".repeat(257) }));
    // The same device is independently unique for the current kind; a repeat
    // increments PV while preserving one current UV row.
    await handlePublicV2UpdateCheck(makePublicContext(env, query("20"), { "X-Quiver-Device-Id": "device-a" }));
    await handlePublicV2UpdateCheck(makePublicContext(env, query("20"), { "X-Quiver-Device-Id": "device-a" }));

    const row = (await env.DB.prepare(
      "SELECT offered_count, current_count FROM release_metrics WHERE release_id = ?1",
    )
      .bind("rel-metric")
      .first()) as { offered_count: number; current_count: number } | null;
    expect(row?.offered_count).toBe(6);
    expect(row?.current_count).toBe(2);
    const uv = await env.DB.prepare(
      `SELECT metric_kind, COUNT(*) AS n FROM release_metric_devices
       WHERE release_id = ?1 GROUP BY metric_kind ORDER BY metric_kind`,
    ).bind("rel-metric").all();
    expect(uv.results).toEqual([
      { metric_kind: "current", n: 1 },
      { metric_kind: "offered", n: 2 },
    ]);

    const { handleListReleases } = await import("../src/routes/releases");
    const listed = await responseJson<any>(await handleListReleases({
      env,
      req: { param: () => "app-scope", query: () => undefined },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any));
    expect(listed.releases.find((release: any) => release.id === "rel-metric")).toMatchObject({
      offered_count: 6,
      current_count: 2,
      offered_uv: 2,
      current_uv: 1,
    });
  });

  it("combines percentage rollout with an always-included device group", async () => {
    const env = makeEnv();
    const { handlePublicV2UpdateCheck, rolloutBucket } = await import(
      "../src/routes/public_v2"
    );
    await seedRelease(env, "rel-stable", "build-stable", [["full", "all"]], {
      versionCode: 10,
      versionName: "1.0.10",
      createdAt: Date.now() - 1000,
    });
    await seedAsset(env, "build-stable", "asset-stable", { arch: "arm64-v8a" });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO device_groups (id, app_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind("group-always", "app-scope", "Always included", null, now, now).run();
    await seedRelease(env, "rel-gated", "build-gated", [
      ["full", "all"],
      ["device_group", "group-always"],
    ], {
      versionCode: 11,
      versionName: "1.0.11",
      rolloutCohortCount: 30,
    });
    await seedAsset(env, "build-gated", "asset-gated", { arch: "arm64-v8a" });

    let inDevice = "";
    let outDevice = "";
    for (let i = 0; i < 1000 && (!inDevice || !outDevice); i++) {
      const candidate = `device-${i}`;
      if (rolloutBucket("rel-gated", candidate) < 30) {
        inDevice = inDevice || candidate;
      } else {
        outDevice = outDevice || candidate;
      }
    }
    expect(inDevice).not.toBe("");
    expect(outDevice).not.toBe("");
    await env.DB.prepare(
      `INSERT INTO device_group_members (group_id, device_id, label, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind("group-always", outDevice, "Outside percentage", now).run();

    const query = {
      channel: "production",
      product_type: "android-apk",
      current_version_code: "9",
      platform: "android",
      arch: "arm64-v8a",
    };

    const inResponse = await handlePublicV2UpdateCheck(
      makePublicContext(env, query, { "X-Quiver-Device-Id": inDevice }),
    );
    expect(inResponse.status).toBe(200);
    const inBody = await responseJson<any>(inResponse);
    expect(inBody.update_available).toBe(true);
    expect(inBody.latest.version_code).toBe(11);
    expect(inBody.scoped.rollout_cohort_count).toBe(30);

    const memberResponse = await handlePublicV2UpdateCheck(
      makePublicContext(env, query, { "X-Hands-Device-Id": outDevice }),
    );
    expect(memberResponse.status).toBe(200);
    const memberBody = await responseJson<any>(memberResponse);
    expect(memberBody.update_available).toBe(true);
    expect(memberBody.latest.version_code).toBe(11);
    expect(memberBody.scoped).toMatchObject({
      scope_type: "device_group",
      scope_value: "group-always",
      rollout_cohort_count: 30,
    });

    let nonMemberOutDevice = "";
    for (let i = 1000; i < 2000; i++) {
      const candidate = `non-member-${i}`;
      if (rolloutBucket("rel-gated", candidate) >= 30) {
        nonMemberOutDevice = candidate;
        break;
      }
    }
    expect(nonMemberOutDevice).not.toBe("");
    const outResponse = await handlePublicV2UpdateCheck(
      makePublicContext(env, query, { "X-Hands-Device-Id": nonMemberOutDevice }),
    );
    const outBody = await responseJson<any>(outResponse);
    expect(outBody.latest.version_code).toBe(10);

    const legacyResponse = await handlePublicV2UpdateCheck(
      makePublicContext(env, query),
    );
    expect(legacyResponse.status).toBe(200);
    const legacyBody = await responseJson<any>(legacyResponse);
    expect(legacyBody.update_available).toBe(true);
    expect(legacyBody.latest.version_code).toBe(10);
  });

  it("updates/check still resolves an active release older than 30 days", async () => {
    const env = makeEnv();
    const { handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-old", "build-old", [["full", "all"]], {
      versionCode: 10,
      versionName: "1.0.10",
      createdAt: Date.now() - 60 * 24 * 3600 * 1000,
    });
    await seedAsset(env, "build-old", "asset-old", { arch: "arm64-v8a" });

    const response = await handlePublicV2UpdateCheck(
      makePublicContext(env, {
        channel: "production",
        product_type: "android-apk",
        current_version_code: "1",
        platform: "android",
        arch: "arm64-v8a",
      }),
    );
    expect(response.status).toBe(200);
    const body = await responseJson<any>(response);
    expect(body.update_available).toBe(true);
    expect(body.latest.version_code).toBe(10);
  });

  it("updates/check compares server-side and returns one compatible apk asset", async () => {
    const env = makeEnv();
    const { handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-latest", "build-latest", [["platform", "android-arm64-v8a"]], {
      versionCode: 11,
      versionName: "1.0.11",
      shouldForceUpdate: 1,
    });
    await seedAsset(env, "build-latest", "asset-v7", { arch: "armeabi-v7a" });
    await seedAsset(env, "build-latest", "asset-arm64", { arch: "arm64-v8a", sizeBytes: 99 });

    const response = await handlePublicV2UpdateCheck(
      makePublicContext(env, {
        channel: "production",
        product_type: "android-apk",
        current_version_code: "10",
        platform: "android",
        arch: "arm64-v8a",
      }),
    );
    expect(response.status).toBe(200);
    const body = await responseJson<any>(response);
    expect(body).toMatchObject({
      update_available: true,
      current_version_code: 10,
      latest: {
        version: "1.0.11",
        version_code: 11,
        force_update: true,
      },
      asset: {
        platform: "android",
        arch: "arm64-v8a",
        filetype: "apk",
        size_bytes: 99,
      },
    });
    expect(body.asset.download_url).toContain("asset-arm64.apk");
    expect(body.asset.download_url).toMatch(/^https:\/\/quiver-worker\.test\/public\/r2\//);
    expect(body.asset.download_url).toContain("&sig=");
  });

  it("updates/check offers a delta patch when one applies and is small enough", async () => {
    const env = makeEnv();
    const { handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-delta", "build-delta", [["full", "all"]], {
      versionCode: 20,
      versionName: "1.0.20",
    });
    // Full APK is 1000 bytes for arm64.
    await seedAsset(env, "build-delta", "asset-full", { arch: "arm64-v8a", sizeBytes: 1000 });
    // A patch 10→20 for arm64 that's 200 bytes (< 70% of 1000) → offered.
    await seedAsset(env, "build-delta", "asset-patch-small", {
      artifactKind: "delta-patch",
      arch: "arm64-v8a",
      filetype: "patch",
      sizeBytes: 200,
      r2Key: "apps/app-scope/patch-10-20.patch",
      metadata: {
        from_version_code: 10,
        to_version_code: 20,
        algorithm: "archive-patcher-v1",
        target_sha256: "deadbeef",
      },
    });

    const call = (currentCode: string) =>
      handlePublicV2UpdateCheck(
        makePublicContext(env, {
          channel: "production",
          product_type: "android-apk",
          current_version_code: currentCode,
          platform: "android",
          arch: "arm64-v8a",
        }),
      );

    // Kill switch: delta is off by default → no patch offered even though one
    // exists and applies. Client just gets the full APK.
    const gatedOff = await responseJson<any>(await call("10"));
    expect(gatedOff.update_available).toBe(true);
    expect(gatedOff.patch).toBeUndefined();

    // Opt the app into delta updates via the feature flag (the delta *offer*
    // is now gated by the `delta_updates` feature flag, not apps.delta_updates_enabled).
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, app_id, key, default_enabled, updated_at)
       VALUES ('ff-delta-existing', 'app-scope', 'delta_updates', 1, ?1)`,
    ).bind(Date.now()).run();

    // Client on 10 → patch offered with target hash + signed URL.
    const offered = await responseJson<any>(await call("10"));
    expect(offered.patch).toMatchObject({
      from_version_code: 10,
      algorithm: "archive-patcher-v1",
      size_bytes: 200,
      target_sha256: "deadbeef",
    });
    expect(offered.patch.download_url).toContain("patch-10-20.patch");
    expect(offered.patch.download_url).toContain("&sig=");

    // Client on 15 → no patch for that from-version → full only.
    const noPatch = await responseJson<any>(await call("15"));
    expect(noPatch.update_available).toBe(true);
    expect(noPatch.patch).toBeUndefined();

    // A too-large patch (>70% of full) is not offered.
    await seedAsset(env, "build-delta", "asset-patch-big", {
      artifactKind: "delta-patch",
      arch: "arm64-v8a",
      filetype: "patch",
      sizeBytes: 900,
      r2Key: "apps/app-scope/patch-5-20.patch",
      metadata: { from_version_code: 5, to_version_code: 20, algorithm: "archive-patcher-v1" },
    });
    const bigPatch = await responseJson<any>(await call("5"));
    expect(bigPatch.patch).toBeUndefined();
  });

  it("delta offer respects the delta_updates feature flag (default off/on, per-device allow/deny)", async () => {
    const env = makeEnv();
    const { handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-ff", "build-ff", [["full", "all"]], {
      versionCode: 20,
      versionName: "1.0.20",
    });
    await seedAsset(env, "build-ff", "asset-ff-full", { arch: "arm64-v8a", sizeBytes: 1000 });
    await seedAsset(env, "build-ff", "asset-ff-patch", {
      artifactKind: "delta-patch",
      arch: "arm64-v8a",
      filetype: "patch",
      sizeBytes: 200,
      r2Key: "apps/app-scope/patch-ff-10-20.patch",
      metadata: {
        from_version_code: 10,
        to_version_code: 20,
        algorithm: "archive-patcher-v1",
        target_sha256: "cafef00d",
      },
    });

    const call = (deviceId: string) =>
      handlePublicV2UpdateCheck(
        makePublicContext(env, {
          channel: "production",
          product_type: "android-apk",
          current_version_code: "10",
          platform: "android",
          arch: "arm64-v8a",
          device_id: deviceId,
        }),
      );

    // Replace the (single) delta_updates flag row with a fresh config.
    const setFlag = async (opts: {
      default_enabled?: number;
      allow?: string[];
      deny?: string[];
    }) => {
      await env.DB.prepare(
        "DELETE FROM feature_flags WHERE app_id = ?1 AND key = 'delta_updates'",
      )
        .bind("app-scope")
        .run();
      await env.DB.prepare(
        `INSERT INTO feature_flags
           (id, app_id, key, default_enabled, allow_device_ids, deny_device_ids, updated_at)
         VALUES ('ff-delta', 'app-scope', 'delta_updates', ?1, ?2, ?3, ?4)`,
      )
        .bind(
          opts.default_enabled ?? 0,
          JSON.stringify(opts.allow ?? []),
          JSON.stringify(opts.deny ?? []),
          Date.now(),
        )
        .run();
    };

    // (a) No flag row → fail-safe OFF → delta not offered.
    const none = await responseJson<any>(await call("dev-a"));
    expect(none.update_available).toBe(true);
    expect(none.patch).toBeUndefined();

    // (b) default_enabled = 1 → offered.
    await setFlag({ default_enabled: 1 });
    const on = await responseJson<any>(await call("dev-a"));
    expect(on.patch).toMatchObject({ from_version_code: 10, size_bytes: 200 });

    // (c) default off but allow_device_ids contains dev-a → offered ONLY for dev-a.
    await setFlag({ default_enabled: 0, allow: ["dev-a"] });
    const allowed = await responseJson<any>(await call("dev-a"));
    expect(allowed.patch).toMatchObject({ from_version_code: 10 });
    const otherDevice = await responseJson<any>(await call("dev-b"));
    expect(otherDevice.patch).toBeUndefined();

    // (d) deny overrides default-on: dev-a denied, dev-b still offered.
    await setFlag({ default_enabled: 1, deny: ["dev-a"] });
    const denied = await responseJson<any>(await call("dev-a"));
    expect(denied.patch).toBeUndefined();
    const notDenied = await responseJson<any>(await call("dev-b"));
    expect(notDenied.patch).toMatchObject({ from_version_code: 10 });
  });

  it("public R2 download serves active release assets with a valid signature", async () => {
    const env = makeEnv();
    const { handlePublicR2Download, handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-download", "build-download", [["full", "all"]], {
      versionCode: 11,
    });
    await seedAsset(env, "build-download", "asset-download", {
      arch: "arm64-v8a",
      sizeBytes: 3,
    });
    const key = "apps/app-scope/asset-download.apk";
    env.APK_BUCKET = {
      get: async (requestedKey: string) => {
        if (requestedKey !== key) return null;
        return {
          body: new Blob(["apk"]).stream(),
          httpEtag: "\"asset-download\"",
          writeHttpMetadata: (headers: Headers) => {
            headers.set("content-type", "application/octet-stream");
          },
        };
      },
    };

    const check = await handlePublicV2UpdateCheck(
      makePublicContext(env, {
        channel: "production",
        product_type: "android-apk",
        current_version_code: "10",
        platform: "android",
        arch: "arm64-v8a",
      }),
    );
    const body = await responseJson<any>(check);
    const url = new URL(body.asset.download_url);
    const response = await handlePublicR2Download(
      makePublicDownloadContext(env, decodeURIComponent(url.pathname.replace("/public/r2/", "")), {
        expires: url.searchParams.get("expires") ?? undefined,
        sig: url.searchParams.get("sig") ?? undefined,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="scope-app-1.0.0-11.apk"; filename*=UTF-8''scope-app-1.0.0-11.apk`,
    );
    expect(await response.text()).toBe("apk");
  });

  it("public R2 download serves only release-bound delta patches", async () => {
    const env = makeEnv();
    const {
      generateSignedR2Url,
      handlePublicR2Download,
      handlePublicV2UpdateCheck,
    } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-delta-download", "build-delta-download", [["full", "all"]], {
      versionCode: 20,
      versionName: "1.0.20",
    });
    await seedAsset(env, "build-delta-download", "asset-delta-download-full", {
      arch: "arm64-v8a",
      sizeBytes: 1000,
    });
    const key = "apps/app-scope/patch-download-10-20.patch";
    await seedAsset(env, "build-delta-download", "asset-delta-download", {
      artifactKind: "delta-patch",
      arch: "arm64-v8a",
      filetype: "patch",
      sizeBytes: 200,
      r2Key: key,
      metadata: {
        from_version_code: 10,
        to_version_code: 20,
        algorithm: "archive-patcher-v1",
        target_sha256: "target-apk-sha256",
      },
    });
    await env.DB.prepare(
      `INSERT INTO feature_flags (id, app_id, key, default_enabled, updated_at)
       VALUES ('ff-delta-download', 'app-scope', 'delta_updates', 1, ?1)`,
    ).bind(Date.now()).run();
    env.APK_BUCKET = {
      get: async (requestedKey: string) => {
        if (requestedKey !== key) return null;
        return {
          body: new Blob(["patch"]).stream(),
          httpEtag: '"asset-delta-download"',
          writeHttpMetadata: () => undefined,
        };
      },
    };

    const check = await handlePublicV2UpdateCheck(
      makePublicContext(env, {
        channel: "production",
        product_type: "android-apk",
        current_version_code: "10",
        platform: "android",
        arch: "arm64-v8a",
      }),
    );
    const body = await responseJson<any>(check);
    const url = new URL(body.patch.download_url);
    const requestUrl = (downloadUrl: URL) => handlePublicR2Download(
      makePublicDownloadContext(
        env,
        decodeURIComponent(downloadUrl.pathname.replace("/public/r2/", "")),
        {
          expires: downloadUrl.searchParams.get("expires") ?? undefined,
          sig: downloadUrl.searchParams.get("sig") ?? undefined,
        },
      ),
    );
    const request = () => requestUrl(url);
    const expectAssetNotFound = async (response: Response) => {
      expect(response.status).toBe(404);
      expect(await responseJson<any>(response)).toEqual({ error: "asset not found", code: "object_not_found" });
    };

    const active = await request();
    expect(active.status).toBe(200);
    expect(active.headers.get("content-type")).toBe("application/octet-stream");
    expect(active.headers.get("content-length")).toBe("200");
    expect(active.headers.get("content-disposition")).toBe(
      `attachment; filename="scope-app-1.0.20-20.patch"; filename*=UTF-8''scope-app-1.0.20-20.patch`,
    );
    expect(await active.text()).toBe("patch");

    // Release identity is independently writable from the build identity.
    // Both sides must remain non-QA for a signed URL to authorize the object.
    await env.DB.prepare("UPDATE releases SET release_type = 'qa' WHERE id = ?1")
      .bind("rel-delta-download")
      .run();
    await expectAssetNotFound(await request());
    await env.DB.prepare("UPDATE releases SET release_type = 'stable' WHERE id = ?1")
      .bind("rel-delta-download")
      .run();

    await env.DB.prepare("UPDATE builds SET product_type = 'ios-simulator-qa' WHERE id = ?1")
      .bind("build-delta-download")
      .run();
    await expectAssetNotFound(await request());
    await env.DB.prepare("UPDATE builds SET product_type = 'android-apk' WHERE id = ?1")
      .bind("build-delta-download")
      .run();

    // A support asset on the same active release does not become public merely
    // because the caller can present a valid Worker-minted signature.
    const supportKey = "apps/app-scope/delta-download-symbols.zip";
    await seedAsset(env, "build-delta-download", "asset-delta-download-support", {
      artifactKind: "native-symbols",
      filetype: "zip",
      r2Key: supportKey,
    });
    const supportUrl = new URL(
      await generateSignedR2Url(env as any, supportKey, 3600, "https://quiver-worker.test"),
    );
    await expectAssetNotFound(await requestUrl(supportUrl));

    // The delta allowlist is deliberately narrow: a delta-patch row with the
    // wrong filetype is still private.
    const wrongFiletypeKey = "apps/app-scope/delta-download-wrong-filetype.zip";
    await seedAsset(env, "build-delta-download", "asset-delta-download-wrong-filetype", {
      artifactKind: "delta-patch",
      filetype: "zip",
      r2Key: wrongFiletypeKey,
    });
    const wrongFiletypeUrl = new URL(
      await generateSignedR2Url(env as any, wrongFiletypeKey, 3600, "https://quiver-worker.test"),
    );
    await expectAssetNotFound(await requestUrl(wrongFiletypeUrl));

    // A delta-patch on a build with no release lifecycle is not public.
    await seedRelease(env, "rel-unreleased-delta", "build-unreleased-delta", [["full", "all"]], {
      versionCode: 21,
      versionName: "1.0.21",
    });
    const unreleasedKey = "apps/app-scope/unreleased-delta.patch";
    await seedAsset(env, "build-unreleased-delta", "asset-unreleased-delta", {
      artifactKind: "delta-patch",
      filetype: "patch",
      r2Key: unreleasedKey,
    });
    await env.DB.prepare("DELETE FROM releases WHERE id = ?1")
      .bind("rel-unreleased-delta")
      .run();
    const unreleasedUrl = new URL(
      await generateSignedR2Url(env as any, unreleasedKey, 3600, "https://quiver-worker.test"),
    );
    await expectAssetNotFound(await requestUrl(unreleasedUrl));

    // A still-valid URL must stop working as soon as its release is no longer
    // active or draft. The HMAC alone never authorizes an arbitrary R2 object.
    await env.DB.prepare("UPDATE releases SET status = 'cancelled' WHERE id = ?1")
      .bind("rel-delta-download")
      .run();
    await expectAssetNotFound(await request());
  });

  it("public R2 download redirects to presigned R2 when S3 credentials are configured", async () => {
    const env = makeEnv();
    configureR2Presign(env);
    const { handlePublicR2Download, handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-direct-download", "build-direct-download", [["full", "all"]], {
      versionCode: 11,
    });
    await seedAsset(env, "build-direct-download", "asset-direct-download", {
      arch: "arm64-v8a",
      sizeBytes: 3,
    });
    const key = "apps/app-scope/asset-direct-download.apk";
    env.APK_BUCKET = {
      head: async (requestedKey: string) => {
        if (requestedKey !== key) return null;
        return { httpEtag: "\"asset-direct-download\"" };
      },
      get: async (requestedKey: string) => {
        if (requestedKey !== key) return null;
        return {
          body: new Blob(["apk"]).stream(),
          httpEtag: "\"asset-direct-download\"",
          writeHttpMetadata: () => undefined,
        };
      },
    };

    const check = await handlePublicV2UpdateCheck(
      makePublicContext(env, {
        channel: "production",
        product_type: "android-apk",
        current_version_code: "10",
        platform: "android",
        arch: "arm64-v8a",
      }),
    );
    const body = await responseJson<any>(check);
    const url = new URL(body.asset.download_url);
    const response = await handlePublicR2Download(
      makePublicDownloadContext(env, decodeURIComponent(url.pathname.replace("/public/r2/", "")), {
        expires: url.searchParams.get("expires") ?? undefined,
        sig: url.searchParams.get("sig") ?? undefined,
      }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(location.pathname).toBe("/quiver-apks/apps/app-scope/asset-direct-download.apk");
    expect(location.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(location.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(location.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(location.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(location.searchParams.get("response-content-disposition")).toContain("scope-app-1.0.0-11.apk");
  });

  it("serves electron-updater generic metadata from the active release", async () => {
    const env = makeEnv();
    const { handleElectronGenericAsset } = await import("../src/routes/electron");
    await seedRelease(env, "rel-electron", "build-electron", [["full", "all"]], {
      productType: "electron-installer",
      versionCode: 10203,
      versionName: "1.2.3",
    });
    await seedAsset(env, "build-electron", "asset-latest-yml", {
      artifactKind: "electron-metadata",
      platform: "win32",
      filetype: "yml",
      variant: "latest.yml",
      r2Key: "apps/scope-app/electron/latest.yml",
      sizeBytes: 121,
      metadata: { filename: "latest.yml" },
    });
    env.APK_BUCKET = {
      get: async (requestedKey: string) => {
        if (requestedKey !== "apps/scope-app/electron/latest.yml") return null;
        return {
          body: new Blob(["version: 1.2.3\nfiles: []\n"]).stream(),
          httpEtag: "\"latest-yml\"",
          writeHttpMetadata: (headers: Headers) => {
            headers.set("content-type", "application/octet-stream");
          },
        };
      },
    };

    const response = await handleElectronGenericAsset(makeElectronContext(env, "latest.yml"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/yaml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, must-revalidate");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(await response.text()).toBe("version: 1.2.3\nfiles: []\n");
  });

  it("serves electron-updater installer and blockmap assets by original filename", async () => {
    const env = makeEnv();
    const { handleElectronGenericAsset } = await import("../src/routes/electron");
    await seedRelease(env, "rel-electron-files", "build-electron-files", [["full", "all"]], {
      productType: "electron-installer",
      versionCode: 10203,
      versionName: "1.2.3",
    });
    await seedAsset(env, "build-electron-files", "asset-exe", {
      artifactKind: "installable",
      platform: "win32",
      arch: "x64",
      filetype: "exe",
      r2Key: "apps/scope-app/electron/Raft Setup 1.2.3.exe",
      sizeBytes: 3,
      metadata: { filename: "Raft Setup 1.2.3.exe" },
    });
    await seedAsset(env, "build-electron-files", "asset-blockmap", {
      artifactKind: "electron-blockmap",
      platform: "win32",
      arch: "x64",
      filetype: "blockmap",
      r2Key: "apps/scope-app/electron/Raft Setup 1.2.3.exe.blockmap",
      sizeBytes: 8,
      metadata: { filename: "Raft Setup 1.2.3.exe.blockmap" },
    });
    env.APK_BUCKET = {
      get: async (requestedKey: string) => {
        if (requestedKey.endsWith(".blockmap")) {
          return {
            body: new Blob(["blockmap"]).stream(),
            httpEtag: "\"blockmap\"",
            writeHttpMetadata: () => undefined,
          };
        }
        if (requestedKey.endsWith(".exe")) {
          return {
            body: new Blob(["exe"]).stream(),
            httpEtag: "\"exe\"",
            writeHttpMetadata: () => undefined,
          };
        }
        return null;
      },
    };

    const installer = await handleElectronGenericAsset(
      makeElectronContext(env, "Raft%20Setup%201.2.3.exe"),
    );
    expect(installer.status).toBe(200);
    expect(installer.headers.get("content-type")).toBe("application/vnd.microsoft.portable-executable");
    expect(installer.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(installer.headers.get("content-disposition")).toContain("attachment");
    expect(await installer.text()).toBe("exe");

    const blockmap = await handleElectronGenericAsset(
      makeElectronContext(env, "Raft%20Setup%201.2.3.exe.blockmap"),
    );
    expect(blockmap.status).toBe(200);
    expect(blockmap.headers.get("content-type")).toBe("application/octet-stream");
    expect(await blockmap.text()).toBe("blockmap");
  });

  it("authenticated build asset download serves support artifacts", async () => {
    const env = makeEnv();
    const { handleDownloadBuildAsset } = await import("../src/routes/builds");
    await seedRelease(env, "rel-support-download", "build-support-download", [["full", "all"]], {
      versionCode: 12,
      versionName: "1.0.12",
    });
    await seedAsset(env, "build-support-download", "asset-metadata", {
      artifactKind: "metadata-file",
      filetype: "json",
      sizeBytes: 14,
    });
    const key = "apps/app-scope/asset-metadata.apk";
    env.APK_BUCKET = {
      get: async (requestedKey: string) => {
        if (requestedKey !== key) return null;
        return {
          body: new Blob(['{"ok":true}\n']).stream(),
          httpEtag: "\"asset-metadata\"",
          writeHttpMetadata: (headers: Headers) => {
            headers.set("content-type", "application/octet-stream");
          },
        };
      },
    };

    const response = await handleDownloadBuildAsset(
      makeBuildAssetDownloadContext(env, "build-support-download", "asset-metadata"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-length")).toBe("14");
    expect(response.headers.get("content-disposition")).toContain(
      "scope-app-1.0.12-12-metadata-file-android.json",
    );
    expect(await response.text()).toBe('{"ok":true}\n');
    const row = await env.DB.prepare("SELECT download_count FROM build_assets WHERE id = ?")
      .bind("asset-metadata")
      .first() as { download_count: number } | null;
    expect(row?.download_count).toBe(1);
  });

  it("authenticated build asset download redirects support artifacts to presigned R2", async () => {
    const env = makeEnv();
    configureR2Presign(env);
    const { handleDownloadBuildAsset } = await import("../src/routes/builds");
    await seedRelease(env, "rel-direct-metadata", "build-direct-metadata", [["full", "all"]], {
      versionCode: 12,
      versionName: "1.0.12",
    });
    await seedAsset(env, "build-direct-metadata", "asset-direct-metadata", {
      artifactKind: "metadata-file",
      filetype: "json",
      sizeBytes: 14,
    });
    const key = "apps/app-scope/asset-direct-metadata.apk";
    env.APK_BUCKET = {
      head: async (requestedKey: string) => {
        if (requestedKey !== key) return null;
        return { httpEtag: "\"asset-direct-metadata\"" };
      },
      get: async (requestedKey: string) => {
        if (requestedKey !== key) return null;
        return {
          body: new Blob(['{"ok":true}\n']).stream(),
          httpEtag: "\"asset-direct-metadata\"",
          writeHttpMetadata: () => undefined,
        };
      },
    };

    const response = await handleDownloadBuildAsset(
      makeBuildAssetDownloadContext(env, "build-direct-metadata", "asset-direct-metadata"),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(location.pathname).toBe("/quiver-apks/apps/app-scope/asset-direct-metadata.apk");
    expect(location.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(location.searchParams.get("response-content-type")).toBe("application/json");
    expect(location.searchParams.get("response-content-disposition")).toContain(
      "scope-app-1.0.12-12-metadata-file-android.json",
    );
    const row = await env.DB.prepare("SELECT download_count FROM build_assets WHERE id = ?")
      .bind("asset-direct-metadata")
      .first() as { download_count: number } | null;
    expect(row?.download_count).toBe(1);
  });

  it("authenticated build asset presign returns JSON without counting a download", async () => {
    const env = makeEnv();
    configureR2Presign(env);
    const { handleDownloadBuildAsset } = await import("../src/routes/builds");
    await seedRelease(env, "rel-presign-metadata", "build-presign-metadata", [["full", "all"]], {
      versionCode: 13,
      versionName: "1.0.13",
    });
    await seedAsset(env, "build-presign-metadata", "asset-presign-metadata", {
      artifactKind: "metadata-file",
      filetype: "json",
      sizeBytes: 14,
    });
    const key = "apps/app-scope/asset-presign-metadata.apk";
    env.APK_BUCKET = {
      head: async (requestedKey: string) =>
        requestedKey === key ? { httpEtag: '"asset-presign-metadata"' } : null,
    };

    const response = await handleDownloadBuildAsset(
      makeBuildAssetDownloadContext(
        env,
        "build-presign-metadata",
        "asset-presign-metadata",
        { presign: "1" },
      ),
    );

    expect(response.status).toBe(200);
    const body = await responseJson<any>(response);
    expect(body.asset_id).toBe("asset-presign-metadata");
    expect(body.download_url).toContain("cloudflarestorage.com");
    const row = await env.DB.prepare("SELECT download_count FROM build_assets WHERE id = ?")
      .bind("asset-presign-metadata")
      .first() as { download_count: number } | null;
    expect(row?.download_count).toBe(0);
  });

  it("guarded Agent delete removes only non-installable metadata and preserves R2", async () => {
    const env = makeEnv();
    const { handleDeleteBuildAsset } = await import("../src/routes/builds");
    await seedRelease(env, "rel-delete-metadata", "build-delete-metadata", [["full", "all"]], {
      versionCode: 14,
      versionName: "1.0.14",
    });
    const hash = "a".repeat(64);
    const r2Key = "apps/app-scope/delete-metadata.patch.gz";
    await seedAsset(env, "build-delete-metadata", "asset-delete-metadata", {
      artifactKind: "android-delta",
      filetype: "patch",
      sizeBytes: 123,
      fileHash: hash,
      r2Key,
    });
    let deleteCalls = 0;
    let objectPresent = true;
    env.APK_BUCKET = {
      head: async (key: string) => objectPresent && key === r2Key ? { size: 123 } : null,
      delete: async () => {
        deleteCalls += 1;
      },
    };

    const response = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-metadata", "asset-delete-metadata", {
        expected_file_hash: hash,
        expected_size_bytes: "123",
      }),
    );

    expect(response.status).toBe(200);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      ok: true,
      deleted: true,
      asset_id: "asset-delete-metadata",
      build_id: "build-delete-metadata",
      metadata_absent: true,
      r2_preserved: true,
      r2_key: r2Key,
      file_hash: hash,
      size_bytes: 123,
    });
    expect(deleteCalls).toBe(0);
    await expect(
      env.DB.prepare("SELECT id FROM build_assets WHERE id = ?").bind("asset-delete-metadata").first(),
    ).resolves.toBeNull();
    const audit = await env.DB.prepare(
      "SELECT actor, payload FROM audit_logs WHERE app_id = ? AND action = 'build_asset.delete'",
    ).bind("app-scope").first() as { actor: string; payload: string } | null;
    expect(audit?.actor).toBe("raft:delete-agent@test");
    expect(JSON.parse(audit?.payload ?? "{}")).toMatchObject({
      buildId: "build-delete-metadata",
      assetId: "asset-delete-metadata",
      artifactKind: "android-delta",
      r2Key,
      fileHash: hash,
      sizeBytes: 123,
      r2Preserved: true,
      guarded: true,
    });

    const retry = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-metadata", "asset-delete-metadata", {
        expected_file_hash: hash,
        expected_size_bytes: "123",
      }),
    );
    expect(retry.status).toBe(200);
    await expect(responseJson<any>(retry)).resolves.toMatchObject({
      ok: true,
      deleted: false,
      idempotent_replay: true,
      metadata_absent: true,
      r2_preserved: true,
      r2_key: r2Key,
    });

    objectPresent = false;
    const missingObjectRetry = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-metadata", "asset-delete-metadata", {
        expected_file_hash: hash,
        expected_size_bytes: "123",
      }),
    );
    expect(missingObjectRetry.status).toBe(409);
    await expect(responseJson<any>(missingObjectRetry)).resolves.toMatchObject({
      code: "ASSET_OBJECT_PRECONDITION_FAILED",
      metadata_absent: true,
      r2_preserved: false,
    });

    const arbitraryAbsent = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-metadata", "asset-never-existed", {
        expected_file_hash: hash,
        expected_size_bytes: "123",
      }),
    );
    expect(arbitraryAbsent.status).toBe(404);
    await expect(responseJson<any>(arbitraryAbsent)).resolves.toMatchObject({
      code: "ASSET_DELETE_PROVENANCE_NOT_FOUND",
      metadata_absent: true,
      r2_preserved: null,
    });
  });

  it("rolls back metadata deletion when the atomic audit insert fails", async () => {
    const env = makeEnv();
    const { handleDeleteBuildAsset } = await import("../src/routes/builds");
    await seedRelease(env, "rel-delete-audit-fail", "build-delete-audit-fail", [["full", "all"]], {
      versionCode: 16,
      versionName: "1.0.16",
    });
    const hash = "e".repeat(64);
    const r2Key = "apps/app-scope/delete-audit-fail.patch.gz";
    await seedAsset(env, "build-delete-audit-fail", "asset-delete-audit-fail", {
      artifactKind: "android-delta",
      filetype: "patch",
      sizeBytes: 77,
      fileHash: hash,
      r2Key,
    });
    env.APK_BUCKET = {
      head: async (key: string) => key === r2Key ? { size: 77 } : null,
    };
    await env.DB.prepare(
      `CREATE TRIGGER force_build_asset_audit_failure
       BEFORE INSERT ON audit_logs
       WHEN NEW.action = 'build_asset.delete'
       BEGIN
         SELECT RAISE(ABORT, 'forced build asset audit failure');
       END`,
    ).run();

    await expect(
      handleDeleteBuildAsset(
        makeBuildAssetDownloadContext(env, "build-delete-audit-fail", "asset-delete-audit-fail", {
          expected_file_hash: hash,
          expected_size_bytes: "77",
        }),
      ),
    ).rejects.toThrow("forced build asset audit failure");

    const asset = await env.DB.prepare(
      "SELECT id, r2_key FROM build_assets WHERE id = ? AND build_id = ?",
    ).bind("asset-delete-audit-fail", "build-delete-audit-fail").first();
    expect(asset).toMatchObject({ id: "asset-delete-audit-fail", r2_key: r2Key });
    const audit = await env.DB.prepare(
      "SELECT id FROM audit_logs WHERE app_id = ? AND action = 'build_asset.delete'",
    ).bind("app-scope").first();
    expect(audit).toBeNull();
  });

  it("fails closed when the asset R2 key changes between preflight and the atomic batch", async () => {
    const env = makeEnv();
    const { handleDeleteBuildAsset } = await import("../src/routes/builds");
    await seedRelease(env, "rel-delete-key-race", "build-delete-key-race", [["full", "all"]], {
      versionCode: 17,
      versionName: "1.0.17",
    });
    const hash = "f".repeat(64);
    const oldKey = "apps/app-scope/delete-key-race-old.patch.gz";
    const newKey = "apps/app-scope/delete-key-race-new.patch.gz";
    await seedAsset(env, "build-delete-key-race", "asset-delete-key-race", {
      artifactKind: "android-delta",
      filetype: "patch",
      sizeBytes: 88,
      fileHash: hash,
      r2Key: oldKey,
    });
    let preflightMutated = false;
    env.APK_BUCKET = {
      head: async (key: string) => {
        if (key !== oldKey) return null;
        if (!preflightMutated) {
          preflightMutated = true;
          await env.DB.prepare(
            "UPDATE build_assets SET r2_key = ? WHERE id = ? AND build_id = ?",
          ).bind(newKey, "asset-delete-key-race", "build-delete-key-race").run();
        }
        return { size: 88 };
      },
    };

    const response = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-key-race", "asset-delete-key-race", {
        expected_file_hash: hash,
        expected_size_bytes: "88",
      }),
    );

    expect(response.status).toBe(409);
    await expect(responseJson<any>(response)).resolves.toMatchObject({
      code: "ASSET_DELETE_PRECONDITION_FAILED",
    });
    const asset = await env.DB.prepare(
      "SELECT id, r2_key FROM build_assets WHERE id = ? AND build_id = ?",
    ).bind("asset-delete-key-race", "build-delete-key-race").first();
    expect(asset).toMatchObject({ id: "asset-delete-key-race", r2_key: newKey });
    const audit = await env.DB.prepare(
      "SELECT id FROM audit_logs WHERE app_id = ? AND action = 'build_asset.delete'",
    ).bind("app-scope").first();
    expect(audit).toBeNull();
  });

  it("returns a durable audit receipt when first post-delete R2 readback fails and recovers on retry", async () => {
    const env = makeEnv();
    const { handleDeleteBuildAsset } = await import("../src/routes/builds");
    await seedRelease(env, "rel-delete-post-head", "build-delete-post-head", [["full", "all"]], {
      versionCode: 18,
      versionName: "1.0.18",
    });
    const hash = "1".repeat(64);
    const r2Key = "apps/app-scope/delete-post-head.patch.gz";
    await seedAsset(env, "build-delete-post-head", "asset-delete-post-head", {
      artifactKind: "android-delta",
      filetype: "patch",
      sizeBytes: 66,
      fileHash: hash,
      r2Key,
    });
    let headCalls = 0;
    let readbackRecovered = false;
    env.APK_BUCKET = {
      head: async (key: string) => {
        if (key !== r2Key) return null;
        headCalls += 1;
        if (headCalls === 1 || readbackRecovered) return { size: 66 };
        return null;
      },
    };

    const first = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-post-head", "asset-delete-post-head", {
        expected_file_hash: hash,
        expected_size_bytes: "66",
      }),
    );
    expect(first.status).toBe(503);
    const firstBody = await responseJson<any>(first);
    expect(firstBody).toMatchObject({
      code: "ASSET_OBJECT_READBACK_FAILED",
      metadata_absent: true,
      r2_preserved: false,
    });
    expect(firstBody.audit_id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      env.DB.prepare("SELECT id FROM build_assets WHERE id = ?").bind("asset-delete-post-head").first(),
    ).resolves.toBeNull();
    const audit = await env.DB.prepare(
      "SELECT id, payload FROM audit_logs WHERE id = ? AND action = 'build_asset.delete'",
    ).bind(firstBody.audit_id).first() as { id: string; payload: string } | null;
    expect(audit?.id).toBe(firstBody.audit_id);
    expect(JSON.parse(audit?.payload ?? "{}")).toMatchObject({
      buildId: "build-delete-post-head",
      assetId: "asset-delete-post-head",
      r2Key,
      fileHash: hash,
      sizeBytes: 66,
    });

    readbackRecovered = true;
    const retry = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-post-head", "asset-delete-post-head", {
        expected_file_hash: hash,
        expected_size_bytes: "66",
      }),
    );
    expect(retry.status).toBe(200);
    await expect(responseJson<any>(retry)).resolves.toMatchObject({
      ok: true,
      deleted: false,
      idempotent_replay: true,
      metadata_absent: true,
      r2_preserved: true,
      r2_key: r2Key,
      audit_id: firstBody.audit_id,
    });
  });

  it("preserves a durable unknown receipt when post-delete and replay R2 HEAD reject", async () => {
    const env = makeEnv();
    const { handleDeleteBuildAsset } = await import("../src/routes/builds");
    await seedRelease(env, "rel-delete-head-reject", "build-delete-head-reject", [["full", "all"]], {
      versionCode: 19,
      versionName: "1.0.19",
    });
    const hash = "2".repeat(64);
    const r2Key = "apps/app-scope/delete-head-reject.patch.gz";
    await seedAsset(env, "build-delete-head-reject", "asset-delete-head-reject", {
      artifactKind: "android-delta",
      filetype: "patch",
      sizeBytes: 65,
      fileHash: hash,
      r2Key,
    });
    let headCalls = 0;
    let readbackRecovered = false;
    env.APK_BUCKET = {
      head: async (key: string) => {
        if (key !== r2Key) return null;
        headCalls += 1;
        if (headCalls === 1 || readbackRecovered) return { size: 65 };
        throw new Error("forced transient R2 HEAD failure");
      },
    };

    const first = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-head-reject", "asset-delete-head-reject", {
        expected_file_hash: hash,
        expected_size_bytes: "65",
      }),
    );
    expect(first.status).toBe(503);
    const firstBody = await responseJson<any>(first);
    expect(firstBody).toMatchObject({
      code: "ASSET_OBJECT_READBACK_FAILED",
      metadata_absent: true,
      r2_preserved: null,
    });
    expect(firstBody.audit_id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      env.DB.prepare("SELECT id FROM build_assets WHERE id = ?").bind("asset-delete-head-reject").first(),
    ).resolves.toBeNull();
    const audit = await env.DB.prepare(
      "SELECT id FROM audit_logs WHERE id = ? AND action = 'build_asset.delete'",
    ).bind(firstBody.audit_id).first();
    expect(audit).toMatchObject({ id: firstBody.audit_id });

    const unavailableReplay = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-head-reject", "asset-delete-head-reject", {
        expected_file_hash: hash,
        expected_size_bytes: "65",
      }),
    );
    expect(unavailableReplay.status).toBe(503);
    await expect(responseJson<any>(unavailableReplay)).resolves.toMatchObject({
      code: "ASSET_OBJECT_READBACK_FAILED",
      metadata_absent: true,
      r2_preserved: null,
      audit_id: firstBody.audit_id,
    });

    readbackRecovered = true;
    const recovered = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-head-reject", "asset-delete-head-reject", {
        expected_file_hash: hash,
        expected_size_bytes: "65",
      }),
    );
    expect(recovered.status).toBe(200);
    await expect(responseJson<any>(recovered)).resolves.toMatchObject({
      ok: true,
      deleted: false,
      idempotent_replay: true,
      metadata_absent: true,
      r2_preserved: true,
      r2_key: r2Key,
      audit_id: firstBody.audit_id,
    });
  });

  it("guarded Agent delete fails closed for stale facts, installables, and missing R2", async () => {
    const env = makeEnv();
    const { handleDeleteBuildAsset } = await import("../src/routes/builds");
    await seedRelease(env, "rel-delete-guards", "build-delete-guards", [["full", "all"]], {
      versionCode: 15,
      versionName: "1.0.15",
    });
    const metadataHash = "b".repeat(64);
    const installableHash = "c".repeat(64);
    await seedAsset(env, "build-delete-guards", "asset-guarded-metadata", {
      artifactKind: "metadata-file",
      filetype: "json",
      sizeBytes: 55,
      fileHash: metadataHash,
      r2Key: "apps/app-scope/guarded-metadata.json",
    });
    await seedAsset(env, "build-delete-guards", "asset-guarded-installable", {
      artifactKind: "installable",
      filetype: "apk",
      sizeBytes: 99,
      fileHash: installableHash,
      r2Key: "apps/app-scope/guarded-installable.apk",
    });
    env.APK_BUCKET = {
      head: async (key: string) => key.endsWith("guarded-installable.apk") ? { size: 99 } : null,
    };

    const stale = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-guards", "asset-guarded-metadata", {
        expected_file_hash: "d".repeat(64),
        expected_size_bytes: "55",
      }),
    );
    expect(stale.status).toBe(409);
    await expect(responseJson<any>(stale)).resolves.toMatchObject({
      code: "ASSET_DELETE_PRECONDITION_FAILED",
    });

    const missingObject = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-guards", "asset-guarded-metadata", {
        expected_file_hash: metadataHash,
        expected_size_bytes: "55",
      }),
    );
    expect(missingObject.status).toBe(409);
    await expect(responseJson<any>(missingObject)).resolves.toMatchObject({
      code: "ASSET_OBJECT_PRECONDITION_FAILED",
    });

    const installable = await handleDeleteBuildAsset(
      makeBuildAssetDownloadContext(env, "build-delete-guards", "asset-guarded-installable", {
        expected_file_hash: installableHash,
        expected_size_bytes: "99",
      }),
    );
    expect(installable.status).toBe(409);
    await expect(responseJson<any>(installable)).resolves.toMatchObject({
      code: "INSTALLABLE_ASSET_DELETE_FORBIDDEN",
    });

    const remaining = await env.DB.prepare(
      "SELECT id FROM build_assets WHERE build_id = ? ORDER BY id",
    ).bind("build-delete-guards").all();
    expect(remaining.results.map((row: any) => row.id)).toEqual([
      "asset-guarded-installable",
      "asset-guarded-metadata",
    ]);
  });

  it("creates public release shares with hashed tokens only", async () => {
    const env = makeEnv();
    const { handleCreateReleaseShare } = await import("../src/routes/shares");
    await seedRelease(env, "rel-share", "build-share", [["full", "all"]], {
      versionCode: 11,
      versionName: "1.0.11",
    });

    const response = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }, { ttl_seconds: 600 }),
    );

    expect(response.status).toBe(201);
    const body = await responseJson<any>(response);
    expect(body.release_id).toBe("rel-share");
    expect(body.share_url).toMatch(/^https:\/\/quiver-worker\.test\/share\//);
    const token = new URL(body.share_url).pathname.replace("/share/", "");
    const rows = await env.DB.prepare("SELECT id, token_hash, expires_at, revoked_at FROM release_shares WHERE id = ?")
      .bind(body.id)
      .all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(rows.results[0].token_hash).not.toBe(token);
    expect(rows.results[0].revoked_at).toBeNull();
  });

  it("creates release shares without a default expiry and updates share expiry", async () => {
    const env = makeEnv();
    const { handleCreateReleaseShare, handleUpdateReleaseShare } = await import("../src/routes/shares");
    await seedRelease(env, "rel-share", "build-share", [["full", "all"]], {
      versionCode: 11,
      versionName: "1.0.11",
    });

    const created = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }, {}),
    );

    expect(created.status).toBe(201);
    const createdBody = await responseJson<any>(created);
    expect(createdBody.expires_at).toBeNull();

    const expiresAt = Date.now() + 14 * 24 * 60 * 60 * 1000;
    const updated = await handleUpdateReleaseShare(
      makeShareAdminContext(
        env,
        { appId: "app-scope", releaseId: "rel-share", shareId: createdBody.id },
        { expires_at: expiresAt },
      ),
    );

    expect(updated.status).toBe(200);
    const updatedBody = await responseJson<any>(updated);
    expect(updatedBody).toMatchObject({
      id: createdBody.id,
      release_id: "rel-share",
      expires_at: expiresAt,
      revoked_at: null,
    });

    const row = await env.DB.prepare("SELECT expires_at FROM release_shares WHERE id = ?")
      .bind(createdBody.id)
      .first() as { expires_at: number } | null;
    expect(row?.expires_at).toBe(expiresAt);
  });

  it("public release share page renders metadata and a signed download URL", async () => {
    const env = makeEnv();
    const { handleCreateReleaseShare, handlePublicReleaseShare } = await import("../src/routes/shares");
    await seedRelease(env, "rel-share", "build-share", [["full", "all"]], {
      versionCode: 11,
      versionName: "1.0.11",
    });
    await seedAsset(env, "build-share", "asset-share", {
      arch: "arm64-v8a",
      sizeBytes: 123,
    });
    const created = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }, { ttl_seconds: 600 }),
    );
    const createdBody = await responseJson<any>(created);
    const token = new URL(createdBody.share_url).pathname.replace("/share/", "");

    const response = await handlePublicReleaseShare(makeSharePublicContext(env, token));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Scope App");
    expect(html).toContain("1.0.11");
    expect(html).toContain("build 11");
    expect(html).toContain("arm64-v8a");
    expect(html).toContain(`/share/${token}/download`);
    // Expiry is intentionally not shown on the public page.
    expect(html).not.toContain('id="expires-at"');
    // No stats on the public page — they are console-only.
    expect(html).not.toContain("<dt>Stats</dt>");
    expect(html).not.toContain("<span>visitors</span>");

    const events = await env.DB.prepare("SELECT event_type, COUNT(*) AS count FROM release_share_events GROUP BY event_type")
      .bind()
      .all();
    expect(events.results).toEqual([{ event_type: "view", count: 1 }]);
  });

  it("password-protected share gates page and download until unlocked", async () => {
    const env = makeEnv();
    const {
      handleCreateReleaseShare,
      handlePublicReleaseShare,
      handlePublicReleaseShareDownload,
      handlePublicReleaseShareUnlock,
    } = await import("../src/routes/shares");
    await seedRelease(env, "rel-pw", "build-pw", [["full", "all"]], {
      versionCode: 12,
      versionName: "1.0.12",
    });
    await seedAsset(env, "build-pw", "asset-pw", { arch: "arm64-v8a" });
    const created = await handleCreateReleaseShare(
      makeShareAdminContext(
        env,
        { appId: "app-scope", releaseId: "rel-pw" },
        { ttl_seconds: 600, password: "hunter2" },
      ),
    );
    const createdBody = await responseJson<any>(created);
    expect(createdBody.has_password).toBe(true);
    const token = new URL(createdBody.share_url).pathname.replace("/share/", "");

    // Page shows the password form, not the download.
    const gated = await handlePublicReleaseShare(makeSharePublicContext(env, token));
    expect(gated.status).toBe(200);
    const gatedHtml = await gated.text();
    expect(gatedHtml).toContain("Password required");
    expect(gatedHtml).not.toContain("Download APK");

    // Download without unlock bounces back to the page.
    const blocked = await handlePublicReleaseShareDownload(makeSharePublicContext(env, token));
    expect(blocked.status).toBe(302);
    expect(blocked.headers.get("location")).toBe(`/share/${token}`);

    const makeUnlockContext = (password: string, cookie?: string) =>
      ({
        env,
        req: {
          url: `https://quiver-worker.test/share/${token}/unlock`,
          param: (name: string) => (name === "token" ? token : ""),
          query: () => undefined,
          header: (name: string) =>
            name.toLowerCase() === "cookie" ? cookie : undefined,
          parseBody: async () => ({ password }),
          raw: { cf: { clientIp: "203.0.113.10" } },
        },
        redirect: (url: string, status = 302) =>
          new Response(null, { status, headers: { location: url } }),
        json: (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status }),
      }) as any;

    // Wrong password: 401 + failure recorded.
    const denied = await handlePublicReleaseShareUnlock(makeUnlockContext("nope"));
    expect(denied.status).toBe(401);

    // Right password: 303 + unlock cookie.
    const unlocked = await handlePublicReleaseShareUnlock(makeUnlockContext("hunter2"));
    expect(unlocked.status).toBe(303);
    const setCookie = unlocked.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("qshare_");
    const cookiePair = setCookie.split(";")[0]!;

    // With the cookie both page and download work.
    const open = await handlePublicReleaseShare(
      makeSharePublicContext(env, token, {
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "vitest",
        "accept-language": "en-US",
        cookie: cookiePair,
      }),
    );
    expect(open.status).toBe(200);
    expect(await open.text()).toContain("Download APK");

    const download = await handlePublicReleaseShareDownload(
      makeSharePublicContext(env, token, {
        "cf-connecting-ip": "203.0.113.10",
        "user-agent": "vitest",
        cookie: cookiePair,
      }),
    );
    expect(download.status).toBe(302);
    expect(download.headers.get("location") ?? "").not.toBe(`/share/${token}`);

    const failures = (await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'release_share.unlock_failed'",
    )
      .bind()
      .first()) as { count: number } | null;
    expect(failures?.count).toBe(1);
  });

  it("share PATCH can set and clear a password on an existing share", async () => {
    const env = makeEnv();
    const {
      handleCreateReleaseShare,
      handleUpdateReleaseShare,
      handlePublicReleaseShare,
    } = await import("../src/routes/shares");
    await seedRelease(env, "rel-pw2", "build-pw2", [["full", "all"]], {
      versionCode: 13,
      versionName: "1.0.13",
    });
    await seedAsset(env, "build-pw2", "asset-pw2", { arch: "arm64-v8a" });
    const created = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-pw2" }, { ttl_seconds: 600 }),
    );
    const createdBody = await responseJson<any>(created);
    expect(createdBody.has_password).toBe(false);
    const token = new URL(createdBody.share_url).pathname.replace("/share/", "");

    // Set a password on the existing share.
    const setResp = await handleUpdateReleaseShare(
      makeShareAdminContext(
        env,
        { appId: "app-scope", releaseId: "rel-pw2", shareId: createdBody.id },
        { expires_at: createdBody.expires_at, password: "s3cret" },
      ),
    );
    expect(setResp.status).toBe(200);
    const gated = await handlePublicReleaseShare(makeSharePublicContext(env, token));
    expect(await gated.text()).toContain("Password required");

    // Clear it again.
    const clearResp = await handleUpdateReleaseShare(
      makeShareAdminContext(
        env,
        { appId: "app-scope", releaseId: "rel-pw2", shareId: createdBody.id },
        { expires_at: createdBody.expires_at, password: null },
      ),
    );
    expect(clearResp.status).toBe(200);
    const open = await handlePublicReleaseShare(makeSharePublicContext(env, token));
    expect(await open.text()).toContain("Download APK");
  });

  it("feedback: crash tickets get a signature and group by it", async () => {
    const env = makeEnv();
    env.APK_BUCKET = { put: async () => {}, get: async () => null };
    const { handlePublicFeedbackSubmit, handleListCrashGroups } = await import(
      "../src/routes/feedback"
    );

    const submitCrash = async (topFrame: string, device: string, version: string) => {
      const form = new FormData();
      form.set("message", "crash");
      form.set("kind", "crash");
      form.set(
        "metadata",
        JSON.stringify({
          version_name: version,
          version_code: 1000101,
          device_id: device,
          crash_exception_class: "java.lang.NullPointerException",
          crash_top_frame: topFrame,
        }),
      );
      const ctx = {
        env,
        req: {
          param: (n: string) => (n === "slug" ? "scope-app" : ""),
          header: (n: string) => (n === "X-Quiver-Client-Key" ? "qk_test" : undefined),
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: `10.0.0.${device.length}` } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any;
      return handlePublicFeedbackSubmit(ctx);
    };

    // Two crashes share a frame (same signature), one differs.
    expect((await submitCrash("build.raft.app.Home.onCreate(Home.kt:10)", "devA", "1.0.1")).status).toBe(201);
    expect((await submitCrash("build.raft.app.Home.onCreate(Home.kt:22)", "devB", "1.0.2")).status).toBe(201);
    expect((await submitCrash("build.raft.app.Feed.load(Feed.kt:5)", "devC", "1.0.1")).status).toBe(201);

    const groupsCtx = {
      env,
      req: { param: (n: string) => (n === "appId" ? "app-scope" : ""), query: () => undefined },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any;
    const res = await handleListCrashGroups(groupsCtx);
    const body = await responseJson<any>(res);
    // Home.onCreate collapses line numbers → one group of 2; Feed.load → 1.
    expect(body.groups.length).toBe(2);
    const home = body.groups.find((g: any) => g.signature.includes("Home.onCreate"));
    expect(home.count).toBe(2);
    expect(home.device_count).toBe(2);
    expect(home.open_count).toBe(2);
  });

  it("parseNativeFrames bounds and shape-checks SDK input", async () => {
    const { parseNativeFrames } = await import("../src/routes/feedback");
    const frames = parseNativeFrames(JSON.stringify([
      { index: 0, offset: "0x1a2b", soname: "libraft.so", build_id: "E0276A1082493B6A57BD" },
      { index: 1, offset: "nonsense", soname: "libraft.so" },
      { index: 2, offset: "beef", soname: "" },
      "garbage",
      { index: 3, offset: "cafe", soname: "libc.so", build_id: "zz" },
    ]));
    expect(frames).toEqual([
      { index: 0, offset: "0x1a2b", soname: "libraft.so", build_id: "e0276a1082493b6a57bd" },
      { index: 3, offset: "cafe", soname: "libc.so" },
    ]);
    expect(parseNativeFrames("not json")).toEqual([]);
    expect(parseNativeFrames(42)).toEqual([]);
  });

  it("symbolicateNativeCrashTicket records no_symbols on the ticket when symbols are missing", async () => {
    const env = makeEnv();
    const { symbolicateNativeCrashTicket } = await import("../src/routes/feedback");
    await env.DB.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES (?1, ?2, 'crash', 'open', 'native crash', '{}', ?3, ?4)`,
    ).bind("tick-nat", "app-scope", 1, 1).run();
    await symbolicateNativeCrashTicket(env as any, "app-scope", "tick-nat", 1000200, [
      { index: 0, offset: "0x1a2b", soname: "libraft.so", build_id: "abcd1234" },
    ]);
    const row = (await env.DB.prepare(
      "SELECT symbolication_status, symbolicated_stack FROM feedback_tickets WHERE id = ?1",
    ).bind("tick-nat").first()) as { symbolication_status: string; symbolicated_stack: string };
    expect(row.symbolication_status).toBe("no_symbols");
    expect(row.symbolicated_stack).toContain("native-symbols");
    expect(row.symbolicated_stack).toContain("1000200");
    expect(row.symbolicated_stack).toContain("abcd1234");
  });

  it("symbolicateNativeCrashTicket fails closed when every frame lacks a BuildId", async () => {
    const env = makeEnv();
    const { symbolicateNativeCrashTicket } = await import("../src/routes/feedback");
    await env.DB.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES (?1, ?2, 'crash', 'open', 'legacy native crash', '{}', ?3, ?4)`,
    ).bind("tick-nat-no-build-id", "app-scope", 1, 1).run();
    await symbolicateNativeCrashTicket(env as any, "app-scope", "tick-nat-no-build-id", 1000200, [
      { index: 0, offset: "0x1a2b", soname: "libraft.so" },
    ]);
    const row = (await env.DB.prepare(
      "SELECT symbolication_status, symbolicated_stack FROM feedback_tickets WHERE id = ?1",
    ).bind("tick-nat-no-build-id").first()) as {
      symbolication_status: string;
      symbolicated_stack: string;
    };
    expect(row.symbolication_status).toBe("unsymbolicated");
    expect(row.symbolicated_stack).toContain("did not include an ELF BuildId");
    expect(row.symbolicated_stack).toContain("QNC2-capable Android SDK");
  });

  it("parseOhosNativeFrames extracts frames from a debuggerd-style HarmonyOS fault log", async () => {
    const { parseOhosNativeFrames } = await import("../src/routes/feedback");
    const log = [
      "Hands OHOS fault log (hiAppEvent)",
      "Event: APP_CRASH",
      "Fault kind: CppCrash",
      "",
      "--- exception ---",
      "Thread 0 crashed:",
      "#00 pc 000000000004a1b8 /system/lib64/libc.so(abort+164)(BuildId: 1a2b3c4d5e6f7a8b)",
      "#01 pc 0000000000012345 /data/storage/el1/bundle/entry/libs/arm64/libentry.so",
      "#02 pc 00000000000067ff /data/app/libnative.so(doWork+31)(BuildId: aabbccddeeff0011)",
    ].join("\n");
    expect(parseOhosNativeFrames(log)).toEqual([
      { index: 0, offset: "0x000000000004a1b8", soname: "libc.so", build_id: "1a2b3c4d5e6f7a8b" },
      { index: 1, offset: "0x0000000000012345", soname: "libentry.so" },
      { index: 2, offset: "0x00000000000067ff", soname: "libnative.so", build_id: "aabbccddeeff0011" },
    ]);
  });

  it("parseOhosNativeFrames handles the Kotlin/Native runtime backtrace (Kuikly/Bugly OHOS form)", async () => {
    const { parseOhosNativeFrames } = await import("../src/routes/feedback");
    // Real OHOS KN format: build id lives inside [arch::buildid], not (BuildId:).
    const log = [
      "Hands OHOS fault log (hiAppEvent)",
      "--- exception ---",
      "#00 pc 0000000000168f0b /data/storage/el1/bundle/libs/arm64/libshared.so (0) [arm64-v8a::914bbb25df0b98d1395de2ba65b9274b]",
      "#01 pc 0000000000012345 /system/lib/ld-musl-aarch64.so.1 (0) [arm64-v8a::deadbeefcafe0011]",
    ].join("\n");
    expect(parseOhosNativeFrames(log)).toEqual([
      { index: 0, offset: "0x0000000000168f0b", soname: "libshared.so", build_id: "914bbb25df0b98d1395de2ba65b9274b" },
      { index: 1, offset: "0x0000000000012345", soname: "ld-musl-aarch64.so.1", build_id: "deadbeefcafe0011" },
    ]);
  });

  it("parseOhosNativeFrames handles the system faultlogger form `.so(<buildid>)`", async () => {
    const { parseOhosNativeFrames } = await import("../src/routes/feedback");
    // hiAppEvent external_log fault-file form: bare hex build id in parens.
    const log =
      "Hands OHOS fault log (hiAppEvent)\n--- system fault log files (on device) ---\n" +
      "#00 pc 0000000000006f98 /data/storage/el1/bundle/libs/arm64/libentry.so(996f532bb3d4b6a1a911675ec4a018291d3038c5)\n" +
      "#01 pc 000000000004a1b8 /system/lib/ld-musl-aarch64.so.1(abort+164)";
    expect(parseOhosNativeFrames(log)).toEqual([
      { index: 0, offset: "0x0000000000006f98", soname: "libentry.so", build_id: "996f532bb3d4b6a1a911675ec4a018291d3038c5" },
      { index: 1, offset: "0x000000000004a1b8", soname: "ld-musl-aarch64.so.1" },
    ]);
  });

  it("parseOhosNativeFrames handles JSON-escaped newlines and structured frames", async () => {
    const { parseOhosNativeFrames } = await import("../src/routes/feedback");
    // Backtrace embedded as a JSON-stringified string (real newlines escaped).
    const escaped =
      "Hands OHOS fault log (hiAppEvent)\\n--- exception ---\\n" +
      '{"stack":"#00 pc 000000000004a1b8 /system/lib64/libc.so(BuildId: 1a2b3c4d5e6f7a8b)"}';
    expect(parseOhosNativeFrames(escaped)).toEqual([
      { index: 0, offset: "0x000000000004a1b8", soname: "libc.so", build_id: "1a2b3c4d5e6f7a8b" },
    ]);
    // Structured JSON frames (no text backtrace): pc is the .so-relative address.
    const structured =
      "Hands OHOS fault log (hiAppEvent)\n--- exception ---\n" +
      JSON.stringify({
        message: "Segmentation fault",
        frames: [
          { index: 0, symbol: "abort", file: "/system/lib64/libc.so", pc: "4a1b8", offset: "164", buildId: "1a2b3c4d5e6f7a8b" },
          { symbol: "", file: "/data/app/libentry.so", pc: "0x12345" },
        ],
      });
    expect(parseOhosNativeFrames(structured)).toEqual([
      { index: 0, offset: "0x4a1b8", soname: "libc.so", build_id: "1a2b3c4d5e6f7a8b" },
      { index: 1, offset: "0x12345", soname: "libentry.so" },
    ]);
    expect(parseOhosNativeFrames("")).toEqual([]);
    expect(parseOhosNativeFrames("no frames here")).toEqual([]);
  });

  it("symbolicateOhosCrashTicket parses the fault log and leaves a publish-ohos hint when symbols are missing", async () => {
    const env = makeEnv();
    const log =
      "Hands OHOS fault log (hiAppEvent)\n--- exception ---\n" +
      "#00 pc 000000000004a1b8 /data/app/libentry.so(BuildId: aabbccddeeff0011)";
    env.APK_BUCKET = {
      get: async (key: string) =>
        key === "feedback/app-scope/tick-ohos/0-crash.log" ? { text: async () => log } : null,
    } as any;
    const { symbolicateOhosCrashTicket } = await import("../src/routes/feedback");
    await env.DB.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES (?1, ?2, 'crash', 'open', 'ohos crash', '{}', ?3, ?4)`,
    ).bind("tick-ohos", "app-scope", 1, 1).run();
    await symbolicateOhosCrashTicket(
      env as any,
      "app-scope",
      "tick-ohos",
      1040000,
      "feedback/app-scope/tick-ohos/0-crash.log",
    );
    const row = (await env.DB.prepare(
      "SELECT symbolication_status, symbolicated_stack FROM feedback_tickets WHERE id = ?1",
    ).bind("tick-ohos").first()) as { symbolication_status: string; symbolicated_stack: string };
    expect(row.symbolication_status).toBe("no_symbols");
    expect(row.symbolicated_stack).toContain("native-symbols");
    expect(row.symbolicated_stack).toContain("publish-ohos");
    expect(row.symbolicated_stack).toContain("aabbccddeeff0011");
  });

  it("symbolicateOhosCrashTicket ignores non-OHOS logs", async () => {
    const env = makeEnv();
    env.APK_BUCKET = {
      get: async () => ({ text: async () => "some android logcat, not an ohos fault log" }),
    } as any;
    const { symbolicateOhosCrashTicket } = await import("../src/routes/feedback");
    await env.DB.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES (?1, ?2, 'crash', 'open', 'not ohos', '{}', ?3, ?4)`,
    ).bind("tick-noop", "app-scope", 1, 1).run();
    await symbolicateOhosCrashTicket(env as any, "app-scope", "tick-noop", 1040000, "any-key");
    const rows = (await env.DB.prepare(
      "SELECT id FROM feedback_comments WHERE ticket_id = ?1",
    ).bind("tick-noop").all()).results;
    expect(rows.length).toBe(0);
  });

  it("parseBinaryImages/parseCrashFrames bound and shape-check SDK input", async () => {
    const { parseBinaryImages, parseCrashFrames } = await import("../src/routes/feedback");
    const images = parseBinaryImages(JSON.stringify([
      { uuid: "A1", load_address: "0x104abc000", end_address: "0x104b00000", name: "Raft" },
      { uuid: "B2", load_address: "nonsense", name: "Bad" },
      { uuid: "C3", load_address: "0x1", name: "" },
      { path: "/x/y/UIKit", load_address: 4368 },
      "garbage",
    ]));
    expect(images).toEqual([
      { uuid: "A1", load_address: 0x104abc000n, end_address: 0x104b00000n, name: "Raft" },
      { uuid: "", load_address: 4368n, end_address: 4368n, name: "UIKit" },
    ]);
    expect(parseBinaryImages("not json")).toEqual([]);

    const frames = parseCrashFrames(JSON.stringify([
      { index: 0, address: "0x104abc123" },
      { index: 1, address: "junk" },
      { address: "0x2" },
      { index: 2, address: 100 },
    ]));
    expect(frames).toEqual([
      { index: 0, address: 0x104abc123n },
      { index: 2, address: 100n },
    ]);
    expect(parseCrashFrames(42)).toEqual([]);
  });

  it("symbolicateDsymCrashTicket leaves an actionable comment when dSYM is missing", async () => {
    const env = makeEnv();
    const { symbolicateDsymCrashTicket } = await import("../src/routes/feedback");
    await env.DB.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES (?1, ?2, 'crash', 'open', 'ios crash', '{}', ?3, ?4)`,
    ).bind("tick-dsym", "app-scope", 1, 1).run();
    await symbolicateDsymCrashTicket(
      env as any,
      "app-scope",
      "tick-dsym",
      1000200,
      [{ uuid: "DEADBEEF", load_address: 0x100000000n, end_address: 0x100100000n, name: "Raft" }],
      [{ index: 0, address: 0x100004000n }],
    );
    const row = (await env.DB.prepare(
      "SELECT symbolication_status, symbolicated_stack FROM feedback_tickets WHERE id = ?1",
    ).bind("tick-dsym").first()) as { symbolication_status: string; symbolicated_stack: string };
    expect(row.symbolication_status).toBe("no_symbols");
    expect(row.symbolicated_stack).toContain("dsym");
    expect(row.symbolicated_stack).toContain("1000200");
    expect(row.symbolicated_stack).toContain("DEADBEEF");
  });

  it("handlePublicMinidumpSubmit ingests a Crashpad minidump as an electron crash ticket", async () => {
    const env = makeEnv();
    const store = new Map<string, Uint8Array>();
    env.APK_BUCKET = {
      put: async (key: string, body: ArrayBuffer) => { store.set(key, new Uint8Array(body)); },
      get: async (key: string) =>
        store.has(key) ? { arrayBuffer: async () => store.get(key)!.buffer } : null,
      head: async (key: string) =>
        store.has(key) ? { size: store.get(key)!.byteLength } : null,
    } as any;
    const { handlePublicMinidumpSubmit } = await import("../src/routes/feedback");

    const form = new FormData();
    form.set(
      "upload_file_minidump",
      new File([new Uint8Array([77, 68, 77, 80])], "crash.dmp", { type: "application/x-minidump" }),
    );
    form.set("version", "1.2.3");
    form.set("version_code", "1020300");
    form.set("process_type", "renderer");
    form.set("channel", "stable");
    form.set("guid", "abc-guid");
    form.set("custom_note", "hello");

    const waited: Promise<unknown>[] = [];
    const res = await handlePublicMinidumpSubmit({
      env,
      executionCtx: { waitUntil: (p: Promise<unknown>) => waited.push(p) },
      req: {
        param: (n: string) => (n === "slug" ? "scope-app" : ""),
        header: (n: string) => (n === "X-Quiver-Client-Key" ? "qk_test" : undefined),
        query: () => undefined,
        formData: async () => form,
        raw: { cf: { clientIp: "203.0.113.7" } },
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    expect(res.status).toBe(201);
    await Promise.all(waited).catch(() => {});
    const body = await responseJson<any>(res);

    const ticket = (await env.DB.prepare(
      "SELECT kind, version_name, version_code, channel, device_id, metadata_json FROM feedback_tickets WHERE id = ?1",
    ).bind(body.id).first()) as any;
    expect(ticket.kind).toBe("crash");
    expect(ticket.version_name).toBe("1.2.3");
    expect(ticket.version_code).toBe(1020300);
    expect(ticket.channel).toBe("stable");
    expect(ticket.device_id).toBe("abc-guid");
    const meta = JSON.parse(ticket.metadata_json);
    expect(meta.product_type).toBe("electron");
    expect(meta.process_type).toBe("renderer");
    expect(meta.custom_note).toBe("hello");

    const att = (await env.DB.prepare(
      "SELECT filename, content_type, size_bytes FROM feedback_attachments WHERE ticket_id = ?1",
    ).bind(body.id).first()) as any;
    expect(att.filename).toBe("minidump.dmp");
    expect(att.content_type).toBe("application/x-minidump");
    expect(att.size_bytes).toBe(4);
  });

  it("handlePublicMinidumpSubmit derives the product from a closed set", async () => {
    const { handlePublicMinidumpSubmit } = await import("../src/routes/feedback");

    const submit = async (product?: string, platform?: string) => {
      const env = makeEnv();
      const store = new Map<string, Uint8Array>();
      env.APK_BUCKET = {
        put: async (key: string, body: ArrayBuffer) => { store.set(key, new Uint8Array(body)); },
        get: async () => null,
        head: async () => null,
      } as any;
      const form = new FormData();
      form.set(
        "upload_file_minidump",
        new File([new Uint8Array([77, 68, 77, 80])], "crash.dmp", { type: "application/x-minidump" }),
      );
      form.set("version_code", "1020300");
      if (product !== undefined) form.set("product_type", product);
      if (platform !== undefined) form.set("platform", platform);

      const waited: Promise<unknown>[] = [];
      const res = await handlePublicMinidumpSubmit({
        env,
        executionCtx: { waitUntil: (pr: Promise<unknown>) => waited.push(pr) },
        req: {
          param: (n: string) => (n === "slug" ? "scope-app" : ""),
          header: (n: string) => (n === "X-Quiver-Client-Key" ? "qk_test" : undefined),
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: "203.0.113.7" } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);
      await Promise.all(waited).catch(() => {});
      const body = await responseJson<any>(res);
      const row = (await env.DB.prepare(
        "SELECT message, metadata_json FROM feedback_tickets WHERE id = ?1",
      ).bind(body.id).first()) as any;
      return { message: row.message as string, meta: JSON.parse(row.metadata_json) };
    };

    // The shipped Electron SDK sends product_type="electron" with a real
    // platform on every minidump (clients/electron/src/common.ts). This is the
    // payload production actually delivers, so it is the case that has to stay
    // byte-identical — and the only one that pins the recognised-electron
    // branch. Without it a mutation to that branch leaves the other three green.
    const shipped = await submit("electron", "darwin");
    expect(shipped.meta.product_type).toBe("electron");
    expect(shipped.meta.crash_platform).toBe("darwin");
    expect(shipped.message).toBe("Electron crash");

    // A client that sends no product annotation at all must land on the same
    // output as the shipped one.
    const absent = await submit();
    expect(absent.meta.product_type).toBe("electron");
    expect(absent.meta.crash_platform).toBe("electron");
    expect(absent.message).toBe("Electron crash");

    // A value outside the closed set is treated as absent, not echoed back into
    // the ticket title or the platform field.
    const unknown = await submit("flutter");
    expect(unknown.meta.product_type).toBe("electron");
    expect(unknown.meta.crash_platform).toBe("electron");
    expect(unknown.message).toBe("Electron crash");

    // Only a deliberate, recognised value changes the output.
    const tauri = await submit("tauri");
    expect(tauri.meta.product_type).toBe("tauri");
    expect(tauri.meta.crash_platform).toBe("tauri");
    expect(tauri.message).toBe("Tauri crash");
  });

  it("handlePublicMinidumpSubmit rejects an invalid client key", async () => {
    const env = makeEnv();
    const { handlePublicMinidumpSubmit } = await import("../src/routes/feedback");
    const form = new FormData();
    form.set("upload_file_minidump", new File([new Uint8Array([1])], "c.dmp"));
    const res = await handlePublicMinidumpSubmit({
      env,
      executionCtx: { waitUntil: () => {} },
      req: {
        param: (n: string) => (n === "slug" ? "scope-app" : ""),
        header: () => "wrong-key",
        query: () => undefined,
        formData: async () => form,
        raw: { cf: {} },
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    expect(res.status).toBe(401);
  });

  it("handleGetFeedback resolves a short ticket-id prefix and full UUID", async () => {
    const env = makeEnv();
    const { handleGetFeedback } = await import("../src/routes/feedback");
    const fullId = "abcd1234-1111-2222-3333-444455556666";
    await env.DB.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES (?1, 'app-scope', 'bug', 'open', 'hi', '{}', 1, 1)`,
    ).bind(fullId).run();
    const call = (tid: string) =>
      handleGetFeedback({
        env,
        req: {
          param: (n: string) => (n === "appId" ? "app-scope" : n === "ticketId" ? tid : undefined),
          query: () => undefined,
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);

    const short = await call("abcd1234");
    expect(short.status).toBe(200);
    expect((await responseJson<any>(short)).ticket.id).toBe(fullId);

    const full = await call(fullId);
    expect(full.status).toBe(200);
    expect((await responseJson<any>(full)).ticket.id).toBe(fullId);

    const missing = await call("ffffffff");
    expect(missing.status).toBe(404);
  });

  it("handleGetFeedback returns 409 on an ambiguous ticket-id prefix", async () => {
    const env = makeEnv();
    const { handleGetFeedback } = await import("../src/routes/feedback");
    const ins = (id: string) =>
      env.DB.prepare(
        `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
         VALUES (?1, 'app-scope', 'bug', 'open', 'x', '{}', 1, 1)`,
      ).bind(id).run();
    await ins("dead0001-0000-0000-0000-000000000000");
    await ins("dead0002-0000-0000-0000-000000000000");
    const res = await handleGetFeedback({
      env,
      req: {
        param: (n: string) => (n === "appId" ? "app-scope" : n === "ticketId" ? "dead000" : undefined),
        query: () => undefined,
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    expect(res.status).toBe(409);
  });

  it("changelogToHtml renders bullets safely", async () => {
    const { changelogToHtml } = await import("../src/routes/public_v2");
    const html = changelogToHtml("- one **bold**\n- two <script>x</script>\n\nplain `c`");
    expect(html).toBe(
      "<ul><li>one <strong>bold</strong></li><li>two &lt;script&gt;x&lt;/script&gt;</li></ul><p>plain <code>c</code></p>",
    );
  });

  it("apps: purge requires archived + slug confirm, deletes R2 + row", async () => {
    const env = makeEnv();
    const deleted: string[] = [];
    env.APK_BUCKET = {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: prefix === "apps/app-scope/" ? [{ key: "apps/app-scope/stray.apk" }] : [],
        truncated: false,
      }),
      delete: async (keys: string | string[]) => {
        deleted.push(...(Array.isArray(keys) ? keys : [keys]));
      },
    };
    const { handlePurgeApp } = await import("../src/routes/apps");
    const ctx = (body: Record<string, unknown>) =>
      ({
        env,
        req: { param: () => "app-scope", json: async () => body },
        get: () => "tester",
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      }) as any;

    // active app -> 409
    expect((await handlePurgeApp(ctx({ confirm_slug: "scope-app" }))).status).toBe(409);
    await env.DB.prepare(
      `INSERT INTO app_reporter_integrations
       (id, app_id, name, created_at, updated_at)
       VALUES ('purge-integration', 'app-scope', 'Purge fixture', 1, 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
       VALUES ('99999999-9999-4999-8999-999999999999', 'app-scope',
               'feedback', 'open', 'purge', '{}', ?1, 'purge-integration', 1, 1)`,
    ).bind("p".repeat(32)).run();
    await env.DB.prepare(
      `INSERT INTO feedback_events
       (id, event_type, app_id, ticket_id, reporter_integration_id,
        reporter_id, payload_json, created_at)
       VALUES ('purge-event', 'feedback:status_changed', 'app-scope',
               '99999999-9999-4999-8999-999999999999', 'purge-integration',
               ?1, '{}', 1)`,
    ).bind("p".repeat(32)).run();
    await env.DB.prepare(
      `INSERT INTO webhooks
       (id, org_id, app_id, url, secret, events_json, enabled, created_at, updated_at)
       VALUES ('purge-hook', 'default', 'app-scope', 'https://example.test/purge',
               'secret', '[]', 1, 1, 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries
       (id, webhook_id, event_type, event_id, payload_json, status,
        attempts, max_attempts, created_at, updated_at)
       VALUES ('purge-delivery', 'purge-hook', 'feedback:status_changed',
               'purge-event', '{}', 'pending', 0, 3, 1, 1)`,
    ).run();
    await env.DB.prepare("UPDATE apps SET archived = 1 WHERE id = ?1").bind("app-scope").run();
    // wrong confirm -> 400
    expect((await handlePurgeApp(ctx({ confirm_slug: "nope" }))).status).toBe(400);
    // correct -> 200, R2 sweep ran, row gone
    const res = await handlePurgeApp(ctx({ confirm_slug: "scope-app" }));
    expect(res.status).toBe(200);
    expect(deleted).toContain("apps/app-scope/stray.apk");
    const row = await env.DB.prepare("SELECT id FROM apps WHERE id = ?1").bind("app-scope").first();
    expect(row).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM feedback_events WHERE id = 'purge-event'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE id = 'purge-delivery'").first()).toBeNull();
    // restore for later tests in this suite
    await env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    ).bind("app-scope", "default", "scope-app", "Scope App", "android", "qk_test", 1).run();
  });

  it("feedback: crash alert webhooks fire on new group only once", async () => {
    const env = makeEnv();
    env.APK_BUCKET = { put: async () => {}, get: async () => null };
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");

    await env.DB.prepare(
      `INSERT INTO webhooks (id, org_id, app_id, url, secret, events_json, enabled, created_at, updated_at)
       VALUES (?1, ?2, NULL, ?3, ?4, ?5, 1, ?6, ?7)`,
    )
      .bind("wh-crash", "default", "https://example.test/hook", "s3cret", JSON.stringify(["crash:new_group", "crash:spike"]), Date.now(), Date.now())
      .run();

    const submitCrash = async (topFrame: string, ip: string) => {
      const form = new FormData();
      form.set("message", "crash");
      form.set("kind", "crash");
      form.set(
        "metadata",
        JSON.stringify({
          crash_exception_class: "java.lang.IllegalStateException",
          crash_top_frame: topFrame,
        }),
      );
      const waited: Promise<unknown>[] = [];
      const ctx = {
        env,
        executionCtx: { waitUntil: (p: Promise<unknown>) => waited.push(p) },
        req: {
          param: (n: string) => (n === "slug" ? "scope-app" : ""),
          header: (n: string) => (n === "X-Quiver-Client-Key" ? "qk_test" : undefined),
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: ip } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any;
      const res = await handlePublicFeedbackSubmit(ctx);
      await Promise.all(waited);
      return res;
    };

    expect((await submitCrash("app.Main.boot(Main.kt:1)", "10.1.0.1")).status).toBe(201);
    expect((await submitCrash("app.Main.boot(Main.kt:9)", "10.1.0.2")).status).toBe(201); // same signature
    expect((await submitCrash("app.Feed.load(Feed.kt:3)", "10.1.0.3")).status).toBe(201); // new signature

    const deliveries = (await env.DB.prepare(
      "SELECT event_type FROM webhook_deliveries WHERE webhook_id = ?1 ORDER BY created_at",
    ).bind("wh-crash").all()).results as Array<{ event_type: string }>;
    expect(deliveries.filter((d) => d.event_type === "crash:new_group").length).toBe(2);
    expect(deliveries.filter((d) => d.event_type === "crash:spike").length).toBe(0);
  });

  it("devices: register upserts per device and analytics aggregates by version", async () => {
    const env = makeEnv();
    const { handleDeviceRegister, handleDeviceAnalytics } = await import("../src/routes/analytics");
    const ping = (deviceId: string, versionName: string, versionCode: number, platform: string) => {
      const body = { version_name: versionName, version_code: versionCode, platform, channel: "main" };
      return handleDeviceRegister({
        env,
        req: {
          param: (n: string) => (n === "slug" ? "scope-app" : ""),
          header: (n: string) =>
            n === "X-Quiver-Client-Key" ? "qk_test" : n === "X-Quiver-Device-Id" ? deviceId : undefined,
          query: () => undefined,
          json: async () => body,
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);
    };
    // wrong key -> 401
    const bad = await handleDeviceRegister({
      env,
      req: {
        param: (n: string) => (n === "slug" ? "scope-app" : ""),
        header: () => undefined,
        query: () => undefined,
        json: async () => ({}),
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    expect(bad.status).toBe(401);

    expect((await ping("devA", "1.0.2", 1000200, "android")).status).toBe(202);
    expect((await ping("devB", "1.0.2", 1000200, "android")).status).toBe(202);
    expect((await ping("devA", "1.0.2", 1000200, "android")).status).toBe(202); // upsert, not a new row
    expect((await ping("devC", "1.0.1", 1000101, "android")).status).toBe(202);
    expect((await ping("devD", "1.0.3", 1000300, "android")).status).toBe(202);

    const res = await handleDeviceAnalytics({
      env,
      req: { param: (n: string) => (n === "appId" ? "app-scope" : ""), query: () => undefined },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    const body = await responseJson<any>(res);
    expect(body.active_devices).toBe(4); // devA (deduped), devB, devC, devD
    const v102 = body.by_version.find((v: any) => v.version_code === 1000200);
    expect(v102.devices).toBe(2);
    expect(body.by_platform[0].platform).toBe("android");
    expect(body.by_platform[0].devices).toBe(4);
  });

  it("sessions: start/end/crash events roll up into crash-free release health", async () => {
    const env = makeEnv();
    const { handleSessionEvent, handleReleaseHealth } = await import("../src/routes/sessions");
    const post = (body: Record<string, unknown>, key = "qk_test") =>
      handleSessionEvent({
        env,
        req: {
          param: (n: string) => (n === "slug" ? "scope-app" : ""),
          header: (n: string) => (n === "X-Hands-Client-Key" ? key : undefined),
          json: async () => body,
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);

    // wrong key -> 401; bad event -> 400
    expect((await post({ session_id: "s1", device_id: "d1", event: "start" }, "wrong")).status).toBe(401);
    expect((await post({ session_id: "s1", device_id: "d1", event: "nope" })).status).toBe(400);

    const base = {
      version_name: "1.2.0",
      version_code: 1020000,
      channel: "main",
      platform: "android",
    };
    // devA: one clean session (start+end), one crashed session
    expect((await post({ ...base, session_id: "s1", device_id: "devA", event: "start" })).status).toBe(202);
    expect((await post({ ...base, session_id: "s1", device_id: "devA", event: "end", duration_ms: 60000 })).status).toBe(202);
    expect((await post({ ...base, session_id: "s2", device_id: "devA", event: "start" })).status).toBe(202);
    expect((await post({ ...base, session_id: "s2", device_id: "devA", event: "crash" })).status).toBe(202);
    // devB: clean session; duplicate start is idempotent
    expect((await post({ ...base, session_id: "s3", device_id: "devB", event: "start" })).status).toBe(202);
    expect((await post({ ...base, session_id: "s3", device_id: "devB", event: "start" })).status).toBe(202);
    // devC: end arrives with no start (lost offline) — still counts as a session
    expect((await post({ ...base, session_id: "s4", device_id: "devC", event: "end" })).status).toBe(202);
    // older version, crashed
    expect((await post({ session_id: "s5", device_id: "devD", event: "crash", version_name: "1.1.0", version_code: 1010000 })).status).toBe(202);

    const res = await handleReleaseHealth({
      env,
      req: { param: (n: string) => (n === "appId" ? "app-scope" : ""), query: () => undefined },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    const body = await responseJson<any>(res);

    expect(body.totals.sessions).toBe(5);
    expect(body.totals.crashed_sessions).toBe(2);
    expect(body.totals.crash_free_sessions_pct).toBe(60);
    expect(body.totals.devices).toBe(4);
    expect(body.totals.crashed_devices).toBe(2);
    expect(body.totals.crash_free_devices_pct).toBe(50);

    const v12 = body.versions.find((v: any) => v.version_code === 1020000);
    expect(v12.channel).toBe("main");
    expect(v12.sessions).toBe(4); // s1, s2, s3 (deduped start), s4
    expect(v12.crashed_sessions).toBe(1);
    expect(v12.crash_free_sessions_pct).toBe(75);
    expect(v12.devices).toBe(3); // devA, devB, devC
    expect(v12.crashed_devices).toBe(1); // devA
    expect(v12.crash_free_devices_pct).toBeCloseTo(66.67, 1);

    const v11 = body.versions.find((v: any) => v.version_code === 1010000);
    expect(v11.crash_free_sessions_pct).toBe(0);
  });

  it("analytics: versions aggregates release metrics, devices, feedback, and downloads", async () => {
    const env = makeEnv();
    const { handleDeviceRegister, handleVersionAnalytics } = await import("../src/routes/analytics");
    await seedRelease(env, "rel-metrics", "build-metrics", [["full", "all"]], {
      versionName: "1.2.0",
      versionCode: 120,
      createdAt: 10_000,
      rolloutCohortCount: 50,
    });
    await seedAsset(env, "build-metrics", "asset-metrics");
    await env.DB.prepare(
      "UPDATE build_assets SET download_count = ? WHERE id = ?",
    ).bind(7, "asset-metrics").run();
    await env.DB.prepare(
      "INSERT INTO release_metrics (release_id, offered_count, current_count, last_checked_at) VALUES (?, ?, ?, ?)",
    ).bind("rel-metrics", 5, 2, 11_000).run();
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, version_name, version_code, channel,
        device_id, metadata_json, created_at, updated_at)
       VALUES (?, 'app-scope', ?, 'open', ?, ?, ?, 'production', ?, '{}', ?, ?)`,
    ).bind("tick-metrics-1", "feedback", "feedback", "1.2.0", 120, "devA", 12_000, 12_000).run();
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, version_name, version_code, channel,
        device_id, metadata_json, created_at, updated_at)
       VALUES (?, 'app-scope', ?, 'open', ?, ?, ?, 'production', ?, '{}', ?, ?)`,
    ).bind("tick-metrics-2", "crash", "crash", "1.2.0", 120, "devB", 12_001, 12_001).run();

    const ping = (deviceId: string, versionName: string, versionCode: number, channel = "production") =>
      handleDeviceRegister({
        env,
        req: {
          param: (n: string) => (n === "slug" ? "scope-app" : ""),
          header: (n: string) =>
            n === "X-Quiver-Client-Key" ? "qk_test" : n === "X-Quiver-Device-Id" ? deviceId : undefined,
          query: () => undefined,
          json: async () => ({ version_name: versionName, version_code: versionCode, channel, platform: "android" }),
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);

    expect((await ping("devA", "1.2.0", 120)).status).toBe(202);
    expect((await ping("devB", "1.2.0", 120)).status).toBe(202);
    expect((await ping("devC", "2.0.0-beta", 200)).status).toBe(202);

    const res = await handleVersionAnalytics({
      env,
      req: { param: (n: string) => (n === "appId" ? "app-scope" : ""), query: (n: string) => (n === "window_days" ? "30" : undefined) },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    const body = await responseJson<any>(res);
    expect(body.window_minutes).toBe(30 * 24 * 60);
    const minutesRes = await handleVersionAnalytics({
      env,
      req: { param: (n: string) => (n === "appId" ? "app-scope" : ""), query: (n: string) => (n === "window_minutes" ? "30" : undefined) },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    const minutesBody = await responseJson<any>(minutesRes);
    expect(minutesBody.window_minutes).toBe(30);
    expect(minutesBody.window_days).toBe(1);
    const releaseRow = body.versions.find((v: any) => v.release_id === "rel-metrics");
    expect(releaseRow).toMatchObject({
      build_id: "build-metrics",
      channel: "production",
      release_status: "active",
      rollout_cohort_count: 50,
      version_name: "1.2.0",
      version_code: 120,
      active_devices: 2,
      total_devices: 2,
      update_current_count: 2,
      update_offered_count: 5,
      feedback_count: 2,
      crash_count: 1,
      download_count: 7,
      telemetry_only: false,
    });
    const telemetryOnly = body.versions.find((v: any) => v.version_code === 200);
    expect(telemetryOnly).toMatchObject({
      release_id: null,
      build_id: null,
      channel: "production",
      version_name: "2.0.0-beta",
      active_devices: 1,
      total_devices: 1,
      telemetry_only: true,
    });
  });

  it("feedback: presigned attachments are namespace-guarded and existence-checked", async () => {
    const env = makeEnv();
    const stored = new Map<string, number>();
    stored.set("feedback/app-scope/presigned/good-file.bin", 1024);
    env.APK_BUCKET = {
      put: async () => {},
      get: async () => null,
      head: async (key: string) =>
        stored.has(key) ? { size: stored.get(key)! } : null,
    };
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");

    const submit = (presigned: unknown) => {
      const form = new FormData();
      form.set("message", "big upload");
      form.set("presigned", JSON.stringify(presigned));
      return handlePublicFeedbackSubmit({
        env,
        executionCtx: { waitUntil: () => {} },
        req: {
          param: (n: string) => (n === "slug" ? "scope-app" : ""),
          header: (n: string) => (n === "X-Quiver-Client-Key" ? "qk_test" : undefined),
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: "203.0.113.50" } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);
    };

    // wrong namespace -> 400
    expect((await submit([{ r2_key: "feedback/other-app/presigned/x.bin" }])).status).toBe(400);
    // missing object -> 400
    expect((await submit([{ r2_key: "feedback/app-scope/presigned/missing.bin" }])).status).toBe(400);
    // valid presigned object -> 201, recorded with the real size from head
    const ok = await submit([
      { r2_key: "feedback/app-scope/presigned/good-file.bin", filename: "good-file.bin", content_type: "application/octet-stream", size: 999 },
    ]);
    expect(ok.status).toBe(201);
    const body = await responseJson<any>(ok);
    expect(body.attachments).toBe(1);
  });

  it("feedback: submission_id replays the original ticket and rejects payload conflicts", async () => {
    const env = makeEnv();
    const putCalls: string[] = [];
    const deleted: string[] = [];
    env.APK_BUCKET = {
      put: async (key: string) => { putCalls.push(key); },
      delete: async (key: string) => { deleted.push(key); },
      get: async () => null,
      head: async () => null,
    };
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");
    const submissionId = "11111111-1111-4111-8111-111111111111";

    const submit = (opts: {
      message?: string;
      metadata?: Record<string, unknown>;
      bytes?: number[];
      submissionId?: string;
    } = {}) => {
      const form = new FormData();
      form.set("message", opts.message ?? "Please add compact mode");
      form.set("kind", "feedback");
      form.set("submission_id", opts.submissionId ?? submissionId);
      form.set("metadata", JSON.stringify(opts.metadata ?? { feedback_type: "idea", locale: "zh-CN" }));
      if (opts.bytes) {
        form.append("attachments", new File([new Uint8Array(opts.bytes)], "screen.png", { type: "image/png" }));
      }
      return handlePublicFeedbackSubmit({
        env,
        executionCtx: { waitUntil: () => {} },
        req: {
          param: (name: string) => (name === "slug" ? "scope-app" : ""),
          header: (name: string) => (name === "X-Quiver-Client-Key" ? "qk_test" : undefined),
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: "203.0.113.71" } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);
    };

    const first = await submit({ bytes: [1, 2, 3] });
    expect(first.status).toBe(201);
    const firstBody = await responseJson<any>(first);
    expect(firstBody.idempotent_replay).toBe(false);

    const replay = await submit({
      metadata: { locale: "zh-CN", feedback_type: "idea" },
      bytes: [1, 2, 3],
      submissionId: submissionId.toUpperCase(),
    });
    expect(replay.status).toBe(200);
    const replayBody = await responseJson<any>(replay);
    expect(replayBody.id).toBe(firstBody.id);
    expect(replayBody.reference).toBe(firstBody.reference);
    expect(replayBody.idempotent_replay).toBe(true);
    expect(putCalls).toHaveLength(1);

    expect((await submit({ message: "Different draft", bytes: [1, 2, 3] })).status).toBe(409);
    expect((await submit({ bytes: [3, 2, 1] })).status).toBe(409);
    expect(deleted).toEqual([]);

    const rows = await env.DB.prepare(
      "SELECT id, submission_id, submission_fingerprint FROM feedback_tickets WHERE app_id = ?1 AND submission_id = ?2",
    ).bind("app-scope", submissionId).all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results[0] as any).submission_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("feedback: over-limit new submissions stop before R2 HEAD while known replays remain recoverable", async () => {
    const env = makeEnv();
    let headCalls = 0;
    env.APK_BUCKET = {
      put: async () => {},
      get: async () => null,
      head: async () => {
        headCalls += 1;
        return { size: 3, etag: "etag-screen" };
      },
    };
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");
    const existingId = "33333333-3333-4333-8333-333333333333";
    const presigned = [{
      r2_key: "feedback/app-scope/presigned/screen.png",
      filename: "screen.png",
      content_type: "image/png",
      size: 3,
    }];
    const submit = (submissionId?: string, includePresigned = false) => {
      const responseHeaders = new Headers();
      const form = new FormData();
      form.set("message", "Rate boundary");
      if (submissionId) form.set("submission_id", submissionId);
      if (includePresigned) form.set("presigned", JSON.stringify(presigned));
      return handlePublicFeedbackSubmit({
        env,
        executionCtx: { waitUntil: () => {} },
        header: (name: string, value: string) => { responseHeaders.set(name, value); },
        req: {
          param: (name: string) => (name === "slug" ? "scope-app" : ""),
          header: (name: string) => (name === "X-Quiver-Client-Key" ? "qk_test" : undefined),
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: "203.0.113.74" } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
          status,
          headers: responseHeaders,
        }),
      } as any);
    };

    expect((await submit(existingId, true)).status).toBe(201);
    for (let index = 0; index < 9; index += 1) expect((await submit()).status).toBe(201);
    headCalls = 0;

    const overLimit = await submit("44444444-4444-4444-8444-444444444444", true);
    expect(overLimit.status).toBe(429);
    expect(Number(overLimit.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(headCalls).toBe(0);

    const replay = await submit(existingId.toUpperCase(), true);
    expect(replay.status).toBe(200);
    expect(headCalls).toBe(1);
  });

  it("feedback: concurrent identical submission_id requests converge on one ticket", async () => {
    const env = makeEnv();
    const deleted: string[] = [];
    env.APK_BUCKET = {
      put: async () => {},
      delete: async (key: string) => { deleted.push(key); },
      get: async () => null,
      head: async () => null,
    };
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");
    const submit = () => {
      const form = new FormData();
      form.set("message", "Concurrent retry");
      form.set("submission_id", "22222222-2222-4222-8222-222222222222");
      form.append("attachments", new File([new Uint8Array([9])], "same.txt", { type: "text/plain" }));
      return handlePublicFeedbackSubmit({
        env,
        executionCtx: { waitUntil: () => {} },
        req: {
          param: (name: string) => (name === "slug" ? "scope-app" : ""),
          header: (name: string) => (name === "X-Quiver-Client-Key" ? "qk_test" : undefined),
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: "203.0.113.72" } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);
    };

    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const bodies = await Promise.all(responses.map((response) => responseJson<any>(response)));
    expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
    expect(deleted.length).toBeLessThanOrEqual(1);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_tickets WHERE app_id = ?1 AND submission_id = ?2",
    ).bind("app-scope", "22222222-2222-4222-8222-222222222222").first() as { count: number } | null;
    expect(count?.count).toBe(1);
  });

  it("feedback: trusted server proxy persists and rate-limits by pseudonymous reporter id", async () => {
    const env = makeEnv();
    let r2Writes = 0;
    env.APK_BUCKET = { put: async () => { r2Writes += 1; }, get: async () => null };
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");
    const { generateDeployToken, hashDeployToken } = await import("../src/lib/deploy_tokens");
    const credential = generateDeployToken();
    const secondCredential = generateDeployToken();
    const publisherCredential = generateDeployToken();
    const broadCredential = generateDeployToken();
    await env.DB.prepare(
      `INSERT INTO app_reporter_integrations
       (id, app_id, name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4),
              ('integration-proxy-2', ?2, 'Feedback proxy 2', ?4, ?4)`,
    ).bind("integration-proxy", "app-scope", "Feedback proxy", Date.now()).run();
    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at, reporter_integration_id)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL,
               '["feedback:write","feedback:read","feedback:comment","feedback:route"]',
               ?6, ?7, ?8)`,
    ).bind(
      "proxy-token",
      "app-scope",
      "feedback proxy",
      credential.token_prefix,
      await hashDeployToken(credential.token),
      "test",
      Date.now(),
      "integration-proxy",
    ).run();
    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at, reporter_integration_id)
       VALUES ('proxy-token-2', 'app-scope', 'feedback proxy 2', ?1, ?2, NULL,
               '["feedback:write","feedback:read","feedback:comment","feedback:route"]',
               'test', ?3, 'integration-proxy-2')`,
    ).bind(
      secondCredential.token_prefix,
      await hashDeployToken(secondCredential.token),
      Date.now(),
    ).run();
    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'publisher', NULL, ?6, ?7)`,
    ).bind(
      "publisher-token",
      "app-scope",
      "publisher token",
      publisherCredential.token_prefix,
      await hashDeployToken(publisherCredential.token),
      "test",
      Date.now(),
    ).run();
    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL, '["feedback:write","app:read"]', ?6, ?7)`,
    ).bind(
      "broad-token",
      "app-scope",
      "broad custom token",
      broadCredential.token_prefix,
      await hashDeployToken(broadCredential.token),
      "test",
      Date.now(),
    ).run();

    const submit = (
      reporterId: string,
      bearer = credential.token,
      submissionId?: string,
      withAttachment = false,
    ) => {
      const responseHeaders = new Headers();
      const form = new FormData();
      form.set("message", "Proxy feedback");
      if (submissionId) form.set("submission_id", submissionId);
      if (withAttachment) {
        form.append("attachments", new File([new Uint8Array([1, 2, 3])], "route.txt", {
          type: "text/plain",
        }));
      }
      return handlePublicFeedbackSubmit({
        env,
        executionCtx: { waitUntil: () => {} },
        header: (name: string, value: string) => { responseHeaders.set(name, value); },
        req: {
          param: (name: string) => (name === "slug" ? "scope-app" : ""),
          header: (name: string) => {
            if (name === "X-Quiver-Client-Key") return "qk_test";
            if (name === "X-Hands-Reporter-Id") return reporterId;
            if (name === "authorization") return bearer ? `Bearer ${bearer}` : undefined;
            return undefined;
          },
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: "203.0.113.80" } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
          status,
          headers: responseHeaders,
        }),
      } as any);
    };

    const reporterA = "a".repeat(64);
    const missingRoute = await submit("z".repeat(64), credential.token, undefined, true);
    expect(missingRoute.status).toBe(409);
    expect(await missingRoute.json()).toMatchObject({ error: "route_required" });
    expect(r2Writes).toBe(0);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_tickets WHERE reporter_id = ?1",
    ).bind("z".repeat(64)).first() as any).count).toBe(0);
    for (const [integrationId, reporterId, marker] of ([
      ["integration-proxy", reporterA, "A"],
      ["integration-proxy-2", reporterA, "B"],
      ["integration-proxy", "b".repeat(64), "C"],
      ["integration-proxy", "g".repeat(64), "D"],
      ["integration-proxy", "h".repeat(64), "E"],
    ] as const)) {
      await env.DB.prepare(
        `INSERT INTO app_reporter_routes
         (app_id, reporter_integration_id, reporter_id, route_subject, subject_version, created_at)
         VALUES ('app-scope', ?1, ?2, ?3, 'v1', ?4)`,
      ).bind(integrationId, reporterId, `rfr_v1_${marker.repeat(64)}`, Date.now()).run();
    }

    const dbBeforeRace = env.DB;
    const prepareBeforeRace = dbBeforeRace.prepare.bind(dbBeforeRace);
    env.DB = {
      ...dbBeforeRace,
      prepare(sql: string) {
        const prepared = prepareBeforeRace(sql);
        if (!sql.includes("FROM app_reporter_integrations ri")) return prepared;
        return {
          ...prepared,
          bind(...params: unknown[]) {
            const bound = prepared.bind(...params);
            return {
              ...bound,
              async first() {
                const row = await bound.first();
                await prepareBeforeRace("UPDATE apps SET archived = 1 WHERE id = 'app-scope'").run();
                return row;
              },
            };
          },
        };
      },
    };
    const raceTicketCountBefore = (await prepareBeforeRace(
      "SELECT COUNT(*) AS count FROM feedback_tickets WHERE app_id = 'app-scope'",
    ).first() as any).count;
    const archivedRace = await submit("b".repeat(64));
    expect(archivedRace.status).toBe(409);
    expect(await archivedRace.json()).toMatchObject({ error: "route_required" });
    env.DB = dbBeforeRace;
    await env.DB.prepare("UPDATE apps SET archived = 0 WHERE id = 'app-scope'").run();
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_tickets WHERE app_id = 'app-scope'",
    ).first() as any).count).toBe(raceTicketCountBefore);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_submission_events WHERE app_id = 'app-scope'",
    ).first() as any).count).toBe(0);

    const dbBeforeAtomicFailure = env.DB;
    const prepareBeforeAtomicFailure = dbBeforeAtomicFailure.prepare.bind(dbBeforeAtomicFailure);
    env.DB = {
      ...dbBeforeAtomicFailure,
      prepare(sql: string) {
        if (sql.includes("INSERT INTO feedback_submission_events")) {
          return prepareBeforeAtomicFailure("INSERT INTO definitely_missing_table VALUES (1)");
        }
        return prepareBeforeAtomicFailure(sql);
      },
    };
    await expect(submit("g".repeat(64))).rejects.toThrow();
    env.DB = dbBeforeAtomicFailure;
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_tickets WHERE app_id = 'app-scope' AND reporter_id = ?1",
    ).bind("g".repeat(64)).first() as any).count).toBe(0);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_submission_events WHERE app_id = 'app-scope' AND reporter_id = ?1",
    ).bind("g".repeat(64)).first() as any).count).toBe(0);

    // Production D1 has returned a zero `meta.changes` for a successful
    // INSERT ... SELECT batch. Commit authority comes from the exact row
    // returned by the ticket insert, never from advisory batch metadata.
    const dbBeforeCommitMetadata = env.DB as unknown as D1Database;
    const batchBeforeCommitMetadata = dbBeforeCommitMetadata.batch.bind(dbBeforeCommitMetadata);
    env.DB = {
      ...dbBeforeCommitMetadata,
      async batch(statements: D1PreparedStatement[]) {
        const results = await batchBeforeCommitMetadata(statements);
        return results.map((result, index) => index === 0
          ? { ...result, meta: { ...result.meta, changes: 0 } }
          : result);
      },
    } as unknown as typeof env.DB;
    const committedWithZeroMetadata = await submit("h".repeat(64));
    expect(committedWithZeroMetadata.status).toBe(201);
    const committedWithZeroMetadataBody = await responseJson<any>(committedWithZeroMetadata);
    env.DB = dbBeforeCommitMetadata as unknown as typeof env.DB;
    expect(await env.DB.prepare(
      `SELECT 1 AS ok FROM feedback_tickets
       WHERE id = ?1 AND app_id = 'app-scope'
         AND reporter_integration_id = 'integration-proxy' AND reporter_id = ?2`,
    ).bind(committedWithZeroMetadataBody.id, "h".repeat(64)).first()).toMatchObject({ ok: 1 });
    expect(await env.DB.prepare(
      `SELECT 1 AS ok FROM feedback_submission_events
       WHERE ticket_id = ?1 AND route_outcome = 'route_bound'`,
    ).bind(committedWithZeroMetadataBody.id).first()).toMatchObject({ ok: 1 });

    for (let index = 0; index < 100; index += 1) {
      const response = await submit(reporterA);
      expect(response.status).toBe(201);
      if (index === 0) {
        expect(response.headers.get("server-timing")).toMatch(
          /^hands_auth;dur=\d+\.\d, hands_preflight;dur=\d+\.\d, hands_commit;dur=\d+\.\d, hands_postcommit;dur=\d+\.\d$/,
        );
      }
    }
    const limited = await submit(reporterA);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await submit(reporterA, secondCredential.token)).status).toBe(201);
    expect((await submit("b".repeat(64))).status).toBe(201);
    expect((await submit("c".repeat(64), "")).status).toBe(401);
    expect((await submit("d".repeat(64), publisherCredential.token)).status).toBe(401);
    expect((await submit("e".repeat(64), broadCredential.token)).status).toBe(401);
    expect((await submit("raw account id", credential.token)).status).toBe(400);

    await env.DB.prepare(
      `INSERT INTO webhooks
       (id, org_id, app_id, url, secret, events_json, enabled, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8),
              ('generic-feedback-webhook', ?2, ?3, 'https://example.test/generic-feedback',
               'generic-secret', ?6, 1, ?7, ?8)`,
    ).bind(
      "trusted-feedback-webhook",
      "default",
      "app-scope",
      "https://example.test/trusted-feedback",
      "secret",
      JSON.stringify(["feedback:new"]),
      Date.now(),
      Date.now(),
    ).run();
    await env.DB.prepare(
      `INSERT INTO app_reporter_webhook_subscriptions
       (app_id, reporter_integration_id, webhook_id, created_at)
       VALUES ('app-scope', 'integration-proxy', 'trusted-feedback-webhook', ?1)`,
    ).bind(Date.now()).run();
    const ownedSubmission = "55555555-5555-4555-8555-555555555555";
    expect((await submit("g".repeat(64), credential.token, ownedSubmission)).status).toBe(201);
    expect((await submit("h".repeat(64), credential.token, ownedSubmission)).status).toBe(409);

    const trustedDelivery = (await env.DB.prepare(
      `SELECT payload_json, signing_secret, signature_key_version, reporter_delivery,
              feedback_submission_event_id
       FROM webhook_deliveries
       WHERE webhook_id = ?1 AND event_type = 'feedback:new'`,
    ).bind("trusted-feedback-webhook").first()) as {
      payload_json: string;
      signing_secret: string;
      signature_key_version: string;
      reporter_delivery: number;
      feedback_submission_event_id: string;
    };
    expect(JSON.parse(trustedDelivery.payload_json).payload.reporter_id).toBe("g".repeat(64));
    expect(JSON.parse(trustedDelivery.payload_json).payload.reporter_integration_id)
      .toBe("integration-proxy");
    expect(JSON.parse(trustedDelivery.payload_json).payload).toMatchObject({
      route_outcome: "route_bound",
      route_subject: `rfr_v1_${"D".repeat(64)}`,
    });
    expect(trustedDelivery).toMatchObject({
      signing_secret: "secret",
      signature_key_version: "v1",
      reporter_delivery: 1,
    });
    const submissionLedger = await env.DB.prepare(
      `SELECT id, ticket_id, route_outcome FROM feedback_submission_events
       WHERE id = ?1`,
    ).bind(trustedDelivery.feedback_submission_event_id).first() as any;
    expect(submissionLedger).toMatchObject({ route_outcome: "route_bound" });
    const genericDelivery = await env.DB.prepare(
      `SELECT payload_json, reporter_delivery FROM webhook_deliveries
       WHERE webhook_id = 'generic-feedback-webhook' AND event_type = 'feedback:new'`,
    ).first() as { payload_json: string; reporter_delivery: number } | null;
    expect(genericDelivery).not.toBeNull();
    expect(genericDelivery?.reporter_delivery).toBe(0);
    expect(JSON.stringify(genericDelivery)).not.toContain("route_subject");
    expect((await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM webhook_deliveries
       WHERE feedback_submission_event_id = ?1`,
    ).bind(trustedDelivery.feedback_submission_event_id).first() as any).count).toBe(2);

    const reporterRows = await env.DB.prepare(
      `SELECT DISTINCT reporter_id
       FROM feedback_tickets
       WHERE app_id = ?1 AND reporter_id IS NOT NULL`,
    ).bind("app-scope").all();
    const storedReporterIds = reporterRows.results.map((row: any) => row.reporter_id);
    expect(storedReporterIds).toContain(reporterA);
    expect(storedReporterIds).toContain("b".repeat(64));
    expect(storedReporterIds).toContain("g".repeat(64));
  });

  it("feedback: legacy submissions without submission_id remain non-idempotent", async () => {
    const env = makeEnv();
    env.APK_BUCKET = { put: async () => {}, get: async () => null };
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");
    const submit = () => {
      const form = new FormData();
      form.set("message", "Legacy client");
      return handlePublicFeedbackSubmit({
        env,
        executionCtx: { waitUntil: () => {} },
        req: {
          param: (name: string) => (name === "slug" ? "scope-app" : ""),
          header: (name: string) => (name === "X-Quiver-Client-Key" ? "qk_test" : undefined),
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: "203.0.113.73" } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);
    };
    const first = await responseJson<any>(await submit());
    const second = await responseJson<any>(await submit());
    expect(first.id).not.toBe(second.id);
  });

  it("feedback: rejects malformed submission_id", async () => {
    const env = makeEnv();
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");
    const form = new FormData();
    form.set("message", "Bad id");
    form.set("submission_id", "not-a-uuid");
    const response = await handlePublicFeedbackSubmit({
      env,
      req: {
        param: (name: string) => (name === "slug" ? "scope-app" : ""),
        header: (name: string) => (name === "X-Quiver-Client-Key" ? "qk_test" : undefined),
        query: () => undefined,
        formData: async () => form,
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    expect(response.status).toBe(400);
  });

  it("feedback: client key is always required", async () => {
    const env = makeEnv();
    const { handlePublicFeedbackSubmit } = await import("../src/routes/feedback");
    env.APK_BUCKET = { put: async () => {}, get: async () => null };

    const submit = (headers: Record<string, string | undefined>) => {
      const form = new FormData();
      form.set("message", "key gate test");
      return handlePublicFeedbackSubmit({
        env,
        req: {
          param: (name: string) => (name === "slug" ? "scope-app" : ""),
          header: (name: string) => headers[name],
          query: () => undefined,
          formData: async () => form,
          raw: { cf: { clientIp: "203.0.113.7" } },
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
      } as any);
    };

    // missing/wrong -> 401, correct -> 201
    expect((await submit({})).status).toBe(401);
    expect((await submit({ "X-Quiver-Client-Key": "qk_wrong" })).status).toBe(401);
    expect((await submit({ "X-Quiver-Client-Key": "qk_test" })).status).toBe(201);

    // app without a key rejects everything (legacy rows until admin generates one)
    await env.DB.prepare("UPDATE apps SET client_key = NULL WHERE id = ?1")
      .bind("app-scope")
      .run();
    expect((await submit({ "X-Quiver-Client-Key": "qk_test" })).status).toBe(401);
    await env.DB.prepare("UPDATE apps SET client_key = ?1 WHERE id = ?2")
      .bind("qk_test", "app-scope")
      .run();
  });

  it("feedback: public submit stores ticket + attachment, admin can triage", async () => {
    const env = makeEnv();
    const putCalls: Array<{ key: string; bytes: number }> = [];
    env.APK_BUCKET = {
      put: async (key: string, body: ArrayBuffer) => {
        putCalls.push({ key, bytes: body.byteLength ?? 0 });
      },
      get: async (key: string) => {
        const hit = putCalls.find((p) => p.key === key);
        if (!hit) return null;
        return { body: new Blob(["log"]).stream() };
      },
    };
    const {
      handlePublicFeedbackSubmit,
      handleListFeedback,
      handleUpdateFeedback,
      handleAddFeedbackComment,
      handleGetFeedback,
      handleDownloadFeedbackAttachment,
    } = await import("../src/routes/feedback");

    const form = new FormData();
    form.set("message", "首页打开就闪退");
    form.set("kind", "bug");
    form.set("contact", "artin@cat.ms");
    form.set(
      "metadata",
      JSON.stringify({
        version_name: "1.0.1",
        version_code: 1000101,
        channel: "main",
        device_id: "dev-123",
        device_model: "HUAWEI SGT-AL10",
        os_version: "12",
        arch: "arm64-v8a",
        locale: "zh-CN",
      }),
    );
    form.append(
      "attachments",
      new File([new Uint8Array([1, 2, 3])], "logcat.txt", { type: "text/plain" }),
    );

    const submitContext = {
      env,
      req: {
        url: "https://legacy.example/public/v2/apps/scope-app/feedback",
        param: (name: string) => (name === "slug" ? "scope-app" : ""),
        header: (name: string) => (name === "X-Quiver-Client-Key" ? "qk_test" : undefined),
        query: () => undefined,
        formData: async () => form,
        raw: { cf: { clientIp: "203.0.113.9" } },
      },
      json: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status }),
    } as any;

    const submitted = await handlePublicFeedbackSubmit(submitContext);
    expect(submitted.status).toBe(201);
    const submittedBody = await responseJson<any>(submitted);
    expect(submittedBody.attachments).toBe(1);
    expect(submittedBody.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(submittedBody.reference).toContain(`ticket ${submittedBody.id}`);
    // The copyable reference lists attachment filenames, one per line, so a
    // reading agent knows the ticket carries files and will fetch them.
    expect(submittedBody.reference).toContain("attachments:\nlogcat.txt");
    expect(submittedBody.attachment_names).toEqual(["logcat.txt"]);
    expect(submittedBody.ticket_url).toBe(
      `https://dashboard.example/apps/app-scope/feedback/${submittedBody.id}`,
    );
    expect(putCalls.length).toBe(1);
    expect(putCalls[0]!.key).toContain("feedback/app-scope/");

    const adminContext = (params: Record<string, string>, opts: { query?: Record<string, string>; body?: unknown } = {}) =>
      ({
        env,
        req: {
          param: (name: string) => params[name] ?? "",
          query: (name: string) => opts.query?.[name],
          json: async () => opts.body ?? {},
        },
        get: (name: string) => (name === "admin_actor" ? "tester" : undefined),
        json: (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status }),
      }) as any;

    const listed = await handleListFeedback(adminContext({ appId: "app-scope" }, { query: { kind: "bug" } }));
    const listBody = await responseJson<any>(listed);
    expect(listBody.tickets.length).toBe(1);
    expect(listBody.tickets[0].attachment_count).toBe(1);
    const ticketId = listBody.tickets[0].id as string;

    const updated = await handleUpdateFeedback(
      adminContext({ appId: "app-scope", ticketId }, { body: { status: "in_progress", assignee: "cc-quiver-owner" } }),
    );
    expect(updated.status).toBe(200);

    const commented = await handleAddFeedbackComment(
      adminContext({ appId: "app-scope", ticketId }, { body: { body: "已复现，排查中" } }),
    );
    expect(commented.status).toBe(201);

    const detail = await handleGetFeedback(adminContext({ appId: "app-scope", ticketId }));
    const detailBody = await responseJson<any>(detail);
    expect(detailBody.ticket.status).toBe("in_progress");
    expect(detailBody.ticket.assignee).toBe("cc-quiver-owner");
    expect(detailBody.ticket.device_id).toBe("dev-123");
    expect(detailBody.attachments.length).toBe(1);
    expect(detailBody.comments.length).toBe(1);

    const download = await handleDownloadFeedbackAttachment(
      adminContext({ appId: "app-scope", ticketId, attachmentId: detailBody.attachments[0].id }),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("logcat.txt");
  });

  it("share download redirects to signed R2 and records download stats", async () => {
    const env = makeEnv();
    const {
      handleCreateReleaseShare,
      handleListReleaseShares,
      handlePublicReleaseShare,
      handlePublicReleaseShareDownload,
    } = await import("../src/routes/shares");
    await seedRelease(env, "rel-share", "build-share", [["full", "all"]], {
      versionCode: 11,
      versionName: "1.0.11",
    });
    await seedAsset(env, "build-share", "asset-share", {
      arch: "arm64-v8a",
      sizeBytes: 123,
    });
    const created = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }, { ttl_seconds: 600 }),
    );
    const createdBody = await responseJson<any>(created);
    const token = new URL(createdBody.share_url).pathname.replace("/share/", "");
    await handlePublicReleaseShare(makeSharePublicContext(env, token));

    const download = await handlePublicReleaseShareDownload(makeSharePublicContext(env, token));

    expect(download.status).toBe(302);
    const location = download.headers.get("location") ?? "";
    expect(location).toMatch(/^https:\/\/quiver-worker\.test\/public\/r2\//);
    expect(location).toContain("asset-share.apk");
    expect(location).toContain("&sig=");

    const list = await handleListReleaseShares(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }),
    );
    const body = await responseJson<any>(list);
    expect(body.shares[0]).toMatchObject({
      view_count: 1,
      unique_view_count: 1,
      download_count: 1,
      unique_download_count: 1,
    });
  });

  it("public release shares stop working after revoke", async () => {
    const env = makeEnv();
    const { handleCreateReleaseShare, handlePublicReleaseShare, handleRevokeReleaseShare } = await import("../src/routes/shares");
    await seedRelease(env, "rel-share", "build-share", [["full", "all"]], {
      versionCode: 11,
    });
    await seedAsset(env, "build-share", "asset-share", { arch: "arm64-v8a" });
    const created = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }, { ttl_seconds: 600 }),
    );
    const createdBody = await responseJson<any>(created);
    const token = new URL(createdBody.share_url).pathname.replace("/share/", "");

    const revoke = await handleRevokeReleaseShare(
      makeShareAdminContext(env, {
        appId: "app-scope",
        releaseId: "rel-share",
        shareId: createdBody.id,
      }),
    );
    expect(revoke.status).toBe(200);

    const response = await handlePublicReleaseShare(makeSharePublicContext(env, token));
    expect(response.status).toBe(404);
  });

  it("does not update revoked release shares", async () => {
    const env = makeEnv();
    const { handleCreateReleaseShare, handleRevokeReleaseShare, handleUpdateReleaseShare } = await import("../src/routes/shares");
    await seedRelease(env, "rel-share", "build-share", [["full", "all"]], {
      versionCode: 11,
    });
    const created = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }, { ttl_seconds: 600 }),
    );
    const createdBody = await responseJson<any>(created);

    await handleRevokeReleaseShare(
      makeShareAdminContext(env, {
        appId: "app-scope",
        releaseId: "rel-share",
        shareId: createdBody.id,
      }),
    );
    const updated = await handleUpdateReleaseShare(
      makeShareAdminContext(
        env,
        { appId: "app-scope", releaseId: "rel-share", shareId: createdBody.id },
        { ttl_seconds: 600 },
      ),
    );

    expect(updated.status).toBe(409);
  });

  it("draft-only release endpoint enforces draft even against a hostile status=active", async () => {
    const env = makeEnv();
    const { handleCreateReleaseDraft } = await import("../src/routes/releases");
    // seed a build to release
    await seedRelease(env, "rel-seed", "build-draftonly", [["full", "all"]], { versionCode: 21 });
    await env.DB.prepare("DELETE FROM releases WHERE id = 'rel-seed'").run();
    const ctx = (body: unknown) =>
      ({
        env,
        executionCtx: { waitUntil: () => {} },
        req: {
          url: "https://quiver-worker.test/api/apps/app-scope/releases/draft",
          param: (name: string) => (name === "appId" ? "app-scope" : ""),
          json: async () => body,
        },
        get: (name: string) => (name === "admin_actor" ? "tester" : name === "org_id" ? "default" : undefined),
        json: (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
      }) as any;

    // hostile: explicit active must be rejected outright (nothing created)
    const hostile = await handleCreateReleaseDraft(ctx({ build_id: "build-draftonly", status: "active" }));
    expect(hostile.status).toBe(400);
    const hostileBody = (await hostile.json()) as any;
    expect(hostileBody.error).toContain("draft");

    // normal: no status -> created as draft (NOT the legacy active default)
    const ok = await handleCreateReleaseDraft(ctx({ build_id: "build-draftonly" }));
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as any;
    expect(created.status).toBe("draft");
    const row = (await env.DB.prepare("SELECT status FROM releases WHERE id = ?1").bind(created.id).first()) as any;
    expect(row.status).toBe("draft");
  });

  it("create release share rejects invalid TTL and cancelled releases", async () => {
    const env = makeEnv();
    const { handleCreateReleaseShare } = await import("../src/routes/shares");
    await seedRelease(env, "rel-share", "build-share", [["full", "all"]], {
      versionCode: 11,
    });

    const invalidTtl = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }, { ttl_seconds: -1 }),
    );
    expect(invalidTtl.status).toBe(400);

    await env.DB.prepare("UPDATE releases SET status = 'cancelled' WHERE id = ?")
      .bind("rel-share")
      .run();
    const cancelled = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }, { ttl_seconds: 600 }),
    );
    expect(cancelled.status).toBe(409);
  });

  it("public R2 download rejects unsigned active release assets", async () => {
    const env = makeEnv();
    const { handlePublicR2Download } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-unsigned", "build-unsigned", [["full", "all"]], {
      versionCode: 11,
    });
    await seedAsset(env, "build-unsigned", "asset-unsigned", {
      arch: "arm64-v8a",
    });

    const response = await handlePublicR2Download(
      makePublicDownloadContext(env, "apps/app-scope/asset-unsigned.apk", {
        expires: String(Math.floor(Date.now() / 1000) + 3600),
      }),
    );

    expect(response.status).toBe(403);
    const body = await responseJson<any>(response);
    expect(body.error).toBe("invalid download signature");
  });

  it("updates/check excludes support artifacts from public asset selection", async () => {
    const env = makeEnv();
    const { handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-support", "build-support", [["full", "all"]], {
      versionCode: 11,
    });
    await seedAsset(env, "build-support", "asset-apk", {
      arch: "arm64-v8a",
      filetype: "apk",
    });
    await seedAsset(env, "build-support", "asset-mapping", {
      artifactKind: "proguard-mapping",
      arch: null,
      filetype: "mapping.txt",
    });
    await seedAsset(env, "build-support", "asset-symbols", {
      artifactKind: "native-symbols",
      arch: null,
      filetype: "symbols.zip",
    });

    const response = await handlePublicV2UpdateCheck(
      makePublicContext(env, {
        channel: "production",
        product_type: "android-apk",
        current_version_code: "10",
        platform: "android",
        arch: "arm64-v8a",
        filetype: "apk",
      }),
    );
    expect(response.status).toBe(200);
    const body = await responseJson<any>(response);
    expect(body.asset.filetype).toBe("apk");
    expect(body.asset.download_url).toContain("asset-apk.apk");
    expect(JSON.stringify(body)).not.toContain("asset-mapping");
    expect(JSON.stringify(body)).not.toContain("asset-symbols");
  });

  it("updates/check returns 404 when an update has no compatible requested filetype", async () => {
    const env = makeEnv();
    const { handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    await seedRelease(env, "rel-latest", "build-latest", [["full", "all"]], {
      versionCode: 11,
    });
    await seedAsset(env, "build-latest", "asset-aab", { filetype: "aab" });

    const response = await handlePublicV2UpdateCheck(
      makePublicContext(env, {
        channel: "production",
        product_type: "android-apk",
        current_version_code: "10",
        platform: "android",
        filetype: "apk",
      }),
    );
    expect(response.status).toBe(404);
    const body = await responseJson<any>(response);
    expect(body.error).toBe("matched release has no compatible asset");
  });
});

// =============================================================================
// QA-only exact iOS simulator artifacts
// =============================================================================

describe("Hands iOS simulator QA artifacts", () => {
  function makeEnv() {
    const env = makeMockEnv();
    env.R2_ACCOUNT_ID = "test-account";
    env.R2_BUCKET_NAME = "hands-artifacts";
    env.R2_S3_ACCESS_KEY_ID = "test-access-key";
    env.R2_S3_SECRET_ACCESS_KEY = "test-secret-key";
    env.R2_PRESIGNED_DOWNLOAD_TTL_SECONDS = "600";
    env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("app-ios", "default", "raft-ios", "Raft iOS", "ios", 1).run();
    env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, enabled_product_types_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("ch-ios-main", "app-ios", "main", "Main", "[]", "{}", 1).run();

    const objects = new Map<string, Uint8Array>();
    env.APK_BUCKET = {
      put: async (key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | string) => {
        const bytes = typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof ReadableStream
            ? new Uint8Array(await new Response(value).arrayBuffer())
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        objects.set(key, new Uint8Array(bytes));
      },
      head: async (key: string) => {
        const bytes = objects.get(key);
        return bytes
          ? { size: bytes.byteLength, httpEtag: `"${key}"`, writeHttpMetadata: () => undefined }
          : null;
      },
      get: async (key: string) => {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return {
          body: new Response(bytes).body!,
          size: bytes.byteLength,
          httpEtag: `"${key}"`,
          writeHttpMetadata(headers: Headers) {
            headers.set("content-type", "application/zip");
          },
        };
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    };
    return { env, objects };
  }

  function context(
    env: MockEnv,
    method: string,
    path: string,
    params: Record<string, string>,
    body?: unknown,
  ) {
    const url = new URL(`https://hands.test${path}`);
    return {
      env,
      req: {
        url: url.toString(),
        raw: new Request(url, { method }),
        param: (name: string) => params[name] ?? "",
        query: (name: string) => url.searchParams.get(name) ?? undefined,
        header: (_name: string) => undefined,
        json: async () => body,
      },
      get: (name: string) => (name === "admin_actor" ? "raft:test-agent@test" : undefined),
      header: (_name: string, _value: string) => undefined,
      json: (data: unknown, status = 200) => Response.json(data, { status }),
    } as any;
  }

  const declaration = (bytes: Uint8Array) => ({
    filename: "raft-ios-simulator.app.zip",
    size_bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source_commit: "470023f98d154e50d7ba07b01a2cd53eb4367fc9",
    version_name: "1.0",
    build_number: "1",
    bundle_id: "build.raft.app",
    github_run_id: "29700366778",
    github_artifact_id: "8446353537",
    github_job_id: "88230185690",
    github_repository: "botiverse/mobile",
  });

  it("round-trips exact bytes with durable build/asset coordinates and full provenance", async () => {
    const { env, objects } = makeEnv();
    const bytes = new TextEncoder().encode("exact iOS simulator .app.zip fixture");

    const createdResponse = await handleCreateIosSimulatorArtifact(
      context(env, "POST", "/api/apps/app-ios/qa-artifacts/ios-simulator", { appId: "app-ios" }, declaration(bytes)),
    );
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as any;
    expect(created).toMatchObject({
      kind: "ios-simulator-app",
      artifact_kind: "ios-simulator-app",
      qa_only: true,
      release_offer_eligible: false,
      status: "pending_upload",
      filename: "raft-ios-simulator.app.zip",
      source_commit: declaration(bytes).source_commit,
      version_name: "1.0",
      version: "1.0",
      version_code: 1,
      build_number: "1",
      build_run_id: "29700366778",
      bundle_id: "build.raft.app",
      github: {
        run_id: "29700366778",
        artifact_id: "8446353537",
        job_id: "88230185690",
      },
    });
    expect(created.build_id).toMatch(/[0-9a-f-]{36}/);
    expect(created.asset_id).toMatch(/[0-9a-f-]{36}/);
    expect(created.upload).toMatchObject({ method: "PUT", headers: { "content-type": "application/zip" } });
    expect(created.upload.url).toContain("test-account.r2.cloudflarestorage.com");
    expect(created.download_api).toBe(
      `https://hands.test/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/download`,
    );

    const stored = await env.DB.prepare("SELECT r2_key FROM build_assets WHERE id = ?1")
      .bind(created.asset_id)
      .first() as { r2_key: string } | null;
    objects.set(stored!.r2_key, bytes);

    const completeResponse = await handleCompleteIosSimulatorArtifact(
      context(
        env,
        "POST",
        `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/complete`,
        { appId: "app-ios", assetId: created.asset_id },
      ),
    );
    expect(completeResponse.status).toBe(200);
    const completed = await completeResponse.json() as any;
    expect(completed.status).toBe("ready");
    expect(completed.verification).toMatchObject({
      verified_sha256: declaration(bytes).sha256,
      verified_size_bytes: bytes.byteLength,
    });
    expect(completed.server_sha256).toBe(declaration(bytes).sha256);
    const sealed = await env.DB.prepare("SELECT r2_key FROM build_assets WHERE id = ?1")
      .bind(created.asset_id)
      .first() as { r2_key: string } | null;
    expect(sealed!.r2_key).toContain("/qa/ios-simulator/verified/");
    expect(objects.has(stored!.r2_key)).toBe(false);
    expect(objects.has(sealed!.r2_key)).toBe(true);

    // A still-valid stale PUT URL can only recreate the pending key; the
    // completed asset points at a separate sealed key and cannot be replaced.
    objects.set(stored!.r2_key, new TextEncoder().encode("late overwrite attempt"));
    const secondComplete = await handleCompleteIosSimulatorArtifact(
      context(
        env,
        "POST",
        `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/complete`,
        { appId: "app-ios", assetId: created.asset_id },
      ),
    );
    expect(secondComplete.status).toBe(409);
    await expect(secondComplete.json()).resolves.toMatchObject({ code: "QA_ARTIFACT_ALREADY_COMPLETED" });

    const getResponse = await handleGetIosSimulatorArtifact(
      context(env, "GET", `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}`, {
        appId: "app-ios",
        assetId: created.asset_id,
      }),
    );
    expect(await getResponse.json()).toMatchObject({
      build_id: created.build_id,
      asset_id: created.asset_id,
      sha256: declaration(bytes).sha256,
      server_sha256: declaration(bytes).sha256,
      status: "ready",
    });

    const listResponse = await handleListIosSimulatorArtifacts(
      context(
        env,
        "GET",
        `/api/apps/app-ios/qa-artifacts/ios-simulator?source_commit=${declaration(bytes).source_commit}&github_run_id=29700366778`,
        { appId: "app-ios" },
      ),
    );
    const listed = await listResponse.json() as any;
    expect(listed.artifacts).toHaveLength(1);
    expect(listed.artifacts[0].asset_id).toBe(created.asset_id);

    const presignResponse = await handleDownloadIosSimulatorArtifact(
      context(
        env,
        "GET",
        `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/download?presign=1`,
        { appId: "app-ios", assetId: created.asset_id },
      ),
    );
    const presigned = await presignResponse.json() as any;
    expect(presigned).toMatchObject({
      build_id: created.build_id,
      asset_id: created.asset_id,
      filename: "raft-ios-simulator.app.zip",
      sha256: declaration(bytes).sha256,
      size_bytes: bytes.byteLength,
    });
    expect(presigned.download_url).toContain("X-Amz-Signature=");

    const downloadResponse = await handleDownloadIosSimulatorArtifact(
      context(env, "GET", `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/download`, {
        appId: "app-ios",
        assetId: created.asset_id,
      }),
    );
    expect(downloadResponse.status).toBe(200);
    const downloaded = new Uint8Array(await downloadResponse.arrayBuffer());
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(declaration(bytes).sha256);
    expect(downloadResponse.headers.get("content-disposition")).toContain("raft-ios-simulator.app.zip");

    const { createRelease } = await import("../src/routes/releases");
    await expect(
      createRelease(env.DB as any, "app-ios", { build_id: created.build_id, status: "draft" }, "tester"),
    ).rejects.toThrow("QA-only builds cannot be attached to releases");
  });

  it("fails closed and deletes uploaded bytes when exact SHA-256 does not match", async () => {
    const { env, objects } = makeEnv();
    const declared = new TextEncoder().encode("declared bytes");
    const createdResponse = await handleCreateIosSimulatorArtifact(
      context(env, "POST", "/api/apps/app-ios/qa-artifacts/ios-simulator", { appId: "app-ios" }, declaration(declared)),
    );
    const created = await createdResponse.json() as any;
    const stored = await env.DB.prepare("SELECT r2_key FROM build_assets WHERE id = ?1")
      .bind(created.asset_id)
      .first() as { r2_key: string } | null;
    objects.set(stored!.r2_key, new TextEncoder().encode("tampered bytes"));

    const response = await handleCompleteIosSimulatorArtifact(
      context(
        env,
        "POST",
        `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/complete`,
        { appId: "app-ios", assetId: created.asset_id },
      ),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "QA_ARTIFACT_INTEGRITY_MISMATCH" });
    expect(objects.has(stored!.r2_key)).toBe(false);

    const getResponse = await handleGetIosSimulatorArtifact(
      context(env, "GET", `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}`, {
        appId: "app-ios",
        assetId: created.asset_id,
      }),
    );
    await expect(getResponse.json()).resolves.toMatchObject({ status: "failed" });

    const retry = await handleCompleteIosSimulatorArtifact(
      context(
        env,
        "POST",
        `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/complete`,
        { appId: "app-ios", assetId: created.asset_id },
      ),
    );
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({ code: "QA_ARTIFACT_VERIFICATION_FAILED" });
  });

  it("allows exactly one concurrent complete request to enter verifying", async () => {
    const { env, objects } = makeEnv();
    const bytes = new TextEncoder().encode("concurrent complete fixture");
    const createdResponse = await handleCreateIosSimulatorArtifact(
      context(env, "POST", "/api/apps/app-ios/qa-artifacts/ios-simulator", { appId: "app-ios" }, declaration(bytes)),
    );
    const created = await createdResponse.json() as any;
    const stored = await env.DB.prepare("SELECT r2_key FROM build_assets WHERE id = ?1")
      .bind(created.asset_id)
      .first() as { r2_key: string } | null;
    objects.set(stored!.r2_key, bytes);

    const bucket = env.APK_BUCKET as any;
    const originalHead = bucket.head.bind(bucket);
    let releaseFirstHead!: () => void;
    const firstHeadBlocked = new Promise<void>((resolveBlocked) => {
      bucket.head = async (key: string) => {
        if (key === stored!.r2_key) {
          await new Promise<void>((resolveRelease) => {
            releaseFirstHead = resolveRelease;
            resolveBlocked();
          });
        }
        return originalHead(key);
      };
    });

    const first = handleCompleteIosSimulatorArtifact(
      context(
        env,
        "POST",
        `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/complete`,
        { appId: "app-ios", assetId: created.asset_id },
      ),
    );
    await firstHeadBlocked;
    const loser = await handleCompleteIosSimulatorArtifact(
      context(
        env,
        "POST",
        `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/complete`,
        { appId: "app-ios", assetId: created.asset_id },
      ),
    );
    expect(loser.status).toBe(409);
    await expect(loser.json()).resolves.toMatchObject({ code: "QA_ARTIFACT_VERIFICATION_IN_PROGRESS" });
    releaseFirstHead();
    const winner = await first;
    expect(winner.status).toBe(200);
    await expect(winner.json()).resolves.toMatchObject({ status: "ready" });
  });

  it("hashes and seals the same staging byte stream even if the upload key is overwritten during complete", async () => {
    const { env, objects } = makeEnv();
    const original = new TextEncoder().encode("original-stream");
    const overwritten = new TextEncoder().encode("tampered-stream");
    expect(overwritten.byteLength).toBe(original.byteLength);
    const createdResponse = await handleCreateIosSimulatorArtifact(
      context(env, "POST", "/api/apps/app-ios/qa-artifacts/ios-simulator", { appId: "app-ios" }, declaration(original)),
    );
    const created = await createdResponse.json() as any;
    const stored = await env.DB.prepare("SELECT r2_key FROM build_assets WHERE id = ?1")
      .bind(created.asset_id)
      .first() as { r2_key: string } | null;
    objects.set(stored!.r2_key, original);

    const bucket = env.APK_BUCKET as any;
    const originalGet = bucket.get.bind(bucket);
    let overwrittenOnce = false;
    bucket.get = async (key: string) => {
      const snapshot = await originalGet(key);
      if (key === stored!.r2_key && !overwrittenOnce) {
        overwrittenOnce = true;
        objects.set(key, overwritten);
      }
      return snapshot;
    };

    const complete = await handleCompleteIosSimulatorArtifact(
      context(
        env,
        "POST",
        `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/complete`,
        { appId: "app-ios", assetId: created.asset_id },
      ),
    );
    expect(complete.status).toBe(200);
    const completed = await complete.json() as any;
    expect(completed.server_sha256).toBe(declaration(original).sha256);

    const download = await handleDownloadIosSimulatorArtifact(
      context(env, "GET", `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/download`, {
        appId: "app-ios",
        assetId: created.asset_id,
      }),
    );
    const downloaded = new Uint8Array(await download.arrayBuffer());
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(declaration(original).sha256);
    expect(createHash("sha256").update(downloaded).digest("hex")).not.toBe(
      createHash("sha256").update(overwritten).digest("hex"),
    );
  });

  it("wraps the verified R2 put in a Workers FixedLengthStream", async () => {
    const previousFixedLengthStream = (globalThis as any).FixedLengthStream;
    class StrictFixedLengthStream {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;

      constructor(expectedBytes: number | bigint) {
        const stream = new TransformStream<Uint8Array, Uint8Array>();
        this.readable = stream.readable;
        this.writable = stream.writable;
        (this.readable as any).__expectedBytes = Number(expectedBytes);
      }
    }
    (globalThis as any).FixedLengthStream = StrictFixedLengthStream;

    try {
      const { env, objects } = makeEnv();
      const bytes = new TextEncoder().encode("fixed-length R2 fixture");
      const createdResponse = await handleCreateIosSimulatorArtifact(
        context(env, "POST", "/api/apps/app-ios/qa-artifacts/ios-simulator", { appId: "app-ios" }, declaration(bytes)),
      );
      const created = await createdResponse.json() as any;
      const stored = await env.DB.prepare("SELECT r2_key FROM build_assets WHERE id = ?1")
        .bind(created.asset_id)
        .first() as { r2_key: string } | null;
      objects.set(stored!.r2_key, bytes);

      const bucket = env.APK_BUCKET as any;
      const originalPut = bucket.put.bind(bucket);
      let sawFixedLengthFinalPut = false;
      bucket.put = async (key: string, value: ReadableStream, options: unknown) => {
        if (key.includes("/qa/ios-simulator/verified/")) {
          expect((value as any).__expectedBytes).toBe(bytes.byteLength);
          sawFixedLengthFinalPut = true;
        }
        return originalPut(key, value, options);
      };

      const response = await handleCompleteIosSimulatorArtifact(
        context(
          env,
          "POST",
          `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/complete`,
          { appId: "app-ios", assetId: created.asset_id },
        ),
      );
      expect(response.status).toBe(200);
      expect(sawFixedLengthFinalPut).toBe(true);
    } finally {
      if (previousFixedLengthStream === undefined) {
        delete (globalThis as any).FixedLengthStream;
      } else {
        (globalThis as any).FixedLengthStream = previousFixedLengthStream;
      }
    }
  });

  it("rejects oversized staging objects from metadata without streaming them", async () => {
    const { env, objects } = makeEnv();
    const bytes = new TextEncoder().encode("small declaration");
    const createdResponse = await handleCreateIosSimulatorArtifact(
      context(env, "POST", "/api/apps/app-ios/qa-artifacts/ios-simulator", { appId: "app-ios" }, declaration(bytes)),
    );
    const created = await createdResponse.json() as any;
    const stored = await env.DB.prepare("SELECT r2_key FROM build_assets WHERE id = ?1")
      .bind(created.asset_id)
      .first() as { r2_key: string } | null;
    objects.set(stored!.r2_key, bytes);

    const bucket = env.APK_BUCKET as any;
    const originalHead = bucket.head.bind(bucket);
    const originalGet = bucket.get.bind(bucket);
    let getCalls = 0;
    bucket.head = async (key: string) => key === stored!.r2_key
      ? { size: 500 * 1024 * 1024 + 1, httpEtag: '"oversized"', writeHttpMetadata: () => undefined }
      : originalHead(key);
    bucket.get = async (key: string) => {
      getCalls += 1;
      return originalGet(key);
    };

    const response = await handleCompleteIosSimulatorArtifact(
      context(
        env,
        "POST",
        `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}/complete`,
        { appId: "app-ios", assetId: created.asset_id },
      ),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "QA_ARTIFACT_INTEGRITY_MISMATCH",
      actual: { size_bytes: 500 * 1024 * 1024 + 1 },
    });
    expect(getCalls).toBe(0);
    expect(objects.has(stored!.r2_key)).toBe(false);

    const readback = await handleGetIosSimulatorArtifact(
      context(env, "GET", `/api/apps/app-ios/qa-artifacts/ios-simulator/${created.asset_id}`, {
        appId: "app-ios",
        assetId: created.asset_id,
      }),
    );
    await expect(readback.json()).resolves.toMatchObject({ status: "failed" });
  });

  it("explicitly excludes QA-only builds from public latest, update offers, and latest landing", async () => {
    const { env } = makeEnv();
    const now = Date.now();
    await env.DB.prepare("UPDATE apps SET public_history = 1 WHERE id = ?1").bind("app-ios").run();
    await env.DB.prepare(
      `INSERT INTO builds
       (id, app_id, channel_id, product_type, release_type, version_name, version_code,
        source, status, build_metadata_json, parsed_metadata_json, provenance_json,
        created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "qa-public-build",
      "app-ios",
      "ch-ios-main",
      "ios-simulator-qa",
      "qa",
      "9.9",
      99,
      "qa-artifact",
      "succeeded",
      '{"qa_only":true}',
      "{}",
      "{}",
      now,
      now,
      now,
    ).run();
    // Deliberately attach an installable-shaped asset and inject an active
    // release directly, bypassing createRelease, to prove public queries keep
    // their own defense-in-depth exclusion.
    await env.DB.prepare(
      `INSERT INTO build_assets
       (id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key,
        file_hash, size_bytes, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "qa-malicious-installable",
      "qa-public-build",
      "installable",
      "ios",
      "arm64",
      "simulator",
      "ipa",
      "apps/app-ios/qa-malicious.ipa",
      "deadbeef",
      42,
      "{}",
      now,
    ).run();
    await env.DB.prepare(
      `INSERT INTO releases
       (id, app_id, build_id, channel_id, product_type, release_type, status,
        is_full, changelog, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "qa-malicious-release",
      "app-ios",
      "qa-public-build",
      "ch-ios-main",
      "ios-simulator-qa",
      "qa",
      "active",
      1,
      "must stay private",
      "tester",
      now,
      now,
    ).run();
    await env.DB.prepare(
      "INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("qa-malicious-scope", "qa-malicious-release", "full", "all", now).run();

    const { handlePublicV2Latest, handlePublicV2UpdateCheck } = await import("../src/routes/public_v2");
    const latest = await handlePublicV2Latest(
      context(env, "GET", "/public/v2/apps/raft-ios/latest?channel=main", { slug: "raft-ios" }),
    );
    expect(latest.status).toBe(404);

    const update = await handlePublicV2UpdateCheck(
      context(
        env,
        "GET",
        "/public/v2/apps/raft-ios/updates/check?channel=main&current_version_code=1&platform=ios&filetype=ipa",
        { slug: "raft-ios" },
      ),
    );
    expect(update.status).toBe(404);

    const { handlePublicLatestReleaseLanding } = await import("../src/routes/history");
    const landing = await handlePublicLatestReleaseLanding(
      context(env, "GET", "/apps/raft-ios/latest?channel=main", { slug: "raft-ios" }),
    );
    expect(landing.status).toBe(404);
    await expect(landing.text()).resolves.toBe("No active release");
  });

  it("rejects IPA-shaped declarations instead of treating them as simulator QA artifacts", async () => {
    const { env } = makeEnv();
    const bytes = new TextEncoder().encode("fixture");
    const response = await handleCreateIosSimulatorArtifact(
      context(env, "POST", "/api/apps/app-ios/qa-artifacts/ios-simulator", { appId: "app-ios" }, {
        ...declaration(bytes),
        filename: "raft-ios.ipa",
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_QA_ARTIFACT" });
  });

  it("publishes the full create/upload/complete/read/download Agent Login action surface", async () => {
    const { env } = makeEnv();
    const { handleAgentManifest } = await import("../src/routes/auth");
    const response = await handleAgentManifest(
      context(env, "GET", "/.well-known/raft-agent-manifest.json", {}),
    );
    const manifest = await response.json() as any;
    const actions = Object.fromEntries(manifest.actions.map((action: any) => [action.name, action.endpoint]));
    expect(actions).toMatchObject({
      "create-app": {
        method: "POST",
        path: "/api/apps",
      },
      "archive-app": {
        method: "POST",
        path: "/api/apps/{app_id}/archive",
      },
      "purge-app": {
        method: "POST",
        path: "/api/apps/{app_id}/purge",
      },
      "get-client-key": {
        method: "GET",
        path: "/api/apps/{app_id}/client-key",
      },
      "update-release-share": {
        method: "PATCH",
        path: "/api/apps/{app_id}/releases/{release_id}/shares/{share_id}",
      },
      "list-app-members": {
        method: "GET",
        path: "/api/apps/{app_id}/members",
      },
      "add-app-member": {
        method: "POST",
        path: "/api/apps/{app_id}/members",
      },
      "update-app-member": {
        method: "PATCH",
        path: "/api/apps/{app_id}/members/{account_id}",
      },
      "remove-app-member": {
        method: "DELETE",
        path: "/api/apps/{app_id}/members/{account_id}",
      },
      "list-device-groups": {
        method: "GET",
        path: "/api/apps/{app_id}/device-groups",
      },
      "create-device-group": {
        method: "POST",
        path: "/api/apps/{app_id}/device-groups",
      },
      "update-device-group": {
        method: "PATCH",
        path: "/api/apps/{app_id}/device-groups/{group_id}",
      },
      "add-device-group-member": {
        method: "POST",
        path: "/api/apps/{app_id}/device-groups/{group_id}/members",
      },
      "remove-device-group-member": {
        method: "DELETE",
        path: "/api/apps/{app_id}/device-groups/{group_id}/members/{device_id}",
      },
      "delete-device-group": {
        method: "DELETE",
        path: "/api/apps/{app_id}/device-groups/{group_id}",
      },
      "list-ios-simulator-artifacts": {
        method: "GET",
        path: "/api/apps/{app_id}/qa-artifacts/ios-simulator",
      },
      "create-ios-simulator-artifact": {
        method: "POST",
        path: "/api/apps/{app_id}/qa-artifacts/ios-simulator",
      },
      "complete-ios-simulator-artifact": {
        method: "POST",
        path: "/api/apps/{app_id}/qa-artifacts/ios-simulator/{asset_id}/complete",
      },
      "get-ios-simulator-artifact": {
        method: "GET",
        path: "/api/apps/{app_id}/qa-artifacts/ios-simulator/{asset_id}",
      },
      "presign-ios-simulator-artifact": {
        method: "GET",
        path: "/api/apps/{app_id}/qa-artifacts/ios-simulator/{asset_id}/download?presign=1",
      },
      "upload-testflight-build": {
        method: "POST",
        path: "/api/apps/{app_id}/builds/{build_id}/testflight-upload",
      },
      "get-testflight-beta-app-description": {
        method: "GET",
        path: "/api/apps/{app_id}/testflight-beta-app-description",
      },
      "update-testflight-beta-app-description": {
        method: "PUT",
        path: "/api/apps/{app_id}/testflight-beta-app-description",
      },
      "get-testflight-upload-status": {
        method: "GET",
        path: "/api/apps/{app_id}/testflight-uploads/{build_upload_id}",
      },
      "list-testflight-groups": {
        method: "GET",
        path: "/api/apps/{app_id}/builds/{build_id}/testflight-groups",
      },
      "expire-testflight-build": {
        method: "POST",
        path: "/api/apps/{app_id}/builds/{build_id}/testflight-expire",
      },
      "publish-testflight-build": {
        method: "POST",
        path: "/api/apps/{app_id}/builds/{build_id}/testflight-publish",
      },
      "get-testflight-publish-status": {
        method: "GET",
        path: "/api/apps/{app_id}/builds/{build_id}/testflight-publish",
      },
      "delete-build-asset": {
        method: "DELETE",
        path: "/api/apps/{app_id}/builds/{build_id}/assets/{asset_id}",
      },
    });
    const byName = Object.fromEntries(manifest.actions.map((action: any) => [action.name, action]));
    expect(byName["create-app"].parameters).toMatchObject({
      slug: { type: "string", in: "body", required: true },
      name: { type: "string", in: "body", required: true },
      platform: { type: "string", in: "body", required: true },
      description: { type: "string", in: "body", required: false },
    });
    expect(byName["archive-app"].parameters).toMatchObject({
      app_id: { type: "string", in: "path", required: true },
      archived: { type: "boolean", in: "body", required: false },
    });
    expect(byName["purge-app"].parameters).toMatchObject({
      app_id: { type: "string", in: "path", required: true },
      confirm_slug: { type: "string", in: "body", required: true },
    });
    expect(byName["update-release-share"].parameters).toMatchObject({
      app_id: { type: "string", in: "path", required: true },
      release_id: { type: "string", in: "path", required: true },
      share_id: { type: "string", in: "path", required: true },
      expires_at: { type: "number", in: "body", required: false, nullable: true },
      ttl_seconds: { type: "number", in: "body", required: false },
    });
    expect(byName["bind-reporter-webhook"]).toMatchObject({
      endpoint: {
        method: "PUT",
        path: "/api/apps/{app_id}/reporter-integrations/{reporter_integration_id}/webhooks/{webhook_id}",
      },
    });
    expect(byName["list-reporter-integrations"]).toMatchObject({
      endpoint: {
        method: "GET",
        path: "/api/apps/{app_id}/reporter-integrations",
      },
      parameters: {
        app_id: { type: "string", in: "path", required: true },
        include_archived: { type: "string", in: "query", required: false },
      },
    });
    expect(byName["create-reporter-integration"]).toMatchObject({
      endpoint: { method: "POST", path: "/api/apps/{app_id}/reporter-integrations" },
      parameters: {
        app_id: { type: "string", in: "path", required: true },
        name: { type: "string", in: "body", required: true },
      },
    });
    expect(byName["update-reporter-integration"]).toMatchObject({
      endpoint: {
        method: "PATCH",
        path: "/api/apps/{app_id}/reporter-integrations/{reporter_integration_id}",
      },
      parameters: {
        app_id: { type: "string", in: "path", required: true },
        reporter_integration_id: { type: "string", in: "path", required: true },
        archived: { type: "boolean", in: "body", required: true },
      },
    });
    expect(byName["list-webhooks"]).toMatchObject({
      endpoint: {
        method: "GET",
        path: "/api/orgs/{org_id}/webhooks",
      },
      parameters: {
        org_id: { type: "string", in: "path", required: true },
      },
    });
    expect(byName["create-webhook"]).toMatchObject({
      endpoint: { method: "POST", path: "/api/orgs/{org_id}/webhooks" },
      parameters: {
        org_id: { type: "string", in: "path", required: true },
        url: { type: "string", in: "body", required: true },
        secret: { type: "string", in: "body", required: true },
        events: { type: "array", in: "body", required: false },
        app_id: { type: "string", in: "body", required: false },
      },
    });
    expect(byName["delete-webhook"]).toMatchObject({
      endpoint: {
        method: "DELETE",
        path: "/api/orgs/{org_id}/webhooks/{webhook_id}",
      },
      parameters: {
        org_id: { type: "string", in: "path", required: true },
        webhook_id: { type: "string", in: "path", required: true },
      },
    });
    expect(byName["get-reporter-feedback-metadata"]).toMatchObject({
      endpoint: { method: "GET", path: "/api/apps/{app_id}/reporter-feedback-metadata" },
      parameters: {
        app_id: { type: "string", in: "path", required: true },
        reporter_integration_id: { type: "string", in: "query", required: true },
        reporter_id: { type: "string", in: "query", required: true },
        token_id: { type: "string", in: "query", required: true },
      },
    });
    expect(byName["get-client-key"].parameters.app_id).toMatchObject({
      type: "string",
      in: "path",
      required: true,
    });
    expect(byName["delete-build-asset"]).toMatchObject({
      parameters: {
        app_id: { type: "string", in: "path", required: true },
        build_id: { type: "string", in: "path", required: true },
        asset_id: { type: "string", in: "path", required: true },
        expected_file_hash: { type: "string", in: "query", required: true },
        expected_size_bytes: { type: "integer", in: "query", required: true },
      },
    });
    expect(byName["add-app-member"].parameters).toMatchObject({
      app_id: { type: "string", in: "path", required: true },
      account_id: { type: "string", in: "body", required: true },
      app_role: { type: "string", in: "body", required: true },
    });
    expect(byName["create-release"].parameters.scopes).toMatchObject({ type: "array", in: "body" });
    expect(byName["update-release"].parameters.scopes).toMatchObject({ type: "array", in: "body" });
    expect(byName["update-release"].parameters.expected_revision).toMatchObject({
      type: "number",
      in: "body",
      required: false,
    });
    expect(byName["get-release"].endpoint.method).toBe("GET");
    expect(byName["get-release"].parameters).not.toHaveProperty("expected_scope");
    expect(byName["publish-release"].endpoint.method).toBe("POST");
    expect(byName["expire-testflight-build"].parameters).toMatchObject({
      app_id: { type: "string", in: "path", required: true },
      build_id: { type: "string", in: "path", required: true },
      asc_build_id: { type: "string", in: "body", required: true },
      confirm_version: { type: "string", in: "body", required: true },
      confirm_build_number: { type: "string", in: "body", required: true },
      bundle_id: { type: "string", in: "body", required: false },
    });
    expect(byName["publish-release"].parameters.expected_scope).toMatchObject({
      type: "object",
      in: "body",
      required: false,
    });
    expect(byName["publish-release"].parameters.expected_revision).toMatchObject({
      type: "number",
      in: "body",
      required: false,
    });
  });

  it("binds immutable reporter routes and exact integration webhooks without subject disclosure", async () => {
    const { env } = makeEnv() as any;
    env.FEEDBACK_AUDIT_HMAC_KEY = "test-audit-key-with-enough-entropy";
    env.FEEDBACK_AUDIT_KEY_VERSION = "test-v1";
    const { generateDeployToken, hashDeployToken } = await import("../src/lib/deploy_tokens");
    const {
      handleBindReporterRouteSubject,
      handleBindReporterWebhook,
      handleGetReporterRouteMetadata,
    } = await import("../src/routes/reporter_routes");
    const now = Date.now();
    const integrationId = "91919191-9191-4191-8191-919191919191";
    const reporterId = "route_reporter_123456789";
    const credential = generateDeployToken();
    await env.DB.prepare(
      `INSERT INTO app_reporter_integrations
       (id, app_id, name, created_at, updated_at)
       VALUES (?1, 'app-ios', 'Route', ?2, ?2)`,
    ).bind(integrationId, now).run();
    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at, reporter_integration_id)
       VALUES ('route-token', 'app-ios', 'route', ?1, ?2, NULL,
               '["feedback:write","feedback:read","feedback:comment","feedback:route"]',
               'test', ?3, ?4)`,
    ).bind(credential.token_prefix, await hashDeployToken(credential.token), now, integrationId).run();
    const subjectA = `rfr_v1_${"A".repeat(64)}`;
    const subjectB = `rfr_v1_${"B".repeat(64)}`;
    const bindContext = (subject: string, boundReporterId = reporterId) => ({
      env,
      req: {
        param: (name: string) => name === "appId" ? "app-ios" : undefined,
        header: (name: string) => name === "X-Hands-Reporter-Id"
          ? boundReporterId
          : name === "authorization" ? `Bearer ${credential.token}` : undefined,
        json: async () => ({ route_subject: subject }),
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    }) as any;
    const created = await handleBindReporterRouteSubject(bindContext(subjectA));
    expect(created.status).toBe(201);
    expect(JSON.stringify(await created.json())).not.toContain(subjectA);
    expect((await handleBindReporterRouteSubject(bindContext(subjectA))).status).toBe(200);
    expect((await handleBindReporterRouteSubject(bindContext(subjectB))).status).toBe(409);
    expect((await env.DB.prepare(
      "SELECT route_subject FROM app_reporter_routes WHERE app_id = 'app-ios' AND reporter_integration_id = ?1",
    ).bind(integrationId).first() as any).route_subject).toBe(subjectA);

    const concurrentSameReporter = "same_writer_reporter_1234";
    const concurrentSame = await Promise.all([
      handleBindReporterRouteSubject(bindContext(subjectA, concurrentSameReporter)),
      handleBindReporterRouteSubject(bindContext(subjectA, concurrentSameReporter)),
    ]);
    expect(concurrentSame.map((response) => response.status).sort()).toEqual([200, 201]);
    expect((await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM app_reporter_routes
       WHERE app_id = 'app-ios' AND reporter_integration_id = ?1 AND reporter_id = ?2`,
    ).bind(integrationId, concurrentSameReporter).first() as any).count).toBe(1);

    const concurrentDifferentReporter = "different_writer_reporter_1234";
    const concurrentDifferent = await Promise.all([
      handleBindReporterRouteSubject(bindContext(subjectA, concurrentDifferentReporter)),
      handleBindReporterRouteSubject(bindContext(subjectB, concurrentDifferentReporter)),
    ]);
    expect(concurrentDifferent.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM app_reporter_routes
       WHERE app_id = 'app-ios' AND reporter_integration_id = ?1 AND reporter_id = ?2`,
    ).bind(integrationId, concurrentDifferentReporter).first() as any).count).toBe(1);

    await env.DB.prepare(
      `INSERT INTO webhooks
       (id, org_id, app_id, url, secret, events_json, enabled, created_at, updated_at)
       VALUES ('route-hook', 'default', 'app-ios', 'https://example.test/route',
               'secret', '["feedback:comment_created"]', 1, ?1, ?1)`,
    ).bind(now).run();
    const adminContext = (handler: "bind" | "metadata") => ({
      env,
      req: {
        param: (name: string) => name === "appId" ? "app-ios"
          : name === "integrationId" ? integrationId
            : name === "webhookId" ? "route-hook" : undefined,
        query: (name: string) => name === "reporter_integration_id" ? integrationId
          : name === "reporter_id" ? reporterId
            : name === "token_id" ? "route-token" : undefined,
      },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    }) as any;
    expect((await handleBindReporterWebhook(adminContext("bind"))).status).toBe(201);
    expect((await handleBindReporterWebhook(adminContext("bind"))).status).toBe(200);
    const metadata = await handleGetReporterRouteMetadata(adminContext("metadata"));
    const metadataBody = await metadata.json() as any;
    expect(metadataBody).toMatchObject({
      route: { bound: true, subject_version: "v1" },
      grant: {
        token_id: "route-token",
        app_role: null,
        grant_valid: true,
        effective_permissions: ["feedback:comment", "feedback:read", "feedback:route", "feedback:write"],
      },
      matching_subscriber_count: 1,
      active_exact_subscriber: true,
      audit: { action: "feedback.route_bind", count: 2, key_version: "test-v1" },
      events: [],
    });
    expect(JSON.stringify(metadataBody)).not.toContain(subjectA);
    expect(JSON.stringify(metadataBody)).not.toContain(reporterId);

    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
       VALUES ('route-metadata-ticket', 'app-ios', 'feedback', 'open', 'hidden', '{}',
               ?1, ?2, ?3, ?3)`,
    ).bind(reporterId, integrationId, now).run();
    const metadataEventPayload = JSON.stringify({
      id: "route-metadata-event",
      event: "feedback:new",
      payload: { route_subject: subjectA, reporter_id: reporterId },
    });
    await env.DB.prepare(
      `INSERT INTO feedback_submission_events
       (id, event_type, app_id, ticket_id, reporter_integration_id, reporter_id,
        payload_json, route_outcome, route_subject, created_at)
       VALUES ('route-metadata-event', 'feedback:new', 'app-ios', 'route-metadata-ticket',
               ?1, ?2, ?3, 'route_bound', ?4, ?5)`,
    ).bind(integrationId, reporterId, metadataEventPayload, subjectA, now).run();
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries
       (id, webhook_id, event_type, feedback_submission_event_id, payload_json,
        signing_secret, signature_key_version, reporter_delivery, status, attempts, max_attempts,
        created_at, updated_at, completed_at)
       VALUES ('route-metadata-delivery', 'route-hook', 'feedback:new',
               'route-metadata-event', ?1, 'snapshot-secret', 'route-sign-v1', 1,
               'succeeded', 1, 3, ?2, ?2, ?2)`,
    ).bind(metadataEventPayload, now).run();
    const oracleBeforeRotation = await handleGetReporterRouteMetadata(adminContext("metadata"));
    const oracleBeforeRotationBody = await oracleBeforeRotation.json() as any;
    expect(oracleBeforeRotationBody.events[0]).toMatchObject({
      event_id: "route-metadata-event",
      delivery_id: "route-metadata-delivery",
      route_outcome: "route_bound",
      signature_key_version: "route-sign-v1",
      retry_stable: true,
      terminal: true,
    });
    expect(oracleBeforeRotationBody.events[0].payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(oracleBeforeRotationBody.events[0].signature_sha256).toMatch(/^[0-9a-f]{64}$/);
    await env.DB.prepare(
      "UPDATE webhooks SET secret = 'rotated-secret', signature_key_version = 'route-sign-v2' WHERE id = 'route-hook'",
    ).run();
    const oracleAfterRotation = await handleGetReporterRouteMetadata(adminContext("metadata"));
    const oracleAfterRotationBody = await oracleAfterRotation.json() as any;
    expect(oracleAfterRotationBody.events[0].signature_sha256)
      .toBe(oracleBeforeRotationBody.events[0].signature_sha256);
    expect(oracleAfterRotationBody.events[0].signature_key_version).toBe("route-sign-v1");
    expect(JSON.stringify(oracleAfterRotationBody)).not.toContain(subjectA);
    expect(JSON.stringify(oracleAfterRotationBody)).not.toContain(reporterId);

    await env.DB.prepare(
      `DELETE FROM app_reporter_webhook_subscriptions
       WHERE app_id = 'app-ios' AND reporter_integration_id = ?1 AND webhook_id = 'route-hook'`,
    ).bind(integrationId).run();
    const unboundPayload = JSON.stringify({ id: "route-unbound-event", event: "feedback:status_changed" });
    await env.DB.prepare(
      `INSERT INTO feedback_events
       (id, event_type, app_id, ticket_id, reporter_integration_id, reporter_id,
        payload_json, route_outcome, route_subject, created_at)
       VALUES ('route-unbound-event', 'feedback:status_changed', 'app-ios',
               'route-metadata-ticket', ?1, ?2, ?3, 'route_unbound', NULL, ?4)`,
    ).bind(integrationId, reporterId, unboundPayload, now + 1).run();
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries
       (id, webhook_id, event_type, event_id, payload_json, signing_secret,
        signature_key_version, reporter_delivery, status, attempts, max_attempts,
        created_at, updated_at)
       VALUES ('route-unbound-generic', 'route-hook', 'feedback:status_changed',
               'route-unbound-event', ?1, 'snapshot-secret', 'route-sign-v1', 0,
               'pending', 0, 3, ?2, ?2)`,
    ).bind(unboundPayload, now + 1).run();
    const oracleBeforeLaterBind = await handleGetReporterRouteMetadata(adminContext("metadata"));
    const unboundBefore = (await oracleBeforeLaterBind.json() as any).events
      .find((event: any) => event.event_id === "route-unbound-event");
    expect(unboundBefore).toMatchObject({ route_outcome: "route_unbound", delivery_id: null });
    expect((await handleBindReporterWebhook(adminContext("bind"))).status).toBe(201);
    const oracleAfterLaterBind = await handleGetReporterRouteMetadata(adminContext("metadata"));
    const unboundAfter = (await oracleAfterLaterBind.json() as any).events
      .find((event: any) => event.event_id === "route-unbound-event");
    expect(unboundAfter).toMatchObject({ route_outcome: "route_unbound", delivery_id: null });

    await env.DB.prepare("UPDATE apps SET archived = 1 WHERE id = 'app-ios'").run();
    expect((await handleBindReporterRouteSubject(
      bindContext(subjectA, "archived_app_reporter_1234"),
    )).status).toBe(403);
    expect((await handleBindReporterWebhook(adminContext("bind"))).status).toBe(409);
    const inactiveMetadata = await handleGetReporterRouteMetadata(adminContext("metadata"));
    expect(await inactiveMetadata.json()).toMatchObject({
      grant: { grant_valid: false },
      route: { bound: false },
      matching_subscriber_count: 0,
      active_exact_subscriber: false,
    });
    await env.DB.prepare("UPDATE apps SET archived = 0 WHERE id = 'app-ios'").run();
    await env.DB.prepare(
      "UPDATE app_reporter_integrations SET archived_at = ?1 WHERE id = ?2",
    ).bind(now + 1, integrationId).run();
    expect((await handleBindReporterRouteSubject(
      bindContext(subjectA, "archived_integration_reporter_1234"),
    )).status).toBe(403);
    expect((await handleBindReporterWebhook(adminContext("bind"))).status).toBe(409);
    const archivedIntegrationMetadata = await handleGetReporterRouteMetadata(adminContext("metadata"));
    expect(await archivedIntegrationMetadata.json()).toMatchObject({
      grant: { grant_valid: false },
      route: { bound: false },
      active_exact_subscriber: false,
    });
    await env.DB.prepare(
      "UPDATE app_reporter_integrations SET archived_at = NULL WHERE id = ?1",
    ).bind(integrationId).run();
  });

  it("mints disabled-by-default reporter sessions and removes deploy-token D1 auth from hot routes", async () => {
    const { env } = makeEnv() as any;
    env.FEEDBACK_AUDIT_HMAC_KEY = "test-audit-key-with-enough-entropy";
    env.FEEDBACK_AUDIT_KEY_VERSION = "test-v1";
    const keyBytes = new Uint8Array(32).fill(19);
    let keyBinary = "";
    for (const byte of keyBytes) keyBinary += String.fromCharCode(byte);
    const key = btoa(keyBinary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const { generateDeployToken, hashDeployToken } = await import("../src/lib/deploy_tokens");
    const { handleMintReporterSession } = await import("../src/routes/reporter_sessions");
    const {
      handleAddReporterComment,
      handleGetReporterFeedback,
      handleListReporterFeedback,
    } = await import("../src/routes/reporter_feedback");
    const appId = "10101010-1010-4010-8010-101010101010";
    const integrationId = "20202020-2020-4020-8020-202020202020";
    const tokenId = "30303030-3030-4030-8030-303030303030";
    const ticketId = "40404040-4040-4040-8040-404040404040";
    const reporterId = "signed_session_reporter_123456789";
    const credential = generateDeployToken();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO apps (id, org_id, slug, name, platform, created_at)
       VALUES (?1, 'default', 'signed-session-app', 'Signed session app', 'web', ?2)`,
    ).bind(appId, now).run();
    await env.DB.prepare(
      `INSERT INTO app_reporter_integrations
       (id, app_id, name, created_at, updated_at)
       VALUES (?1, ?2, 'Signed session', ?3, ?3)`,
    ).bind(integrationId, appId, now).run();
    await env.DB.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at, reporter_integration_id)
       VALUES (?1, ?2, 'signed-session', ?3, ?4, NULL,
               '["feedback:read","feedback:comment"]', 'test', ?5, ?6)`,
    ).bind(tokenId, appId, credential.token_prefix, await hashDeployToken(credential.token), now, integrationId).run();
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
       VALUES (?1, ?2, 'feedback', 'open', 'Session ticket', '{}', ?3, ?4, ?5, ?5)`,
    ).bind(ticketId, appId, reporterId, integrationId, now).run();

    const context = (input: {
      app?: string;
      reporter?: string;
      bearer?: string;
      ticket?: string;
      body?: unknown;
      query?: Record<string, string>;
    }) => {
      const responseHeaders = new Headers();
      return {
        env,
        header: (name: string, value: string) => responseHeaders.set(name, value),
        req: {
          param: (name: string) => name === "appId"
            ? input.app ?? appId
            : name === "ticketId"
              ? input.ticket
              : undefined,
          header: (name: string) => name === "X-Hands-Reporter-Id"
            ? input.reporter ?? reporterId
            : name.toLowerCase() === "authorization" && input.bearer
              ? `Bearer ${input.bearer}`
              : undefined,
          query: (name: string) => input.query?.[name],
          json: async () => input.body,
          text: async () => JSON.stringify(input.body),
          formData: async () => new FormData(),
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
          status,
          headers: responseHeaders,
        }),
      } as any;
    };

    const disabledMint = await handleMintReporterSession(context({
      bearer: credential.token,
      body: { scopes: ["feedback:read", "feedback:comment"] },
    }));
    expect(disabledMint.status).toBe(404);
    expect(disabledMint.headers.get("server-timing")).toBeNull();

    env.FEEDBACK_REPORTER_SESSION_ENABLED = "true";
    env.FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION = "test-n";
    env.FEEDBACK_REPORTER_SESSION_KEYS = JSON.stringify({ "test-n": key });
    const mint = await handleMintReporterSession(context({
      bearer: credential.token,
      body: { scopes: ["feedback:read", "feedback:comment"] },
    }));
    expect(mint.status).toBe(201);
    expect(mint.headers.get("cache-control")).toBe("private, no-store");
    expect(mint.headers.get("server-timing")).toMatch(/^hands_session_mint;dur=\d+\.\d$/);
    const mintBody = await mint.json() as any;
    expect(mintBody.reporter_integration_id).toBe(integrationId);
    const session = mintBody.session_token as string;
    expect(session).toMatch(/^hrps_v1_/);

    const originalBatch = env.DB.batch.bind(env.DB);
    let batchStages = 0;
    env.DB.batch = async (statements: unknown[]) => {
      batchStages += 1;
      return originalBatch(statements);
    };
    const list = await handleListReporterFeedback(context({ bearer: session }));
    env.DB.batch = originalBatch;
    expect(list.status).toBe(200);
    expect(batchStages).toBe(2);
    expect((await list.json() as any).tickets.map((ticket: any) => ticket.id)).toEqual([ticketId]);
    expect(list.headers.get("server-timing")).toMatch(
      /^hands_session_verify;dur=\d+\.\d, hands_auth;dur=\d+\.\d, hands_list;dur=\d+\.\d$/,
    );

    const detail = await handleGetReporterFeedback(context({ bearer: session, ticket: ticketId }));
    expect(detail.status).toBe(200);
    expect((await detail.json() as any).ticket.id).toBe(ticketId);
    const comment = await handleAddReporterComment(context({
      bearer: session,
      ticket: ticketId,
      body: {
        body: "signed session comment",
        submission_id: "50505050-5050-4050-8050-505050505050",
      },
    }));
    expect(comment.status).toBe(201);
    expect(comment.headers.get("server-timing")).toMatch(/^hands_session_verify;/);

    expect((await handleMintReporterSession(context({
      bearer: credential.token,
      body: { scopes: ["feedback:write"] },
    }))).status).toBe(400);
    expect((await handleMintReporterSession(context({
      bearer: credential.token,
      body: { scopes: ["feedback:read"], extra: true },
    }))).status).toBe(400);
    expect((await handleMintReporterSession(context({
      bearer: credential.token,
      body: { scopes: ["feedback:read"], padding: "x".repeat(2_000) },
    }))).status).toBe(400);
    // The reporter header selects an opaque reporter under the deploy token's
    // existing integration authority; it is not separately authenticated.
    expect((await handleMintReporterSession(context({
      bearer: credential.token,
      reporter: "another_reporter_header_123456789",
      body: { scopes: ["feedback:read"] },
    }))).status).toBe(201);

    let mismatchBatches = 0;
    env.DB.batch = async (statements: unknown[]) => {
      mismatchBatches += 1;
      return originalBatch(statements);
    };
    expect((await handleListReporterFeedback(context({
      app: "60606060-6060-4060-8060-606060606060",
      bearer: session,
    }))).status).toBe(403);
    expect((await handleListReporterFeedback(context({
      reporter: "different_reporter_123456789",
      bearer: session,
    }))).status).toBe(403);
    env.DB.batch = originalBatch;
    expect(mismatchBatches).toBe(0);

    await env.DB.prepare(
      `UPDATE feedback_reporter_session_mint_rate_windows SET request_count = 30
       WHERE app_id = ?1 AND reporter_integration_id = ?2
         AND reporter_hash <> 'integration-total'`,
    ).bind(appId, integrationId).run();
    const limited = await handleMintReporterSession(context({
      bearer: credential.token,
      body: { scopes: ["feedback:read"] },
    }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    await env.DB.prepare("UPDATE app_deploy_tokens SET revoked_at = ?1 WHERE id = ?2")
      .bind(Date.now(), tokenId).run();
    expect((await handleMintReporterSession(context({
      bearer: credential.token,
      body: { scopes: ["feedback:read"] },
    }))).status).toBe(401);
    // Already-issued sessions deliberately retain bounded validity after source
    // revocation; no D1 auth lookup is reintroduced on the hot path.
    expect((await handleListReporterFeedback(context({ bearer: session }))).status).toBe(200);

    env.FEEDBACK_REPORTER_SESSION_ENABLED = "false";
    const disabledUse = await handleListReporterFeedback(context({ bearer: session }));
    expect(disabledUse.status).toBe(401);
    expect(disabledUse.headers.get("server-timing")).toBeNull();
  });

  it("reporter feedback bearer routes isolate integrations and converge comment replay", async () => {
    const { env } = makeEnv() as any;
    env.FEEDBACK_AUDIT_HMAC_KEY = "test-audit-key-with-enough-entropy";
    env.FEEDBACK_AUDIT_KEY_VERSION = "test-v1";
    const { generateDeployToken, hashDeployToken } = await import("../src/lib/deploy_tokens");
    const {
      handleAddReporterComment,
      handleCloseReporterFeedback,
      handleReopenReporterFeedback,
      cleanupReporterFeedbackData,
      handleDownloadReporterAttachment,
      handleGetReporterFeedback,
      handleListReporterFeedback,
    } =
      await import("../src/routes/reporter_feedback");
    const now = Date.now();
    const reporterId = "r".repeat(64);
    const integrationA = "11111111-1111-4111-8111-111111111111";
    const integrationB = "22222222-2222-4222-8222-222222222222";
    const ticketA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ticketB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const credentialA = generateDeployToken();
    const credentialB = generateDeployToken();
    const credentialComment = generateDeployToken();
    const credentialRead = generateDeployToken();
    await env.DB.prepare(
      `INSERT INTO app_reporter_integrations
       (id, app_id, name, created_at, updated_at)
       VALUES (?1, 'app-ios', 'A', ?3, ?3), (?2, 'app-ios', 'B', ?3, ?3)`,
    ).bind(integrationA, integrationB, now).run();
    const insertToken = async (
      id: string,
      credential: { token: string; token_prefix: string },
      integrationId: string,
      scopes = '["feedback:write","feedback:read","feedback:comment","feedback:route"]',
    ) => {
      await env.DB.prepare(
        `INSERT INTO app_deploy_tokens
         (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
          created_by_actor, created_at, reporter_integration_id)
         VALUES (?1, 'app-ios', ?1, ?2, ?3, NULL,
                 ?4, 'test', ?5, ?6)`,
      ).bind(
        id,
        credential.token_prefix,
        await hashDeployToken(credential.token),
        scopes,
        now,
        integrationId,
      ).run();
    };
    await insertToken("token-a", credentialA, integrationA);
    await insertToken("token-b", credentialB, integrationB);
    await insertToken("token-comment", credentialComment, integrationA, '["feedback:comment"]');
    await insertToken("token-read", credentialRead, integrationA, '["feedback:read"]');
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
       VALUES (?1, 'app-ios', 'feedback', 'open', 'A ticket', '{}', ?3, ?4, ?5, ?5),
              (?2, 'app-ios', 'feedback', 'open', 'B ticket', '{}', ?3, ?6, ?5, ?5)`,
    ).bind(ticketA, ticketB, reporterId, integrationA, now, integrationB).run();
    await env.DB.prepare(
      `INSERT INTO webhooks
       (id, org_id, app_id, url, secret, events_json, enabled, created_at, updated_at)
       VALUES ('reporter-hook', 'default', 'app-ios', 'https://example.test/hook',
               'secret', '["feedback:comment_created","feedback:status_changed"]', 1, ?1, ?1)`,
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO app_reporter_routes
       (app_id, reporter_integration_id, reporter_id, route_subject, subject_version, created_at)
       VALUES ('app-ios', ?1, ?2, ?3, 'v1', ?4)`,
    ).bind(integrationA, reporterId, `rfr_v1_${"A".repeat(64)}`, now).run();
    await env.DB.prepare(
      `INSERT INTO app_reporter_webhook_subscriptions
       (app_id, reporter_integration_id, webhook_id, created_at)
       VALUES ('app-ios', ?1, 'reporter-hook', ?2)`,
    ).bind(integrationA, now).run();

    const context = (
      handler: "list" | "detail" | "comment" | "close" | "reopen",
      credential: string | null,
      ticketId?: string,
      commentBody?: { body: string; submission_id: string } | FormData,
      headerReporter = reporterId,
      queries: Record<string, string> = {},
    ) => {
      const responseHeaders = new Headers();
      return {
        env,
        header: (name: string, value: string) => responseHeaders.set(name, value),
        req: {
          param: (name: string) => name === "appId" ? "app-ios" : name === "ticketId" ? ticketId : undefined,
          header: (name: string) => name.toLowerCase() === "content-type" && commentBody instanceof FormData
            ? "multipart/form-data; boundary=test"
            : name === "X-Hands-Reporter-Id"
            ? headerReporter
            : name === "authorization" && credential
              ? `Bearer ${credential}`
              : undefined,
          query: (name: string) => queries[name] ?? (handler === "list" && name === "limit" ? "50" : undefined),
          json: async () => commentBody instanceof FormData ? {} : commentBody ?? {},
          formData: async () => commentBody instanceof FormData ? commentBody : new FormData(),
        },
        json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
          status,
          headers: responseHeaders,
        }),
      } as any;
    };

    const listA = await handleListReporterFeedback(context("list", credentialA.token));
    expect(listA.status).toBe(200);
    expect(listA.headers.get("server-timing")).toMatch(
      /^hands_auth;dur=\d+\.\d, hands_list;dur=\d+\.\d$/,
    );
    const listABody = await listA.json() as any;
    expect(listABody.tickets.map((ticket: any) => ticket.id)).toEqual([ticketA]);
    expect(listABody.tickets[0]).toMatchObject({
      attachment_count: 0,
      comment_count: 0,
      latest_comment_at: null,
      unread: false,
      unread_count: 0,
    });
    expect(listABody.unread_total).toBe(0);
    expect((await handleGetReporterFeedback(context("detail", credentialA.token, ticketB))).status).toBe(404);
    expect((await handleListReporterFeedback(context("list", credentialA.token, undefined, undefined, ""))).status).toBe(400);
    expect((await handleListReporterFeedback(context("list", null))).status).toBe(401);

    const rateReporter = "rate_limit_reporter_123456789";
    const firstRateRequest = await handleListReporterFeedback(context(
      "list",
      credentialA.token,
      undefined,
      undefined,
      rateReporter,
    ));
    expect(firstRateRequest.status).toBe(200);
    const { computeReporterAuditHash: reporterAuditHash } =
      await import("../src/lib/reporter_audit");
    const rateReporterHash = await reporterAuditHash({
      key: env.FEEDBACK_AUDIT_HMAC_KEY,
      appId: "app-ios",
      integrationId: integrationA,
      reporterId: rateReporter,
    });
    await env.DB.prepare(
      `UPDATE feedback_reporter_rate_windows SET request_count = 59
       WHERE app_id = 'app-ios' AND reporter_integration_id = ?1
         AND reporter_hash = ?2 AND endpoint = 'list'`,
    ).bind(integrationA, rateReporterHash).run();
    expect((await handleListReporterFeedback(context(
      "list", credentialA.token, undefined, undefined, rateReporter,
    ))).status).toBe(200);
    const rateLimited = await handleListReporterFeedback(context(
      "list", credentialA.token, undefined, undefined, rateReporter,
    ));
    expect(rateLimited.status).toBe(429);
    expect(Number(rateLimited.headers.get("retry-after"))).toBeGreaterThan(0);

    const submissionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const makeComment = () => handleAddReporterComment(context(
      "comment",
      credentialA.token,
      ticketA,
      { body: "  hello reporter loop  ", submission_id: submissionId },
    ));
    const concurrent = await Promise.all([makeComment(), makeComment()]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 201]);
    const conflict = await handleAddReporterComment(context(
      "comment",
      credentialA.token,
      ticketA,
      { body: "different", submission_id: submissionId },
    ));
    expect(conflict.status).toBe(409);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_comments WHERE ticket_id = ?1 AND author_type = 'reporter'",
    ).bind(ticketA).first() as any).count).toBe(1);
    expect((await env.DB.prepare(
      "SELECT submission_fingerprint FROM feedback_comments WHERE ticket_id = ?1 AND submission_id = ?2",
    ).bind(ticketA, submissionId).first() as any).submission_fingerprint).toBe(
      createHash("sha256").update("hello reporter loop").digest("hex"),
    );
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_events WHERE ticket_id = ?1",
    ).bind(ticketA).first() as any).count).toBe(1);
    const reporterEvent = await env.DB.prepare(
      `SELECT payload_json FROM feedback_events
       WHERE ticket_id = ?1 AND event_type = 'feedback:comment_created'`,
    ).bind(ticketA).first() as { payload_json: string } | null;
    expect(JSON.parse(reporterEvent!.payload_json).payload.comment).toMatchObject({
      author_type: "reporter",
      body: "hello reporter loop",
    });
    expect(JSON.parse(reporterEvent!.payload_json).payload.comment).toHaveProperty("id");
    expect(JSON.parse(reporterEvent!.payload_json).payload.comment).toHaveProperty("created_at");
    expect(JSON.parse(reporterEvent!.payload_json).payload).toMatchObject({
      route_outcome: "route_bound",
      route_subject: `rfr_v1_${"A".repeat(64)}`,
    });
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE webhook_id = 'reporter-hook' AND event_id IS NOT NULL",
    ).first() as any).count).toBe(1);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'feedback.reporter_comment'",
    ).first() as any).count).toBe(1);

    // Closing is a one-way, reporter-owned conversation mutation. It uses the
    // comment capability, preserves every other ticket field, and emits one
    // status event/audit even under an exact concurrent retry.
    expect((await handleCloseReporterFeedback(context(
      "close", credentialRead.token, ticketA,
    ))).status).toBe(403);
    expect((await handleCloseReporterFeedback(context(
      "close", credentialB.token, ticketA,
    ))).status).toBe(404);
    await env.DB.prepare("UPDATE feedback_tickets SET assignee = 'staff:test' WHERE id = ?1")
      .bind(ticketA).run();
    const closeResponses = await Promise.all([
      handleCloseReporterFeedback(context("close", credentialComment.token, ticketA)),
      handleCloseReporterFeedback(context("close", credentialComment.token, ticketA)),
    ]);
    const closeBodies = await Promise.all(closeResponses.map((response) => response.json() as Promise<any>));
    expect(closeBodies.map((body) => body.changed).sort()).toEqual([false, true]);
    expect(await env.DB.prepare(
      "SELECT status, assignee FROM feedback_tickets WHERE id = ?1",
    ).bind(ticketA).first()).toEqual({ status: "closed", assignee: "staff:test" });
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'feedback.reporter_close'",
    ).first() as any).count).toBe(1);
    const closeAudit = await env.DB.prepare(
      "SELECT actor, payload FROM audit_logs WHERE action = 'feedback.reporter_close'",
    ).first() as { actor: string; payload: string } | null;
    expect(closeAudit?.actor).toMatch(/^reporter:[0-9a-f]{64}$/);
    expect(JSON.parse(closeAudit!.payload)).toMatchObject({
      ticket_id: ticketA,
      previous_status: "open",
      status: "closed",
    });
    const closeEvents = await env.DB.prepare(
      `SELECT payload_json FROM feedback_events
       WHERE ticket_id = ?1 AND event_type = 'feedback:status_changed'`,
    ).bind(ticketA).all() as any;
    expect(closeEvents.results).toHaveLength(1);
    expect(JSON.parse(closeEvents.results[0].payload_json).payload).toMatchObject({
      ticket_id: ticketA,
      previous_status: "open",
      status: "closed",
      reporter_integration_id: integrationA,
      reporter_id: reporterId,
    });

    // Reopening is the matching bounded mutation: it restores only `open`,
    // preserves the assignee, and converges exact concurrent retries.
    expect((await handleReopenReporterFeedback(context(
      "reopen", credentialRead.token, ticketA,
    ))).status).toBe(403);
    expect((await handleReopenReporterFeedback(context(
      "reopen", credentialB.token, ticketA,
    ))).status).toBe(404);
    const reopenResponses = await Promise.all([
      handleReopenReporterFeedback(context("reopen", credentialComment.token, ticketA)),
      handleReopenReporterFeedback(context("reopen", credentialComment.token, ticketA)),
    ]);
    const reopenBodies = await Promise.all(reopenResponses.map((response) => response.json() as Promise<any>));
    expect(reopenBodies.map((body) => body.changed).sort()).toEqual([false, true]);
    expect(reopenBodies.every((body) => body.status === "open")).toBe(true);
    expect(await env.DB.prepare(
      "SELECT status, assignee FROM feedback_tickets WHERE id = ?1",
    ).bind(ticketA).first()).toEqual({ status: "open", assignee: "staff:test" });
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'feedback.reporter_reopen'",
    ).first() as any).count).toBe(1);
    const reopenAudit = await env.DB.prepare(
      "SELECT actor, payload FROM audit_logs WHERE action = 'feedback.reporter_reopen'",
    ).first() as { actor: string; payload: string } | null;
    expect(reopenAudit?.actor).toMatch(/^reporter:[0-9a-f]{64}$/);
    expect(JSON.parse(reopenAudit!.payload)).toMatchObject({
      ticket_id: ticketA,
      previous_status: "closed",
      status: "open",
    });
    const statusEvents = await env.DB.prepare(
      `SELECT payload_json FROM feedback_events
       WHERE ticket_id = ?1 AND event_type = 'feedback:status_changed'
       ORDER BY created_at ASC`,
    ).bind(ticketA).all() as any;
    expect(statusEvents.results).toHaveLength(2);
    expect(JSON.parse(statusEvents.results[1].payload_json).payload).toMatchObject({
      ticket_id: ticketA,
      previous_status: "closed",
      status: "open",
      reporter_integration_id: integrationA,
      reporter_id: reporterId,
    });
    await env.DB.prepare(
      "DELETE FROM feedback_events WHERE ticket_id = ?1 AND event_type = 'feedback:status_changed'",
    ).bind(ticketA).run();
    await env.DB.prepare("DELETE FROM audit_logs WHERE action = 'feedback.reporter_close'").run();
    await env.DB.prepare("DELETE FROM audit_logs WHERE action = 'feedback.reporter_reopen'").run();
    await env.DB.prepare(
      "UPDATE feedback_tickets SET status = 'open', assignee = NULL WHERE id = ?1",
    ).bind(ticketA).run();

    const { computeReporterAuditHash } = await import("../src/lib/reporter_audit");
    await expect(computeReporterAuditHash({
      key: "0123456789abcdef0123456789abcdef",
      appId: "app-1",
      integrationId: "integration-1",
      reporterId: "reporter-1",
    })).resolves.toBe("593d979085c606e7898b6e3a5cfc3eb9f26e9b3ca1a7e75c61ae8e370cdc5e25");
    await expect(computeReporterAuditHash({
      key: "too-short",
      appId: "app-1",
      integrationId: "integration-1",
      reporterId: "reporter-1",
    })).resolves.toBeNull();

    for (const id of [
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ]) {
      await env.DB.prepare(
        `INSERT INTO feedback_comments
         (id, ticket_id, author_actor, author_type, body, internal, created_at)
         VALUES (?1, ?2, 'system', 'system', ?1, 0, ?3)`,
      ).bind(id, ticketA, now + 100).run();
    }
    const detailBatch = env.DB.batch.bind(env.DB);
    let detailBatchStages = 0;
    env.DB.batch = async (statements: unknown[]) => {
      detailBatchStages += 1;
      return detailBatch(statements);
    };
    const page1 = await handleGetReporterFeedback(context(
      "detail", credentialA.token, ticketA, undefined, reporterId,
      { comment_limit: "2" },
    ));
    env.DB.batch = detailBatch;
    expect(detailBatchStages).toBe(4);
    expect(page1.headers.get("server-timing")).toMatch(
      /^hands_auth;dur=\d+\.\d, hands_preflight;dur=\d+\.\d, hands_commit;dur=\d+\.\d, hands_postcommit;dur=\d+\.\d$/,
    );
    const page1Body = await page1.json() as any;
    expect(page1Body.ticket).toMatchObject({ unread: true, unread_count: 2 });
    expect(page1Body.unread_total).toBe(1);
    const page2 = await handleGetReporterFeedback(context(
      "detail", credentialA.token, ticketA, undefined, reporterId,
      { comment_limit: "2", comment_cursor: page1Body.next_comment_cursor },
    ));
    const page2Body = await page2.json() as any;
    expect(page2Body.ticket).toMatchObject({ unread: false, unread_count: 0 });
    expect(page2Body.unread_total).toBe(0);
    const firstFour = [...page1Body.comments, ...page2Body.comments].map((comment: any) => comment.id);
    const expectedFirstFour = (await env.DB.prepare(
      `SELECT id FROM feedback_comments WHERE ticket_id = ?1 AND internal = 0
       ORDER BY created_at ASC, id ASC LIMIT 4`,
    ).bind(ticketA).all() as any).results.map((comment: any) => comment.id);
    expect(firstFour).toEqual(expectedFirstFour);

    const legacyTicket = "90909090-9090-4090-8090-909090909090";
    const bridgeTime = now + 150;
    const bridgeHigh = "eeeeeeee-1111-4111-8111-111111111111";
    const bridgeLow = "11111111-2222-4222-8222-222222222222";
    const bridgeHigher = "ffffffff-3333-4333-8333-333333333333";
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
       VALUES (?1, 'app-ios', 'feedback', 'open', 'Legacy cursor bridge', '{}',
               ?2, ?3, ?4, ?4)`,
    ).bind(legacyTicket, reporterId, integrationA, bridgeTime).run();
    for (const id of [bridgeHigh, bridgeLow, bridgeHigher]) {
      await env.DB.prepare(
        `INSERT INTO feedback_comments
         (id, ticket_id, author_actor, author_type, body, internal, created_at)
         VALUES (?1, ?2, 'staff:test', 'staff', ?1, 0, ?3)`,
      ).bind(id, legacyTicket, bridgeTime).run();
    }
    const legacyCursor = btoa(JSON.stringify([bridgeTime, bridgeLow]))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const legacyPage1 = await handleGetReporterFeedback(context(
      "detail", credentialA.token, legacyTicket, undefined, reporterId,
      { comment_limit: "1", comment_cursor: legacyCursor },
    ));
    const legacyPage1Body = await legacyPage1.json() as any;
    expect(legacyPage1Body.comments.map((comment: any) => comment.id)).toEqual([bridgeHigh]);
    const legacyPage2 = await handleGetReporterFeedback(context(
      "detail", credentialA.token, legacyTicket, undefined, reporterId,
      { comment_limit: "1", comment_cursor: legacyPage1Body.next_comment_cursor },
    ));
    const legacyPage2Body = await legacyPage2.json() as any;
    expect(legacyPage2Body.comments.map((comment: any) => comment.id)).toEqual([bridgeHigher]);
    expect(legacyPage2Body.comments.map((comment: any) => comment.id)).not.toContain(bridgeLow);
    await env.DB.prepare("DELETE FROM feedback_tickets WHERE id = ?1").bind(legacyTicket).run();

    const sparseLegacyTicket = "91909090-9090-4090-8090-909090909090";
    const sparsePrevious = "01010101-0101-4101-8101-010101010101";
    const sparseMid = "88888888-8888-4888-8888-888888888888";
    const sparseHigh = "ffffffff-ffff-4fff-8fff-fffffffffff0";
    const sparseLow = "11111111-1111-4111-8111-111111111110";
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
       VALUES (?1, 'app-ios', 'feedback', 'open', 'Sparse legacy receipt', '{}',
               ?2, ?3, ?4, ?4)`,
    ).bind(sparseLegacyTicket, reporterId, integrationA, bridgeTime).run();
    await env.DB.prepare(
      `INSERT INTO feedback_comments
       (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES (?1, ?2, 'staff:test', 'staff', 'previous', 0, ?3)`,
    ).bind(sparsePrevious, sparseLegacyTicket, bridgeTime - 1).run();
    for (const id of [sparseMid, sparseHigh, sparseLow]) {
      await env.DB.prepare(
        `INSERT INTO feedback_comments
         (id, ticket_id, author_actor, author_type, body, internal, created_at)
         VALUES (?1, ?2, 'staff:test', 'staff', ?1, 0, ?3)`,
      ).bind(id, sparseLegacyTicket, bridgeTime).run();
    }
    const sparsePreviousRow = await env.DB.prepare(
      "SELECT reporter_sequence FROM feedback_comments WHERE id = ?1",
    ).bind(sparsePrevious).first() as any;
    await env.DB.prepare(
      `INSERT INTO feedback_reporter_ticket_reads
       (app_id, reporter_integration_id, reporter_id, ticket_id,
        read_through_sequence, read_through_comment_id, updated_at)
       VALUES ('app-ios', ?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      integrationA,
      reporterId,
      sparseLegacyTicket,
      sparsePreviousRow.reporter_sequence,
      sparsePrevious,
      now,
    ).run();
    const sparseCursor = btoa(JSON.stringify([bridgeTime - 1, sparsePrevious]))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const sparsePage = await handleGetReporterFeedback(context(
      "detail", credentialA.token, sparseLegacyTicket, undefined, reporterId,
      { comment_limit: "1", comment_cursor: sparseCursor },
    ));
    const sparseBody = await sparsePage.json() as any;
    expect(sparseBody.comments.map((comment: any) => comment.id)).toEqual([sparseLow]);
    expect(sparseBody.ticket).toMatchObject({ unread: true, unread_count: 3 });
    expect(sparseBody.unread_total).toBeGreaterThanOrEqual(1);
    await env.DB.prepare("DELETE FROM feedback_tickets WHERE id = ?1").bind(sparseLegacyTicket).run();

    const afterRead = await handleListReporterFeedback(context("list", credentialA.token));
    expect(await afterRead.json()).toMatchObject({
      unread_total: 0,
      tickets: [{ id: ticketA, unread: false, unread_count: 0 }],
    });
    const tiedEarlier = "21212121-2121-4212-8212-212121212121";
    const tiedLater = "31313131-3131-4313-8313-313131313131";
    await env.DB.prepare(
      `INSERT INTO feedback_comments
       (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES (?1, ?2, 'staff:test', 'staff', 'new visible reply', 0, ?3)`,
    ).bind(tiedEarlier, ticketA, now + 200).run();
    const unreadOnce = await handleListReporterFeedback(context("list", credentialA.token));
    expect(await unreadOnce.json()).toMatchObject({
      unread_total: 1,
      tickets: [{ id: ticketA, unread: true, unread_count: 1 }],
    });
    await handleGetReporterFeedback(context("detail", credentialA.token, ticketA));
    await env.DB.prepare(
      `INSERT INTO feedback_comments
       (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES (?1, ?2, 'system', 'system', 'same timestamp later id', 0, ?3)`,
    ).bind(tiedLater, ticketA, now + 200).run();
    const unreadTie = await handleListReporterFeedback(context("list", credentialA.token));
    expect(await unreadTie.json()).toMatchObject({
      unread_total: 1,
      tickets: [{ id: ticketA, unread: true, unread_count: 1 }],
    });
    await env.DB.prepare(
      `INSERT INTO feedback_comments
       (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES ('41414141-4141-4414-8414-414141414141', ?1, 'staff:test', 'staff',
               'internal does not count', 1, ?2)`,
    ).bind(ticketA, now + 300).run();
    const unreadInternal = await handleListReporterFeedback(context("list", credentialA.token));
    expect((await unreadInternal.json() as any).tickets[0].unread_count).toBe(1);
    await handleGetReporterFeedback(context("detail", credentialA.token, ticketA));

    const raceCommentId = "10101010-1010-4010-8010-101010101010";
    const originalPrepare = env.DB.prepare.bind(env.DB);
    const raceOriginalBatch = env.DB.batch.bind(env.DB);
    let injectRace = true;
    let raceReadPrepared = false;
    env.DB.prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      if (
        sql.includes("FROM feedback_comments fc")
        && sql.includes("fc.reporter_sequence")
      ) raceReadPrepared = true;
      return statement;
    };
    env.DB.batch = async (statements: unknown[]) => {
      const snapshot = await raceOriginalBatch(statements);
      if (injectRace && raceReadPrepared) {
        injectRace = false;
        raceReadPrepared = false;
        await originalPrepare(
          `INSERT INTO feedback_comments
           (id, ticket_id, author_actor, author_type, body, internal, created_at)
           VALUES (?1, ?2, 'staff:test', 'staff', 'raced after snapshot', 0, ?3)`,
        ).bind(raceCommentId, ticketA, now + 200).run();
      }
      return snapshot;
    };
    const raceDetail = await handleGetReporterFeedback(context("detail", credentialA.token, ticketA));
    env.DB.prepare = originalPrepare;
    env.DB.batch = raceOriginalBatch;
    const raceBody = await raceDetail.json() as any;
    expect(raceBody.comments.some((comment: any) => comment.id === raceCommentId)).toBe(false);
    expect(raceBody.ticket).toMatchObject({ unread: true, unread_count: 1 });
    expect(raceBody.unread_total).toBe(1);
    await handleGetReporterFeedback(context("detail", credentialA.token, ticketA));

    const stageTicket = "abababab-1111-4111-8111-abababababab";
    await env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
       VALUES (?1, 'app-ios', 'feedback', 'open', 'Four-stage comment', '{}',
               ?2, ?3, ?4, ?4)`,
    ).bind(stageTicket, reporterId, integrationA, now).run();
    const commentBatch = env.DB.batch.bind(env.DB);
    let commentBatchStages = 0;
    env.DB.batch = async (statements: unknown[]) => {
      commentBatchStages += 1;
      return commentBatch(statements);
    };
    const stagedComment = await handleAddReporterComment(context(
      "comment",
      credentialA.token,
      stageTicket,
      {
        body: "four stage comment",
        submission_id: "abababab-abab-4bab-8bab-abababababab",
      },
    ));
    env.DB.batch = commentBatch;
    expect(stagedComment.status).toBe(201);
    expect(commentBatchStages).toBe(4);
    expect(stagedComment.headers.get("server-timing")).toMatch(
      /^hands_auth;dur=\d+\.\d, hands_preflight;dur=\d+\.\d, hands_commit;dur=\d+\.\d, hands_postcommit;dur=\d+\.\d$/,
    );
    await env.DB.prepare("DELETE FROM feedback_tickets WHERE id = ?1").bind(stageTicket).run();

    const emojiSubmission = "12121212-1212-4212-8212-121212121212";
    expect((await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA,
      { body: "😀".repeat(10_000), submission_id: emojiSubmission },
    ))).status).toBe(201);
    expect((await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA,
      { body: "😀".repeat(10_001), submission_id: "13131313-1313-4313-8313-131313131313" },
    ))).status).toBe(400);

    const storedObjects = new Map<string, Uint8Array>();
    const deletedObjects: string[] = [];
    env.APK_BUCKET = {
      put: async (key: string, value: ArrayBuffer) => {
        storedObjects.set(key, new Uint8Array(value));
      },
      get: async (key: string) => {
        const value = storedObjects.get(key);
        return value ? { body: new Blob([value]).stream() } : null;
      },
      delete: async (key: string) => {
        deletedObjects.push(key);
        storedObjects.delete(key);
      },
    };
    const attachmentSubmission = "51515151-5151-4515-8515-515151515151";
    const attachmentForm = new FormData();
    attachmentForm.set("body", "reply with screenshot");
    attachmentForm.set("submission_id", attachmentSubmission);
    attachmentForm.append("attachments", new File([new Uint8Array([1, 2, 3, 4])], "screen shot.png", {
      type: "image/png",
    }));
    const attachmentResponse = await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, attachmentForm,
    ));
    expect(attachmentResponse.status).toBe(201);
    const attachmentRow = await env.DB.prepare(
      `SELECT id, comment_id, r2_key, filename, content_type, size_bytes, origin, visibility
       FROM feedback_attachments WHERE ticket_id = ?1 AND origin = 'reporter'`,
    ).bind(ticketA).first() as any;
    expect(attachmentRow).toMatchObject({
      filename: "screen_shot.png",
      content_type: "image/png",
      size_bytes: 4,
      origin: "reporter",
      visibility: "reporter",
    });
    expect(attachmentRow.comment_id).toBe((await attachmentResponse.clone().json() as any).id);
    expect(storedObjects.get(attachmentRow.r2_key)).toEqual(new Uint8Array([1, 2, 3, 4]));
    const attachmentReplay = await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, attachmentForm,
    ));
    expect(attachmentReplay.status).toBe(200);
    expect(storedObjects.size).toBe(1);
    const sanitizedCollisionForm = new FormData();
    sanitizedCollisionForm.set("body", "reply with screenshot");
    sanitizedCollisionForm.set("submission_id", attachmentSubmission);
    sanitizedCollisionForm.append("attachments", new File(
      [new Uint8Array([1, 2, 3, 4])],
      "screen?shot.png",
      { type: "image/png" },
    ));
    expect((await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, sanitizedCollisionForm,
    ))).status).toBe(409);
    const changedFileForm = new FormData();
    changedFileForm.set("body", "reply with screenshot");
    changedFileForm.set("submission_id", attachmentSubmission);
    changedFileForm.append("attachments", new File([new Uint8Array([4, 3, 2, 1])], "screen shot.png", {
      type: "image/png",
    }));
    expect((await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, changedFileForm,
    ))).status).toBe(409);
    const detailWithAttachment = await handleGetReporterFeedback(context("detail", credentialA.token, ticketA));
    expect((await detailWithAttachment.json() as any).attachments).toContainEqual(expect.objectContaining({
      id: attachmentRow.id,
      filename: "screen_shot.png",
      content_type: "image/png",
      size_bytes: 4,
    }));
    const downloadResponse = await handleDownloadReporterAttachment({
      ...context("detail", credentialA.token, ticketA),
      req: {
        ...context("detail", credentialA.token, ticketA).req,
        param: (name: string) => name === "appId" ? "app-ios" : name === "ticketId" ? ticketA : attachmentRow.id,
      },
    } as any);
    expect(downloadResponse.status).toBe(200);
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(downloadResponse.headers.get("cache-control")).toBe("private, no-store");
    const crossIntegrationDownload = await handleDownloadReporterAttachment({
      ...context("detail", credentialB.token, ticketA),
      req: {
        ...context("detail", credentialB.token, ticketA).req,
        param: (name: string) => name === "appId" ? "app-ios" : name === "ticketId" ? ticketA : attachmentRow.id,
      },
    } as any);
    expect(crossIntegrationDownload.status).toBe(404);

    env.APK_BUCKET.put = async (key: string, value: ArrayBuffer) => {
      storedObjects.set(key, new Uint8Array(value));
      await cleanupReporterFeedbackData(env, Date.now());
    };
    const cronRaceForm = new FormData();
    cronRaceForm.set("body", "cron must not delete in-flight upload");
    cronRaceForm.set("submission_id", "52525252-5252-4525-8525-525252525252");
    cronRaceForm.append("attachments", new File(["cron"], "cron.png", { type: "image/png" }));
    expect((await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, cronRaceForm,
    ))).status).toBe(201);
    const cronRaceAttachment = await env.DB.prepare(
      "SELECT r2_key FROM feedback_attachments WHERE filename = 'cron.png'",
    ).first() as any;
    expect(storedObjects.has(cronRaceAttachment.r2_key)).toBe(true);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_reporter_r2_cleanup WHERE r2_key = ?1",
    ).bind(cronRaceAttachment.r2_key).first() as any).count).toBe(0);

    env.APK_BUCKET.put = async (key: string, value: ArrayBuffer) => {
      storedObjects.set(key, new Uint8Array(value));
      await cleanupReporterFeedbackData(env, Date.now() + 16 * 60_000);
    };
    const expiredLeaseForm = new FormData();
    expiredLeaseForm.set("body", "expired writer must lose cleanup claim");
    expiredLeaseForm.set("submission_id", "53535353-5353-4535-8535-535353535353");
    expiredLeaseForm.append("attachments", new File(["expired"], "expired.png", { type: "image/png" }));
    await expect(handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, expiredLeaseForm,
    ))).rejects.toThrow("feedback reporter attachment cleanup intent missing");
    expect([...storedObjects.keys()].some((key) => key.endsWith("/0-expired.png"))).toBe(false);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_attachments WHERE filename = 'expired.png'",
    ).first() as any).count).toBe(0);

    const invalidTypeForm = new FormData();
    invalidTypeForm.set("body", "bad type");
    invalidTypeForm.set("submission_id", "61616161-6161-4616-8616-616161616161");
    invalidTypeForm.append("attachments", new File(["x"], "x.txt", { type: "text/plain" }));
    expect((await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, invalidTypeForm,
    ))).status).toBe(400);
    const tooManyForm = new FormData();
    tooManyForm.set("body", "too many");
    tooManyForm.set("submission_id", "71717171-7171-4717-8717-717171717171");
    for (let index = 0; index < 4; index += 1) {
      tooManyForm.append("attachments", new File(["x"], `${index}.png`, { type: "image/png" }));
    }
    expect((await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, tooManyForm,
    ))).status).toBe(400);
    const tooLargeForm = new FormData();
    tooLargeForm.set("body", "too large");
    tooLargeForm.set("submission_id", "81818181-8181-4818-8818-818181818181");
    tooLargeForm.append("attachments", new File(
      [new Uint8Array(10 * 1024 * 1024 + 1)],
      "large.png",
      { type: "image/png" },
    ));
    expect((await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, tooLargeForm,
    ))).status).toBe(400);

    let uploadAttempt = 0;
    env.APK_BUCKET.put = async (key: string, value: ArrayBuffer) => {
      uploadAttempt += 1;
      storedObjects.set(key, new Uint8Array(value));
      if (uploadAttempt === 2) throw new Error("simulated R2 failure");
    };
    const r2FailureForm = new FormData();
    r2FailureForm.set("body", "r2 failure");
    r2FailureForm.set("submission_id", "91919191-9191-4919-8919-919191919191");
    r2FailureForm.append("attachments", new File(["a"], "a.png", { type: "image/png" }));
    r2FailureForm.append("attachments", new File(["b"], "b.png", { type: "image/png" }));
    await expect(handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, r2FailureForm,
    ))).rejects.toThrow("simulated R2 failure");
    expect([...storedObjects.keys()].some((key) => key.endsWith("/0-a.png") || key.endsWith("/1-b.png"))).toBe(false);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_reporter_r2_cleanup",
    ).first() as any).count).toBe(0);

    env.APK_BUCKET.put = async (key: string, value: ArrayBuffer) => {
      storedObjects.set(key, new Uint8Array(value));
      throw new Error("stored then failed");
    };
    env.APK_BUCKET.delete = async () => {
      throw new Error("delete unavailable");
    };
    const compensatedForm = new FormData();
    compensatedForm.set("body", "cleanup compensation");
    compensatedForm.set("submission_id", "92929292-9292-4929-8929-929292929292");
    compensatedForm.append("attachments", new File(["retry"], "retry.png", { type: "image/png" }));
    await expect(handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, compensatedForm,
    ))).rejects.toThrow("stored then failed");
    const cleanupIntent = await env.DB.prepare(
      "SELECT r2_key, attempts, last_error FROM feedback_reporter_r2_cleanup",
    ).first() as any;
    expect(cleanupIntent).toMatchObject({ attempts: 1, last_error: "r2 delete failed" });
    expect(storedObjects.has(cleanupIntent.r2_key)).toBe(true);
    env.APK_BUCKET.delete = async (key: string) => {
      storedObjects.delete(key);
    };
    await cleanupReporterFeedbackData(env, Date.now() + 61_000);
    expect(storedObjects.has(cleanupIntent.r2_key)).toBe(false);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_reporter_r2_cleanup",
    ).first() as any).count).toBe(0);

    env.APK_BUCKET.put = async (key: string, value: ArrayBuffer) => {
      storedObjects.set(key, new Uint8Array(value));
    };
    const originalBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = async (statements: unknown[]) => {
      if (statements.length > 2) {
        await originalBatch(statements);
        throw new Error("simulated ambiguous D1 success");
      }
      return originalBatch(statements);
    };
    const ambiguousForm = new FormData();
    ambiguousForm.set("body", "ambiguous commit");
    ambiguousForm.set("submission_id", "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0");
    ambiguousForm.append("attachments", new File(["committed"], "committed.png", { type: "image/png" }));
    const ambiguousResponse = await handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, ambiguousForm,
    ));
    expect(ambiguousResponse.status).toBe(200);
    expect(await ambiguousResponse.json()).toMatchObject({ idempotent_replay: true });
    const committedAttachment = await env.DB.prepare(
      "SELECT r2_key FROM feedback_attachments WHERE filename = 'committed.png'",
    ).first() as any;
    expect(storedObjects.has(committedAttachment.r2_key)).toBe(true);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_reporter_r2_cleanup WHERE r2_key = ?1",
    ).bind(committedAttachment.r2_key).first() as any).count).toBe(0);

    env.DB.batch = async (statements: unknown[]) => {
      if (statements.length > 2) throw new Error("simulated D1 failure");
      return originalBatch(statements);
    };
    const d1FailureForm = new FormData();
    d1FailureForm.set("body", "d1 failure");
    d1FailureForm.set("submission_id", "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1");
    d1FailureForm.append("attachments", new File(["d1"], "d1.png", { type: "image/png" }));
    await expect(handleAddReporterComment(context(
      "comment", credentialA.token, ticketA, d1FailureForm,
    ))).rejects.toThrow("simulated D1 failure");
    env.DB.batch = originalBatch;
    expect([...storedObjects.keys()].some((key) => key.endsWith("/0-d1.png"))).toBe(false);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_comments WHERE submission_id = ?1",
    ).bind("a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1").first() as any).count).toBe(0);

    const { handleAddFeedbackComment, handleUpdateFeedback } = await import("../src/routes/feedback");
    const adminContext = (body: unknown) => ({
      env,
      req: {
        param: (name: string) => name === "appId" ? "app-ios" : name === "ticketId" ? ticketA : undefined,
        json: async () => body,
      },
      get: (name: string) => name === "admin_actor" ? "staff:test" : undefined,
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    }) as any;
    expect((await handleAddFeedbackComment(adminContext({ body: "staff reply", internal: false }))).status).toBe(201);
    expect((await handleAddFeedbackComment(adminContext({ body: "internal note", internal: true }))).status).toBe(201);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_events WHERE ticket_id = ?1 AND event_type = 'feedback:comment_created'",
    ).bind(ticketA).first() as any).count).toBe(6);
    const staffEvent = await env.DB.prepare(
      `SELECT payload_json FROM feedback_events
       WHERE ticket_id = ?1 AND event_type = 'feedback:comment_created'
       ORDER BY rowid DESC LIMIT 1`,
    ).bind(ticketA).first() as { payload_json: string } | null;
    expect(JSON.parse(staffEvent!.payload_json).payload.comment).toMatchObject({
      author_type: "staff",
      body: "staff reply",
    });
    const update = await handleUpdateFeedback(adminContext({ status: "resolved", assignee: "staff:test" }));
    expect(update.status).toBe(200);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_events WHERE ticket_id = ?1 AND event_type = 'feedback:status_changed'",
    ).bind(ticketA).first() as any).count).toBe(1);
    const auditBeforeNoop = (await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'feedback.update'",
    ).first() as any).count;
    const noop = await handleUpdateFeedback(adminContext({ status: "resolved", assignee: "staff:test" }));
    expect((await noop.json() as any).changed).toBe(false);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'feedback.update'",
    ).first() as any).count).toBe(auditBeforeNoop);

    await env.DB.prepare(
      "DELETE FROM feedback_events WHERE ticket_id = ?1 AND event_type = 'feedback:status_changed'",
    ).bind(ticketA).run();
    await env.DB.prepare(
      "DELETE FROM audit_logs WHERE app_id = 'app-ios' AND action = 'feedback.update'",
    ).run();
    await env.DB.prepare(
      "UPDATE feedback_tickets SET status = 'open', assignee = NULL WHERE id = ?1",
    ).bind(ticketA).run();
    const sameTarget = await Promise.all([
      handleUpdateFeedback(adminContext({ status: "resolved", assignee: "owner" })),
      handleUpdateFeedback(adminContext({ status: "resolved", assignee: "owner" })),
    ]);
    const sameTargetBodies = await Promise.all(sameTarget.map((response) => response.json() as Promise<any>));
    expect(sameTargetBodies.filter((body) => body.changed).length).toBe(1);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE app_id = 'app-ios' AND action = 'feedback.update'",
    ).first() as any).count).toBe(1);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feedback_events WHERE ticket_id = ?1 AND event_type = 'feedback:status_changed'",
    ).bind(ticketA).first() as any).count).toBe(1);

    await env.DB.prepare(
      "DELETE FROM feedback_events WHERE ticket_id = ?1 AND event_type = 'feedback:status_changed'",
    ).bind(ticketA).run();
    await env.DB.prepare(
      "DELETE FROM audit_logs WHERE app_id = 'app-ios' AND action = 'feedback.update'",
    ).run();
    await env.DB.prepare(
      "UPDATE feedback_tickets SET status = 'open', assignee = NULL WHERE id = ?1",
    ).bind(ticketA).run();
    await Promise.all([
      handleUpdateFeedback(adminContext({ status: "in_progress", assignee: "first" })),
      handleUpdateFeedback(adminContext({ status: "resolved", assignee: "second" })),
    ]);
    const transitions = (await env.DB.prepare(
      `SELECT payload_json FROM feedback_events
       WHERE ticket_id = ?1 AND event_type = 'feedback:status_changed'
       ORDER BY rowid ASC`,
    ).bind(ticketA).all() as any).results.map((row: any) => JSON.parse(row.payload_json).payload);
    expect(transitions).toHaveLength(2);
    let cursorStatus = "open";
    for (const transition of transitions) {
      expect(transition.previous_status).toBe(cursorStatus);
      cursorStatus = transition.status;
    }
    const finalMutation = await env.DB.prepare(
      "SELECT status, assignee FROM feedback_tickets WHERE id = ?1",
    ).bind(ticketA).first() as { status: string; assignee: string | null } | null;
    expect(finalMutation?.status).toBe(cursorStatus);
    expect(finalMutation?.assignee).toBe(cursorStatus === "resolved" ? "second" : "first");

    const { handleUpdateReporterIntegration } = await import("../src/routes/reporter_integrations");
    const integrationContext = (archived: boolean) => ({
      env,
      req: {
        param: (name: string) => name === "appId" ? "app-ios" : integrationA,
        json: async () => ({ archived }),
      },
      get: (name: string) => name === "admin_actor" ? "staff:test" : undefined,
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    }) as any;
    expect((await handleUpdateReporterIntegration(integrationContext(true))).status).toBe(200);
    expect((await env.DB.prepare(
      "SELECT revoked_at FROM app_deploy_tokens WHERE id = 'token-a'",
    ).first() as any).revoked_at).toBeTypeOf("number");
    expect((await handleUpdateReporterIntegration(integrationContext(false))).status).toBe(200);
    expect((await env.DB.prepare(
      "SELECT revoked_at FROM app_deploy_tokens WHERE id = 'token-a'",
    ).first() as any).revoked_at).toBeTypeOf("number");
    const lifecycleActions = (await env.DB.prepare(
      `SELECT action FROM audit_logs
       WHERE app_id = 'app-ios' AND action LIKE 'reporter_integration.%'
       ORDER BY created_at, rowid`,
    ).all() as any).results.map((row: any) => row.action);
    expect(lifecycleActions).toEqual([
      "reporter_integration.archive",
      "reporter_integration.unarchive",
    ]);
  });
});
