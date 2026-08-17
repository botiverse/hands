/**
 * Agent CLI login (generic RFC 057, Hands first instance) — server-side primitives.
 *
 * Flow (design doc: docs/agent-cli-login-hands-instance.md):
 *   1. `agent-login` action (Hands-executed): the CLI sends only a PKCE S256
 *      `code_challenge`; Hands issues an opaque single-use `grant` bound to the
 *      authenticated identity + challenge, and stores only the grant DIGEST.
 *   2. exchange: the CLI sends `{ grant, code_verifier }`; Hands atomically consumes
 *      the grant (single-use), verifies SHA-256(verifier) == challenge, and mints a
 *      short access JWT + a revocable/rotating refresh token.
 *   3. refresh: rotate the refresh token; reuse of a rotated token revokes the chain.
 *
 * Security invariants enforced here:
 *   - Raw grant / refresh token are never stored — only digests/hashes.
 *   - The verifier is only checked here; it is never persisted or logged.
 *   - Single-use consume is atomic (conditional UPDATE bound by changes()==1).
 *   - Identity comes from the caller (the handler reads the pre-org-switch
 *     `authenticated_account`); this module never trusts request-body identity.
 */

import { createSignedJwt } from "../routes/auth";

// `Env` is an ambient global (worker/env.d.ts); used directly, not imported.

// Grant lives at most 5 minutes (RFC 057: `expires_at` <= 300s from issue).
export const AGENT_GRANT_TTL_MS = 5 * 60 * 1000;
// Short access token; refresh handles longevity (Codex-isomorphic short/long split).
export const AGENT_ACCESS_TTL_MS = 15 * 60 * 1000;
export const AGENT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Authenticated identity a grant/refresh binds to (from `authenticated_account`). */
export interface AgentLoginIdentity {
  server_id: string;
  // Raft agent identity = authenticated_account.provider_subject. The grant/refresh
  // BINDING and per-agent revoke key. NOT the session account. (XX-frozen mapping.)
  agent_id: string;
  // Hands-local account row = authenticated_account.id. Used as the access JWT `sub`
  // and raft_sessions.account_id so the minted access token resolves through normal
  // auth middleware. Stored on the session, never as the binding/revoke key.
  account_id: string;
  integration: string;
  service: string; // exact installed client key, e.g. "hands-4cc7a2"
  app_scope?: string | null;
}

/**
 * Closed error set — the frozen RFC 057 codes (verified against slock commit
 * 2cb55a4e, rfcs/057-...). Exchange failures use the `grant_*` codes; refresh
 * failures use the `refresh_*` codes; `temporarily_unavailable` is the only
 * retryable one (a concurrent rotation loser).
 */
export type AgentLoginErrorCode =
  | "grant_invalid"
  | "grant_expired"
  | "grant_consumed"
  | "grant_binding_mismatch"
  | "grant_proof_mismatch"
  | "refresh_invalid"
  | "refresh_expired"
  | "refresh_reused"
  | "refresh_revoked"
  | "temporarily_unavailable";

export interface AgentTokens {
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
}

type ExchangeResult =
  | { ok: true; tokens: AgentTokens }
  | { ok: false; code: AgentLoginErrorCode };

type RotateResult =
  | { ok: true; tokens: AgentTokens }
  | { ok: false; code: AgentLoginErrorCode };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** High-entropy opaque token (32 bytes → base64url). */
export function randomOpaqueToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * RFC 057 S256 challenge validation (verified against slock 2cb55a4e rfcs/057):
 * strict base64url charset with NO padding, decodes to EXACTLY 32 bytes, and
 * canonical round-trip (re-encoding the decoded bytes yields the same string —
 * this rejects non-canonical trailing bits that a length check alone would miss).
 * The caller separately enforces `code_challenge_method === "S256"`.
 */
export function isValidS256Challenge(challenge: unknown): challenge is string {
  if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]+$/.test(challenge)) {
    return false;
  }
  let bytes: Uint8Array;
  try {
    const b64 = challenge.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  if (bytes.length !== 32) return false;
  return base64Url(bytes) === challenge; // canonical round-trip
}

/** SHA-256 → base64url. Used for grant/refresh digests AND PKCE S256 challenge. */
export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return base64Url(new Uint8Array(digest));
}

/**
 * SHA-256 → lowercase hex. MUST match the auth middleware's session lookup format
 * (it hashes the bearer as hex), so the minted access token resolves to its session.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * `agent-login` action: mint an opaque grant bound to `identity` + `codeChallenge`.
 * Stores only the digest. Returns the raw grant (returned to the CLI once) + expiry.
 */
export async function issueAgentGrant(
  env: Env,
  identity: AgentLoginIdentity,
  codeChallenge: string,
  now: number = Date.now(),
): Promise<{ grant: string; expires_at: number }> {
  const grant = randomOpaqueToken();
  const grantDigest = await sha256Base64Url(grant);
  const expiresAt = now + AGENT_GRANT_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO agent_login_grants
       (grant_digest, server_id, agent_id, account_id, integration, service,
        code_challenge, nonce, issued_at, expires_at, consumed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)`,
  )
    .bind(
      grantDigest,
      identity.server_id,
      identity.agent_id,
      identity.account_id,
      identity.integration,
      identity.service,
      codeChallenge,
      crypto.randomUUID(),
      now,
      expiresAt,
    )
    .run();
  return { grant, expires_at: expiresAt };
}

/**
 * exchange: verify the proof, then ATOMICALLY consume the grant (single-use) and mint
 * the access session + refresh token in ONE transaction (D1 batch). Either all three
 * happen or none do — fixes the CP2 non-atomic exchange (a burned grant with no
 * tokens on a mid-exchange failure). The verifier is checked here, never stored/logged.
 *
 * Concurrency: the session/refresh INSERTs are guarded on "this call won the consume"
 * (grant.consumed_at == now, set by the same-batch UPDATE). A concurrent loser's
 * UPDATE matches 0 rows, so its guarded INSERTs write nothing; we detect the win via
 * the session INSERT's changes count.
 */
export async function exchangeAgentGrant(
  env: Env,
  grant: string,
  codeVerifier: string,
  now: number = Date.now(),
): Promise<ExchangeResult> {
  if (!grant || !codeVerifier) return { ok: false, code: "grant_invalid" };
  const grantDigest = await sha256Base64Url(grant);
  const row = await env.DB.prepare(
    `SELECT server_id, agent_id, account_id, integration, service,
            code_challenge, expires_at, consumed_at
       FROM agent_login_grants WHERE grant_digest = ?1`,
  )
    .bind(grantDigest)
    .first<{
      server_id: string;
      agent_id: string;
      account_id: string;
      integration: string;
      service: string;
      code_challenge: string;
      expires_at: number;
      consumed_at: number | null;
    }>();

  if (!row) return { ok: false, code: "grant_invalid" };
  if (row.consumed_at !== null) return { ok: false, code: "grant_consumed" };
  if (row.expires_at <= now) return { ok: false, code: "grant_expired" };

  // Proof check BEFORE consuming: a wrong verifier must not burn the grant (so a
  // stolen-grant attacker without the verifier can't DoS the legitimate CLI).
  const challengeFromVerifier = await sha256Base64Url(codeVerifier);
  if (challengeFromVerifier !== row.code_challenge) {
    return { ok: false, code: "grant_proof_mismatch" };
  }

  const identity: AgentLoginIdentity = {
    server_id: row.server_id,
    agent_id: row.agent_id, // Raft provider_subject (binding key)
    account_id: row.account_id, // Hands account row (session subject)
    integration: row.integration,
    service: row.service,
    // Grants carry no app scope (login-time); refresh defaults to null.
    app_scope: null,
  };
  const accessExpiresAt = now + AGENT_ACCESS_TTL_MS;
  const refreshExpiresAt = now + AGENT_REFRESH_TTL_MS;
  // One id is BOTH the JWT `jti` and the raft_sessions row id (session ≡ token).
  const sessionId = crypto.randomUUID();
  // Access token subject = Hands account_id, so it resolves via the normal middleware.
  const accessToken = await createSignedJwt(
    env,
    identity.account_id,
    now,
    accessExpiresAt,
    sessionId,
  );
  const accessHash = await sha256Hex(accessToken);
  const refreshId = crypto.randomUUID();
  const refreshToken = randomOpaqueToken();
  const refreshHash = await sha256Base64Url(refreshToken);

  const results = await env.DB.batch([
    // 1) single-use consume — only one exchange matches `consumed_at IS NULL`.
    env.DB.prepare(
      `UPDATE agent_login_grants SET consumed_at = ?2
         WHERE grant_digest = ?1 AND consumed_at IS NULL AND expires_at > ?2`,
    ).bind(grantDigest, now),
    // 2) session — inserted only if THIS call set consumed_at = now (won the consume).
    //    raft_sessions.account_id = Hands account_id (session subject), NOT agent_id.
    env.DB.prepare(
      `INSERT INTO raft_sessions
         (id, account_id, token_hash, created_at, expires_at, last_seen_at,
          revoked_at, raft_access_token_ciphertext)
       SELECT ?1, ?2, ?3, ?4, ?5, ?4, NULL, NULL
        WHERE (SELECT consumed_at FROM agent_login_grants WHERE grant_digest = ?6) = ?4`,
    ).bind(sessionId, identity.account_id, accessHash, now, accessExpiresAt, grantDigest),
    // 3) refresh — same win-guard. Binds agent_id (provider_subject) + account_id.
    env.DB.prepare(
      `INSERT INTO agent_refresh_tokens
         (id, token_hash, server_id, agent_id, account_id, integration, service, app_scope,
          created_at, expires_at, rotated_from, revoked_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL
        WHERE (SELECT consumed_at FROM agent_login_grants WHERE grant_digest = ?11) = ?9`,
    ).bind(
      refreshId,
      refreshHash,
      identity.server_id,
      identity.agent_id,
      identity.account_id,
      identity.integration,
      identity.service,
      identity.app_scope ?? null,
      now,
      refreshExpiresAt,
      grantDigest,
    ),
  ]);

  // Session INSERT wrote 1 row ⇒ we won the atomic consume. 0 ⇒ a concurrent exchange
  // won (the whole batch rolls back on any error, so we never burn a grant tokenlessly).
  if ((results[1]?.meta?.changes ?? 0) !== 1) {
    return { ok: false, code: "grant_consumed" };
  }
  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      access_expires_at: accessExpiresAt,
      refresh_expires_at: refreshExpiresAt,
    },
  };
}

/**
 * Mint a short access token: a Hands JWT (subject = agent account row id) backed by
 * a `raft_sessions` row, so it resolves through the normal auth middleware
 * (which looks the bearer up by its hex SHA-256 in raft_sessions). Agent sessions
 * carry no encrypted Raft token (NULL) — that field is only for hands-admin.
 */
async function mintAccessToken(
  env: Env,
  identity: AgentLoginIdentity,
  now: number,
  accessExpiresAt: number,
): Promise<string> {
  // One id is BOTH the JWT `jti` and the raft_sessions row id, so a session and its
  // access token are the same principal (simpler revoke/audit correlation — Volta CP2).
  const sessionId = crypto.randomUUID();
  const accessToken = await createSignedJwt(
    env,
    identity.account_id,
    now,
    accessExpiresAt,
    sessionId,
  );
  await env.DB.prepare(
    `INSERT INTO raft_sessions
       (id, account_id, token_hash, created_at, expires_at, last_seen_at,
        revoked_at, raft_access_token_ciphertext)
     VALUES (?1, ?2, ?3, ?4, ?5, ?4, NULL, NULL)`,
  )
    .bind(
      sessionId,
      identity.account_id,
      await sha256Hex(accessToken),
      now,
      accessExpiresAt,
    )
    .run();
  return accessToken;
}

async function mintTokens(
  env: Env,
  identity: AgentLoginIdentity,
  now: number,
): Promise<AgentTokens> {
  const accessExpiresAt = now + AGENT_ACCESS_TTL_MS;
  const refreshExpiresAt = now + AGENT_REFRESH_TTL_MS;
  const accessToken = await mintAccessToken(env, identity, now, accessExpiresAt);
  const refreshToken = randomOpaqueToken();
  const refreshHash = await sha256Base64Url(refreshToken);
  await env.DB.prepare(
    `INSERT INTO agent_refresh_tokens
       (id, token_hash, server_id, agent_id, account_id, integration, service, app_scope,
        created_at, expires_at, rotated_from, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)`,
  )
    .bind(
      crypto.randomUUID(),
      refreshHash,
      identity.server_id,
      identity.agent_id,
      identity.account_id,
      identity.integration,
      identity.service,
      identity.app_scope ?? null,
      now,
      refreshExpiresAt,
    )
    .run();
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    access_expires_at: accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
  };
}

/** exchange step 2: mint access + refresh for a proven identity. */
export async function issueAgentTokens(
  env: Env,
  identity: AgentLoginIdentity,
  now: number = Date.now(),
): Promise<AgentTokens> {
  return mintTokens(env, identity, now);
}

/**
 * refresh: rotate the refresh token. Reuse of an already-rotated (or revoked)
 * token revokes the whole identity's live tokens (compromise signal) and fails.
 */
export async function rotateAgentRefresh(
  env: Env,
  refreshToken: string,
  now: number = Date.now(),
): Promise<RotateResult> {
  if (!refreshToken) return { ok: false, code: "refresh_invalid" };
  const refreshHash = await sha256Base64Url(refreshToken);
  const row = await env.DB.prepare(
    `SELECT id, server_id, agent_id, account_id, integration, service, app_scope,
            expires_at, revoked_at,
            (SELECT COUNT(*) FROM agent_refresh_tokens c WHERE c.rotated_from = agent_refresh_tokens.id) AS children
       FROM agent_refresh_tokens WHERE token_hash = ?1`,
  )
    .bind(refreshHash)
    .first<{
      id: string;
      server_id: string;
      agent_id: string;
      account_id: string;
      integration: string;
      service: string;
      app_scope: string | null;
      expires_at: number;
      revoked_at: number | null;
      children: number;
    }>();

  if (!row) return { ok: false, code: "refresh_invalid" };
  // Reuse detection FIRST: a normal rotation marks the old token revoked AND gives it
  // a child, so the revoked_at check would otherwise shadow reuse. Presenting an
  // already-rotated token again is a compromise signal → revoke the identity's chain.
  if (row.children > 0) {
    await revokeAgentTokensForIdentity(env, {
      server_id: row.server_id,
      agent_id: row.agent_id,
      service: row.service,
    }, now);
    return { ok: false, code: "refresh_reused" };
  }
  if (row.revoked_at !== null) return { ok: false, code: "refresh_revoked" };
  if (row.expires_at <= now) return { ok: false, code: "refresh_expired" };

  const identity: AgentLoginIdentity = {
    server_id: row.server_id,
    agent_id: row.agent_id, // Raft provider_subject (binding key), carried forward
    account_id: row.account_id, // Hands account row (session subject), carried forward
    integration: row.integration,
    service: row.service,
    app_scope: row.app_scope,
  };
  const accessExpiresAt = now + AGENT_ACCESS_TTL_MS;
  const refreshExpiresAt = now + AGENT_REFRESH_TTL_MS;
  const sessionId = crypto.randomUUID();
  const accessToken = await createSignedJwt(
    env,
    identity.account_id,
    now,
    accessExpiresAt,
    sessionId,
  );
  const accessHash = await sha256Hex(accessToken);
  const newRefreshId = crypto.randomUUID();
  const newRefreshToken = randomOpaqueToken();
  const newRefreshHash = await sha256Base64Url(newRefreshToken);

  // Atomic rotation: fence (revoke old) + mint successor in ONE transaction. The mint
  // INSERTs are guarded on winning the fence (old.revoked_at == now, set by the
  // same-batch UPDATE); a concurrent second rotation of the SAME token matches 0 rows
  // on the fence and mints nothing (no double-issue). A mint failure rolls the fence
  // back too (no crash-lockout: we never revoke the old token without a successor).
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_refresh_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`,
    ).bind(row.id, now),
    env.DB.prepare(
      `INSERT INTO raft_sessions
         (id, account_id, token_hash, created_at, expires_at, last_seen_at,
          revoked_at, raft_access_token_ciphertext)
       SELECT ?1, ?2, ?3, ?4, ?5, ?4, NULL, NULL
        WHERE (SELECT revoked_at FROM agent_refresh_tokens WHERE id = ?6) = ?4`,
    ).bind(sessionId, identity.account_id, accessHash, now, accessExpiresAt, row.id),
    env.DB.prepare(
      `INSERT INTO agent_refresh_tokens
         (id, token_hash, server_id, agent_id, account_id, integration, service, app_scope,
          created_at, expires_at, rotated_from, revoked_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL
        WHERE (SELECT revoked_at FROM agent_refresh_tokens WHERE id = ?11) = ?9`,
    ).bind(
      newRefreshId,
      newRefreshHash,
      identity.server_id,
      identity.agent_id,
      identity.account_id,
      identity.integration,
      identity.service,
      identity.app_scope ?? null,
      now,
      refreshExpiresAt,
      row.id,
    ),
  ]);

  // Session INSERT wrote 1 row ⇒ we won the fence. 0 ⇒ a concurrent rotation of the
  // same token won; ask the client to retry (it must serialize refreshes, OAuth-style).
  if ((results[1]?.meta?.changes ?? 0) !== 1) {
    return { ok: false, code: "temporarily_unavailable" };
  }
  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      access_expires_at: accessExpiresAt,
      refresh_expires_at: refreshExpiresAt,
    },
  };
}

/** Revoke all live refresh tokens for an identity (lifecycle / admin / reuse). */
export async function revokeAgentTokensForIdentity(
  env: Env,
  identity: Pick<AgentLoginIdentity, "server_id" | "agent_id" | "service">,
  now: number = Date.now(),
): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE agent_refresh_tokens SET revoked_at = ?4
       WHERE server_id = ?1 AND agent_id = ?2 AND service = ?3 AND revoked_at IS NULL`,
  )
    .bind(identity.server_id, identity.agent_id, identity.service, now)
    .run();
  return res.meta.changes ?? 0;
}
