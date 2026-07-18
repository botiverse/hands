import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { APP_PLATFORMS } from "../src/lib/app_platform";
import { handleCreateApp } from "../src/routes/apps";
import {
  handleListExternalBuildTargets,
  handlePublishExternalBuildVersion,
} from "../src/routes/builds";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE TABLE builds (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      channel_id TEXT,
      product_type TEXT NOT NULL,
      release_type TEXT NOT NULL,
      version_name TEXT NOT NULL,
      version_code INTEGER NOT NULL,
      changelog TEXT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      build_metadata_json TEXT NOT NULL,
      parsed_metadata_json TEXT NOT NULL,
      should_force_update INTEGER NOT NULL,
      availability_at INTEGER,
      provenance_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      targets_frozen_at INTEGER,
      freeze_token TEXT,
      required_targets_json TEXT
    );
    CREATE UNIQUE INDEX idx_builds_external_app_version
      ON builds(app_id, version_name)
      WHERE source = 'external';
    CREATE TABLE external_build_targets (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
      version_name TEXT NOT NULL,
      target TEXT NOT NULL,
      source_url TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL,
      raw_size_bytes INTEGER NOT NULL,
      gzip_sha256 TEXT,
      gzip_size_bytes INTEGER,
      node_version TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      gzip_source_url TEXT,
      UNIQUE (app_id, version_name, target)
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const normalize = (sql: string) => sql.replace(/\?\d+/g, "?");
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(normalize(sql));
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              const info = statement.run(...params);
              return { success: true, meta: { changes: Number(info.changes ?? 0) } };
            },
            async first<T>() {
              return (statement.get(...params) as T | undefined) ?? null;
            },
            async all<T>() {
              return { results: statement.all(...params) as T[], success: true };
            },
          };
        },
      };
    },
  };
}

function jsonContext(
  db: ReturnType<typeof makeDb>,
  params: Record<string, string>,
  body: unknown = {},
) {
  return {
    env: { DB: db },
    req: {
      param: (name: string) => params[name] ?? "",
      json: async () => body,
    },
    get: (name: string) => (name === "admin_actor" ? "external-build-test" : undefined),
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as any;
}

const RAW_SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const GZIP_SHA = "c".repeat(64);

function declaration(target = "darwin-arm64") {
  return {
    channel_id: "main",
    version_name: "0.72.13",
    version_code: 7213,
    target,
    source_url: `https://cdn.raft.build/computer/0.72.13/${target}`,
    raw_sha256: RAW_SHA,
    raw_size_bytes: 12_345,
    gzip_sha256: GZIP_SHA,
    gzip_size_bytes: 5_432,
    node_version: "22.23.1",
    metadata_json: { source: "computer-release" },
    provenance_json: { commit: "0123456789abcdef" },
  };
}

describe("external Node build declarations", () => {
  it("rejects app platform values outside the shared closed set", async () => {
    const response = await handleCreateApp(
      jsonContext(makeDb(), {}, { slug: "bad", name: "Bad", platform: "web" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "unsupported app platform",
      code: "UNSUPPORTED_APP_PLATFORM",
      supported_platforms: APP_PLATFORMS,
    });
  });

  it("publishes immutable per-target evidence and replays the same declaration", async () => {
    const db = makeDb();
    await db.prepare("INSERT INTO apps (id, platform) VALUES (?1, 'node')").bind("computer").run();
    await db.prepare("INSERT INTO channels (id, app_id) VALUES ('main', ?1)").bind("computer").run();

    const first = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "computer" }, declaration()),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;
    expect(firstBody).toMatchObject({
      app_id: "computer",
      version: "0.72.13",
      target: "darwin-arm64",
      platform: "darwin",
      arch: "arm64",
      replayed: false,
    });

    const replay = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "computer" }, declaration()),
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      build_id: firstBody.build_id,
      target_id: firstBody.target_id,
      replayed: true,
    });

    const secondTarget = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "computer" }, declaration("linux-x64")),
    );
    expect(secondTarget.status).toBe(201);
    await expect(secondTarget.json()).resolves.toMatchObject({
      build_id: firstBody.build_id,
      target: "linux-x64",
      platform: "linux",
      arch: "x64",
      replayed: false,
    });

    const list = await handleListExternalBuildTargets(
      jsonContext(db, { appId: "computer", buildId: firstBody.build_id }),
    );
    expect(list.status).toBe(200);
    const listBody = await list.json() as any;
    expect(listBody.targets.map((target: any) => target.target)).toEqual([
      "darwin-arm64",
      "linux-x64",
    ]);
  });

  it("canonicalizes nested declaration JSON for idempotent replay", async () => {
    const db = makeDb();
    await db.prepare("INSERT INTO apps (id, platform) VALUES (?1, 'node')").bind("computer").run();
    await db.prepare("INSERT INTO channels (id, app_id) VALUES ('main', ?1)").bind("computer").run();

    const first = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "computer" }, {
        ...declaration(),
        metadata_json: { source: "computer-release", nested: { left: 1, right: 2 } },
        provenance_json: {
          commit: "0123456789abcdef",
          run: { provider: "github", id: "42" },
        },
      }),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;

    const replay = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "computer" }, {
        ...declaration(),
        metadata_json: { nested: { right: 2, left: 1 }, source: "computer-release" },
        provenance_json: {
          run: { id: "42", provider: "github" },
          commit: "0123456789abcdef",
        },
      }),
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      build_id: firstBody.build_id,
      target_id: firstBody.target_id,
      replayed: true,
    });
  });

  it("rejects changed bytes for an existing app/version/target declaration", async () => {
    const db = makeDb();
    await db.prepare("INSERT INTO apps (id, platform) VALUES (?1, 'node')").bind("computer").run();
    await db.prepare("INSERT INTO channels (id, app_id) VALUES ('main', ?1)").bind("computer").run();

    const first = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "computer" }, declaration()),
    );
    expect(first.status).toBe(201);

    const conflict = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "computer" }, { ...declaration(), raw_sha256: OTHER_SHA }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "EXTERNAL_BUILD_CONFLICT",
      target: "darwin-arm64",
    });
  });

  it("rejects changed version-level metadata before treating a target as a replay", async () => {
    const db = makeDb();
    await db.prepare("INSERT INTO apps (id, platform) VALUES (?1, 'node')").bind("computer").run();
    await db.prepare("INSERT INTO channels (id, app_id) VALUES ('main', ?1)").bind("computer").run();

    const first = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "computer" }, declaration()),
    );
    expect(first.status).toBe(201);

    const conflict = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "computer" }, { ...declaration(), version_code: 72_014 }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "EXTERNAL_VERSION_CONFLICT",
    });
  });

  it("requires a node app", async () => {
    const db = makeDb();
    await db.prepare("INSERT INTO apps (id, platform) VALUES (?1, 'electron')").bind("desktop").run();
    await db.prepare("INSERT INTO channels (id, app_id) VALUES ('main', ?1)").bind("desktop").run();

    const response = await handlePublishExternalBuildVersion(
      jsonContext(db, { appId: "desktop" }, declaration()),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "APP_PLATFORM_MISMATCH",
      app_platform: "electron",
    });
  });

  it("rejects source URLs that embed credentials", async () => {
    const response = await handlePublishExternalBuildVersion(
      jsonContext(makeDb(), { appId: "computer" }, {
        ...declaration(),
        source_url: "https://token@example.test/computer",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_EXTERNAL_BUILD",
      error: "source_url must not contain embedded credentials",
    });
  });
});
