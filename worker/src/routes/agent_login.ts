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
  consumeAgentGrant,
  issueAgentGrant,
  issueAgentTokens,
  rotateAgentRefresh,
  type AgentLoginErrorCode,
  type AgentLoginIdentity,
} from "../lib/agent_login";

const SERVICE = "hands";
// The recorded integration attribute. Not part of the security binding (which is
// server_id + agent_id + service); an audit/label field. TODO(confirm w/ XX):
// whether this should carry the exact Raft integration slug instead of the service.
const INTEGRATION = "hands";

// Map a closed-set error to an HTTP status. temporarily_unavailable is the only
// retryable one; everything else is a terminal client-side failure.
function statusFor(code: AgentLoginErrorCode): 400 | 401 | 409 | 503 {
  switch (code) {
    case "expired":
    case "consumed":
      return 409;
    case "temporarily_unavailable":
      return 503;
    default:
      return 400; // invalid | binding_mismatch | grant_proof_mismatch
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
  if (body.code_challenge_method !== "S256") {
    return c.json({ error: "code_challenge_method must be S256", code: "invalid_challenge_method" }, 400);
  }
  if (typeof body.code_challenge !== "string" || body.code_challenge.length < 43) {
    return c.json({ error: "code_challenge must be a base64url SHA-256", code: "invalid_challenge" }, 400);
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
    return c.json({ error: "grant and code_verifier are required", code: "invalid" }, 400);
  }
  const result = await consumeAgentGrant(c.env, body.grant, body.code_verifier);
  if (!result.ok) {
    return c.json({ error: result.code, code: result.code }, statusFor(result.code));
  }
  const tokens = await issueAgentTokens(c.env, result.identity);
  return c.json(tokens);
}

/** Public refresh: `{ refresh_token }` → rotated access + refresh. */
export async function handleAgentRefresh(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const body = (await c.req.json().catch(() => null)) as
    | { schema?: unknown; refresh_token?: unknown }
    | null;
  if (!body || typeof body.refresh_token !== "string") {
    return c.json({ error: "refresh_token is required", code: "invalid" }, 400);
  }
  const result = await rotateAgentRefresh(c.env, body.refresh_token);
  if (!result.ok) {
    return c.json({ error: result.code, code: result.code }, statusFor(result.code));
  }
  return c.json(result.tokens);
}
