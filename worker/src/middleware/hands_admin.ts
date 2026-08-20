import type { Context, MiddlewareHandler } from "hono";
import { type AdminAccount, type AdminEnv } from "./auth";

function deny(c: Context, status: 401 | 403, code: string) {
  return c.json({ error: status === 401 ? "unauthorized" : "forbidden", code }, status);
}

// Unified admin auth: the admin console reuses the SAME Hands session as the rest of
// the app — one layer, not two.
//
// authMiddleware sets `admin_account` ONLY for a session that is present, not revoked,
// and not expired (loadAccountFromAuthToken filters `revoked_at IS NULL AND expires_at
// > now`). So a resolved admin_account here already IS a valid session, and the account
// row carries the server role captured at Login-with-Raft. Admin access is therefore a
// valid session + that login-time role being owner/admin on an allowed server.
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
  const account = c.get("admin_account") as AdminAccount | undefined;
  if (!account) return deny(c, 401, "AUTH_REQUIRED");

  const allowedServers = (c.env.HANDS_ADMIN_ALLOWED_SERVER_IDS || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const role = (account.server_role || "").toLowerCase();
  if (!allowedServers.includes(account.server_id) || !["owner", "admin"].includes(role)) {
    return deny(c, 403, "HANDS_ADMIN_REQUIRED");
  }

  await next();
};
