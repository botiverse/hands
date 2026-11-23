import { beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { exportPKCS8, generateKeyPair } from "jose";
import { storeGooglePlayBinding } from "../src/lib/google_play_bindings";
import { requireAppRole } from "../src/lib/permissions";
import { handleProxyPlayApi, normalizePlayApiPathForPackage } from "../src/routes/play_api_proxy";
import { handleAppStats } from "../src/routes/stats";
import { handleGetAppQuota } from "../src/routes/upstream_quota";

let privateKey: string;
beforeAll(async () => {
  privateKey = await exportPKCS8((await generateKeyPair("RS256", { extractable: true })).privateKey);
});

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(
      sql.replace(/\?(\d+)/g, (_m, index) => {
        indexes.push(Number(index));
        return "?";
      }),
    );
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      const runSync = () => ({ success: true, meta: { changes: statement.run(...expanded).changes } });
      return {
        _batchSync: () => (statement.reader ? { success: true, results: statement.all(...expanded) } : runSync()),
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

type Adapter = NonNullable<Env["PLAY_RELEASE_SERVICE"]>;

const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function setupHarness(options: {
  role?: "publisher" | "viewer";
  principal?: "human" | "agent" | "system";
  adapterOverrides?: Partial<Adapter>;
} = {}) {
  const principal = options.principal ?? "agent";
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  }
  const now = Date.now();
  sqlite
    .prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app', 'raft-android', 'Raft Android', 'android', ?)")
    .run(now);
  sqlite
    .prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('ch-main', 'app', 'main', 'Main', ?)")
    .run(now);
  sqlite
    .prepare(
      `INSERT INTO raft_accounts
       (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
        username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
       VALUES ('acct', 'raft', 'acct', 'server', 'test', ?, 'member', 'acct', 'Acct', NULL, '{}', ?, ?, ?)`,
    )
    .run(principal === "system" ? "agent" : principal, now, now, now);
  sqlite
    .prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('m', 'app', 'acct', ?, ?)")
    .run(options.role ?? "publisher", now);

  const unexpected = async () => {
    throw new Error("unexpected adapter call");
  };
  const playAdapter: Adapter = {
    listTracks: unexpected,
    verifyBinding: unexpected,
    readTrackMaximum: unexpected,
    promote: unexpected,
    readStoreListings: unexpected,
    pushStoreListings: unexpected,
    listReleaseStates: async (input) => ({
      ok: true,
      value: [
        {
          packageName: input.packageName,
          handsTrack: input.handsTrack,
          playTrack: input.tracks[input.handsTrack],
          releaseName: "1.23.0",
          releaseLifecycleState: "completed",
          activeArtifacts: [{ versionCode: 12300 }],
          observedAt: now,
        },
      ],
    }),
    callPlayApi: async (input) => ({
      ok: true,
      value: {
        package_name: input.packageName,
        method: input.method,
        path: input.path.startsWith("/androidpublisher/")
          ? input.path
          : `/androidpublisher/v3/applications/${input.packageName}/${input.path.replace(/^\/+/, "")}`,
        status: 200,
        body: { echoMethod: input.method, echoBody: input.body ?? null },
      },
    }),
    ...options.adapterOverrides,
  } as Adapter;

  const env = {
    DB: d1(sqlite),
    ENVIRONMENT: "development",
    PLAY_CRED_ENC_KEYS: JSON.stringify({ v1: "test-only-google-play-key-material-1234567890" }),
    PLAY_CRED_ENC_ACTIVE_KEY_VERSION: "v1",
    PLAY_RELEASE_SERVICE: playAdapter,
  } as unknown as Env;

  await storeGooglePlayBinding(env.DB, {
    appId: "app",
    packageName: "build.raft.app",
    tracks: { internal: "qa", closed: "closed", production: "production" },
    credential: {
      type: "service_account",
      client_email: "app@example.iam.gserviceaccount.com",
      private_key: privateKey,
    },
    actor: "raft:human@test",
    keyringJson: env.PLAY_CRED_ENC_KEYS!,
    activeKeyVersion: "v1",
  });

  const app = new Hono<{ Bindings: Env; Variables: { admin_account: any; admin_actor: string } }>();
  app.use("*", async (c, next) => {
    c.set(
      "admin_account",
      principal === "system"
        ? undefined
        : {
            id: "acct",
            provider: "raft",
            provider_subject: "acct",
            server_id: "server",
            server_slug: "test",
            principal_type: principal,
            server_role: "member",
            username: "acct",
            display_name: "Acct",
            avatar_url: null,
            raw_profile: "{}",
            created_at: 1,
            updated_at: 1,
            last_login_at: 1,
          },
    );
    c.set("admin_actor", `raft:${principal}@test`);
    await next();
  });
  app.post("/api/apps/:appId/distributions/play/api", requireAppRole("viewer"), handleProxyPlayApi);
  app.get("/api/apps/:appId/stats", requireAppRole("viewer"), handleAppStats);
  app.get("/api/apps/:appId/quota", requireAppRole("viewer"), handleGetAppQuota);

  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://hands.test${path}`, init), env, executionContext);

  return { sqlite, env, request };
}

describe("POST /api/apps/:appId/distributions/play/api", () => {
  it("normalizes package-relative paths and rejects cross-package paths", () => {
    expect(normalizePlayApiPathForPackage("build.raft.app", "reviews").canonicalPath).toBe(
      "/androidpublisher/v3/applications/build.raft.app/reviews",
    );
    expect(() =>
      normalizePlayApiPathForPackage(
        "build.raft.app",
        "/androidpublisher/v3/applications/com.other.app/reviews",
      ),
    ).toThrow(/targets package 'com.other.app'/);
  });

  it("allows viewer role for GET but requires publisher role for mutating methods and records receipts", async () => {
    const viewerHarness = await setupHarness({ role: "viewer" });
    const getRes = await viewerHarness.request("/api/apps/app/distributions/play/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "GET", path: "reviews" }),
    });
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as Record<string, unknown>;
    expect(getJson.receipt_id).toBeNull();
    expect(getJson.path).toBe("/androidpublisher/v3/applications/build.raft.app/reviews");

    const postDenied = await viewerHarness.request("/api/apps/app/distributions/play/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "POST", path: "edits" }),
    });
    expect(postDenied.status).toBe(403);

    const pubHarness = await setupHarness({ role: "publisher" });
    const postOk = await pubHarness.request("/api/apps/app/distributions/play/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "PUT",
        path: "edits/edit-99/tracks/production",
        body: { track: "production" },
        note: "update track via play api",
      }),
    });
    expect(postOk.status).toBe(200);
    const postJson = (await postOk.json()) as Record<string, unknown>;
    expect(typeof postJson.receipt_id).toBe("string");
    const receipts = pubHarness.sqlite
      .prepare("SELECT * FROM play_store_listing_receipts")
      .all() as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.mode).toBe("commit");
    expect(receipts[0]?.verdict).toBe("committed");
    expect(receipts[0]?.play_edit_id).toBe("edit-99");
  });
});

describe("Play API proxy failures", () => {
  it("relays what Google said once, as upstream, not inside the raw cause", async () => {
    const { request, sqlite } = await setupHarness({ role: "publisher", adapterOverrides: {
      callPlayApi: async () => ({ ok: false, error: { status: 403, code: "play_api_rejected", message: "refused",
        cause: { stage: "play_request", provider_http_status: 403, provider_message: "The caller does not have permission ya29.leak" } } }),
    } as Partial<Adapter> });
    const res = await request("/api/apps/app/distributions/play/api", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "PUT", path: "edits/e1/tracks/production", body: {}, note: "n" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.upstream).toEqual({ service: "google_play", http_status: 403, message: "The caller does not have permission [redacted]" });
    expect(body.error.cause).toEqual({ stage: "play_request", provider_http_status: 403 });
    const receipt = sqlite.prepare("SELECT payload_json FROM play_store_listing_receipts").get() as { payload_json: string };
    expect(receipt.payload_json).not.toContain("ya29.");
    expect(receipt.payload_json).not.toContain("provider_message");
  });
});

describe("GET /api/apps/:appId/stats", () => {
  it("aggregates direct device pings, downloads, and live Google Play track states", async () => {
    const { sqlite, request } = await setupHarness({ role: "viewer" });
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO device_pings (app_id, device_id, version_name, version_code, channel, platform, first_seen, last_seen, ping_count)
         VALUES ('app', 'dev-1', '1.23.0', 12300, 'main', 'android', ?, ?, 5)`,
      )
      .run(now - 1000, now);

    const res = await request("/api/apps/app/stats?window_days=30");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      app: { slug: string };
      direct: {
        devices: { active_window: number; total_all_time: number };
        by_version: Array<{ version_name: string; active_devices: number }>;
      };
      stores: {
        google_play: {
          configured: boolean;
          package_name: string;
          live_tracks: Array<{ hands_track: string }>;
        } | null;
      };
    };
    expect(body.app.slug).toBe("raft-android");
    expect(body.direct.devices.active_window).toBe(1);
    expect(body.direct.devices.total_all_time).toBe(1);
    expect(body.direct.by_version[0]?.version_name).toBe("1.23.0");
    expect(body.stores.google_play?.configured).toBe(true);
    expect(body.stores.google_play?.package_name).toBe("build.raft.app");
    expect(body.stores.google_play?.live_tracks).toHaveLength(4); // production, open testing (beta), closed, internal
  });

  it("gives direct-install daily active devices and countries for a from/to range", async () => {
    const { sqlite, request } = await setupHarness({ role: "viewer" });
    const insert = sqlite.prepare(
      `INSERT INTO device_ping_days (app_id, day, device_id, channel, platform, version_code, country) VALUES ('app', ?, ?, ?, 'android', 1, ?)`,
    );
    insert.run("2026-11-01", "d1", "main", "CN");
    insert.run("2026-11-01", "d2", "main", "US");
    insert.run("2026-11-02", "d1", "main", "CN");
    insert.run("2026-11-02", "d3", "preview", null);
    insert.run("2026-11-05", "d4", "main", "CN"); // outside the range

    const body = await (await request("/api/apps/app/stats?from=2026-11-01&to=2026-11-03&live=0")).json() as any;
    expect([body.from, body.to, body.window_days]).toEqual(["2026-11-01", "2026-11-03", 3]);
    expect(body.direct.recorded_since).toBe("2026-11-01");
    expect(body.direct.daily).toEqual([{ date: "2026-11-01", active_devices: 2 }, { date: "2026-11-02", active_devices: 2 }]);
    expect(body.direct.active_devices_range).toBe(3);
    expect(body.direct.by_country).toEqual([
      { country: "CN", active_devices: 1 }, { country: "US", active_devices: 1 }, { country: "unknown", active_devices: 1 },
    ]);

    const main = await (await request("/api/apps/app/stats?from=2026-11-01&to=2026-11-03&channel=main&live=0")).json() as any;
    expect(main.direct.active_devices_range).toBe(2);

    for (const bad of ["from=2026-11-31", "from=2026-11-05&to=2026-11-01", "to=2026-11-01", "from=2025-01-01&to=2026-11-01"]) {
      const res = await request(`/api/apps/app/stats?${bad}&live=0`);
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("INVALID_STATS_RANGE");
    }
  });

  it("serves Google Play track states from the stored answer after the first read", async () => {
    let calls = 0;
    const { request } = await setupHarness({ role: "viewer", adapterOverrides: {
      listReleaseStates: async (input) => {
        calls++;
        const track = input.tracks[input.handsTrack as "internal"];
        return { ok: true, value: [{ releaseName: "1.0", track, activeArtifacts: [{ versionCode: 1 }], releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }] };
      },
    } });
    const first = await (await request("/api/apps/app/stats?window_days=30")).json() as any;
    expect(calls).toBe(4);
    const second = await (await request("/api/apps/app/stats?window_days=30")).json() as any;
    // Google allows about 12 release-state reads per app per hour; a page view must not spend them.
    expect(calls).toBe(4);
    expect(second.stores.google_play.live_tracks).toEqual(first.stores.google_play.live_tracks);
    expect(second.stores.google_play.live_tracks[0]).toMatchObject({ read_at: expect.any(Number), releases: [{ version_codes: [1] }] });
  });

  it("leaves a never-read track unread when the interactive budget is used up, without failing the page", async () => {
    let calls = 0;
    const { sqlite, request } = await setupHarness({ role: "viewer", adapterOverrides: {
      listReleaseStates: async (input) => {
        calls++;
        const track = input.tracks[input.handsTrack as "internal"];
        return { ok: true, value: [{ releaseName: "1.0", track, activeArtifacts: [{ versionCode: 1 }], releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED" }] };
      },
    } });
    // Six calls spent this hour: two first reads fit under the interactive ceiling of eight.
    spendPlayQuota(sqlite, 6);
    const res = await request("/api/apps/app/stats?window_days=30");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(calls).toBe(2);
    expect(body.stores.google_play.live_tracks.map((t: any) => t.hands_track)).toEqual(["production", "open"]);
    expect(body.stores.google_play.live_error).toBeNull();
  });
});

/** Spend `used` calls of this hour's Play release-listing quota for the test package. */
function spendPlayQuota(sqlite: Database.Database, used: number, exhaustedUntil: number | null = null) {
  const now = Date.now();
  const start = Math.floor((now - 600_000) / 3_600_000) * 3_600_000 + 600_000;
  sqlite.prepare(`INSERT INTO upstream_quota_usage (quota_key, scope_key, window_start, used, exhausted_until, updated_at)
    VALUES ('google_play:tracks.releases.list', 'build.raft.app', ?, ?, ?, ?)`).run(start, used, exhaustedUntil, now);
  return { reset_at: start + 3_600_000 };
}

describe("GET /api/apps/:appId/quota", () => {
  it("lists Play's release-listing quota for an Android app with a verified binding, to viewers", async () => {
    const { sqlite, request } = await setupHarness({ role: "viewer" });
    sqlite.exec("UPDATE app_google_play_bindings SET verification_state='verified', enabled=1");
    const { reset_at } = spendPlayQuota(sqlite, 5);
    const res = await request("/api/apps/app/quota");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quotas: [{
      key: "google_play:tracks.releases.list", service: "google_play", operation: "tracks.releases.list",
      scope: "package", scope_key: "build.raft.app", limit: 12, used: 5,
      remaining: { gate: 7, interactive: 3, background: 0 }, reset_at, exhausted_until: null,
      source: "measured 2026-11-22",
    }] });
  });

  it("reports an exhausted quota as nothing left until it resets", async () => {
    const { sqlite, request } = await setupHarness({ role: "viewer" });
    const now = Date.now();
    const start = Math.floor((now - 600_000) / 3_600_000) * 3_600_000 + 600_000;
    spendPlayQuota(sqlite, 2, start + 3_600_000);
    const body = await (await request("/api/apps/app/quota")).json() as any;
    expect(body.quotas[0]).toMatchObject({ used: 2, exhausted_until: start + 3_600_000, remaining: { gate: 0, interactive: 0, background: 0 } });
  });

  it("lists nothing for an app without a verified Play binding", async () => {
    const { sqlite, request } = await setupHarness({ role: "viewer" });
    sqlite.exec("UPDATE app_google_play_bindings SET verification_state='stale'");
    expect(await (await request("/api/apps/app/quota")).json()).toEqual({ quotas: [] });
    sqlite.exec("UPDATE app_google_play_bindings SET verification_state='verified'; UPDATE apps SET platform='ios'");
    expect(await (await request("/api/apps/app/quota")).json()).toEqual({ quotas: [] });
  });
});
