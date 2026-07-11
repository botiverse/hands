/**
 * Login with Raft routes.
 *
 * The Raft OAuth code and Raft access token never leave the Worker. The
 * browser receives a Hands-signed JWT for Authorization: Bearer requests.
 */

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  accountActor,
  accountForRequestedOrg,
  ACTIVE_ORG_HEADER,
  loadAccountFromAuthToken,
  SESSION_COOKIE,
  type AdminAccount,
} from "../middleware/auth";
import {
  businessOrigin,
  configuredProductionHost,
  dashboardOrigin,
  isSecureRequest,
  requestOrigin,
  sharedCookieDomain,
} from "../lib/origin";

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

type LoginResult = {
  account: AdminAccount;
  authToken: { token: string; expiresAt: number };
};

function now() {
  return Date.now();
}

function appOrigin(c: Context<{ Bindings: Env }>): string {
  return requestOrigin(c);
}

function secureCookie(c: Context<{ Bindings: Env }>): boolean {
  return isSecureRequest(c);
}

function isHandsProductionHost(c: Context<{ Bindings: Env }>): boolean {
  const hostname = new URL(c.req.url).hostname;
  return configuredProductionHost(c.env, hostname);
}

function sharedCookieDomainOption(
  c: Context<{ Bindings: Env }>,
): { domain: string } | Record<string, never> {
  const domain = sharedCookieDomain(c.env);
  return isHandsProductionHost(c) && domain ? { domain } : {};
}

function callbackUrl(c: Context<{ Bindings: Env }>): string {
  const origin = isHandsProductionHost(c)
    ? businessOrigin(c.env, () => appOrigin(c))
    : appOrigin(c);
  return `${origin}/login/raft/callback`;
}

function browserReturnUrl(
  c: Context<{ Bindings: Env }>,
  returnPath: string,
): string {
  return isHandsProductionHost(c)
    ? `${dashboardOrigin(c.env, () => appOrigin(c))}${returnPath}`
    : returnPath;
}

function requireRaftConfig(c: Context<{ Bindings: Env }>) {
  const clientId = c.env.RAFT_CLIENT_ID;
  const clientSecret = c.env.RAFT_CLIENT_SECRET;
  const raftOrigin = c.env.RAFT_ORIGIN;
  const raftApiOrigin = c.env.RAFT_API_ORIGIN;
  const business = c.env.BUSINESS_ORIGIN;
  const dashboard = c.env.DASHBOARD_ORIGIN;
  const missing = [
    clientId ? undefined : "RAFT_CLIENT_ID",
    clientSecret ? undefined : "RAFT_CLIENT_SECRET",
    raftOrigin ? undefined : "RAFT_ORIGIN",
    raftApiOrigin ? undefined : "RAFT_API_ORIGIN",
    business ? undefined : "BUSINESS_ORIGIN",
    dashboard ? undefined : "DASHBOARD_ORIGIN",
  ].filter((key): key is string => Boolean(key));
  if (missing.length > 0) {
    return {
      ok: false as const,
      response: c.json(
        {
          error: "Login with Raft is not configured",
          missing,
          detail: `Set ${missing.join(", ")} on the Worker before using Login with Raft.`,
        },
        503,
      ),
    };
  }
  return {
    ok: true as const,
    clientId: clientId!,
    clientSecret: clientSecret!,
    raftOrigin: raftOrigin!,
    raftApiOrigin: raftApiOrigin!,
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

function base64UrlUtf8(input: string): string {
  return base64Utf8(input)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function createSignedJwt(
  env: Env,
  accountId: string,
  issuedAt: number,
  expiresAt: number,
  jwtId: string,
): Promise<string> {
  const secret = env.SIGNED_URL_SECRET || env.RAFT_CLIENT_SECRET;
  if (!secret) throw new Error("SIGNED_URL_SECRET or RAFT_CLIENT_SECRET is required for auth JWTs");
  const header = base64UrlUtf8(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlUtf8(JSON.stringify({
    iss: businessOrigin(env),
    aud: "hands-dashboard",
    sub: accountId,
    jti: jwtId,
    iat: Math.floor(issuedAt / 1000),
    exp: Math.floor(expiresAt / 1000),
  }));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`hands-auth-jwt-v1:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slugifyOrgPart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "raft"
  );
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

function roleFromRaftServerRole(role: string | null | undefined) {
  const normalized = (role || "").toLowerCase();
  if (normalized === "owner") return "owner";
  if (normalized === "admin") return "admin";
  return null;
}

async function isFirstHumanInServer(db: D1Database, serverId: string, accountId: string) {
  const row = await db
    .prepare(
      `SELECT id
       FROM raft_accounts
       WHERE server_id = ?1 AND principal_type = 'human'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .bind(serverId)
    .first<{ id: string }>();
  return row?.id === accountId;
}

async function isFirstPrincipalInServer(db: D1Database, serverId: string, accountId: string) {
  const row = await db
    .prepare(
      `SELECT id
       FROM raft_accounts
       WHERE server_id = ?1
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .bind(serverId)
    .first<{ id: string }>();
  return row?.id === accountId;
}

async function defaultOrgRoleForAccount(
  db: D1Database,
  account: AdminAccount,
): Promise<"owner" | "admin" | "member" | "viewer"> {
  const raftRole = roleFromRaftServerRole(account.server_role);
  if (raftRole) return raftRole;
  if (account.principal_type === "human") {
    return (await isFirstHumanInServer(db, account.server_id, account.id))
      ? "owner"
      : "member";
  }
  return (await isFirstPrincipalInServer(db, account.server_id, account.id))
    ? "admin"
    : "member";
}

async function upsertRaftOrgMembership(
  db: D1Database,
  account: AdminAccount,
): Promise<{ org_id: string; org_role: "owner" | "admin" | "member" | "viewer" }> {
  const timestamp = now();
  const orgId = `raft_${account.server_id}`;
  const slugBase = slugifyOrgPart(account.server_slug || account.server_id);
  const slug = `${slugBase}-${account.server_id.slice(0, 8)}`;
  const name = account.server_slug || `Raft server ${account.server_id.slice(0, 8)}`;
  const orgRole = await defaultOrgRoleForAccount(db, account);

  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations
         (id, slug, name, external_provider, external_id, created_at, archived)
         VALUES (?1, ?2, ?3, 'raft', ?4, ?5, 0)
         ON CONFLICT(external_provider, external_id) DO UPDATE SET
           slug = excluded.slug,
           name = excluded.name`,
      )
      .bind(orgId, slug, name, account.server_id, timestamp),
    db
      .prepare(
        `INSERT INTO org_members
         (id, org_id, account_id, org_role, invited_by, joined_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)
         ON CONFLICT(org_id, account_id) DO NOTHING`,
      )
      .bind(`orgmem_${account.id}`, orgId, account.id, orgRole, timestamp),
  ]);

  const membership = await db
    .prepare(
      `SELECT org_id, org_role
       FROM org_members
       WHERE org_id = ?1 AND account_id = ?2`,
    )
    .bind(orgId, account.id)
    .first<{ org_id: string; org_role: "owner" | "admin" | "member" | "viewer" }>();
  if (!membership) throw new Error("Raft org membership upsert did not return a row");
  return membership;
}

async function createAuthToken(
  env: Env,
  accountId: string,
): Promise<{ token: string; expiresAt: number }> {
  const timestamp = now();
  const ttlSeconds = 60 * 60 * 24 * 14;
  const expiresAt = timestamp + ttlSeconds * 1000;
  const sessionId = crypto.randomUUID();
  const token = await createSignedJwt(env, accountId, timestamp, expiresAt, sessionId);
  const tokenHash = await sha256Hex(token);
  await env.DB
    .prepare(
      `INSERT INTO raft_sessions
       (id, account_id, token_hash, created_at, expires_at, last_seen_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4, NULL)`,
    )
    .bind(sessionId, accountId, tokenHash, timestamp, expiresAt)
    .run();
  return { token, expiresAt };
}

async function finalizeRaftLogin(
  c: Context<{ Bindings: Env }>,
  config: {
    raftApiOrigin: string;
    clientId: string;
    clientSecret: string;
  },
  code: string,
): Promise<LoginResult | Response> {
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
    return c.text("This Raft server is not allowed for this Hands admin.", 403);
  }

  const account = await upsertRaftAccount(c.env.DB, userinfo);
  const membership = await upsertRaftOrgMembership(c.env.DB, account);
  account.org_id = membership.org_id;
  account.org_role = membership.org_role;
  const authToken = await createAuthToken(c.env, account.id);
  return { account, authToken };
}

function agentLoginJson(result: LoginResult) {
  return {
    ok: true,
    token_type: "Bearer",
    access_token: result.authToken.token,
    expires_at: result.authToken.expiresAt,
    account: {
      id: result.account.id,
      server_id: result.account.server_id,
      server_slug: result.account.server_slug,
      principal_type: result.account.principal_type,
      username: result.account.username,
      display_name: result.account.display_name,
      actor: accountActor(result.account),
      org_id: result.account.org_id ?? null,
      org_role: result.account.org_role ?? null,
    },
    usage: {
      authorization: "Authorization: Bearer <access_token>",
    },
  };
}

export async function handleAuthConfig(c: Context<{ Bindings: Env }>) {
  return c.json({
    provider: "raft",
    configured: Boolean(c.env.RAFT_CLIENT_ID && c.env.RAFT_CLIENT_SECRET),
    callback_url: callbackUrl(c),
  });
}

export async function handleAuthMe(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : undefined;
  const sessionAccount = await loadAccountFromAuthToken(
    c.env,
    bearerToken,
  );
  if (!sessionAccount) {
    return c.json(
      {
        authenticated: false,
        login_url: `/api/auth/login?return=${encodeURIComponent("/")}`,
      },
      401,
    );
  }
  const account = await accountForRequestedOrg(
    c.env,
    sessionAccount,
    c.req.header(ACTIVE_ORG_HEADER),
  );
  return c.json({
    authenticated: true,
    account: {
      id: account.id,
      provider: account.provider,
      server_id: account.server_id,
      server_slug: account.server_slug,
      principal_type: account.principal_type,
      server_role: account.server_role,
      org_id: account.org_id ?? null,
      org_role: account.org_role ?? null,
      username: account.username,
      display_name: account.display_name,
      avatar_url: account.avatar_url,
      actor: accountActor(account),
    },
    // Post-login orientation for agents/scripts: /api/auth/me is the manifest's
    // context_check, so it's the first thing a fresh login sees.
    help: {
      hint: "New here? GET /api/agent/help (the manifest's `help` action) for auth model, action list, crash-triage flow, and docs.",
      url: "/api/agent/help",
    },
  });
}

export async function handleAuthLogin(c: Context<{ Bindings: Env }>) {
  const config = requireRaftConfig(c);
  if (!config.ok) return config.response;

  const pending = randomToken(16);
  const returnPath = normalizeReturnPath(c.req.query("return") ?? c.req.query("return_to"));
  setCookie(c, LOGIN_PENDING_COOKIE, pending, {
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: "Lax",
    ...sharedCookieDomainOption(c),
    path: "/",
    maxAge: 10 * 60,
  });
  setCookie(c, LOGIN_RETURN_COOKIE, returnPath, {
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: "Lax",
    ...sharedCookieDomainOption(c),
    path: "/",
    maxAge: 10 * 60,
  });

  const setup = new URL("/login-with-raft/setup", config.raftOrigin);
  setup.searchParams.set("client_id", config.clientId);
  setup.searchParams.set("return_to", callbackUrl(c));
  setup.searchParams.set("scope", "openid profile");
  const setupUrl = setup.toString();
  const accept = c.req.header("accept") || "";
  if (accept.includes("text/html")) {
    c.header("cache-control", "no-store");
    return c.html(
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0;url=${escapeHtml(setupUrl)}" />
    <title>Redirecting to Raft</title>
    <script>location.replace(${JSON.stringify(setupUrl)});</script>
  </head>
  <body>
    <a href="${escapeHtml(setupUrl)}">Continue to Raft</a>
  </body>
</html>`,
    );
  }
  return c.redirect(setupUrl, 302);
}

export async function handleRaftCallback(c: Context<{ Bindings: Env }>) {
  const config = requireRaftConfig(c);
  if (!config.ok) return config.response;

  const code = c.req.query("code") || "";
  if (!code) return c.text("Missing Raft callback code", 400);

  try {
    const hasPendingBrowserLogin = Boolean(getCookie(c, LOGIN_PENDING_COOKIE));
    const result = await finalizeRaftLogin(c, config, code);
    if (result instanceof Response) return result;

    if (!hasPendingBrowserLogin) {
      if (result.account.principal_type !== "agent") {
        return c.text("Missing local login state. Start again from /api/auth/login.", 400);
      }
      // Stateless agent login (e.g. raft CLI `integration login`). The CLI stores
      // and replays a Set-Cookie rather than the JSON token, so set the session
      // cookie in addition to returning the token in the body.
      setCookie(c, SESSION_COOKIE, result.authToken.token, {
        httpOnly: true,
        secure: secureCookie(c),
        sameSite: "Lax",
        ...sharedCookieDomainOption(c),
        path: "/",
        expires: new Date(result.authToken.expiresAt),
      });
      c.header("cache-control", "no-store");
      return c.json(agentLoginJson(result));
    }

    deleteCookie(c, LOGIN_PENDING_COOKIE, {
      ...sharedCookieDomainOption(c),
      path: "/",
    });
    const returnPath = normalizeReturnPath(getCookie(c, LOGIN_RETURN_COOKIE));
    deleteCookie(c, LOGIN_RETURN_COOKIE, {
      ...sharedCookieDomainOption(c),
      path: "/",
    });
    const destination = new URL(browserReturnUrl(c, returnPath), requestOrigin(c));
    destination.hash = new URLSearchParams({
      access_token: result.authToken.token,
      expires_at: String(result.authToken.expiresAt),
    }).toString();
    return c.redirect(destination.toString(), 302);
  } catch (error) {
    console.error(
      `[raft-auth] callback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return c.text("Login with Raft failed. Check Worker logs for details.", 502);
  }
}

export async function handleAuthLogout(c: Context<{ Bindings: Env }>) {
  const authHeader = c.req.header("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : undefined;
  const token = bearerToken ?? getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await c.env.DB.prepare(
      "UPDATE raft_sessions SET revoked_at = ?1 WHERE token_hash = ?2",
    )
      .bind(now(), tokenHash)
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, {
    ...sharedCookieDomainOption(c),
    path: "/",
  });
  return c.json({ ok: true });
}

/**
 * Agent/API quick-start (the manifest's `help` action). Public by design —
 * this is how a caller learns to authenticate in the first place. Content
 * mirrors the CLI's --help recipes and /docs/agent-cli-feedback.
 */
export async function handleAgentHelp(c: Context<{ Bindings: Env }>) {
  const origin = appOrigin(c);
  c.header("Cache-Control", "no-store");
  return c.json({
    service: "hands",
    start_here: [
      "1. Authenticate (see `auth` below), then GET /api/apps to find your app_id.",
      "2. Crash triage: list-feedback (kind=crash) → get-feedback (device context + attachments) → presign-feedback-attachment, then curl the returned download_url yourself (raw-bytes endpoints get corrupted through agent transports).",
      "3. Update tickets as you work: PATCH status/assignee, POST comments (see `write_endpoints`).",
    ],
    auth: {
      raft_agents:
        "Run `raft integration login --service <hands-service>` once; then call actions via `raft integration invoke --service <hands-service> --action <name>`. The stored session authenticates you automatically.",
      bearer_token:
        "CI/scripts: send `Authorization: Bearer <deploy token>` (create one in the console: App → Settings → Deploy Tokens; viewer role is enough for reads).",
      humans:
        "Use the CLI: `npm i -g @botiverse/hands-cli` then `hands login` (browser flow). `hands --help` lists common recipes.",
    },
    actions_list:
      "GET /.well-known/raft-agent-manifest.json — or `raft integration invoke --service <hands-service> --list-actions`.",
    write_endpoints: {
      update_ticket:
        "PATCH /api/apps/{app_id}/feedback/{ticket_id} — body: {status?: open|in_progress|resolved|closed, assignee?: string|null}",
      comment_ticket:
        "POST /api/apps/{app_id}/feedback/{ticket_id}/comments — body: {text: string}",
    },
    docs: {
      agent_guide: `${origin}/docs/agent-cli-feedback`,
      cli_reference: `${origin}/docs/cli-reference`,
      api_reference: `${origin}/docs/public-api-reference`,
      openapi: `${origin}/openapi.json`,
    },
  });
}

export async function handleAgentManifest(c: Context<{ Bindings: Env }>) {
  const origin = appOrigin(c);
  // Never edge-cache the manifest — the integration daemon must always see the
  // current action list (a stale cached copy makes schema changes invisible).
  c.header("Cache-Control", "no-store");
  return c.json({
    schema: "slock-agent-manifest.v0",
    service: c.env.RAFT_CLIENT_ID || "quiver",
    docs_url: `${origin}/`,
    execution: {
      mode: "http_api",
      base_url: origin,
    },
    context_check: {
      url: `${origin}/api/auth/me`,
      method: "GET",
    },
    // HTTP API actions an agent can self-serve via `raft integration invoke`.
    // Paths are relative to execution.base_url (`${origin}/api`). Focused on the
    // feedback-read/log-retrieval flow; Hands serves raw attachments and does
    // not interpret their contents.
    actions: [
      {
        name: "help",
        description:
          "Start here — how to authenticate, what each action does, common crash/feedback flows, and docs links.",
        endpoint: { method: "GET", path: "/api/agent/help" },
      },
      {
        name: "list-orgs",
        description:
          "List every organization the current Raft identity can access across linked servers, including role and server identity.",
        endpoint: { method: "GET", path: "/api/orgs" },
      },
      {
        name: "list-apps",
        description: "List apps the caller can access.",
        endpoint: { method: "GET", path: "/api/apps" },
      },
      {
        name: "create-deploy-token",
        description:
          "Create an app-scoped deploy token. Requires app admin. The raw token is returned exactly once; store it immediately in a secret manager and never post it to a public channel.",
        endpoint: { method: "POST", path: "/api/apps/{app_id}/deploy-tokens" },
        parameters: {
          app_id: { type: "string", in: "path", required: true, description: "App UUID." },
        },
      },
      {
        name: "list-deploy-tokens",
        description:
          "List app deploy-token metadata, including ids and revocation state. Requires app admin; raw token values are never returned.",
        endpoint: { method: "GET", path: "/api/apps/{app_id}/deploy-tokens" },
        parameters: {
          app_id: { type: "string", in: "path", required: true, description: "App UUID." },
          include_revoked: { type: "string", in: "query", required: false, description: "Set to 1 to include revoked tokens." },
        },
      },
      {
        name: "revoke-deploy-token",
        description: "Revoke an app-scoped deploy token by id. Requires app admin.",
        endpoint: { method: "DELETE", path: "/api/apps/{app_id}/deploy-tokens/{token_id}" },
        parameters: {
          app_id: { type: "string", in: "path", required: true, description: "App UUID." },
          token_id: { type: "string", in: "path", required: true, description: "Deploy-token UUID." },
        },
      },
      {
        name: "list-feedback",
        description:
          "List feedback/crash tickets for an app, newest first. Optional status/kind filters.",
        endpoint: { method: "GET", path: "/api/apps/{app_id}/feedback" },
        parameters: {
          app_id: { type: "string", in: "path", required: true, description: "App UUID." },
          status: { type: "string", in: "query", required: false, description: "open|in_progress|resolved|closed" },
          kind: { type: "string", in: "query", required: false, description: "feedback|bug|crash (comma-separated)" },
        },
      },
      {
        name: "get-feedback",
        description:
          "Get a feedback/crash ticket with device context, attachments, and comments. ticket_id may be a full UUID or a unique short-id prefix.",
        endpoint: { method: "GET", path: "/api/apps/{app_id}/feedback/{ticket_id}" },
        parameters: {
          app_id: { type: "string", in: "path", required: true, description: "App UUID." },
          ticket_id: { type: "string", in: "path", required: true, description: "Ticket UUID or unique short-id prefix." },
        },
      },
      {
        name: "presign-feedback-attachment",
        description:
          "Get a short-lived signed download URL for a feedback attachment. USE THIS for binaries (zips, images): fetch the returned download_url yourself with curl/wget — invoking a raw-bytes endpoint through an agent transport corrupts binary data.",
        endpoint: {
          method: "GET",
          path: "/api/apps/{app_id}/feedback/{ticket_id}/attachments/{attachment_id}?presign=1",
        },
        parameters: {
          app_id: { type: "string", in: "path", required: true, description: "App UUID." },
          ticket_id: { type: "string", in: "path", required: true, description: "Ticket UUID or unique short-id prefix." },
          attachment_id: { type: "string", in: "path", required: true, description: "Attachment UUID from the ticket detail." },
        },
      },
    ],
  });
}
