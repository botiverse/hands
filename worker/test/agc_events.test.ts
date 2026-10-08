import Database from "better-sqlite3";
import { readFileSync,readdirSync } from "node:fs";
import { afterEach, describe,expect,it,vi } from "vitest";
import { recordAgcTransition, type AgcSubmission } from "../src/lib/agc_events";
import { pollAgcInvitations } from "../src/lib/agc_poll";
vi.mock("../src/routes/agc_testing", () => ({ resolveAgcAppAuth: async () => ({accessToken:"secret-token"}) }));
import { getAgcTestVersionStatus } from "../src/lib/agc_api";
vi.mock("../src/lib/agc_api", async orig => ({...await orig<typeof import("../src/lib/agc_api")>(),getAgcTestVersionStatus:vi.fn()}));
afterEach(()=>{vi.restoreAllMocks();vi.mocked(getAgcTestVersionStatus).mockReset();});
function setup() {
  const sql = new Database(":memory:");
  sql.pragma("foreign_keys = ON");
  const directory = new URL("../../migrations/sql/", import.meta.url);
  for (const file of readdirSync(directory).sort())
    if (file.endsWith(".sql")) sql.exec(readFileSync(new URL(file, directory), "utf8"));
  sql.exec(`INSERT INTO organizations(id,slug,name,external_id,created_at) VALUES('org','org','Org','org',0);
    INSERT INTO raft_accounts(id,provider_subject,server_id,principal_type,display_name,raw_profile,created_at,updated_at,last_login_at) VALUES('actor','actor','server','human','Actor','{}',0,0,0);
    INSERT INTO apps(id,slug,name,platform,created_at,org_id) VALUES('app','raft-ios','Raft iOS','ios',0,'org'),('other','other','Other','ios',0,'org');
    INSERT INTO builds(id,app_id,version_name,version_code,created_at,updated_at) VALUES('build','app','1.13.0',11300006,0,0);
    INSERT INTO market_submissions(id,app_id,build_id,provider,lane,state,idempotency_key,created_by_actor,created_at,updated_at,external_app_id,external_version_id,provider_state_json)
      VALUES('submission','app','build','appgallery','invitation_test','testing_review','attempt','actor',0,0,'agc-app','agc-version','{"group_ids":["g1","g2"]}');`);
  for (const [id, app, enabled, events] of [
    ["matching", "app", 1, '["appgallery:invitation_state_changed"]'],
    ["all", null, 1, "[]"], ["other", "other", 1, "[]"],
    ["disabled", "app", 0, "[]"], ["external-only", "app", 1, '["testflight:external_state_changed"]'],
  ]) sql.prepare(`INSERT INTO webhooks(id,org_id,app_id,url,enabled,events_json,secret,created_by,created_at,updated_at)
    VALUES(?,'org',?,'https://receiver.example',?,?,'secret','actor',0,0)`).run(id, app, enabled, events);
  function prepare(query: string) {
    const indexes: number[] = [];
    const stmt = sql.prepare(query.replace(/\?(\d+)/g, (_, n) => { indexes.push(Number(n)); return "?"; }));
    return { bind(...args: unknown[]) {
      const values = indexes.length ? indexes.map(n => args[n - 1]) : args;
      return { execute: () => ({ success: true, meta: { changes: stmt.run(...values).changes } }),
        run: async () => ({ success:true,meta:{changes:stmt.run(...values).changes} }),
        first: async () => stmt.get(...values) ?? null,
        all: async () => ({ results: stmt.all(...values) }) };
    } };
  }
  const db = { prepare, batch: async (stmts: Array<{ execute(): unknown }>) => sql.transaction(() => stmts.map(s => s.execute()))() } as unknown as D1Database;
  const old = sql.prepare("SELECT * FROM market_submissions").get() as AgcSubmission;
  return { sql, db, old };
}
describe("AGC atomic invitation notifications",()=>{
 it("commits identity, selected group IDs and isolated deliveries; stale replay is a no-op",async()=>{
  const {db,sql,old}=setup();
  expect(await recordAgcTransition(db,old,"testing_active",{release_state:0,audit_opinion:"private-opinion",upload_url:"private-signed-url"},null,300001)).toBe(true);
  const rows=sql.prepare("SELECT * FROM webhook_deliveries ORDER BY webhook_id").all() as Array<{payload_json:string}>;
  expect(rows).toHaveLength(2);
  const body=JSON.parse(rows[0]!.payload_json);
  expect(body.payload).toMatchObject({app:{slug:"raft-ios"},version:"1.13.0",build_number:"11300006",state:"testing_active",provider_state:0,groups_display:"测试组 ID：g1、g2"});
  expect(rows[0]!.payload_json).not.toContain("private-");
  expect(await recordAgcTransition(db,old,"rejected",{},null,300002)).toBe(false);
  expect(sql.prepare("SELECT count(*) n FROM webhook_deliveries").get()).toEqual({n:2});
  expect(sql.prepare("SELECT count(*) n FROM market_submission_events").get()).toEqual({n:1});
 });
 it("labels developer withdrawal distinctly and marks cron observation rather than a live review action",async()=>{
  const {db,sql,old}=setup();
  await recordAgcTransition(db,old,"ready",{release_state:11,notification_source:"provider_poll"},null,300001);
  const row=sql.prepare("SELECT payload_json FROM webhook_deliveries LIMIT 1").get() as {payload_json:string};
  expect(JSON.parse(row.payload_json).payload).toMatchObject({state_label:"开发者撤回邀请测试审核",observation_display:"定时查询观测（不是刚发生的审核变化）"});
 });
 it("rolls back state and history if delivery insertion fails",async()=>{
  const {db,sql,old}=setup();
  sql.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT,'delivery failed'); END");
  await expect(recordAgcTransition(db,old,"rejected",{},null,300001)).rejects.toThrow();
  expect(sql.prepare("SELECT state FROM market_submissions").get()).toEqual({state:"testing_review"});
  expect(sql.prepare("SELECT count(*) n FROM market_submission_events").get()).toEqual({n:0});
 });
 it("polls read-only once per slot, catches transition and never turns an outage into rejection",async()=>{
  const {db,sql}=setup();
  const env={DB:db,AGC_CRED_ENC_KEY:"key",WEBHOOK_QUEUE:{sendBatch:async()=>{}}} as unknown as Env;
  vi.mocked(getAgcTestVersionStatus).mockResolvedValue({release_state:0,audit_opinion:null,open_test_info:null});
  await pollAgcInvitations(env,300611);await pollAgcInvitations(env,300900);
  expect(getAgcTestVersionStatus).toHaveBeenCalledTimes(1);
  expect(getAgcTestVersionStatus).toHaveBeenCalledWith({accessToken:"secret-token"},"agc-app","agc-version");
  expect(sql.prepare("SELECT state FROM market_submissions").get()).toEqual({state:"testing_active"});
  vi.mocked(getAgcTestVersionStatus).mockRejectedValue(new Error("secret-provider-error"));
  const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  await pollAgcInvitations(env,600373);
  expect(getAgcTestVersionStatus).toHaveBeenCalledTimes(2);
  expect(sql.prepare("SELECT state FROM market_submissions").get()).toEqual({state:"testing_active"});
  expect(sql.prepare("SELECT count(*) n FROM market_submission_events").get()).toEqual({n:1});
  expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-");
 });
 it("keeps unknown provider values without inventing approval or rejection",async()=>{
  const {db,sql}=setup();vi.mocked(getAgcTestVersionStatus).mockResolvedValue({release_state:99,audit_opinion:null,open_test_info:null});
  await pollAgcInvitations({DB:db,AGC_CRED_ENC_KEY:"key",WEBHOOK_QUEUE:{sendBatch:async()=>{}}} as unknown as Env,300611);
  const row=sql.prepare("SELECT state,provider_state_json FROM market_submissions").get() as {state:string;provider_state_json:string};
  expect(row.state).toBe("testing_review");expect(JSON.parse(row.provider_state_json).release_state).toBe(99);
  expect(sql.prepare("SELECT count(*) n FROM webhook_deliveries").get()).toEqual({n:0});
 });
});
