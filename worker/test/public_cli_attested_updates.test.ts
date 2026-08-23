import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
  UPDATE_ATTESTATION_ALGORITHM,
  UPDATE_ATTESTATION_DOMAIN,
  canonicalizeUpdateAttestationPayload,
  updateAttestationKeyId,
  type UpdateArtifactAttestationPayload,
} from "../src/lib/update_attestation";
import { handlePublicCliBinaryUpdateCheck } from "../src/routes/public_v2";

function d1(sqlite: Database.Database) {
  return {
    prepare(sql: string) {
      const indexes: number[] = [];
      const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => {
        indexes.push(Number(index));
        return "?";
      }));
      const bind = (...values: unknown[]) => {
        const bound = indexes.length ? indexes.map((index) => values[index - 1]) : values;
        return {
          first: async <T>() => (statement.get(...bound) as T | undefined) ?? null,
          all: async <T>() => ({ results: statement.all(...bound) as T[] }),
          run: async () => ({ success: true, meta: { changes: statement.run(...bound).changes } }),
        };
      };
      return { bind, first: () => bind().first(), all: () => bind().all(), run: () => bind().run() };
    },
  };
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

describe("public attested cli-binary selection", () => {
  let sqlite: Database.Database;
  let env: { DB: ReturnType<typeof d1>; BUSINESS_ORIGIN: string };
  let app: Hono<{ Bindings: typeof env }>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let keyId: string;
  let spki: Uint8Array;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY, slug TEXT, platform TEXT, update_attestation_required INTEGER);
      CREATE TABLE channels (id TEXT PRIMARY KEY, app_id TEXT, slug TEXT);
      CREATE TABLE releases (id TEXT PRIMARY KEY, app_id TEXT, build_id TEXT, channel_id TEXT, product_type TEXT, release_type TEXT, status TEXT, hidden INTEGER, revision INTEGER, rollout_cohort_count INTEGER, activated_at INTEGER, availability_at INTEGER);
      CREATE TABLE release_scopes (id TEXT PRIMARY KEY, release_id TEXT, scope_type TEXT, scope_value TEXT);
      CREATE TABLE builds (id TEXT PRIMARY KEY, app_id TEXT, status TEXT, version_name TEXT, version_code INTEGER);
      CREATE TABLE external_build_targets (id TEXT PRIMARY KEY, build_id TEXT, target TEXT, raw_sha256 TEXT, raw_size_bytes INTEGER);
      CREATE TABLE update_attestation_keys (key_id TEXT PRIMARY KEY, app_id TEXT, status TEXT, public_key_spki_b64url TEXT);
      CREATE TABLE release_artifact_attestations (id TEXT PRIMARY KEY, app_id TEXT, release_id TEXT, build_id TEXT, artifact_kind TEXT, artifact_id TEXT, schema_version INTEGER, algorithm TEXT, key_id TEXT, payload_b64url TEXT, signature_b64url TEXT);
      INSERT INTO apps VALUES ('app', 'computer', 'desktop', 1);
      INSERT INTO channels VALUES ('channel-main', 'app', 'main');
      INSERT INTO channels VALUES ('channel-alpha', 'app', 'alpha');
    `);
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey) as ArrayBuffer);
    keyId = await updateAttestationKeyId(spki);
    sqlite.prepare("INSERT INTO update_attestation_keys VALUES (?, 'app', 'active', ?)").run(keyId, base64url(spki));
    env = { DB: d1(sqlite), BUSINESS_ORIGIN: "https://hands.example" };
    app = new Hono<{ Bindings: typeof env }>();
    app.get("/public/v2/apps/:slug/updates/check", handlePublicCliBinaryUpdateCheck as never);
  });

  async function seedRelease(id: string, version: string, status: string, activatedAt: number, options: { channel?: "main" | "alpha"; sha256?: string; sourceCommit?: string | null; reuseArtifactFrom?: string } = {}) {
    const buildId = `build-${options.reuseArtifactFrom ?? id}`;
    const artifactId = `artifact-${options.reuseArtifactFrom ?? id}`;
    const sha256 = options.sha256 ?? createHash("sha256").update(id).digest("hex");
    const channel = options.channel ?? "main";
    const channelId = `channel-${channel}`;
    if (!options.reuseArtifactFrom) sqlite.prepare("INSERT INTO builds VALUES (?, 'app', 'succeeded', ?, ?)").run(buildId, version, activatedAt);
    sqlite.prepare("INSERT INTO releases VALUES (?, 'app', ?, ?, 'cli-binary', 'stable', ?, 0, 1, NULL, ?, NULL)").run(id, buildId, channelId, status, activatedAt);
    sqlite.prepare("INSERT INTO release_scopes VALUES (?, ?, 'full', 'all')").run(`scope-${id}`, id);
    if (!options.reuseArtifactFrom) sqlite.prepare("INSERT INTO external_build_targets VALUES (?, ?, 'linux-x64', ?, 8)").run(artifactId, buildId, sha256);
    const payload: UpdateArtifactAttestationPayload = {
      algorithm: UPDATE_ATTESTATION_ALGORITHM,
      appId: "app",
      artifact: { arch: "x64", id: artifactId, kind: "external_build_target", platform: "linux", sha256, sizeBytes: 8, type: "sea" },
      buildId,
      channelId,
      domain: UPDATE_ATTESTATION_DOMAIN,
      issuedAt: 1,
      keyId,
      productType: "cli-binary",
      releaseId: id,
      releaseType: "stable",
      schemaVersion: 1,
      sourceCommit: options.sourceCommit ?? null,
      version,
      versionCode: activatedAt,
    };
    const bytes = new TextEncoder().encode(canonicalizeUpdateAttestationPayload(payload));
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, bytes));
    sqlite.prepare("INSERT INTO release_artifact_attestations VALUES (?, 'app', ?, ?, 'external_build_target', ?, 1, 'Ed25519', ?, ?, ?)")
      .run(`att-${id}`, id, buildId, artifactId, keyId, base64url(bytes), base64url(signature));
  }

  async function check(extra = "") {
    return app.request(`https://hands.example/public/v2/apps/computer/updates/check?current_version=0.5.0&channel=main&platform=linux&arch=x64${extra}`, {}, env);
  }

  it("selects the exact pinned active version instead of returning latest", async () => {
    await seedRelease("r1", "1.0.0", "active", 100);
    await seedRelease("r2", "2.0.0", "active", 200);
    const response = await check("&version=1.0.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ release: { id: "r1", version: "1.0.0" } });
  });

  it("never exposes a draft through a pinned request or arbitrary device_id", async () => {
    await seedRelease("draft", "3.0.0", "draft", 300);
    const response = await check("&version=3.0.0&device_id=attacker-controlled");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_NO_COMPATIBLE_ARTIFACT" });
  });

  it("rejects signed-payload versus ledger drift", async () => {
    await seedRelease("drift", "1.0.0", "active", 100);
    sqlite.prepare("UPDATE external_build_targets SET raw_size_bytes = 9 WHERE id = 'artifact-drift'").run();
    const response = await check();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_IDENTITY_DRIFT" });
  });

  it("allows an exact pin that exists only as an active alpha release", async () => {
    await seedRelease("alpha-only", "4.0.0", "active", 400, { channel: "alpha" });
    const response = await check("&version=4.0.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ release: { id: "alpha-only", channel: "alpha" } });
  });

  it("deterministically prefers main when cross-channel signed identity is equal", async () => {
    const sha256 = "b".repeat(64);
    await seedRelease("alpha-same", "5.0.0", "active", 500, { channel: "alpha", sha256, sourceCommit: "commit" });
    await seedRelease("main-same", "5.0.0", "active", 500, { channel: "main", sha256, sourceCommit: "commit", reuseArtifactFrom: "alpha-same" });
    const response = await check("&version=5.0.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ release: { id: "main-same", channel: "main" } });
  });

  it("fails closed when cross-channel pinned signed identities diverge", async () => {
    await seedRelease("alpha-divergent", "6.0.0", "active", 600, { channel: "alpha", sha256: "c".repeat(64), sourceCommit: "commit" });
    await seedRelease("main-divergent", "6.0.0", "active", 601, { channel: "main", sha256: "d".repeat(64), sourceCommit: "commit" });
    const response = await check("&version=6.0.0");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_IDENTITY_CONFLICT" });
  });
});
