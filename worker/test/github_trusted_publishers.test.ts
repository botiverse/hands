/**
 * GitHub OIDC trusted publishing, through the real handlers on the real
 * migration chain. GitHub's signing key is replaced by a locally generated RSA
 * key served from a stubbed JWKS endpoint; everything else is production code.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleCreateTrustedPublisher,
  handleGithubOidcExchange,
  handleListTrustedPublishers,
  handleRevokeTrustedPublisher,
} from "../src/routes/trusted_publishers";
import { loadDeployToken } from "../src/lib/deploy_tokens";
import { refMatches, resetGithubJwksCache, verifyGithubOidcToken } from "../src/lib/github_oidc";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const ORIGIN = "https://hands.example.test";
const APP = "app-deck";

function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]) => {
      const params = (indexes.length ? indexes.map((i) => input[i - 1]) : input)
        .map((v) => v === undefined ? null : v);
      const execute = () => statement.reader
        ? { results: statement.all(...params), success: true as const, meta: { changes: 0 } }
        : { results: [], success: true as const, meta: { changes: statement.run(...params).changes } };
      return {
        _execute: execute,
        run: async () => execute(),
        all: async () => execute(),
        first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: <T>() => bind().first<T>() };
  };
  return {
    prepare,
    batch: async (sts: { _execute: () => unknown }[]) => db.transaction(() => sts.map((s) => s._execute()))(),
  };
}

function environment() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  sqlite.prepare(
    `INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
     VALUES ('org','org','Org','raft','server',1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
     VALUES (?,'org','raft-deck','Raft Deck','electron','ck',1)`,
  ).run(APP);
  sqlite.prepare(
    `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
     VALUES ('app-other','org','other','Other','electron','ck2',1)`,
  ).run();
  return { sqlite, env: { DB: d1(sqlite) } as unknown as Env };
}

function adminCtx(env: Env, params: Record<string, string>, body: unknown = {}, query: Record<string, string> = {}) {
  let status = 200;
  const c = {
    env,
    req: { param: (n: string) => params[n] ?? "", json: async () => body, query: (k: string) => query[k] },
    json: (data: unknown, s = 200) => { status = s; return new Response(JSON.stringify(data), { status: s }); },
    get: () => undefined,
  } as any;
  return { c, status: () => status };
}

async function callAdmin(handler: (c: any) => Promise<Response>, env: Env, params: Record<string, string>, body?: unknown, query?: Record<string, string>) {
  const { c } = adminCtx(env, params, body, query);
  const response = await handler(c);
  return { status: response.status, body: await response.json() as any };
}

async function exchange(env: Env, body: unknown) {
  const c = {
    env,
    req: { url: `${ORIGIN}/public/v2/oidc/github/token`, json: async () => body, header: () => undefined },
    json: (data: unknown, s = 200) => new Response(JSON.stringify(data), { status: s }),
  } as any;
  const response = await handleGithubOidcExchange(c);
  return { status: response.status, body: await response.json() as any };
}

// ---------- A fake GitHub signer ----------

let signingKey: CryptoKeyPair;
let otherKey: CryptoKeyPair;
const KID = "test-kid";

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return Buffer.from(raw).toString("base64url");
};

async function signJwt(claims: Record<string, unknown>, opts: { key?: CryptoKeyPair; kid?: string; alg?: string } = {}) {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", (opts.key ?? signingKey).privateKey, new TextEncoder().encode(`${header}.${payload}`),
  ));
  return `${header}.${payload}.${b64url(signature)}`;
}

let jtiCounter = 0;
function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: ORIGIN,
    sub: "repo:botiverse/raft-deck:ref:refs/heads/main",
    jti: `jti-${++jtiCounter}`,
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    repository: "botiverse/raft-deck",
    repository_id: "123456",
    repository_owner: "botiverse",
    workflow_ref: "botiverse/raft-deck/.github/workflows/desktop.yml@refs/heads/main",
    job_workflow_ref: "botiverse/raft-deck/.github/workflows/desktop.yml@refs/heads/main",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
    run_id: "987",
    run_attempt: "1",
    event_name: "push",
    actor: "someone",
    ...overrides,
  };
}

beforeAll(async () => {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  signingKey = await crypto.subtle.generateKey(params, true, ["sign", "verify"]) as CryptoKeyPair;
  otherKey = await crypto.subtle.generateKey(params, true, ["sign", "verify"]) as CryptoKeyPair;
});

beforeEach(async () => {
  resetGithubJwksCache();
  const jwk = await crypto.subtle.exportKey("jwk", signingKey.publicKey);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url) === "https://token.actions.githubusercontent.com/.well-known/jwks") {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] }));
    }
    return new Response("not found", { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function addPublisher(env: Env, body: Record<string, unknown> = {}, appId = APP) {
  return callAdmin(handleCreateTrustedPublisher, env, { appId }, {
    repository: "Botiverse/Raft-Deck",
    workflow_path: ".github/workflows/desktop.yml",
    ref_patterns: ["refs/heads/main", "refs/tags/desktop-v*"],
    ...body,
  });
}

describe("GitHub OIDC token verification", () => {
  it("accepts a GitHub-signed token for this audience and rejects every forged variant", async () => {
    await expect(verifyGithubOidcToken(await signJwt(claims()), ORIGIN)).resolves.toMatchObject({ repository: "botiverse/raft-deck" });
    const cases: Array<[string, Promise<string>, string]> = [
      ["other key", signJwt(claims(), { key: otherKey }), "bad_signature"],
      ["unknown kid", signJwt(claims(), { kid: "nope" }), "unknown_key"],
      ["alg none", signJwt(claims(), { alg: "none" }), "unsupported_algorithm"],
      ["HS256", signJwt(claims(), { alg: "HS256" }), "unsupported_algorithm"],
      ["wrong issuer", signJwt(claims({ iss: "https://evil.example" })), "wrong_issuer"],
      ["wrong audience", signJwt(claims({ aud: "https://other.example" })), "wrong_audience"],
      ["expired", signJwt(claims({ exp: Math.floor(Date.now() / 1000) - 120 })), "expired"],
      ["future", signJwt(claims({ iat: Math.floor(Date.now() / 1000) + 600, nbf: Math.floor(Date.now() / 1000) + 600, exp: Math.floor(Date.now() / 1000) + 900 })), "not_yet_valid"],
      ["no repository", signJwt(claims({ repository: undefined })), "missing_claim"],
      ["no jti", signJwt(claims({ jti: undefined })), "missing_claim"],
    ];
    for (const [label, token, code] of cases) {
      await expect(verifyGithubOidcToken(await token, ORIGIN), label).rejects.toMatchObject({ code });
    }
    // A tampered payload under a valid signature.
    const [h, , s] = (await signJwt(claims())).split(".");
    const tampered = `${h}.${b64url(JSON.stringify(claims({ repository: "evil/repo" })))}.${s}`;
    await expect(verifyGithubOidcToken(tampered, ORIGIN)).rejects.toMatchObject({ code: "bad_signature" });
  });

  it("matches ref patterns within one path segment", () => {
    expect(refMatches("refs/tags/desktop-v*", "refs/tags/desktop-v1.2.3")).toBe(true);
    expect(refMatches("refs/tags/desktop-v*", "refs/tags/mobile-v1.2.3")).toBe(false);
    expect(refMatches("refs/heads/main", "refs/heads/main-old")).toBe(false);
    expect(refMatches("refs/heads/*", "refs/heads/feature/x")).toBe(false);
    expect(refMatches("refs/heads/release.*", "refs/heads/releaseX1")).toBe(false);
  });
});

describe("trusted publishers", () => {
  it("validates configuration and lists, creates and revokes publishers", async () => {
    const { env } = environment();
    for (const bad of [
      { repository: "not a repo" },
      { workflow_path: "desktop.yml" },
      { workflow_path: ".github/workflows/../secrets.yml" },
      { ref_patterns: [] },
      { ref_patterns: ["main"] },
      { ref_patterns: ["refs/pull/1/merge"] },
      { app_role: "admin" },
      { repository_id: "abc" },
      { extra: 1 },
    ]) {
      expect((await addPublisher(env, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const created = await addPublisher(env);
    expect(created.status).toBe(201);
    expect(created.body.trusted_publisher).toMatchObject({
      repository: "botiverse/raft-deck",
      workflow_path: ".github/workflows/desktop.yml",
      ref_patterns: ["refs/heads/main", "refs/tags/desktop-v*"],
      app_role: "publisher",
      repository_id: null,
    });
    const listed = await callAdmin(handleListTrustedPublishers, env, { appId: APP });
    expect(listed.body.trusted_publishers).toHaveLength(1);
    const otherApp = await callAdmin(handleRevokeTrustedPublisher, env, { appId: "app-other", publisherId: created.body.trusted_publisher.id });
    expect(otherApp.status).toBe(404);
    const revoked = await callAdmin(handleRevokeTrustedPublisher, env, { appId: APP, publisherId: created.body.trusted_publisher.id });
    expect(revoked.status).toBe(200);
    expect((await callAdmin(handleListTrustedPublishers, env, { appId: APP })).body.trusted_publishers).toHaveLength(0);
  });

  it("exchanges a matching run for a working, app-scoped, short-lived deploy token", async () => {
    const { env, sqlite } = environment();
    const publisher = (await addPublisher(env)).body.trusted_publisher;
    const result = await exchange(env, { app: "raft-deck", token: await signJwt(claims()) });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ app_id: APP, app_slug: "raft-deck", app_role: "publisher", trusted_publisher_id: publisher.id });
    expect(result.body.expires_at - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(result.body.expires_at - Date.now()).toBeGreaterThan(55 * 60 * 1000);

    const loaded = await loadDeployToken(env, result.body.token);
    expect(loaded).toMatchObject({ app_id: APP, app_role: "publisher" });
    // The repository id is pinned on first use.
    expect(sqlite.prepare("SELECT repository_id FROM app_github_trusted_publishers WHERE id = ?").get(publisher.id))
      .toEqual({ repository_id: "123456" });
    const audit = sqlite.prepare("SELECT action, actor, actor_type, payload FROM audit_logs WHERE action = 'trusted_publisher.exchange'").get() as any;
    expect(audit).toMatchObject({ actor: "github:botiverse/raft-deck/.github/workflows/desktop.yml", actor_type: "system" });
    expect(JSON.parse(audit.payload)).toMatchObject({ run_id: "987", sha: "a".repeat(40), ref: "refs/heads/main" });
    expect(audit.payload).not.toContain(result.body.token);

    // A tag run matches the tag pattern; the id also works as the app reference.
    expect((await exchange(env, { app: APP, token: await signJwt(claims({ ref: "refs/tags/desktop-v1.0.0", workflow_ref: "botiverse/raft-deck/.github/workflows/desktop.yml@refs/tags/desktop-v1.0.0" })) })).status).toBe(201);
  });

  it("refuses runs that do not match, replays, other apps and revoked publishers", async () => {
    const { env } = environment();
    const publisher = (await addPublisher(env)).body.trusted_publisher;
    const deny = async (overrides: Record<string, unknown>, app = "raft-deck") =>
      exchange(env, { app, token: await signJwt(claims(overrides)) });

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["fork", { repository: "evil/raft-deck", workflow_ref: "evil/raft-deck/.github/workflows/desktop.yml@refs/heads/main" }, "repository"],
      ["other workflow", { workflow_ref: "botiverse/raft-deck/.github/workflows/mobile.yml@refs/heads/main" }, "workflow"],
      ["feature branch", { ref: "refs/heads/feature", workflow_ref: "botiverse/raft-deck/.github/workflows/desktop.yml@refs/heads/feature" }, "ref"],
      ["pull request", { ref: "refs/pull/7/merge", workflow_ref: "botiverse/raft-deck/.github/workflows/desktop.yml@refs/pull/7/merge", event_name: "pull_request" }, "ref"],
      ["workflow file from another ref", { workflow_ref: "botiverse/raft-deck/.github/workflows/desktop.yml@refs/heads/feature" }, "ref"],
      ["other tag", { ref: "refs/tags/mobile-v1", workflow_ref: "botiverse/raft-deck/.github/workflows/desktop.yml@refs/tags/mobile-v1" }, "ref"],
    ];
    for (const [label, overrides, reason] of cases) {
      const result = await deny(overrides);
      expect([label, result.status, result.body.code]).toEqual([label, 403, "github_oidc_no_trusted_publisher"]);
      expect(result.body.mismatch, label).toContain(reason);
    }
    expect((await deny({}, "other")).status).toBe(403);
    expect((await deny({}, "no-such-app")).status).toBe(403);
    expect((await exchange(env, { app: "raft-deck", token: await signJwt(claims({ aud: "https://other.example" })) })).body.code).toBe("github_oidc_wrong_audience");
    expect((await exchange(env, { app: "raft-deck" })).status).toBe(400);

    // Single use per GitHub token.
    const token = await signJwt(claims());
    expect((await exchange(env, { app: "raft-deck", token })).status).toBe(201);
    const replay = await exchange(env, { app: "raft-deck", token });
    expect([replay.status, replay.body.code]).toEqual([409, "github_oidc_token_reused"]);

    // Pinned repository id: a re-created repository with the same name cannot publish.
    const recreated = await deny({ repository_id: "999" });
    expect(recreated.body.mismatch).toContain("repository_id");

    // Revoking the publisher revokes the tokens it minted.
    const minted = await exchange(env, { app: "raft-deck", token: await signJwt(claims()) });
    expect(await loadDeployToken(env, minted.body.token)).not.toBeNull();
    await callAdmin(handleRevokeTrustedPublisher, env, { appId: APP, publisherId: publisher.id });
    expect(await loadDeployToken(env, minted.body.token)).toBeNull();
    expect((await deny({})).status).toBe(403);
  });

  it("requires the configured GitHub environment when one is set", async () => {
    const { env } = environment();
    await addPublisher(env, { environment: "release" });
    expect((await exchange(env, { app: "raft-deck", token: await signJwt(claims()) })).body.mismatch).toContain("environment");
    expect((await exchange(env, { app: "raft-deck", token: await signJwt(claims({ environment: "release" })) })).status).toBe(201);
  });
});
