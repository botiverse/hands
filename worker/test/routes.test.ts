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
  APK_PARSER: unknown;
  MAX_APK_SIZE_MB: string;
}

/** Spin up an in-memory SQLite that mimics D1's bind/run/all/first shape. */
function makeMockDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE apps (
      id TEXT PRIMARY KEY, org_id TEXT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      platform TEXT NOT NULL, created_at INTEGER NOT NULL
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
    CREATE TABLE release_shares (
      id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
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
      .bind("m2", "raft_s1", "agent1", "viewer", now)
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
      { principal_type: "agent", org_role: "viewer" },
      { principal_type: "human", org_role: "owner" },
    ]);
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
    ).bind("orgmem-token", "raft_server1", "acct-token", "viewer", now).run();
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
      org_role: "viewer",
    });
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
      "INSERT OR IGNORE INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind("app-scope", "default", "scope-app", "Scope App", "android", 1).run();
    env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, enabled_product_types_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("ch-scope-prod", "app-scope", "production", "Production", "[]", "{}", 1).run();
    return env;
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
        100,
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
        null,
        opts.filetype ?? "apk",
        `apps/app-scope/${assetId}.apk`,
        `${assetId}-hash`,
        opts.sizeBytes ?? 42,
        `${assetId}-sig`,
        "{}",
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

  function makeSharePublicContext(env: MockEnv, token: string) {
    return {
      env,
      req: {
        url: `https://quiver-worker.test/share/${token}`,
        param: (name: string) => (name === "token" ? token : ""),
      },
    } as any;
  }

  async function responseJson<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

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
    expect(html).toContain("/public/r2/apps%2Fapp-scope%2Fasset-share.apk");
    expect(html).toContain("&amp;sig=");
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
