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
  sha256Base64Url,
  sha256Hex,
  type AgentLoginIdentity,
} from "../src/lib/agent_login";
import { handleAgentLoginAction } from "../src/routes/agent_login";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE agent_login_grants (
      grant_digest TEXT PRIMARY KEY, server_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      integration TEXT NOT NULL, service TEXT NOT NULL, code_challenge TEXT NOT NULL,
      nonce TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE TABLE agent_refresh_tokens (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, server_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, integration TEXT NOT NULL, service TEXT NOT NULL,
      app_scope TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      rotated_from TEXT, revoked_at INTEGER
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
  return { DB: makeDb() as any, SIGNED_URL_SECRET: "test-secret", ENVIRONMENT: "development" } as any;
}

const IDENTITY: AgentLoginIdentity = {
  server_id: "srv-A",
  agent_id: "acct-1",
  integration: "hands",
  service: "hands",
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
    expect(res).toEqual({ ok: false, code: "expired" });
    expect(await countRows("raft_sessions")).toBe(0);
  });

  it("is single-use: a second exchange returns consumed and mints nothing extra", async () => {
    const { verifier, challenge } = await pkce();
    const { grant } = await issueAgentGrant(env, IDENTITY, challenge, T0);
    expect((await exchangeAgentGrant(env, grant, verifier, T0 + 1000)).ok).toBe(true);
    const again = await exchangeAgentGrant(env, grant, verifier, T0 + 2000);
    expect(again).toEqual({ ok: false, code: "consumed" });
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
    // jti unification: the JWT `jti` equals the raft_sessions row id (session ≡ token).
    const jti = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ).jti;
    expect(jti).toBe(session.id);
    const refreshRow = await env.DB
      .prepare("SELECT agent_id FROM agent_refresh_tokens WHERE token_hash = ?1")
      .bind(await sha256Base64Url(tokens.refresh_token))
      .first();
    expect(refreshRow).toMatchObject({ agent_id: "acct-1" });
  });

  it("rotates a refresh token, and revokes the chain on reuse of a rotated token", async () => {
    const first = await issueAgentTokens(env, IDENTITY, T0);
    const rotated = await rotateAgentRefresh(env, first.refresh_token, T0 + 1000);
    expect(rotated.ok).toBe(true);
    // Reusing the now-rotated original must fail and revoke the identity's chain.
    const reuse = await rotateAgentRefresh(env, first.refresh_token, T0 + 2000);
    expect(reuse).toEqual({ ok: false, code: "consumed" });
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
          authenticated_account: { id: "acct-A", server_id: "srv-A", principal_type: "agent" },
          admin_account: { id: "acct-B", server_id: "srv-B", principal_type: "agent" },
        },
      }),
    );
    expect(res.status).toBe(200);
    const row = await env.DB
      .prepare("SELECT server_id, agent_id FROM agent_login_grants LIMIT 1")
      .first();
    expect(row).toMatchObject({ server_id: "srv-A", agent_id: "acct-A" }); // NEVER srv-B/acct-B
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
});
