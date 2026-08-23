import Database from "better-sqlite3";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { updateAttestationKeyId } from "../src/lib/update_attestation";
import {
  handlePrepareUpdateAttestation,
  handleSubmitUpdateAttestation,
} from "../src/routes/update_attestations";

function d1(sqlite: Database.Database) {
  const prepared = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => {
      indexes.push(Number(index));
      return "?";
    }));
    const bind = (...values: unknown[]) => {
      const bound = indexes.length ? indexes.map((index) => values[index - 1]) : values;
      const runSync = () => ({ success: true, meta: { changes: statement.run(...bound).changes } });
      return {
        _runSync: runSync,
        first: async <T>() => (statement.get(...bound) as T | undefined) ?? null,
        all: async <T>() => ({ results: statement.all(...bound) as T[] }),
        run: async () => runSync(),
      };
    };
    return { bind, first: () => bind().first(), all: () => bind().all(), run: () => bind().run() };
  };
  return {
    prepare: prepared,
    batch: async (statements: Array<{ _runSync: () => unknown }>) =>
      sqlite.transaction(() => statements.map((statement) => statement._runSync()))(),
  };
}

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

describe("update attestation admission routes", () => {
  let sqlite: Database.Database;
  let env: { DB: ReturnType<typeof d1> };
  let app: Hono<{ Bindings: typeof env }>;
  let privateKey: CryptoKey;
  let keyId: string;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE releases (id TEXT PRIMARY KEY, app_id TEXT, build_id TEXT, channel_id TEXT, product_type TEXT, release_type TEXT, status TEXT);
      CREATE TABLE builds (id TEXT PRIMARY KEY, app_id TEXT, version_name TEXT, version_code INTEGER, provenance_json TEXT);
      CREATE TABLE build_assets (id TEXT PRIMARY KEY, build_id TEXT, platform TEXT, arch TEXT, filetype TEXT, file_hash TEXT, size_bytes INTEGER);
      CREATE TABLE external_build_targets (id TEXT PRIMARY KEY, build_id TEXT, target TEXT, raw_sha256 TEXT, raw_size_bytes INTEGER);
      CREATE TABLE update_attestation_keys (key_id TEXT PRIMARY KEY, app_id TEXT, algorithm TEXT, public_key_spki_b64url TEXT, status TEXT, label TEXT, created_at INTEGER);
      CREATE TABLE release_artifact_attestation_requests (id TEXT PRIMARY KEY, app_id TEXT, release_id TEXT, build_id TEXT, artifact_kind TEXT, artifact_id TEXT, key_id TEXT, payload_b64url TEXT, payload_sha256 TEXT, issued_at INTEGER, expires_at INTEGER, consumed_at INTEGER, created_at INTEGER, UNIQUE(release_id, artifact_kind, artifact_id, key_id));
      CREATE TABLE release_artifact_attestations (id TEXT PRIMARY KEY, app_id TEXT, release_id TEXT, build_id TEXT, artifact_kind TEXT, artifact_id TEXT, schema_version INTEGER, algorithm TEXT, key_id TEXT, payload_b64url TEXT, payload_sha256 TEXT UNIQUE, signature_b64url TEXT, issued_at INTEGER, created_at INTEGER, UNIQUE(release_id, artifact_kind, artifact_id));
      INSERT INTO builds VALUES ('build', 'app', '1.0.0', 100, '{"source_commit":"abc"}');
      INSERT INTO releases VALUES ('release', 'app', 'build', 'main', 'cli-binary', 'stable', 'draft');
      INSERT INTO external_build_targets VALUES ('artifact', 'build', 'linux-x64', '${"a".repeat(64)}', 8);
    `);
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    privateKey = pair.privateKey;
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey) as ArrayBuffer);
    keyId = await updateAttestationKeyId(spki);
    sqlite.prepare("INSERT INTO update_attestation_keys VALUES (?, 'app', 'Ed25519', ?, 'active', 'test', 1)").run(keyId, encode(spki));
    env = { DB: d1(sqlite) };
    app = new Hono<{ Bindings: typeof env }>();
    app.post("/api/apps/:appId/releases/:releaseId/attestations/prepare", handlePrepareUpdateAttestation as never);
    app.post("/api/apps/:appId/releases/:releaseId/attestations/submit", handleSubmitUpdateAttestation as never);
  });

  async function prepare() {
    const response = await app.request("https://hands.example/api/apps/app/releases/release/attestations/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact_kind: "external_build_target", artifact_id: "artifact", key_id: keyId }),
    }, env);
    return { response, body: await response.json() as { request: { id: string; payload_b64url: string } } };
  }

  async function submit(requestId: string, payload: string) {
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, Buffer.from(payload, "base64url")));
    return app.request("https://hands.example/api/apps/app/releases/release/attestations/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: requestId, signature: encode(signature) }),
    }, env);
  }

  it("prepares and admits a valid release-bound signature", async () => {
    const prepared = await prepare();
    expect(prepared.response.status).toBe(201);
    expect((await submit(prepared.body.request.id, prepared.body.request.payload_b64url)).status).toBe(201);
    expect(sqlite.prepare("SELECT count(*) AS count FROM release_artifact_attestations").get()).toEqual({ count: 1 });
  });

  it("replaces an expired signing request", async () => {
    const first = await prepare();
    sqlite.prepare("UPDATE release_artifact_attestation_requests SET expires_at = 0").run();
    const second = await prepare();
    expect(second.response.status).toBe(201);
    expect(second.body.request.id).not.toBe(first.body.request.id);
  });

  it("rejects identity drift before admitting the signature", async () => {
    const prepared = await prepare();
    sqlite.prepare("UPDATE builds SET version_name = '1.0.1'").run();
    const response = await submit(prepared.body.request.id, prepared.body.request.payload_b64url);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_IDENTITY_DRIFT" });
  });

  it("rejects replay after a request has been consumed", async () => {
    const prepared = await prepare();
    expect((await submit(prepared.body.request.id, prepared.body.request.payload_b64url)).status).toBe(201);
    expect((await submit(prepared.body.request.id, prepared.body.request.payload_b64url)).status).toBe(404);
  });
});
