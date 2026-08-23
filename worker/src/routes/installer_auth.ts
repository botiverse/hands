import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { businessOrigin, isSecureRequest, requestOrigin } from "../lib/origin";
import {
  INSTALLER_ACCESS_TTL_MS,
  INSTALLER_CLIENT_ID,
  INSTALLER_REFRESH_TTL_MS,
  configuredInstallerRedirectUris,
  isAllowedRedirectUri,
  isPkceChallenge,
  isPkceVerifier,
  pkceChallenge,
  randomOpaqueToken,
  sha256Hex,
} from "../lib/installer_auth";
import {
  exchangeRaftCode,
  fetchRaftUserinfo,
  isUserAllowed,
  requireRaftConfig,
  upsertRaftAccount,
} from "./auth";

const LOGIN_COOKIE = "hands_installer_login";
const LOGIN_REQUEST_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;

type JsonObject = Record<string, unknown>;

function noStore(c: Context) {
  c.header("cache-control", "no-store");
}

async function jsonBody(c: Context): Promise<JsonObject | null> {
  try {
    const value = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
  } catch {
    return null;
  }
}

export async function handleInstallerLogin(c: Context<{ Bindings: Env }>) {
  noStore(c);
  const config = requireRaftConfig(c);
  if (!config.ok) return config.response;
  const clientId = c.req.query("client_id") || "";
  const redirectUri = c.req.query("redirect_uri") || "";
  const challenge = c.req.query("code_challenge") || "";
  const method = c.req.query("code_challenge_method") || "";
  const state = c.req.query("state") || "";
  if (clientId !== INSTALLER_CLIENT_ID ||
      !isAllowedRedirectUri(redirectUri, configuredInstallerRedirectUris(c.env)) ||
      method !== "S256" || !isPkceChallenge(challenge) ||
      !/^[A-Za-z0-9._~-]{16,200}$/.test(state)) {
    return c.json({ error: "invalid authorization request", code: "invalid_request" }, 400);
  }

  const timestamp = Date.now();
  const requestId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO installer_login_requests
     (id, client_id, redirect_uri, state, code_challenge, code_challenge_method,
      created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'S256', ?6, ?7)`,
  ).bind(requestId, clientId, redirectUri, state, challenge, timestamp,
    timestamp + LOGIN_REQUEST_TTL_MS).run();
  setCookie(c, LOGIN_COOKIE, requestId, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/login/raft/installer/callback",
    maxAge: LOGIN_REQUEST_TTL_MS / 1000,
  });

  const setup = new URL("/login-with-raft/setup", config.raftOrigin);
  setup.searchParams.set("client_id", config.clientId);
  setup.searchParams.set("return_to", `${businessOrigin(c.env, () => requestOrigin(c))}/login/raft/installer/callback`);
  setup.searchParams.set("scope", "openid profile");
  noStore(c);
  return c.redirect(setup.toString(), 302);
}

export async function handleInstallerRaftCallback(c: Context<{ Bindings: Env }>) {
  noStore(c);
  const config = requireRaftConfig(c);
  if (!config.ok) return config.response;
  const raftCode = c.req.query("code") || "";
  const requestId = getCookie(c, LOGIN_COOKIE) || "";
  if (!raftCode || !requestId) return c.text("Installer login state is missing or expired.", 400);
  const timestamp = Date.now();
  const pending = await c.env.DB.prepare(
    `SELECT id, client_id, redirect_uri, state, code_challenge
     FROM installer_login_requests WHERE id=?1 AND expires_at>?2 LIMIT 1`,
  ).bind(requestId, timestamp).first<{
    id: string; client_id: string; redirect_uri: string; state: string; code_challenge: string;
  }>();
  if (!pending) return c.text("Installer login state is missing or expired.", 400);

  try {
    const token = await exchangeRaftCode(
      config.raftApiOrigin, config.clientId, config.clientSecret, raftCode,
    );
    const userinfo = await fetchRaftUserinfo(config.raftApiOrigin, token.access_token);
    if (userinfo.type !== "human" || !isUserAllowed(c.env, userinfo)) {
      return c.text("Hands Installer login is available to allowed human accounts only.", 403);
    }
    const account = await upsertRaftAccount(c.env.DB, userinfo);
    const authorizationCode = randomOpaqueToken();
    const codeHash = await sha256Hex(authorizationCode);
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO installer_login_codes
         (id, code_hash, account_id, client_id, redirect_uri, state, code_challenge,
          code_challenge_method, created_at, expires_at)
         SELECT ?1, ?2, ?3, client_id, redirect_uri, state, code_challenge,
                'S256', ?4, ?5
         FROM installer_login_requests WHERE id=?6 AND expires_at>?4`,
      ).bind(crypto.randomUUID(), codeHash, account.id, timestamp,
        timestamp + LOGIN_CODE_TTL_MS, pending.id),
      c.env.DB.prepare("DELETE FROM installer_login_requests WHERE id=?1").bind(pending.id),
    ]);
    if (results.some((result) => result.meta.changes !== 1)) {
      return c.text("Installer login state is missing or expired.", 400);
    }
    deleteCookie(c, LOGIN_COOKIE, { path: "/login/raft/installer/callback" });
    const destination = new URL(pending.redirect_uri);
    destination.searchParams.set("code", authorizationCode);
    destination.searchParams.set("state", pending.state);
    noStore(c);
    return c.redirect(destination.toString(), 302);
  } catch (error) {
    console.error(`[installer-auth] callback failed: ${error instanceof Error ? error.message : String(error)}`);
    return c.text("Hands Installer login failed.", 502);
  }
}

export async function handleInstallerToken(c: Context<{ Bindings: Env }>) {
  noStore(c);
  const body = await jsonBody(c);
  if (!body) return c.json({ error: "invalid request", code: "invalid_request" }, 400);
  const grantType = body.grant_type;
  if (grantType === "authorization_code") return exchangeAuthorizationCode(c, body);
  if (grantType === "refresh_token") return rotateRefreshToken(c, body);
  return c.json({ error: "unsupported grant type", code: "invalid_request" }, 400);
}

async function exchangeAuthorizationCode(
  c: Context<{ Bindings: Env }>, body: JsonObject,
) {
  const code = typeof body.code === "string" ? body.code : "";
  const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
  if (!code || !isPkceVerifier(verifier) || clientId !== INSTALLER_CLIENT_ID ||
      !isAllowedRedirectUri(redirectUri, configuredInstallerRedirectUris(c.env))) {
    return c.json({ error: "invalid authorization code", code: "invalid_grant" }, 400);
  }
  const codeHash = await sha256Hex(code);
  const challenge = await pkceChallenge(verifier);
  const timestamp = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT id, account_id FROM installer_login_codes
     WHERE code_hash=?1 AND client_id=?2 AND redirect_uri=?3 AND code_challenge=?4
       AND consumed_at IS NULL AND expires_at>?5 LIMIT 1`,
  ).bind(codeHash, clientId, redirectUri, challenge, timestamp)
    .first<{ id: string; account_id: string }>();
  if (!row) return c.json({ error: "invalid authorization code", code: "invalid_grant" }, 400);

  const attempt = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  const refreshId = crypto.randomUUID();
  const accessId = crypto.randomUUID();
  const refreshToken = randomOpaqueToken();
  const accessToken = randomOpaqueToken();
  const refreshHash = await sha256Hex(refreshToken);
  const accessHash = await sha256Hex(accessToken);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO installer_refresh_tokens
       (id, family_id, account_id, client_id, token_hash, created_at, expires_at)
       SELECT ?1, ?2, account_id, client_id, ?3, ?4, ?5
       FROM installer_login_codes
       WHERE id=?6 AND consumed_at IS NULL AND expires_at>?4`,
    ).bind(refreshId, familyId, refreshHash, timestamp,
      timestamp + INSTALLER_REFRESH_TTL_MS, row.id),
    c.env.DB.prepare(
      `INSERT INTO installer_access_tokens
       (id, account_id, client_id, token_hash, family_id, created_at, expires_at)
       SELECT ?1, account_id, client_id, ?2, family_id, ?3, ?4
       FROM installer_refresh_tokens WHERE id=?5`,
    ).bind(accessId, accessHash, timestamp, timestamp + INSTALLER_ACCESS_TTL_MS, refreshId),
    c.env.DB.prepare(
      `UPDATE installer_login_codes SET consumed_at=?1, consumed_by=?2
       WHERE id=?3 AND consumed_at IS NULL AND EXISTS
         (SELECT 1 FROM installer_refresh_tokens WHERE id=?4)`,
    ).bind(timestamp, attempt, row.id, refreshId),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) {
    return c.json({ error: "invalid authorization code", code: "invalid_grant" }, 400);
  }
  noStore(c);
  return c.json({
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: Math.floor(INSTALLER_ACCESS_TTL_MS / 1000),
    refresh_token: refreshToken,
    refresh_expires_in: Math.floor(INSTALLER_REFRESH_TTL_MS / 1000),
  });
}

async function rotateRefreshToken(c: Context<{ Bindings: Env }>, body: JsonObject) {
  const token = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const clientId = typeof body.client_id === "string" ? body.client_id : "";
  if (!token || clientId !== INSTALLER_CLIENT_ID) {
    return c.json({ error: "invalid refresh token", code: "invalid_grant" }, 400);
  }
  const hash = await sha256Hex(token);
  const timestamp = Date.now();
  const current = await c.env.DB.prepare(
    `SELECT id, family_id, account_id, client_id, expires_at, consumed_at, revoked_at
     FROM installer_refresh_tokens WHERE token_hash=?1 LIMIT 1`,
  ).bind(hash).first<{
    id: string; family_id: string; account_id: string; client_id: string;
    expires_at: number; consumed_at: number | null; revoked_at: number | null;
  }>();
  if (!current || current.client_id !== clientId || current.expires_at <= timestamp || current.revoked_at) {
    return c.json({ error: "invalid refresh token", code: "invalid_grant" }, 400);
  }
  if (current.consumed_at) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE installer_refresh_tokens SET revoked_at=?1 WHERE family_id=?2 AND revoked_at IS NULL",
      ).bind(timestamp, current.family_id),
      c.env.DB.prepare(
        "UPDATE installer_access_tokens SET revoked_at=?1 WHERE family_id=?2 AND revoked_at IS NULL",
      ).bind(timestamp, current.family_id),
    ]);
    return c.json({ error: "invalid refresh token", code: "invalid_grant" }, 400);
  }

  const successorId = crypto.randomUUID();
  const accessId = crypto.randomUUID();
  const successor = randomOpaqueToken();
  const accessToken = randomOpaqueToken();
  const successorHash = await sha256Hex(successor);
  const accessHash = await sha256Hex(accessToken);
  const accessExpiresAt = Math.min(timestamp + INSTALLER_ACCESS_TTL_MS, current.expires_at);
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO installer_refresh_tokens
       (id, family_id, account_id, client_id, token_hash, created_at, expires_at)
       SELECT ?1, family_id, account_id, client_id, ?2, ?3, expires_at
       FROM installer_refresh_tokens
       WHERE id=?4 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?3`,
    ).bind(successorId, successorHash, timestamp, current.id),
    c.env.DB.prepare(
      `INSERT INTO installer_access_tokens
       (id, account_id, client_id, token_hash, family_id, created_at, expires_at)
       SELECT ?1, account_id, client_id, ?2, family_id, ?3, ?4
       FROM installer_refresh_tokens WHERE id=?5`,
    ).bind(accessId, accessHash, timestamp, accessExpiresAt, successorId),
    c.env.DB.prepare(
      `UPDATE installer_access_tokens SET revoked_at=?1
       WHERE family_id=?2 AND id<>?3 AND revoked_at IS NULL`,
    ).bind(timestamp, current.family_id, accessId),
    c.env.DB.prepare(
      `UPDATE installer_refresh_tokens
       SET consumed_at=?1, consumed_by=?2, replaced_by_id=?2
       WHERE id=?3 AND consumed_at IS NULL AND EXISTS
         (SELECT 1 FROM installer_refresh_tokens WHERE id=?2)`,
    ).bind(timestamp, successorId, current.id),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1 ||
      results[3]?.meta.changes !== 1) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE installer_refresh_tokens SET revoked_at=?1 WHERE family_id=?2 AND revoked_at IS NULL",
      ).bind(timestamp, current.family_id),
      c.env.DB.prepare(
        "UPDATE installer_access_tokens SET revoked_at=?1 WHERE family_id=?2 AND revoked_at IS NULL",
      ).bind(timestamp, current.family_id),
    ]);
    return c.json({ error: "invalid refresh token", code: "invalid_grant" }, 400);
  }
  noStore(c);
  return c.json({
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: Math.max(1, Math.floor((accessExpiresAt - timestamp) / 1000)),
    refresh_token: successor,
    refresh_expires_in: Math.max(0, Math.floor((current.expires_at - timestamp) / 1000)),
  });
}

export async function handleInstallerLogout(c: Context<{ Bindings: Env }>) {
  noStore(c);
  const body = await jsonBody(c);
  const token = body && typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!token) return c.json({ ok: true });
  const hash = await sha256Hex(token);
  const timestamp = Date.now();
  const row = await c.env.DB.prepare(
    "SELECT family_id FROM installer_refresh_tokens WHERE token_hash=?1 LIMIT 1",
  ).bind(hash).first<{ family_id: string }>();
  if (row) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE installer_refresh_tokens SET revoked_at=?1 WHERE family_id=?2 AND revoked_at IS NULL",
      ).bind(timestamp, row.family_id),
      c.env.DB.prepare(
        "UPDATE installer_access_tokens SET revoked_at=?1 WHERE family_id=?2 AND revoked_at IS NULL",
      ).bind(timestamp, row.family_id),
    ]);
  }
  noStore(c);
  return c.json({ ok: true });
}
