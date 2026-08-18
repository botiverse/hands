import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installerAuthMiddleware,
  pkceChallenge,
  sha256Hex,
  type InstallerVariables,
} from "../src/lib/installer_auth";
import { handleInstallerToken } from "../src/routes/installer_auth";
import { authMiddleware } from "../src/middleware/auth";
import {
  handleInstallerCatalog,
  handleInstallerManifest,
  handlePutInstallerSubscription,
} from "../src/routes/installer";
import { autoParseInstallableAsset } from "../src/routes/builds";

vi.mock("@cloudflare/containers", () => ({
  getRandom: async () => ({
    fetch: async () => Response.json({
      parser_kind: "apk-aapt",
      platform: "android",
      arch: null,
      version: "1.2.3",
      version_code: 10203,
      package_id: "dev.hands.app",
      app_label: "App One",
      size_bytes: 0,
      file_hash_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      raw: {
        signer_lineages: [[
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ]],
      },
    }),
  }),
}));

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => {
      indexes.push(Number(index));
      return "?";
    }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      const runSync = () => {
        const info = statement.run(...expanded);
        return { success: true, meta: { changes: info.changes } };
      };
      const allSync = () => statement.reader
        ? { success: true, results: statement.all(...expanded) }
        : runSync();
      return {
        _batchSync: allSync,
        run: async () => runSync(),
        all: async () => ({ success: true, results: statement.all(...expanded) }),
        first: async (column?: string) => {
          const row = statement.get(...expanded) as Record<string, unknown> | undefined;
          return column ? row?.[column] ?? null : row ?? null;
        },
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  return {
    prepare,
    batch: async (statements: Array<{ _batchSync: () => unknown }>) =>
      sqlite.transaction(() => statements.map((statement) => statement._batchSync()))(),
  } as unknown as D1Database;
}

function database() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  }
  return sqlite;
}

function envFor(sqlite: Database.Database): Env {
  return {
    DB: d1(sqlite),
    ENVIRONMENT: "development",
    ADMIN_API_TOKEN: "admin-token",
    RAFT_CLIENT_ID: "hands-test",
    RAFT_CLIENT_SECRET: "raft-secret",
    RAFT_ORIGIN: "https://raft.test",
    RAFT_API_ORIGIN: "https://raft-api.test",
    BUSINESS_ORIGIN: "https://hands.test",
    DASHBOARD_ORIGIN: "https://app.hands.test",
    SIGNED_URL_SECRET: "signed-secret",
    SIGNED_URL_TTL_SECONDS: "3600",
  } as unknown as Env;
}

const context = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

async function fetchWorker(env: Env, path: string, init?: RequestInit) {
  const app = new Hono<{ Bindings: Env; Variables: InstallerVariables }>();
  app.post("/api/installer/v1/auth/token", handleInstallerToken);
  app.use("/api/installer/v1/*", installerAuthMiddleware);
  app.get("/api/installer/v1/catalog", handleInstallerCatalog);
  app.put("/api/installer/v1/subscriptions/:appId/:channel", handlePutInstallerSubscription);
  app.get("/api/installer/v1/apps/:appId/channels/:channel/manifest", handleInstallerManifest);
  return app.fetch(new Request(`https://hands.test${path}`, init), env, context);
}

async function issueConsumerSession(sqlite: Database.Database, env: Env) {
  const verifier = "a".repeat(43);
  const code = "authorization-code";
  const challenge = await pkceChallenge(verifier);
  sqlite.exec(`
    INSERT INTO raft_accounts
      (id, provider_subject, server_id, principal_type, display_name, raw_profile,
       created_at, updated_at, last_login_at)
    VALUES ('account-1', 'human-1', 'server-1', 'human', 'Human', '{}', 1, 1, 1);
  `);
  sqlite.prepare(`
    INSERT INTO installer_login_codes
      (id, code_hash, account_id, client_id, redirect_uri, state, code_challenge,
       code_challenge_method, created_at, expires_at)
    VALUES ('code-1', ?, 'account-1', 'hands-installer',
            'hands-installer://auth/callback', 'state-1234567890', ?, 'S256', 1, ?)
  `).run(await sha256Hex(code), challenge, Date.now() + 60_000);
  const response = await fetchWorker(env, "/api/installer/v1/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: "hands-installer",
      redirect_uri: "hands-installer://auth/callback",
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ access_token: string; refresh_token: string }>;
}

function seedOffer(sqlite: Database.Database, overrides: { optedIn?: boolean; releaseType?: string } = {}) {
  const optedIn = overrides.optedIn ?? true;
  const releaseType = overrides.releaseType ?? "stable";
  sqlite.exec(`
    INSERT INTO apps
      (id, slug, name, platform, created_at, public_history, installer_catalog_public,
       installer_package_id, installer_publisher_name)
    VALUES ('app-1', 'app-one', 'App One', 'android', 1, 1, ${optedIn ? 1 : 0},
            'dev.hands.app', 'Hands');
    INSERT INTO channels (id, app_id, slug, name, created_at)
    VALUES ('channel-1', 'app-1', 'main', 'Main', 1);
    INSERT INTO builds
      (id, app_id, channel_id, product_type, release_type, version_name,
       version_code, source, status, created_at, updated_at)
    VALUES ('build-1', 'app-1', 'channel-1', 'android-apk', '${releaseType}',
            '1.2.3', 10203, 'ci', 'succeeded', 1, 1);
    INSERT INTO releases
      (id, app_id, build_id, channel_id, product_type, release_type, status,
       created_by, created_at, updated_at, activated_at)
    VALUES ('release-1', 'app-1', 'build-1', 'channel-1', 'android-apk',
            '${releaseType}', 'active', 'test', 1, 1, 1);
    INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
    VALUES ('scope-1', 'release-1', 'full', 'all', 1);
    INSERT INTO build_assets
      (id, build_id, platform, filetype, r2_key, file_hash, size_bytes,
       created_at, artifact_kind)
    VALUES ('asset-1', 'build-1', 'android', 'apk', 'artifact.apk',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            10, 1, 'installable');
  `);
  if (optedIn) sqlite.exec(`
    INSERT INTO installer_asset_metadata
      (asset_id, platform, filetype, package_id, version_code, signer_lineages_json,
       inspected_file_hash, inspector_version, inspected_at)
    VALUES ('asset-1', 'android', 'apk', 'dev.hands.app', 10203,
            '[["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
               "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]]',
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'inspector-v1', 2);
  `);
}

describe("Hands Installer routes", () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = database();
    env = envFor(sqlite);
  });

  it("exchanges a PKCE code once and rejects dashboard/admin tokens", async () => {
    const verifier = "a".repeat(43);
    const challenge = await pkceChallenge(verifier);
    sqlite.exec(`
      INSERT INTO raft_accounts
        (id, provider_subject, server_id, principal_type, display_name, raw_profile,
         created_at, updated_at, last_login_at)
      VALUES ('account-1', 'human-1', 'server-1', 'human', 'Human', '{}', 1, 1, 1);
    `);
    sqlite.prepare(`
      INSERT INTO installer_login_codes
        (id, code_hash, account_id, client_id, redirect_uri, state, code_challenge,
         code_challenge_method, created_at, expires_at)
      VALUES ('code-1', ?, 'account-1', 'hands-installer',
              'hands-installer://auth/callback', 'state-1234567890', ?, 'S256', 1, ?)
    `).run(await sha256Hex("authorization-code"), challenge, Date.now() + 60_000);
    const wrongVerifier = await fetchWorker(env, "/api/installer/v1/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code", code: "authorization-code",
        code_verifier: "b".repeat(43), client_id: "hands-installer",
        redirect_uri: "hands-installer://auth/callback",
      }),
    });
    expect(wrongVerifier.status).toBe(400);
    const correct = await fetchWorker(env, "/api/installer/v1/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code", code: "authorization-code",
        code_verifier: verifier, client_id: "hands-installer",
        redirect_uri: "hands-installer://auth/callback",
      }),
    });
    const session = await correct.json() as { access_token: string };
    const replay = await fetchWorker(env, "/api/installer/v1/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: "authorization-code",
        code_verifier: "a".repeat(43),
        client_id: "hands-installer",
        redirect_uri: "hands-installer://auth/callback",
      }),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "invalid_grant" });

    const consumer = await fetchWorker(env, "/api/installer/v1/catalog", {
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    expect(consumer.status).toBe(200);
    const admin = await fetchWorker(env, "/api/installer/v1/catalog", {
      headers: { authorization: "Bearer admin-token" },
    });
    expect(admin.status).toBe(401);

    const adminApp = new Hono<{ Bindings: Env }>();
    adminApp.use("/api/apps/*", authMiddleware as never);
    adminApp.get("/api/apps/private", (c) => c.json({ ok: true }));
    const cannotEscalate = await adminApp.fetch(new Request("https://hands.test/api/apps/private", {
      headers: { authorization: `Bearer ${session.access_token}` },
    }), env, context);
    expect(cannotEscalate.status).toBe(401);
  });

  it("uses one active/non-QA rollout resolver for catalog and manifest", async () => {
    const session = await issueConsumerSession(sqlite, env);
    seedOffer(sqlite);
    const headers = { authorization: `Bearer ${session.access_token}` };
    const catalog = await fetchWorker(env, "/api/installer/v1/catalog", { headers });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      schema: "hands-installer-catalog.v1",
      apps: [{ id: "app-1", channels: [{ name: "main", latest_version: "1.2.3" }] }],
    });
    const manifest = await fetchWorker(
      env, "/api/installer/v1/apps/app-1/channels/main/manifest", { headers },
    );
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({
      schema: "hands-installer-manifest.v1",
      release: { id: "release-1", version: "1.2.3", version_code: 10203 },
      asset: {
        id: "asset-1",
        platform: "android",
        filetype: "apk",
        signer_lineages: [[
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ]],
      },
    });
  });

  it("persists verified APK inspection against the exact asset before catalog opt-in", async () => {
    sqlite.exec(`
      INSERT INTO apps (id, slug, name, platform, created_at)
      VALUES ('app-1', 'app-one', 'App One', 'android', 1);
      INSERT INTO channels (id, app_id, slug, name, created_at)
      VALUES ('channel-1', 'app-1', 'main', 'Main', 1);
      INSERT INTO builds
        (id, app_id, channel_id, product_type, release_type, version_name,
         version_code, source, status, created_at, updated_at)
      VALUES ('build-1', 'app-1', 'channel-1', 'android-apk', 'stable',
              '1.2.3', 10203, 'ci', 'succeeded', 1, 1);
      INSERT INTO build_assets
        (id, build_id, platform, filetype, r2_key, file_hash, size_bytes,
         created_at, artifact_kind)
      VALUES ('asset-1', 'build-1', 'android', 'apk', 'artifact.apk',
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
              0, 1, 'installable');
    `);
    env.APK_BUCKET = {
      get: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    } as unknown as R2Bucket;
    env.APK_PARSER = {} as never;
    await autoParseInstallableAsset(env, "app-1", "build-1", "artifact.apk", "apk-aapt");
    const row = sqlite.prepare(
      `SELECT package_id, version_code, signer_lineages_json, inspected_file_hash,
              inspector_version
       FROM installer_asset_metadata WHERE asset_id='asset-1'`,
    ).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      package_id: "dev.hands.app",
      version_code: 10203,
      inspected_file_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      inspector_version: "android-apksig-34.0.0-v1",
    });
    expect(JSON.parse(row.signer_lineages_json as string)).toEqual([[
      "b".repeat(64), "c".repeat(64),
    ]]);
    expect(sqlite.prepare(
      "SELECT installer_catalog_public FROM apps WHERE id='app-1'",
    ).pluck().get()).toBe(0);
  });

  it("does not offer or sign an asset whose stored signer lineages fail closed validation", async () => {
    const session = await issueConsumerSession(sqlite, env);
    seedOffer(sqlite);
    sqlite.exec(`
      DROP TRIGGER installer_asset_metadata_lineages_update_guard;
      PRAGMA ignore_check_constraints = ON;
      UPDATE installer_asset_metadata
      SET signer_lineages_json='[["not-a-fingerprint"]]'
      WHERE asset_id='asset-1';
    `);
    const response = await fetchWorker(
      env,
      "/api/installer/v1/apps/app-1/channels/main/manifest",
      { headers: { authorization: `Bearer ${session.access_token}` } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "app not found", code: "app_not_found" });
  });

  it("does not ingest parser metadata when the inspected bytes mismatch the asset hash", async () => {
    sqlite.exec(`
      INSERT INTO apps (id, slug, name, platform, created_at)
      VALUES ('app-1', 'app-one', 'App One', 'android', 1);
      INSERT INTO channels (id, app_id, slug, name, created_at)
      VALUES ('channel-1', 'app-1', 'main', 'Main', 1);
      INSERT INTO builds
        (id, app_id, channel_id, product_type, release_type, version_name,
         version_code, source, status, created_at, updated_at)
      VALUES ('build-1', 'app-1', 'channel-1', 'android-apk', 'stable',
              '1.2.3', 10203, 'ci', 'succeeded', 1, 1);
      INSERT INTO build_assets
        (id, build_id, platform, filetype, r2_key, file_hash, size_bytes,
         created_at, artifact_kind)
      VALUES ('asset-1', 'build-1', 'android', 'apk', 'artifact.apk',
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              0, 1, 'installable');
    `);
    env.APK_BUCKET = {
      get: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    } as unknown as R2Bucket;
    env.APK_PARSER = {} as never;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await autoParseInstallableAsset(env, "app-1", "build-1", "artifact.apk", "apk-aapt");
    error.mockRestore();
    expect(sqlite.prepare("SELECT count(*) FROM installer_asset_metadata").pluck().get()).toBe(0);
    expect(sqlite.prepare(
      "SELECT parsed_metadata_json FROM builds WHERE id='build-1'",
    ).pluck().get()).toBe("{}");
  });

  it("does not enumerate non-opted-in apps or QA releases", async () => {
    const session = await issueConsumerSession(sqlite, env);
    seedOffer(sqlite, { optedIn: false });
    const headers = { authorization: `Bearer ${session.access_token}` };
    const catalog = await fetchWorker(env, "/api/installer/v1/catalog", { headers });
    expect(await catalog.json()).toMatchObject({ apps: [] });
    const manifest = await fetchWorker(
      env, "/api/installer/v1/apps/app-1/channels/main/manifest", { headers },
    );
    expect(manifest.status).toBe(404);
    expect(await manifest.json()).toEqual({ error: "app not found", code: "app_not_found" });
  });

  it("excludes an opted-in app when its only active build is QA", async () => {
    const session = await issueConsumerSession(sqlite, env);
    seedOffer(sqlite, { releaseType: "qa" });
    const headers = { authorization: `Bearer ${session.access_token}` };
    const catalog = await fetchWorker(env, "/api/installer/v1/catalog", { headers });
    expect(await catalog.json()).toMatchObject({ apps: [] });
    const manifest = await fetchWorker(
      env, "/api/installer/v1/apps/app-1/channels/main/manifest", { headers },
    );
    expect(manifest.status).toBe(404);
  });

  it("uses optimistic subscription revisions with exactly one stale loser", async () => {
    const session = await issueConsumerSession(sqlite, env);
    seedOffer(sqlite);
    const headers = {
      authorization: `Bearer ${session.access_token}`,
      "content-type": "application/json",
    };
    const create = await fetchWorker(env, "/api/installer/v1/subscriptions/app-1/main", {
      method: "PUT", headers, body: JSON.stringify({ auto_download: false, expected_revision: null }),
    });
    expect(create.status).toBe(200);
    expect(await create.json()).toMatchObject({ subscriptions: [{ revision: 1 }] });
    const update = await fetchWorker(env, "/api/installer/v1/subscriptions/app-1/main", {
      method: "PUT", headers, body: JSON.stringify({ auto_download: true, expected_revision: 1 }),
    });
    expect(update.status).toBe(200);
    const stale = await fetchWorker(env, "/api/installer/v1/subscriptions/app-1/main", {
      method: "PUT", headers, body: JSON.stringify({ auto_download: false, expected_revision: 1 }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "subscription_conflict" });
  });

  it("revokes the whole family when an already-rotated refresh token is reused", async () => {
    const session = await issueConsumerSession(sqlite, env);
    const refresh = async () => fetchWorker(env, "/api/installer/v1/auth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: session.refresh_token,
        client_id: "hands-installer",
      }),
    });
    const attempts = await Promise.all([refresh(), refresh()]);
    const first = attempts.find((response) => response.status === 200);
    const reused = attempts.find((response) => response.status === 400);
    expect(first).toBeDefined();
    expect(reused).toBeDefined();
    const firstTokens = await first!.json() as { access_token: string };
    expect(await reused!.json()).toMatchObject({ code: "invalid_grant" });
    const afterRevoke = await fetchWorker(env, "/api/installer/v1/catalog", {
      headers: { authorization: `Bearer ${firstTokens.access_token}` },
    });
    expect(afterRevoke.status).toBe(401);
  });
});
