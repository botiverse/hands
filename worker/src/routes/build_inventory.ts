/**
 * Build content inventory routes:
 *   GET  /api/apps/:appId/builds/:buildId/inventory
 *   GET  /api/apps/:appId/builds/:buildId/inventory/diff?against=<buildId|previous>
 *   POST /api/apps/:appId/builds/:buildId/inventory   (recompute from the stored APK/IPA)
 *
 * Storage: the JSON is in R2 at apps/<app>/builds/<build>/inventory.json and
 * build_inventories has one row per build pointing at it (migration 0102).
 */

import type { Context } from "hono";
import { currentActor } from "../middleware/auth";
import {
  diffInventories,
  inventoryR2Key,
  MAX_STORED_INVENTORY_BYTES,
  validateInventory,
  type BuildInventory,
} from "../lib/build_inventory";

type Ctx = Context<{ Bindings: Env }>;

interface BuildRef {
  id: string;
  app_id: string;
  product_type: string;
  version_name: string;
  version_code: number;
  created_at: number;
}

interface InventoryRow {
  build_id: string;
  platform: string;
  r2_key: string;
  source_asset_id: string | null;
  source_file_hash: string | null;
  total_bytes: number;
  generator: string | null;
  computed_at: number;
}

export async function storeBuildInventory(
  env: Env,
  input: { appId: string; buildId: string; inventory: unknown; sourceAssetId?: string | null; sourceFileHash?: string | null },
): Promise<InventoryRow> {
  const inventory = validateInventory(input.inventory);
  const body = JSON.stringify(inventory);
  if (body.length > MAX_STORED_INVENTORY_BYTES) throw new Error("inventory is too large to store");
  const key = inventoryR2Key(input.appId, input.buildId);
  await env.APK_BUCKET.put(key, body, { httpMetadata: { contentType: "application/json" } });
  const row: InventoryRow = {
    build_id: input.buildId,
    platform: inventory.platform,
    r2_key: key,
    source_asset_id: input.sourceAssetId ?? null,
    source_file_hash: input.sourceFileHash ?? null,
    total_bytes: inventory.total_bytes,
    generator: inventory.generator ?? null,
    computed_at: Date.now(),
  };
  await env.DB.prepare(
    `INSERT INTO build_inventories
       (build_id, app_id, platform, schema_version, r2_key, source_asset_id,
        source_file_hash, total_bytes, generator, computed_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(build_id) DO UPDATE SET
       platform = excluded.platform,
       schema_version = excluded.schema_version,
       r2_key = excluded.r2_key,
       source_asset_id = excluded.source_asset_id,
       source_file_hash = excluded.source_file_hash,
       total_bytes = excluded.total_bytes,
       generator = excluded.generator,
       computed_at = excluded.computed_at`,
  ).bind(
    row.build_id, input.appId, row.platform, row.r2_key, row.source_asset_id,
    row.source_file_hash, row.total_bytes, row.generator, row.computed_at,
  ).run();
  return row;
}

async function getBuild(db: D1Database, appId: string, buildId: string): Promise<BuildRef | null> {
  return db.prepare(
    `SELECT id, app_id, product_type, version_name, version_code, created_at
     FROM builds WHERE app_id = ?1 AND id = ?2`,
  ).bind(appId, buildId).first<BuildRef>();
}

async function loadInventory(env: Env, appId: string, buildId: string): Promise<{ row: InventoryRow; inventory: BuildInventory } | null> {
  const row = await env.DB.prepare(
    `SELECT i.build_id, i.platform, i.r2_key, i.source_asset_id, i.source_file_hash,
            i.total_bytes, i.generator, i.computed_at
     FROM build_inventories i
     JOIN builds b ON b.id = i.build_id
     WHERE b.app_id = ?1 AND i.build_id = ?2`,
  ).bind(appId, buildId).first<InventoryRow>();
  if (!row) return null;
  const object = await env.APK_BUCKET.get(row.r2_key);
  if (!object) return null;
  const inventory = validateInventory(JSON.parse(await object.text()));
  return { row, inventory };
}

const buildSummary = (b: BuildRef) => ({
  build_id: b.id,
  version_name: b.version_name,
  version_code: b.version_code,
  product_type: b.product_type,
});

const metaOf = (row: InventoryRow) => ({
  computed_at: row.computed_at,
  source_asset_id: row.source_asset_id,
  source_file_hash: row.source_file_hash,
});

export async function handleGetBuildInventory(c: Ctx) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const build = await getBuild(c.env.DB, appId, buildId);
  if (!build) return c.json({ error: "build not found" }, 404);
  const loaded = await loadInventory(c.env, appId, buildId);
  if (!loaded) {
    return c.json({
      error: "this build has no content inventory yet; POST to this URL to compute it from the build's APK or IPA",
      code: "INVENTORY_MISSING",
      build_id: buildId,
    }, 404);
  }
  return c.json({ build: buildSummary(build), ...metaOf(loaded.row), inventory: loaded.inventory });
}

/** The build before this one: same app and product type, next lower version code (ties: created earlier). */
export async function previousBuild(db: D1Database, build: BuildRef): Promise<BuildRef | null> {
  return db.prepare(
    `SELECT id, app_id, product_type, version_name, version_code, created_at
     FROM builds
     WHERE app_id = ?1 AND product_type = ?2 AND id <> ?3
       AND (version_code < ?4 OR (version_code = ?4 AND created_at < ?5))
     ORDER BY version_code DESC, created_at DESC
     LIMIT 1`,
  ).bind(build.app_id, build.product_type, build.id, build.version_code, build.created_at).first<BuildRef>();
}

export async function handleBuildInventoryDiff(c: Ctx) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const against = (c.req.query("against") ?? "previous").trim() || "previous";
  const head = await getBuild(c.env.DB, appId, buildId);
  if (!head) return c.json({ error: "build not found" }, 404);
  const base = against === "previous" ? await previousBuild(c.env.DB, head) : await getBuild(c.env.DB, appId, against);
  if (!base) {
    return against === "previous"
      ? c.json({ error: "no earlier build of this product type to compare with", code: "NO_PREVIOUS_BUILD" }, 404)
      : c.json({ error: "comparison build not found", code: "AGAINST_NOT_FOUND" }, 404);
  }
  const [headInv, baseInv] = await Promise.all([
    loadInventory(c.env, appId, head.id),
    loadInventory(c.env, appId, base.id),
  ]);
  if (!headInv || !baseInv) {
    const missing = !headInv ? head : base;
    return c.json({
      error: `build ${missing.version_name} (${missing.version_code}) has no content inventory yet; compute it with POST /api/apps/${appId}/builds/${missing.id}/inventory`,
      code: "INVENTORY_MISSING",
      build_id: missing.id,
      base: buildSummary(base),
      head: buildSummary(head),
    }, 404);
  }
  if (headInv.inventory.platform !== baseInv.inventory.platform) {
    return c.json({ error: "the two builds are for different platforms", code: "PLATFORM_MISMATCH" }, 409);
  }
  return c.json({
    base: { ...buildSummary(base), ...metaOf(baseInv.row) },
    head: { ...buildSummary(head), ...metaOf(headInv.row) },
    diff: diffInventories(baseInv.inventory, headInv.inventory),
  });
}

interface InstallableAsset {
  id: string;
  platform: "android" | "ios";
  filetype: string;
  r2_key: string;
  file_hash: string;
}

export async function handleRefreshBuildInventory(c: Ctx) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const build = await getBuild(c.env.DB, appId, buildId);
  if (!build) return c.json({ error: "build not found" }, 404);
  const asset = await c.env.DB.prepare(
    `SELECT id, platform, filetype, r2_key, file_hash
     FROM build_assets
     WHERE build_id = ?1 AND artifact_kind = 'installable'
       AND ((platform = 'android' AND filetype = 'apk') OR (platform = 'ios' AND filetype = 'ipa'))
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(buildId).first<InstallableAsset>();
  if (!asset) {
    return c.json({ error: "this build has no APK or IPA to read", code: "NO_INSTALLABLE_PACKAGE" }, 409);
  }
  const object = await c.env.APK_BUCKET.get(asset.r2_key);
  if (!object) {
    return c.json({ error: "the build's package file is not in storage", code: "PACKAGE_NOT_STORED" }, 409);
  }
  let inventory: unknown;
  try {
    inventory = await fetchInventoryFromContainer(c.env, asset.platform, await object.arrayBuffer());
  } catch (err) {
    return c.json({ error: `inventory extraction failed: ${err instanceof Error ? err.message : String(err)}`, code: "INVENTORY_FAILED" }, 502);
  }
  let row: InventoryRow;
  try {
    row = await storeBuildInventory(c.env, {
      appId, buildId, inventory, sourceAssetId: asset.id, sourceFileHash: asset.file_hash,
    });
  } catch (err) {
    return c.json({ error: `inventory could not be stored: ${err instanceof Error ? err.message : String(err)}`, code: "INVENTORY_INVALID" }, 502);
  }
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(
    crypto.randomUUID(), appId, "build.inventory.refresh", currentActor(c),
    JSON.stringify({ buildId, assetId: asset.id }), row.computed_at,
  ).run();
  return c.json({ build: buildSummary(build), ...metaOf(row), inventory: validateInventory(inventory) });
}

async function fetchInventoryFromContainer(env: Env, platform: "android" | "ios", bytes: ArrayBuffer): Promise<unknown> {
  // Lazy import: @cloudflare/containers needs the Workers runtime.
  const { getRandom } = await import("@cloudflare/containers");
  const container = await getRandom(env.APK_PARSER, 1);
  const res = await container.fetch(new Request(`http://container/inventory?platform=${platform}`, {
    method: "POST",
    body: bytes,
    headers: { "content-type": "application/octet-stream" },
  }));
  const body = (await res.json().catch(() => ({}))) as { inventory?: unknown; error?: string };
  if (!res.ok || !body.inventory) throw new Error(body.error ?? `container returned ${res.status}`);
  return body.inventory;
}
