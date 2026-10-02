import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { currentActor, accountForRequestedOrg, accountActor, googlePlayOAuthCookieName, SESSION_COOKIE, type AdminEnv } from "../middleware/auth";
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
  let packageName: string;
  let tracks: GooglePlayTracks;
  try {
    const body = await c.req.json();
    packageName = normalizeGooglePlayPackage(body.package_name);
    tracks = normalizeGooglePlayTracks(body.tracks);
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
        JSON.stringify(tracks), meta ? meta.credential_fingerprint + ":" + meta.updated_at + ":" + meta.enabled : null,
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
type Pending = {
  state_hash: string; app_id: string; account_id: string; authenticated_account_id: string; org_id: string | null; client_id: string; package_name: string;
  tracks_json: string; expected_binding_version: string | null; expires_at: number; consumed_at: number | null;
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
  const effective = await accountForRequestedOrg(c.env, c.get("authenticated_account") ?? account, pending.org_id ?? undefined);
  if (effective.id !== pending.account_id) return c.json({ code: "INVALID_OAUTH_STATE", error: "Authorization account changed" }, 400);
  c.set("admin_account", effective);
  c.set("admin_actor", accountActor(effective));
  const denial = await ensureAppRole(c, pending.app_id, "admin");
  if (!denial.ok) return denial.response;
  // Atomic one-time claim before any Google calls; duplicate callbacks cannot
  // exchange a code or replace a binding. Failures require a fresh start.
  const claimed = await c.env.DB.prepare("UPDATE google_play_oauth_requests SET consumed_at=?3 WHERE state_hash=?1 AND account_id=?2 AND expires_at>?3 AND consumed_at IS NULL RETURNING state_hash")
    .bind(hash, effective.id, Date.now()).first<{ state_hash: string }>();
  if (!claimed) return c.json({ error: "Authorization was already consumed", code: "INVALID_OAUTH_STATE" }, 400);
  const resultUrl = new URL(dashboardOrigin(c.env) + "/apps/" + pending.app_id + "/settings");
  const finish = (result: string) => { resultUrl.searchParams.set("google_play_oauth", result); return c.redirect(resultUrl.toString(), 303); };
  if (c.req.query("error")) return finish("cancelled");
  if (!c.req.query("code")) return finish("failed");
  try {
    if (!c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID || !c.env.GOOGLE_PLAY_OAUTH_CLIENT_SECRET || pending.client_id !== c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID) return finish("failed");
    const verifier = await decryptGooglePlayValue(pending.verifier_ciphertext_b64, pending.verifier_iv_b64, pending.app_id, pending.verifier_key_version, c.env.PLAY_CRED_ENC_KEYS);
    if (typeof verifier !== "string" || !/^[a-f0-9]{64}$/.test(verifier)) return finish("failed");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: c.req.query("code")!,
        code_verifier: verifier, redirect_uri: callbackUri(c.env), client_id: c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID,
        client_secret: c.env.GOOGLE_PLAY_OAUTH_CLIENT_SECRET }),
    });
    const token = await response.json() as Record<string, unknown>;
    if (!response.ok || token.token_type !== "Bearer" || typeof token.access_token !== "string" || !token.access_token
      || typeof token.refresh_token !== "string" || !token.refresh_token
      || typeof token.scope !== "string" || !token.scope.split(/\s+/).some((scope) => scope === SCOPE)) return finish("failed");
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: "Bearer " + token.access_token }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    const profile = await profileResponse.json() as Record<string, unknown>;
    if (!profileResponse.ok || typeof profile.email !== "string" || profile.email_verified !== true) return finish("failed");
    const credential = parseGooglePlayCredential({
      type: "authorized_user", client_id: c.env.GOOGLE_PLAY_OAUTH_CLIENT_ID,
      client_secret: c.env.GOOGLE_PLAY_OAUTH_CLIENT_SECRET, refresh_token: token.refresh_token, client_email: profile.email,
    });
    const tracks = normalizeGooglePlayTracks(JSON.parse(pending.tracks_json));
    const verified = await verifyBinding(c, { credential, package_name: pending.package_name, tracks });
    if (!verified.ok) return finish("failed");
    // Recheck role after I/O; compare-and-set protects an intervening binding
    // replacement/disable/disconnect from being overwritten.
    const changedRole = await ensureAppRole(c, pending.app_id, "admin");
    if (!changedRole.ok) return finish("failed");
    const meta = await storeGooglePlayBinding(c.env.DB, {
      appId: pending.app_id, packageName: pending.package_name, tracks, credential,
      actor: currentActor(c), keyringJson: c.env.PLAY_CRED_ENC_KEYS, activeKeyVersion: c.env.PLAY_CRED_ENC_ACTIVE_KEY_VERSION,
      expectedBindingVersion: pending.expected_binding_version, expectedOAuthStateHash: hash,
    });
    await insertAuditLog(c.env.DB, c, { app_id: pending.app_id, action: "google_play.oauth.connect",
      payload: { package_name: pending.package_name, credential_kind: credential.type, credential_fingerprint: meta.credential_fingerprint } });
    await c.env.DB.prepare("DELETE FROM google_play_oauth_requests WHERE state_hash=?1").bind(hash).run();
    return finish("connected");
  } catch { return finish("failed"); }
}
