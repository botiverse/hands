/**
 * Agent CLI login (RFC 057, Hands first instance) — HTTP handlers.
 *
 * - agent-login action (AUTHENTICATED, manifest action reached via `integration
 *   invoke`): binds a proof-key grant to the pre-org-switch authenticated agent.
 * - exchange / refresh (PUBLIC token endpoints): the grant+verifier / refresh token
 *   IS the credential, like an OAuth token endpoint — no prior session required.
 *
 * See docs/agent-cli-login-hands-instance.md. The verifier is checked in the lib
 * and never stored/logged.
 */

import type { Context } from "hono";
import type { AdminContext } from "../lib/permissions";
import {
  exchangeAgentGrant,
  isValidS256Challenge,
  issueAgentGrant,
  rotateAgentRefresh,
  type AgentLoginErrorCode,
  type AgentLoginIdentity,
  type AgentTokens,
} from "../lib/agent_login";

const SERVICE = "hands";

/** Build the frozen RFC 057 `raft-cli-agent-session.v1` wire response. Expiry
 *  timestamps are RFC3339 UTC (authoritative service facts). */
function sessionResponse(tokens: AgentTokens) {
  return {
    schema: "raft-cli-agent-session.v1",
    token_type: "Bearer",
    access_token: tokens.access_token,
    access_expires_at: new Date(tokens.access_expires_at).toISOString(),
    refresh_token: tokens.refresh_token,
    refresh_expires_at:
      tokens.refresh_expires_at === null
        ? null
        : new Date(tokens.refresh_expires_at).toISOString(),
  };
}
// The recorded integration attribute. Not part of the security binding (which is
// server_id + agent_id + service); an audit/label field. TODO(confirm w/ XX):
// whether this should carry the exact Raft integration slug instead of the service.
const INTEGRATION = "hands";

// Map a closed-set error to an HTTP status. temporarily_unavailable is the only
// retryable one; everything else is a terminal client-side failure.
function statusFor(code: AgentLoginErrorCode): 400 | 401 | 409 | 503 {
  switch (code) {
    case "grant_expired":
    case "grant_consumed":
    case "refresh_expired":
    case "refresh_reused":
    case "refresh_revoked":
      return 409;
    case "temporarily_unavailable":
      return 503;
    default:
      // grant_invalid | grant_binding_mismatch | grant_proof_mismatch | refresh_invalid
      return 400;
  }
}

/**
 * `agent-login` manifest action. Requires an authenticated AGENT session; binds the
 * grant to the pre-org-switch identity (never the org-switchable admin_account, and
 * never request-body identity).
 */
export async function handleAgentLoginAction(c: AdminContext): Promise<Response> {
  // Tooth 1: only the valid-session branch sets this; deploy-token fallback does
  // not. Absent ⇒ fail closed.
  const authed = c.get("authenticated_account");
  if (!authed) {
    return c.json({ error: "unauthorized", code: "unauthenticated" }, 401);
  }
  // Tooth 2: human sessions cannot mint an agent grant.
  if (authed.principal_type !== "agent") {
    return c.json({ error: "forbidden", code: "agent_principal_required" }, 403);
  }

  const body = (await c.req.json().catch(() => null)) as
    | { schema?: unknown; code_challenge?: unknown; code_challenge_method?: unknown }
    | null;
  if (!body || body.schema !== "raft-cli-agent-login-request.v1") {
    return c.json({ error: "bad request", code: "invalid_schema" }, 400);
  }
  // Closed input (RFC 057): reject extension fields.
  const allowed = new Set(["schema", "code_challenge", "code_challenge_method"]);
  if (Object.keys(body).some((k) => !allowed.has(k))) {
    return c.json({ error: "unexpected fields (closed input)", code: "invalid_schema" }, 400);
  }
  if (body.code_challenge_method !== "S256") {
    return c.json({ error: "code_challenge_method must be S256", code: "invalid_challenge_method" }, 400);
  }
  // RFC 057: strict base64url (no padding), decodes to exactly 32 bytes, canonical.
  if (!isValidS256Challenge(body.code_challenge)) {
    return c.json({ error: "code_challenge must be an unpadded base64url SHA-256 decoding to 32 bytes", code: "invalid_challenge" }, 400);
  }

  // Tooth 3: identity (incl. audit actor) derives from the authenticated account,
  // NOT the org-switched admin_account/admin_actor.
  const identity: AgentLoginIdentity = {
    server_id: authed.server_id,
    agent_id: authed.id,
    integration: INTEGRATION,
    service: SERVICE,
  };
  const { grant, expires_at } = await issueAgentGrant(c.env, identity, body.code_challenge);
  return c.json({
    schema: "raft-cli-agent-login-grant.v1",
    service: SERVICE,
    grant,
    expires_at: new Date(expires_at).toISOString(),
  });
}

/** Public exchange: `{ grant, code_verifier }` → access + refresh. */
export async function handleAgentExchange(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as
    | { schema?: unknown; grant?: unknown; code_verifier?: unknown }
    | null;
  if (!body || body.schema !== "raft-cli-agent-login-exchange.v1") {
    return c.json({ error: "bad request", code: "invalid_schema" }, 400);
  }
  if (typeof body.grant !== "string" || typeof body.code_verifier !== "string") {
    return c.json({ error: "grant and code_verifier are required", code: "grant_invalid" }, 400);
  }
  // Atomic consume+mint: never burns a grant without issuing tokens.
  const result = await exchangeAgentGrant(c.env, body.grant, body.code_verifier);
  if (!result.ok) {
    return c.json({ error: result.code, code: result.code }, statusFor(result.code));
  }
  return c.json(sessionResponse(result.tokens));
}

/** Public refresh: `{ refresh_token }` → rotated access + refresh. */
export async function handleAgentRefresh(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as
    | { schema?: unknown; refresh_token?: unknown }
    | null;
  if (!body || body.schema !== "raft-cli-agent-refresh.v1") {
    return c.json({ error: "bad request", code: "invalid_schema" }, 400);
  }
  if (typeof body.refresh_token !== "string") {
    return c.json({ error: "refresh_token is required", code: "refresh_invalid" }, 400);
  }
  const result = await rotateAgentRefresh(c.env, body.refresh_token);
  if (!result.ok) {
    return c.json({ error: result.code, code: result.code }, statusFor(result.code));
  }
  return c.json(sessionResponse(result.tokens));
}
