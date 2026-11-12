import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { exportPKCS8, generateKeyPair } from "jose";
import { storeAscCredentials } from "../src/lib/asc_credentials";
import { requireAppRole } from "../src/lib/permissions";
import {
  ASC_ANALYTICS_REPORTS,
  ASC_DAILY_SQL,
  ReportAggregator,
  ingestAscAnalyticsForApp,
  parseTsvStream,
  pollAscAnalytics,
  queryAscAnalyticsDaily,
  SCHEDULED_BUDGET,
  segmentUrlHost,
  type IngestBudget,
} from "../src/lib/asc_analytics_ingest";
import { handleIngestAscAnalytics } from "../src/routes/asc_analytics_requests";
import { handleAppStats } from "../src/routes/stats";

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const ASC = "https://api.appstoreconnect.apple.com";
const ASC_ORIGIN = new URL(ASC).origin;
const isAsc = (input: unknown) => new URL(String(input)).origin === ASC_ORIGIN;
const SEG = "https://analytics-segments.apple.com/seg";
const BUDGET: IngestBudget = { ...SCHEDULED_BUDGET, maxInstances: 20 };

let p8: string;
beforeAll(async () => {
  p8 = await exportPKCS8((await generateKeyPair("ES256", { extractable: true })).privateKey);
});
afterEach(() => vi.restoreAllMocks());

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_m, index) => { indexes.push(Number(index)); return "?"; }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      const run = () => ({ success: true, meta: { changes: statement.reader ? 0 : statement.run(...expanded).changes } });
      return {
        exec: run,
        run: async () => run(),
        all: async () => ({ success: true, results: statement.all(...expanded) }),
        first: async (column?: string) => {
          const row = statement.get(...expanded) as Record<string, unknown> | undefined;
          return column ? row?.[column] ?? null : row ?? null;
        },
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  const batch = async (statements: Array<{ exec: () => unknown }>) => sqlite.transaction(() => statements.map((s) => s.exec()))();
  return { prepare, batch } as unknown as D1Database;
}

async function harness(opts: { role?: "admin" | "publisher"; bundleId?: string | null } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  const now = Date.now();
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app', 'raft-ios', 'Raft iOS', 'ios', ?)").run(now);
  sqlite.prepare("INSERT INTO channels (id, app_id, slug, name, bundle_id, created_at) VALUES ('ch', 'app', 'main', 'Main', ?, ?)")
    .run(opts.bundleId === undefined ? "build.raft.app" : opts.bundleId, now);
  sqlite.prepare(`INSERT INTO raft_accounts (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
      username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
      VALUES ('acct', 'raft', 'acct', 'server', 'test', 'human', 'member', 'acct', 'Acct', NULL, '{}', ?, ?, ?)`).run(now, now, now);
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('m', 'app', 'acct', ?, ?)").run(opts.role ?? "admin", now);
  const env = { DB: d1(sqlite), ENVIRONMENT: "development", ASC_CRED_ENC_KEY: "test-key" } as unknown as Env;
  await storeAscCredentials(env.DB, "test-key", { app_id: "app", key_id: "KEY123", issuer_id: "issuer", p8, actor: "raft:acct@test" });
  const app = new Hono<{ Bindings: Env; Variables: { admin_account: any; admin_actor: string } }>();
  app.use("*", async (c, next) => {
    c.set("admin_account", { id: "acct", provider: "raft", provider_subject: "acct", server_id: "server", server_slug: "test",
      principal_type: "human", server_role: "member", username: "acct", display_name: "Acct", avatar_url: null, raw_profile: "{}",
      created_at: 1, updated_at: 1, last_login_at: 1 });
    c.set("admin_actor", "raft:acct@test");
    await next();
  });
  app.post("/api/apps/:appId/stats/app-store/ingest", requireAppRole("admin"), handleIngestAscAnalytics as any);
  app.get("/api/apps/:appId/stats", requireAppRole("viewer"), handleAppStats as any);
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const call = (path: string, method = "GET") => app.fetch(new Request(`https://hands.test${path}`, { method }), env, ctx);
  return { sqlite, env, call };
}

const tsv = (rows: string[][]) => rows.map((r) => r.join("\t")).join("\n") + "\n";
const DL_HEADER = ["Date", "App Name", "App Apple Identifier", "Download Type", "App Version", "Device", "Platform Version", "Source Type", "Territory", "Counts"];
const downloads = tsv([
  DL_HEADER,
  ["2026-11-10", "Raft", "1", "First-time download", "1.0", "iPhone", "iOS 26", "App Store search", "US", "5"],
  ["2026-11-10", "Raft", "1", "First-time download", "1.0", "iPad", "iOS 26", "App Store browse", "US", "2"],
  ["2026-11-10", "Raft", "1", "Redownload", "1.0", "iPhone", "iOS 26", "App Store search", "JP", "3"],
  ["2026-11-10", "Raft", "1", "Auto-update", "1.0", "iPhone", "iOS 26", "App Store search", "US", "40"],
]);
const installs = tsv([
  ["Date", "App Name", "App Apple Identifier", "Event", "Download Type", "App Version", "Territory", "Counts", "Unique Devices"],
  ["2026-11-10", "Raft", "1", "Install", "First-time download", "1.0", "US", "6", "6"],
  ["2026-11-10", "Raft", "1", "Delete", "", "1.0", "US", "1", "1"],
]);
const SESS_HEADER = ["Date", "App Name", "App Apple Identifier", "App Version", "Device", "Territory", "Sessions", "Total Session Duration", "Unique Devices"];
const sessionsA = tsv([SESS_HEADER, ["2026-11-10", "Raft", "1", "1.0", "iPhone", "US", "10", "500", "4"]]);
const sessionsB = tsv([SESS_HEADER, ["2026-11-10", "Raft", "1", "1.1", "iPhone", "JP", "5", "100", "2"]]);
const sessionsOlder = tsv([SESS_HEADER, ["2026-11-09", "Raft", "1", "1.0", "iPhone", "US", "8", "300", "3"]]);

type World = {
  requests: string[];
  reports: Record<string, Array<{ id: string; name: string }>>;
  instances: Record<string, Array<{ id: string; processingDate: string }>>;
  segments: Record<string, string[]>;
  files: Record<string, string>;
  redirects?: Record<string, string>;
  /** Per-URL checksum override; default is the MD5 of the served gzip bytes. */
  checksums?: Record<string, string | undefined>;
  /** Per-URL declared sizeInBytes override (default 1). */
  sizes?: Record<string, number>;
};
const gz = (text: string) => gzipSync(Buffer.from(text));
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

function world(): World {
  return {
    requests: ["req-ongoing", "req-snapshot"],
    reports: {
      "req-ongoing": [
        { id: "r-crash", name: "App Crashes" },
        { id: "r-dl", name: "App Downloads Standard" },
        { id: "r-inst", name: "App Store Installation and Deletion Standard" },
        { id: "r-sess", name: "App Sessions Standard" },
        { id: "r-sess-detail", name: "App Sessions Detailed" },
      ],
      "req-snapshot": [{ id: "r-snap-sess", name: "App Sessions Standard" }],
    },
    instances: {
      "r-dl": [{ id: "i-dl", processingDate: "2026-11-10" }],
      "r-inst": [{ id: "i-inst", processingDate: "2026-11-10" }],
      "r-sess": [{ id: "i-sess", processingDate: "2026-11-10" }],
      // The snapshot repeats 2026-11-10 (must not double count) and adds 2026-11-09.
      "r-snap-sess": [{ id: "i-snap-10", processingDate: "2026-11-10" }, { id: "i-snap-09", processingDate: "2026-11-09" }],
    },
    segments: {
      "i-dl": [`${SEG}/dl.gz?X-Amz-Signature=secret`],
      "i-inst": [`${SEG}/inst.gz?X-Amz-Signature=secret`],
      "i-sess": [`${SEG}/sess-a.gz?sig=1`, `${SEG}/sess-b.gz?sig=1`],
      "i-snap-10": [`${SEG}/snap-a.gz?sig=1`, `${SEG}/snap-b.gz?sig=1`],
      "i-snap-09": [`${SEG}/snap-09.gz?sig=1`],
    },
    files: {
      [`${SEG}/dl.gz?X-Amz-Signature=secret`]: downloads,
      [`${SEG}/inst.gz?X-Amz-Signature=secret`]: installs,
      [`${SEG}/sess-a.gz?sig=1`]: sessionsA,
      [`${SEG}/sess-b.gz?sig=1`]: sessionsB,
      [`${SEG}/snap-a.gz?sig=1`]: sessionsA,
      [`${SEG}/snap-b.gz?sig=1`]: sessionsB,
      [`${SEG}/snap-09.gz?sig=1`]: sessionsOlder,
    },
  };
}

/** Serves every collection one item per page so links.next is always exercised. */
function apple(w: World) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const href = String(input);
    const url = new URL(href);
    if (url.origin === ASC_ORIGIN) {
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
      const page = <T,>(items: T[], map: (t: T) => unknown) => {
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        const next = new URL(href);
        next.searchParams.set("cursor", String(cursor + 1));
        return Response.json({
          data: items.slice(cursor, cursor + 1).map(map),
          links: cursor + 1 < items.length ? { next: next.toString() } : {},
        });
      };
      const p = url.pathname;
      if (p === "/v1/apps") return Response.json({ data: [{ id: "asc-app", attributes: { bundleId: "build.raft.app" } }] });
      if (p === "/v1/apps/asc-app/analyticsReportRequests") return page(w.requests, (id) => ({ id, attributes: {} }));
      let m = p.match(/^\/v1\/analyticsReportRequests\/([^/]+)\/reports$/);
      if (m) {
        expect(url.searchParams.get("filter[category]")).toContain("APP_USAGE");
        return page(w.reports[m[1]!] ?? [], (r) => ({ id: r.id, attributes: { name: r.name } }));
      }
      m = p.match(/^\/v1\/analyticsReports\/([^/]+)\/instances$/);
      if (m) {
        expect(url.searchParams.get("filter[granularity]")).toBe("DAILY");
        return page(w.instances[m[1]!] ?? [], (i) => ({ id: i.id, attributes: { granularity: "DAILY", processingDate: i.processingDate } }));
      }
      m = p.match(/^\/v1\/analyticsReportInstances\/([^/]+)\/segments$/);
      if (m) return page(w.segments[m[1]!] ?? [], (u) => ({ id: `seg-${u}`, attributes: {
        url: u,
        checksum: w.checksums && u in w.checksums ? w.checksums[u] : w.files[u] === undefined ? "0".repeat(32) : md5(gz(w.files[u]!)),
        sizeInBytes: w.sizes?.[u] ?? 1 } }));
      throw new Error(`unexpected ASC call ${p}`);
    }
    const redirect = w.redirects?.[href];
    if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
    const file = w.files[href];
    if (file === undefined) return new Response("missing", { status: 404 });
    return new Response(gz(file), { status: 200 });
  });
}
const segmentCalls = (fetch: ReturnType<typeof apple>) =>
  fetch.mock.calls.filter(([input]) => !isAsc(input));
const dailyRows = (sqlite: Database.Database) => [
  sqlite.prepare("SELECT instance_id, date, metric, dimension_key, value FROM asc_analytics_daily ORDER BY instance_id, date, metric, dimension_key").all(),
  sqlite.prepare("SELECT instance_id, date, metric, value FROM asc_analytics_daily_totals ORDER BY instance_id, date, metric").all(),
];

describe("App Store analytics ingest", () => {
  it("ingests the whole chain, keeps first-time and redownloads apart, and never double counts overlapping instances", async () => {
    const h = await harness();
    const fetch = apple(world());
    const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    expect(summary).toMatchObject({ status: "ok", asc_app_id: "asc-app", requests: 2, instances_seen: 5, instances_processed: 5, instances_failed: [] });
    expect(summary.reports_matched.map((r) => r.name).sort()).toEqual([
      "App Downloads Standard", "App Sessions Standard", "App Sessions Standard", "App Store Installation and Deletion Standard"]);

    const result = await queryAscAnalyticsDaily(h.env.DB, "app", "2026-11-01");
    expect(result.daily).toEqual([
      { date: "2026-11-09", downloads_first_time: null, downloads_redownload: null, installations: null, deletions: null, sessions: 8, active_devices: 3 },
      { date: "2026-11-10", downloads_first_time: 7, downloads_redownload: 3, installations: 6, deletions: 1, sessions: 15, active_devices: 6 },
    ]);
    expect(result.totals).toEqual({ downloads_first_time: 7, downloads_redownload: 3, installations: 6, deletions: 1, sessions: 23, active_devices_peak_daily: 6 });
    expect(result.ingest.instances_processed).toBe(5);
    expect(result.note).toMatch(/agreed to share analytics/);
    // The totals the stats read uses equal the territory rows summed, per instance.
    expect(h.sqlite.prepare("SELECT instance_id, date, metric, value FROM asc_analytics_daily_totals ORDER BY 1, 2, 3").all())
      .toEqual(h.sqlite.prepare(`SELECT instance_id, date, metric, SUM(value) AS value FROM asc_analytics_daily
        GROUP BY instance_id, date, metric ORDER BY 1, 2, 3`).all());
    // Territory is kept as the dimension.
    expect(h.sqlite.prepare("SELECT dimension_key, value FROM asc_analytics_daily WHERE instance_id='i-sess' AND metric='sessions' ORDER BY dimension_key").all())
      .toEqual([{ dimension_key: "JP", value: 5 }, { dimension_key: "US", value: 10 }]);

    // The pre-signed URL never receives the ASC JWT.
    expect(segmentCalls(fetch)).toHaveLength(7);
    for (const [input, init] of segmentCalls(fetch)) {
      expect(new URL(String(input)).hostname).toBe("analytics-segments.apple.com");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.redirect).toBe("manual");
    }
  });

  it("is idempotent: a second run downloads nothing and adds nothing", async () => {
    const h = await harness();
    apple(world());
    await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    const before = dailyRows(h.sqlite);
    vi.restoreAllMocks();
    const fetch = apple(world());
    const again = await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    expect(again).toMatchObject({ instances_processed: 0, instances_already_processed: 5, rows_written: 0 });
    expect(segmentCalls(fetch)).toHaveLength(0);
    expect(dailyRows(h.sqlite)).toEqual(before);
    expect((await queryAscAnalyticsDaily(h.env.DB, "app", "2026-11-01")).totals.sessions).toBe(23);
  });

  it("re-ingesting an instance (lost processed marker, overlapping run) replaces its rows instead of adding", async () => {
    const h = await harness();
    apple(world());
    await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    const before = dailyRows(h.sqlite);
    h.sqlite.prepare("DELETE FROM asc_analytics_instances WHERE instance_id IN ('i-dl', 'i-sess')").run();
    const again = await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    expect(again.instances_processed).toBe(2);
    expect(dailyRows(h.sqlite)).toEqual(before);
  });

  it("respects the instance budget, newest first, and reports more pending", async () => {
    const h = await harness();
    apple(world());
    const first = await ingestAscAnalyticsForApp(h.env, "app", { ...BUDGET, maxInstances: 2 });
    expect(first).toMatchObject({ instances_processed: 2, more_pending: true });
    const ids = h.sqlite.prepare("SELECT processing_date FROM asc_analytics_instances").all() as Array<{ processing_date: string }>;
    expect(ids.every((r) => r.processing_date === "2026-11-10")).toBe(true);
    const rest = await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    expect(rest).toMatchObject({ instances_processed: 3, more_pending: false });
  });

  it("records a missing column as a warning and still ingests the columns that exist", async () => {
    const h = await harness();
    const w = world();
    const noDevices = tsv([["Date", "App Version", "Territory", "Sessions"], ["2026-11-10", "1.0", "US", "10"]]);
    w.requests = ["req-ongoing"];
    w.reports["req-ongoing"] = [{ id: "r-sess", name: "App Sessions Standard" }];
    w.segments["i-sess"] = [`${SEG}/nodev.gz`];
    w.files[`${SEG}/nodev.gz`] = noDevices;
    apple(w);
    const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    expect(summary.warnings).toEqual([
      { instance_id: "i-sess", report_name: "App Sessions Standard", code: "missing_column", column: "Unique Devices", metric: "active_devices" }]);
    const result = await queryAscAnalyticsDaily(h.env.DB, "app", "2026-11-01");
    expect(result.daily).toEqual([expect.objectContaining({ date: "2026-11-10", sessions: 10, active_devices: null })]);
    expect(result.ingest.warnings).toEqual([expect.objectContaining({ code: "missing_column", column: "Unique Devices" })]);
  });

  it("rejects a segment URL outside Apple hosts without fetching it or marking the instance complete", async () => {
    const h = await harness();
    const w = world();
    w.requests = ["req-ongoing"];
    w.reports["req-ongoing"] = [{ id: "r-dl", name: "App Downloads Standard" }];
    w.segments["i-dl"] = ["https://reports.apple.com.evil.example/dl.gz?sig=1"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = apple(w);
    const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    expect(summary.instances_failed).toEqual([{ instance_id: "i-dl", code: "segment_host_not_allowed" }]);
    expect(segmentCalls(fetch)).toHaveLength(0);
    // Recorded as a failed attempt (no rows), retried only after the back-off.
    expect(h.sqlite.prepare("SELECT status, attempts, last_error FROM asc_analytics_instances").all())
      .toEqual([{ status: "failed", attempts: 1, last_error: "segment_host_not_allowed" }]);
    expect(h.sqlite.prepare("SELECT count(*) n FROM asc_analytics_daily").get()).toEqual({ n: 0 });
    // The log names the host and identifiers only, never the signed URL.
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("reports.apple.com.evil.example");
    expect(logged).not.toContain("sig=1");
  });

  it("does not follow a redirect off Apple hosts", async () => {
    const h = await harness();
    const w = world();
    w.requests = ["req-ongoing"];
    w.reports["req-ongoing"] = [{ id: "r-dl", name: "App Downloads Standard" }];
    w.redirects = { [`${SEG}/dl.gz?X-Amz-Signature=secret`]: "https://attacker.example/steal" };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = apple(w);
    const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    expect(summary.instances_failed).toEqual([{ instance_id: "i-dl", code: "segment_host_not_allowed" }]);
    expect(segmentCalls(fetch).map(([u]) => new URL(String(u)).hostname)).toEqual(["analytics-segments.apple.com"]);
  });

  it("allows only https Apple hosts for segments", () => {
    expect(segmentUrlHost("https://analytics.apple.com/x?sig=1").ok).toBe(true);
    expect(segmentUrlHost("https://apple.com/x").ok).toBe(true);
    for (const bad of ["http://analytics.apple.com/x", "https://apple.com.evil.example/x", "https://evilapple.com/x",
      "https://user:pw@analytics.apple.com/x", "https://analytics.apple.com:8443/x", "not a url"]) {
      expect(segmentUrlHost(bad).ok).toBe(false);
    }
  });
});

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 12);
function sessionsOnly(file: string): World {
  const w = world();
  w.requests = ["req-ongoing"];
  w.reports["req-ongoing"] = [{ id: "r-sess", name: "App Sessions Standard" }];
  w.segments["i-sess"] = [`${SEG}/one.gz`];
  w.files[`${SEG}/one.gz`] = file;
  return w;
}
const instanceRow = (sqlite: Database.Database, id: string) =>
  sqlite.prepare("SELECT status, attempts, last_error, next_attempt_at FROM asc_analytics_instances WHERE instance_id = ?").get(id);

describe("incomplete and failed instances stay retryable, with back-off", () => {
  it("a missing required column leaves the instance retryable and a fixed report completes it", async () => {
    const h = await harness();
    let fetch = apple(sessionsOnly(tsv([["Date", "Territory", "Sessions"], ["2026-11-10", "US", "10"]])));
    const first = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0);
    expect(first).toMatchObject({ instances_processed: 0, instances_incomplete: [{ instance_id: "i-sess", code: "missing_column:Unique Devices" }] });
    expect(instanceRow(h.sqlite, "i-sess")).toEqual({ status: "incomplete", attempts: 1, last_error: "missing_column:Unique Devices", next_attempt_at: T0 + 6 * HOUR });
    // Partial data stays visible with its warning.
    expect((await queryAscAnalyticsDaily(h.env.DB, "app", "2026-11-01")).ingest).toMatchObject({ instances_processed: 0, instances_incomplete: 1 });

    // Within the back-off: not downloaded again, not counted against the budget.
    vi.restoreAllMocks();
    fetch = apple(sessionsOnly(tsv([SESS_HEADER, ["2026-11-10", "Raft", "1", "1.0", "iPhone", "US", "10", "500", "4"]])));
    const early = await ingestAscAnalyticsForApp(h.env, "app", { ...BUDGET, maxInstances: 1 }, T0 + 5 * HOUR);
    expect(early).toMatchObject({ instances_deferred: 1, instances_processed: 0, more_pending: false });
    expect(segmentCalls(fetch)).toHaveLength(0);

    // After the back-off the (now complete) report is re-ingested and replaces the partial rows.
    const later = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0 + 6 * HOUR + 1);
    expect(later).toMatchObject({ instances_processed: 1, instances_incomplete: [] });
    expect(instanceRow(h.sqlite, "i-sess")).toEqual({ status: "complete", attempts: 2, last_error: null, next_attempt_at: null });
    expect((await queryAscAnalyticsDaily(h.env.DB, "app", "2026-11-01")).daily)
      .toEqual([expect.objectContaining({ date: "2026-11-10", sessions: 10, active_devices: 4 })]);

    // Complete is final: never read again, even long after.
    const after = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0 + 100 * HOUR);
    expect(after).toMatchObject({ instances_already_processed: 1, instances_processed: 0 });
  });

  it("an unrecognised classifier value keeps the instance retryable", async () => {
    const h = await harness();
    const w = world();
    w.requests = ["req-ongoing"];
    w.reports["req-ongoing"] = [{ id: "r-dl", name: "App Downloads Standard" }];
    w.files[`${SEG}/dl.gz?X-Amz-Signature=secret`] = tsv([DL_HEADER,
      ["2026-11-10", "Raft", "1", "First-time download", "1.0", "iPhone", "iOS 26", "Search", "US", "5"],
      ["2026-11-10", "Raft", "1", "Gifted download", "1.0", "iPhone", "iOS 26", "Search", "US", "2"]]);
    apple(w);
    const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0);
    expect(summary.instances_incomplete).toEqual([{ instance_id: "i-dl", code: "unmapped_value:Download Type" }]);
    expect(instanceRow(h.sqlite, "i-dl")).toMatchObject({ status: "incomplete" });
  });

  it("a missing Territory column only drops the breakdown and completes", async () => {
    const h = await harness();
    apple(sessionsOnly(tsv([["Date", "Sessions", "Unique Devices"], ["2026-11-10", "4", "2"]])));
    const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0);
    expect(summary).toMatchObject({ instances_processed: 1, instances_incomplete: [] });
    expect(summary.warnings).toEqual([expect.objectContaining({ code: "missing_column", column: "Territory" })]);
    expect(instanceRow(h.sqlite, "i-sess")).toMatchObject({ status: "complete" });
  });

  it("a failed instance is retried only after the back-off, with attempts counted", async () => {
    const h = await harness();
    const w = sessionsOnly(sessionsA);
    w.segments["i-sess"] = ["https://evil.example/one.gz"];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apple(w);
    await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0);
    expect(instanceRow(h.sqlite, "i-sess")).toEqual({ status: "failed", attempts: 1, last_error: "segment_host_not_allowed", next_attempt_at: T0 + 6 * HOUR });
    const early = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0 + HOUR);
    expect(early).toMatchObject({ instances_deferred: 1, instances_failed: [] });
    const later = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0 + 6 * HOUR + 1);
    expect(later.instances_failed).toEqual([{ instance_id: "i-sess", code: "segment_host_not_allowed" }]);
    expect(instanceRow(h.sqlite, "i-sess")).toMatchObject({ status: "failed", attempts: 2 });
    expect((await queryAscAnalyticsDaily(h.env.DB, "app", "2026-11-01")).ingest).toMatchObject({ instances_failed: 1, instances_processed: 0 });
  });
});

describe("segment checksum", () => {
  const url = `${SEG}/one.gz`;
  it("rejects a segment whose MD5 does not match and writes nothing", async () => {
    const h = await harness();
    const w = sessionsOnly(sessionsA);
    w.checksums = { [url]: md5(gz(sessionsB)) };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apple(w);
    const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0);
    expect(summary.instances_failed).toEqual([{ instance_id: "i-sess", code: "segment_checksum_mismatch" }]);
    expect(h.sqlite.prepare("SELECT count(*) n FROM asc_analytics_daily").get()).toEqual({ n: 0 });
  });

  it("accepts a matching MD5 in any case and a matching SHA-256", async () => {
    for (const checksum of [md5(gz(sessionsA)).toUpperCase(), createHash("sha256").update(gz(sessionsA)).digest("hex")]) {
      const h = await harness();
      const w = sessionsOnly(sessionsA);
      w.checksums = { [url]: checksum };
      apple(w);
      const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0);
      expect(summary).toMatchObject({ instances_processed: 1, instances_failed: [], warnings: [] });
      vi.restoreAllMocks();
    }
  });

  it("records a warning, never a silent pass, when the checksum is absent or of an unknown format", async () => {
    for (const [checksum, code] of [[undefined, "checksum_missing"], ["abc==", "checksum_unverified"]] as const) {
      const h = await harness();
      const w = sessionsOnly(sessionsA);
      w.checksums = { [url]: checksum };
      apple(w);
      const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0);
      expect(summary.instances_processed).toBe(1);
      expect(summary.warnings).toEqual([{ instance_id: "i-sess", report_name: "App Sessions Standard", code }]);
      expect((await queryAscAnalyticsDaily(h.env.DB, "app", "2026-11-01")).ingest.warnings).toEqual([expect.objectContaining({ code })]);
      vi.restoreAllMocks();
    }
  });
});

describe("limits and CPU bounds", () => {
  const manySegments = (n: number) => {
    const w = sessionsOnly(sessionsA);
    w.segments["i-sess"] = Array.from({ length: n }, (_, i) => `${SEG}/part-${i}.gz`);
    for (const u of w.segments["i-sess"]!) w.files[u] = sessionsA;
    return w;
  };

  it("ingests an instance with more segments than the old cap of 8", async () => {
    const h = await harness();
    apple(manySegments(12));
    const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0);
    expect(summary).toMatchObject({ instances_processed: 1, instances_over_limit: [] });
    expect((await queryAscAnalyticsDaily(h.env.DB, "app", "2026-11-01")).daily[0]).toMatchObject({ sessions: 120 });
  });

  it("an instance over the segment cap ends over_limit without downloading, and is visible", async () => {
    const h = await harness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = apple(manySegments(51));
    const summary = await ingestAscAnalyticsForApp(h.env, "app", BUDGET, T0);
    expect(summary).toMatchObject({ instances_processed: 0, instances_failed: [], instances_over_limit: [{ instance_id: "i-sess", code: "segment_limit" }] });
    expect(segmentCalls(fetch)).toHaveLength(0);
    expect(instanceRow(h.sqlite, "i-sess")).toEqual({ status: "over_limit", attempts: 1, last_error: "segment_limit", next_attempt_at: T0 + 6 * HOUR });
    expect((await queryAscAnalyticsDaily(h.env.DB, "app", "2026-11-01")).ingest).toMatchObject({ instances_over_limit: 1, instances_failed: 0 });
  });

  it("checks Apple's declared sizes before downloading, and actual bytes while streaming", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const declared = await harness();
    const w = sessionsOnly(sessionsA);
    w.sizes = { [`${SEG}/one.gz`]: 33 * 1024 * 1024 };
    let fetch = apple(w);
    const a = await ingestAscAnalyticsForApp(declared.env, "app", BUDGET, T0);
    expect(a.instances_over_limit).toEqual([{ instance_id: "i-sess", code: "segment_bytes_limit" }]);
    expect(segmentCalls(fetch)).toHaveLength(0);
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const actual = await harness();
    fetch = apple(sessionsOnly(sessionsA));
    const b = await ingestAscAnalyticsForApp(actual.env, "app", { ...BUDGET, maxInstanceBytes: 10 }, T0);
    expect(b.instances_over_limit).toEqual([{ instance_id: "i-sess", code: "segment_bytes_limit" }]);
    expect(actual.sqlite.prepare("SELECT count(*) n FROM asc_analytics_daily").get()).toEqual({ n: 0 });

    const text = await harness();
    const c = await ingestAscAnalyticsForApp(text.env, "app", { ...BUDGET, maxInstanceChars: 20 }, T0);
    expect(c.instances_over_limit).toEqual([{ instance_id: "i-sess", code: "segment_text_limit" }]);
  });

  it("stops taking new instances once the run's text budget is spent", async () => {
    const h = await harness();
    apple(world());
    const summary = await ingestAscAnalyticsForApp(h.env, "app", { ...BUDGET, maxRunChars: 1 }, T0);
    expect(summary).toMatchObject({ instances_processed: 1, more_pending: true });
  });

  it("parses lines split across stream chunks", async () => {
    const agg = new ReportAggregator(ASC_ANALYTICS_REPORTS.find((r) => r.name === "App Sessions Standard")!);
    const text = "Date\tTerritory\tSessions\tUnique Devices\n2026-11-10\tUS\t3\t1\n2026-11-10\tJP\t4\t2\n2026-11-11\tUS\t5\t1";
    const chunks = ["Da", "te\tTerritory\tSess", "ions\tUnique Devices\n2026-11-10\tU", "S\t3\t1\n2026-11-10\tJP\t4\t2\n", "2026-11-11\tUS\t5", "\t1"];
    expect(chunks.join("")).toBe(text);
    await parseTsvStream(new ReadableStream<string>({ start(c) { for (const k of chunks) c.enqueue(k); c.close(); } }), agg);
    expect(Object.fromEntries(agg.values)).toEqual({
      "2026-11-10\tsessions\tUS": 3, "2026-11-10\tactive_devices\tUS": 1, "2026-11-10\tsessions\tJP": 4,
      "2026-11-10\tactive_devices\tJP": 2, "2026-11-11\tsessions\tUS": 5, "2026-11-11\tactive_devices\tUS": 1 });
  });
});

describe("stats read at realistic volume", () => {
  it("picks one instance per (report, date) over 365 days x 150 territories x 3 reports, fast and without a correlated subquery", async () => {
    const h = await harness();
    const reports: Array<[string, string, string]> = [
      ["App Downloads Standard", "downloads_first_time", "downloads_redownload"],
      ["App Store Installation and Deletion Standard", "installations", "deletions"],
      ["App Sessions Standard", "sessions", "active_devices"],
    ];
    const day = (i: number) => new Date(Date.UTC(2025, 10, 11) + i * 86_400_000).toISOString().slice(0, 10);
    const territories = Array.from({ length: 150 }, (_, i) => `T${i}`);
    const insert = h.sqlite.prepare(`INSERT INTO asc_analytics_daily
      (app_id, instance_id, report_name, processing_date, date, metric, dimension_key, value) VALUES ('app', ?, ?, ?, ?, ?, ?, ?)`);
    h.sqlite.transaction(() => {
      for (let i = 0; i < 365; i++) {
        const date = day(i);
        for (const [name, m1, m2] of reports) {
          // Two overlapping instances per date: an older one (value 1) and a later restatement (value 2).
          for (const [suffix, processing, value] of [["old", date, 1], ["new", day(i + 1), 2]] as const) {
            const id = `${name}-${date}-${suffix}`;
            for (const t of territories) {
              insert.run(id, name, processing, date, m1, t, value);
              insert.run(id, name, processing, date, m2, t, value);
            }
          }
        }
      }
    })();
    expect(h.sqlite.prepare("SELECT count(*) n FROM asc_analytics_daily").get()).toEqual({ n: 365 * 150 * 3 * 2 * 2 });
    // The write path stores per-instance totals alongside the territory rows; derive them the same way.
    h.sqlite.exec(`INSERT INTO asc_analytics_daily_totals (app_id, instance_id, report_name, processing_date, date, metric, value)
      SELECT app_id, instance_id, report_name, processing_date, date, metric, SUM(value) FROM asc_analytics_daily
      GROUP BY app_id, instance_id, report_name, processing_date, date, metric`);
    h.sqlite.exec("ANALYZE");

    const plan = (h.sqlite.prepare(`EXPLAIN QUERY PLAN ${ASC_DAILY_SQL.replace(/\?(\d+)/g, "?")}`).all("app", day(0), "app") as Array<{ detail: string }>)
      .map((r) => r.detail).join("\n");
    expect(plan).not.toMatch(/CORRELATED/);

    const started = performance.now();
    const result = await queryAscAnalyticsDaily(h.env.DB, "app", day(0));
    const elapsed = performance.now() - started;
    console.info(`asc stats read: ${elapsed.toFixed(1)} ms for 365 days\n${plan}`);
    expect(result.daily).toHaveLength(365);
    expect(result.daily.every((d) => d.sessions === 300 && d.downloads_first_time === 300 && d.active_devices === 300)).toBe(true);
    expect(result.totals).toMatchObject({ downloads_first_time: 365 * 300, deletions: 365 * 300, sessions: 365 * 300, active_devices_peak_daily: 300 });
    // Generous bound so CI noise cannot flake; the measured time is printed above.
    expect(elapsed).toBeLessThan(100);

    const window = performance.now();
    await queryAscAnalyticsDaily(h.env.DB, "app", day(365 - 56));
    console.info(`asc stats read: ${(performance.now() - window).toFixed(1)} ms for 56 days`);
  }, 60_000);
});

describe("report column mapping", () => {
  const stream = (text: string) => new ReadableStream<string>({ start(c) { c.enqueue(text); c.close(); } });
  const mapping = (name: string) => ASC_ANALYTICS_REPORTS.find((r) => r.name === name)!;

  it("ignores known update types silently and warns on unknown download types", async () => {
    const agg = new ReportAggregator(mapping("App Downloads Standard"));
    await parseTsvStream(stream(tsv([DL_HEADER.slice(), ["2026-11-10", "", "", "Pre-order", "", "", "", "", "US", "4"],
      ["2026-11-10", "", "", "Restore", "", "", "", "", "US", "9"], ["2026-11-10", "", "", "Redownload", "", "", "", "", "US", "1"]])), agg);
    expect([...agg.values]).toEqual([["2026-11-10\tdownloads_redownload\tUS", 1]]);
    expect(agg.warningList()).toEqual([{ code: "unmapped_value", column: "Download Type", values: ["Pre-order"] }]);
  });

  it("matches headers case-insensitively, tolerates CRLF, and counts bad rows", async () => {
    const agg = new ReportAggregator(mapping("App Store Installation and Deletion Standard"));
    await parseTsvStream(stream("date\tevent\tterritory\tcounts\r\n2026-11-10\tinstall\tUS\t3\r\nbad-date\tInstall\tUS\t1\r\n2026-11-10\tDelete\tUS\tn/a\r\n"), agg);
    expect([...agg.values]).toEqual([["2026-11-10\tinstallations\tUS", 3]]);
    expect(agg.warningList()).toEqual([{ code: "invalid_rows", count: 2 }]);
  });

  it("produces nothing and warns when the classifier or count column is missing", async () => {
    const agg = new ReportAggregator(mapping("App Store Installation and Deletion Standard"));
    await parseTsvStream(stream("Date\tTerritory\tCounts\n2026-11-10\tUS\t3\n"), agg);
    expect(agg.values.size).toBe(0);
    expect(agg.warningList()).toEqual([{ code: "missing_column", column: "Event" }]);
  });

  it("keeps rows without a Territory column under an empty dimension and warns", async () => {
    const agg = new ReportAggregator(mapping("App Sessions Standard"));
    await parseTsvStream(stream("Date\tSessions\tUnique Devices\n2026-11-10\t4\t2\n"), agg);
    expect([...agg.values]).toEqual([["2026-11-10\tsessions\t", 4], ["2026-11-10\tactive_devices\t", 2]]);
    expect(agg.warningList()).toEqual([{ code: "missing_column", column: "Territory" }]);
  });
});

describe("scheduled ingest and routes", () => {
  it("cron ingests one app per tick, each in isolation, and records only error codes", async () => {
    const h = await harness();
    const now = Date.now();
    h.sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('broken', 'broken', 'Broken', 'ios', ?)").run(now);
    await storeAscCredentials(h.env.DB, "test-key", { app_id: "broken", key_id: "K2", issuer_id: "i", p8, actor: "raft:acct@test" });
    apple(world());
    // One app per tick: the first tick only touches "app".
    await pollAscAnalytics(h.env, now);
    expect(h.sqlite.prepare("SELECT app_id FROM asc_analytics_ingest_schedule WHERE last_run_at IS NOT NULL").all()).toEqual([{ app_id: "app" }]);
    await pollAscAnalytics(h.env, now);
    const schedule = h.sqlite.prepare("SELECT app_id, last_error_code, next_run_at FROM asc_analytics_ingest_schedule ORDER BY app_id").all() as
      Array<{ app_id: string; last_error_code: string | null; next_run_at: number }>;
    expect(schedule.map((s) => [s.app_id, s.last_error_code])).toEqual([["app", null], ["broken", "bundle_id_missing"]]);
    expect(h.sqlite.prepare("SELECT count(*) n FROM asc_analytics_instances WHERE app_id='app'").get()).toEqual({ n: 5 });
    expect(schedule.every((s) => s.next_run_at > now)).toBe(true);
    // Not due again: a second tick at the same time does nothing.
    vi.restoreAllMocks();
    const fetch = apple(world());
    await pollAscAnalytics(h.env, now);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("overlapping cron ticks claim each app once", async () => {
    const h = await harness();
    const now = Date.now();
    const fetch = apple(world());
    await Promise.all([pollAscAnalytics(h.env, now), pollAscAnalytics(h.env, now), pollAscAnalytics(h.env, now)]);
    // One run's worth of work: 7 segment downloads and one call resolving the app.
    expect(segmentCalls(fetch)).toHaveLength(7);
    expect(fetch.mock.calls.filter(([u]) => new URL(String(u)).pathname === "/v1/apps")).toHaveLength(1);
    expect(h.sqlite.prepare("SELECT count(*) n FROM asc_analytics_instances WHERE status = 'complete'").get()).toEqual({ n: 5 });
  });

  it("manual ingest is app-admin only", async () => {
    const publisher = await harness({ role: "publisher" });
    const fetch = apple(world());
    expect((await publisher.call("/api/apps/app/stats/app-store/ingest", "POST")).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    const admin = await harness();
    const res = await admin.call("/api/apps/app/stats/app-store/ingest", "POST");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", instances_processed: 5, note: expect.stringMatching(/privacy/) });
  });

  it("GET /stats exposes daily App Store metrics, totals and the privacy note without a live call", async () => {
    const h = await harness();
    apple(world());
    await ingestAscAnalyticsForApp(h.env, "app", BUDGET);
    vi.restoreAllMocks();
    const fetch = vi.spyOn(globalThis, "fetch");
    const res = await h.call("/api/apps/app/stats?window_days=365&live=false");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(fetch).not.toHaveBeenCalled();
    expect(body.stores.app_store.daily.map((d: any) => [d.date, d.sessions])).toEqual([["2026-11-09", 8], ["2026-11-10", 15]]);
    expect(body.stores.app_store.totals).toMatchObject({ downloads_first_time: 7, downloads_redownload: 3, installations: 6, deletions: 1 });
    expect(body.stores.app_store.analytics_note).toMatch(/privacy thresholds/);
    expect(body.stores.app_store.analytics_ingest).toMatchObject({ instances_processed: 5 });
  });
});
