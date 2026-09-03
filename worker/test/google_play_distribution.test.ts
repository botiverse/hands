import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  normalizeAndroidReleaseArtifactInput,
  handleCompleteAndroidReleaseArtifact,
  handleCreateAndroidReleaseArtifacts,
  handleGetAndroidReleaseArtifacts,
  type AndroidReleaseArtifactInput,
} from "../src/routes/android_release_artifacts";
import {
  normalizePlayPromotionInput,
  playReadbackMatches,
  handleCreateAcceptanceReceipt,
  handleListDistributions,
  handleListReleaseReceipts,
  handleRollbackPlayDistribution,
  handlePromotePlayDistribution,
} from "../src/routes/play_distribution";
import { createRelease } from "../src/routes/releases";
import { openApiDocument } from "../src/openapi";
import { storeGooglePlayBinding } from "../src/lib/google_play_bindings";
import { requireAppRole } from "../src/lib/permissions";
import {
  handleEnableGooglePlayBinding,
  handleGetGooglePlayBinding,
  handlePutGooglePlayBinding,
  handleVerifyGooglePlayBinding,
} from "../src/routes/google_play_bindings";

const A = "a".repeat(64);
const B = "b".repeat(64);
const COMMIT = "c".repeat(40);
const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function validBundle(): AndroidReleaseArtifactInput {
  return {
    source: { repository: "botiverse/mobile", commit_sha: COMMIT, ci_run_id: "123" },
    package_name: "build.raft.app",
    version_name: "1.2.3",
    version_code: 42,
    upload_key_cert_sha256: A,
    artifacts: [
      { kind: "aab", filename: "raft-1.2.3.aab", size_bytes: 100, sha256: A },
      { kind: "apk", filename: "raft-1.2.3.apk", size_bytes: 200, sha256: B },
    ],
  };
}

describe("Android release artifact declaration", () => {
  it("binds exactly one AAB and one APK to one source/version identity", () => {
    const normalized = normalizeAndroidReleaseArtifactInput(validBundle());
    expect(normalized.source.commitSha).toBe(COMMIT);
    expect(normalized.versionCode).toBe(42);
    expect(normalized.artifacts.map((artifact) => artifact.kind)).toEqual(["aab", "apk"]);
    expect(normalized.artifacts[0].contentType).toBe("application/octet-stream");
    expect(normalized.artifacts[1].contentType).toBe("application/vnd.android.package-archive");
  });

  it("fails closed when either carrier is missing or duplicated", () => {
    const missing = validBundle();
    missing.artifacts = [missing.artifacts[0]!];
    expect(() => normalizeAndroidReleaseArtifactInput(missing)).toThrow(/exactly one AAB and one APK/);

    const duplicate = validBundle();
    duplicate.artifacts = [duplicate.artifacts[0]!, { ...duplicate.artifacts[0]!, filename: "second.aab" }];
    expect(() => normalizeAndroidReleaseArtifactInput(duplicate)).toThrow(/duplicate aab/);
  });

  it("rejects non-canonical hashes, commits, version codes, and filenames", () => {
    const uppercase = validBundle();
    uppercase.upload_key_cert_sha256 = "A".repeat(64);
    expect(() => normalizeAndroidReleaseArtifactInput(uppercase)).toThrow(/lowercase hex/);

    const shortCommit = validBundle();
    shortCommit.source.commit_sha = "c".repeat(39);
    expect(() => normalizeAndroidReleaseArtifactInput(shortCommit)).toThrow(/40-character/);

    const zeroVersion = validBundle();
    zeroVersion.version_code = 0;
    expect(() => normalizeAndroidReleaseArtifactInput(zeroVersion)).toThrow(/positive integer/);

    const path = validBundle();
    path.artifacts[0]!.filename = "../escape.aab";
    expect(() => normalizeAndroidReleaseArtifactInput(path)).toThrow(/safe basename/);
  });
});

describe("Play promotion gates", () => {
  it("requires an explicit supported track, revision, and approval", () => {
    expect(normalizePlayPromotionInput({
      track: "internal",
      expected_revision: 3,
      approval: { note: "ship exact accepted bytes" },
    })).toEqual({
      track: "internal",
      expected_revision: 3,
      approval: { note: "ship exact accepted bytes" },
    });
    expect(() => normalizePlayPromotionInput({
      track: "internal",
      expected_revision: 3,
      approval: { note: " " },
    })).toThrow(/approval.note/);
    expect(() => normalizePlayPromotionInput({
      track: "internal",
      rollout_percent: 25,
      expected_revision: 3,
      approval: { note: "ship" },
    })).toThrow(/partial rollout.*production/);
    expect(() => normalizePlayPromotionInput({
      track: "production",
      rollout_percent: 0,
      expected_revision: 3,
      approval: { note: "ship" },
    })).toThrow(/1 to 100/);
    expect(normalizePlayPromotionInput({
      track: "production",
      rollout_percent: 25,
      expected_revision: 3,
      approval: { note: "ship" },
    })).toMatchObject({ track: "production", rollout_percent: 25 });
  });

  it("accepts readback only when package, version, track, and SHA all match", () => {
    const artifact = { package_name: "build.raft.app", version_code: 42, file_hash: A };
    expect(playReadbackMatches(artifact, "internal", {
      edit_id: "edit-1",
      package_name: "build.raft.app",
      version_code: 42,
      track: "internal",
      sha256: A,
    })).toBe(true);
    for (const mismatch of [
      { package_name: "wrong.app" },
      { version_code: 43 },
      { track: "closed" as const },
      { sha256: B },
    ]) {
      expect(playReadbackMatches(artifact, "internal", {
        edit_id: "edit-1",
        package_name: "build.raft.app",
        version_code: 42,
        track: "internal",
        sha256: A,
        ...mismatch,
      })).toBe(false);
    }
  });
});

describe("0070 durable constraints", () => {
  function migratedDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY);
      CREATE TABLE builds (id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id), version_code INTEGER, revision INTEGER);
      CREATE TABLE releases (id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id), build_id TEXT NOT NULL REFERENCES builds(id));
      CREATE TABLE build_assets (id TEXT PRIMARY KEY, build_id TEXT NOT NULL REFERENCES builds(id));
    `);
    const migration = readFileSync(
      fileURLToPath(new URL("../../migrations/sql/0070_google_play_distribution.sql", import.meta.url)),
      "utf8",
    );
    db.exec(migration);
    db.prepare("INSERT INTO apps(id) VALUES ('app')").run();
    db.prepare("INSERT INTO builds(id, app_id, version_code, revision) VALUES ('build', 'app', 42, 0)").run();
    db.prepare("INSERT INTO releases(id, app_id, build_id) VALUES ('release', 'app', 'build')").run();
    db.prepare("INSERT INTO build_assets(id, build_id) VALUES ('aab', 'build')").run();
    return db;
  }

  it("makes receipts append-only", () => {
    const db = migratedDb();
    db.prepare(`INSERT INTO release_receipts
      (id, app_id, release_id, kind, verdict, artifact_id, artifact_sha256,
       artifact_size, package_name, source_commit, version_code, payload_json,
       created_by, created_at)
      VALUES ('receipt', 'app', 'release', 'acceptance', 'pass', 'aab', ?, 100,
              'build.raft.app', ?, 42, '{}', 'tester', 1)`).run(A, COMMIT);
    expect(() => db.prepare("UPDATE release_receipts SET verdict='fail' WHERE id='receipt'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM release_receipts WHERE id='receipt'").run()).toThrow(/immutable/);
  });

  it("allows exactly one active Play edit per app/package", () => {
    const db = migratedDb();
    db.prepare(`INSERT INTO play_edit_locks
      (app_id, package_name, release_id, operation_id, acquired_by, acquired_at)
      VALUES ('app', 'build.raft.app', 'release', 'one', 'human', 1)`).run();
    expect(() => db.prepare(`INSERT INTO play_edit_locks
      (app_id, package_name, release_id, operation_id, acquired_by, acquired_at)
      VALUES ('app', 'build.raft.app', 'release', 'two', 'human', 2)`).run()).toThrow(/UNIQUE/);
  });

  it("contains no Play distribution-certificate schema or gate", () => {
    const migration = readFileSync(
      fileURLToPath(new URL("../../migrations/sql/0070_google_play_distribution.sql", import.meta.url)),
      "utf8",
    );
    expect(migration).not.toMatch(/play_distribution_cert|distribution_cert/i);
    const schema = readFileSync(
      fileURLToPath(new URL("../../docs/schemas/release-receipt-v1.json", import.meta.url)),
      "utf8",
    );
    expect(schema).not.toMatch(/play_distribution_cert|distribution_cert/i);
  });
});

describe("Android distribution OpenAPI", () => {
  it("publishes every P0 artifact, receipt, and Play route", () => {
    const paths = openApiDocument.paths ?? {};
    for (const path of [
      "/api/apps/{appId}/android-release-artifacts",
      "/api/apps/{appId}/android-release-artifacts/{buildId}",
      "/api/apps/{appId}/android-release-artifacts/{buildId}/assets/{assetId}/complete",
      "/api/apps/{appId}/google-play-binding",
      "/api/apps/{appId}/google-play-binding/verify",
      "/api/apps/{appId}/google-play-binding/enable",
      "/api/apps/{appId}/google-play-binding/disable",
      "/api/apps/{appId}/releases/{releaseId}/receipts",
      "/api/apps/{appId}/releases/{releaseId}/receipts/acceptance",
      "/api/apps/{appId}/releases/{releaseId}/distributions",
      "/api/apps/{appId}/releases/{releaseId}/distributions/play",
      "/api/apps/{appId}/releases/{releaseId}/distributions/play/promote",
      "/api/apps/{appId}/releases/{releaseId}/distributions/play/halt",
      "/api/apps/{appId}/releases/{releaseId}/distributions/play/rollback",
    ]) {
      expect(paths[path]).toBeDefined();
    }
  });
});

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

function fullDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  }
  const now = Date.now();
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("app", "raft-android", "Raft Android", "android", now);
  sqlite.prepare(`INSERT INTO channels
    (id, app_id, slug, name, enabled_product_types_json, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?)`)
    .run("main", "app", "main", "Main", '["android-apk"]', now);
  return sqlite;
}

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { key, size: bytes.byteLength } : null;
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { key, size: bytes.byteLength, body: new Response(bytes).body! };
  }

  async put(key: string, value: ReadableStream<Uint8Array> | Uint8Array) {
    const bytes = value instanceof Uint8Array
      ? value
      : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, bytes);
    return { key, size: bytes.byteLength };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

function routeHarness() {
  const sqlite = fullDatabase();
  const bucket = new MemoryBucket();
  const env = {
    DB: d1(sqlite),
    APK_BUCKET: bucket,
    ENVIRONMENT: "development",
    BUSINESS_ORIGIN: "https://hands.test",
    R2_S3_ENDPOINT: "https://r2.test",
    R2_BUCKET_NAME: "artifacts",
    R2_S3_ACCESS_KEY_ID: "access",
    R2_S3_SECRET_ACCESS_KEY: "secret",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: { admin_account: any; admin_actor: string } }>();
  app.use("*", async (c, next) => {
    c.set("admin_account", {
      id: "human",
      provider: "raft",
      provider_subject: "human",
      server_id: "server",
      server_slug: "test",
      principal_type: "human",
      server_role: "member",
      username: "human",
      display_name: "Human",
      avatar_url: null,
      raw_profile: "{}",
      created_at: 1,
      updated_at: 1,
      last_login_at: 1,
    });
    c.set("admin_actor", "raft:human@test");
    await next();
  });
  app.post("/api/apps/:appId/android-release-artifacts", handleCreateAndroidReleaseArtifacts);
  app.post(
    "/api/apps/:appId/android-release-artifacts/:buildId/assets/:assetId/complete",
    handleCompleteAndroidReleaseArtifact,
  );
  app.get("/api/apps/:appId/android-release-artifacts/:buildId", handleGetAndroidReleaseArtifacts);
  app.post("/api/apps/:appId/releases/:releaseId/receipts/acceptance", handleCreateAcceptanceReceipt);
  app.get("/api/apps/:appId/releases/:releaseId/receipts", handleListReleaseReceipts);
  app.get("/api/apps/:appId/releases/:releaseId/distributions", handleListDistributions);
  app.post("/api/apps/:appId/releases/:releaseId/distributions/play/promote", handlePromotePlayDistribution);
  app.post("/api/apps/:appId/releases/:releaseId/distributions/play/rollback", handleRollbackPlayDistribution);
  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://hands.test${path}`, init), env, executionContext);
  return { sqlite, bucket, env, request };
}

function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Android artifact routes", () => {
  it("seals both exact objects before the parent build becomes ready", async () => {
    const { sqlite, bucket, request } = routeHarness();
    const aab = new TextEncoder().encode("exact-aab");
    const apk = new TextEncoder().encode("exact-apk");
    const body = validBundle();
    body.artifacts = [
      { kind: "aab", filename: "raft.aab", size_bytes: aab.byteLength, sha256: sha(aab) },
      { kind: "apk", filename: "raft.apk", size_bytes: apk.byteLength, sha256: sha(apk) },
    ];
    const declaredResponse = await request("/api/apps/app/android-release-artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(declaredResponse.status).toBe(201);
    const declared = await declaredResponse.json() as {
      build_id: string;
      status: string;
      artifacts: Array<{
        asset_id: string;
        kind: "aab" | "apk";
        status: string;
        complete_url: string;
        upload: { url: string };
      }>;
    };
    expect(declared.status).toBe("uploading");
    expect(declared.artifacts.map((artifact) => artifact.kind)).toEqual(["aab", "apk"]);
    expect(declared.artifacts.every((artifact) => artifact.upload.url.startsWith("https://r2.test/"))).toBe(true);
    expect(declared.artifacts.every((artifact) => artifact.complete_url.endsWith(`/assets/${artifact.asset_id}/complete`))).toBe(true);

    for (const artifact of declared.artifacts) {
      const row = sqlite.prepare("SELECT r2_key FROM build_assets WHERE id = ?").get(artifact.asset_id) as { r2_key: string };
      bucket.objects.set(row.r2_key, artifact.kind === "aab" ? aab : apk);
      const completedResponse = await request(
        `/api/apps/app/android-release-artifacts/${declared.build_id}/assets/${artifact.asset_id}/complete`,
        { method: "POST" },
      );
      expect(completedResponse.status).toBe(200);
      const completed = await completedResponse.json() as { status: string; artifacts: Array<{ status: string }> };
      expect(completed.artifacts.some((item) => item.status === "sealed")).toBe(true);
      expect(completed.status).toBe(artifact.kind === "aab" ? "uploading" : "ready");
    }

    const readbackResponse = await request(`/api/apps/app/android-release-artifacts/${declared.build_id}`);
    expect(readbackResponse.status).toBe(200);
    const readback = await readbackResponse.json() as { status: string; artifacts: Array<{ status: string; verified_sha256: string }> };
    expect(readback.status).toBe("ready");
    expect(readback.artifacts.every((artifact) => artifact.status === "sealed")).toBe(true);
    expect(readback.artifacts.map((artifact) => artifact.verified_sha256)).toEqual([sha(aab), sha(apk)]);
  });

  it("fails the whole bundle when uploaded bytes do not match the declaration", async () => {
    const { sqlite, bucket, request } = routeHarness();
    const body = validBundle();
    body.artifacts[0] = { kind: "aab", filename: "raft.aab", size_bytes: 5, sha256: A };
    body.artifacts[1] = { kind: "apk", filename: "raft.apk", size_bytes: 5, sha256: B };
    const declared = await (await request("/api/apps/app/android-release-artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })).json() as { build_id: string; artifacts: Array<{ asset_id: string; kind: string }> };
    const aabAsset = declared.artifacts.find((artifact) => artifact.kind === "aab")!;
    const row = sqlite.prepare("SELECT r2_key FROM build_assets WHERE id = ?").get(aabAsset.asset_id) as { r2_key: string };
    bucket.objects.set(row.r2_key, new TextEncoder().encode("wrong"));
    const completed = await request(
      `/api/apps/app/android-release-artifacts/${declared.build_id}/assets/${aabAsset.asset_id}/complete`,
      { method: "POST" },
    );
    expect(completed.status).toBe(422);
    expect(await completed.json()).toMatchObject({ code: "INTEGRITY_MISMATCH" });
    const bundle = await (await request(`/api/apps/app/android-release-artifacts/${declared.build_id}`)).json() as { status: string };
    expect(bundle.status).toBe("failed");
  });
});

async function readyRelease() {
  const harness = routeHarness();
  harness.env.PLAY_CRED_ENC_KEYS = JSON.stringify({ v1: "test-only-google-play-key-material-1234567890" });
  harness.env.PLAY_CRED_ENC_ACTIVE_KEY_VERSION = "v1";
  await storeGooglePlayBinding(harness.env.DB, {
    appId: "app",
    packageName: "build.raft.app",
    tracks: { internal: "qa", closed: "closed", production: "production" },
    credential: {
      type: "service_account",
      client_email: "app@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
    },
    actor: "raft:human@test",
    keyringJson: harness.env.PLAY_CRED_ENC_KEYS,
    activeKeyVersion: harness.env.PLAY_CRED_ENC_ACTIVE_KEY_VERSION,
  });
  const aab = new TextEncoder().encode("exact-aab");
  const apk = new TextEncoder().encode("exact-apk");
  const body = validBundle();
  body.artifacts = [
    { kind: "aab", filename: "raft.aab", size_bytes: aab.byteLength, sha256: sha(aab) },
    { kind: "apk", filename: "raft.apk", size_bytes: apk.byteLength, sha256: sha(apk) },
  ];
  const declared = await (await harness.request("/api/apps/app/android-release-artifacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json() as { build_id: string; artifacts: Array<{ asset_id: string; kind: "aab" | "apk" }> };
  for (const artifact of declared.artifacts) {
    const row = harness.sqlite.prepare("SELECT r2_key FROM build_assets WHERE id = ?").get(artifact.asset_id) as { r2_key: string };
    harness.bucket.objects.set(row.r2_key, artifact.kind === "aab" ? aab : apk);
    const completed = await harness.request(
      `/api/apps/app/android-release-artifacts/${declared.build_id}/assets/${artifact.asset_id}/complete`,
      { method: "POST" },
    );
    expect(completed.status).toBe(200);
  }
  await createRelease(
    harness.env.DB,
    "app",
    { build_id: declared.build_id, status: "draft" },
    "raft:human@test",
    "release",
  );
  const aabAsset = declared.artifacts.find((artifact) => artifact.kind === "aab")!;
  const acceptance = await harness.request("/api/apps/app/releases/release/receipts/acceptance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      artifact_id: aabAsset.asset_id,
      verdict: "pass",
      matrix_ref: "matrix://android/p0/1",
      expected_revision: 0,
    }),
  });
  expect(acceptance.status).toBe(201);
  return { ...harness, aab, aabAsset, declared };
}

type PlayAdapter = NonNullable<Env["PLAY_RELEASE_SERVICE"]>;

function playAdapterStub(overrides: Partial<PlayAdapter> = {}): PlayAdapter {
  return {
    verifyBinding: async (input) => ({
      ok: true,
      value: {
        client_email: input.credential.client_email,
        package_name: input.packageName,
        tracks: input.tracks,
      },
    }),
    readTrackMaximum: async () => ({ ok: true, value: { max_version_code: 41 } }),
    promote: async () => {
      throw new Error("unexpected promote call");
    },
    ...overrides,
  };
}

function googlePlayBindingHarness(role: "admin" | "publisher", withKeyring = true) {
  const sqlite = fullDatabase();
  const now = Date.now();
  sqlite.prepare(`INSERT INTO raft_accounts
    (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
     username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
    VALUES ('binding-user', 'raft', 'binding-user', 'server', 'test', 'human', NULL,
            'binding-user', 'Binding User', NULL, '{}', ?, ?, ?)`)
    .run(now, now, now);
  sqlite.prepare(`INSERT INTO app_members
    (id, app_id, account_id, app_role, joined_at)
    VALUES ('binding-member', 'app', 'binding-user', ?, ?)`)
    .run(role, now);
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('other', 'other', 'Other', 'android', ?)")
    .run(now);

  const env = {
    DB: d1(sqlite),
    ENVIRONMENT: "development",
    BUSINESS_ORIGIN: "https://hands.test",
    DASHBOARD_ORIGIN: "https://app.hands.test",
    ...(withKeyring
      ? {
          PLAY_CRED_ENC_KEYS: JSON.stringify({ v1: "test-only-google-play-key-material-1234567890" }),
          PLAY_CRED_ENC_ACTIVE_KEY_VERSION: "v1",
        }
      : {}),
    PLAY_RELEASE_SERVICE: playAdapterStub(),
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: { admin_account: any; admin_actor: string } }>();
  app.use("*", async (c, next) => {
    c.set("admin_account", {
      id: "binding-user",
      provider: "raft",
      provider_subject: "binding-user",
      server_id: "server",
      server_slug: "test",
      principal_type: "human",
      server_role: null,
      username: "binding-user",
      display_name: "Binding User",
      avatar_url: null,
      raw_profile: "{}",
      created_at: now,
      updated_at: now,
      last_login_at: now,
    });
    c.set("admin_actor", "raft:binding-user@test");
    await next();
  });
  app.get("/api/apps/:appId/google-play-binding", requireAppRole("admin"), handleGetGooglePlayBinding);
  app.put("/api/apps/:appId/google-play-binding", requireAppRole("admin"), handlePutGooglePlayBinding);
  app.post("/api/apps/:appId/google-play-binding/verify", requireAppRole("admin"), handleVerifyGooglePlayBinding);
  app.post("/api/apps/:appId/google-play-binding/enable", requireAppRole("admin"), handleEnableGooglePlayBinding);
  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://hands.test${path}`, init), env, executionContext);
  return { sqlite, env, request };
}

function validBindingBody() {
  return {
    service_account_json: {
      type: "service_account",
      project_id: "tenant-project",
      private_key_id: "tenant-key",
      client_email: "tenant@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nprivate-tenant-material\n-----END PRIVATE KEY-----",
    },
    package_name: "build.raft.app",
    tracks: { internal: "qa", closed: "closed", production: "production" },
  };
}

describe("Google Play binding routes", () => {
  it("allows only the app admin, stores encrypted private material, and returns safe metadata", async () => {
    const publisher = googlePlayBindingHarness("publisher");
    const denied = await publisher.request("/api/apps/app/google-play-binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBindingBody()),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "INSUFFICIENT_APP_ROLE", required_role: "admin" });

    const admin = googlePlayBindingHarness("admin");
    const stored = await admin.request("/api/apps/app/google-play-binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBindingBody()),
    });
    expect(stored.status).toBe(200);
    const responseText = await stored.text();
    expect(responseText).not.toContain("private-tenant-material");
    expect(responseText).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.parse(responseText)).toMatchObject({
      google_play: { app_id: "app", enabled: true, package_name: "build.raft.app" },
    });
    const row = admin.sqlite.prepare(`SELECT credential_ciphertext_b64, credential_iv_b64,
      credential_key_version FROM app_google_play_bindings WHERE app_id='app'`).get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain("private-tenant-material");
    expect(row.credential_key_version).toBe("v1");
    const audit = admin.sqlite.prepare("SELECT payload FROM audit_logs WHERE action='google_play.binding.set'").get() as { payload: string };
    expect(audit.payload).not.toContain("private-tenant-material");

    const readback = await admin.request("/api/apps/app/google-play-binding");
    expect(readback.status).toBe(200);
    expect(await readback.text()).not.toContain("credential_ciphertext_b64");

    const crossApp = await admin.request("/api/apps/other/google-play-binding");
    expect(crossApp.status).toBe(403);
  });

  it("fails before external validation when credential encryption is unavailable", async () => {
    const harness = googlePlayBindingHarness("admin", false);
    let adapterCalls = 0;
    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
      verifyBinding: async () => {
        adapterCalls += 1;
        return { ok: false, error: { status: 500, code: "UNEXPECTED", message: "unexpected" } };
      },
    });
    const response = await harness.request("/api/apps/app/google-play-binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBindingBody()),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "PLAY_CREDENTIAL_STORAGE_UNAVAILABLE" });
    expect(adapterCalls).toBe(0);
  });

  it("marks a definitively rejected binding stale and disabled, then re-verifies before enable", async () => {
    const harness = googlePlayBindingHarness("admin");
    const stored = await harness.request("/api/apps/app/google-play-binding", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBindingBody()),
    });
    expect(stored.status).toBe(200);

    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
      verifyBinding: async () => ({
        ok: false,
        error: { status: 502, code: "PLAY_UPSTREAM_UNAVAILABLE", message: "temporarily unavailable" },
      }),
    });
    const transient = await harness.request("/api/apps/app/google-play-binding/verify", { method: "POST" });
    expect(transient.status).toBe(502);
    expect(harness.sqlite.prepare(`SELECT enabled, verification_state FROM app_google_play_bindings
      WHERE app_id='app'`).get()).toEqual({ enabled: 1, verification_state: "verified" });

    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
      verifyBinding: async () => ({
        ok: false,
        error: { status: 403, code: "PLAY_PERMISSION_DENIED", message: "permission denied" },
      }),
    });
    const rejected = await harness.request("/api/apps/app/google-play-binding/verify", { method: "POST" });
    expect(rejected.status).toBe(502);
    expect(harness.sqlite.prepare(`SELECT enabled, verification_state, verified_at
      FROM app_google_play_bindings WHERE app_id='app'`).get()).toEqual({
      enabled: 0,
      verification_state: "stale",
      verified_at: null,
    });

    const deniedEnable = await harness.request("/api/apps/app/google-play-binding/enable", { method: "POST" });
    expect(deniedEnable.status).toBe(502);
    const deniedAudit = harness.sqlite.prepare(`SELECT payload FROM audit_logs
      WHERE action='google_play.binding.enable' ORDER BY created_at DESC LIMIT 1`).get() as { payload: string };
    expect(JSON.parse(deniedAudit.payload)).toEqual({
      package_name: "build.raft.app",
      ok: false,
      code: "PLAY_PERMISSION_DENIED",
    });
    expect(deniedAudit.payload).not.toContain("private-tenant-material");

    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub();
    const enabled = await harness.request("/api/apps/app/google-play-binding/enable", { method: "POST" });
    expect(enabled.status).toBe(200);
    expect(harness.sqlite.prepare(`SELECT enabled, verification_state, verified_at IS NOT NULL AS verified
      FROM app_google_play_bindings WHERE app_id='app'`).get()).toEqual({
      enabled: 1,
      verification_state: "verified",
      verified: 1,
    });
  });
});

describe("Play promotion route", () => {
  it("streams the accepted exact AAB once and records matching readback", async () => {
    const harness = await readyRelease();
    let trackReads = 0;
    let edits = 0;
    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
      readTrackMaximum: async () => {
        trackReads += 1;
        return { ok: true, value: { max_version_code: 41 } };
      },
      promote: async (_input, stream) => {
        edits += 1;
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        return { ok: true, value: {
          edit_id: "edit-1",
          package_name: "build.raft.app",
          version_code: 42,
          track: "internal",
          sha256: sha(bytes),
          rollout_percent: 100,
        } };
      },
    });

    const promoted = await harness.request("/api/apps/app/releases/release/distributions/play/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        track: "internal",
        expected_revision: 1,
        approval: { note: "promote accepted exact AAB" },
      }),
    });
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ edit_id: "edit-1", track: "internal", version_code: 42 });
    expect(trackReads).toBe(1);
    expect(edits).toBe(1);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM play_edit_locks").get()).toEqual({ count: 0 });
    expect(harness.sqlite.prepare("SELECT verdict, artifact_id, track FROM release_receipts WHERE kind='play-promotion'").get())
      .toEqual({ verdict: "success", artifact_id: harness.aabAsset.asset_id, track: "internal" });
    const payload = JSON.parse(String((harness.sqlite.prepare(
      "SELECT payload_json FROM release_receipts WHERE kind='play-promotion'",
    ).get() as { payload_json: string }).payload_json));
    expect(payload).toMatchObject({
      schema_version: 1,
      kind: "play-promotion",
      artifact: { type: "aab", sha256: sha(harness.aab), package: "build.raft.app", version_code: 42 },
      source: { repo: "botiverse/mobile", sha: COMMIT, ci_run_id: "123" },
      signing: { upload_key_cert_sha256: A },
      play: { edit_id: "edit-1", track: "internal", api_readback: { sha256_match: true } },
      result: { status: "success" },
    });
    expect(JSON.stringify(payload)).not.toMatch(/distribution[_-]?cert/i);
  });

  it("rejects missing, disabled, and package-mismatched app bindings before any adapter call", async () => {
    const cases = [
      {
        mutate: (db: Database.Database) => db.prepare("DELETE FROM app_google_play_bindings WHERE app_id='app'").run(),
        status: 403,
        gate: "permission",
      },
      {
        mutate: (db: Database.Database) => db.prepare("UPDATE app_google_play_bindings SET enabled=0 WHERE app_id='app'").run(),
        status: 403,
        gate: "permission",
      },
      {
        mutate: (db: Database.Database) => db.prepare("UPDATE app_google_play_bindings SET package_name='other.package' WHERE app_id='app'").run(),
        status: 400,
        gate: "immutable_binding",
      },
    ];
    for (const fixture of cases) {
      const harness = await readyRelease();
      let adapterCalls = 0;
      harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
        readTrackMaximum: async () => {
          adapterCalls += 1;
          return { ok: true, value: { max_version_code: 41 } };
        },
      });
      fixture.mutate(harness.sqlite);
      const response = await harness.request("/api/apps/app/releases/release/distributions/play/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ track: "internal", expected_revision: 1, approval: { note: "approved" } }),
      });
      expect(response.status).toBe(fixture.status);
      expect(await response.json()).toMatchObject({ error: { gate: fixture.gate } });
      expect(adapterCalls).toBe(0);
      expect(harness.sqlite.prepare("SELECT revision FROM releases WHERE id='release'").get()).toEqual({ revision: 1 });
    }
  });

  it("returns edit_conflict without calling Play and never retries", async () => {
    const harness = await readyRelease();
    let calls = 0;
    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
      readTrackMaximum: async () => {
        calls += 1;
        return { ok: true, value: { max_version_code: 41 } };
      },
    });
    harness.sqlite.prepare(`INSERT INTO play_edit_locks
      (app_id, package_name, release_id, operation_id, acquired_by, acquired_at)
      VALUES ('app', 'build.raft.app', 'release', 'other', 'other', 1)`).run();
    const response = await harness.request("/api/apps/app/releases/release/distributions/play/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ track: "internal", expected_revision: 1, approval: { note: "approved" } }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "edit_conflict", gate: "edit_lock" } });
    expect(calls).toBe(0);
  });

  it("returns typed play_api_error before revision reserve for malformed track JSON", async () => {
    const harness = await readyRelease();
    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
      readTrackMaximum: async () => ({ ok: true, value: { max_version_code: Number.NaN } }),
    });
    const response = await harness.request("/api/apps/app/releases/release/distributions/play/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ track: "internal", expected_revision: 1, approval: { note: "approved" } }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "play_api_error", receipt_id: null } });
    expect(harness.sqlite.prepare("SELECT revision FROM releases WHERE id='release'").get()).toEqual({ revision: 1 });
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM release_receipts WHERE kind='play-promotion'").get())
      .toEqual({ count: 0 });
  });

  it("returns typed play_api_error before reserve when the track request rejects", async () => {
    const harness = await readyRelease();
    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
      readTrackMaximum: async () => { throw new Error("adapter unavailable"); },
    });
    const response = await harness.request("/api/apps/app/releases/release/distributions/play/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ track: "internal", expected_revision: 1, approval: { note: "approved" } }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "play_api_error", receipt_id: null } });
    expect(harness.sqlite.prepare("SELECT revision FROM releases WHERE id='release'").get()).toEqual({ revision: 1 });
  });

  it("records failed-closed after reserve when Play edit readback is malformed", async () => {
    const harness = await readyRelease();
    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
      readTrackMaximum: async () => ({ ok: true, value: { max_version_code: 41 } }),
      promote: async () => ({ ok: true, value: null }),
    } as unknown as Partial<PlayAdapter>);
    const response = await harness.request("/api/apps/app/releases/release/distributions/play/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ track: "internal", expected_revision: 1, approval: { note: "approved" } }),
    });
    expect(response.status).toBe(502);
    const failure = await response.json() as { error: { code: string; receipt_id: string } };
    expect(failure.error).toMatchObject({ code: "play_api_error" });
    expect(failure.error.receipt_id).toBeTruthy();
    expect(harness.sqlite.prepare("SELECT revision FROM releases WHERE id='release'").get()).toEqual({ revision: 2 });
    expect(harness.sqlite.prepare("SELECT verdict, id FROM release_receipts WHERE kind='play-promotion'").get())
      .toEqual({ verdict: "failed-closed", id: failure.error.receipt_id });
  });

  it("records failed-closed after reserve when the Play edit request rejects", async () => {
    const harness = await readyRelease();
    harness.env.PLAY_RELEASE_SERVICE = playAdapterStub({
      readTrackMaximum: async () => ({ ok: true, value: { max_version_code: 41 } }),
      promote: async () => { throw new Error("adapter unavailable"); },
    });
    const response = await harness.request("/api/apps/app/releases/release/distributions/play/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ track: "internal", expected_revision: 1, approval: { note: "approved" } }),
    });
    expect(response.status).toBe(502);
    const failure = await response.json() as { error: { code: string; receipt_id: string } };
    expect(failure.error).toMatchObject({ code: "play_api_error" });
    expect(failure.error.receipt_id).toBeTruthy();
    expect(harness.sqlite.prepare("SELECT revision FROM releases WHERE id='release'").get()).toEqual({ revision: 2 });
    expect(harness.sqlite.prepare("SELECT verdict, id FROM release_receipts WHERE kind='play-promotion'").get())
      .toEqual({ verdict: "failed-closed", id: failure.error.receipt_id });
  });

  it("validates rollback to_version_code before the fail-closed adapter boundary", async () => {
    const harness = await readyRelease();
    const missing = await harness.request("/api/apps/app/releases/release/distributions/play/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 1, approval: { note: "approved" } }),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { gate: "version_code" } });

    const valid = await harness.request("/api/apps/app/releases/release/distributions/play/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 1, approval: { note: "approved" }, to_version_code: 40 }),
    });
    expect(valid.status).toBe(502);
    expect(await valid.json()).toMatchObject({ error: { code: "play_api_error" } });
  });

  it("fails before Play when the latest acceptance does not pass", async () => {
    const harness = await readyRelease();
    harness.sqlite.prepare("UPDATE releases SET revision = 2 WHERE id = 'release'").run();
    harness.sqlite.prepare(`INSERT INTO release_receipts
      (id, app_id, release_id, kind, verdict, artifact_id, artifact_sha256,
       artifact_size, package_name, source_commit, version_code, payload_json,
       created_by, created_at)
      SELECT '!later-fail', app_id, release_id, kind, 'fail', artifact_id,
             artifact_sha256, artifact_size, package_name, source_commit,
             version_code, '{}', 'human', created_at
      FROM release_receipts WHERE kind = 'acceptance'`).run();
    const response = await harness.request("/api/apps/app/releases/release/distributions/play/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ track: "internal", expected_revision: 2, approval: { note: "approved" } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { gate: "acceptance_receipt" } });
  });

  it("derives Hands distribution state from the latest appended acceptance", async () => {
    const harness = await readyRelease();
    let distributions = await (await harness.request(
      "/api/apps/app/releases/release/distributions",
    )).json() as { distributions: Array<{ provider: string; state: string }> };
    expect(distributions.distributions).toContainEqual({ provider: "hands", state: "accepted" });

    const existing = harness.sqlite.prepare(
      "SELECT * FROM release_receipts WHERE kind = 'acceptance'",
    ).get() as Record<string, unknown>;
    harness.sqlite.prepare(`INSERT INTO release_receipts
      (id, app_id, release_id, kind, verdict, artifact_id, artifact_sha256,
       artifact_size, package_name, source_commit, version_code, payload_json,
       created_by, created_at)
      VALUES ('!later-fail', ?, ?, 'acceptance', 'fail', ?, ?, ?, ?, ?, ?, '{}', 'human', ?)`)
      .run(
        existing.app_id, existing.release_id, existing.artifact_id,
        existing.artifact_sha256, existing.artifact_size, existing.package_name,
        existing.source_commit, existing.version_code, existing.created_at,
      );
    distributions = await (await harness.request(
      "/api/apps/app/releases/release/distributions",
    )).json() as { distributions: Array<{ provider: string; state: string }> };
    expect(distributions.distributions).toContainEqual({ provider: "hands", state: "not-accepted" });
  });

  it("records complete acceptance provenance for either sealed Android asset", async () => {
    const harness = await readyRelease();
    const acceptancePayload = JSON.parse(String((harness.sqlite.prepare(
      "SELECT payload_json FROM release_receipts WHERE kind='acceptance' ORDER BY rowid LIMIT 1",
    ).get() as { payload_json: string }).payload_json));
    expect(acceptancePayload).toMatchObject({
      schema_version: 1,
      kind: "acceptance",
      artifact: { type: "aab", sha256: sha(harness.aab), version_name: "1.2.3", version_code: 42 },
      source: { repo: "botiverse/mobile", sha: COMMIT, ci_run_id: "123" },
      signing: { upload_key_cert_sha256: A },
      hands_acceptance: { verdict: "pass", matrix_ref: "matrix://android/p0/1" },
      result: { status: "success" },
    });

    const apkAsset = harness.declared.artifacts.find((artifact) => artifact.kind === "apk")!;
    const response = await harness.request("/api/apps/app/releases/release/receipts/acceptance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifact_id: apkAsset.asset_id,
        verdict: "pass",
        matrix_ref: "matrix://android/apk/1",
        expected_revision: 1,
      }),
    });
    expect(response.status).toBe(201);
    const apkPayload = JSON.parse(String((harness.sqlite.prepare(
      "SELECT payload_json FROM release_receipts WHERE artifact_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(apkAsset.asset_id) as { payload_json: string }).payload_json));
    expect(apkPayload.artifact.type).toBe("apk");
  });
});
