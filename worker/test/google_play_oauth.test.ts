import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { OpenAPIHono } from "@hono/zod-openapi";
import { registerAndroidDistributionRoutes } from "../src/openapi/android_distribution";
import { authMiddleware, type AdminEnv, type AdminAccount } from "../src/middleware/auth";
import { handleStartGooglePlayOAuth, handleGooglePlayOAuthCallback } from "../src/routes/google_play_oauth";
import { handleDeleteGooglePlayBinding, handlePutGooglePlayBinding, handleGetGooglePlayBinding, handleEnableGooglePlayBinding } from "../src/routes/google_play_bindings";
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
function harness(realAuth = false, beforeConnectMigration = false) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const dir = new URL("../../migrations/sql/", import.meta.url);
  for (const file of readdirSync(dir).sort()) if (file.endsWith(".sql") && !(beforeConnectMigration && file === "0080_google_play_connect_first.sql")) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, 'oauth-app', 'App', 'android', 1)").run(appId);
  for (const id of ["human", "other"]) sqlite.prepare("INSERT INTO raft_accounts (id, provider, provider_subject, server_id, principal_type, display_name, raw_profile, created_at, updated_at, last_login_at) VALUES (?, 'raft', ?, 'server', 'human', 'User', '{}', 1, 1, 1)").run(id, id);
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('member', ?, 'human', 'admin', 1)").run(appId);
  let account = { id: "human", provider: "raft", provider_subject: "human", server_id: "server", principal_type: "human", display_name: "User", raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1 } as AdminAccount;
  const verify = vi.fn(async (binding: any) => ({ ok: true, value: { client_email: binding.credential.client_email, package_name: binding.packageName } }));
  const env = { DB: d1(sqlite), ENVIRONMENT: "production", BUSINESS_ORIGIN: "https://hands.test", DASHBOARD_ORIGIN: "https://hands.test",
    GOOGLE_PLAY_OAUTH_CLIENT_ID: "client", GOOGLE_PLAY_OAUTH_CLIENT_SECRET: "client-secret",
    PLAY_CRED_ENC_KEYS: keyring, PLAY_CRED_ENC_ACTIVE_KEY_VERSION: "v1", PLAY_RELEASE_SERVICE: { verifyBinding: verify } } as unknown as Env;
  let authenticated = account;
  const app = new OpenAPIHono<AdminEnv & { Bindings: Env }>();
  if (realAuth) app.use("*", authMiddleware);
  else app.use("*", async (c, next) => { c.set("admin_account", account); c.set("authenticated_account", authenticated); c.set("admin_actor", "human"); await next(); });
  app.get("/api/other", (c) => c.json({ ok: true }));
  app.openapi(registerAndroidDistributionRoutes().find((route) => route.path.endsWith("google-play-oauth/start"))!, handleStartGooglePlayOAuth);
  app.get("/api/google-play/oauth/callback", handleGooglePlayOAuthCallback);
  app.openapi(registerAndroidDistributionRoutes().find((route) => route.method === "put" && route.path.endsWith("google-play-binding"))!, handlePutGooglePlayBinding);
  app.get("/api/apps/:appId/google-play-binding", handleGetGooglePlayBinding);
  app.post("/api/apps/:appId/google-play-binding/enable", handleEnableGooglePlayBinding);
  app.delete("/api/apps/:appId/google-play-binding", handleDeleteGooglePlayBinding);
  const request = (path: string, init?: RequestInit, origin = "https://hands.test") => app.fetch(new Request(origin + path, init), env);
  const start = async (origin = "https://hands.test") => {
    const response = await request("/api/apps/" + appId + "/google-play-oauth/start", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer browser-session" }, body: JSON.stringify(input) }, origin);
    return { response, url: response.ok ? new URL((await response.json() as any).authorization_url) : null };
  };
  const callback = (state: string, suffix = "&code=private-code") => request("/api/google-play/oauth/callback?state=" + state + suffix);
  return { sqlite, env, start, callback, request, verify, setAccount: (next: AdminAccount) => { account = next; authenticated = next; }, setSelected: (next: AdminAccount) => { account = next; }, account };
}
function google() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(init?.redirect).toBe("manual");
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
  it.each([
    ["token_exchange", {error:"invalid_grant", error_description:"private-code private-client-secret"}, 400],
    ["token_exchange", {access_token:"private-access",token_type:"unexpected",refresh_token:"private-refresh",scope:"https://www.googleapis.com/auth/androidpublisher"}, 200],
    ["offline_access", {access_token:"private-access",token_type:"Bearer",scope:"https://www.googleapis.com/auth/androidpublisher"}, 200],
    ["google_permissions", {access_token:"private-access",token_type:"Bearer",refresh_token:"private-refresh",scope:"openid email"}, 200],
  ] as const)("persists a safe %s reason without blaming Play app permissions", async (reason, token, status) => {
    const h = harness(); const warning = vi.spyOn(console,"warn").mockImplementation(() => {});
    vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json(token, {status}));
    const response = await h.request('/api/apps/' + appId + '/google-play-oauth/start', {method:'POST',headers:{authorization:'Bearer browser-session'}});
    const state = new URL((await response.json() as any).authorization_url).searchParams.get('state')!;
    const result = await h.callback(state);
    const redirect = new URL(result.headers.get('location')!);
    expect(redirect.searchParams.get('google_play_oauth')).toBe('failed');
    expect(redirect.searchParams.get('google_play_oauth_error')).toBe(reason);
    const rows = h.sqlite.prepare("SELECT payload FROM audit_logs WHERE action='google_play.oauth.failed'").all() as Array<{payload:string}>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({reason});
    if (status === 400) expect(JSON.parse(rows[0]!.payload)).toMatchObject({provider_status:400,provider_error:'invalid_grant'});
    const diagnostics = JSON.stringify([rows,warning.mock.calls,result.headers.get('location')]);
    for (const secret of ['private-code','private-client-secret','private-access','private-refresh',state]) expect(diagnostics).not.toContain(secret);
    expect(await getGooglePlayBindingMeta(h.env.DB,appId)).toBeNull();
    expect(h.verify).not.toHaveBeenCalled();
    expect((await h.callback(state)).status).toBe(400);
  });

  it.each(['timeout','profile','storage'] as const)('distinguishes %s failures without serializing exceptions or Google bodies', async mode => {
    const h = harness(); const warning = vi.spyOn(console,'warn').mockImplementation(() => {}); const fetch = google();
    if (mode === 'timeout') fetch.mockImplementationOnce(async () => {throw new Error('private-code private-refresh');});
    if (mode === 'profile') fetch.mockImplementationOnce(async () => Response.json({access_token:'access',refresh_token:oauth.refresh_token,token_type:'Bearer',scope:'https://www.googleapis.com/auth/androidpublisher'})).mockImplementationOnce(async () => Response.json({error:'private-access'}, {status:403}));
    if (mode === 'storage') h.sqlite.exec("CREATE TRIGGER reject_binding BEFORE INSERT ON app_google_play_bindings BEGIN SELECT RAISE(ABORT, 'private-refresh'); END");
    const started = await h.request('/api/apps/' + appId + '/google-play-oauth/start', {method:'POST',headers:{authorization:'Bearer browser-session'}});
    const state = new URL((await started.json() as any).authorization_url).searchParams.get('state')!;
    const result = await h.callback(state);
    const reason = mode === 'timeout' ? 'token_exchange' : mode === 'profile' ? 'account_identity' : 'credential_storage';
    expect(new URL(result.headers.get('location')!).searchParams.get('google_play_oauth_error')).toBe(reason);
    expect(h.sqlite.prepare("SELECT count(*) n FROM audit_logs WHERE action='google_play.oauth.failed'").get()).toEqual({n:1});
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-');
    expect(h.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['timeout', undefined, 'TimeoutError', () => Promise.reject(new DOMException('private-code', 'TimeoutError'))],
    ['transport', undefined, undefined, () => Promise.reject(Object.assign(new Error('private-code'), {name:'private-access'}))],
    ['transport', undefined, 'TypeError', () => Promise.reject(new TypeError('private-client-secret'))],
    ['response_body', 502, 'SyntaxError', () => Promise.resolve(new Response('<html>private-refresh</html>', {status:502}))],
    ['response_body', 200, 'SyntaxError', () => Promise.resolve(new Response('private-access', {status:200}))],
    ['invalid_response', 200, undefined, () => Promise.resolve(Response.json(null))],
    ['invalid_response', 200, undefined, () => Promise.resolve(Response.json([]))],
  ] as const)('records safe exchange detail %s with the received HTTP status', async (detail, status, exceptionName, result) => {
    const h = harness(); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(result);
    const {url} = await h.start(); const state = url!.searchParams.get('state')!;
    const response = await h.callback(state);
    const row = h.sqlite.prepare("SELECT payload FROM audit_logs WHERE action='google_play.oauth.failed'").get() as {payload:string};
    expect(JSON.parse(row.payload)).toEqual({reason:'token_exchange', exchange_failure:detail, ...(exceptionName ? {exception_name:exceptionName} : {}), ...(status === undefined ? {} : {provider_status:status})});
    const diagnostics = JSON.stringify([row, warning.mock.calls, response.headers.get('location')]);
    for (const secret of ['private-code','private-client-secret','private-refresh','private-access',state]) expect(diagnostics).not.toContain(secret);
    expect(await getGooglePlayBindingMeta(h.env.DB, appId)).toBeNull();
    expect(h.verify).not.toHaveBeenCalled();
    expect((await h.callback(state)).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['token', 'profile'] as const)('rejects %s redirects without forwarding credentials', async (stage) => {
    const h = harness(); const fetch = google(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    const redirect = new Response('private-code private-access', {status:302, headers:{location:'https://untrusted.test/steal'}});
    if (stage === 'token') fetch.mockResolvedValueOnce(redirect);
    else fetch.mockResolvedValueOnce(Response.json({access_token:'access',refresh_token:oauth.refresh_token,token_type:'Bearer',scope:'https://www.googleapis.com/auth/androidpublisher'})).mockResolvedValueOnce(redirect);
    const {url} = await h.start(); const state = url!.searchParams.get('state')!;
    const result = await h.callback(state);
    expect(new URL(result.headers.get('location')!).searchParams.get('google_play_oauth_error')).toBe(stage === 'token' ? 'token_exchange' : 'account_identity');
    expect(fetch).toHaveBeenCalledTimes(stage === 'token' ? 1 : 2);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).not.toContain('untrusted');
      expect(init?.redirect).toBe('manual');
    }
    const row = h.sqlite.prepare("SELECT payload FROM audit_logs WHERE action='google_play.oauth.failed'").get() as {payload:string};
    expect(JSON.parse(row.payload)).toMatchObject({provider_status:302});
    expect(row.payload).not.toContain('private-');
    expect(await getGooglePlayBindingMeta(h.env.DB, appId)).toBeNull();
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('keeps an actually stored connection successful when receipt bookkeeping fails', async () => {
    const h = harness(); google(); vi.spyOn(console,'warn').mockImplementation(() => {});
    h.sqlite.exec("CREATE TRIGGER reject_connect_audit BEFORE INSERT ON audit_logs WHEN NEW.action='google_play.oauth.connect' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    const response = await h.request('/api/apps/' + appId + '/google-play-oauth/start', {method:'POST',headers:{authorization:'Bearer browser-session'}});
    const state = new URL((await response.json() as any).authorization_url).searchParams.get('state')!;
    expect((await h.callback(state)).headers.get('location')).toContain('google_play_oauth=connected');
    expect(await getGooglePlayBindingMeta(h.env.DB,appId)).not.toBeNull();
    expect((await h.callback(state)).status).toBe(400);
  });

  it.each(['role', 'disconnect', 'expired'])('does not save an unconfigured connection after %s changes during Google I/O', async (mode) => {
    const h = harness(); const fetch = google();
    const response = await h.request('/api/apps/' + appId + '/google-play-oauth/start', {method:'POST',headers:{authorization:'Bearer browser-session'}});
    const url = new URL((await response.json() as any).authorization_url);
    fetch.mockImplementationOnce(async () => {
      if (mode === 'role') h.sqlite.exec('DELETE FROM app_members');
      if (mode === 'disconnect') await h.request('/api/apps/' + appId + '/google-play-binding', {method:'DELETE'});
      if (mode === 'expired') h.sqlite.exec('UPDATE google_play_oauth_requests SET expires_at=0');
      return Response.json({access_token:'access',refresh_token:oauth.refresh_token,token_type:'Bearer',scope:'https://www.googleapis.com/auth/androidpublisher'});
    });
    expect((await h.callback(url.searchParams.get('state')!)).headers.get('location')).toContain('google_play_oauth=failed');
    expect(await getGooglePlayBindingMeta(h.env.DB, appId)).toBeNull();
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('preserves existing encrypted bindings and pending requests while migrating and enforces unconfigured safety', async () => {
    const h = harness(false, true);
    await storeGooglePlayBinding(h.env.DB, {appId, packageName:input.package_name, tracks:input.tracks, credential:oauth, actor:'human', keyringJson:keyring, activeKeyVersion:'v1'});
    await h.start();
    const before = h.sqlite.prepare('SELECT * FROM app_google_play_bindings').get();
    const pending = h.sqlite.prepare('SELECT * FROM google_play_oauth_requests').get();
    h.sqlite.exec(readFileSync(new URL('../../migrations/sql/0080_google_play_connect_first.sql', import.meta.url), 'utf8'));
    expect(h.sqlite.prepare('SELECT * FROM app_google_play_bindings').get()).toEqual(before);
    expect(h.sqlite.prepare('SELECT * FROM google_play_oauth_requests').get()).toEqual(pending);
    expect(() => h.sqlite.exec('UPDATE app_google_play_bindings SET package_name=NULL')).toThrow();
    await storeGooglePlayBinding(h.env.DB, {appId, packageName:null, tracks:null, credential:oauth, actor:'human', keyringJson:keyring, activeKeyVersion:'v1'});
    expect(() => h.sqlite.exec('UPDATE app_google_play_bindings SET enabled=1')).toThrow();
    expect(() => h.sqlite.exec("UPDATE app_google_play_bindings SET verification_state='verified'")).toThrow();
    h.sqlite.prepare('DELETE FROM apps WHERE id=?').run(appId);
    expect(h.sqlite.prepare('SELECT count(*) n FROM app_google_play_bindings').get()).toEqual({n:0});
    expect(h.sqlite.prepare('SELECT count(*) n FROM google_play_oauth_requests').get()).toEqual({n:0});
    expect(h.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([undefined, "{}"])('connects without configuration (%s), then configures using the stored credential', async (body) => {
    const h = harness(); google();
    const response = await h.request('/api/apps/' + appId + '/google-play-oauth/start', {method:'POST', headers:{authorization:'Bearer browser-session', ...(body ? {'content-type':'application/json'} : {})}, ...(body === undefined ? {} : {body})});
    expect(response.status).toBe(200);
    const url = new URL((await response.json() as any).authorization_url);
    expect((await h.callback(url.searchParams.get('state')!)).headers.get('location')).toContain('/integrations?google_play_oauth=connected');
    expect(h.verify).not.toHaveBeenCalled();
    const meta = (await (await h.request('/api/apps/' + appId + '/google-play-binding')).json() as any).google_play;
    expect(meta).toMatchObject({package_name:null, internal_track:null, closed_track:null, production_track:null, enabled:false, verification_state:'stale', verified_at:null, credential_kind:'authorized_user'});
    expect(JSON.stringify(meta)).not.toContain(oauth.refresh_token);
    expect((await h.request('/api/apps/' + appId + '/google-play-binding/enable', {method:'POST'})).status).toBe(400);
    expect(h.verify).not.toHaveBeenCalled();
    const saved = await h.request('/api/apps/' + appId + '/google-play-binding', {method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(input)});
    expect(saved.status).toBe(200);
    expect(h.verify).toHaveBeenCalledOnce();
    expect(h.verify.mock.calls[0]![0].credential).toEqual(oauth);
    expect((await saved.json() as any).google_play).toMatchObject({package_name:input.package_name, enabled:true, verification_state:'verified'});
  });
  it.each([{package_name:input.package_name}, {tracks:input.tracks}, null, [], 'invalid'])('rejects malformed or partial configuration %j', async (body) => {
    const h = harness();
    const response = await h.request('/api/apps/' + appId + '/google-play-oauth/start', {method:'POST', headers:{authorization:'Bearer browser-session','content-type':'application/json'}, body:JSON.stringify(body)});
    expect(response.status).toBe(400);
    expect(h.sqlite.prepare('SELECT count(*) n FROM google_play_oauth_requests').get()).toEqual({n:0});
  });
  it('does not overwrite a disconnected OAuth credential after configuration verification', async () => {
    const h = harness();
    await storeGooglePlayBinding(h.env.DB, {appId, packageName:null, tracks:null, credential:oauth, actor:'human', keyringJson:keyring, activeKeyVersion:'v1'});
    h.verify.mockImplementationOnce(async (binding) => { await h.request('/api/apps/' + appId + '/google-play-binding', {method:'DELETE'}); return {ok:true,value:{client_email:binding.credential.client_email,package_name:binding.packageName}}; });
    const response = await h.request('/api/apps/' + appId + '/google-play-binding', {method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(input)});
    expect(response.status).toBe(409);
    expect(await getGooglePlayBindingMeta(h.env.DB, appId)).toBeNull();
  });

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
    expect(response.headers.get("location")).toBe("https://hands.test/apps/" + appId + "/integrations?google_play_oauth=connected");
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
  it.each(["cancelled", "scope", "scope-prefix", "scope-suffix", "refresh", "unverified", "play", "revoked", "replacement", "disconnect", "disconnect-during-callback", "expired-during-callback"])("does not persist a credential after %s", async (mode) => {
    const h = harness(); const fetch = google(); const { url } = await h.start(); const state = url!.searchParams.get("state")!;
    if (mode.startsWith("scope") || mode === "refresh") fetch.mockResolvedValueOnce(Response.json({ access_token: "access", token_type: "Bearer",
      refresh_token: mode === "refresh" ? undefined : "secret", scope: mode === "scope" ? "openid email" : mode === "scope-prefix" ? "https://evil.test/https://www.googleapis.com/auth/androidpublisher" : mode === "scope-suffix" ? "https://www.googleapis.com/auth/androidpublisher.extra" : "https://www.googleapis.com/auth/androidpublisher" }));
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
  it("shares only the configured parent domain between dashboard initiation and business callback", async () => {
    const h = harness(true); google();
    h.env.BUSINESS_ORIGIN = "https://hands.test";
    h.env.DASHBOARD_ORIGIN = "https://app.hands.test";
    h.sqlite.prepare("INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES ('session', 'human', ?, ?, ?, ?)").run(createHash("sha256").update("browser-session").digest("hex"), Date.now(), Date.now() + 3600000, Date.now());
    const start = await h.start("https://app.hands.test");
    expect(start.response.status).toBe(200);
    expect(start.response.headers.get("set-cookie")).toContain("Domain=hands.test");
    const response = await h.request("/api/google-play/oauth/callback?state=" + start.url!.searchParams.get("state") + "&code=code", {
      headers: { cookie: start.response.headers.get("set-cookie")!.split(";")[0]! },
    }, "https://hands.test");
    expect(response.headers.get("location")).toContain("https://app.hands.test/apps/");
    expect(response.headers.get("set-cookie")).toContain("Domain=hands.test");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    h.env.DASHBOARD_ORIGIN = "https://unrelated.test";
    expect((await h.start("https://unrelated.test")).response.status).toBe(503);
    expect((await h.start("https://untrusted.hands.test")).response.status).toBe(503);
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
  it.each([false, true])("restores the initiating cross-org account and rechecks its grant (revoked=%s)", async (revoked) => {
    const h = harness(true); const fetch = google();
    h.sqlite.prepare("INSERT INTO organizations (id, slug, name, external_id, created_at) VALUES ('target', 'target', 'Target', 'other-server', 1)").run();
    h.sqlite.prepare("INSERT INTO raft_accounts (id, provider, provider_subject, server_id, principal_type, display_name, raw_profile, created_at, updated_at, last_login_at) VALUES ('linked', 'raft', 'human', 'other-server', 'human', 'User', '{}', 1, 1, 1)").run();
    h.sqlite.prepare("INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES ('owner', 'target', 'linked', 'owner', 1)").run();
    h.sqlite.prepare("UPDATE apps SET org_id='target' WHERE id=?").run(appId);
    h.sqlite.prepare("INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES ('session', 'human', ?, ?, ?, ?)").run(createHash("sha256").update("browser-session").digest("hex"), Date.now(), Date.now() + 3600000, Date.now());
    const started = await h.start();
    expect(started.response.status).toBe(200);
    if (revoked) h.sqlite.exec("DELETE FROM app_members WHERE account_id='human'");
    const response = await h.request("/api/google-play/oauth/callback?state=" + started.url!.searchParams.get("state") + "&code=code", {
      headers: { cookie: started.response.headers.get("set-cookie")!.split(";")[0]! },
    });
    expect(response.status).toBe(revoked ? 403 : 303);
    if (revoked) expect(fetch).not.toHaveBeenCalled();
    else expect(response.headers.get("location")).toContain("connected");
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
