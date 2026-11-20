/**
 * Signing service through the real handlers on the real migration chain. The
 * container is replaced by a recorder (its signing tools are exercised by the
 * container's own tests and by a local image run); everything else is
 * production code, including encryption at rest.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleCreateSigningJob,
  handleExportSigningIdentityBackup,
  handleGenerateAndroidSigningIdentity,
  handleGetSigningJob,
  handleGrantSigningIdentity,
  handleListSigningApiKeySources,
  handleListSigningIdentities,
  handleRevokeSigningIdentity,
  handleRunSigningJob,
  handleUngrantSigningIdentity,
  handleUploadSigningIdentity,
  handleGenerateAppleIosSigningIdentity,
  handleCreateSigningCertificateRequest,
  handleListSigningCertificateRequests,
  handleCompleteSigningCertificateRequest,
  handleCancelSigningCertificateRequest,
  handleAppleAppId,
} from "../src/routes/signing";
import { setSigningContainerForTests } from "../src/lib/signing";
import { storeAscCredentials } from "../src/lib/asc_credentials";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const ORG = "org";
const APP = "app-deck";
const SHA = "a".repeat(64);

function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; });
    const statement = db.prepare(normalized);
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
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  sqlite.prepare(`INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES (?, ?, ?, 'raft', ?, 1)`).run(ORG, ORG, "Org", "s1");
  sqlite.prepare(`INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org2','org2','Org2','raft','s2',1)`).run();
  sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES (?, ?, 'raft-deck-android', 'Deck', 'android', 'ck', 1)`).run(APP, ORG);
  sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES ('app-mac', ?, 'raft-deck', 'Deck Mac', 'electron', 'ck2', 2)`).run(ORG);
  sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES ('app-foreign', 'org2', 'other', 'Other', 'android', 'ck3', 1)`).run();
  const objects = new Map<string, number>();
  const env = {
    DB: d1(sqlite),
    ASC_CRED_ENC_KEY: "test-master-key",
    R2_ACCOUNT_ID: "acct",
    R2_BUCKET_NAME: "bucket",
    R2_S3_ACCESS_KEY_ID: "AKID",
    R2_S3_SECRET_ACCESS_KEY: "secret",
    APK_BUCKET: {
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key) } : null),
      delete: async (key: string) => { objects.delete(key); },
    },
  } as unknown as Env;
  return { sqlite, env, objects };
}

async function call(handler: (c: any) => Promise<Response>, env: Env, params: Record<string, string>, body: unknown = {}) {
  const c = {
    env,
    req: { param: (n: string) => params[n] ?? "", json: async () => body, query: () => undefined },
    json: (data: unknown, s = 200) => new Response(JSON.stringify(data), { status: s }),
    get: (key: string) => (key === "admin_actor" ? "tester" : undefined),
  } as any;
  const response = await handler(c);
  return { status: response.status, body: await response.json() as any };
}

type Call = { path: string; body: any };
function recorder(reply: (path: string, body: any) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  setSigningContainerForTests(async (path, body) => {
    calls.push({ path, body });
    const r = reply(path, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return calls;
}

const ANDROID_META = { subject: "CN=Deck", sha256_fingerprint: "ff".repeat(32), not_after: "2056", key_alias: "release" };

afterEach(() => {
  setSigningContainerForTests(null);
  vi.unstubAllGlobals();
});

async function uploadAndroid(env: Env, extra: Record<string, unknown> = {}) {
  return call(handleUploadSigningIdentity, env, { orgId: ORG }, {
    kind: "android_keystore", name: "Deck release", keystore_b64: "QUJD", store_password: "storepw-secret", key_alias: "release", ...extra,
  });
}

describe("signing identities", () => {
  it("stores an uploaded key encrypted, verified by the container, and never returns key material", async () => {
    const { env, sqlite } = environment();
    const calls = recorder(() => ({ body: { metadata: ANDROID_META } }));
    const created = await uploadAndroid(env);
    expect(created.status).toBe(201);
    expect(calls[0]).toMatchObject({ path: "/signing/inspect", body: { secret: { kind: "android_keystore", store_password: "storepw-secret", key_password: "storepw-secret" } } });
    const row = sqlite.prepare("SELECT * FROM signing_identities").get() as any;
    expect(row.secret_ciphertext_b64).not.toContain("storepw");
    expect(Buffer.from(row.secret_ciphertext_b64, "base64").toString("latin1")).not.toContain("storepw-secret");
    expect(JSON.stringify(created.body)).not.toContain("storepw");
    expect(JSON.stringify(created.body)).not.toContain("QUJD");
    const listed = await call(handleListSigningIdentities, env, { orgId: ORG });
    expect(listed.body.signing_identities).toHaveLength(1);
    expect(listed.body.signing_identities[0]).toMatchObject({ kind: "android_keystore", origin: "uploaded", metadata: ANDROID_META, apps: [] });
    expect(JSON.stringify(listed.body)).not.toContain("storepw");
    // Other orgs see nothing.
    expect((await call(handleListSigningIdentities, env, { orgId: "org2" })).body.signing_identities).toHaveLength(0);
  });

  it("rejects bad input and a key the container cannot open", async () => {
    const { env } = environment();
    recorder(() => ({ status: 400, body: { error: "keystore, password or alias is wrong", code: "signing_identity_invalid" } }));
    expect((await uploadAndroid(env)).body.code).toBe("signing_identity_invalid");
    expect((await uploadAndroid(env, { keystore_b64: "not base64!" })).status).toBe(400);
    expect((await uploadAndroid(env, { key_alias: "-J-Dx=1" })).status).toBe(400);
    expect((await uploadAndroid(env, { key_alias: "a b" })).status).toBe(400);
    expect((await uploadAndroid(env, { key_alias: "-Jfoo" })).status).toBe(400);
    expect((await call(handleUploadSigningIdentity, env, { orgId: ORG }, { kind: "windows", name: "x" })).status).toBe(400);
    expect((await call(handleUploadSigningIdentity, env, { orgId: ORG }, {
      kind: "apple_developer_id", name: "Dev ID", p12_b64: "QUJD", p12_password: "x", notary: { key_id: "K", issuer_id: "I", p8: "nope" },
    })).status).toBe(400);
  });

  it("reuses an app's App Store Connect key for notarization and iOS profiles", async () => {
    const { env, sqlite } = environment();
    const p8 = "-----BEGIN PRIVATE KEY-----\nTEAMKEYMATERIAL\n-----END PRIVATE KEY-----";
    await storeAscCredentials(env.DB, "test-master-key", { app_id: "app-mac", key_id: "TEAMKEY1", issuer_id: "ISS-1", p8, actor: "t" });
    await storeAscCredentials(env.DB, "test-master-key", { app_id: "app-foreign", key_id: "OTHER", issuer_id: "ISS-2", p8, actor: "t" });

    // The picker lists key ids of this org's apps only, never the key itself.
    const sources = await call(handleListSigningApiKeySources, env, { orgId: ORG });
    expect(sources.body.api_keys).toEqual([expect.objectContaining({ app_id: "app-mac", slug: "raft-deck", key_id: "TEAMKEY1", issuer_id: "ISS-1" })]);
    expect(JSON.stringify(sources.body)).not.toContain("TEAMKEYMATERIAL");

    const calls = recorder((_path, body) => ({ body: { metadata: { subject: "CN=x", notary_key_id: body.secret.notary?.key_id ?? null } } }));
    const devId = await call(handleUploadSigningIdentity, env, { orgId: ORG }, {
      kind: "apple_developer_id", name: "Dev ID", p12_b64: "QUJD", p12_password: "pw", notary: { from_app: "raft-deck" },
    });
    expect(devId.status).toBe(201);
    expect(calls[0]!.body.secret.notary).toEqual({ key_id: "TEAMKEY1", issuer_id: "ISS-1", p8 });
    expect(devId.body.signing_identity.metadata).toMatchObject({ notary_key_id: "TEAMKEY1", api_key_from_app: "raft-deck" });
    expect(JSON.stringify(devId.body)).not.toContain("TEAMKEYMATERIAL");

    // Another org's app, or an app without a key, cannot be the source.
    expect((await call(handleUploadSigningIdentity, env, { orgId: ORG }, {
      kind: "apple_developer_id", name: "Dev ID 2", p12_b64: "QUJD", p12_password: "pw", notary: { from_app: "other" },
    })).body.code).toBe("app_not_in_org");
    expect((await call(handleUploadSigningIdentity, env, { orgId: ORG }, {
      kind: "apple_developer_id", name: "Dev ID 3", p12_b64: "QUJD", p12_password: "pw", notary: { from_app: "raft-deck-android" },
    })).body.code).toBe("asc_credentials_missing");

    // iOS: a profile or an API key (so Hands can create the profile) is required.
    const ios = { kind: "apple_ios_distribution", name: "Deck iOS", p12_b64: "QUJD", p12_password: "pw" };
    expect((await call(handleUploadSigningIdentity, env, { orgId: ORG }, ios)).status).toBe(400);
    const created = await call(handleUploadSigningIdentity, env, { orgId: ORG }, { ...ios, asc: { from_app: "app-mac" } });
    expect(created.status).toBe(201);
    expect(calls.at(-1)!.body.secret).toMatchObject({ kind: "apple_ios_distribution", provisioning_profiles_b64: [], asc: { key_id: "TEAMKEY1", p8 } });
    expect(created.body.signing_identity.metadata).toMatchObject({ asc_key_id: "TEAMKEY1", provisioning_profile_count: 0, api_key_from_app: "raft-deck" });
    const withProfile = await call(handleUploadSigningIdentity, env, { orgId: ORG }, { ...ios, name: "Deck iOS 2", provisioning_profiles_b64: ["UFJPRklMRQ=="] });
    expect(withProfile.body.signing_identity.metadata).toMatchObject({ asc_key_id: null, provisioning_profile_count: 1 });
    const stored = sqlite.prepare("SELECT secret_ciphertext_b64 FROM signing_identities").all() as Array<{ secret_ciphertext_b64: string }>;
    for (const row of stored) expect(Buffer.from(row.secret_ciphertext_b64, "base64").toString("latin1")).not.toContain("TEAMKEYMATERIAL");
  });

  it("generates an Android key in Hands and gives out its backup once", async () => {
    const { env, sqlite } = environment();
    recorder((path) => path === "/signing/generate-android"
      ? { body: { secret: { kind: "android_keystore", keystore_b64: "R0VO", store_password: "gen-pw", key_alias: "release", key_password: "gen-pw" }, metadata: ANDROID_META } }
      : { body: { metadata: ANDROID_META } });
    const generated = await call(handleGenerateAndroidSigningIdentity, env, { orgId: ORG }, { name: "Deck Android" });
    expect(generated.status).toBe(201);
    expect(generated.body.signing_identity).toMatchObject({ origin: "generated", backup_exported_at: null });
    const id = generated.body.signing_identity.id;
    const backup = await call(handleExportSigningIdentityBackup, env, { orgId: ORG, identityId: id });
    expect(backup.body).toMatchObject({ keystore_b64: "R0VO", store_password: "gen-pw", key_alias: "release", format: "PKCS12" });
    // A lost response can be retried for a short while, then the backup is gone.
    expect((await call(handleExportSigningIdentityBackup, env, { orgId: ORG, identityId: id })).status).toBe(200);
    sqlite.prepare("UPDATE signing_identities SET backup_exported_at = ? WHERE id = ?").run(Date.now() - 11 * 60 * 1000, id);
    const again = await call(handleExportSigningIdentityBackup, env, { orgId: ORG, identityId: id });
    expect([again.status, again.body.code]).toEqual([409, "backup_already_exported"]);
    const uploaded = await uploadAndroid(env);
    expect((await call(handleExportSigningIdentityBackup, env, { orgId: ORG, identityId: uploaded.body.signing_identity.id })).body.code).toBe("backup_not_available");
    expect((await call(handleExportSigningIdentityBackup, env, { orgId: "org2", identityId: id })).status).toBe(404);
  });

  it("grants only to apps of the same org", async () => {
    const { env } = environment();
    recorder(() => ({ body: { metadata: ANDROID_META } }));
    const id = (await uploadAndroid(env)).body.signing_identity.id;
    expect((await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: "app-foreign" })).body.code).toBe("app_not_in_org");
    expect((await call(handleGrantSigningIdentity, env, { orgId: "org2", identityId: id, appId: "app-foreign" })).status).toBe(404);
    const granted = await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: APP });
    expect(granted.body.signing_identity.apps).toEqual([{ app_id: APP, slug: "raft-deck-android" }]);
    expect((await call(handleUngrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: APP })).body.signing_identity.apps).toEqual([]);
  });
});

describe("signing jobs", () => {
  async function grantedAndroid() {
    const ctx = environment();
    recorder(() => ({ body: { metadata: ANDROID_META } }));
    const id = (await uploadAndroid(ctx.env)).body.signing_identity.id;
    await call(handleGrantSigningIdentity, ctx.env, { orgId: ORG, identityId: id, appId: APP });
    return { ...ctx, identityId: id };
  }
  const jobBody = (extra: Record<string, unknown> = {}) => ({ artifact_type: "apk", filename: "app-release.apk", size: 1234, sha256: SHA, ...extra });

  it("signs an uploaded APK with the granted key and returns a verified download", async () => {
    const { env, sqlite, objects, identityId } = await grantedAndroid();
    const created = await call(handleCreateSigningJob, env, { appId: APP }, jobBody());
    expect(created.status).toBe(201);
    expect(created.body.upload_url).toContain("X-Amz-Signature");
    expect(created.body.job).toMatchObject({ status: "awaiting_upload", identity_id: identityId });
    const jobId = created.body.job.id;

    // Not uploaded yet: the job fails and says so.
    const early = await call(handleRunSigningJob, env, { appId: APP, jobId });
    expect(early.body.job).toMatchObject({ status: "failed", error_code: "signing_input_missing" });

    const second = (await call(handleCreateSigningJob, env, { appId: APP }, jobBody())).body.job.id;
    objects.set(`signing/${APP}/${second}/input`, 1234);
    const calls = recorder(() => ({ body: { output_size: 1300, output_sha256: "b".repeat(64), notary_submission_id: null } }));
    const run = await call(handleRunSigningJob, env, { appId: APP, jobId: second });
    expect(run.body.job).toMatchObject({ status: "succeeded", output_sha256: "b".repeat(64) });
    expect(run.body.job.download_url).toContain("X-Amz-Signature");
    expect(calls[0]!.path).toBe("/signing/sign");
    expect(calls[0]!.body).toMatchObject({ artifact_type: "apk", expected_input_sha256: SHA, secret: { kind: "android_keystore", store_password: "storepw-secret" } });
    // Running again is a no-op on a finished job.
    await call(handleRunSigningJob, env, { appId: APP, jobId: second });
    expect(calls).toHaveLength(1);
    const audit = sqlite.prepare("SELECT action, payload FROM audit_logs WHERE app_id = ? AND action LIKE 'signing_job.%' ORDER BY created_at").all(APP) as any[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["signing_job.create", "signing_job.sign", "signing_job.fail"]));
    expect(audit.map((a) => a.payload).join("")).not.toContain("storepw");
  });

  it("refuses ungranted, mismatched, revoked and unsupported requests", async () => {
    const { env, sqlite, objects, identityId } = await grantedAndroid();
    expect((await call(handleCreateSigningJob, env, { appId: "app-mac" }, jobBody())).body.code).toBe("signing_identity_not_granted");
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ artifact_type: "macos", filename: "x.app.zip" }))).body.code).toBe("signing_identity_not_granted");
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ artifact_type: "ipa" }))).body.code).toBe("signing_identity_not_granted");
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ notarize: true }))).status).toBe(400);
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ sha256: "x" }))).status).toBe(400);
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ size: 0 }))).status).toBe(400);
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ filename: "../x" }))).status).toBe(400);

    // Two granted keys: the caller must choose.
    const other = (await uploadAndroid(env)).body.signing_identity.id;
    await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: other, appId: APP });
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody())).body.code).toBe("signing_identity_ambiguous");
    const chosen = await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ identity_id: identityId }));
    expect(chosen.status).toBe(201);

    // Size mismatch with the declared size.
    objects.set(`signing/${APP}/${chosen.body.job.id}/input`, 99);
    expect((await call(handleRunSigningJob, env, { appId: APP, jobId: chosen.body.job.id })).body.job.error_code).toBe("signing_input_mismatch");

    // Revoked after the job was created: signing refuses.
    const late = (await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ identity_id: identityId }))).body.job.id;
    objects.set(`signing/${APP}/${late}/input`, 1234);
    await call(handleRevokeSigningIdentity, env, { orgId: ORG, identityId });
    const calls = recorder(() => ({ body: {} }));
    expect((await call(handleRunSigningJob, env, { appId: APP, jobId: late })).body.job.error_code).toBe("signing_identity_revoked");
    expect(calls).toHaveLength(0);
    // An app moved to another org keeps none of the old org's keys, even if a grant row lingers.
    recorder(() => ({ body: { metadata: ANDROID_META } }));
    const fresh = (await uploadAndroid(env)).body.signing_identity.id;
    await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: fresh, appId: APP });
    sqlite.prepare("UPDATE apps SET org_id = 'org2' WHERE id = ?").run(APP);
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ identity_id: fresh }))).body.code).toBe("signing_identity_not_granted");
    expect((await call(handleListSigningIdentities, env, { orgId: ORG })).body.signing_identities.find((i: any) => i.id === fresh).apps).toEqual([]);
    sqlite.prepare("UPDATE apps SET org_id = ? WHERE id = ?").run(ORG, APP);
    // Jobs are app-scoped.
    expect((await call(handleGetSigningJob, env, { appId: "app-mac", jobId: late })).status).toBe(404);
  });

  it("fails a job whose signing request was lost", async () => {
    const { env, sqlite, objects } = await grantedAndroid();
    const jobId = (await call(handleCreateSigningJob, env, { appId: APP }, jobBody())).body.job.id;
    objects.set(`signing/${APP}/${jobId}/input`, 1234);
    sqlite.prepare("UPDATE signing_jobs SET status = 'signing', updated_at = ? WHERE id = ?").run(Date.now() - 10 * 60 * 1000, jobId);
    expect((await call(handleGetSigningJob, env, { appId: APP, jobId })).body.job.status).toBe("signing");
    sqlite.prepare("UPDATE signing_jobs SET updated_at = ? WHERE id = ?").run(Date.now() - 31 * 60 * 1000, jobId);
    expect((await call(handleGetSigningJob, env, { appId: APP, jobId })).body.job).toMatchObject({ status: "failed", error_code: "signing_interrupted" });
  });

  it("re-signs an IPA with an App Store profile found or created through App Store Connect", async () => {
    const { env, objects, sqlite } = environment();
    const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const p8 = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey) as ArrayBuffer).toString("base64")}\n-----END PRIVATE KEY-----`;
    const certDer = Buffer.from("distribution-cert-der");
    const fingerprint = (await import("node:crypto")).createHash("sha256").update(certDer).digest("hex");
    recorder(() => ({ body: { metadata: { subject: "CN=Apple Distribution: Botiverse (XDAPXFY8FZ)", team_id: "XDAPXFY8FZ", sha256_fingerprint: fingerprint } } }));
    const id = (await call(handleUploadSigningIdentity, env, { orgId: ORG }, {
      kind: "apple_ios_distribution", name: "Deck iOS", p12_b64: "QUJD", p12_password: "pw", asc: { key_id: "KEY1", issuer_id: "ISS", p8 },
    })).body.signing_identity.id;
    sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES ('app-ios', ?, 'raft-deck-ios', 'Deck iOS', 'ios', 'ck4', 3)`).run(ORG);
    await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: "app-ios" });

    // App Store Connect: the App ID and certificate exist; one stale profile, then a fresh one is created.
    const apple: Array<{ method: string; path: string; body?: any }> = [];
    let appIdRegistered = true;
    let existingProfile: "none" | "fresh" = "none";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace("https://api.appstoreconnect.apple.com", "");
      apple.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const json = (data: unknown) => new Response(JSON.stringify(data));
      if (path.startsWith("/v1/bundleIds?")) {
        return json({ data: appIdRegistered ? [
          { id: "B-WIDGET", type: "bundleIds", attributes: { identifier: "build.raft.deck.widget", platform: "IOS" } },
          { id: "B1", type: "bundleIds", attributes: { identifier: "build.raft.deck", platform: "IOS" } },
        ] : [] });
      }
      if (path.startsWith("/v1/certificates?")) {
        return json({ data: [
          { id: "C-OTHER", type: "certificates", attributes: { certificateType: "DISTRIBUTION", certificateContent: Buffer.from("other").toString("base64") } },
          { id: "C1", type: "certificates", attributes: { certificateType: "DISTRIBUTION", certificateContent: certDer.toString("base64") } },
        ] });
      }
      if (path.startsWith("/v1/bundleIds/B1/profiles")) {
        const soon = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
        const later = new Date(Date.now() + 300 * 24 * 3600 * 1000).toISOString();
        return json({ data: [
          { id: "P-SOON", type: "profiles", attributes: { name: "expiring", profileType: "IOS_APP_STORE", profileState: "ACTIVE", profileContent: "U09PTg==", expirationDate: soon } },
          { id: "P-DEV", type: "profiles", attributes: { name: "dev", profileType: "IOS_APP_DEVELOPMENT", profileState: "ACTIVE", profileContent: "REVW", expirationDate: later } },
          ...(existingProfile === "fresh" ? [{ id: "P-NEW", type: "profiles", attributes: { name: "Hands", profileType: "IOS_APP_STORE", profileState: "ACTIVE", profileContent: "TkVX", expirationDate: later } }] : []),
        ] });
      }
      if (path.startsWith("/v1/profiles/P-NEW/relationships/certificates")) return json({ data: [{ type: "certificates", id: "C1" }] });
      if (path === "/v1/profiles" && init.method === "POST") {
        return new Response(JSON.stringify({ data: { id: "P-NEW", type: "profiles", attributes: {
          name: "Hands build.raft.deck App Store", profileType: "IOS_APP_STORE", profileState: "ACTIVE", profileContent: "TkVX", expirationDate: "2027-11-20T00:00:00Z",
        } } }), { status: 201 });
      }
      return new Response(JSON.stringify({ errors: [{ title: "unexpected" }] }), { status: 404 });
    }));

    const runJob = async () => {
      const created = await call(handleCreateSigningJob, env, { appId: "app-ios" }, { artifact_type: "ipa", filename: "Deck.ipa", size: 10, sha256: SHA });
      expect(created.status).toBe(201);
      const jobId = created.body.job.id;
      objects.set(`signing/app-ios/${jobId}/input`, 10);
      const calls = recorder((path) => path === "/signing/ipa-info"
        ? { body: { bundle_id: "build.raft.deck", version: "1.0", build: "7", extensions: [] } }
        : { body: { output_size: 11, output_sha256: "e".repeat(64), notary_submission_id: null, ios: { bundle_id: "build.raft.deck", profile: { name: "Hands" } } } });
      const signed = await call(handleRunSigningJob, env, { appId: "app-ios", jobId }, { entitlements_b64: "PHBsaXN0Lz4=" });
      return { signed, calls };
    };

    const first = await runJob();
    expect(first.signed.body.job).toMatchObject({ status: "succeeded", artifact_type: "ipa" });
    expect(first.calls.map((c) => c.path)).toEqual(["/signing/ipa-info", "/signing/sign"]);
    expect(first.calls[1]!.body).toMatchObject({ artifact_type: "ipa", provisioning_profile_b64: "TkVX", entitlements_b64: "PHBsaXN0Lz4=" });
    const created = apple.find((a) => a.method === "POST")!;
    expect(created.body.data.attributes.profileType).toBe("IOS_APP_STORE");
    expect(created.body.data.relationships).toEqual({ bundleId: { data: { type: "bundleIds", id: "B1" } }, certificates: { data: [{ type: "certificates", id: "C1" }] } });

    // The next build reuses the profile instead of creating another.
    existingProfile = "fresh";
    apple.length = 0;
    const second = await runJob();
    expect(second.calls[1]!.body.provisioning_profile_b64).toBe("TkVX");
    expect(apple.some((a) => a.method === "POST")).toBe(false);
    const actions = (sqlite.prepare("SELECT action FROM audit_logs WHERE action LIKE 'signing_profile.%' ORDER BY created_at").all() as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toEqual(["signing_profile.create", "signing_profile.reuse"]);

    // Without a registered App ID the job fails with what to do, and nothing is signed.
    appIdRegistered = false;
    const third = await runJob();
    expect(third.signed.body.job).toMatchObject({ status: "failed", error_code: "signing_app_id_missing" });
    expect(third.signed.body.job.error_message).toContain("build.raft.deck");
    expect(third.calls.map((c) => c.path)).toEqual(["/signing/ipa-info"]);
  });

  it("notarizes a macOS app: polls Apple, staples when accepted, fails when rejected", async () => {
    const { env, objects } = environment();
    const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey) as ArrayBuffer).toString("base64");
    const p8 = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`;
    recorder(() => ({ body: { metadata: { subject: "CN=Developer ID Application: X (TEAM123456)", team_id: "TEAM123456", notary_key_id: "KEY1" } } }));
    const id = (await call(handleUploadSigningIdentity, env, { orgId: ORG }, {
      kind: "apple_developer_id", name: "Dev ID", p12_b64: "QUJD", p12_password: "pw", notary: { key_id: "KEY1", issuer_id: "ISS", p8 },
    })).body.signing_identity.id;
    await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: "app-mac" });

    const created = await call(handleCreateSigningJob, env, { appId: "app-mac" }, { artifact_type: "macos", filename: "Deck.app.zip", size: 10, sha256: SHA, notarize: true });
    const jobId = created.body.job.id;
    objects.set(`signing/app-mac/${jobId}/input`, 10);
    const calls = recorder((path) => path === "/signing/sign"
      ? { body: { output_size: 11, output_sha256: "c".repeat(64), notary_submission_id: "11111111-2222-3333-4444-555555555555" } }
      : { body: { output_size: 12, output_sha256: "d".repeat(64) } });
    const signed = await call(handleRunSigningJob, env, { appId: "app-mac", jobId }, { entitlements_b64: "PHBsaXN0Lz4=" });
    expect(signed.body.job).toMatchObject({ status: "notarizing", notary_status: "In Progress" });
    expect(signed.body.job.download_url).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({ notarize: true, entitlements_b64: "PHBsaXN0Lz4=" });

    let appleStatus = "In Progress";
    const appleCalls: string[] = [];
    let appleDown = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      appleCalls.push(String(url));
      if (appleDown) throw new TypeError("network down");
      expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^Bearer ey/);
      return new Response(JSON.stringify({ data: { attributes: { status: appleStatus } } }));
    }));
    expect((await call(handleGetSigningJob, env, { appId: "app-mac", jobId })).body.job.status).toBe("notarizing");
    // A network failure talking to Apple is not a verdict.
    appleDown = true;
    expect((await call(handleGetSigningJob, env, { appId: "app-mac", jobId })).body.job.status).toBe("notarizing");
    appleDown = false;
    appleStatus = "Accepted";
    const done = await call(handleGetSigningJob, env, { appId: "app-mac", jobId });
    expect(done.body.job).toMatchObject({ status: "succeeded", output_sha256: "d".repeat(64), notary_status: "Accepted" });
    expect(calls.map((c) => c.path)).toEqual(["/signing/sign", "/signing/staple"]);
    expect(appleCalls[0]).toBe("https://appstoreconnect.apple.com/notary/v2/submissions/11111111-2222-3333-4444-555555555555");

    // A rejected submission fails the job.
    const second = await call(handleCreateSigningJob, env, { appId: "app-mac" }, { artifact_type: "macos", filename: "Deck.app.zip", size: 10, sha256: SHA, notarize: true });
    objects.set(`signing/app-mac/${second.body.job.id}/input`, 10);
    await call(handleRunSigningJob, env, { appId: "app-mac", jobId: second.body.job.id });
    appleStatus = "Invalid";
    const failed = await call(handleGetSigningJob, env, { appId: "app-mac", jobId: second.body.job.id });
    expect(failed.body.job).toMatchObject({ status: "failed", error_code: "signing_notary_rejected" });
    // A finished job is never turned into a failure later.
    expect((await call(handleGetSigningJob, env, { appId: "app-mac", jobId })).body.job.status).toBe("succeeded");
    // The unstapled output was removed after stapling.
    expect(objects.has(`signing/app-mac/${jobId}/input`)).toBe(false);
  });
});

describe("Apple keys made in Hands", () => {
  async function ecP8() {
    const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey) as ArrayBuffer).toString("base64")}\n-----END PRIVATE KEY-----`;
  }
  const KEY_PEM = "-----BEGIN PRIVATE KEY-----\nGENERATEDKEYMATERIAL\n-----END PRIVATE KEY-----\n";
  const CSR_PEM = "-----BEGIN CERTIFICATE REQUEST-----\nCSR\n-----END CERTIFICATE REQUEST-----\n";
  function container(kindSubject = "CN=Apple Distribution: Botiverse (XDAPXFY8FZ)") {
    return recorder((path, body) => {
      if (path === "/signing/apple-csr") return { body: { key_pem: KEY_PEM, csr_pem: CSR_PEM } };
      if (path === "/signing/apple-p12") {
        if (body.certificate_b64 === "WRONG") return { status: 400, body: { error: "issued for a different request", code: "signing_certificate_mismatch" } };
        return { body: { secret: { kind: body.kind, p12_b64: "UDEy", p12_password: "joined-pw" }, metadata: { subject: kindSubject, team_id: "XDAPXFY8FZ" } } };
      }
      return { status: 500, body: {} };
    });
  }

  it("creates an iOS Distribution certificate through App Store Connect, key kept in Hands", async () => {
    const { env, sqlite } = environment();
    const p8 = await ecP8();
    await storeAscCredentials(env.DB, "test-master-key", { app_id: "app-mac", key_id: "TEAMKEY1", issuer_id: "ISS-1", p8, actor: "t" });
    const calls = container();
    const apple: Array<{ method: string; path: string; body?: any }> = [];
    let reply: () => Response = () => new Response(JSON.stringify({ data: { id: "CERT-1", type: "certificates", attributes: { certificateType: "DISTRIBUTION", certificateContent: "Q0VSVA==" } } }), { status: 201 });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      apple.push({ method: init.method ?? "GET", path: String(url).replace("https://api.appstoreconnect.apple.com", ""), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return reply();
    }));

    const made = await call(handleGenerateAppleIosSigningIdentity, env, { orgId: ORG }, { name: "Botiverse, Inc. iOS", asc: { from_app: "raft-deck" } });
    expect(made.status).toBe(201);
    expect(apple[0]).toEqual({ method: "POST", path: "/v1/certificates", body: { data: { type: "certificates", attributes: { certificateType: "DISTRIBUTION", csrContent: CSR_PEM } } } });
    expect(calls.map((x) => x.path)).toEqual(["/signing/apple-csr", "/signing/apple-p12"]);
    expect(calls[1]!.body).toMatchObject({ kind: "apple_ios_distribution", key_pem: KEY_PEM, certificate_b64: "Q0VSVA==" });
    expect(made.body.signing_identity).toMatchObject({
      kind: "apple_ios_distribution", origin: "generated",
      metadata: { team_id: "XDAPXFY8FZ", asc_key_id: "TEAMKEY1", api_key_from_app: "raft-deck", apple_certificate_id: "CERT-1" },
    });
    expect(JSON.stringify(made.body)).not.toContain("GENERATEDKEYMATERIAL");
    const row = sqlite.prepare("SELECT secret_ciphertext_b64 FROM signing_identities").get() as { secret_ciphertext_b64: string };
    expect(Buffer.from(row.secret_ciphertext_b64, "base64").toString("latin1")).not.toContain("GENERATEDKEYMATERIAL");

    // The team is at Apple's limit, or the key's role cannot create certificates.
    reply = () => new Response(JSON.stringify({ errors: [{ status: "409", code: "ENTITY_ERROR", title: "There is a problem with the request entity", detail: "You already have a current Distribution certificate or a pending certificate request." }] }), { status: 409 });
    const limit = await call(handleGenerateAppleIosSigningIdentity, env, { orgId: ORG }, { name: "Team iOS 2", asc: { from_app: "raft-deck" } });
    expect(limit.body.code).toBe("apple_certificate_limit");
    expect(limit.body.error).toMatch(/revoke an unused one/);
    reply = () => new Response(JSON.stringify({ errors: [{ status: "403", title: "Forbidden" }] }), { status: 403 });
    expect((await call(handleGenerateAppleIosSigningIdentity, env, { orgId: ORG }, { name: "Team iOS 3", asc: { from_app: "raft-deck" } })).body.error).toMatch(/Admin role/);
    expect((await call(handleGenerateAppleIosSigningIdentity, env, { orgId: ORG }, { name: "No key" })).status).toBe(400);

    // Issued but not storable (the container refuses): the certificate is revoked again.
    reply = () => new Response(JSON.stringify({ data: { id: "CERT-2", type: "certificates", attributes: { certificateContent: "WRONG" } } }), { status: 201 });
    apple.length = 0;
    const lost = await call(handleGenerateAppleIosSigningIdentity, env, { orgId: ORG }, { name: "Team iOS 4", asc: { from_app: "raft-deck" } });
    expect(lost.body.code).toBe("signing_certificate_mismatch");
    expect(apple.map((x) => `${x.method} ${x.path}`)).toEqual(["POST /v1/certificates", "DELETE /v1/certificates/CERT-2"]);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM signing_identities").get() as { n: number }).n).toBe(1);
  });

  it("makes a certificate request for the Apple Developer site and completes it with the issued certificate", async () => {
    const { env, sqlite } = environment();
    const p8 = await ecP8();
    await storeAscCredentials(env.DB, "test-master-key", { app_id: "app-mac", key_id: "TEAMKEY1", issuer_id: "ISS-1", p8, actor: "t" });
    const calls = container("CN=Developer ID Application: Botiverse (XDAPXFY8FZ)");

    const created = await call(handleCreateSigningCertificateRequest, env, { orgId: ORG }, { kind: "apple_developer_id", name: "Deck Mac", notary: { from_app: "raft-deck" } });
    expect(created.status).toBe(201);
    expect(created.body.certificate_request).toMatchObject({ kind: "apple_developer_id", name: "Deck Mac", csr_pem: CSR_PEM, metadata: { api_key_from_app: "raft-deck" } });
    expect(JSON.stringify(created.body)).not.toContain("GENERATEDKEYMATERIAL");
    const requestId = created.body.certificate_request.id;
    const stored = sqlite.prepare("SELECT secret_ciphertext_b64 FROM signing_certificate_requests WHERE id = ?").get(requestId) as { secret_ciphertext_b64: string };
    expect(Buffer.from(stored.secret_ciphertext_b64, "base64").toString("latin1")).not.toContain("GENERATEDKEYMATERIAL");
    expect((await call(handleListSigningCertificateRequests, env, { orgId: ORG })).body.certificate_requests).toHaveLength(1);
    expect((await call(handleListSigningCertificateRequests, env, { orgId: "org2" })).body.certificate_requests).toHaveLength(0);

    // A certificate for another request is refused and the request stays open.
    const wrong = await call(handleCompleteSigningCertificateRequest, env, { orgId: ORG, requestId }, { certificate_b64: "WRONG" });
    expect(wrong.body.code).toBe("signing_certificate_mismatch");
    expect((await call(handleListSigningCertificateRequests, env, { orgId: ORG })).body.certificate_requests).toHaveLength(1);
    // Another org cannot complete it.
    expect((await call(handleCompleteSigningCertificateRequest, env, { orgId: "org2", requestId }, { certificate_b64: "Q0VS" })).status).toBe(404);

    const done = await call(handleCompleteSigningCertificateRequest, env, { orgId: ORG, requestId }, { certificate_b64: "Q0VS" });
    expect(done.status).toBe(201);
    expect(calls.at(-1)!.body).toMatchObject({ kind: "apple_developer_id", key_pem: KEY_PEM, certificate_b64: "Q0VS", notary: { key_id: "TEAMKEY1", p8 } });
    expect(done.body.signing_identity).toMatchObject({ kind: "apple_developer_id", origin: "generated", metadata: { api_key_from_app: "raft-deck" } });
    // The key moved into the identity; the request no longer holds it and cannot be used again.
    const after = sqlite.prepare("SELECT secret_ciphertext_b64, identity_id, completed_at FROM signing_certificate_requests WHERE id = ?").get(requestId) as any;
    expect(after).toMatchObject({ secret_ciphertext_b64: null, identity_id: done.body.signing_identity.id });
    expect((await call(handleCompleteSigningCertificateRequest, env, { orgId: ORG, requestId }, { certificate_b64: "Q0VS" })).status).toBe(404);
    expect((await call(handleListSigningCertificateRequests, env, { orgId: ORG })).body.certificate_requests).toHaveLength(0);

    // Cancelling an open request drops its key.
    const other = (await call(handleCreateSigningCertificateRequest, env, { orgId: ORG }, { kind: "apple_ios_distribution", name: "Spare", asc: { from_app: "raft-deck" } })).body.certificate_request.id;
    expect((await call(handleCancelSigningCertificateRequest, env, { orgId: "org2", requestId: other })).status).toBe(404);
    expect((await call(handleCancelSigningCertificateRequest, env, { orgId: ORG, requestId: other })).body.cancelled).toBe(true);
    expect((sqlite.prepare("SELECT secret_ciphertext_b64 FROM signing_certificate_requests WHERE id = ?").get(other) as any).secret_ciphertext_b64).toBeNull();
    expect((await call(handleCreateSigningCertificateRequest, env, { orgId: ORG }, { kind: "android_keystore", name: "x" })).status).toBe(400);
    expect((await call(handleCreateSigningCertificateRequest, env, { orgId: ORG }, { kind: "apple_ios_distribution", name: "No key" })).body.error).toMatch(/API key/);
  });
});

describe("Apple App IDs", () => {
  async function iosApp() {
    const { env, sqlite } = environment();
    const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const p8 = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey) as ArrayBuffer).toString("base64")}\n-----END PRIVATE KEY-----`;
    recorder(() => ({ body: { metadata: { subject: "CN=Apple Distribution", team_id: "XDAPXFY8FZ", sha256_fingerprint: "ab".repeat(32) } } }));
    const id = (await call(handleUploadSigningIdentity, env, { orgId: ORG }, {
      kind: "apple_ios_distribution", name: "Deck iOS", p12_b64: "QUJD", p12_password: "pw", asc: { key_id: "KEY1", issuer_id: "ISS", p8 },
    })).body.signing_identity.id;
    sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES ('app-ios', ?, 'raft-deck-ios', 'Deck iOS', 'ios', 'ck4', 3)`).run(ORG);
    await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: "app-ios" });
    return { env, sqlite };
  }

  function apple(state: { registered: boolean; caps: string[]; profiles?: Array<{ id: string; name: string }> }) {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = String(url).replace("https://api.appstoreconnect.apple.com", "");
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
      if (method === "GET" && path.startsWith("/v1/bundleIds?")) {
        return json({ data: [
          { id: "B-WIDGET", type: "bundleIds", attributes: { identifier: "build.raft.deck.widget", platform: "IOS" } },
          ...(state.registered ? [{ id: "B1", type: "bundleIds", attributes: { identifier: "build.raft.deck", platform: "IOS" } }] : []),
        ] });
      }
      if (method === "GET" && path.startsWith("/v1/bundleIds/B1/bundleIdCapabilities")) {
        return json({ data: state.caps.map((c, i) => ({ id: `cap${i}`, type: "bundleIdCapabilities", attributes: { capabilityType: c } })) });
      }
      if (method === "GET" && path.startsWith("/v1/bundleIds/B1/profiles")) {
        return json({ data: (state.profiles ?? []).map((p) => ({ id: p.id, type: "profiles", attributes: { name: p.name, profileType: "IOS_APP_STORE" } })) });
      }
      if (method === "POST" && path === "/v1/bundleIds") return json({ data: { id: "B-NEW", type: "bundleIds", attributes: { identifier: body.data.attributes.identifier } } }, 201);
      if (method === "POST" && path === "/v1/bundleIdCapabilities") return json({ data: { id: "c", type: "bundleIdCapabilities", attributes: body.data.attributes } }, 201);
      if (method === "DELETE" && path.startsWith("/v1/profiles/")) return new Response(null, { status: 204 });
      return json({ errors: [{ title: "unexpected" }] }, 404);
    }));
    return calls;
  }

  const DECK = { "com.apple.developer.associated-domains": ["applinks:deck.raft.build", "webcredentials:deck.raft.build"] };

  it("plans without writing, then registers the App ID with the capabilities the entitlements ask for", async () => {
    const { env, sqlite } = await iosApp();
    const calls = apple({ registered: false, caps: [] });
    const planned = await call(handleAppleAppId, env, { appId: "app-ios" }, { bundle_id: "build.raft.deck", entitlements: DECK });
    expect(planned.status).toBe(200);
    expect(planned.body.applied).toBeNull();
    expect(planned.body.plan).toMatchObject({ bundle_id: "build.raft.deck", create_app_id: true, app_id_resource_id: null, enable: [{ capability: "ASSOCIATED_DOMAINS" }] });
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    calls.length = 0;
    const applied = await call(handleAppleAppId, env, { appId: "app-ios" }, { bundle_id: "build.raft.deck", entitlements: DECK, apply: true });
    expect(applied.body.applied).toMatchObject({ app_id_resource_id: "B-NEW", created_app_id: true, enabled: ["ASSOCIATED_DOMAINS"], profiles_removed: [] });
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/bundleIds", "POST /v1/bundleIdCapabilities"]);
    expect(writes[0]!.body.data.attributes).toEqual({ identifier: "build.raft.deck", name: "Hands build raft deck", platform: "IOS" });
    expect(writes[1]!.body.data).toMatchObject({ attributes: { capabilityType: "ASSOCIATED_DOMAINS" }, relationships: { bundleId: { data: { type: "bundleIds", id: "B-NEW" } } } });
    const audit = sqlite.prepare("SELECT action, payload FROM audit_logs WHERE action = 'signing_app_id.apply'").get() as any;
    expect(JSON.parse(audit.payload)).toMatchObject({ bundle_id: "build.raft.deck", created_app_id: true, enabled: ["ASSOCIATED_DOMAINS"] });
  });

  it("turns on only missing capabilities of an existing App ID and drops Hands-made profiles", async () => {
    const { env } = await iosApp();
    const calls = apple({ registered: true, caps: ["IN_APP_PURCHASE"], profiles: [{ id: "P-HANDS", name: "Hands build.raft.deck App Store 202611" }, { id: "P-MANUAL", name: "Deck App Store" }] });
    const applied = await call(handleAppleAppId, env, { appId: "app-ios" }, {
      bundle_id: "build.raft.deck", entitlements: { ...DECK, "aps-environment": "production" }, apply: true,
    });
    expect(applied.body.applied).toMatchObject({ created_app_id: false, enabled: ["PUSH_NOTIFICATIONS", "ASSOCIATED_DOMAINS"], profiles_removed: ["P-HANDS"] });
    expect(calls.some((c) => c.method === "POST" && c.path === "/v1/bundleIds")).toBe(false);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/v1/profiles/P-HANDS"]);

    // Nothing missing: nothing written.
    calls.length = 0;
    apple({ registered: true, caps: ["ASSOCIATED_DOMAINS"] });
    const again = await call(handleAppleAppId, env, { appId: "app-ios" }, { bundle_id: "build.raft.deck", entitlements: DECK, apply: true });
    expect(again.body.plan).toMatchObject({ enable: [], already_enabled: ["ASSOCIATED_DOMAINS"] });
    expect(again.body.applied).toMatchObject({ enabled: [], profiles_removed: [] });
  });

  it("reads an .entitlements file through the container and refuses bad input", async () => {
    const { env } = await iosApp();
    apple({ registered: true, caps: [] });
    const calls = recorder((path) => path === "/signing/entitlements" ? { body: { entitlements: DECK } } : { status: 500, body: {} });
    const res = await call(handleAppleAppId, env, { appId: "app-ios" }, { bundle_id: "build.raft.deck", entitlements_b64: "PHBsaXN0Lz4=" });
    expect(calls).toEqual([{ path: "/signing/entitlements", body: { entitlements_b64: "PHBsaXN0Lz4=" } }]);
    expect(res.body.plan.enable).toEqual([{ capability: "ASSOCIATED_DOMAINS", entitlements: ["com.apple.developer.associated-domains"] }]);
    expect((await call(handleAppleAppId, env, { appId: "app-ios" }, { bundle_id: "build.raft.*" })).body.code).toBe("invalid_request");
    expect((await call(handleAppleAppId, env, { appId: "app-ios" }, { bundle_id: "build.raft.deck", entitlements: DECK, entitlements_b64: "x" })).body.code).toBe("invalid_request");
    // An app with no Distribution identity granted cannot use one.
    expect((await call(handleAppleAppId, env, { appId: APP }, { bundle_id: "build.raft.deck" })).body.code).toBe("signing_identity_not_granted");
  });
});
