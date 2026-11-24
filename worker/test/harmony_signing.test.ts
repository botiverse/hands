import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/routes/agc_testing", () => ({ resolveAgcAppAuth: async () => ({ clientId: "cid", accessToken: "tok" }) }));

const { setSigningContainerForTests, decryptSigningSecret } = await import("../src/lib/signing");
const h = await import("../src/routes/harmony_signing");

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = db.prepare(sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; }));
    const bind = (...input: unknown[]) => {
      const params = (indexes.length ? indexes.map((i) => input[i - 1]) : input).map((v) => v === undefined ? null : v);
      const execute = () => statement.reader
        ? { results: statement.all(...params), success: true as const, meta: { changes: 0 } }
        : { results: [], success: true as const, meta: { changes: statement.run(...params).changes } };
      return { _execute: execute, run: async () => execute(), all: async () => execute(), first: async <T>() => (statement.get(...params) as T | undefined) ?? null };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: <T>() => bind().first<T>() };
  };
  return { prepare, batch: async (sts: { _execute: () => unknown }[]) => db.transaction(() => sts.map((s) => s._execute()))() };
}

function environment() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  sqlite.prepare(`INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org','org','Org','raft','s1',1)`).run();
  sqlite.prepare(`INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org2','org2','Org2','raft','s2',1)`).run();
  sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES ('app', 'org', 'raft-deck-ohos', 'Raft Deck', 'ohos', 1)`).run();
  sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES ('android', 'org', 'raft-deck-android', 'Deck', 'android', 1)`).run();
  sqlite.prepare(`INSERT INTO channels (id, app_id, slug, name, bundle_id, created_at) VALUES ('ch', 'app', 'main', 'Main', 'build.raft.deck', 1)`).run();
  const objects = new Map<string, number>();
  const env = {
    DB: d1(sqlite), ASC_CRED_ENC_KEY: "test-master-key", AGC_CRED_ENC_KEY: "k",
    R2_ACCOUNT_ID: "acct", R2_BUCKET_NAME: "bucket", R2_S3_ACCESS_KEY_ID: "AKID", R2_S3_SECRET_ACCESS_KEY: "secret",
    APK_BUCKET: { head: async (key: string) => (objects.has(key) ? { size: objects.get(key) } : null), delete: async (key: string) => { objects.delete(key); } },
  } as unknown as Env;
  return { sqlite, env, objects };
}

async function call(handler: (c: any) => Promise<Response>, env: Env, params: Record<string, string>, body: unknown = {}) {
  const c = {
    env, req: { param: (n: string) => params[n] ?? "", json: async () => body, query: () => undefined, header: () => undefined },
    json: (data: unknown, s = 200) => new Response(JSON.stringify(data), { status: s }),
    get: (key: string) => (key === "admin_actor" ? "tester" : undefined),
  } as any;
  const response = await handler(c);
  return { status: response.status, body: await response.json() as any };
}

type AgcCall = { url: string; method: string; body: any; headers: Record<string, string> };
function huawei(handlers: Record<string, (body: any) => unknown>) {
  const calls: AgcCall[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("https://download.agc.test/")) return new Response(new TextEncoder().encode(url.endsWith(".p7b") ? "P7B-BYTES" : "CERT-PEM"));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method: init.method ?? "GET", body, headers });
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
    const handler = handlers[key];
    if (!handler) return Response.json({ ret: { code: 1, msg: `unexpected ${key}` } }, { status: 500 });
    return Response.json(handler(body));
  });
  return calls;
}

afterEach(() => { setSigningContainerForTests(null); vi.unstubAllGlobals(); });

describe("Hands-managed HarmonyOS signing", () => {
  it("makes a key in the container, has AGC issue the certificate, and stores it encrypted", async () => {
    const { env, sqlite } = environment();
    const container: string[] = [];
    setSigningContainerForTests(async (path, body: any) => {
      container.push(path);
      if (path === "/signing/harmony-csr") return Response.json({ key_pem: "KEY", csr_pem: "CSR" });
      expect(atob(body.certificate_b64)).toBe("CERT-PEM");
      return Response.json({ chain_pem: "CHAIN", metadata: { subject: "CN=Raft Deck", key_algorithm: "ECDSA P-256" } });
    });
    const calls = huawei({
      "POST /api/publish/v3/cert": () => ({ ret: { code: 0 }, certInfo: { id: "cert-1", certName: "Deck release", certType: 2, expireTime: 2e12, certDownloadUrl: "https://download.agc.test/c.cer?sig=x" } }),
    });
    const res = await call(h.handleCreateHarmonyIdentity, env, { orgId: "org" }, { name: "Deck release", kind: "release", agc_from_app: "raft-deck-ohos" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.identity).toMatchObject({ name: "Deck release", kind: "release", agc_cert_id: "cert-1", metadata: { key_algorithm: "ECDSA P-256" } });
    expect(container).toEqual(["/signing/harmony-csr", "/signing/harmony-certificate"]);
    expect(calls[0]).toMatchObject({ method: "POST", body: { csr: "CSR", certName: "Deck release", certType: 2 }, headers: { client_id: "cid", authorization: "Bearer tok" } });
    const row = sqlite.prepare("SELECT * FROM harmony_signing_identities").get() as any;
    expect(row.secret_ciphertext_b64).not.toContain("KEY");
    expect(await decryptSigningSecret(row, "test-master-key")).toEqual({ kind: "harmony", key_pem: "KEY", chain_pem: "CHAIN" });
    // An app of another organization cannot lend its credentials.
    expect((await call(h.handleCreateHarmonyIdentity, env, { orgId: "org2" }, { name: "x", kind: "debug", agc_from_app: "raft-deck-ohos" })).status).toBe(400);
  });

  it("finds or creates the AGC app, registers devices, and issues a profile that replaces the previous one", async () => {
    const { env, sqlite } = environment();
    sqlite.prepare(`INSERT INTO harmony_signing_identities (id, org_id, name, cert_kind, agc_cert_id, metadata_json, secret_ciphertext_b64, secret_iv_b64, created_by_actor, created_at)
      VALUES ('id-debug', 'org', 'Deck debug', 'debug', 'cert-d', '{}', 'x', 'y', 't', 1)`).run();
    let exists = false;
    const calls = huawei({
      "GET /api/publish/v2/appid-list": () => (exists ? { ret: { code: 0 }, appids: [{ key: "build.raft.deck", value: "agc-app-1" }] } : { ret: { code: 0 }, appids: [] }),
      "POST /api/publish/v3/app": () => { exists = true; return { ret: { code: 0 }, appId: "agc-app-1" }; },
      "POST /api/publish/v2/device": () => ({ ret: { code: 0 }, successedCount: 1, failedCount: 0 }),
      "GET /api/publish/v2/device/list": () => ({ ret: { code: 0 }, totalCount: 1, deviceList: [{ id: "dev-1", deviceName: "Mate 60", udid: "A".repeat(64), deviceType: 4 }] }),
      "POST /api/publish/v3/provision": (b) => ({ ret: { code: 0 }, provisionInfo: { id: `prov-${b.deviceIdList.join("")}`, provisionType: 1, appId: b.appId, provisionDownloadUrl: "https://download.agc.test/p.p7b", expireTime: 3e12, deviceList: [{ id: "dev-1" }] } }),
    });
    const created = await call(h.handleEnsureHarmonyAgcApp, env, { appId: "app" });
    expect(created).toMatchObject({ status: 201, body: { agc_app_id: "agc-app-1", package_name: "build.raft.deck", created: true } });
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ appName: "Raft Deck", packageName: "build.raft.deck", parentType: 13, installationFree: 0 });
    expect((await call(h.handleEnsureHarmonyAgcApp, env, { appId: "app" })).body).toMatchObject({ created: false });
    expect((await call(h.handleEnsureHarmonyAgcApp, env, { appId: "android" })).status).toBe(400);

    expect((await call(h.handleAddHarmonyDevices, env, { appId: "app" }, { devices: [{ name: "Mate 60", udid: "not-hex" }] })).status).toBe(400);
    expect((await call(h.handleAddHarmonyDevices, env, { appId: "app" }, { devices: [{ name: "Mate 60", udid: "A".repeat(64) }] })).body)
      .toMatchObject({ added: 1, failed: 0 });
    expect((await call(h.handleListHarmonyDevices, env, { appId: "app" })).body.devices).toEqual([
      { id: "dev-1", name: "Mate 60", udid: "A".repeat(64), type: 4, created_at: null }]);

    expect((await call(h.handleCreateHarmonyProfile, env, { appId: "app" }, { identity_id: "id-debug" })).status).toBe(400);
    const first = await call(h.handleCreateHarmonyProfile, env, { appId: "app" }, { identity_id: "id-debug", device_ids: ["dev1"] });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.profile).toMatchObject({ kind: "debug", agc_app_id: "agc-app-1", agc_profile_id: "prov-dev1", device_ids: ["dev-1"] });
    const provision = calls.filter((c) => c.url.endsWith("/v3/provision")).at(-1)!;
    expect(provision.body).toMatchObject({ provisionType: 1, certId: "cert-d", appId: "agc-app-1", deviceIdList: ["dev1"] });
    await call(h.handleCreateHarmonyProfile, env, { appId: "app" }, { identity_id: "id-debug", device_ids: ["dev2"] });
    const profiles = (await call(h.handleListHarmonyProfiles, env, { appId: "app" })).body.profiles;
    expect(profiles.map((p: any) => [p.agc_profile_id, p.replaced_at === null])).toEqual([["prov-dev2", true], ["prov-dev1", false]]);
    expect((sqlite.prepare("SELECT profile_b64 FROM harmony_signing_profiles LIMIT 1").get() as any).profile_b64).toBe(btoa("P7B-BYTES"));
  });

  it("passes AGC's own refusal on", async () => {
    const { env } = environment();
    setSigningContainerForTests(async () => Response.json({ key_pem: "KEY", csr_pem: "CSR" }));
    huawei({ "POST /api/publish/v3/cert": () => ({ ret: { code: 204144660, msg: "The number of certificates exceeds the upper limit." } }) });
    const res = await call(h.handleCreateHarmonyIdentity, env, { orgId: "org" }, { name: "Deck release", kind: "release", agc_from_app: "raft-deck-ohos" });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "agc_request_failed", error: expect.stringContaining("The number of certificates exceeds the upper limit.") });
  });

  it("signs an uploaded .hap with the app's current profile and its identity", async () => {
    const { env, sqlite, objects } = environment();
    const { encryptSigningSecret } = await import("../src/lib/signing");
    const enc = await encryptSigningSecret({ kind: "harmony", key_pem: "KEY", chain_pem: "CHAIN" }, "test-master-key");
    sqlite.prepare(`INSERT INTO harmony_signing_identities (id, org_id, name, cert_kind, agc_cert_id, metadata_json, secret_ciphertext_b64, secret_iv_b64, created_by_actor, created_at)
      VALUES ('id-rel', 'org', 'Deck release', 'release', 'cert-r', '{}', ?, ?, 't', 1)`).run(enc.secret_ciphertext_b64, enc.secret_iv_b64);
    const sha = "b".repeat(64);
    const declare = (b: Record<string, unknown>) => call(h.handleCreateHarmonySigningJob, env, { appId: "app" }, b);
    expect((await declare({ kind: "release", artifact_type: "hap", filename: "entry.hap", size: 10, sha256: sha })).body.code).toBe("harmony_profile_missing");
    sqlite.prepare(`INSERT INTO harmony_signing_profiles (id, app_id, identity_id, kind, agc_app_id, agc_profile_id, profile_b64, created_by_actor, created_at)
      VALUES ('prof-1', 'app', 'id-rel', 'release', 'agc-app-1', 'p1', 'UDdC', 't', 1)`).run();
    expect((await declare({ kind: "release", artifact_type: "apk", filename: "x", size: 10, sha256: sha })).status).toBe(400);
    const created = await declare({ kind: "release", artifact_type: "hap", filename: "entry.hap", size: 10, sha256: sha });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.upload_url).toMatch(/^https:\/\//);
    const jobId = created.body.job.id;
    expect((await call(h.handleRunHarmonySigningJob, env, { appId: "app", jobId })).body.job).toMatchObject({ status: "failed", error_code: "signing_input_missing" });

    const again = (await declare({ kind: "release", artifact_type: "hap", filename: "entry.hap", size: 10, sha256: sha })).body.job.id;
    objects.set(`signing/app/harmony/${again}/input`, 10);
    const sent: any[] = [];
    setSigningContainerForTests(async (path, b) => { sent.push({ path, b }); return Response.json({ output_size: 20, output_sha256: "c".repeat(64) }); });
    const signed = await call(h.handleRunHarmonySigningJob, env, { appId: "app", jobId: again });
    expect(signed.body.job).toMatchObject({ status: "succeeded", output_size: 20, output_sha256: "c".repeat(64) });
    expect(signed.body.job.download_url).toMatch(/^https:\/\//);
    expect(sent[0]).toMatchObject({ path: "/signing/sign", b: { artifact_type: "hap", secret: { kind: "harmony", key_pem: "KEY", chain_pem: "CHAIN" },
      harmony_profile_b64: "UDdC", sign_code: true, expected_input_sha256: sha } });
    expect(objects.has(`signing/app/harmony/${again}/input`)).toBe(false);
    // Signing again returns the finished job; nothing is signed twice.
    await call(h.handleRunHarmonySigningJob, env, { appId: "app", jobId: again });
    expect(sent).toHaveLength(1);
  });
});