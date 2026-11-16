import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLAY_ACCESS_ALERT_AFTER_MS, recordPlayAccessFailure, recordPlayAccessSuccess } from "../src/lib/play_access_alerts";
import { formatRaftNotificationMessage } from "../src/lib/raft_notification_content";

const DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]) => {
      const params = (indexes.length ? indexes.map((i) => input[i - 1]) : input).map((v) => v === undefined ? null : v);
      const execute = () => statement.reader
        ? { results: statement.all(...params), success: true as const, meta: { changes: 0 } }
        : { results: [], success: true as const, meta: { changes: statement.run(...params).changes } };
      return { _execute: execute, run: async () => execute(), all: async () => execute(), first: async <T>() => (statement.get(...params) as T | undefined) ?? null };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: <T>() => bind().first<T>() };
  };
  return { prepare, batch: async (sts: { _execute: () => unknown }[]) => db.transaction(() => sts.map((s) => s._execute()))() };
}

function setup() {
  const sqlite = new Database(":memory:");
  for (const name of readdirSync(DIR).sort()) if (name.endsWith(".sql")) sqlite.exec(readFileSync(DIR + name, "utf8"));
  sqlite.exec(`INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org','org','Org','raft','s',1);
    INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES ('app','org','raft-android','Raft Android','android','ck',1);`);
  sqlite.pragma("foreign_keys = OFF");
  sqlite.prepare(`INSERT INTO webhooks (id, org_id, app_id, url, secret, events_json, enabled, created_by, created_at, updated_at)
    VALUES ('wh','org','app','https://hooks.test/x','s',?,1,'acct',1,1)`).run(JSON.stringify(["google_play:access_failed", "google_play:access_restored"]));
  const deliveries = () => sqlite.prepare("SELECT event_type, external_event_id, payload_json FROM webhook_deliveries ORDER BY created_at, external_event_id").all() as any[];
  return { db: d1(sqlite) as unknown as D1Database, deliveries, sqlite };
}

describe("Google Play access alerts", () => {
  it("alerts at once on a rejected authorization, once per episode, and reports the recovery", async () => {
    const { db, deliveries } = setup();
    const t0 = 1_800_000_000_000;
    await recordPlayAccessFailure(db, "app", "statistics", "play_reports_token_rejected", t0);
    await recordPlayAccessFailure(db, "app", "statistics", "play_reports_token_rejected", t0 + 6 * 3600_000);
    expect(deliveries().map((d) => d.event_type)).toEqual(["google_play:access_failed"]);
    const payload = JSON.parse(deliveries()[0].payload_json);
    expect(payload.payload).toMatchObject({ access: "statistics", error_code: "play_reports_token_rejected" });
    expect(payload.payload.hint).toMatch(/Authorize statistics reports/);
    await recordPlayAccessSuccess(db, "app", "statistics", t0 + 7 * 3600_000);
    await recordPlayAccessSuccess(db, "app", "statistics", t0 + 8 * 3600_000);
    expect(deliveries().map((d) => d.event_type)).toEqual(["google_play:access_failed", "google_play:access_restored"]);
    // A new episode alerts again.
    await recordPlayAccessFailure(db, "app", "statistics", "play_reports_token_rejected", t0 + 9 * 3600_000);
    expect(deliveries().filter((d) => d.event_type === "google_play:access_failed")).toHaveLength(2);
  });

  it("waits an hour before alerting on other failures, and says nothing if it recovers first", async () => {
    const { db, deliveries } = setup();
    const t0 = 1_800_000_000_000;
    await recordPlayAccessFailure(db, "app", "publishing", "play_api_unavailable", t0);
    await recordPlayAccessFailure(db, "app", "publishing", "play_api_unavailable", t0 + PLAY_ACCESS_ALERT_AFTER_MS - 1);
    expect(deliveries()).toHaveLength(0);
    await recordPlayAccessSuccess(db, "app", "publishing", t0 + PLAY_ACCESS_ALERT_AFTER_MS);
    expect(deliveries()).toHaveLength(0);
    await recordPlayAccessFailure(db, "app", "publishing", "play_api_unavailable", t0 + 2 * PLAY_ACCESS_ALERT_AFTER_MS);
    await recordPlayAccessFailure(db, "app", "publishing", "play_api_unavailable", t0 + 3 * PLAY_ACCESS_ALERT_AFTER_MS);
    expect(deliveries().map((d) => d.event_type)).toEqual(["google_play:access_failed"]);
    expect(JSON.parse(deliveries()[0].payload_json).payload).toMatchObject({ access: "publishing", access_label: "release status" });
  });

  it("renders a readable Raft message", () => {
    const text = formatRaftNotificationMessage({
      event: "google_play:access_failed",
      payload: { app: { name: "Raft Android" }, access_label: "statistics reports", error_code: "play_reports_token_rejected",
        failing_since: "2026-11-16T07:05:12.000Z", hint: "An app admin chooses \"Authorize statistics reports\".", occurred_at: "2026-11-16T07:05:12.000Z" },
    });
    expect(text).toContain("Google Play access failing");
    expect(text).toContain("Access: statistics reports");
    expect(text).toContain("Error: play_reports_token_rejected");
    expect(text).toContain("What to do:");
  });
});
