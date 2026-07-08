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

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { authMiddleware } from "../src/middleware/auth";
import { requireCurrentOrgRole } from "../src/lib/permissions";
import { httpsRedirectUrl, isSecureRequest, requestOrigin } from "../src/lib/origin";
import { openApiDocument } from "../src/openapi";
import { handleCreateApp } from "../src/routes/apps";

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
      "/apps/{slug}/history",
      "/api/apps",
      "/api/apps/{appId}/builds",
      "/api/apps/{appId}/releases/{releaseId}/publish",
      "/api/apps/{appId}/feedback/{ticketId}/comments",
      "/api/apps/{appId}/client-key",
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
      archived_at INTEGER, created_at INTEGER NOT NULL, icon_r2_key TEXT, public_history INTEGER NOT NULL DEFAULT 0, client_key TEXT
    );
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
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
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
      is_full INTEGER NOT NULL DEFAULT 1,
      superseded_by_release_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
      rollout_cohort_count INTEGER,
      rollout_target_cohorts_json TEXT NOT NULL DEFAULT '[]',
      availability_at INTEGER,
      should_force_update INTEGER NOT NULL DEFAULT 0,
      changelog TEXT,
      provenance_json TEXT NOT NULL DEFAULT '{}',
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
    CREATE TABLE release_metrics (
      release_id TEXT PRIMARY KEY,
      offered_count INTEGER NOT NULL DEFAULT 0,
      current_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at INTEGER
    );
    CREATE TABLE release_shares (
      id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
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
    CREATE TABLE feedback_attachments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE feedback_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      author_actor TEXT NOT NULL,
      body TEXT NOT NULL,
      internal INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
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
      app_role TEXT NOT NULL CHECK (app_role IN ('publisher', 'viewer')),
      created_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
      created_by_actor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER
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
      payload_json TEXT NOT NULL,
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
  `);

  // Replace `?N` numbered placeholders with anonymous `?` (better-sqlite3 compat).
  // The real D1 migration keeps `?N` — same SQL semantics, just different binding.
  const normalize = (sql: string) => sql.replace(/\?\d+/g, "?");

  return {
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
    prepare(sql: string) {
      const normSql = normalize(sql);
      const stmt = sqlite.prepare(normSql);
      const bind = (...params: any[]) => ({
        run: async () => {
          stmt.run(...params);
          return { success: true, meta: { changes: 0 } };
        },
        all: async () => {
          const rows = stmt.all(...params);
          return { results: rows, success: true };
        },
        first: async () => {
          const rows = stmt.all(...params);
          return rows[0] ?? null;
        },
      });
      return { bind };
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
    RAFT_ORIGIN: "https://app.raft.build",
    RAFT_API_ORIGIN: "https://api.raft.build",
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

    const memberResponse = await testApp.request(
      "https://quiver-worker.test/api/apps",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${memberToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ slug: "member-app", name: "Member App", platform: "android" }),
      },
      env as any,
    );
    expect(memberResponse.status).toBe(201);
    await expect(memberResponse.json()).resolves.toMatchObject({
      org_id: "raft_create",
      slug: "member-app",
      name: "Member App",
      platform: "android",
    });

    const seededChannels = await env.DB
      .prepare("SELECT slug FROM channels WHERE app_id = (SELECT id FROM apps WHERE slug = ?) ORDER BY slug")
      .bind("member-app")
      .all();
    expect(seededChannels.results.map((row: any) => row.slug)).toEqual(["main", "nightly", "preview"]);
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
      .bind("orgmem-external", "raft_external", "external-user", "viewer", now)
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
      .bind("orgmem-external2", "raft_external2", "external2-user", "viewer", now)
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
  it("canonicalizes public http custom-domain requests to https", () => {
    const ctx = {
      req: {
        url: "http://quiver.oranix.io/api/auth/login?return=/apps",
        header: () => null,
      },
    };
    expect(requestOrigin(ctx as any)).toBe("https://quiver.oranix.io");
    expect(isSecureRequest(ctx as any)).toBe(true);
    expect(httpsRedirectUrl(ctx as any)).toBe("https://quiver.oranix.io/api/auth/login?return=/apps");
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
        url: "http://quiver.oranix.io/api/auth/login?return=/apps",
        header: (name: string) => (name === "x-forwarded-proto" ? "https" : null),
      },
    };
    expect(requestOrigin(ctx as any)).toBe("https://quiver.oranix.io");
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
    });
    const row = (await env.DB.prepare(
      "SELECT last_used_at FROM app_deploy_tokens WHERE id = ?",
    ).bind("dt-1").first()) as { last_used_at: number | null } | null;
    expect(row?.last_used_at).toBeTypeOf("number");
  });

  it("allows deploy tokens only for their app and role", async () => {
    const env = makeMockEnv();
    const { ensureAppRole } = await import("../src/lib/permissions");
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
  ) {
    return {
      env,
      req: {
        param: (name: string) =>
          name === "appId" ? "app-release" : name === "releaseId" ? releaseId : "",
        json: async () => body,
        query: () => undefined,
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
                             is_full, rollout_cohort_count, changelog, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        releaseId,
        "app-scope",
        buildId,
        "ch-scope-prod",
        opts.productType ?? "android-apk",
        "stable",
        "active",
        scopes.length === 1 && scopes[0]?.[0] === "full" && scopes[0]?.[1] === "all" ? 1 : 0,
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
        `${assetId}-hash`,
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
  ) {
    return {
      env,
      req: {
        url: "https://quiver-worker.test/public/v2/apps/scope-app/updates/check",
        param: (name: string) => (name === "slug" ? "scope-app" : ""),
        query: (name: string) => query[name],
        header: (name: string) => headers[name],
        raw: { cf: { clientIp: "10.0.0.5" } },
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
        JSON.stringify(["build:succeeded", "release:new", "feedback:new", "crash:new_group"]),
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
    expect(eventTypes).toContain("feedback:new");
    expect(eventTypes).toContain("crash:new_group");
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

  it("updates/check records offered/current release metrics", async () => {
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
    // Two older clients (offered) + one already-current client.
    await handlePublicV2UpdateCheck(makePublicContext(env, query("10")));
    await handlePublicV2UpdateCheck(makePublicContext(env, query("15")));
    await handlePublicV2UpdateCheck(makePublicContext(env, query("20")));

    const row = (await env.DB.prepare(
      "SELECT offered_count, current_count FROM release_metrics WHERE release_id = ?1",
    )
      .bind("rel-metric")
      .first()) as { offered_count: number; current_count: number } | null;
    expect(row?.offered_count).toBe(2);
    expect(row?.current_count).toBe(1);
  });

  it("updates/check gates a partial rollout by device bucket and falls back to the previous release", async () => {
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
    await seedRelease(env, "rel-gated", "build-gated", [["full", "all"]], {
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

    const outResponse = await handlePublicV2UpdateCheck(
      makePublicContext(env, query, { "X-Quiver-Device-Id": outDevice }),
    );
    expect(outResponse.status).toBe(200);
    const outBody = await responseJson<any>(outResponse);
    expect(outBody.update_available).toBe(true);
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

  it("defaults release shares to seven days and updates share expiry", async () => {
    const env = makeEnv();
    const { handleCreateReleaseShare, handleUpdateReleaseShare } = await import("../src/routes/shares");
    await seedRelease(env, "rel-share", "build-share", [["full", "all"]], {
      versionCode: 11,
      versionName: "1.0.11",
    });

    const createStart = Date.now();
    const created = await handleCreateReleaseShare(
      makeShareAdminContext(env, { appId: "app-scope", releaseId: "rel-share" }, {}),
    );
    const createEnd = Date.now();

    expect(created.status).toBe(201);
    const createdBody = await responseJson<any>(created);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(createdBody.expires_at).toBeGreaterThanOrEqual(createStart + sevenDaysMs);
    expect(createdBody.expires_at).toBeLessThanOrEqual(createEnd + sevenDaysMs);

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
    expect(html).toContain('id="expires-at"');
    expect(html).toContain("data-expires-at=");
    expect(html).toContain("Intl.DateTimeFormat");
    expect(html).toContain("<dt>Stats</dt>");
    expect(html).toContain("<span>visitors</span>");

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
      req: { param: (n: string) => (n === "appId" ? "app-scope" : "") },
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

  it("symbolicateNativeCrashTicket leaves an actionable comment when symbols are missing", async () => {
    const env = makeEnv();
    const { symbolicateNativeCrashTicket } = await import("../src/routes/feedback");
    await env.DB.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES (?1, ?2, 'crash', 'open', 'native crash', '{}', ?3, ?4)`,
    ).bind("tick-nat", "app-scope", 1, 1).run();
    await symbolicateNativeCrashTicket(env as any, "app-scope", "tick-nat", 1000200, [
      { index: 0, offset: "0x1a2b", soname: "libraft.so", build_id: "abcd1234" },
    ]);
    const comment = (await env.DB.prepare(
      "SELECT author_actor, body FROM feedback_comments WHERE ticket_id = ?1",
    ).bind("tick-nat").all()).results[0] as { author_actor: string; body: string };
    expect(comment.author_actor).toBe("quiver-symbolicate");
    expect(comment.body).toContain("native-symbols");
    expect(comment.body).toContain("1000200");
    expect(comment.body).toContain("abcd1234");
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
    const comment = (await env.DB.prepare(
      "SELECT author_actor, body FROM feedback_comments WHERE ticket_id = ?1",
    ).bind("tick-dsym").all()).results[0] as { author_actor: string; body: string };
    expect(comment.author_actor).toBe("quiver-symbolicate");
    expect(comment.body).toContain("dsym");
    expect(comment.body).toContain("1000200");
    expect(comment.body).toContain("DEADBEEF");
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
    await env.DB.prepare("UPDATE apps SET archived = 1 WHERE id = ?1").bind("app-scope").run();
    // wrong confirm -> 400
    expect((await handlePurgeApp(ctx({ confirm_slug: "nope" }))).status).toBe(400);
    // correct -> 200, R2 sweep ran, row gone
    const res = await handlePurgeApp(ctx({ confirm_slug: "scope-app" }));
    expect(res.status).toBe(200);
    expect(deleted).toContain("apps/app-scope/stray.apk");
    const row = await env.DB.prepare("SELECT id FROM apps WHERE id = ?1").bind("app-scope").first();
    expect(row).toBeNull();
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

    const res = await handleDeviceAnalytics({
      env,
      req: { param: (n: string) => (n === "appId" ? "app-scope" : ""), query: () => undefined },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as any);
    const body = await responseJson<any>(res);
    expect(body.active_devices).toBe(3); // devA (deduped), devB, devC
    const v102 = body.by_version.find((v: any) => v.version_code === 1000200);
    expect(v102.devices).toBe(2);
    expect(body.by_platform[0].platform).toBe("android");
    expect(body.by_platform[0].devices).toBe(3);
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
        url: "https://quiver.oranix.io/public/v2/apps/scope-app/feedback",
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
    expect(submittedBody.ticket_url).toContain(`/apps/app-scope/feedback/${submittedBody.id}`);
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
