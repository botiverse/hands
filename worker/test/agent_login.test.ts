/**
 * Unit tests for the agent CLI login primitives (RFC 057, Hands first instance).
 * In-memory better-sqlite3 mimics D1's bind/run/first + meta.changes (same shim
 * shape as routes.test.ts; `?N` numbered placeholders normalized to `?`).
 */
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import {
  issueAgentGrant,
  exchangeAgentGrant,
  issueAgentTokens,
  rotateAgentRefresh,
  revokeAgentTokensForIdentity,
  isValidS256Challenge,
  sha256Base64Url,
  sha256Hex,
  type AgentLoginIdentity,
} from "../src/lib/agent_login";
import {
  handleAgentLoginAction,
  handleAgentExchange,
  handleAgentRefresh,
} from "../src/routes/agent_login";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE agent_login_grants (
      grant_digest TEXT PRIMARY KEY, server_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      account_id TEXT NOT NULL, integration TEXT NOT NULL, service TEXT NOT NULL,
      code_challenge TEXT NOT NULL, nonce TEXT NOT NULL, issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER
    );
    CREATE TABLE agent_refresh_tokens (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, server_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, account_id TEXT NOT NULL, integration TEXT NOT NULL,
      service TEXT NOT NULL, app_scope TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, rotated_from TEXT, revoked_at INTEGER
    );
    CREATE TABLE raft_sessions (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER,
      revoked_at INTEGER, raft_access_token_ciphertext TEXT
    );
  `);
  return {
    _sqlite: sqlite,
    prepare(sql: string) {
      const indexSequence: number[] = [];
      const normSql = sql.replace(/\?(\d+)/g, (_m, n) => {
        indexSequence.push(Number(n));
        return "?";
      });
      const stmt = sqlite.prepare(normSql);
      const bind = (...params: any[]) => {
        const expanded =
          indexSequence.length > 0 ? indexSequence.map((n) => params[n - 1]) : params;
        return {
          // __exec is the synchronous run used inside batch()'s transaction.
          __exec: () => ({ meta: { changes: stmt.run(...expanded).changes } }),
          run: async () => ({ success: true, meta: { changes: stmt.run(...expanded).changes } }),
          all: async () => ({ results: stmt.all(...expanded), success: true }),
          first: async () => (stmt.all(...expanded)[0] ?? null),
        };
      };
      return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
    },
    // D1 batch: run all statements in one transaction, rolling back on any error
    // (better-sqlite3 transaction()). Returns per-statement { meta: { changes } }.
    batch(stmts: any[]) {
      const txn = sqlite.transaction((ss: any[]) => ss.map((s) => s.__exec()));
      return Promise.resolve(txn(stmts));
    },
  };
}

function makeEnv() {
  return {
    DB: makeDb() as any,
    SIGNED_URL_SECRET: "test-secret",
    ENVIRONMENT: "development",
    // The exact installed Raft client key (Argus live probe: hands-4cc7a2), NOT "hands".
    RAFT_CLIENT_ID: "hands-4cc7a2",
  } as any;
}

const IDENTITY: AgentLoginIdentity = {
  server_id: "srv-A",
  agent_id: "raft-agent-1", // provider_subject (binding key)
  account_id: "acct-1", // Hands account row (session subject)
  integration: "hands-4cc7a2",
  service: "hands-4cc7a2",
};
const T0 = 1_700_000_000_000;

async function pkce() {
  const verifier = "verifier-" + Math.abs(Math.sin(T0)).toString(36) + "-highentropy-fixed";
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

describe("agent_login primitives", () => {
  let env: any;
  beforeEach(() => {
    env = makeEnv();
  });

  async function countRows(table: string): Promise<number> {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
    return Number(r.n);
  }

  it("exchanges a grant atomically: matching verifier → access + refresh + rows", async () => {
    const { verifier, challenge } = await pkce();
    const { grant, expires_at } = await issueAgentGrant(env, IDENTITY, challenge, T0);
    expect(expires_at).toBe(T0 + 5 * 60 * 1000);
    const res = await exchangeAgentGrant(env, grant, verifier, T0 + 1000);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tokens.access_token).toBeTruthy();
      expect(res.tokens.refresh_token).toBeTruthy();
      expect(res.tokens.access_expires_at).toBe(T0 + 1000 + 15 * 60 * 1000);
      expect(res.tokens.refresh_expires_at).toBe(T0 + 1000 + 30 * 24 * 60 * 60 * 1000);
    }
    // Atomic mint: exactly one session and one refresh row were created together.
    expect(await countRows("raft_sessions")).toBe(1);
    expect(await countRows("agent_refresh_tokens")).toBe(1);
  });

  it("rejects a wrong verifier (grant_proof_mismatch) without burning the grant or minting", async () => {
    const { verifier, challenge } = await pkce();
    const { grant } = await issueAgentGrant(env, IDENTITY, challenge, T0);
    const bad = await exchangeAgentGrant(env, grant, "wrong-verifier", T0 + 1000);
    expect(bad).toEqual({ ok: false, code: "grant_proof_mismatch" });
    // No tokens minted on a failed proof, and the grant is not burned.
    expect(await countRows("raft_sessions")).toBe(0);
    expect(await countRows("agent_refresh_tokens")).toBe(0);
    const good = await exchangeAgentGrant(env, grant, verifier, T0 + 2000);
    expect(good.ok).toBe(true);
  });

  it("rejects an expired grant", async () => {
    const { verifier, challenge } = await pkce();
    const { grant } = await issueAgentGrant(env, IDENTITY, challenge, T0);
    const res = await exchangeAgentGrant(env, grant, verifier, T0 + 6 * 60 * 1000);
    expect(res).toEqual({ ok: false, code: "grant_expired" });
    expect(await countRows("raft_sessions")).toBe(0);
  });

  it("is single-use: a second exchange returns consumed and mints nothing extra", async () => {
    const { verifier, challenge } = await pkce();
    const { grant } = await issueAgentGrant(env, IDENTITY, challenge, T0);
    expect((await exchangeAgentGrant(env, grant, verifier, T0 + 1000)).ok).toBe(true);
    const again = await exchangeAgentGrant(env, grant, verifier, T0 + 2000);
    expect(again).toEqual({ ok: false, code: "grant_consumed" });
    expect(await countRows("raft_sessions")).toBe(1);
    expect(await countRows("agent_refresh_tokens")).toBe(1);
  });

  it("mints an access token backed by a raft_sessions row, plus a refresh token", async () => {
    const tokens = await issueAgentTokens(env, IDENTITY, T0);
    expect(tokens.access_expires_at).toBe(T0 + 15 * 60 * 1000);
    expect(tokens.refresh_expires_at).toBe(T0 + 30 * 24 * 60 * 60 * 1000);
    // Access token resolves via a session row keyed by its hex SHA-256.
    const session = await env.DB
      .prepare("SELECT id, account_id, expires_at FROM raft_sessions WHERE token_hash = ?1")
      .bind(await sha256Hex(tokens.access_token))
      .first();
    expect(session).toMatchObject({ account_id: "acct-1", expires_at: T0 + 15 * 60 * 1000 });
    // Session subject is the Hands account_id, and the JWT `sub` matches it.
    const sub = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ).sub;
    expect(sub).toBe("acct-1");
    // jti unification: the JWT `jti` equals the raft_sessions row id (session ≡ token).
    const jti = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ).jti;
    expect(jti).toBe(session.id);
    // Refresh binds to the Raft agent identity (provider_subject), not the account id.
    const refreshRow = await env.DB
      .prepare("SELECT agent_id, account_id FROM agent_refresh_tokens WHERE token_hash = ?1")
      .bind(await sha256Base64Url(tokens.refresh_token))
      .first();
    expect(refreshRow).toMatchObject({ agent_id: "raft-agent-1", account_id: "acct-1" });
  });

  it("rotates a refresh token, and revokes the chain on reuse of a rotated token", async () => {
    const first = await issueAgentTokens(env, IDENTITY, T0);
    const rotated = await rotateAgentRefresh(env, first.refresh_token, T0 + 1000);
    expect(rotated.ok).toBe(true);
    // Reusing the now-rotated original must fail and revoke the identity's chain.
    const reuse = await rotateAgentRefresh(env, first.refresh_token, T0 + 2000);
    expect(reuse).toEqual({ ok: false, code: "refresh_reused" });
    // The successor is revoked too (chain revoke).
    if (rotated.ok) {
      const successor = await rotateAgentRefresh(env, rotated.tokens.refresh_token, T0 + 3000);
      expect(successor.ok).toBe(false);
    }
  });

  it("revokes all live refresh tokens for an identity", async () => {
    await issueAgentTokens(env, IDENTITY, T0);
    const t2 = await issueAgentTokens(env, IDENTITY, T0 + 10);
    const n = await revokeAgentTokensForIdentity(env, IDENTITY, T0 + 20);
    expect(n).toBeGreaterThanOrEqual(2);
    expect((await rotateAgentRefresh(env, t2.refresh_token, T0 + 30)).ok).toBe(false);
  });
});

/** Minimal AdminContext stub exercising the handler's identity-binding teeth. */
function fakeCtx(opts: { env: any; body?: any; vars?: Record<string, any> }): any {
  const vars = opts.vars ?? {};
  return {
    env: opts.env,
    get: (k: string) => vars[k],
    req: { json: async () => opts.body },
    json: (obj: any, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }),
  };
}

describe("agent-login action — identity-binding teeth", () => {
  it("binds the grant to the pre-org-switch authenticated account, never the x-hands-org-id-switched one", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const res = await handleAgentLoginAction(
      fakeCtx({
        env,
        body: { schema: "raft-cli-agent-login-request.v1", code_challenge: challenge, code_challenge_method: "S256" },
        vars: {
          // Server A authenticated; an x-hands-org-id switched admin_account to server B.
          authenticated_account: { id: "acct-A", provider_subject: "raft-agent-A", server_id: "srv-A", principal_type: "agent" },
          admin_account: { id: "acct-B", provider_subject: "raft-agent-B", server_id: "srv-B", principal_type: "agent" },
        },
      }),
    );
    expect(res.status).toBe(200);
    const row = await env.DB
      .prepare("SELECT server_id, agent_id, account_id, service, integration FROM agent_login_grants LIMIT 1")
      .first();
    // XX-frozen split, bound to the PRE-org-switch account (never srv-B/acct-B):
    //   agent_id = provider_subject, account_id = account row id.
    expect(row).toMatchObject({ server_id: "srv-A", agent_id: "raft-agent-A", account_id: "acct-A" });
    // Grant binds to the exact installed client key, not the brand "hands".
    expect(row).toMatchObject({ service: "hands-4cc7a2", integration: "hands-4cc7a2" });
  });

  it("fails closed (503) when RAFT_CLIENT_ID (exact service key) is unset", async () => {
    const env = makeEnv();
    delete (env as any).RAFT_CLIENT_ID;
    const { challenge } = await pkce();
    const res = await handleAgentLoginAction(
      fakeCtx({
        env,
        body: { schema: "raft-cli-agent-login-request.v1", code_challenge: challenge, code_challenge_method: "S256" },
        vars: { authenticated_account: { id: "a", provider_subject: "raft-agent-a", server_id: "s", principal_type: "agent" } },
      }),
    );
    expect(res.status).toBe(503);
  });

  it("rejects a human session (agent principal required)", async () => {
    const { challenge } = await pkce();
    const res = await handleAgentLoginAction(
      fakeCtx({
        env: makeEnv(),
        body: { schema: "raft-cli-agent-login-request.v1", code_challenge: challenge, code_challenge_method: "S256" },
        vars: { authenticated_account: { id: "h", server_id: "s", principal_type: "human" } },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("fails closed when authenticated_account is absent (e.g. deploy-token fallback)", async () => {
    const { challenge } = await pkce();
    const res = await handleAgentLoginAction(
      fakeCtx({
        env: makeEnv(),
        body: { schema: "raft-cli-agent-login-request.v1", code_challenge: challenge, code_challenge_method: "S256" },
        vars: {}, // no authenticated_account
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects extension fields on the login request (closed input)", async () => {
    const { challenge } = await pkce();
    const res = await handleAgentLoginAction(
      fakeCtx({
        env: makeEnv(),
        body: {
          schema: "raft-cli-agent-login-request.v1",
          code_challenge: challenge,
          code_challenge_method: "S256",
          extra: "nope",
        },
        vars: { authenticated_account: { id: "a", server_id: "s", principal_type: "agent" } },
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("invalid_schema");
  });
});

describe("RFC 057 wire — session.v1 + challenge validation", () => {
  it("validates the S256 challenge: canonical 32-byte base64url only", async () => {
    const { challenge } = await pkce();
    expect(isValidS256Challenge(challenge)).toBe(true); // 43-char canonical
    expect(isValidS256Challenge("short")).toBe(false); // decodes to < 32 bytes
    expect(isValidS256Challenge(challenge + "A")).toBe(false); // 33 bytes → wrong length
    expect(isValidS256Challenge("****" + challenge.slice(4))).toBe(false); // bad charset
    expect(isValidS256Challenge(challenge.slice(0, 42) + "=")).toBe(false); // padding rejected
  });

  it("exchange handler returns raft-cli-agent-session.v1 (Bearer + RFC3339 expiries)", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    // Handler uses real Date.now(); issue the grant at real time so it isn't expired.
    const { grant } = await issueAgentGrant(env, IDENTITY, challenge);
    const res = await handleAgentExchange(
      fakeCtx({ env, body: { schema: "raft-cli-agent-login-exchange.v1", grant, code_verifier: verifier } }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.schema).toBe("raft-cli-agent-session.v1");
    expect(json.token_type).toBe("Bearer");
    expect(typeof json.access_token).toBe("string");
    expect(typeof json.refresh_token).toBe("string");
    // RFC3339 UTC timestamps, not epoch milliseconds.
    expect(json.access_expires_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(json.refresh_expires_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it("exchange handler maps a bad verifier to grant_proof_mismatch (400)", async () => {
    const env = makeEnv();
    const { challenge } = await pkce();
    const { grant } = await issueAgentGrant(env, IDENTITY, challenge);
    const res = await handleAgentExchange(
      fakeCtx({ env, body: { schema: "raft-cli-agent-login-exchange.v1", grant, code_verifier: "wrong-verifier" } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("grant_proof_mismatch");
  });

  it("refresh handler requires the raft-cli-agent-refresh.v1 schema", async () => {
    const res = await handleAgentRefresh(
      fakeCtx({ env: makeEnv(), body: { refresh_token: "whatever" } }), // missing schema
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("invalid_schema");
  });
});

describe("agent-login end-to-end (real handlers, XX-frozen identity split)", () => {
  it("login → exchange → refresh: session subject = account_id, binding = provider_subject", async () => {
    const env = makeEnv();
    const { verifier, challenge } = await pkce();
    const authed = { id: "acct-A", provider_subject: "raft-agent-A", server_id: "srv-A", principal_type: "agent" };

    // 1) agent-login action issues a grant bound to the authed identity.
    const loginRes = await handleAgentLoginAction(
      fakeCtx({
        env,
        body: { schema: "raft-cli-agent-login-request.v1", code_challenge: challenge, code_challenge_method: "S256" },
        vars: { authenticated_account: authed },
      }),
    );
    expect(loginRes.status).toBe(200);
    const grant = ((await loginRes.json()) as any).grant;
    expect(typeof grant).toBe("string");

    // 2) exchange → session.v1
    const exRes = await handleAgentExchange(
      fakeCtx({ env, body: { schema: "raft-cli-agent-login-exchange.v1", grant, code_verifier: verifier } }),
    );
    expect(exRes.status).toBe(200);
    const session1 = (await exRes.json()) as any;
    expect(session1.schema).toBe("raft-cli-agent-session.v1");

    // 3) refresh → new session.v1, rotated refresh token
    const rfRes = await handleAgentRefresh(
      fakeCtx({ env, body: { schema: "raft-cli-agent-refresh.v1", refresh_token: session1.refresh_token } }),
    );
    expect(rfRes.status).toBe(200);
    const session2 = (await rfRes.json()) as any;
    expect(session2.schema).toBe("raft-cli-agent-session.v1");
    expect(session2.refresh_token).not.toBe(session1.refresh_token);

    // Identity split persisted across the whole chain:
    //  - every access session's account_id = Hands account (acct-A)
    //  - every refresh binds to the Raft agent identity (raft-agent-A)
    const sessions = await env.DB.prepare("SELECT DISTINCT account_id FROM raft_sessions").all();
    expect(sessions.results.map((r: any) => r.account_id)).toEqual(["acct-A"]);
    const refreshes = await env.DB.prepare("SELECT DISTINCT agent_id, account_id FROM agent_refresh_tokens").all();
    expect(refreshes.results).toEqual([{ agent_id: "raft-agent-A", account_id: "acct-A" }]);
  });
});
