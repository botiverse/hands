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
  // The `raft_accounts.id` of the authenticated agent account. Used as the access
  // JWT `sub` and the `raft_sessions.account_id`, so the minted access token
  // resolves through the normal auth middleware. Also the binding/revoke key.
  agent_id: string;
  integration: string;
  service: string; // "hands"
  app_scope?: string | null;
}

/** Closed error set (mirrors RFC 057 exchange errors). */
export type AgentLoginErrorCode =
  | "invalid"
  | "expired"
  | "consumed"
  | "binding_mismatch"
  | "grant_proof_mismatch"
  | "temporarily_unavailable";

export interface AgentTokens {
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
}

type ConsumeResult =
  | { ok: true; identity: AgentLoginIdentity }
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
       (grant_digest, server_id, agent_id, integration, service,
        code_challenge, nonce, issued_at, expires_at, consumed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)`,
  )
    .bind(
      grantDigest,
      identity.server_id,
      identity.agent_id,
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
 * exchange step 1: verify the proof and atomically consume the grant (single-use).
 * Returns the bound identity on success, or a typed closed-set error.
 * The verifier is checked here and never stored/logged.
 */
export async function consumeAgentGrant(
  env: Env,
  grant: string,
  codeVerifier: string,
  now: number = Date.now(),
): Promise<ConsumeResult> {
  if (!grant || !codeVerifier) return { ok: false, code: "invalid" };
  const grantDigest = await sha256Base64Url(grant);
  const row = await env.DB.prepare(
    `SELECT server_id, agent_id, integration, service,
            code_challenge, expires_at, consumed_at
       FROM agent_login_grants WHERE grant_digest = ?1`,
  )
    .bind(grantDigest)
    .first<{
      server_id: string;
      agent_id: string;
      integration: string;
      service: string;
      code_challenge: string;
      expires_at: number;
      consumed_at: number | null;
    }>();

  if (!row) return { ok: false, code: "invalid" };
  if (row.consumed_at !== null) return { ok: false, code: "consumed" };
  if (row.expires_at <= now) return { ok: false, code: "expired" };

  // Proof check BEFORE consuming: a wrong verifier must not burn the grant (so a
  // stolen-grant attacker without the verifier can't DoS the legitimate CLI).
  const challengeFromVerifier = await sha256Base64Url(codeVerifier);
  if (challengeFromVerifier !== row.code_challenge) {
    return { ok: false, code: "grant_proof_mismatch" };
  }

  // Atomic single-use consume: only one exchange wins the WHERE consumed_at IS NULL.
  const consumed = await env.DB.prepare(
    `UPDATE agent_login_grants SET consumed_at = ?2
       WHERE grant_digest = ?1 AND consumed_at IS NULL AND expires_at > ?3`,
  )
    .bind(grantDigest, now, now)
    .run();
  if (consumed.meta.changes !== 1) return { ok: false, code: "consumed" };

  return {
    ok: true,
    identity: {
      server_id: row.server_id,
      agent_id: row.agent_id,
      integration: row.integration,
      service: row.service,
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
  const accessToken = await createSignedJwt(
    env,
    identity.agent_id,
    now,
    accessExpiresAt,
    crypto.randomUUID(),
  );
  await env.DB.prepare(
    `INSERT INTO raft_sessions
       (id, account_id, token_hash, created_at, expires_at, last_seen_at,
        revoked_at, raft_access_token_ciphertext)
     VALUES (?1, ?2, ?3, ?4, ?5, ?4, NULL, NULL)`,
  )
    .bind(
      crypto.randomUUID(),
      identity.agent_id,
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
  const accessToken = await mintAccessToken(env, identity, now, accessExpiresAt);
  const refreshToken = randomOpaqueToken();
  const refreshHash = await sha256Base64Url(refreshToken);
  await env.DB.prepare(
    `INSERT INTO agent_refresh_tokens
       (id, token_hash, server_id, agent_id, integration, service, app_scope,
        created_at, expires_at, rotated_from, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL)`,
  )
    .bind(
      crypto.randomUUID(),
      refreshHash,
      identity.server_id,
      identity.agent_id,
      identity.integration,
      identity.service,
      identity.app_scope ?? null,
      now,
      now + AGENT_REFRESH_TTL_MS,
    )
    .run();
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    access_expires_at: accessExpiresAt,
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
  if (!refreshToken) return { ok: false, code: "invalid" };
  const refreshHash = await sha256Base64Url(refreshToken);
  const row = await env.DB.prepare(
    `SELECT id, server_id, agent_id, integration, service, app_scope,
            expires_at, revoked_at,
            (SELECT COUNT(*) FROM agent_refresh_tokens c WHERE c.rotated_from = agent_refresh_tokens.id) AS children
       FROM agent_refresh_tokens WHERE token_hash = ?1`,
  )
    .bind(refreshHash)
    .first<{
      id: string;
      server_id: string;
      agent_id: string;
      integration: string;
      service: string;
      app_scope: string | null;
      expires_at: number;
      revoked_at: number | null;
      children: number;
    }>();

  if (!row) return { ok: false, code: "invalid" };
  // Reuse detection FIRST: a normal rotation marks the old token revoked AND gives it
  // a child, so the revoked_at check would otherwise shadow reuse. Presenting an
  // already-rotated token again is a compromise signal → revoke the identity's chain.
  if (row.children > 0) {
    await revokeAgentTokensForIdentity(env, {
      server_id: row.server_id,
      agent_id: row.agent_id,
      service: row.service,
    }, now);
    return { ok: false, code: "consumed" };
  }
  if (row.revoked_at !== null) return { ok: false, code: "consumed" };
  if (row.expires_at <= now) return { ok: false, code: "expired" };

  // Mark old rotated, then mint the successor bound to rotated_from.
  await env.DB.prepare(
    `UPDATE agent_refresh_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL`,
  )
    .bind(row.id, now)
    .run();
  const tokens = await mintTokensRotated(env, {
    server_id: row.server_id,
    agent_id: row.agent_id,
    integration: row.integration,
    service: row.service,
    app_scope: row.app_scope,
  }, row.id, now);
  return { ok: true, tokens };
}

async function mintTokensRotated(
  env: Env,
  identity: AgentLoginIdentity,
  rotatedFrom: string,
  now: number,
): Promise<AgentTokens> {
  const accessExpiresAt = now + AGENT_ACCESS_TTL_MS;
  const accessToken = await mintAccessToken(env, identity, now, accessExpiresAt);
  const refreshToken = randomOpaqueToken();
  const refreshHash = await sha256Base64Url(refreshToken);
  await env.DB.prepare(
    `INSERT INTO agent_refresh_tokens
       (id, token_hash, server_id, agent_id, integration, service, app_scope,
        created_at, expires_at, rotated_from, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)`,
  )
    .bind(
      crypto.randomUUID(),
      refreshHash,
      identity.server_id,
      identity.agent_id,
      identity.integration,
      identity.service,
      identity.app_scope ?? null,
      now,
      now + AGENT_REFRESH_TTL_MS,
      rotatedFrom,
    )
    .run();
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    access_expires_at: accessExpiresAt,
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
