import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { ruleMatches, validateMatch, isHighRiskExit } from "../src/lib/feedback_rules";
import { handleCreateFeedbackRule, handleDeleteFeedbackRule, handleListFeedbackRules, handlePreviewFeedbackRule, handleUpdateFeedbackRule } from "../src/routes/feedback_rules";

const dir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const st = sqlite.prepare(sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; }));
    const bind = (...p: unknown[]) => {
      const args = (indexes.length ? indexes.map((i) => p[i - 1]) : p).map((v) => v === undefined ? null : v);
      return {
        run: async () => ({ success: true, meta: { changes: st.run(...args).changes } }),
        all: async () => ({ success: true, results: st.all(...args) }),
        first: async () => (st.get(...args) as Record<string, unknown> | undefined) ?? null,
      };
    };
    return { bind };
  };
  return { prepare } as unknown as D1Database;
}

function harness() {
  const sqlite = new Database(":memory:");
  for (const n of readdirSync(dir).sort()) if (n.endsWith(".sql")) sqlite.exec(readFileSync(`${dir}${n}`, "utf8"));
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app', 'raft-android', 'Raft', 'android', 1)").run();
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("admin_actor", "raft:tester@test"); await next(); });
  app.get("/r/:appId", handleListFeedbackRules);
  app.post("/r/:appId/preview", handlePreviewFeedbackRule);
  app.post("/r/:appId", handleCreateFeedbackRule);
  app.patch("/r/:appId/:ruleId", handleUpdateFeedbackRule);
  app.delete("/r/:appId/:ruleId", handleDeleteFeedbackRule);
  const env = { DB: d1(sqlite) } as unknown as Env;
  const call = (method: string, path: string, body?: unknown) => app.fetch(new Request(`https://h.test${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  return { sqlite, call };
}

const kill = (extra: Record<string, unknown>) => ({
  kind: "crash", signature: "SystemKill@signaled", channel: "main", device_model: "HUAWEI P60", version_code: 12900001,
  metadata: { crash_type: "system_kill", crash_exit_reason: "signaled", crash_exit_reason_code: 2, crash_exit_status: 9,
    crash_exit_importance: 230, crash_foreground: false, device_brand: "HUAWEI", ...extra },
});

describe("feedback rule matching", () => {
  const rule = { match: { exit_reason_codes: [2], exit_statuses: [9], exit_importance_min: 200, foreground: false,
    device_brands: ["huawei"], device_models: ["huawei p*"], channels: ["main"], version_code_min: 12900000, signatures: ["SystemKill@*"] },
    protect_high_risk: true };
  it("matches every condition, case-insensitively for devices, with prefixes", () => {
    expect(ruleMatches(rule, kill({}))).toBe(true);
    expect(ruleMatches(rule, kill({ crash_exit_importance: 125 }))).toBe(false);
    expect(ruleMatches(rule, kill({ crash_foreground: true }))).toBe(false);
    expect(ruleMatches(rule, kill({ device_brand: "Xiaomi" }))).toBe(false);
    expect(ruleMatches(rule, { ...kill({}), version_code: 12800000 })).toBe(false);
    expect(ruleMatches(rule, { ...kill({}), kind: "bug" })).toBe(false);
  });
  it("protects native crashes, ANRs and Java exceptions unless told not to", () => {
    for (const extra of [{ crash_exit_reason_code: 5 }, { crash_exit_reason: "anr" }, { crash_type: "java_exception" }]) {
      expect(isHighRiskExit(kill(extra))).toBe(true);
    }
    const loose = { match: { exit_statuses: [9] }, protect_high_risk: true };
    expect(ruleMatches(loose, kill({ crash_exit_reason_code: 5 }))).toBe(false);
    expect(ruleMatches({ ...loose, protect_high_risk: false }, kill({ crash_exit_reason_code: 5 }))).toBe(true);
  });
  it("matches the exit description exactly", () => {
    const swipe = { match: { exit_reason_codes: [13], exit_descriptions: ["SwipeUpClean"] }, protect_high_risk: true };
    expect(ruleMatches(swipe, kill({ crash_exit_reason_code: 13, crash_exit_description: "SwipeUpClean" }))).toBe(true);
    expect(ruleMatches(swipe, kill({ crash_exit_reason_code: 13, crash_exit_description: "swipeupclean" }))).toBe(false);
    expect(ruleMatches(swipe, kill({ crash_exit_reason_code: 13, crash_exit_description: "SwipeUpClean extra" }))).toBe(false);
    expect(ruleMatches(swipe, kill({ crash_exit_reason_code: 13 }))).toBe(false);
    expect(validateMatch({ exit_descriptions: ["SwipeUpClean"] })).toEqual({ match: { exit_descriptions: ["SwipeUpClean"] } });
    expect(validateMatch({ exit_descriptions: [] })).toMatchObject({ error: expect.stringMatching(/exit_descriptions/) });
    expect(validateMatch({ exit_descriptions: ["x".repeat(1001)] })).toMatchObject({ error: expect.stringMatching(/exit_descriptions/) });
  });
  it("validates conditions", () => {
    expect(validateMatch({ kinds: ["crash"] })).toEqual({ error: "match needs at least one condition besides kinds" });
    expect(validateMatch({ nope: 1 })).toEqual({ error: "match has an unknown condition: nope" });
    expect(validateMatch({ exit_statuses: ["9"] })).toMatchObject({ error: expect.stringMatching(/integers/) });
    expect(validateMatch({ foreground: false })).toEqual({ match: { foreground: false } });
  });
});

describe("feedback rule routes", () => {
  it("creates disabled rules, previews against past tickets without changing them, updates and deletes", async () => {
    const { sqlite, call } = harness();
    const insert = (id: string, meta: Record<string, unknown>, status = "open") => sqlite.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, closure_reason, message, metadata_json, signature, created_at, updated_at, version_code)
       VALUES (?, 'app', 'crash', ?, ?, 'x', ?, 'SystemKill@signaled', ?, ?, 12900001)`,
    ).run(id, status, status === "closed" ? "not_planned" : null, JSON.stringify(kill(meta).metadata), Date.now(), Date.now());
    insert("t1", {}); insert("t2", {}, "closed"); insert("t3", { crash_exit_importance: 100 }); insert("t4", { crash_exit_reason_code: 5 });
    const match = { exit_reason_codes: [2, 5], exit_importance_min: 200 };
    const preview = await (await call("POST", "/r/app/preview", { match, days: 7 })).json() as any;
    expect(preview).toMatchObject({ scanned: 4, matched: 2, matched_open: 1, by_signature: [{ signature: "SystemKill@signaled", count: 2 }] });
    expect(preview.sample.map((t: any) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(sqlite.prepare("SELECT status FROM feedback_tickets WHERE id = 't1'").get()).toEqual({ status: "open" });

    expect((await call("POST", "/r/app", { name: "x", action: "delete", match })).status).toBe(400);
    const created = await call("POST", "/r/app", { name: "Background kills", action: "close", match });
    expect(created.status).toBe(201);
    const rule = (await created.json() as any).rule;
    expect(rule).toMatchObject({ enabled: false, protect_high_risk: true, action: "close", match });
    const byId = await (await call("POST", "/r/app/preview", { rule_id: rule.id })).json() as any;
    expect(byId.matched).toBe(2);
    expect(((await (await call("PATCH", `/r/app/${rule.id}`, { enabled: true })).json()) as any).rule.enabled).toBe(true);
    expect(((await (await call("GET", "/r/app")).json()) as any).rules).toHaveLength(1);
    expect((await call("DELETE", `/r/app/${rule.id}`)).status).toBe(200);
    expect((await call("DELETE", `/r/app/${rule.id}`)).status).toBe(404);
    expect(sqlite.prepare("SELECT action FROM audit_logs ORDER BY created_at").all().map((r: any) => r.action))
      .toEqual(["feedback.rule_created", "feedback.rule_updated", "feedback.rule_deleted"]);
  });
});
