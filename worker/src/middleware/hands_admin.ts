import type { Context, MiddlewareHandler } from "hono";
import { type AdminAccount, type AdminEnv } from "./auth";

function deny(c: Context, status: 401 | 403, code: string) {
  return c.json({ error: status === 401 ? "unauthorized" : "forbidden", code }, status);
}

// Unified admin auth: the admin console reuses the SAME Hands session as the rest of
// the app — one layer, not two.
//
// This gates on `authenticated_account` — the identity established by the session
// itself — NOT `admin_account`. authMiddleware sets `authenticated_account` from the
// session token ONLY for a session that is present, not revoked, and not expired
// (loadAccountFromAuthToken filters `revoked_at IS NULL AND expires_at > now`), and it
// carries the server role captured at Login-with-Raft. `admin_account` is DERIVED from
// it via the client-supplied `x-hands-org-id` header (org switching), so it must never
// drive an authorization decision — that would let a client influence its own admin
// check. Admin access is therefore: a valid session + that session identity's login-time
// role being owner/admin on an allowed server.
//
// This deliberately drops the previous SECOND layer — a per-session Raft access token,
// stored encrypted on the session row, decrypted and re-checked against Raft
// `/api/oauth/userinfo` on every request. That token expired (~1h) and rotted
// independently of the 14-day session: it locked admins out ("can see app details,
// can't enter admin") while regular app auth, which never touched it, kept working.
//
// TRADEOFF: a Raft-side owner/admin change now takes effect when the session next
// refreshes (a fresh login, session expiry, or an explicit session revoke), not on the
// very next request. For an internal admin console that is acceptable; revocation stays
// enforceable immediately by revoking the account's sessions (`revoked_at`, the "kick"
// path) or by a shorter session lifetime, because both feed the same authMiddleware
// check above.
export const requireHandsAdmin: MiddlewareHandler<AdminEnv & { Bindings: Env }> = async (c, next) => {
  const account = c.get("authenticated_account") as AdminAccount | undefined;
  if (!account) return deny(c, 401, "AUTH_REQUIRED");

  // Intentionally NOT restricted by principal_type: BOTH human and agent identities
  // qualify if they are owner/admin on an allowed server (artin's decision 2026-08-20).
  // The guarded endpoint is read-only, global-aggregate observability (not user content),
  // and every access is recorded in hands_admin_access_audit (actor id + type). Do not
  // add a human-only gate here without an explicit decision to reverse that — the test
  // suite asserts an owner/admin agent is admitted, so such a change fails loudly.
  const allowedServers = (c.env.HANDS_ADMIN_ALLOWED_SERVER_IDS || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const role = (account.server_role || "").toLowerCase();
  const sessionServerAdmits = allowedServers.includes(account.server_id) && ["owner", "admin"].includes(role);
  if (!sessionServerAdmits && !(await sameLoginAdmits(c.env, account, allowedServers))) {
    return deny(c, 403, "HANDS_ADMIN_REQUIRED");
  }

  await next();
};

// An account-mode Login with Raft (RFC 079) refreshes one account per server
// in the same sign-in (signInRaftIdentities) and starts the session in one of
// them, which need not be the admin server. Those sibling accounts carry the
// role Raft reported for their server in that same login, so they count as the
// session identity's. "Same login" is their last_login_at within a minute of
// the session account's; a sibling refreshed by an older, separate login (a
// server-mode login to another server) does not count.
const SAME_LOGIN_WINDOW_MS = 60_000;

async function sameLoginAdmits(env: Env, account: AdminAccount, allowedServers: string[]): Promise<boolean> {
  if (allowedServers.length === 0) return false;
  const placeholders = allowedServers.map((_, index) => `?${index + 5}`).join(", ");
  const row = await env.DB.prepare(
    `SELECT id FROM raft_accounts
     WHERE provider = ?1 AND provider_subject = ?2 AND principal_type = ?3
       AND last_login_at >= ?4
       AND lower(COALESCE(server_role, '')) IN ('owner', 'admin')
       AND server_id IN (${placeholders})
     LIMIT 1`,
  )
    .bind(
      account.provider,
      account.provider_subject,
      account.principal_type,
      account.last_login_at - SAME_LOGIN_WINDOW_MS,
      ...allowedServers,
    )
    .first<{ id: string }>();
  return !!row;
}
