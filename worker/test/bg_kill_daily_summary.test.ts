import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildBackgroundSystemKillDailySummary, backgroundSystemKillSpike } from "../src/routes/feedback";

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

const DAY = "2026-11-26";
const DAY_MS = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const addDays = (day: string, n: number) => new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
const window = { day: DAY, startMs: dayMs(DAY), endMs: dayMs(DAY) + DAY_MS };

function harness() {
  const sqlite = new Database(":memory:");
  for (const n of readdirSync(dir).sort()) if (n.endsWith(".sql")) sqlite.exec(readFileSync(`${dir}${n}`, "utf8"));
  sqlite.prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES ('app', NULL, 'raft-android', 'Raft', 'android', 1)").run();
  sqlite.prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('ch', 'app', 'main', 'Main', 1)").run();
  let n = 0;
  const build = (versionName: string, versionCode: number) => {
    n += 1;
    sqlite.prepare(
      `INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code,
                           source, status, build_metadata_json, parsed_metadata_json, provenance_json, created_at, updated_at)
       VALUES (?, 'app', 'ch', 'apk', 'stable', ?, ?, 'upload', 'succeeded', '{}', '{}', '{}', 1, 1)`,
    ).run(`b${n}`, versionName, versionCode);
  };
  /** `devices` devices active on `channel`/`code` every day from `from` to `to` inclusive. */
  const pings = (channel: string, code: number, from: string, to: string, devices: number, prefix = `${channel}-${code}`) => {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      for (let i = 0; i < devices; i++) {
        sqlite.prepare(
          "INSERT OR IGNORE INTO device_ping_days (app_id, day, device_id, channel, platform, version_code) VALUES ('app', ?, ?, ?, 'android', ?)",
        ).run(d, `${prefix}-${i}`, channel, code);
      }
    }
  };
  const kill = (o: { channel: string | null; versionName: string; code: number; device: string; at: number; ruleId?: string }) => {
    n += 1;
    const metadata: Record<string, unknown> = { crash_type: "system_kill", crash_exit_reason_code: 13, crash_exit_importance: 400 };
    if (o.ruleId) metadata.hands_rule = { id: o.ruleId, name: "rule", action: "close" };
    sqlite.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, closure_reason, message, version_name, version_code, channel, device_id,
                                     metadata_json, signature, created_at, updated_at)
       VALUES (?, 'app', 'crash', 'closed', 'not_planned', 'kill', ?, ?, ?, ?, ?, 'SystemKill@background', ?, ?)`,
    ).run(`t${n}`, o.versionName, o.code, o.channel, o.device, JSON.stringify(metadata), o.at, o.at);
  };
  const rule = (id: string, category: string | null) => {
    sqlite.prepare(
      `INSERT INTO feedback_rules (id, app_id, name, enabled, action, match_json, created_at, updated_at, category)
       VALUES (?, 'app', ?, 1, 'close', '{"crash_types":["system_kill"]}', 1, 1, ?)`,
    ).run(id, id, category);
  };
  const env = { DB: d1(sqlite) } as unknown as Env;
  return { sqlite, env, build, pings, kill, rule };
}

/**
 * One commit ships as preview N, Hands main N+1 and Play N+2 (Play reports the
 * main channel), so 1.30.0 is 13000014 on preview and 13000015/13000016 on main.
 */
function release130(h: ReturnType<typeof harness>) {
  for (const [name, code] of [["1.29.0", 12900010], ["1.29.0", 12900011], ["1.29.0", 12900012],
    ["1.30.0", 13000014], ["1.30.0", 13000015], ["1.30.0", 13000016]] as const) h.build(name, code);
  h.pings("main", 12900011, "2026-11-10", "2026-11-25", 10);
  h.pings("main", 12900012, "2026-11-10", "2026-11-25", 10);
  h.pings("preview", 12900010, "2026-11-10", "2026-11-24", 2);
  h.pings("main", 13000015, "2026-11-20", DAY, 15);
  h.pings("main", 13000016, "2026-11-21", DAY, 15);
  h.pings("preview", 13000014, "2026-11-25", DAY, 5);
  h.rule("swipe", "user_cleanup");
  h.rule("plain", null);
  // Baseline window for main 1.30.0 (first seen 11-20): 11-13..11-19, 20 devices a day on 1.29.0.
  for (let i = 0; i < 14; i++) {
    h.kill({ channel: "main", versionName: "1.29.0", code: 12900011, device: `old-${i}`, at: dayMs("2026-11-13") + i * 3_600_000 * 8 });
  }
  // A cleanup report in the window does not count toward the baseline.
  h.kill({ channel: "main", versionName: "1.29.0", code: 12900011, device: "old-x", at: dayMs("2026-11-15"), ruleId: "swipe" });
  // Preview baseline window (1.30.0 first seen 11-25): 11-18..11-24.
  h.kill({ channel: "preview", versionName: "1.29.0", code: 12900010, device: "pv-old", at: dayMs("2026-11-20") });
  const t = window.startMs + 3_600_000;
  for (let i = 0; i < 18; i++) {
    h.kill({ channel: "main", versionName: "1.30.0", code: i % 2 ? 13000015 : 13000016, device: `m-${i % 9}`, at: t + i });
  }
  h.kill({ channel: "main", versionName: "1.30.0", code: 13000015, device: "m-swipe", at: t, ruleId: "swipe" });
  h.kill({ channel: "main", versionName: "1.30.0", code: 13000015, device: "m-swipe", at: t + 1, ruleId: "swipe" });
  // Closed by a rule without a category: still an ordinary report.
  h.kill({ channel: "main", versionName: "1.30.0", code: 13000016, device: "m-plain", at: t, ruleId: "plain" });
  for (let i = 0; i < 3; i++) h.kill({ channel: "preview", versionName: "1.30.0", code: 13000014, device: `p-${i}`, at: t + i });
}

describe("daily background system kill summary", () => {
  it("compares each version only with the previous version of the same channel, per active device", async () => {
    const h = harness();
    release130(h);
    const built = await buildBackgroundSystemKillDailySummary(h.env, "app", window);
    const s = built!.summary;
    expect(s).toMatchObject({
      total_count: 24, user_cleanup_count: 2, total_count_excluding_cleanup: 22, ping_data_since: "2026-11-10",
    });
    expect(s.by_version.map((r) => [r.channel, r.version_name])).toEqual([["main", "1.30.0"], ["preview", "1.30.0"]]);

    const main = s.by_version[0]!;
    expect(main).toMatchObject({
      version_codes: [13000015, 13000016],
      version_code: 13000016,
      count: 21,
      user_cleanup_count: 2,
      count_excluding_cleanup: 19,
      device_count: 11,
      device_count_excluding_cleanup: 10,
      active_devices: 30,
      baseline_unavailable_reason: null,
    });
    expect(main.kills_per_active_device).toBeCloseTo(19 / 30);
    expect(main.affected_device_share).toBeCloseTo(10 / 30);
    // The previous main version, not preview's 13000014 from the same commit.
    expect(main.baseline).toMatchObject({
      version_name: "1.29.0",
      version_codes: [12900011, 12900012],
      window_start_day: "2026-11-13",
      window_end_day: "2026-11-19",
      count: 14,
      active_device_days: 140,
    });
    expect(main.baseline!.rate).toBeCloseTo(0.1);
    expect(main.spike).toBe(true);

    // Preview is compared with preview 1.29.0. Its rate is far higher, but 5
    // active devices and 3 reports are too few to flag.
    const preview = s.by_version[1]!;
    expect(preview).toMatchObject({ version_codes: [13000014], count: 3, active_devices: 5 });
    expect(preview.baseline).toMatchObject({ version_name: "1.29.0", version_codes: [12900010], count: 1, active_device_days: 14 });
    expect(preview.spike).toBe(false);
  });

  it("does not flag when the rate is within twice the baseline", async () => {
    const h = harness();
    release130(h);
    // Forty more baseline reports: 54 / 140 ≈ 0.39, and today's 19 / 30 ≈ 0.63
    // is less than twice that.
    for (let i = 0; i < 40; i++) {
      h.kill({ channel: "main", versionName: "1.29.0", code: 12900012, device: `old2-${i}`, at: dayMs("2026-11-14") + i });
    }
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    expect(s.by_version[0]!.baseline!.count).toBe(54);
    expect(s.by_version[0]!.spike).toBe(false);
  });

  it("gives no rate and no flag without active-device data for the day", async () => {
    const h = harness();
    release130(h);
    h.sqlite.prepare("DELETE FROM device_ping_days WHERE day = ?").run(DAY);
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    for (const row of s.by_version) {
      expect(row).toMatchObject({ active_devices: null, kills_per_active_device: null, affected_device_share: null, spike: false });
    }
  });

  it("gives no baseline when the 7 days before the new version predate the ping data", async () => {
    const h = harness();
    release130(h);
    h.sqlite.prepare("DELETE FROM device_ping_days WHERE day < '2026-11-16'").run();
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    expect(s.by_version[0]).toMatchObject({ baseline: null, baseline_unavailable_reason: "insufficient_history", spike: false });
    expect(s.by_version[0]!.active_devices).toBe(30);
  });

  it("says when a channel has no previous version", async () => {
    const h = harness();
    h.build("2.0.0", 20000001);
    h.pings("alpha", 20000001, "2026-11-01", DAY, 12);
    for (let i = 0; i < 3; i++) h.kill({ channel: "alpha", versionName: "2.0.0", code: 20000001, device: `a-${i}`, at: window.startMs + i });
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    expect(s.by_version[0]).toMatchObject({ channel: "alpha", active_devices: 12, baseline: null, baseline_unavailable_reason: "no_previous_version" });
  });

  it("flags only with enough devices and reports on both sides", () => {
    const baseline = { version_name: "1", version_codes: [1], window_start_day: "a", window_end_day: "b", count: 7, active_device_days: 70, rate: 0.1 };
    const ok = { active_devices: 10, count_excluding_cleanup: 10, kills_per_active_device: 1 };
    expect(backgroundSystemKillSpike(ok, baseline)).toBe(true);
    expect(backgroundSystemKillSpike({ ...ok, active_devices: 9 }, baseline)).toBe(false);
    expect(backgroundSystemKillSpike({ ...ok, count_excluding_cleanup: 9 }, baseline)).toBe(false);
    expect(backgroundSystemKillSpike(ok, { ...baseline, active_device_days: 69 })).toBe(false);
    expect(backgroundSystemKillSpike({ ...ok, kills_per_active_device: 0.19 }, baseline)).toBe(false);
    expect(backgroundSystemKillSpike({ ...ok, kills_per_active_device: 0.2 }, baseline)).toBe(true);
    expect(backgroundSystemKillSpike(ok, { ...baseline, count: 0, rate: 0 })).toBe(false);
    expect(backgroundSystemKillSpike(ok, null)).toBe(false);
  });
});
