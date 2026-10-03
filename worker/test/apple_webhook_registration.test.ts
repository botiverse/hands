import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAppRole } from "../src/lib/permissions";
import { encryptP8, getAscCredentials } from "../src/lib/asc_credentials";
import { ascRequest, AscApiError } from "../src/lib/asc_api";
import { handleRegisterAppleWebhook } from "../src/routes/apple_webhooks";
vi.mock("../src/lib/asc_credentials", async (original) => ({ ...await original<typeof import('../src/lib/asc_credentials')>(), getAscCredentials: vi.fn() }));
vi.mock("../src/lib/asc_api", async (original) => ({ ...await original<typeof import('../src/lib/asc_api')>(), ascRequest: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const appId = "76304f16-fbf7-488f-8445-e16ffdd6cef8";
const url = "https://hands.build/api/apple/webhooks/config";
const eventTypes = ["APP_STORE_VERSION_APP_VERSION_STATE_UPDATED", "BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED", "BUILD_UPLOAD_STATE_UPDATED"];
const resource = { id: "apple-subscription", type: "webhooks", attributes: { url, enabled: true, eventTypes } };
async function setup(role = "admin") {
  const sql = new Database(":memory:");
  const dir = new URL("../../migrations/sql/", import.meta.url);
  for (const f of readdirSync(dir).sort()) if (f.endsWith('.sql')) sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  sql.exec(`INSERT INTO organizations(id,slug,name,external_id,created_at) VALUES('org','org','Org','org',0);
    INSERT INTO raft_accounts(id,provider_subject,server_id,principal_type,display_name,raw_profile,created_at,updated_at,last_login_at) VALUES('actor','actor','server','agent','Actor','{}',0,0,0);
    INSERT INTO apps(id,slug,name,platform,created_at,org_id) VALUES('${appId}','raft-ios','Raft iOS','ios',0,'org');
    INSERT INTO app_members(id,app_id,account_id,app_role,invited_by,joined_at) VALUES('member','${appId}','actor','${role}','actor',0);`);
  const encrypted = await encryptP8("private-hmac", "test-key");
  sql.prepare(`INSERT INTO apple_webhook_configs VALUES('config',?,'6789091965',?,?,1,0,0)`).run(appId,encrypted.ciphertext_b64,encrypted.iv_b64);
  const DB = { prepare(query: string) {
    const indexes: number[] = [];
    const stmt = sql.prepare(query.replace(/\?(\d+)/g, (_s, n) => { indexes.push(Number(n)); return '?'; }));
    return { bind(...args: unknown[]) { const values = indexes.map((i) => args[i-1]); return {
      first: async () => stmt.get(...values) ?? null, run: async () => { const r=stmt.run(...values);return {meta:{changes:r.changes}}; },
      all: async () => ({ results: stmt.all(...values) }),
    }; } };
  } };
  vi.mocked(getAscCredentials).mockResolvedValue({ key_id:'key',issuer_id:'issuer',p8:'private-p8' } as never);
  const app = new Hono<any>();
  app.use('*',async(c,next)=>{c.set('admin_account',{id:'actor',principal_type:'agent',display_name:'Actor',server_id:'server'});await next();});
  app.post('/api/apps/:appId/apple-webhook/register',requireAppRole('admin'),handleRegisterAppleWebhook as never);
  const send=()=>app.request(`/api/apps/${appId}/apple-webhook/register`,{method:'POST'},{DB,ASC_CRED_ENC_KEY:'test-key',BUSINESS_ORIGIN:'https://hands.build'});
  return {sql,send};
}
describe('Apple webhook registration using stored credentials',()=>{
  it('registers only this app, verifies Apple readback and never returns secrets',async()=>{
    const {sql,send}=await setup();
    vi.mocked(ascRequest).mockResolvedValueOnce({data:[]}).mockResolvedValueOnce({data:resource}).mockResolvedValueOnce({data:resource});
    const response=await send();expect(response.status).toBe(200);
    const text=await response.text();expect(text).not.toContain('private-');
    expect(vi.mocked(ascRequest).mock.calls[1]).toMatchObject([expect.anything(),'POST','/v1/webhooks',{data:{attributes:{url,secret:'private-hmac',eventTypes},relationships:{app:{data:{type:'apps',id:'6789091965'}}}}}, expect.any(AbortSignal)]);
    expect(sql.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='apple_webhook.register'").get()).toEqual({n:1});
  });
  it('discovers a prior accepted request and updates it rather than creating again',async()=>{
    const {send}=await setup();
    vi.mocked(ascRequest).mockResolvedValueOnce({data:[resource]}).mockResolvedValueOnce({data:resource}).mockResolvedValueOnce({data:resource});
    const response=await send();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({reused:true});
    expect(vi.mocked(ascRequest).mock.calls[1]![1]).toBe('PATCH');
    expect(vi.mocked(ascRequest).mock.calls.every((c)=>c[1]!=='POST')).toBe(true);
  });
  it('rejects non-admin agents before decrypting credentials or calling Apple',async()=>{
    const {send}=await setup('viewer');expect((await send()).status).toBe(403);
    expect(getAscCredentials).not.toHaveBeenCalled();expect(ascRequest).not.toHaveBeenCalled();
  });
  it('does not register ingress deleted while listing Apple subscriptions',async()=>{
    const {sql,send}=await setup();vi.mocked(ascRequest).mockImplementationOnce(async()=>{sql.exec('DELETE FROM apple_webhook_configs');return {data:[]};});
    expect((await send()).status).toBe(409);expect(ascRequest).toHaveBeenCalledTimes(1);
  });
  it('does not create when duplicate subscriptions already match',async()=>{
    const {send}=await setup();vi.mocked(ascRequest).mockResolvedValueOnce({data:[resource,resource]});
    expect((await send()).status).toBe(409);expect(ascRequest).toHaveBeenCalledTimes(1);
  });
  it('reports the actual provider failure stage/status without echoing provider secrets',async()=>{
    const {send}=await setup();vi.mocked(ascRequest).mockRejectedValueOnce(new AscApiError(403,'private-provider-body','private-hmac'));
    const r=await send();expect(r.status).toBe(502);expect(await r.json()).toEqual({error:'App Store Connect webhook registration failed',stage:'list_webhooks',upstream_status:403});
  });
  it('rejects failed readback instead of claiming registration verified',async()=>{
    const {send}=await setup();vi.mocked(ascRequest).mockResolvedValueOnce({data:[]}).mockResolvedValueOnce({data:resource}).mockResolvedValueOnce({data:{...resource,attributes:{...resource.attributes,enabled:false}}});
    const r=await send();expect(r.status).toBe(502);expect(await r.json()).toMatchObject({stage:'readback_webhook'});
  });
  it('never sends credentials to an unexpected pagination origin',async()=>{
    const {send}=await setup();vi.mocked(ascRequest).mockResolvedValueOnce({data:[],links:{next:'https://attacker.example/v1/apps/6789091965/webhooks'}});
    expect((await send()).status).toBe(502);expect(ascRequest).toHaveBeenCalledTimes(1);
  });
});
