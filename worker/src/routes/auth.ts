/**
 * Login with Raft routes.
 *
 * The Raft OAuth code and access token never leave the Worker. The browser
 * only receives Quiver's own HttpOnly session cookie.
 */

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  accountActor,
  loadAccountFromSession,
  SESSION_COOKIE,
  type AdminAccount,
} from "../middleware/auth";

const LOGIN_PENDING_COOKIE = "quiver_raft_login_pending";
const LOGIN_RETURN_COOKIE = "quiver_raft_return";

type RaftTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
};

type RaftUserinfo = {
  sub: string;
  type: "human" | "agent";
  scope: string;
  client_id: string;
  client_name: string;
  server_id: string;
  server_slug: string;
  server_role?: string;
  preferred_username?: string | null;
  name?: string | null;
  avatar_url?: string | null;
  picture?: string | null;
  description?: string | null;
};

function now() {
  return Date.now();
}

function appOrigin(c: Context<{ Bindings: Env }>): string {
  return c.env.APP_ORIGIN || new URL(c.req.url).origin;
}

function secureCookie(c: Context<{ Bindings: Env }>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function callbackUrl(c: Context<{ Bindings: Env }>): string {
  return `${appOrigin(c)}/login/raft/callback`;
}

function requireRaftConfig(c: Context<{ Bindings: Env }>) {
  const clientId = c.env.RAFT_CLIENT_ID;
  const clientSecret = c.env.RAFT_CLIENT_SECRET;
  const raftOrigin = c.env.RAFT_ORIGIN || "https://app.raft.build";
  const raftApiOrigin = c.env.RAFT_API_ORIGIN || "https://api.raft.build";
  if (!clientId || !clientSecret) {
    return {
      ok: false as const,
      response: c.json(
        {
          error: "Login with Raft is not configured",
          detail:
            "Set RAFT_CLIENT_ID and RAFT_CLIENT_SECRET on the Worker before disabling Cloudflare Access.",
        },
        503,
      ),
    };
  }
  return {
    ok: true as const,
    clientId,
    clientSecret,
    raftOrigin,
    raftApiOrigin,
  };
}

function normalizeReturnPath(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.startsWith("/api/") || raw.startsWith("/login/")) return "/";
  return raw;
}

function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeJsonSlice(text: string): string {
  return text.replace(/code=[^&\s"]+/g, "code=<redacted>").slice(0, 500);
}

function isUserAllowed(env: Env, userinfo: RaftUserinfo): boolean {
  const serverIds = (env.RAFT_ALLOWED_SERVER_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const serverSlugs = (env.RAFT_ALLOWED_SERVER_SLUGS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (serverIds.length === 0 && serverSlugs.length === 0) return true;
  return (
    serverIds.includes(userinfo.server_id) ||
    serverSlugs.includes(userinfo.server_slug)
  );
}

async function exchangeRaftCode(
  apiOrigin: string,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<RaftTokenResponse> {
  const response = await fetch(`${apiOrigin}/api/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${base64Utf8(`${clientId}:${clientSecret}`)}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
    }),
  });

  if (!response.ok) {
    const text = safeJsonSlice(await response.text());
    throw new Error(`Raft token exchange failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<RaftTokenResponse>;
}

async function fetchRaftUserinfo(
  apiOrigin: string,
  accessToken: string,
): Promise<RaftUserinfo> {
  const response = await fetch(`${apiOrigin}/api/oauth/userinfo`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    const text = safeJsonSlice(await response.text());
    throw new Error(`Raft userinfo failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<RaftUserinfo>;
}

async function upsertRaftAccount(
  db: D1Database,
  userinfo: RaftUserinfo,
): Promise<AdminAccount> {
  const timestamp = now();
  const displayName =
    userinfo.name || userinfo.preferred_username || "Raft user";
  const rawProfile = JSON.stringify(userinfo);

  await db
    .prepare(
      `INSERT INTO raft_accounts
       (id, provider, provider_subject, server_id, server_slug,
        principal_type, server_role, username, display_name, avatar_url,
        raw_profile, created_at, updated_at, last_login_at)
       VALUES (?1, 'raft', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?11)
       ON CONFLICT(provider, provider_subject, server_id) DO UPDATE SET
         server_slug = excluded.server_slug,
         principal_type = excluded.principal_type,
         server_role = excluded.server_role,
         username = excluded.username,
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         raw_profile = excluded.raw_profile,
         updated_at = excluded.updated_at,
         last_login_at = excluded.last_login_at`,
    )
    .bind(
      crypto.randomUUID(),
      userinfo.sub,
      userinfo.server_id,
      userinfo.server_slug,
      userinfo.type,
      userinfo.server_role ?? null,
      userinfo.preferred_username ?? null,
      displayName,
      userinfo.picture ?? null,
      rawProfile,
      timestamp,
    )
    .run();

  const account = await db
    .prepare(
      `SELECT * FROM raft_accounts
       WHERE provider = 'raft' AND provider_subject = ?1 AND server_id = ?2`,
    )
    .bind(userinfo.sub, userinfo.server_id)
    .first<AdminAccount>();
  if (!account) throw new Error("Raft account upsert did not return an account");
  return account;
}

async function createSession(
  db: D1Database,
  accountId: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const timestamp = now();
  const ttlSeconds = 60 * 60 * 24 * 14;
  const expiresAt = timestamp + ttlSeconds * 1000;
  await db
    .prepare(
      `INSERT INTO raft_sessions
       (id, account_id, token_hash, created_at, expires_at, last_seen_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4, NULL)`,
    )
    .bind(crypto.randomUUID(), accountId, tokenHash, timestamp, expiresAt)
    .run();
  return { token, expiresAt };
}

export async function handleAuthConfig(c: Context<{ Bindings: Env }>) {
  return c.json({
    provider: "raft",
    configured: Boolean(c.env.RAFT_CLIENT_ID && c.env.RAFT_CLIENT_SECRET),
    callback_url: callbackUrl(c),
  });
}

export async function handleAuthMe(c: Context<{ Bindings: Env }>) {
  const account = await loadAccountFromSession(
    c.env,
    getCookie(c, SESSION_COOKIE),
  );
  if (!account) {
    return c.json(
      {
        authenticated: false,
        login_url: `/api/auth/login?return=${encodeURIComponent("/")}`,
      },
      401,
    );
  }
  return c.json({
    authenticated: true,
    account: {
      id: account.id,
      provider: account.provider,
      server_id: account.server_id,
      server_slug: account.server_slug,
      principal_type: account.principal_type,
      server_role: account.server_role,
      username: account.username,
      display_name: account.display_name,
      avatar_url: account.avatar_url,
      actor: accountActor(account),
    },
  });
}

export async function handleAuthLogin(c: Context<{ Bindings: Env }>) {
  const config = requireRaftConfig(c);
  if (!config.ok) return config.response;

  const pending = randomToken(16);
  const returnPath = normalizeReturnPath(c.req.query("return"));
  setCookie(c, LOGIN_PENDING_COOKIE, pending, {
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: "Lax",
    path: "/",
    maxAge: 10 * 60,
  });
  setCookie(c, LOGIN_RETURN_COOKIE, returnPath, {
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: "Lax",
    path: "/",
    maxAge: 10 * 60,
  });

  const setup = new URL("/login-with-slock/setup", config.raftOrigin);
  setup.searchParams.set("client_id", config.clientId);
  setup.searchParams.set("return_to", callbackUrl(c));
  setup.searchParams.set("scope", "openid profile");
  return c.redirect(setup.toString(), 302);
}

export async function handleRaftCallback(c: Context<{ Bindings: Env }>) {
  const config = requireRaftConfig(c);
  if (!config.ok) return config.response;

  if (!getCookie(c, LOGIN_PENDING_COOKIE)) {
    return c.text("Missing local login state. Start again from /api/auth/login.", 400);
  }

  const code = c.req.query("code") || "";
  if (!code) return c.text("Missing Raft callback code", 400);

  try {
    const token = await exchangeRaftCode(
      config.raftApiOrigin,
      config.clientId,
      config.clientSecret,
      code,
    );
    const userinfo = await fetchRaftUserinfo(
      config.raftApiOrigin,
      token.access_token,
    );
    if (!isUserAllowed(c.env, userinfo)) {
      return c.text("This Raft server is not allowed for this Quiver admin.", 403);
    }

    const account = await upsertRaftAccount(c.env.DB, userinfo);
    const session = await createSession(c.env.DB, account.id);
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: secureCookie(c),
      sameSite: "Lax",
      path: "/",
      expires: new Date(session.expiresAt),
    });
    deleteCookie(c, LOGIN_PENDING_COOKIE, { path: "/" });
    const returnPath = normalizeReturnPath(getCookie(c, LOGIN_RETURN_COOKIE));
    deleteCookie(c, LOGIN_RETURN_COOKIE, { path: "/" });
    return c.redirect(returnPath, 302);
  } catch (error) {
    console.error(
      `[raft-auth] callback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return c.text("Login with Raft failed. Check Worker logs for details.", 502);
  }
}

export async function handleAuthLogout(c: Context<{ Bindings: Env }>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await c.env.DB.prepare(
      "UPDATE raft_sessions SET revoked_at = ?1 WHERE token_hash = ?2",
    )
      .bind(now(), tokenHash)
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
}

export async function handleAgentManifest(c: Context<{ Bindings: Env }>) {
  const origin = appOrigin(c);
  return c.json({
    schema: "https://app.raft.build/schemas/agent-manifest.v0.json",
    service: c.env.RAFT_CLIENT_ID || "quiver",
    docs_url: `${origin}/`,
    execution: {
      mode: "http_api",
      base_url: `${origin}/api`,
    },
    context_check: {
      url: `${origin}/api/auth/me`,
      method: "GET",
    },
  });
}
