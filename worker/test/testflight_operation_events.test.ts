import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { completeTestflightOperation, testflightOperationEvent } from "../src/lib/testflight_events";
import { enqueueDueDeliveries } from "../src/routes/webhooks";

const upload = { ok: true, asc_app_id: "asc-app", build_upload_id: "upload", state: { state: "PROCESSING" } };
const publish = { ok: true, asc_app_id: "asc-app", asc_build_id: "asc-build", version: "1.13.0",
  build_number: "11300004", distribution: "internal", requested_group_ids: ["group"],
  assigned_groups: [{ id: "group", name: "Botiverse", is_internal: true }],
  beta_detail: { internal_build_state: "IN_BETA_TESTING", auto_notify_enabled: true } };
function setup(kind = "testflight-upload") {
  const sql = new Database(":memory:");
  sql.pragma("foreign_keys = ON");
  const directory = new URL("../../migrations/sql/", import.meta.url);
  for (const file of readdirSync(directory).sort())
    if (file.endsWith(".sql")) sql.exec(readFileSync(new URL(file, directory), "utf8"));
  sql.exec(`INSERT INTO organizations(id,slug,name,external_id,created_at) VALUES('org','org','Org','org',0);
    INSERT INTO raft_accounts(id,provider_subject,server_id,principal_type,display_name,raw_profile,created_at,updated_at,last_login_at) VALUES('actor','actor','server','human','Actor','{}',0,0,0);
    INSERT INTO apps(id,slug,name,platform,created_at,org_id) VALUES('app','raft-ios','Raft iOS','ios',0,'org'),('other','other','Other','ios',0,'org');
    INSERT INTO operation_logs(id,app_id,kind,status,input,created_at,updated_at)
      VALUES('operation','app','${kind}','in_progress','{"version_name":"1.13.0","version_code":11300004}',0,0);`);
  for (const [id, app, enabled, events] of [
    ["matching", "app", 1, '["testflight:upload_processing","testflight:internal_distribution_ready"]'],
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
        first: async () => stmt.get(...values) ?? null,
        all: async () => ({ results: stmt.all(...values) }) };
    } };
  }
  const db = { prepare, batch: async (stmts: Array<{ execute(): unknown }>) => sql.transaction(() => stmts.map(s => s.execute()))() } as unknown as D1Database;
  return { sql, db };
}
describe("verified TestFlight operation notifications", () => {
  it("commits processing with success, exact build identity, subscriber isolation, dedupe and immediate queue selection", async () => {
    const { db, sql } = setup();
    const now = await completeTestflightOperation(db, "app", "operation", "testflight-upload", upload);
    const rows = sql.prepare("SELECT * FROM webhook_deliveries ORDER BY webhook_id").all() as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ event: "testflight:upload_processing",
      event_id: "hands-operation:operation:testflight:upload_processing", payload: {
        source: "hands_operation_receipt", version: "1.13.0", build_number: "11300004", state: "PROCESSING" } });
    const messages: unknown[] = [];
    const env = { DB: db, WEBHOOK_QUEUE: { sendBatch: async (items: unknown[]) => { messages.push(...items); } } };
    expect(await enqueueDueDeliveries(env as unknown as Env, now)).toBe(2);
    expect(messages).toHaveLength(2);
    await completeTestflightOperation(db, "app", "operation", "testflight-upload", upload);
    expect(sql.prepare("SELECT count(*) n FROM webhook_deliveries").get()).toEqual({ n: 2 });
  });
  it("only emits internal readiness after state and selected-group access are read back", async () => {
    expect(testflightOperationEvent("testflight-publish", { ...publish, distribution: "external" })).toBeNull();
    expect(testflightOperationEvent("testflight-publish", { ...publish, assigned_groups: [] })).toBeNull();
    expect(testflightOperationEvent("testflight-publish", { ...publish, beta_detail: { internal_build_state: "READY_FOR_BETA_TESTING" } })).toBeNull();
    const { db, sql } = setup("testflight-publish");
    await completeTestflightOperation(db, "app", "operation", "testflight-publish", publish);
    const row = sql.prepare("SELECT payload_json FROM webhook_deliveries LIMIT 1").get() as { payload_json: string };
    expect(JSON.parse(row.payload_json).payload).toMatchObject({ state: "IN_BETA_TESTING", auto_notify_enabled: true,
      groups: [{ id: "group", name: "Botiverse" }], resource: { type: "builds", id: "asc-build" } });
  });
  it("does not invent PROCESSING from commit, null, terminal, or failed readbacks", () => {
    for (const state of [null, { state: "COMPLETE" }, { state: "FAILED" }])
      expect(testflightOperationEvent("testflight-upload", { ...upload, state })).toBeNull();
    expect(testflightOperationEvent("testflight-upload", { ...upload, ok: false })).toBeNull();
  });
  it("rolls back success on delivery write failure and rejects another app's operation", async () => {
    const { db, sql } = setup();
    sql.exec("CREATE TRIGGER delivery_failure BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT,'write failed'); END");
    await expect(completeTestflightOperation(db, "app", "operation", "testflight-upload", upload)).rejects.toThrow("write failed");
    expect(sql.prepare("SELECT status FROM operation_logs").get()).toEqual({ status: "in_progress" });
    expect(sql.prepare("SELECT count(*) n FROM webhook_deliveries").get()).toEqual({ n: 0 });
    sql.exec("DROP TRIGGER delivery_failure");
    await expect(completeTestflightOperation(db, "other", "operation", "testflight-upload", upload)).rejects.toThrow("no longer writable");
    expect(sql.prepare("SELECT count(*) n FROM webhook_deliveries").get()).toEqual({ n: 0 });
  });
});
