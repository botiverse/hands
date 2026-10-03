import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { currentActor, accountActor, googlePlayOAuthCookieName, SESSION_COOKIE, type AdminEnv, type AdminAccount } from "../middleware/auth";
import { currentAccount, ensureAppRole, insertAuditLog } from "../lib/permissions";
import { businessOrigin, dashboardOrigin, configuredProductionHost, sharedCookieDomain } from "../lib/origin";
import { decryptGooglePlayValue, encryptGooglePlayValue, getGooglePlayBindingMeta,
  normalizeGooglePlayPackage, normalizeGooglePlayTracks, storeGooglePlayBinding,
  parseGooglePlayCredential, type GooglePlayTracks } from "../lib/google_play_bindings";
import { requireAndroidApp, verifyBinding } from "./google_play_bindings";
type AdminContext = Context<AdminEnv & { Bindings: Env }>;
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
function callbackUri(env: Env) { return businessOrigin(env) + "/api/google-play/oauth/callback"; }
function cookieDomain(c: AdminContext): { domain: string } | Record<string, never> {
  const domain = sharedCookieDomain(c.env);
  const host = new URL(c.req.url).hostname;
  return domain && configuredProductionHost(c.env, host)
    && (host === domain || host.endsWith("." + domain)) ? { domain } : {};
}
function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""); }
export async function oauthStateHash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function challenge(verifier: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function handleStartGooglePlayOAuth(c: AdminContext) {
  c.header("cache-control", "no-store");
  const account = currentAccount(c);
  if (account?.principal_type !== "human") return c.json({ code: "HUMAN_AUTHORIZATION_REQUIRED", error: "A human administrator must authorize Google Play" }, 403);
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  const appId = c.req.param("appId") ?? "";
  const role = await ensureAppRole(c, appId, "admin");
  if (!role.ok) return role.response;
  const authenticated = c.get("authenticated_account") ?? account;
  // Human browser login stores the Hands session in localStorage, so a top-level
  // Google redirect cannot supply its Bearer header. Bridge only this callback
  // with a short-lived HttpOnly cookie, never a general browser login cookie.
  const bearer = c.req.header("authorization");
  const sessionToken = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : getCookie(c, SESSION_COOKIE);
  if (!sessionToken) return c.json({ code: "NOT_AUTHENTICATED", error: "A browser session is required" }, 401);
  if (!c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID || !c.env.GOOGLE_PLAY_OAUTH_CLIENT_SECRET || !c.env.PLAY_RELEASE_SERVICE) {
    return c.json({ code: "PLAY_OAUTH_UNAVAILABLE", error: "Google Play OAuth is not configured" }, 503);
  }
  let packageName: string | null = null;
  let tracks: GooglePlayTracks | null = null;
  try {
    const text = await c.req.text();
    const body = text.trim() ? JSON.parse(text) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Object required");
    if (body.package_name !== undefined || body.tracks !== undefined) {
      packageName = normalizeGooglePlayPackage(body.package_name);
      tracks = normalizeGooglePlayTracks(body.tracks);
    }
  } catch { return c.json({ code: "INVALID_PLAY_BINDING", error: "Valid package and tracks are required" }, 400); }
  const domainOption = cookieDomain(c);
  if (new URL(c.req.url).hostname !== new URL(callbackUri(c.env)).hostname && !domainOption.domain) {
    return c.json({ code: "PLAY_OAUTH_ORIGIN_MISMATCH", error: "Dashboard and callback need a shared cookie domain" }, 503);
  }
  const state = randomToken();
  const verifier = randomToken();
  let encrypted;
  try {
    encrypted = await encryptGooglePlayValue(verifier, appId, c.env.PLAY_CRED_ENC_KEYS, c.env.PLAY_CRED_ENC_ACTIVE_KEY_VERSION);
  } catch { return c.json({ code: "PLAY_CREDENTIAL_STORAGE_UNAVAILABLE", error: "Credential encryption is not configured" }, 503); }
  const meta = await getGooglePlayBindingMeta(c.env.DB, appId);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM google_play_oauth_requests WHERE expires_at<=?1").bind(now),
    c.env.DB.prepare("INSERT INTO google_play_oauth_requests (state_hash, app_id, account_id, authenticated_account_id, org_id, client_id, package_name, tracks_json, expected_binding_version, verifier_ciphertext_b64, verifier_iv_b64, verifier_key_version, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)")
      .bind(await oauthStateHash(state), appId, account.id, authenticated.id, role.org_id, c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID, packageName,
        tracks === null ? null : JSON.stringify(tracks), meta ? meta.credential_fingerprint + ":" + meta.updated_at + ":" + meta.enabled : null,
        encrypted.ciphertext_b64, encrypted.iv_b64, encrypted.key_version, now + 10 * 60_000),
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID, redirect_uri: callbackUri(c.env), response_type: "code",
    scope: SCOPE + " openid email", access_type: "offline", prompt: "consent select_account",
    state, code_challenge: await challenge(verifier), code_challenge_method: "S256",
  }).toString();
  setCookie(c, googlePlayOAuthCookieName(state)!, sessionToken, {
    httpOnly: true, secure: new URL(callbackUri(c.env)).protocol === "https:",
    ...domainOption, sameSite: "Lax", path: "/api/google-play/oauth/callback", maxAge: 600,
  });
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "google_play.oauth.start", payload: { package_name: packageName } });
  return c.json({ authorization_url: url.toString() });
}
type OAuthFailure = "missing_code" | "server_configuration" | "token_exchange" | "offline_access" | "google_permissions" | "account_identity" | "play_permissions" | "access_changed" | "connection_changed" | "credential_storage";
type Pending = {
  state_hash: string; app_id: string; account_id: string; authenticated_account_id: string; org_id: string | null; client_id: string; package_name: string | null;
  tracks_json: string | null; expected_binding_version: string | null; expires_at: number; consumed_at: number | null;
  verifier_ciphertext_b64: string; verifier_iv_b64: string; verifier_key_version: string;
};
export async function handleGooglePlayOAuthCallback(c: AdminContext) {
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  const state = c.req.query("state") ?? "";
  const account = currentAccount(c);
  const cookieName = googlePlayOAuthCookieName(state);
  if (cookieName) deleteCookie(c, cookieName, { ...cookieDomain(c), path: "/api/google-play/oauth/callback" });
  if (!/^[a-f0-9]{64}$/.test(state) || account?.principal_type !== "human") {
    return c.json({ error: "Invalid Google Play authorization", code: "INVALID_OAUTH_STATE" }, 400);
  }
  const hash = await oauthStateHash(state);
  const pending = await c.env.DB.prepare("SELECT * FROM google_play_oauth_requests WHERE state_hash=?1")
    .bind(hash).first<Pending>();
  if (!pending || pending.authenticated_account_id !== (c.get("authenticated_account") ?? account).id || pending.expires_at <= Date.now() || pending.consumed_at !== null) {
    return c.json({ error: "Authorization expired or belongs to another account", code: "INVALID_OAUTH_STATE" }, 400);
  }
  const authenticated = c.get("authenticated_account") ?? account;
  // Restore the exact account recorded at initiation. An app grant can belong
  // to a different-server account than the app's organization membership;
  // re-resolving by org would silently switch to that sibling account.
  const effective = await c.env.DB.prepare(
    "SELECT * FROM raft_accounts WHERE id=?1 AND provider=?2 AND provider_subject=?3 AND principal_type='human'",
  ).bind(pending.account_id, authenticated.provider, authenticated.provider_subject).first<AdminAccount>();
  if (!effective) return c.json({ code: "INVALID_OAUTH_STATE", error: "Authorization account changed" }, 400);
  c.set("admin_account", effective);
  c.set("admin_actor", accountActor(effective));
  const denial = await ensureAppRole(c, pending.app_id, "admin");
  if (!denial.ok) return denial.response;
  // Atomic one-time claim before any Google calls; duplicate callbacks cannot
  // exchange a code or replace a binding. Failures require a fresh start.
  const claimed = await c.env.DB.prepare("UPDATE google_play_oauth_requests SET consumed_at=?3 WHERE state_hash=?1 AND account_id=?2 AND expires_at>?3 AND consumed_at IS NULL RETURNING state_hash")
    .bind(hash, effective.id, Date.now()).first<{ state_hash: string }>();
  if (!claimed) return c.json({ error: "Authorization was already consumed", code: "INVALID_OAUTH_STATE" }, 400);
  const resultUrl = new URL(dashboardOrigin(c.env) + "/apps/" + pending.app_id + "/integrations");
  const finish = (result: string) => { resultUrl.searchParams.set("google_play_oauth", result); return c.redirect(resultUrl.toString(), 303); };
  // Only allowlisted enums and HTTP statuses cross the diagnostic boundary.
  // Never log the callback URL, code, state, provider bodies or credentials.
  const fail = async (reason: OAuthFailure, status?: number, providerError?: string) => {
    const safeProviderError = ["invalid_grant", "invalid_client", "access_denied", "temporarily_unavailable"].includes(providerError ?? "") ? providerError : undefined;
    const payload = { reason, ...(status === undefined ? {} : { provider_status: status }),
      ...(safeProviderError ? { provider_error: safeProviderError } : {}) };
    console.warn("google_play.oauth.failed", { app_id: pending.app_id, ...payload });
    try { await insertAuditLog(c.env.DB, c, { app_id: pending.app_id, action: "google_play.oauth.failed", payload }); }
    catch { console.warn("google_play.oauth.failure_audit_unavailable", { app_id: pending.app_id }); }
    resultUrl.searchParams.set("google_play_oauth_error", reason);
    return finish("failed");
  };
  if (c.req.query("error")) return finish("cancelled");
  if (!c.req.query("code")) return fail("missing_code");
  let stage: OAuthFailure = "server_configuration";
  let stored = false;
  try {
    if (!c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID || !c.env.GOOGLE_PLAY_OAUTH_CLIENT_SECRET || pending.client_id !== c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID) return fail("server_configuration");
    const verifier = await decryptGooglePlayValue(pending.verifier_ciphertext_b64, pending.verifier_iv_b64, pending.app_id, pending.verifier_key_version, c.env.PLAY_CRED_ENC_KEYS);
    if (typeof verifier !== "string" || !/^[a-f0-9]{64}$/.test(verifier)) return fail("server_configuration");
    stage = "token_exchange";
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: c.req.query("code")!,
        code_verifier: verifier, redirect_uri: callbackUri(c.env), client_id: c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID,
        client_secret: c.env.GOOGLE_PLAY_OAUTH_CLIENT_SECRET }),
    });
    const token = await response.json() as Record<string, unknown>;
    if (!response.ok) return fail("token_exchange", response.status, typeof token.error === "string" ? token.error : undefined);
    if (token.token_type !== "Bearer"
      || typeof token.access_token !== "string" || !token.access_token) return fail("token_exchange", response.status);
    if (typeof token.refresh_token !== "string" || !token.refresh_token) return fail("offline_access");
    if (typeof token.scope !== "string" || !token.scope.split(/\s+/).includes(SCOPE)) return fail("google_permissions");
    stage = "account_identity";
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: "Bearer " + token.access_token }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    const profile = await profileResponse.json() as Record<string, unknown>;
    if (!profileResponse.ok || typeof profile.email !== "string" || profile.email_verified !== true) return fail("account_identity", profileResponse.status);
    const credential = parseGooglePlayCredential({
      type: "authorized_user", client_id: c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID,
      client_secret: c.env.GOOGLE_PLAY_OAUTH_CLIENT_SECRET, refresh_token: token.refresh_token, client_email: profile.email,
    });
    stage = "server_configuration";
    const tracks = pending.tracks_json === null ? null : normalizeGooglePlayTracks(JSON.parse(pending.tracks_json));
    if (pending.package_name !== null || tracks !== null) {
      if (pending.package_name === null || tracks === null) return fail("server_configuration");
      stage = "play_permissions";
      const verified = await verifyBinding(c, { credential, package_name: pending.package_name, tracks });
      if (!verified.ok) return fail("play_permissions");
    }
    // Recheck role after I/O; compare-and-set protects an intervening binding
    // replacement/disable/disconnect from being overwritten.
    stage = "access_changed";
    const changedRole = await ensureAppRole(c, pending.app_id, "admin");
    if (!changedRole.ok) return fail("access_changed");
    stage = "credential_storage";
    const meta = await storeGooglePlayBinding(c.env.DB, {
      appId: pending.app_id, packageName: pending.package_name, tracks, credential,
      actor: currentActor(c), keyringJson: c.env.PLAY_CRED_ENC_KEYS, activeKeyVersion: c.env.PLAY_CRED_ENC_ACTIVE_KEY_VERSION,
      expectedBindingVersion: pending.expected_binding_version, expectedOAuthStateHash: hash,
    });
    stored = true;
    await insertAuditLog(c.env.DB, c, { app_id: pending.app_id, action: "google_play.oauth.connect",
      payload: { package_name: pending.package_name, credential_kind: credential.type, credential_fingerprint: meta.credential_fingerprint } });
    await c.env.DB.prepare("DELETE FROM google_play_oauth_requests WHERE state_hash=?1").bind(hash).run();
    return finish("connected");
  } catch (error) {
    // A bookkeeping failure after the credential commit must not tell the user
    // their Google connection failed. The consumed row still prevents replay.
    if (stored) {
      console.warn("google_play.oauth.post_connect_bookkeeping_failed", { app_id: pending.app_id });
      return finish("connected");
    }
    const reason = stage === "credential_storage" && error instanceof Error
      && error.message === "Google Play binding changed during authorization" ? "connection_changed" : stage;
    return fail(reason);
  }
}
