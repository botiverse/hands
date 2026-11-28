import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildBackgroundSystemKillDailySummary,
  backgroundSystemKillDistribution,
  backgroundSystemKillSpike,
} from "../src/routes/feedback";

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
  const buildIds = new Map<number, string>();
  const build = (versionName: string, versionCode: number) => {
    n += 1;
    buildIds.set(versionCode, `b${n}`);
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
          "INSERT OR IGNORE INTO device_version_days (app_id, day, channel, version_code, device_id) VALUES ('app', ?, ?, ?, ?)",
        ).run(d, channel, code, `${prefix}-${i}`);
      }
    }
  };
  const kill = (o: { channel: string | null; versionName: string; code: number; device: string; at: number; ruleId?: string; exitAt?: number; description?: string }) => {
    n += 1;
    const metadata: Record<string, unknown> = { crash_type: "system_kill", crash_exit_reason_code: 13, crash_exit_importance: 400 };
    if (o.exitAt !== undefined) metadata.crash_exit_timestamp = o.exitAt;
    if (o.description !== undefined) metadata.crash_exit_description = o.description;
    if (o.ruleId) metadata.hands_rule = { id: o.ruleId, name: "rule", action: "close" };
    sqlite.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, closure_reason, message, version_name, version_code, channel, device_id,
                                     metadata_json, signature, created_at, updated_at)
       VALUES (?, 'app', 'crash', 'closed', 'not_planned', 'kill', ?, ?, ?, ?, ?, 'SystemKill@background', ?, ?)`,
    ).run(`t${n}`, o.versionName, o.code, o.channel, o.device, JSON.stringify(metadata), o.at, o.at);
  };
  /** A rule matching system kills whose exit description is `description`. */
  const rule = (id: string, category: string | null, description = id) => {
    sqlite.prepare(
      `INSERT INTO feedback_rules (id, app_id, name, enabled, action, match_json, created_at, updated_at, category)
       VALUES (?, 'app', ?, 1, 'close', ?, 1, 1, ?)`,
    ).run(id, id, JSON.stringify({ crash_types: ["system_kill"], exit_descriptions: [description] }), category);
  };
  /** A main release of an existing build; `activated` ones were offered by Hands. */
  const release = (code: number, activated: boolean, status = activated ? "superseded" : "draft") => {
    n += 1;
    sqlite.prepare(
      `INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status, activated_at, created_by, created_at, updated_at)
       VALUES (?, 'app', ?, 'ch', 'apk', 'stable', ?, ?, 'test', 1, 1)`,
    ).run(`r${n}`, buildIds.get(code), status, activated ? 1 : null);
  };
  /** Hands main releases (activated) for these codes. */
  const handsMain = (...codes: number[]) => { for (const c of codes) release(c, true); };
  /** What Play's track poll recorded for a version code. */
  const playObserved = (code: number, state = "RELEASE_LIFECYCLE_STATE_PUBLISHED", track = "production") => {
    sqlite.prepare(
      `INSERT INTO google_play_release_observations (app_id, package_name, play_track, version_code, state, revision, nonce, observed_at)
       VALUES ('app', 'build.raft.app', ?, ?, ?, 1, 'n', 1)`,
    ).run(track, code, state);
  };
  const env = { DB: d1(sqlite) } as unknown as Env;
  return { sqlite, env, build, pings, kill, rule, release, handsMain, playObserved };
}

/**
 * Version codes 13000014 (preview) and 13000015/13000016 (main). Here every
 * main code has an activated Hands main release, so main is one Hands row; the
 * Hands/Play split is tested separately.
 */
function release130(h: ReturnType<typeof harness>, { allHandsMain = true } = {}) {
  for (const [name, code] of [["1.29.0", 12900010], ["1.29.0", 12900011], ["1.29.0", 12900012],
    ["1.30.0", 13000014], ["1.30.0", 13000015], ["1.30.0", 13000016]] as const) h.build(name, code);
  if (allHandsMain) h.handsMain(12900011, 12900012, 13000015, 13000016);
  h.pings("main", 12900011, "2026-11-10", "2026-11-25", 10);
  h.pings("main", 12900012, "2026-11-10", "2026-11-25", 10);
  h.pings("preview", 12900010, "2026-11-10", "2026-11-24", 3);
  h.pings("main", 13000015, "2026-11-20", DAY, 15);
  h.pings("main", 13000016, "2026-11-21", DAY, 15);
  h.pings("preview", 13000014, "2026-11-25", DAY, 5);
  // Rules are not applied to background kills at ingest, so these reports carry
  // no hands_rule: the summary matches the user_cleanup rule itself.
  h.rule("swipe", "user_cleanup", "SwipeUpClean");
  h.rule("plain", null);
  // Baseline window for main 1.30.0 (first seen 11-20): 11-13..11-19, 20 devices a day on 1.29.0.
  for (let i = 0; i < 14; i++) {
    h.kill({ channel: "main", versionName: "1.29.0", code: 12900011, device: `main-12900011-${i % 10}`, at: dayMs("2026-11-13") + i * 3_600_000 * 8 });
  }
  // A cleanup report in the window does not count toward the baseline.
  h.kill({ channel: "main", versionName: "1.29.0", code: 12900011, device: "main-12900011-0", at: dayMs("2026-11-15"), description: "SwipeUpClean" });
  // Preview baseline window (1.30.0 first seen 11-25): 11-18..11-24.
  h.kill({ channel: "preview", versionName: "1.29.0", code: 12900010, device: "preview-12900010-0", at: dayMs("2026-11-20") });
  const t = window.startMs + 3_600_000;
  for (let i = 0; i < 18; i++) {
    h.kill({ channel: "main", versionName: "1.30.0", code: i % 2 ? 13000015 : 13000016, device: `main-13000015-${i % 9}`, at: t + i });
  }
  h.kill({ channel: "main", versionName: "1.30.0", code: 13000015, device: "main-13000015-9", at: t, description: "SwipeUpClean" });
  h.kill({ channel: "main", versionName: "1.30.0", code: 13000015, device: "main-13000015-9", at: t + 1, description: "SwipeUpClean" });
  // Closed by a rule without a category: still an ordinary report.
  h.kill({ channel: "main", versionName: "1.30.0", code: 13000016, device: "main-13000016-0", at: t, ruleId: "plain", description: "plain" });
  for (let i = 0; i < 3; i++) h.kill({ channel: "preview", versionName: "1.30.0", code: 13000014, device: `preview-13000014-${i}`, at: t + i });
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
    expect(main.distribution).toBe("hands");
    // Over twice the baseline, but Hands main flags are held until its baseline is checked.
    expect(backgroundSystemKillSpike(main, main.baseline)).toBe(true);
    expect(main).toMatchObject({ spike: false, spike_held: true });

    // Preview is compared with preview 1.29.0. Its rate is far higher, but 5
    // active devices and 3 reports are too few to flag.
    const preview = s.by_version[1]!;
    expect(preview).toMatchObject({ version_codes: [13000014], count: 3, active_devices: 5 });
    expect(preview.baseline).toMatchObject({ version_name: "1.29.0", version_codes: [12900010], count: 1, active_device_days: 21 });
    expect(preview).toMatchObject({ distribution: null, spike: false, spike_held: false });
  });

  it("splits main by verifiable distribution records and keeps every report in exactly one row", async () => {
    const h = harness();
    release130(h, { allHandsMain: false });
    // 1.29.0: 12900011 Hands main, 12900012 Play. 1.30.0: 13000015 Hands main
    // (Play's build gets a main release that stays a draft), 13000016 Play.
    h.handsMain(12900011, 13000015);
    h.release(13000016, false);
    h.playObserved(12900012);
    h.playObserved(13000016);
    h.playObserved(13000016, "RELEASE_LIFECYCLE_STATE_PUBLISHED", "internal");
    // Both records: unconfirmed. Play only in review: no Play record, so unconfirmed.
    h.build("1.30.0", 13000017);
    h.handsMain(13000017);
    h.playObserved(13000017);
    h.build("1.30.0", 13000018);
    h.playObserved(13000018, "RELEASE_LIFECYCLE_STATE_IN_REVIEW");
    h.pings("main", 13000017, "2026-11-21", DAY, 4);
    h.pings("main", 13000018, "2026-11-21", DAY, 4);
    const t = window.startMs + 7_200_000;
    h.kill({ channel: "main", versionName: "1.30.0", code: 13000017, device: "main-13000017-0", at: t });
    h.kill({ channel: "main", versionName: "1.30.0", code: 13000018, device: "main-13000018-0", at: t });
    h.kill({ channel: "main", versionName: "1.30.0", code: 13000018, device: "main-13000018-1", at: t, description: "SwipeUpClean" });
    // A device seen on both Hands and Play rows is one device in the total.
    h.kill({ channel: "main", versionName: "1.30.0", code: 13000016, device: "main-13000015-0", at: t + 1 });

    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    expect(s.by_version.map((r) => [r.channel, r.distribution, r.version_codes])).toEqual([
      ["main", "hands", [13000015]],
      ["main", "play", [13000016]],
      ["main", "unconfirmed", [13000017, 13000018]],
      ["preview", null, [13000014]],
    ]);
    // Events add up, raw and excluding cleanup; devices are deduplicated in the total only.
    const sum = (k: "count" | "count_excluding_cleanup" | "user_cleanup_count") => s.by_version.reduce((a, r) => a + r[k], 0);
    expect(s.total_count).toBe(28);
    expect(sum("count")).toBe(s.total_count);
    expect(sum("count_excluding_cleanup")).toBe(s.total_count_excluding_cleanup);
    expect(sum("user_cleanup_count")).toBe(s.user_cleanup_count);
    expect(s.user_cleanup_count).toBe(3);
    expect(s.by_version.reduce((a, r) => a + r.device_count, 0)).toBeGreaterThan(s.device_count);

    const [hands, play, unconfirmed] = s.by_version;
    // Hands main: its own codes only, today and in the baseline (12900011, 10 devices a day).
    expect(hands).toMatchObject({
      count: 11, user_cleanup_count: 2, count_excluding_cleanup: 9, active_devices: 15,
      baseline: { version_codes: [12900011], count: 14, active_device_days: 70 },
      spike: false, spike_held: true,
    });
    expect(hands!.kills_per_active_device).toBeCloseTo(9 / 15);
    for (const row of [play!, unconfirmed!]) {
      expect(row).toMatchObject({
        active_devices: null, coverage: null, kills_per_active_device: null, affected_device_share: null,
        rate_unavailable_reason: "distribution_not_comparable", baseline: null,
        baseline_unavailable_reason: "distribution_not_comparable", spike: false, spike_held: false,
      });
    }
    expect(play).toMatchObject({ count: 11, count_excluding_cleanup: 11 });
    expect(unconfirmed).toMatchObject({ count: 3, user_cleanup_count: 1, count_excluding_cleanup: 2 });
  });

  it("classifies a main version code only when exactly one kind of record names it", () => {
    const hands = new Set([1, 3]);
    const play = new Set([2, 3]);
    expect(backgroundSystemKillDistribution("main", 1, hands, play)).toBe("hands");
    expect(backgroundSystemKillDistribution("main", 2, hands, play)).toBe("play");
    expect(backgroundSystemKillDistribution("main", 3, hands, play)).toBe("unconfirmed");
    expect(backgroundSystemKillDistribution("main", 4, hands, play)).toBe("unconfirmed");
    expect(backgroundSystemKillDistribution("main", null, hands, play)).toBe("unconfirmed");
    expect(backgroundSystemKillDistribution("preview", 2, hands, play)).toBeNull();
  });

  it("does not flag when the rate is within twice the baseline", async () => {
    const h = harness();
    release130(h);
    // Forty more baseline reports: 54 / 140 ≈ 0.39, and today's 19 / 30 ≈ 0.63
    // is less than twice that.
    for (let i = 0; i < 40; i++) {
      h.kill({ channel: "main", versionName: "1.29.0", code: 12900012, device: `main-12900012-${i % 10}`, at: dayMs("2026-11-14") + i });
    }
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    expect(s.by_version[0]!.baseline!.count).toBe(54);
    expect(s.by_version[0]!.spike).toBe(false);
  });

  it("gives no rate and no flag without active-device data for the day", async () => {
    const h = harness();
    release130(h);
    h.sqlite.prepare("DELETE FROM device_version_days WHERE day = ?").run(DAY);
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    for (const row of s.by_version) {
      expect(row).toMatchObject({ active_devices: null, kills_per_active_device: null, affected_device_share: null, spike: false });
    }
  });

  it("gives no baseline when the 7 days before the new version predate the ping data", async () => {
    const h = harness();
    release130(h);
    h.sqlite.prepare("DELETE FROM device_version_days WHERE day < '2026-11-16'").run();
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

  it("counts a device that upgraded that day on both versions, and never adds reporters to the denominator", async () => {
    const h = harness();
    release130(h);
    // Five devices used 1.29.0 and then 1.30.0 on main that day; none reported an exit.
    for (let i = 0; i < 5; i++) {
      for (const code of [12900012, 13000015]) {
        h.sqlite.prepare(
          "INSERT INTO device_version_days (app_id, day, channel, version_code, device_id) VALUES ('app', ?, 'main', ?, ?)",
        ).run(DAY, code, `upg-${i}`);
      }
    }
    // An old-version report from a device with no activity record on 1.29.0 that day.
    h.kill({ channel: "main", versionName: "1.29.0", code: 12900012, device: "no-ping", at: window.startMs + 5 });
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    const main130 = s.by_version.find((r) => r.channel === "main" && r.version_name === "1.30.0")!;
    const main129 = s.by_version.find((r) => r.channel === "main" && r.version_name === "1.29.0")!;
    // 30 devices recorded on 1.30.0 plus the 5 that upgraded without reporting an exit.
    expect(main130.active_devices).toBe(35);
    expect(main130.kills_per_active_device).toBeCloseTo(19 / 35);
    // 1.29.0 had only the 5 upgraders that day. The reporter has no record, so it
    // is not added; coverage is 0/1 and there is no rate rather than a made-up one.
    expect(main129).toMatchObject({
      count: 1, active_devices: 5, coverage: { matched: 0, reporters: 1 },
      kills_per_active_device: null, rate_unavailable_reason: "low_coverage", spike: false,
    });
  });

  it("gives no rate and no flag when under 90% of reporting devices have an activity record", async () => {
    const h = harness();
    release130(h);
    // Two more reporting devices with no activity record: 10 of 12 covered.
    for (const d of ["ghost-1", "ghost-2"]) {
      h.kill({ channel: "main", versionName: "1.30.0", code: 13000015, device: d, at: window.startMs + 7 });
    }
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    const main = s.by_version.find((r) => r.channel === "main")!;
    expect(main).toMatchObject({
      active_devices: 30, coverage: { matched: 10, reporters: 12 },
      kills_per_active_device: null, affected_device_share: null, rate_unavailable_reason: "low_coverage", spike: false,
    });
  });

  it("treats a report as user cleanup only through a user_cleanup rule", async () => {
    const h = harness();
    release130(h);
    // Same exit description, but the rule now has no category: counted as ordinary.
    h.sqlite.prepare("UPDATE feedback_rules SET category = NULL WHERE id = 'swipe'").run();
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    expect(s).toMatchObject({ user_cleanup_count: 0, total_count_excluding_cleanup: 24 });
  });

  it("counts a late report on the day the exit happened, not the day it arrived", async () => {
    const h = harness();
    release130(h);
    // Exit on the report day, uploaded two days later: counted.
    h.kill({ channel: "preview", versionName: "1.30.0", code: 13000014, device: "late", at: window.endMs + 2 * DAY_MS, exitAt: window.startMs + 60_000 });
    // Arrived on the report day, but the exit was the day before: not counted.
    h.kill({ channel: "preview", versionName: "1.30.0", code: 13000014, device: "early", at: window.startMs + 60_000, exitAt: window.startMs - 60_000 });
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    const preview = s.by_version.find((r) => r.channel === "preview")!;
    expect(preview).toMatchObject({ count: 4, device_count: 4 });
  });

  it("gives no rate on the first, partial day of activity records", async () => {
    const h = harness();
    h.build("2.0.0", 20000001);
    h.pings("alpha", 20000001, DAY, DAY, 12);
    h.kill({ channel: "alpha", versionName: "2.0.0", code: 20000001, device: "a-0", at: window.startMs });
    const s = (await buildBackgroundSystemKillDailySummary(h.env, "app", window))!.summary;
    expect(s.by_version[0]).toMatchObject({ active_devices: null, kills_per_active_device: null, spike: false });
  });

  it("flags only with enough devices and reports on both sides", () => {
    const baseline = { version_name: "1", version_codes: [1], window_start_day: "a", window_end_day: "b", count: 7, active_device_days: 70, rate: 0.1, coverage: { matched: 7, reporters: 7 } };
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
