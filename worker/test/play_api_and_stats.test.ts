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
    expect(body.stores.google_play?.live_tracks).toHaveLength(3);
  });
});
