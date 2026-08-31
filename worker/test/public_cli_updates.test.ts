import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handlePublicCliBinaryUpdateCheck,
  handlePublicCliBinaryVersions,
} from "../src/routes/public_v2";

function d1(sqlite: Database.Database) {
  return { prepare(sql: string) {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => { indexes.push(Number(index)); return "?"; }));
    const bind = (...values: unknown[]) => {
      const bound = indexes.length ? indexes.map((index) => values[index - 1]) : values;
      return {
        first: async <T>() => (statement.get(...bound) as T | undefined) ?? null,
        all: async <T>() => ({ results: statement.all(...bound) as T[] }),
        run: async () => ({ success: true, meta: { changes: statement.run(...bound).changes } }),
      };
    };
    return { bind, first: () => bind().first(), all: () => bind().all(), run: () => bind().run() };
  } };
}

describe("public cli-binary selection", () => {
  let sqlite: Database.Database;
  let env: { DB: ReturnType<typeof d1>; BUSINESS_ORIGIN: string };
  let app: Hono<{ Bindings: typeof env }>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY, slug TEXT, platform TEXT);
      CREATE TABLE channels (id TEXT PRIMARY KEY, app_id TEXT, slug TEXT);
      CREATE TABLE releases (id TEXT PRIMARY KEY, app_id TEXT, build_id TEXT, channel_id TEXT, product_type TEXT, release_type TEXT, status TEXT, hidden INTEGER, revision INTEGER, rollout_cohort_count INTEGER, activated_at INTEGER, availability_at INTEGER);
      CREATE TABLE release_scopes (id TEXT PRIMARY KEY, release_id TEXT, scope_type TEXT, scope_value TEXT);
      CREATE TABLE builds (id TEXT PRIMARY KEY, app_id TEXT, status TEXT, version_name TEXT, version_code INTEGER);
      CREATE TABLE external_build_targets (id TEXT PRIMARY KEY, build_id TEXT, target TEXT, raw_sha256 TEXT, raw_size_bytes INTEGER);
      INSERT INTO apps VALUES ('app', 'computer', 'desktop');
      INSERT INTO channels VALUES ('channel-main', 'app', 'main');
      INSERT INTO channels VALUES ('channel-alpha', 'app', 'alpha');
    `);
    env = { DB: d1(sqlite), BUSINESS_ORIGIN: "https://hands.example" };
    app = new Hono<{ Bindings: typeof env }>();
    app.get("/public/v2/apps/:slug/updates/check", handlePublicCliBinaryUpdateCheck as never);
    app.get("/public/v2/apps/:slug/versions", handlePublicCliBinaryVersions as never);
  });

  function seedRelease(id: string, version: string, status: string, activatedAt: number, options: { channel?: "main" | "alpha"; sha256?: string; reuseArtifactFrom?: string } = {}) {
    const source = options.reuseArtifactFrom ?? id;
    const buildId = `build-${source}`;
    const artifactId = `artifact-${source}`;
    const sha256 = options.sha256 ?? createHash("sha256").update(id).digest("hex");
    const channel = options.channel ?? "main";
    if (!options.reuseArtifactFrom) {
      sqlite.prepare("INSERT INTO builds VALUES (?, 'app', 'succeeded', ?, ?)").run(buildId, version, activatedAt);
      sqlite.prepare("INSERT INTO external_build_targets VALUES (?, ?, 'linux-x64', ?, 8)").run(artifactId, buildId, sha256);
    }
    sqlite.prepare("INSERT INTO releases VALUES (?, 'app', ?, ?, 'cli-binary', 'stable', ?, 0, 1, NULL, ?, NULL)")
      .run(id, buildId, `channel-${channel}`, status, activatedAt);
    sqlite.prepare("INSERT INTO release_scopes VALUES (?, ?, 'full', 'all')").run(`scope-${id}`, id);
  }

  function check(extra = "") {
    return app.request(`https://hands.example/public/v2/apps/computer/updates/check?current_version=0.5.0&channel=main&platform=linux&arch=x64${extra}`, {}, env);
  }

  function versions(extra = "") {
    return app.request(`https://hands.example/public/v2/apps/computer/versions?channel=alpha&platform=linux&arch=x64${extra}`, {}, env);
  }

  it("selects an exact pinned active version", async () => {
    seedRelease("r1", "1.0.0", "active", 100);
    seedRelease("r2", "2.0.0", "active", 200);
    const response = await check("&version=1.0.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ release: { id: "r1", version: "1.0.0" } });
  });

  it("selects an exact pinned superseded version while cancelled remains unavailable", async () => {
    seedRelease("old", "1.0.0", "superseded", 100, { channel: "alpha" });
    seedRelease("cancelled", "0.9.0", "cancelled", 90, { channel: "alpha" });

    const old = await check("&version=1.0.0");
    expect(old.status).toBe(200);
    await expect(old.json()).resolves.toMatchObject({ release: { id: "old", version: "1.0.0" } });

    const cancelled = await check("&version=0.9.0");
    expect(cancelled.status).toBe(404);
    await expect(cancelled.json()).resolves.toMatchObject({ code: "UPDATE_NO_COMPATIBLE_ARTIFACT" });
  });

  it("never exposes a draft through a pinned request", async () => {
    seedRelease("draft", "3.0.0", "draft", 300);
    const response = await check("&version=3.0.0&device_id=attacker-controlled");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_NO_COMPATIBLE_ARTIFACT" });
  });

  it("rejects malformed active ledger integrity", async () => {
    seedRelease("drift", "1.0.0", "active", 100);
    sqlite.prepare("UPDATE external_build_targets SET raw_sha256 = 'bad' WHERE id = 'artifact-drift'").run();
    const response = await check();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_IDENTITY_DRIFT" });
  });

  it("allows an exact pin that exists only on alpha", async () => {
    seedRelease("alpha-only", "4.0.0", "active", 400, { channel: "alpha" });
    const response = await check("&version=4.0.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ release: { channel: "alpha" } });
  });

  it("prefers main when cross-channel artifact identity matches", async () => {
    const sha256 = "b".repeat(64);
    seedRelease("alpha", "5.0.0", "active", 500, { channel: "alpha", sha256 });
    seedRelease("main", "5.0.0", "active", 500, { channel: "main", reuseArtifactFrom: "alpha" });
    const response = await check("&version=5.0.0");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ release: { channel: "main" } });
  });

  it("fails closed when a pinned cross-channel artifact diverges", async () => {
    seedRelease("alpha", "6.0.0", "active", 600, { channel: "alpha", sha256: "c".repeat(64) });
    seedRelease("main", "6.0.0", "active", 601, { channel: "main", sha256: "d".repeat(64) });
    const response = await check("&version=6.0.0");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "UPDATE_IDENTITY_CONFLICT" });
  });

  it("lists active and superseded target-compatible versions newest first", async () => {
    seedRelease("old", "1.0.0", "superseded", 100, { channel: "alpha" });
    seedRelease("latest", "2.0.0", "active", 200, { channel: "alpha" });
    seedRelease("cancelled", "0.9.0", "cancelled", 90, { channel: "alpha" });
    seedRelease("draft", "3.0.0", "draft", 300, { channel: "alpha" });

    const response = await versions();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      app: { slug: "computer" },
      channel: "alpha",
      target: { platform: "linux", arch: "x64" },
      truncated: false,
      versions: [
        { version: "2.0.0", status: "active", release_id: "latest", published_at: 200 },
        { version: "1.0.0", status: "superseded", release_id: "old", published_at: 100 },
      ],
    });
  });

  it("returns an empty complete list for a real channel with no public versions", async () => {
    const response = await versions();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      channel: "alpha",
      truncated: false,
      versions: [],
    });
  });

  it("fails closed on malformed limits and malformed listed integrity", async () => {
    const invalidLimit = await versions("&limit=0");
    expect(invalidLimit.status).toBe(400);
    await expect(invalidLimit.json()).resolves.toMatchObject({ code: "VERSIONS_LIMIT_INVALID" });

    seedRelease("drift", "1.0.0", "active", 100, { channel: "alpha" });
    sqlite.prepare("UPDATE external_build_targets SET raw_sha256 = 'bad' WHERE id = 'artifact-drift'").run();
    const drift = await versions();
    expect(drift.status).toBe(409);
    await expect(drift.json()).resolves.toMatchObject({ code: "VERSION_IDENTITY_DRIFT" });
  });

  it("fails closed when duplicate channel versions have divergent target identities", async () => {
    seedRelease("first", "1.0.0", "superseded", 100, { channel: "alpha", sha256: "a".repeat(64) });
    seedRelease("second", "1.0.0", "active", 200, { channel: "alpha", sha256: "b".repeat(64) });

    const response = await versions();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "VERSION_IDENTITY_CONFLICT" });
  });

  it("reports truncation after deduplicating exact version identities", async () => {
    seedRelease("old-a", "1.0.0", "superseded", 100, { channel: "alpha", sha256: "a".repeat(64) });
    seedRelease("old-b", "1.0.0", "superseded", 101, { channel: "alpha", reuseArtifactFrom: "old-a" });
    seedRelease("latest", "2.0.0", "active", 200, { channel: "alpha" });

    const response = await versions("&limit=1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      truncated: true,
      versions: [{ version: "2.0.0" }],
    });
  });
});
