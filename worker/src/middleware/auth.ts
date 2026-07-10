/**
 * Admin authentication.
 *
 * Production uses Login with Raft exclusively:
 *   - /api/auth/login redirects to Raft setup.
 *   - /login/raft/callback exchanges the code server-side.
 *   - Admin routes require a Quiver auth token. Browsers carry it in the
 *     HttpOnly cookie; agents/CLIs carry the same token as Bearer auth.
 *
 * A static bearer token is accepted only when ENVIRONMENT !== "production",
 * so local development and unit smoke tests can still call admin endpoints
 * without a registered Raft OAuth client.
 */

import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { loadDeployToken, sha256Hex, type AppDeployToken } from "../lib/deploy_tokens";

export const SESSION_COOKIE = "quiver_session";
export const ACTIVE_ORG_HEADER = "x-hands-org-id";

export type AdminAccount = {
  id: string;
  provider: "raft";
  provider_subject: string;
  server_id: string;
  server_slug: string | null;
  principal_type: "human" | "agent";
  server_role: string | null;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  raw_profile: string;
  created_at: number;
  updated_at: number;
  last_login_at: number;
  org_id?: string | null;
  org_role?: "owner" | "admin" | "member" | "viewer" | null;
};

export type AdminEnv = {
  Variables: {
    admin_account?: AdminAccount;
    admin_deploy_token?: AppDeployToken;
    admin_actor?: string;
    org_id?: string;
    org_role?: "owner" | "admin" | "member" | "viewer";
  };
};

export function isProductionEnv(env: Env): boolean {
  return String(env.ENVIRONMENT ?? "production") === "production";
}

export function accountActor(account: AdminAccount): string {
  const handle = account.username || account.display_name || account.provider_subject;
  const server = account.server_slug || account.server_id;
  return `raft:${handle}@${server}`;
}

export function currentActor(c: Context<any>): string {
  return c.get("admin_actor") || "admin";
}

export function currentActorInfo(c: Context<any>): {
  id: string | null;
  type: "human" | "agent" | "system";
  display_name: string;
} {
  const account = c.get("admin_account") as AdminAccount | undefined;
  if (account) {
    return {
      id: account.id,
      type: account.principal_type,
      display_name: accountActor(account),
    };
  }
  const deployToken = c.get("admin_deploy_token") as AppDeployToken | undefined;
  if (deployToken) {
    return {
      id: deployToken.id,
      type: "agent",
      display_name: `deploy-token:${deployToken.name}@${deployToken.app_slug}`,
    };
  }
  return {
    id: null,
    type: "system",
    display_name: currentActor(c),
  };
}

export async function loadAccountFromAuthToken(
  env: Env,
  token: string | undefined,
): Promise<AdminAccount | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const account = await env.DB.prepare(
    `SELECT a.*, om.org_id, om.org_role
     FROM raft_sessions s
     JOIN raft_accounts a ON a.id = s.account_id
     LEFT JOIN organizations o
       ON o.external_provider = 'raft'
      AND o.external_id = a.server_id
     LEFT JOIN org_members om
       ON om.org_id = o.id
      AND om.account_id = a.id
     WHERE s.token_hash = ?1
       AND s.revoked_at IS NULL
       AND s.expires_at > ?2
     LIMIT 1`,
  )
    .bind(tokenHash, now)
    .first<AdminAccount>();

  if (!account) return null;

  await env.DB.prepare(
    "UPDATE raft_sessions SET last_seen_at = ?1 WHERE token_hash = ?2",
  )
    .bind(now, tokenHash)
    .run();
  return account;
}

export async function accountForRequestedOrg(
  env: Env,
  account: AdminAccount,
  requestedOrgId: string | undefined,
): Promise<AdminAccount> {
  const orgId = requestedOrgId?.trim();
  if (!orgId || orgId === account.org_id) return account;

  const membership = await env.DB.prepare(
    `SELECT linked.*, om.org_id, om.org_role
     FROM org_members om
     JOIN organizations o ON o.id = om.org_id
     JOIN raft_accounts linked ON linked.id = om.account_id
     WHERE linked.provider = ?1
       AND linked.provider_subject = ?2
       AND linked.principal_type = ?3
       AND om.org_id = ?4
       AND o.archived = 0
     LIMIT 1`,
  )
    .bind(account.provider, account.provider_subject, account.principal_type, orgId)
    .first<AdminAccount>();

  return membership ?? account;
}

export const authMiddleware: MiddlewareHandler<AdminEnv & { Bindings: Env }> =
  async (c, next) => {
    const cookieToken = getCookie(c, SESSION_COOKIE);
    const authHeader = c.req.header("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : undefined;
    const sessionAccount = await loadAccountFromAuthToken(
      c.env,
      cookieToken || bearerToken,
    );
    if (sessionAccount) {
      const account = await accountForRequestedOrg(
        c.env,
        sessionAccount,
        c.req.header(ACTIVE_ORG_HEADER),
      );
      c.set("admin_account", account);
      c.set("admin_actor", accountActor(account));
      if (account.org_id) c.set("org_id", account.org_id);
      if (account.org_role) c.set("org_role", account.org_role);
      await next();
      return;
    }

    if (!cookieToken && bearerToken) {
      const deployToken = await loadDeployToken(c.env, bearerToken);
      if (deployToken) {
        c.set("admin_deploy_token", deployToken);
        c.set("admin_actor", `deploy-token:${deployToken.name}@${deployToken.app_slug}`);
        await next();
        return;
      }
    }

    if (!isProductionEnv(c.env)) {
      const auth = c.req.header("authorization");
      const expected = c.env.ADMIN_API_TOKEN;
      if (expected && auth?.startsWith("Bearer ")) {
        const token = auth.slice("Bearer ".length).trim();
        if (token === expected) {
          c.set("admin_actor", "dev-token");
          await next();
          return;
        }
      }
    }

    const returnTo = new URL(c.req.url).pathname;
    return c.json(
      {
        error: "unauthorized",
        login_url: `/api/auth/login?return=${encodeURIComponent(returnTo)}`,
      },
      401,
    );
  };
