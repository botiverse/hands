import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { authMiddleware, type AdminEnv, type AdminAccount } from "../src/middleware/auth";
import { handleStartGooglePlayOAuth, handleGooglePlayOAuthCallback } from "../src/routes/google_play_oauth";
import { handleDeleteGooglePlayBinding } from "../src/routes/google_play_bindings";
import { getGooglePlayBinding, storeGooglePlayBinding, getGooglePlayBindingMeta } from "../src/lib/google_play_bindings";
function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => {
      indexes.push(Number(index));
      return "?";
    }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      const runSync = () => {
        const info = statement.run(...expanded);
        return { success: true, meta: { changes: info.changes } };
      };
      const allSync = () => statement.reader
        ? { success: true, results: statement.all(...expanded) }
        : runSync();
      return {
        _batchSync: allSync,
        run: async () => runSync(),
        all: async () => ({ success: true, results: statement.all(...expanded) }),
        first: async (column?: string) => {
          const row = statement.get(...expanded) as Record<string, unknown> | undefined;
          return column ? row?.[column] ?? null : row ?? null;
        },
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  return {
    prepare,
    batch: async (statements: Array<{ _batchSync: () => unknown }>) =>
      sqlite.transaction(() => statements.map((statement) => statement._batchSync()))(),
  } as unknown as D1Database;
}


const appId = "11111111-1111-4111-8111-111111111111";
const keyring = JSON.stringify({ v1: "test-key-material-over-thirty-two-bytes" });
const oauth = { type: "authorized_user" as const, client_id: "client", client_secret: "client-secret",
  refresh_token: "private-refresh-token", client_email: "user@example.com" };
const input = { package_name: "build.raft.app", tracks: { internal: "internal", closed: "closed", production: "production" } };
function harness(realAuth = false) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const dir = new URL("../../migrations/sql/", import.meta.url);
  for (const file of readdirSync(dir).sort()) if (file.endsWith(".sql")) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, 'oauth-app', 'App', 'android', 1)").run(appId);
  for (const id of ["human", "other"]) sqlite.prepare("INSERT INTO raft_accounts (id, provider, provider_subject, server_id, principal_type, display_name, raw_profile, created_at, updated_at, last_login_at) VALUES (?, 'raft', ?, 'server', 'human', 'User', '{}', 1, 1, 1)").run(id, id);
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('member', ?, 'human', 'admin', 1)").run(appId);
  let account = { id: "human", provider: "raft", provider_subject: "human", server_id: "server", principal_type: "human", display_name: "User", raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1 } as AdminAccount;
  const verify = vi.fn(async (binding: any) => ({ ok: true, value: { client_email: binding.credential.client_email, package_name: binding.packageName } }));
  const env = { DB: d1(sqlite), ENVIRONMENT: "production", BUSINESS_ORIGIN: "https://hands.test", DASHBOARD_ORIGIN: "https://hands.test",
    GOOGLE_PLAY_OAUTH_CLIENT_ID: "client", GOOGLE_PLAY_OAUTH_CLIENT_SECRET: "client-secret",
    PLAY_CRED_ENC_KEYS: keyring, PLAY_CRED_ENC_ACTIVE_KEY_VERSION: "v1", PLAY_RELEASE_SERVICE: { verifyBinding: verify } } as unknown as Env;
  let authenticated = account;
  const app = new Hono<AdminEnv & { Bindings: Env }>();
  if (realAuth) app.use("*", authMiddleware);
  else app.use("*", async (c, next) => { c.set("admin_account", account); c.set("authenticated_account", authenticated); c.set("admin_actor", "human"); await next(); });
  app.get("/api/other", (c) => c.json({ ok: true }));
  app.post("/api/apps/:appId/google-play-oauth/start", handleStartGooglePlayOAuth);
  app.get("/api/google-play/oauth/callback", handleGooglePlayOAuthCallback);
  app.delete("/api/apps/:appId/google-play-binding", handleDeleteGooglePlayBinding);
  const request = (path: string, init?: RequestInit) => app.fetch(new Request("https://hands.test" + path, init), env);
  const start = async () => {
    const response = await request("/api/apps/" + appId + "/google-play-oauth/start", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer browser-session" }, body: JSON.stringify(input) });
    return { response, url: response.ok ? new URL((await response.json() as any).authorization_url) : null };
  };
  const callback = (state: string, suffix = "&code=private-code") => request("/api/google-play/oauth/callback?state=" + state + suffix);
  return { sqlite, env, start, callback, request, verify, setAccount: (next: AdminAccount) => { account = next; authenticated = next; }, setSelected: (next: AdminAccount) => { account = next; }, account };
}
function google() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code_verifier")).toMatch(/^[a-f0-9]{64}$/);
      expect(body.get("redirect_uri")).toBe("https://hands.test/api/google-play/oauth/callback");
      return Response.json({ access_token: "access", refresh_token: oauth.refresh_token, token_type: "Bearer", scope: "openid email https://www.googleapis.com/auth/androidpublisher" });
    }
    expect(String(url)).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    return Response.json({ email: oauth.client_email, email_verified: true });
  });
}
afterEach(() => vi.restoreAllMocks());
describe("Google Play OAuth", () => {
  it("uses offline PKCE with encrypted one-time state and stores only encrypted verified credentials", async () => {
    const h = harness(); const fetch = google();
    const { url } = await h.start();
    expect(url!.origin).toBe("https://accounts.google.com");
    expect(url!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url!.searchParams.get("access_type")).toBe("offline");
    const state = url!.searchParams.get("state")!;
    expect(JSON.stringify(h.sqlite.prepare("SELECT * FROM google_play_oauth_requests").all())).not.toContain(state);
    const response = await h.callback(state);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://hands.test/apps/" + appId + "/settings?google_play_oauth=connected");
    expect(h.verify).toHaveBeenCalledOnce();
    expect((await getGooglePlayBinding(h.env.DB, appId, keyring))!.credential).toEqual(oauth);
    expect(JSON.stringify(h.sqlite.prepare("SELECT * FROM app_google_play_bindings").all())).not.toContain(oauth.refresh_token);
    expect(JSON.stringify(h.sqlite.prepare("SELECT * FROM audit_logs").all())).not.toContain("private-");
    expect((await h.callback(state)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["expired", "account", "role", "agent"])("rejects %s before contacting Google", async (mode) => {
    const h = harness(); const fetch = google(); const { url } = await h.start();
    if (mode === "expired") h.sqlite.exec("UPDATE google_play_oauth_requests SET expires_at=0");
    if (mode === "account") h.setAccount({ ...h.account, id: "other" });
    if (mode === "role") h.sqlite.exec("DELETE FROM app_members");
    if (mode === "agent") h.setAccount({ ...h.account, principal_type: "agent" });
    expect([400, 403]).toContain((await h.callback(url!.searchParams.get("state")!)).status);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects non-admin and agent starts and fails closed without configuration", async () => {
    const h = harness();
    h.setAccount({ ...h.account, principal_type: "agent" });
    expect((await h.start()).response.status).toBe(403);
    h.setAccount(h.account);
    delete h.env.GOOGLE_PLAY_OAUTH_CLIENT_SECRET;
    expect((await h.start()).response.status).toBe(503);
    h.env.GOOGLE_PLAY_OAUTH_CLIENT_SECRET = "client-secret";
    h.sqlite.exec("DELETE FROM app_members");
    expect((await h.start()).response.status).toBe(403);
  });
  it.each(["cancelled", "scope", "refresh", "unverified", "play", "revoked", "replacement", "disconnect", "disconnect-during-callback", "expired-during-callback"])("does not persist a credential after %s", async (mode) => {
    const h = harness(); const fetch = google(); const { url } = await h.start(); const state = url!.searchParams.get("state")!;
    if (mode === "scope" || mode === "refresh") fetch.mockResolvedValueOnce(Response.json({ access_token: "access", token_type: "Bearer",
      refresh_token: mode === "refresh" ? undefined : "secret", scope: mode === "scope" ? "openid email" : "https://www.googleapis.com/auth/androidpublisher" }));
    if (mode === "unverified") fetch.mockImplementationOnce(async () => Response.json({ access_token: "access", refresh_token: "secret", token_type: "Bearer", scope: "https://www.googleapis.com/auth/androidpublisher" }))
      .mockResolvedValueOnce(Response.json({ email: "user@example.com", email_verified: false }));
    if (mode === "play") h.verify.mockResolvedValueOnce({ ok: false, error: { status: 403 } } as any);
    if (mode === "revoked") h.verify.mockImplementationOnce(async () => { h.sqlite.exec("DELETE FROM app_members"); return { ok: true, value: { client_email: oauth.client_email, package_name: input.package_name } }; });
    if (mode === "disconnect-during-callback" || mode === "expired-during-callback") h.verify.mockImplementationOnce(async () => {
      if (mode === "disconnect-during-callback") await h.request("/api/apps/" + appId + "/google-play-binding", { method: "DELETE" });
      else h.sqlite.exec("UPDATE google_play_oauth_requests SET expires_at=0");
      return { ok: true, value: { client_email: oauth.client_email, package_name: input.package_name } };
    });
    if (mode === "replacement") await storeGooglePlayBinding(h.env.DB, { appId, packageName: input.package_name, tracks: input.tracks, credential: { ...oauth, refresh_token: "replacement" }, actor: "human", keyringJson: keyring, activeKeyVersion: "v1" });
    if (mode === "disconnect") await h.request("/api/apps/" + appId + "/google-play-binding", { method: "DELETE" });
    const response = await h.callback(state, mode === "cancelled" ? "&error=access_denied" : undefined);
    if (mode === "disconnect") expect(response.status).toBe(400);
    else expect(response.headers.get("location")).toContain(mode === "cancelled" ? "cancelled" : "failed");
    const binding = await getGooglePlayBinding(h.env.DB, appId, keyring);
    if (mode === "replacement") expect(binding!.credential).toEqual({ ...oauth, refresh_token: "replacement" });
    else expect(binding).toBeNull();
    if (mode === "cancelled" || mode === "disconnect") expect(fetch).not.toHaveBeenCalled();
  });
  it("authenticates the Google redirect from a callback-only cookie and rejects revoked sessions", async () => {
    const h = harness(true); google();
    h.sqlite.prepare("INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES ('session', 'human', ?, ?, ?, ?)").run(createHash("sha256").update("browser-session").digest("hex"), Date.now(), Date.now() + 3600000, Date.now());
    const first = await h.start();
    expect(first.response.status).toBe(200);
    const cookieHeader = first.response.headers.get("set-cookie")!;
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("Secure");
    expect(cookieHeader).toContain("SameSite=Lax");
    expect(cookieHeader).toContain("Max-Age=600");
    expect(cookieHeader).toContain("Path=/api/google-play/oauth/callback");
    const cookie = cookieHeader.split(";")[0]!;
    expect((await h.request("/api/other", { headers: { cookie } })).status).toBe(401);
    const callbackPath = "/api/google-play/oauth/callback?state=" + first.url!.searchParams.get("state") + "&code=code";
    expect((await h.request(callbackPath)).status).toBe(401);
    const success = await h.request(callbackPath, { headers: { cookie } });
    expect(success.status).toBe(303);
    expect(success.headers.get("set-cookie")).toContain("Max-Age=0");
    const second = await h.start();
    h.sqlite.exec("UPDATE raft_sessions SET revoked_at=1");
    expect((await h.request("/api/google-play/oauth/callback?state=" + second.url!.searchParams.get("state") + "&code=code", {
      headers: { cookie: second.response.headers.get("set-cookie")!.split(";")[0]! },
    })).status).toBe(401);
  });
  it("binds the authenticated identity across an organization switch and restores the effective administrator", async () => {
    const h = harness(); google();
    h.sqlite.prepare("INSERT INTO organizations (id, slug, name, external_id, created_at) VALUES ('org', 'org', 'Org', 'org', 1)").run();
    h.sqlite.prepare("INSERT INTO raft_accounts (id, provider, provider_subject, server_id, principal_type, display_name, raw_profile, created_at, updated_at, last_login_at) VALUES ('linked', 'raft', 'human', 'other-server', 'human', 'User', '{}', 1, 1, 1)").run();
    h.sqlite.prepare("INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES ('org-member', 'org', 'linked', 'viewer', 1)").run();
    h.sqlite.prepare("UPDATE apps SET org_id='org' WHERE id=?").run(appId);
    h.sqlite.exec("UPDATE app_members SET account_id='linked'");
    h.setSelected({ ...h.account, id: "linked", org_id: "org", org_role: "viewer" });
    const { url } = await h.start();
    h.setSelected(h.account);
    expect((await h.callback(url!.searchParams.get("state")!)).headers.get("location")).toContain("connected");
  });
  it("consumes a callback atomically when two requests arrive together", async () => {
    const h = harness(); const fetch = google(); const { url } = await h.start();
    const replies = await Promise.all([h.callback(url!.searchParams.get("state")!), h.callback(url!.searchParams.get("state")!)]);
    expect(replies.map((r) => r.status).sort()).toEqual([303, 400]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not overwrite a binding if two independently started authorizations complete", async () => {
    const h = harness(); google();
    const first = await h.start(); const second = await h.start();
    expect((await h.callback(first.url!.searchParams.get("state")!)).headers.get("location")).toContain("connected");
    expect((await h.callback(second.url!.searchParams.get("state")!)).headers.get("location")).toContain("failed");
  });
  it("compare-and-set rejects an intervening disable and supports unchanged replacement", async () => {
    const h = harness();
    const args = { appId, packageName: input.package_name, tracks: input.tracks, credential: oauth, actor: "human", keyringJson: keyring, activeKeyVersion: "v1" };
    await storeGooglePlayBinding(h.env.DB, args);
    const old = (await getGooglePlayBindingMeta(h.env.DB, appId))!;
    const expectedBindingVersion = old.credential_fingerprint + ":" + old.updated_at + ":" + old.enabled;
    h.sqlite.exec("UPDATE app_google_play_bindings SET enabled=0");
    await expect(storeGooglePlayBinding(h.env.DB, { ...args, expectedBindingVersion })).rejects.toThrow(/changed/);
    expect((await getGooglePlayBindingMeta(h.env.DB, appId))!.enabled).toBe(0);
  });
});
