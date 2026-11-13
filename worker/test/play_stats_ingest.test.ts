import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { storeGooglePlayBinding, storeGooglePlayReportsGrant } from "../src/lib/google_play_bindings";
import { requireAppRole } from "../src/lib/permissions";
import {
  PLAY_DAILY_SQL,
  PLAY_STATS_SCHEDULED_BUDGET,
  decodeReportBytes,
  ingestGooglePlayStatsForApp,
  normalizePlayStatsBucket,
  parsePlayReport,
  PLAY_STATS_REPORTS,
  playRetryDelay,
  pollGooglePlayStats,
  queryGooglePlayStatsDaily,
  setPlayStatsBucket,
  type PlayStatsBudget,
} from "../src/lib/play_stats_ingest";
import { handleGetPlayStatsBucket, handleIngestPlayStats, handlePutPlayStatsBucket } from "../src/routes/play_stats";
import { handleAppStats } from "../src/routes/stats";
import { createPlayAdapterService } from "../../play-adapter/src/index";

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const PKG = "build.raft.app";
const BUCKET = "pubsite_prod_8345658214806586934";
const REPORTS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const credential = { type: "authorized_user" as const, client_id: "client-id", client_secret: "client-secret-value",
  refresh_token: "refresh-token-secret", client_email: "owner@example.com" };
const BUDGET: PlayStatsBudget = { ...PLAY_STATS_SCHEDULED_BUDGET, maxFiles: 20, maxRunBytes: 64 * 1024 * 1024 };

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

// ---------- A fake Google: OAuth token endpoint and the GCS JSON API ----------

type GcsObject = { bytes: Uint8Array; generation: string; md5?: string | null; contentEncoding?: string };
type Google = {
  objects: Record<string, GcsObject>;
  /** Status to answer listing with (e.g. 403). */
  listStatus?: number;
  /** Status to answer the OAuth token request with (e.g. 400 for a revoked grant). */
  tokenStatus?: number;
  calls: Array<{ method: string; url: string; authorization: string | null; body: string | null }>;
  onRead?: (name: string) => Promise<void>;
};
const md5b64 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("base64");

function googleFetch(g: Google): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    g.calls.push({ method: init.method ?? "GET", url: url.toString(), authorization: headers.get("authorization"),
      body: typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : null });
    expect(init.redirect).toBe("manual");
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      if (g.tokenStatus) return Response.json({ error: "invalid_grant" }, { status: g.tokenStatus });
      return Response.json({ access_token: "gcs-access-token", token_type: "Bearer", expires_in: 3599, scope: REPORTS_SCOPE });
    }
    if (url.origin !== "https://storage.googleapis.com") throw new Error(`unexpected host ${url.host}`);
    expect(headers.get("authorization")).toBe("Bearer gcs-access-token");
    const list = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o$/);
    if (list) {
      if (g.listStatus) return Response.json({ error: { message: "secret provider text" } }, { status: g.listStatus });
      expect(decodeURIComponent(list[1]!)).toBe(BUCKET);
      const prefix = url.searchParams.get("prefix") ?? "";
      const names = Object.keys(g.objects).filter((n) => n.startsWith(prefix)).sort();
      // One object per page, so nextPageToken is always exercised.
      const cursor = Number(url.searchParams.get("pageToken") ?? 0);
      const page = names.slice(cursor, cursor + 1).map((name) => {
        const o = g.objects[name]!;
        return { name, generation: o.generation, size: String(o.bytes.byteLength), updated: "2026-11-12T00:00:00Z",
          ...(o.md5 === null ? {} : { md5Hash: o.md5 ?? md5b64(o.bytes) }), ...(o.contentEncoding ? { contentEncoding: o.contentEncoding } : {}) };
      });
      return Response.json({ ...(page.length ? { items: page } : {}), ...(cursor + 1 < names.length ? { nextPageToken: String(cursor + 1) } : {}) });
    }
    const read = url.pathname.match(/^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/);
    if (read) {
      expect(url.searchParams.get("alt")).toBe("media");
      const name = decodeURIComponent(read[2]!);
      await g.onRead?.(name);
      const o = g.objects[name];
      if (!o || o.generation !== url.searchParams.get("generation")) return new Response("missing", { status: 404 });
      return new Response(o.bytes, { status: 200, headers: { "content-length": String(o.bytes.byteLength) } });
    }
    throw new Error(`unexpected GCS path ${url.pathname}`);
  }) as typeof fetch;
}

/** The real adapter code behind the service binding, talking to the fake Google. */
function adapter(g: Google) {
  const service = createPlayAdapterService({ fetchImpl: googleFetch(g) });
  return {
    listStatsObjects: vi.fn((input: any) => service.listStatsObjects(input)),
    readStatsObject: vi.fn((input: any) => service.readStatsObject(input)),
  } as unknown as GooglePlayAdapterServiceLike;
}
type GooglePlayAdapterServiceLike = NonNullable<Env["PLAY_RELEASE_SERVICE"]>;

// ---------- Report files ----------

const INSTALLS_HEADER = ["Date", "Package Name", "Daily Device Installs", "Daily Device Uninstalls", "Daily Device Upgrades",
  "Total User Installs", "Daily User Installs", "Daily User Uninstalls", "Active Device Installs", "Install events",
  "Update events", "Uninstall events"];
const utf16 = (text: string) => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
const csv = (rows: string[][]) => rows.map((r) => r.map((f) => (/[",]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(",")).join("\r\n") + "\r\n";
/** Day d of month: device installs = base + d, user installs = d, active = 1000 + d. */
function installs(month: string, days: number[], base = 10, header = INSTALLS_HEADER) {
  const rows = days.map((d) => {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const v: Record<string, string> = {
      "Date": date, "Package Name": PKG, "Daily Device Installs": String(base + d), "Daily Device Uninstalls": "1",
      "Daily Device Upgrades": "2", "Total User Installs": String(5000 + d), "Daily User Installs": String(d),
      "Daily User Uninstalls": "1", "Active Device Installs": String(1000 + d), "Install events": String(base + d + 1),
      "Update events": "3", "Uninstall events": "1",
    };
    return header.map((h) => v[h] ?? "");
  });
  return utf16(csv([header, ...rows]));
}
const storePerf = (month: string, days: number[]) => utf16(csv([
  ["Date", "Package Name", "Store listing acquisitions", "Store listing visitors", "Store listing conversion rate"],
  ...days.map((d) => [`${month}-${String(d).padStart(2, "0")}`, PKG, "2", "1,000", "0.20%"]),
]));
const name = (report: string, ym: string, dim = "overview") => `stats/${report}/${report}_${PKG}_${ym}_${dim}.csv`;

function world(): Google {
  return {
    calls: [],
    objects: {
      [name("installs", "202610")]: { bytes: installs("2026-10", [30, 31]), generation: "1761900000000001" },
      [name("installs", "202611")]: { bytes: installs("2026-11", [1, 2, 3]), generation: "1762900000000001" },
      [name("installs", "202611", "country")]: { bytes: utf16("Date,Country\n"), generation: "1762900000000002" },
      [name("store_performance", "202611")]: { bytes: storePerf("2026-11", [1, 2]), generation: "1762900000000003" },
      // Another package in the same developer bucket is never listed for this app.
      [`stats/installs/installs_build.other.app_202611_overview.csv`]: { bytes: installs("2026-11", [1]), generation: "9" },
    },
  };
}

async function harness(opts: { role?: "admin" | "publisher"; bucket?: string | null; service?: GooglePlayAdapterServiceLike | null } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationDir).sort()) if (file.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${file}`, "utf8"));
  const now = Date.now();
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app', 'raft-android', 'Raft Android', 'android', ?)").run(now);
  sqlite.prepare(`INSERT INTO raft_accounts (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
      username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
      VALUES ('acct', 'raft', 'acct', 'server', 'test', 'human', 'member', 'acct', 'Acct', NULL, '{}', ?, ?, ?)`).run(now, now, now);
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('m', 'app', 'acct', ?, ?)").run(opts.role ?? "admin", now);
  const g = world();
  const env = {
    DB: d1(sqlite),
    ENVIRONMENT: "development",
    PLAY_CRED_ENC_KEYS: JSON.stringify({ v1: "test-only-google-play-key-material-1234567890" }),
    PLAY_RELEASE_SERVICE: opts.service === undefined ? adapter(g) : opts.service ?? undefined,
  } as unknown as Env;
  await storeGooglePlayBinding(env.DB, {
    appId: "app", packageName: PKG, tracks: { internal: "internal", closed: "closed", production: "production" },
    credential, actor: "raft:acct@test", keyringJson: env.PLAY_CRED_ENC_KEYS, activeKeyVersion: "v1",
  });
  if (opts.bucket !== null) await setPlayStatsBucket(env.DB, "app", opts.bucket ?? BUCKET, "raft:acct@test");
  const app = new Hono<{ Bindings: Env; Variables: { admin_account: any; admin_actor: string } }>();
  app.use("*", async (c, next) => {
    c.set("admin_account", { id: "acct", provider: "raft", provider_subject: "acct", server_id: "server", server_slug: "test",
      principal_type: "human", server_role: "member", username: "acct", display_name: "Acct", avatar_url: null, raw_profile: "{}",
      created_at: 1, updated_at: 1, last_login_at: 1 });
    c.set("admin_actor", "raft:acct@test");
    await next();
  });
  app.post("/api/apps/:appId/stats/google-play/ingest", requireAppRole("admin"), handleIngestPlayStats as any);
  app.get("/api/apps/:appId/google-play/stats-bucket", requireAppRole("admin"), handleGetPlayStatsBucket as any);
  app.put("/api/apps/:appId/google-play/stats-bucket", requireAppRole("admin"), handlePutPlayStatsBucket as any);
  app.get("/api/apps/:appId/stats", requireAppRole("viewer"), handleAppStats as any);
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const call = (path: string, method = "GET", body?: unknown) => app.fetch(new Request(`https://hands.test${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  }), env, ctx);
  return { sqlite, env, call, g };
}

const totalsRows = (sqlite: Database.Database) =>
  sqlite.prepare("SELECT report_kind, month, date, metric, value FROM google_play_stats_daily_totals ORDER BY date, metric").all();
const reads = (g: Google) => g.calls.filter((c) => c.url.includes("alt=media"));

describe("Google Play statistics ingest", () => {
  it("ingests the full chain through the adapter: paginated listing, UTF-16 overview files, md5 checked, only Google hosts", async () => {
    const h = await harness();
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const summary = await ingestGooglePlayStatsForApp(h.env, "app", BUDGET);
    expect(summary).toMatchObject({ status: "ok", bucket: BUCKET, package_name: PKG, files_seen: 3, files_processed: 3,
      files_failed: [], files_incomplete: [], more_pending: false });

    const result = await queryGooglePlayStatsDaily(h.env.DB, "app", "2026-10-01");
    expect(result.daily.map((d) => [d.date, d.device_installs, d.user_installs, d.active_device_installs, d.store_listing_visitors])).toEqual([
      ["2026-10-30", 40, 30, 1030, null],
      ["2026-10-31", 41, 31, 1031, null],
      ["2026-11-01", 11, 1, 1001, 1000],
      ["2026-11-02", 12, 2, 1002, 1000],
      ["2026-11-03", 13, 3, 1003, null],
    ]);
    expect(result.daily[2]).toEqual({ date: "2026-11-01", device_installs: 11, device_uninstalls: 1, device_upgrades: 2,
      user_installs: 1, user_uninstalls: 1, total_user_installs: 5001, active_device_installs: 1001, install_events: 12,
      update_events: 3, uninstall_events: 1, store_listing_visitors: 1000, store_listing_acquisitions: 2 });
    expect(result.totals).toMatchObject({ device_installs: 117, user_installs: 67, user_uninstalls: 5,
      active_device_installs_latest: 1003, active_device_installs_latest_date: "2026-11-03", total_user_installs_latest: 5003,
      store_listing_visitors: 2000, store_listing_acquisitions: 4, store_listing_conversion_rate: 0.002 });
    expect(result.ingest).toMatchObject({ stats_bucket: BUCKET, files_processed: 3, latest_data_date: "2026-11-03", problems: [] });
    expect(result.note).toMatch(/3 to 7 days/);

    // The Worker itself made no network call; the adapter did, only to Google.
    expect(globalFetch).not.toHaveBeenCalled();
    const hosts = new Set(h.g.calls.map((c) => new URL(c.url).origin));
    expect([...hosts].sort()).toEqual(["https://oauth2.googleapis.com", "https://storage.googleapis.com"]);
    for (const c of h.g.calls) {
      if (new URL(c.url).origin === "https://storage.googleapis.com") {
        expect(c.method).toBe("GET");
        expect(c.authorization).toBe("Bearer gcs-access-token");
      } else {
        // The refresh grant asks for the reports scope only, and carries no bearer token.
        expect(c.authorization).toBeNull();
        const body = new URLSearchParams(c.body ?? "");
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("scope")).toBe(REPORTS_SCOPE);
      }
    }
    // Paginated: 2 installs objects + 1 store performance object, one per page.
    const lists = h.g.calls.filter((c) => /\/o\?/.test(c.url) && !c.url.includes("alt=media"));
    expect(lists.map((c) => new URL(c.url).searchParams.get("pageToken"))).toEqual([null, "1", "2", null]);
    expect(lists.map((c) => new URL(c.url).searchParams.get("prefix"))).toEqual([
      `stats/installs/installs_${PKG}_`, `stats/installs/installs_${PKG}_`, `stats/installs/installs_${PKG}_`,
      `stats/store_performance/store_performance_${PKG}_`]);
    // Only overview files are downloaded (country is listed, not read).
    expect(reads(h.g).map((c) => decodeURIComponent(new URL(c.url).pathname.split("/o/")[1]!)).sort()).toEqual([
      name("installs", "202610"), name("installs", "202611"), name("store_performance", "202611")]);
  });

  it("is idempotent: a second run reads no file and changes nothing", async () => {
    const h = await harness();
    await ingestGooglePlayStatsForApp(h.env, "app", BUDGET);
    const before = totalsRows(h.sqlite);
    h.g.calls.length = 0;
    const again = await ingestGooglePlayStatsForApp(h.env, "app", BUDGET);
    expect(again).toMatchObject({ files_processed: 0, files_already_processed: 3, rows_written: 0 });
    expect(reads(h.g)).toHaveLength(0);
    expect(totalsRows(h.sqlite)).toEqual(before);
  });

  it("a rewritten current-month file (new generation) replaces that month's rows instead of adding to them", async () => {
    const h = await harness();
    await ingestGooglePlayStatsForApp(h.env, "app", BUDGET);
    const october = () => totalsRows(h.sqlite).filter((r: any) => r.month === "2026-10");
    const octoberBefore = october();
    // Google rewrites November: one more day, and day 1 restated with a different value.
    h.g.objects[name("installs", "202611")] = { bytes: installs("2026-11", [1, 2, 3, 4], 100), generation: "1762999999999999" };
    h.g.calls.length = 0;
    const again = await ingestGooglePlayStatsForApp(h.env, "app", BUDGET);
    expect(again).toMatchObject({ files_processed: 1, files_already_processed: 2 });
    expect(reads(h.g)).toHaveLength(1);
    const result = await queryGooglePlayStatsDaily(h.env.DB, "app", "2026-11-01");
    expect(result.daily.map((d) => [d.date, d.device_installs])).toEqual([
      ["2026-11-01", 101], ["2026-11-02", 102], ["2026-11-03", 103], ["2026-11-04", 104]]);
    expect(result.totals.device_installs).toBe(410);
    expect(october()).toEqual(octoberBefore);
    expect(h.sqlite.prepare("SELECT generation, attempts, status FROM google_play_stats_files WHERE object_name = ?").get(name("installs", "202611")))
      .toEqual({ generation: 1762999999999999, attempts: 1, status: "complete" });
  });

  it("an overlapping older run never overwrites a newer generation's rows", async () => {
    const h = await harness();
    const newer = { bytes: installs("2026-11", [1, 2, 3], 500), generation: "1763000000000000" };
    let raced = false;
    // While run A is downloading the old November generation, Google rewrites it and run B ingests the new one.
    h.g.onRead = async (object) => {
      if (raced || object !== name("installs", "202611")) return;
      raced = true;
      const old = h.g.objects[object]!;
      const b = world();
      b.objects[object] = newer;
      await ingestGooglePlayStatsForApp({ ...h.env, PLAY_RELEASE_SERVICE: adapter(b) }, "app", BUDGET);
      h.g.objects[object] = old;
    };
    await ingestGooglePlayStatsForApp(h.env, "app", BUDGET);
    expect(raced).toBe(true);
    const result = await queryGooglePlayStatsDaily(h.env.DB, "app", "2026-11-01");
    expect(result.daily.map((d) => d.device_installs)).toEqual([501, 502, 503]);
    expect(h.sqlite.prepare("SELECT generation FROM google_play_stats_files WHERE object_name = ?").get(name("installs", "202611")))
      .toEqual({ generation: 1763000000000000 });
  });

  it("ingests a gzip-encoded object Cloud Storage serves decompressed, recording that its md5Hash could not be checked", async () => {
    const h = await harness();
    const o = h.g.objects[name("installs", "202611")]!;
    o.md5 = md5b64(new TextEncoder().encode("hash of the stored compressed bytes"));
    o.contentEncoding = "gzip";
    const summary = await ingestGooglePlayStatsForApp(h.env, "app", BUDGET);
    expect(summary.files_failed).toEqual([]);
    expect(summary.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ object_name: name("installs", "202611"), code: "checksum_unverified_transcoded" })]));
    expect(h.sqlite.prepare("SELECT status FROM google_play_stats_files WHERE object_name = ?").get(name("installs", "202611"))).toEqual({ status: "complete" });
  });

  it("still rejects an identity-encoded object whose bytes do not match md5Hash", async () => {
    const h = await harness();
    const o = h.g.objects[name("installs", "202611")]!;
    o.md5 = md5b64(new TextEncoder().encode("x"));
    o.contentEncoding = "identity";
    const summary = await ingestGooglePlayStatsForApp(h.env, "app", BUDGET);
    expect(summary.files_failed).toEqual([{ object_name: name("installs", "202611"), code: "md5_mismatch" }]);
  });

  it("rejects a file whose bytes do not match the listed md5Hash, writes nothing, and retries after the back-off", async () => {
    const h = await harness();
    h.g.objects[name("installs", "202611")]!.md5 = md5b64(new TextEncoder().encode("something else"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = Date.now();
    const summary = await ingestGooglePlayStatsForApp(h.env, "app", BUDGET, now);
    expect(summary.files_failed).toEqual([{ object_name: name("installs", "202611"), code: "md5_mismatch" }]);
    expect(h.sqlite.prepare("SELECT count(*) n FROM google_play_stats_daily_totals WHERE month = '2026-11' AND report_kind = 'installs_overview'").get()).toEqual({ n: 0 });
    expect(h.sqlite.prepare("SELECT status, attempts, last_error, next_attempt_at FROM google_play_stats_files WHERE object_name = ?").get(name("installs", "202611")))
      .toEqual({ status: "failed", attempts: 1, last_error: "md5_mismatch", next_attempt_at: now + playRetryDelay(1) });
    // Not retried before the back-off, retried after it with attempts counted and a longer back-off.
    h.g.calls.length = 0;
    expect(await ingestGooglePlayStatsForApp(h.env, "app", BUDGET, now + 1000)).toMatchObject({ files_deferred: 1, files_processed: 0 });
    expect(reads(h.g)).toHaveLength(0);
    await ingestGooglePlayStatsForApp(h.env, "app", BUDGET, now + playRetryDelay(1) + 1);
    expect(h.sqlite.prepare("SELECT attempts, next_attempt_at FROM google_play_stats_files WHERE object_name = ?").get(name("installs", "202611")))
      .toEqual({ attempts: 2, next_attempt_at: now + playRetryDelay(1) + 1 + playRetryDelay(2) });
    expect(playRetryDelay(2)).toBe(2 * playRetryDelay(1));
    // Logs carry identifiers and codes only.
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("md5_mismatch");
    expect(logged).not.toMatch(/refresh-token-secret|client-secret-value|gcs-access-token|storage\.googleapis/);
  });

  it("a missing column leaves the file incomplete and retryable; a corrected rewrite completes it", async () => {
    const h = await harness();
    const header = INSTALLS_HEADER.filter((c) => c !== "Daily User Installs").map((c) => (c === "Install events" ? "Install Events Renamed" : c));
    h.g.objects[name("installs", "202611")] = { bytes: installs("2026-11", [1, 2], 10, header), generation: "1762900000000001" };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = Date.now();
    const summary = await ingestGooglePlayStatsForApp(h.env, "app", BUDGET, now);
    expect(summary.files_incomplete).toEqual([{ object_name: name("installs", "202611"), code: "missing_column:Daily User Installs" }]);
    expect(summary.warnings.filter((w) => w.object_name === name("installs", "202611"))).toEqual([
      expect.objectContaining({ code: "missing_column", column: "Daily User Installs" }),
      expect.objectContaining({ code: "missing_column", column: "Install events" }),
      expect.objectContaining({ code: "unknown_column", columns: ["Install Events Renamed"] }),
    ]);
    // Columns that exist are written; the missing ones are not guessed.
    let result = await queryGooglePlayStatsDaily(h.env.DB, "app", "2026-11-01");
    expect(result.daily.slice(0, 2).map((d) => [d.device_installs, d.user_installs, d.install_events])).toEqual([[11, null, null], [12, null, null]]);
    expect(result.ingest).toMatchObject({ files_incomplete: 1,
      problems: [{ report_kind: "installs_overview", month: "2026-11", status: "incomplete", last_error: "missing_column:Daily User Installs" }] });
    expect(h.sqlite.prepare("SELECT next_attempt_at FROM google_play_stats_files WHERE object_name = ?").get(name("installs", "202611")))
      .toEqual({ next_attempt_at: now + playRetryDelay(1) });
    // Google fixes the file (new generation): read at once, not after the back-off.
    h.g.objects[name("installs", "202611")] = { bytes: installs("2026-11", [1, 2]), generation: "1762900000000009" };
    const fixed = await ingestGooglePlayStatsForApp(h.env, "app", BUDGET, now + 1000);
    expect(fixed).toMatchObject({ files_processed: 1, files_incomplete: [] });
    result = await queryGooglePlayStatsDaily(h.env.DB, "app", "2026-11-01");
    expect(result.daily.map((d) => d.user_installs)).toEqual([1, 2]);
    expect(result.ingest.files_incomplete).toBe(0);
  });

  it("an oversized file ends over_limit without being downloaded", async () => {
    const h = await harness();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const summary = await ingestGooglePlayStatsForApp(h.env, "app", { ...BUDGET, maxFileBytes: 100 });
    expect(summary.files_over_limit.map((f) => f.code)).toEqual(["file_bytes_limit", "file_bytes_limit", "file_bytes_limit"]);
    expect(reads(h.g)).toHaveLength(0);
    expect((await queryGooglePlayStatsDaily(h.env.DB, "app", "2026-01-01")).ingest.files_over_limit).toBe(3);
  });

  it("respects the per-run file budget, newest month first, and reports more pending", async () => {
    const h = await harness();
    const first = await ingestGooglePlayStatsForApp(h.env, "app", { ...BUDGET, maxFiles: 2 });
    expect(first).toMatchObject({ files_processed: 2, more_pending: true });
    expect(h.sqlite.prepare("SELECT DISTINCT month FROM google_play_stats_files").all()).toEqual([{ month: "2026-11" }]);
    expect(await ingestGooglePlayStatsForApp(h.env, "app", BUDGET)).toMatchObject({ files_processed: 1, more_pending: false });
  });

  it("does not switch buckets on 403/404: records the error and suggests the rev_ form", async () => {
    const h = await harness();
    h.g.listStatus = 403;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await h.call("/api/apps/app/stats/google-play/ingest", "POST");
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body).toMatchObject({ code: "PLAY_STATS_LIST_FAILED", provider_code: "play_reports_bucket_forbidden" });
    expect(body.hint).toMatch(/pubsite_prod_rev_<digits>/);
    expect(JSON.stringify(body)).not.toContain("secret provider text");
    // Every listing went to the configured bucket only.
    for (const c of h.g.calls.filter((c) => new URL(c.url).origin === "https://storage.googleapis.com")) {
      expect(new URL(c.url).pathname).toBe(`/storage/v1/b/${BUCKET}/o`);
    }
    await pollGooglePlayStats(h.env, Date.now());
    const stats = await queryGooglePlayStatsDaily(h.env.DB, "app", "2026-01-01");
    expect(stats.ingest).toMatchObject({ last_error_code: "play_reports_bucket_forbidden", stats_bucket: BUCKET });
    expect(stats.ingest.hint).toMatch(/does not switch buckets/);

    h.g.listStatus = 404;
    await setPlayStatsBucket(h.env.DB, "app", "pubsite_prod_rev_123", "raft:acct@test");
    await pollGooglePlayStats(h.env, Date.now());
    const rev = await queryGooglePlayStatsDaily(h.env.DB, "app", "2026-01-01");
    expect(rev.ingest.last_error_code).toBe("play_reports_bucket_not_found");
    expect(rev.ingest.hint).not.toMatch(/pubsite_prod_rev_<digits>/);
  });

  it("reads with the separate statistics grant when there is one, and names its rejection", async () => {
    const h = await harness();
    await storeGooglePlayReportsGrant(h.env.DB, { appId: "app", credential: { ...credential, refresh_token: "reports-refresh-secret" },
      actor: "raft:acct@test", keyringJson: h.env.PLAY_CRED_ENC_KEYS, activeKeyVersion: "v1" });
    const ok = await h.call("/api/apps/app/stats/google-play/ingest", "POST");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ok", reports_credential: "reports_grant" });
    const tokenBodies = h.g.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/")).map((c) => new URLSearchParams(c.body ?? ""));
    expect(tokenBodies.length).toBeGreaterThan(0);
    for (const body of tokenBodies) expect(body.get("refresh_token")).toBe("reports-refresh-secret");

    h.g.tokenStatus = 400;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rejected = await h.call("/api/apps/app/stats/google-play/ingest", "POST");
    expect(rejected.status).toBe(502);
    const body = await rejected.json() as any;
    expect(body).toMatchObject({ provider_code: "play_reports_token_rejected" });
    expect(body.hint).toMatch(/reauthorize statistics reports/);
    expect(body.hint).toMatch(/publishing is not affected/);
  });

  it("falls back to the publishing credential before a statistics grant exists", async () => {
    const h = await harness();
    const ok = await h.call("/api/apps/app/stats/google-play/ingest", "POST");
    expect(await ok.json()).toMatchObject({ status: "ok", reports_credential: "publishing" });
    const tokenBodies = h.g.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/")).map((c) => new URLSearchParams(c.body ?? ""));
    for (const body of tokenBodies) expect(body.get("refresh_token")).toBe("refresh-token-secret");
  });

  it("reports an adapter without the statistics methods, and a missing bucket, without calling Google", async () => {
    const old = await harness({ service: { listReleaseStates: vi.fn() } as unknown as GooglePlayAdapterServiceLike });
    const res = await old.call("/api/apps/app/stats/google-play/ingest", "POST");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "PLAY_STATS_SERVICE_UNAVAILABLE" });
    const nobucket = await harness({ bucket: null });
    const res2 = await nobucket.call("/api/apps/app/stats/google-play/ingest", "POST");
    expect(res2.status).toBe(409);
    expect(await res2.json()).toMatchObject({ code: "PLAY_STATS_BUCKET_NOT_CONFIGURED" });
    expect(nobucket.g.calls).toHaveLength(0);
  });
});

describe("report decoding and parsing", () => {
  const text = "Date,Package Name\n2026-11-01,x\n";
  it("decodes UTF-16LE (BOM), UTF-16BE (BOM), UTF-8 with and without BOM, and BOM-less UTF-16LE", () => {
    const le = Buffer.from(text, "utf16le");
    const be = Buffer.from(le).swap16();
    expect(decodeReportBytes(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), le])))).toEqual({ text, encoding: "utf-16le" });
    expect(decodeReportBytes(new Uint8Array(Buffer.concat([Buffer.from([0xfe, 0xff]), be])))).toEqual({ text, encoding: "utf-16be" });
    expect(decodeReportBytes(new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])))).toEqual({ text, encoding: "utf-8" });
    expect(decodeReportBytes(new Uint8Array(Buffer.from(text)))).toEqual({ text, encoding: "utf-8" });
    expect(decodeReportBytes(new Uint8Array(le))).toEqual({ text, encoding: "utf-16le" });
    // Non-ASCII survives (UTF-16 surrogate pairs included).
    const intl = "Date,Country\n2026-11-01,Côte d’Ivoire 🇨🇮\n";
    expect(decodeReportBytes(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(intl, "utf16le")]))).text).toBe(intl);
  });

  it("refuses bytes it cannot decode instead of guessing", () => {
    expect(() => decodeReportBytes(new Uint8Array([0xff, 0xfe, 0x41]))).toThrow("decode_failed");
    expect(() => decodeReportBytes(new Uint8Array([0x41, 0xc3, 0x28, 0x42]))).toThrow("decode_failed");
  });

  it("maps columns case-insensitively, handles quoted numbers, and counts rows outside the file's month as invalid", () => {
    const mapping = PLAY_STATS_REPORTS.store_performance_overview;
    const parsed = parsePlayReport([
      "﻿date,PACKAGE NAME,store listing visitors,Store listing acquisitions,Store listing conversion rate",
      `2026-11-01,${PKG},"1,234",5,0.4%`,
      `2026-12-01,${PKG},9,9,1%`,
      `Nov 2 2026,${PKG},9,9,1%`,
      `2026-11-03,${PKG},abc,1,1%`,
      `2026-11-04,${PKG},,1,`,
    ].join("\r\n"), mapping, "2026-11");
    expect([...parsed.values]).toEqual([
      ["2026-11-01\tstore_listing_visitors", 1234], ["2026-11-01\tstore_listing_acquisitions", 5],
      ["2026-11-04\tstore_listing_acquisitions", 1]]);
    expect(parsed.warnings).toEqual([{ code: "invalid_rows", count: 3 }, { code: "empty_values", count: 1 }]);
  });
});

describe("bucket setting", () => {
  it("accepts only Play Console export bucket names", () => {
    expect(normalizePlayStatsBucket("pubsite_prod_8345658214806586934")).toBe("pubsite_prod_8345658214806586934");
    expect(normalizePlayStatsBucket("pubsite_prod_rev_01234567890")).toBe("pubsite_prod_rev_01234567890");
    expect(normalizePlayStatsBucket(" gs://pubsite_prod_rev_42/ ")).toBe("pubsite_prod_rev_42");
    expect(normalizePlayStatsBucket(null)).toBeNull();
    for (const bad of ["pubsite_prod_", "pubsite_prod_rev_", "pubsite_prod_12a", "my-bucket", "pubsite_prod_1/stats",
      "pubsite_prod_rev_1.evil.com", "gs://pubsite_prod_1/stats/installs", "PUBSITE_PROD_1", 42]) {
      expect(() => normalizePlayStatsBucket(bad)).toThrow();
    }
  });

  it("PUT validates, stores, audits, and is app-admin only; publishers get 403", async () => {
    const h = await harness({ bucket: null });
    expect((await h.call("/api/apps/app/google-play/stats-bucket", "PUT", { stats_bucket: "evil-bucket" })).status).toBe(400);
    expect((await h.call("/api/apps/app/google-play/stats-bucket", "PUT", {})).status).toBe(400);
    const ok = await h.call("/api/apps/app/google-play/stats-bucket", "PUT", { stats_bucket: `gs://${BUCKET}` });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ stats_bucket: BUCKET });
    expect(await (await h.call("/api/apps/app/google-play/stats-bucket")).json()).toEqual({ stats_bucket: BUCKET });
    const audit = h.sqlite.prepare("SELECT action, payload FROM audit_logs WHERE action = 'google_play.stats_bucket.update'").get() as any;
    expect(JSON.parse(audit.payload)).toEqual({ previous: null, stats_bucket: BUCKET });
    const cleared = await h.call("/api/apps/app/google-play/stats-bucket", "PUT", { stats_bucket: null });
    expect(await cleared.json()).toEqual({ stats_bucket: null });

    const publisher = await harness({ role: "publisher" });
    expect((await publisher.call("/api/apps/app/google-play/stats-bucket", "PUT", { stats_bucket: BUCKET })).status).toBe(403);
    expect((await publisher.call("/api/apps/app/stats/google-play/ingest", "POST")).status).toBe(403);
    expect(publisher.g.calls).toHaveLength(0);
  });
});

describe("scheduled ingest", () => {
  it("cron ingests one app per tick, claims it once under overlap, and is not due again", async () => {
    const h = await harness();
    const now = Date.now();
    h.sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app2', 'other', 'Other', 'android', ?)").run(now);
    await storeGooglePlayBinding(h.env.DB, { appId: "app2", packageName: "build.other.app",
      tracks: { internal: "internal", closed: "closed", production: "production" }, credential, actor: "raft:acct@test",
      keyringJson: h.env.PLAY_CRED_ENC_KEYS, activeKeyVersion: "v1" });
    await setPlayStatsBucket(h.env.DB, "app2", BUCKET, "raft:acct@test");
    const ran = () => h.sqlite.prepare("SELECT app_id FROM google_play_stats_ingest_schedule WHERE last_run_at IS NOT NULL ORDER BY app_id").all();
    // Three overlapping ticks pick the same due app; it is claimed and ingested once.
    await Promise.all([pollGooglePlayStats(h.env, now), pollGooglePlayStats(h.env, now), pollGooglePlayStats(h.env, now)]);
    expect(ran()).toEqual([{ app_id: "app" }]);
    expect(reads(h.g).filter((c) => c.url.includes(encodeURIComponent(`installs_${PKG}_202611_overview`)))).toHaveLength(1);
    // One app per tick: the next tick takes the other app.
    await pollGooglePlayStats(h.env, now);
    expect(ran()).toEqual([{ app_id: "app" }, { app_id: "app2" }]);
    h.g.calls.length = 0;
    await pollGooglePlayStats(h.env, now);
    expect(h.g.calls).toHaveLength(0);
  });

  it("alternates with the App Store ingest: Google Play only runs on odd five-minute ticks", async () => {
    const { storeReportsIngest } = await import("../src/lib/store_reports_schedule");
    const h = await harness();
    const service = h.env.PLAY_RELEASE_SERVICE as any;
    const even = 2 * 300_000 * 9_000_000;
    await storeReportsIngest(h.env, even);
    expect(service.listStatsObjects).not.toHaveBeenCalled();
    await storeReportsIngest(h.env, even + 300_000);
    expect(service.listStatsObjects).toHaveBeenCalled();
  });
});

describe("GET /stats", () => {
  it("exposes Google Play daily statistics, totals, ingest status and the metric note without a live call", async () => {
    const h = await harness();
    await ingestGooglePlayStatsForApp(h.env, "app", BUDGET);
    h.g.calls.length = 0;
    const res = await h.call("/api/apps/app/stats?window_days=365&live=false");
    expect(res.status).toBe(200);
    const gp = (await res.json() as any).stores.google_play;
    expect(h.g.calls).toHaveLength(0);
    expect(gp.daily.map((d: any) => [d.date, d.user_installs])).toEqual([
      ["2026-10-30", 30], ["2026-10-31", 31], ["2026-11-01", 1], ["2026-11-02", 2], ["2026-11-03", 3]]);
    expect(gp.totals).toMatchObject({ user_installs: 67, store_listing_conversion_rate: 0.002 });
    expect(gp.reports_ingest).toMatchObject({ files_processed: 3, stats_bucket: BUCKET });
    expect(gp.reports_note).toMatch(/3 to 7 days/);
    expect(gp.download_reports.available).toBe(true);
  });

  it("reads 365 days with a primary-key range scan, fast", async () => {
    const h = await harness();
    const metrics = ["device_installs", "device_uninstalls", "device_upgrades", "user_installs", "user_uninstalls", "total_user_installs",
      "active_device_installs", "install_events", "update_events", "uninstall_events", "store_listing_visitors", "store_listing_acquisitions"];
    const day = (i: number) => new Date(Date.UTC(2025, 10, 12) + i * 86_400_000).toISOString().slice(0, 10);
    const insert = h.sqlite.prepare(`INSERT INTO google_play_stats_daily_totals (app_id, report_kind, month, date, metric, value)
      VALUES (?, ?, ?, ?, ?, ?)`);
    h.sqlite.transaction(() => {
      // Ten other apps of the same size share the table.
      for (const appId of ["app", ...Array.from({ length: 10 }, (_, i) => `other-${i}`)]) {
        if (appId !== "app") h.sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, 'android', 1)").run(appId, appId, appId);
        for (let i = 0; i < 365 * 3; i++) {
          const date = day(i - 365 * 2);
          for (const m of metrics) insert.run(appId, m.startsWith("store") ? "store_performance_overview" : "installs_overview", date.slice(0, 7), date, m, 2);
        }
      }
    })();
    h.sqlite.exec("ANALYZE");
    const plan = (h.sqlite.prepare(`EXPLAIN QUERY PLAN ${PLAY_DAILY_SQL.replace(/\?(\d+)/g, "?")}`).all("app", day(0)) as Array<{ detail: string }>)
      .map((r) => r.detail).join("\n");
    expect(plan).toMatch(/SEARCH google_play_stats_daily_totals USING (INDEX sqlite_autoindex_google_play_stats_daily_totals_1|PRIMARY KEY)/);
    expect(plan).not.toMatch(/^SCAN/m);
    const started = performance.now();
    const result = await queryGooglePlayStatsDaily(h.env.DB, "app", day(0));
    const elapsed = performance.now() - started;
    console.info(`play stats read: ${elapsed.toFixed(1)} ms for 365 days\n${plan}`);
    expect(result.daily).toHaveLength(365);
    expect(result.totals).toMatchObject({ user_installs: 730, active_device_installs_latest: 2, store_listing_conversion_rate: 1 });
    expect(elapsed).toBeLessThan(100);
  }, 60_000);
});
