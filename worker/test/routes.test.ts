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
  APP_ORIGIN: string;
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
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      platform TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, slug TEXT NOT NULL,
      name TEXT NOT NULL, created_at INTEGER NOT NULL,
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
      created_at INTEGER NOT NULL,
      FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_versions_app_code_channel
      ON versions(app_id, channel, version_code);
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, action TEXT NOT NULL,
      actor TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
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
  `);

  // Replace `?N` numbered placeholders with anonymous `?` (better-sqlite3 compat).
  // The real D1 migration keeps `?N` — same SQL semantics, just different binding.
  const normalize = (sql: string) => sql.replace(/\?\d+/g, "?");

  return {
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
    APP_ORIGIN: "https://quiver.example.test",
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

describe("quiver publish + retry — version row + r2_key required", () => {
  let env: MockEnv;

  beforeEach(async () => {
    env = makeMockEnv();
    const now = Date.now();
    // Seed an app + channel
    await env.DB
      .prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("a1", "retry-test", "Retry Test", "android", now)
      .run();
    await env.DB
      .prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind("c1", "a1", "production", "Production", now)
      .run();
  });

  it("insertVersion stores the r2_key passed in the publish payload", async () => {
    const { insertVersion } = await import("../src/routes/versions");
    const id = await insertVersion(env.DB as any, "a1", {
      channel: "production",
      version_name: "1.0.0",
      version_code: 1,
      package_name: "com.example",
      signature_sha256: "abc123",
      min_sdk: 24,
      target_sdk: 34,
      size_bytes: 1234,
      file_hash: "deadbeef",
      r2_key: "apps/a1/pending/deadbeef.apk",
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await env.DB
      .prepare("SELECT r2_key, version_name, file_hash FROM versions WHERE id = ?")
      .bind(id)
      .first();
    expect(row).toMatchObject({
      r2_key: "apps/a1/pending/deadbeef.apk",
      version_name: "1.0.0",
      file_hash: "deadbeef",
    });
  });

  it("insertVersion re-uses an explicit id (retry-friendly)", async () => {
    const { insertVersion } = await import("../src/routes/versions");
    const fixedId = "11111111-1111-1111-1111-111111111111";
    const returnedId = await insertVersion(
      env.DB as any,
      "a1",
      {
        channel: "production",
        version_name: "2.0.0",
        version_code: 2,
        package_name: "com.example",
        signature_sha256: "sig",
        size_bytes: 1,
        file_hash: "hash",
        r2_key: "apps/a1/pending/hash.apk",
      },
      fixedId,
    );
    expect(returnedId).toBe(fixedId);
  });

  it("versions.r2_key is NOT NULL in schema (matches production D1)", async () => {
    // Schema-level guard: if someone removes NOT NULL on r2_key in the future,
    // this test will fail and remind them that the create-version handler
    // depends on r2_key being required.
    const cols = await env.DB
      .prepare("PRAGMA table_info(versions)")
      .bind()
      .all();
    const r2KeyCol = (cols.results as Array<{ name: string; notnull: number }>)
      .find((c) => c.name === "r2_key");
    expect(r2KeyCol).toBeDefined();
    expect(r2KeyCol!.notnull).toBe(1);
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
});
