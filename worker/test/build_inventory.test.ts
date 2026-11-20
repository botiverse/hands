import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { diffInventories, inventoryR2Key, type BuildInventory } from "../src/lib/build_inventory";
import {
  handleBuildInventoryDiff,
  handleGetBuildInventory,
  handleRefreshBuildInventory,
  recomputeInventoryAfterMappingUpload,
} from "../src/routes/build_inventory";
import { autoParseInstallableAsset, handleDeleteBuild } from "../src/routes/builds";
import { openApiDocument } from "../src/openapi";

const container = vi.hoisted(() => ({
  calls: [] as string[],
  mappingUrls: [] as Array<string | null>,
  respond: (_url: string): Response => new Response("unset", { status: 500 }),
}));

vi.mock("@cloudflare/containers", () => ({
  getRandom: async () => ({
    fetch: async (req: Request) => {
      container.calls.push(req.url);
      container.mappingUrls.push(req.headers.get("x-mapping-url"));
      return container.respond(req.url);
    },
  }),
}));

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_m, i) => {
      indexes.push(Number(i));
      return "?";
    }));
    const bind = (...parameters: unknown[]) => {
      const values = indexes.length ? indexes.map((i) => parameters[i - 1]) : parameters;
      const runSync = () => ({ success: true, meta: { changes: statement.run(...values).changes } });
      return {
        _batchSync: () => (statement.reader ? { success: true, results: statement.all(...values) } : runSync()),
        run: async () => runSync(),
        all: async () => ({ success: true, results: statement.all(...values) }),
        first: async () => (statement.get(...values) as Record<string, unknown> | undefined) ?? null,
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  return {
    prepare,
    batch: async (statements: Array<{ _batchSync: () => unknown }>) =>
      sqlite.transaction(() => statements.map((s) => s._batchSync()))(),
  } as unknown as D1Database;
}

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      size: bytes.byteLength,
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  }
  async put(key: string, value: string | Uint8Array) {
    this.objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function inventory(overrides: Partial<BuildInventory> = {}): BuildInventory {
  return {
    schema: 1,
    platform: "android",
    generator: "hands-inventory/1",
    total_bytes: 12_000_000,
    uncompressed_bytes: 20_000_000,
    file_count: 3,
    app: { package_id: "dev.hands.app" },
    categories: [
      { key: "dex", label: "DEX code", bytes: 10_000_000, compressed_bytes: 4_000_000, files: 2 },
      { key: "native/arm64-v8a", label: "Native libraries (arm64-v8a)", bytes: 5_000_000, compressed_bytes: 5_000_000, files: 1 },
    ],
    largest_files: [],
    files: [
      { path: "classes.dex", bytes: 6_000_000, compressed_bytes: 2_400_000, category: "dex" },
      { path: "classes2.dex", bytes: 4_000_000, compressed_bytes: 1_600_000, category: "dex" },
      { path: "lib/arm64-v8a/libapp.so", bytes: 5_000_000, compressed_bytes: 5_000_000, category: "native/arm64-v8a" },
    ],
    components: {
      permissions: ["android.permission.INTERNET"],
      services: ["dev.hands.app.SyncService"],
    },
    libraries: [
      { name: "androidx.compose", kind: "dex-package", bytes: 4_000_000, compressed_bytes: 1_600_000, classes: 5000, sdk: "Jetpack Compose", estimated: true },
      { name: "(12 smaller packages)", kind: "dex-package", bytes: 100_000, compressed_bytes: 40_000, estimated: true },
      { name: "libapp.so", kind: "native", bytes: 5_000_000, compressed_bytes: 5_000_000, abis: ["arm64-v8a"] },
    ],
    sdks: [{ name: "Jetpack Compose", bytes: 4_000_000, compressed_bytes: 1_600_000, kinds: ["dex-package"] }],
    notes: [],
    truncated: false,
    ...overrides,
  };
}

function grownInventory(): BuildInventory {
  const base = inventory();
  return {
    ...base,
    total_bytes: 20_000_000,
    uncompressed_bytes: 32_000_000,
    categories: [
      { key: "dex", label: "DEX code", bytes: 14_000_000, compressed_bytes: 5_600_000, files: 2 },
      { key: "native/arm64-v8a", label: "Native libraries (arm64-v8a)", bytes: 9_000_000, compressed_bytes: 9_000_000, files: 2 },
      { key: "native/armeabi-v7a", label: "Native libraries (armeabi-v7a)", bytes: 3_000_000, compressed_bytes: 3_000_000, files: 1 },
    ],
    files: [
      { path: "classes.dex", bytes: 8_000_000, compressed_bytes: 3_200_000, category: "dex" },
      { path: "classes2.dex", bytes: 6_000_000, compressed_bytes: 2_400_000, category: "dex" },
      { path: "lib/arm64-v8a/libapp.so", bytes: 5_000_000, compressed_bytes: 5_000_000, category: "native/arm64-v8a" },
      { path: "lib/arm64-v8a/libsentry.so", bytes: 4_000_000, compressed_bytes: 4_000_000, category: "native/arm64-v8a" },
    ],
    components: {
      permissions: ["android.permission.INTERNET", "android.permission.CAMERA"],
      services: [],
      receivers: ["io.sentry.android.core.SentryReceiver"],
    },
    libraries: [
      { name: "androidx.compose", kind: "dex-package", bytes: 4_500_000, compressed_bytes: 1_800_000, classes: 5600, sdk: "Jetpack Compose", estimated: true },
      { name: "io.sentry", kind: "dex-package", bytes: 3_000_000, compressed_bytes: 1_200_000, classes: 900, sdk: "Sentry", estimated: true },
      { name: "(15 smaller packages)", kind: "dex-package", bytes: 100_000, compressed_bytes: 40_000, estimated: true },
      { name: "libapp.so", kind: "native", bytes: 5_000_000, compressed_bytes: 5_000_000, abis: ["arm64-v8a"] },
      { name: "libsentry.so", kind: "native", bytes: 7_000_000, compressed_bytes: 7_000_000, abis: ["arm64-v8a", "armeabi-v7a"], sdk: "Sentry" },
    ],
    sdks: [
      { name: "Sentry", bytes: 10_000_000, compressed_bytes: 8_200_000, kinds: ["dex-package", "native"] },
      { name: "Jetpack Compose", bytes: 4_500_000, compressed_bytes: 1_800_000, kinds: ["dex-package"] },
    ],
  };
}

describe("diffInventories", () => {
  it("reports what grew and what was added or removed, by size impact", () => {
    const diff = diffInventories(inventory(), grownInventory());
    expect(diff.total).toMatchObject({ before: 12_000_000, after: 20_000_000, delta: 8_000_000 });
    expect(diff.categories.map((c) => [c.key, c.compressed_delta])).toEqual([
      ["native/arm64-v8a", 4_000_000],
      ["native/armeabi-v7a", 3_000_000],
      ["dex", 1_600_000],
    ]);
    expect(diff.components).toEqual({
      permissions: { added: ["android.permission.CAMERA"], removed: [] },
      services: { added: [], removed: ["dev.hands.app.SyncService"] },
      receivers: { added: ["io.sentry.android.core.SentryReceiver"], removed: [] },
    });
    expect(diff.libraries.added.map((l) => l.name)).toEqual(["libsentry.so", "io.sentry"]);
    expect(diff.libraries.removed).toEqual([]);
    // The "(N smaller packages)" row is the same row even though N changed.
    expect(diff.libraries.changed.map((l) => [l.name, l.delta])).toEqual([["androidx.compose", 500_000]]);
    expect(diff.sdks.added.map((s) => s.name)).toEqual(["Sentry"]);
    expect(diff.sdks.changed).toEqual([{ name: "Jetpack Compose", before: 1_600_000, after: 1_800_000, delta: 200_000 }]);
    expect(diff.files.grown.map((f) => [f.path, f.delta])).toEqual([["classes.dex", 2_000_000], ["classes2.dex", 2_000_000]]);
    expect(diff.files.added.map((f) => f.path)).toEqual(["lib/arm64-v8a/libsentry.so"]);
  });

  it("notes framework version changes even when the size is the same", () => {
    const fw = (version: string) => inventory({
      platform: "ios",
      libraries: [{ name: "Sentry", kind: "framework", bytes: 100, compressed_bytes: 50, version, sdk: "Sentry" }],
    });
    const diff = diffInventories(fw("8.1.0"), fw("8.2.0"));
    expect(diff.libraries.changed).toMatchObject([{ name: "Sentry", delta: 0, version_before: "8.1.0", version_after: "8.2.0" }]);
  });
});

describe("build inventory routes", () => {
  let sqlite: Database.Database;
  let r2: MemoryR2;
  let env: Env;

  const app = new Hono<{ Bindings: Env }>();
  app.get("/api/apps/:appId/builds/:buildId/inventory", handleGetBuildInventory);
  app.get("/api/apps/:appId/builds/:buildId/inventory/diff", handleBuildInventoryDiff);
  app.post("/api/apps/:appId/builds/:buildId/inventory", handleRefreshBuildInventory);
  app.delete("/api/apps/:appId/builds/:buildId", handleDeleteBuild);
  const call = (path: string, init?: RequestInit) => app.request(path, init, env);

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    for (const name of readdirSync(migrationDir).sort()) {
      if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
    }
    sqlite.exec(`
      INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app-1', 'app-one', 'App One', 'android', 1);
      INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('channel-1', 'app-1', 'main', 'Main', 1);
      INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code, source, status, created_at, updated_at)
      VALUES ('build-old', 'app-1', 'channel-1', 'android-apk', 'stable', '1.0.0', 100, 'ci', 'succeeded', 1, 1),
             ('build-new', 'app-1', 'channel-1', 'android-apk', 'stable', '1.1.0', 110, 'ci', 'succeeded', 2, 2),
             ('build-ios', 'app-1', 'channel-1', 'ios-ipa', 'stable', '1.0.5', 105, 'ci', 'succeeded', 3, 3);
      INSERT INTO build_assets (id, build_id, platform, filetype, r2_key, file_hash, size_bytes, created_at, artifact_kind)
      VALUES ('asset-old', 'build-old', 'android', 'apk', 'apps/app-1/old.apk', '${"a".repeat(64)}', 4, 1, 'installable'),
             ('asset-new', 'build-new', 'android', 'apk', 'apps/app-1/new.apk', '${"b".repeat(64)}', 4, 2, 'installable');
    `);
    r2 = new MemoryR2();
    r2.objects.set("apps/app-1/old.apk", new Uint8Array([1, 2, 3, 4]));
    r2.objects.set("apps/app-1/new.apk", new Uint8Array([5, 6, 7, 8]));
    env = {
      DB: d1(sqlite), APK_BUCKET: r2 as unknown as R2Bucket, APK_PARSER: {} as never,
      R2_S3_ENDPOINT: "https://r2.example.test", R2_BUCKET_NAME: "assets",
      R2_S3_ACCESS_KEY_ID: "test-access", R2_S3_SECRET_ACCESS_KEY: "test-secret",
    } as unknown as Env;
    container.calls = [];
    container.mappingUrls = [];
    container.respond = (url) => {
      if (!url.includes("/inventory?platform=android")) return new Response("wrong endpoint", { status: 404 });
      return Response.json({ inventory: inventory() });
    };
  });

  it("is documented in the OpenAPI document", () => {
    const paths = openApiDocument.paths ?? {};
    expect(paths["/api/apps/{appId}/builds/{buildId}/inventory"]?.get).toBeDefined();
    expect(paths["/api/apps/{appId}/builds/{buildId}/inventory"]?.post).toBeDefined();
    expect(paths["/api/apps/{appId}/builds/{buildId}/inventory/diff"]?.get).toBeDefined();
  });

  it("says when a build has no inventory, then computes one from the stored package", async () => {
    const missing = await call("/api/apps/app-1/builds/build-old/inventory");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "INVENTORY_MISSING" });

    const refreshed = await call("/api/apps/app-1/builds/build-old/inventory", { method: "POST" });
    expect(refreshed.status).toBe(200);
    expect(container.calls).toEqual(["http://container/inventory?platform=android"]);
    const body = await refreshed.json() as { inventory: BuildInventory; source_asset_id: string };
    expect(body.inventory.total_bytes).toBe(12_000_000);
    expect(body.source_asset_id).toBe("asset-old");
    expect(r2.objects.has(inventoryR2Key("app-1", "build-old"))).toBe(true);
    expect(sqlite.prepare("SELECT platform, source_file_hash FROM build_inventories WHERE build_id = 'build-old'").get())
      .toEqual({ platform: "android", source_file_hash: "a".repeat(64) });
    expect(sqlite.prepare("SELECT action FROM audit_logs WHERE app_id = 'app-1'").pluck().all()).toContain("build.inventory.refresh");

    const got = await call("/api/apps/app-1/builds/build-old/inventory");
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ build: { build_id: "build-old", version_code: 100 }, inventory: { platform: "android" } });

    // Another app cannot read it.
    sqlite.exec("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app-2', 'app-two', 'Two', 'android', 1)");
    expect((await call("/api/apps/app-2/builds/build-old/inventory")).status).toBe(404);
  });

  it("refuses to refresh a build without an APK or IPA, and reports extractor failures", async () => {
    const none = await call("/api/apps/app-1/builds/build-ios/inventory", { method: "POST" });
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ code: "NO_INSTALLABLE_PACKAGE" });

    container.respond = () => Response.json({ error: "not a zip archive" }, { status: 422 });
    const failed = await call("/api/apps/app-1/builds/build-old/inventory", { method: "POST" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: "INVENTORY_FAILED", error: expect.stringContaining("not a zip archive") });
    expect(sqlite.prepare("SELECT count(*) FROM build_inventories").pluck().get()).toBe(0);
  });

  it("diffs against the previous build of the same product type", async () => {
    const noPrevious = await call("/api/apps/app-1/builds/build-old/inventory/diff");
    expect(noPrevious.status).toBe(404);
    expect(await noPrevious.json()).toMatchObject({ code: "NO_PREVIOUS_BUILD" });

    await call("/api/apps/app-1/builds/build-old/inventory", { method: "POST" });
    const headMissing = await call("/api/apps/app-1/builds/build-new/inventory/diff?against=previous");
    expect(headMissing.status).toBe(404);
    expect(await headMissing.json()).toMatchObject({ code: "INVENTORY_MISSING", build_id: "build-new" });

    container.respond = () => Response.json({ inventory: grownInventory() });
    await call("/api/apps/app-1/builds/build-new/inventory", { method: "POST" });

    const diff = await call("/api/apps/app-1/builds/build-new/inventory/diff");
    expect(diff.status).toBe(200);
    const body = await diff.json() as { base: { build_id: string }; head: { build_id: string }; diff: ReturnType<typeof diffInventories> };
    // build-ios (version 105) is a different product type and is skipped.
    expect(body.base.build_id).toBe("build-old");
    expect(body.head.build_id).toBe("build-new");
    expect(body.diff.total.delta).toBe(8_000_000);
    expect(body.diff.sdks.added.map((s) => s.name)).toEqual(["Sentry"]);

    const explicit = await call("/api/apps/app-1/builds/build-old/inventory/diff?against=build-new");
    expect(explicit.status).toBe(200);
    expect((await explicit.json() as { diff: { total: { delta: number } } }).diff.total.delta).toBe(-8_000_000);
    expect((await call("/api/apps/app-1/builds/build-old/inventory/diff?against=nope")).status).toBe(404);
  });

  it("stores the inventory from upload parsing without putting it in parsed_metadata_json", async () => {
    container.respond = () => Response.json({
      parser_kind: "apk-aapt",
      platform: "android",
      version: "1.1.0",
      version_code: 110,
      package_id: "dev.hands.app",
      size_bytes: 4,
      file_hash_sha256: "b".repeat(64),
      raw: { signer_lineages: [["c".repeat(64)]] },
      inventory: grownInventory(),
    });
    await autoParseInstallableAsset(env, "app-1", "build-new", "apps/app-1/new.apk", "apk-aapt");
    const parsed = JSON.parse(sqlite.prepare("SELECT parsed_metadata_json FROM builds WHERE id = 'build-new'").pluck().get() as string);
    expect(parsed.package_id).toBe("dev.hands.app");
    expect(parsed).not.toHaveProperty("inventory");
    expect(sqlite.prepare("SELECT source_asset_id, total_bytes FROM build_inventories WHERE build_id = 'build-new'").get())
      .toEqual({ source_asset_id: "asset-new", total_bytes: 20_000_000 });
  });

  it("keeps parsing when the inventory is invalid or failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const extra of [{ inventory: { schema: 99 } }, { inventory_error: "aapt crashed" }]) {
      container.respond = () => Response.json({
        parser_kind: "apk-aapt",
        platform: "android",
        package_id: "dev.hands.app",
        version_code: 110,
        size_bytes: 4,
        file_hash_sha256: "b".repeat(64),
        raw: { signer_lineages: [["c".repeat(64)]] },
        ...extra,
      });
      await autoParseInstallableAsset(env, "app-1", "build-new", "apps/app-1/new.apk", "apk-aapt");
      const parsed = JSON.parse(sqlite.prepare("SELECT parsed_metadata_json FROM builds WHERE id = 'build-new'").pluck().get() as string);
      expect(parsed.package_id).toBe("dev.hands.app");
      expect(parsed).not.toHaveProperty("inventory_error");
    }
    error.mockRestore();
    expect(sqlite.prepare("SELECT count(*) FROM build_inventories").pluck().get()).toBe(0);
  });

  const addMapping = (id: string, buildId: string, state: string | null, createdAt: number) => sqlite.prepare(
    `INSERT INTO build_assets (id, build_id, platform, filetype, r2_key, file_hash, size_bytes, created_at, artifact_kind, metadata_json)
     VALUES (?, ?, 'android', 'mapping.txt', ?, ?, 10, ?, 'proguard-mapping', ?)`,
  ).run(id, buildId, `apps/app-1/builds/${buildId}/${id}/mapping.txt`, "d".repeat(64), createdAt, JSON.stringify(state ? { upload_state: state } : {}));

  it("passes the build's own ready R8 mapping to the container as a presigned header", async () => {
    // No mapping: no header.
    await call("/api/apps/app-1/builds/build-new/inventory", { method: "POST" });
    expect(container.mappingUrls).toEqual([null]);

    // Another build's mapping and a mapping still uploading are not used.
    addMapping("map-old", "build-old", "ready", 5);
    addMapping("map-pending", "build-new", "pending_upload", 9);
    await call("/api/apps/app-1/builds/build-new/inventory", { method: "POST" });
    expect(container.mappingUrls[1]).toBeNull();

    sqlite.prepare("UPDATE build_assets SET metadata_json = ? WHERE id = 'map-pending'").run(JSON.stringify({ upload_state: "ready" }));
    container.respond = () => Response.json({ inventory: inventory({ mapping: { used: true, classes_mapped: 10, classes_unmapped: 2 } }) });
    const res = await call("/api/apps/app-1/builds/build-new/inventory", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inventory: { mapping: { used: true, classes_mapped: 10 } } });
    const url = new URL(container.mappingUrls[2]!);
    expect(url.origin).toBe("https://r2.example.test");
    expect(url.pathname).toBe("/assets/apps/app-1/builds/build-new/map-pending/mapping.txt");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    // Never in the container request URL.
    expect(container.calls[2]).toBe("http://container/inventory?platform=android");
    const audit = sqlite.prepare("SELECT payload FROM audit_logs WHERE action = 'build.inventory.refresh' ORDER BY created_at DESC LIMIT 1").pluck().get() as string;
    expect(JSON.parse(audit)).toMatchObject({ buildId: "build-new", mapping: true });
    expect(audit).not.toContain("X-Amz");
  });

  it("passes the mapping to upload parsing when it is already there", async () => {
    addMapping("map-new", "build-new", null, 3);
    container.respond = () => Response.json({
      parser_kind: "apk-aapt", platform: "android", package_id: "dev.hands.app", version_code: 110, size_bytes: 4,
      file_hash_sha256: "b".repeat(64), raw: { signer_lineages: [["c".repeat(64)]] }, inventory: inventory(),
    });
    await autoParseInstallableAsset(env, "app-1", "build-new", "apps/app-1/new.apk", "apk-aapt");
    expect(container.calls).toEqual(["http://container/parse?parser_kind=apk-aapt"]);
    expect(container.mappingUrls[0]).toContain("/map-new/mapping.txt");
  });

  it("recomputes an Android inventory with the mapping after the mapping upload, best effort", async () => {
    // No mapping yet: nothing to do.
    expect(await recomputeInventoryAfterMappingUpload(env, "app-1", "build-new")).toBe(false);
    expect(container.calls).toEqual([]);

    addMapping("map-new", "build-new", "ready", 3);
    container.respond = () => Response.json({ inventory: grownInventory() });
    expect(await recomputeInventoryAfterMappingUpload(env, "app-1", "build-new")).toBe(true);
    expect(container.calls).toEqual(["http://container/inventory?platform=android"]);
    expect(container.mappingUrls[0]).toContain("/map-new/mapping.txt");
    expect(sqlite.prepare("SELECT source_asset_id, total_bytes FROM build_inventories WHERE build_id = 'build-new'").get())
      .toEqual({ source_asset_id: "asset-new", total_bytes: 20_000_000 });

    // Wrong app, or a build without an APK: nothing happens.
    expect(await recomputeInventoryAfterMappingUpload(env, "app-2", "build-new")).toBe(false);
    addMapping("map-ios", "build-ios", "ready", 3);
    expect(await recomputeInventoryAfterMappingUpload(env, "app-1", "build-ios")).toBe(false);

    // Container failure is swallowed.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    container.respond = () => Response.json({ error: "boom" }, { status: 422 });
    expect(await recomputeInventoryAfterMappingUpload(env, "app-1", "build-new")).toBe(false);
    expect(error.mock.calls.flat().join(" ")).not.toContain("X-Amz");
    error.mockRestore();
  });

  it("notes when only one of two compared builds had names restored", () => {
    const diff = diffInventories(inventory(), inventory({ mapping: { used: true, classes_mapped: 1, classes_unmapped: 0 } }));
    expect(diff.notes.some((n) => n.includes("newer build only"))).toBe(true);
    expect(diffInventories(inventory(), inventory()).notes.some((n) => n.includes("R8 mapping"))).toBe(false);
  });

  it("removes the inventory when the build is deleted", async () => {
    sqlite.exec(`
      INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code, source, status, created_at, updated_at)
      VALUES ('build-empty', 'app-1', 'channel-1', 'android-apk', 'stable', '0.9.0', 90, 'ci', 'succeeded', 0, 0);
    `);
    const { storeBuildInventory } = await import("../src/routes/build_inventory");
    await storeBuildInventory(env, { appId: "app-1", buildId: "build-empty", inventory: inventory() });
    const res = await call("/api/apps/app-1/builds/build-empty", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(r2.objects.has(inventoryR2Key("app-1", "build-empty"))).toBe(false);
    expect(sqlite.prepare("SELECT count(*) FROM build_inventories").pluck().get()).toBe(0);
  });
});
