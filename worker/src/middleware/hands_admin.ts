import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { decryptAdminRaftToken } from "../lib/admin_raft_token";
import { sha256Hex } from "../lib/deploy_tokens";
import {
  SESSION_COOKIE,
  type AdminAccount,
  type AdminEnv,
} from "./auth";

type LiveRaftUser = {
  sub: string;
  server_id: string;
  server_role?: string;
};

function deny(c: Context, status: 401 | 403 | 503, code: string) {
  const error = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "unavailable";
  return c.json({ error, code }, status);
}

export const requireHandsAdmin: MiddlewareHandler<AdminEnv & { Bindings: Env }> = async (c, next) => {
  const account = c.get("admin_account") as AdminAccount | undefined;
  if (!account) return deny(c, 401, "AUTH_REQUIRED");

  const authHeader = c.req.header("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
  const sessionToken = bearer ?? getCookie(c, SESSION_COOKIE);
  if (!sessionToken) return deny(c, 401, "AUTH_REQUIRED");

  const session = await c.env.DB.prepare(
    `SELECT raft_access_token_ciphertext
       FROM raft_sessions
      WHERE token_hash = ?1 AND account_id = ?2 AND revoked_at IS NULL AND expires_at > ?3
      LIMIT 1`,
  ).bind(await sha256Hex(sessionToken), account.id, Date.now())
    .first<{ raft_access_token_ciphertext: string | null }>();
  if (!session?.raft_access_token_ciphertext) {
    // A human browser session with no stored Raft credential (a legacy session, or
    // one from before the credential was captured) is recoverable by renewing the
    // browser session — a fresh Login-with-Raft stores one. An agent/CLI session
    // legitimately never has this credential and must NOT be sent through a browser
    // re-auth; it just cannot use the admin console.
    return deny(
      c,
      401,
      account.principal_type === "agent" ? "ADMIN_RELOGIN_REQUIRED" : "SESSION_REAUTH_REQUIRED",
    );
  }

  const secret = c.env.SIGNED_URL_SECRET || c.env.RAFT_CLIENT_SECRET;
  if (!secret || !c.env.RAFT_API_ORIGIN) return deny(c, 401, "ADMIN_AUTH_UNAVAILABLE");

  let accessToken: string;
  try {
    accessToken = await decryptAdminRaftToken(secret, session.raft_access_token_ciphertext);
  } catch {
    // A non-NULL ciphertext that won't decrypt is a browser session whose Raft
    // credential rotted (e.g. the encryption key changed). It is recoverable by
    // renewing the browser session (a fresh Login-with-Raft re-encrypts with the
    // current key) — signal that, not the generic relogin. Agent/API sessions hit
    // the NULL-ciphertext branch above and are never told to re-auth.
    return deny(c, 401, "SESSION_REAUTH_REQUIRED");
  }
  const response = await fetch(new URL("/api/oauth/userinfo", c.env.RAFT_API_ORIGIN), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  // Distinguish WHY Raft refused — three different world states must not collapse into
  // one reading, or transient outages and permission denials drag normal users into
  // repeated logins:
  //   401 — token invalid/expired (or the user was removed): recoverable by a browser
  //         session renewal (a valid user continues; a removed user's renewed token
  //         still fails userinfo, so the frontend loop guard falls back to the manual
  //         page — still denied, role revocation stays immediate).
  //   403 — a permission decision: not a login problem, do not renew.
  //   429 / 5xx / anything else — a transient Raft outage: re-login would not help and
  //         retrying worsens rate-limiting, so surface "temporarily unavailable".
  if (!response.ok) {
    if (response.status === 401) return deny(c, 401, "SESSION_REAUTH_REQUIRED");
    if (response.status === 403) return deny(c, 403, "HANDS_ADMIN_REQUIRED");
    return deny(c, 503, "ADMIN_VERIFICATION_UNAVAILABLE");
  }

  const live = await response.json<LiveRaftUser>();
  const allowedServers = (c.env.HANDS_ADMIN_ALLOWED_SERVER_IDS || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const role = (live.server_role || "").toLowerCase();
  if (
    live.sub !== account.provider_subject ||
    live.server_id !== account.server_id ||
    !allowedServers.includes(live.server_id) ||
    !["owner", "admin"].includes(role)
  ) {
    return deny(c, 403, "HANDS_ADMIN_REQUIRED");
  }

  await next();
};
