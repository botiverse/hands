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

function deny(c: Context, status: 401 | 403, code: string) {
  return c.json({ error: status === 401 ? "unauthorized" : "forbidden", code }, status);
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
  if (!session?.raft_access_token_ciphertext) return deny(c, 401, "ADMIN_RELOGIN_REQUIRED");

  const secret = c.env.SIGNED_URL_SECRET || c.env.RAFT_CLIENT_SECRET;
  if (!secret || !c.env.RAFT_API_ORIGIN) return deny(c, 401, "ADMIN_AUTH_UNAVAILABLE");

  let accessToken: string;
  try {
    accessToken = await decryptAdminRaftToken(secret, session.raft_access_token_ciphertext);
  } catch {
    return deny(c, 401, "ADMIN_RELOGIN_REQUIRED");
  }
  const response = await fetch(new URL("/api/oauth/userinfo", c.env.RAFT_API_ORIGIN), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return deny(c, 401, "AUTH_EXPIRED");

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
