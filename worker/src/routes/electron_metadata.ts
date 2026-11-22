/**
 * Replace a published Electron release's update metadata (latest*.yml) without
 * re-publishing: switch delta patches off, or stage a rollout. The installers it
 * describes cannot change (see checkReplacementMetadata). Every replacement is
 * kept and audited; reverting serves the previous one again.
 *
 *   GET  /api/apps/:appId/releases/:releaseId/electron-metadata             list
 *   GET  /api/apps/:appId/releases/:releaseId/electron-metadata/:file       served text
 *   PUT  /api/apps/:appId/releases/:releaseId/electron-metadata/:file       replace (body: YAML)
 *   POST /api/apps/:appId/releases/:releaseId/electron-metadata/:file/revert
 */
import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import {
  ELECTRON_METADATA_MAX_BYTES,
  checkReplacementMetadata,
  currentElectronMetadataOverride,
  electronMetadataOverrideHistory,
  type ElectronMetadataOverride,
} from "../lib/electron_metadata_overrides";
import { candidateNames, isElectronMetadataAsset, type ElectronAssetRow } from "./electron";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type ReleaseRow = { id: string; app_id: string; build_id: string; status: string };

const EDITABLE_STATUSES = new Set(["draft", "active"]);

async function loadRelease(c: AdminContext): Promise<ReleaseRow | null> {
  return c.env.DB.prepare(
    "SELECT id, app_id, build_id, status FROM releases WHERE app_id = ?1 AND id = ?2",
  ).bind(c.req.param("appId") ?? "", c.req.param("releaseId") ?? "").first<ReleaseRow>();
}

async function buildAssets(db: D1Database, buildId: string): Promise<ElectronAssetRow[]> {
  const { results } = await db.prepare(
    `SELECT id, artifact_kind, platform, arch, variant, filetype, r2_key, size_bytes, metadata_json
     FROM build_assets WHERE build_id = ?1
     ORDER BY platform ASC, arch ASC, filetype ASC, created_at ASC`,
  ).bind(buildId).all<ElectronAssetRow>();
  return results ?? [];
}

function fileName(asset: ElectronAssetRow): string {
  return asset.r2_key.split("/").pop() ?? asset.r2_key;
}

function findMetadataAsset(assets: ElectronAssetRow[], file: string): ElectronAssetRow | null {
  return assets.find((asset) => isElectronMetadataAsset(asset) && candidateNames(asset).has(file)) ?? null;
}

function overrideJson(row: ElectronMetadataOverride) {
  return {
    id: row.id,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    created_by: row.created_by,
    created_at: row.created_at,
    reverted_at: row.reverted_at,
    reverted_by: row.reverted_by,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function audit(c: AdminContext, appId: string, action: string, payload: Record<string, unknown>) {
  return c.env.DB.prepare(
    `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(crypto.randomUUID(), appId, action, currentActor(c), JSON.stringify(payload), Date.now());
}

export async function handleListElectronMetadata(c: AdminContext) {
  const release = await loadRelease(c);
  if (!release) return c.json({ error: "release not found" }, 404);
  const assets = (await buildAssets(c.env.DB, release.build_id)).filter(isElectronMetadataAsset);
  const files = await Promise.all(assets.map(async (asset) => {
    const history = await electronMetadataOverrideHistory(c.env.DB, release.id, asset.id);
    const current = history.find((row) => row.reverted_at === null) ?? null;
    return {
      file: fileName(asset),
      asset_id: asset.id,
      platform: asset.platform,
      replaced: current !== null,
      current: current ? overrideJson(current) : null,
      history: history.map(overrideJson),
    };
  }));
  return c.json({ release_id: release.id, status: release.status, files });
}

export async function handleGetElectronMetadata(c: AdminContext) {
  const release = await loadRelease(c);
  if (!release) return c.json({ error: "release not found" }, 404);
  const asset = findMetadataAsset(await buildAssets(c.env.DB, release.build_id), c.req.param("file") ?? "");
  if (!asset) return c.json({ error: "metadata file not found in this release" }, 404);
  const override = await currentElectronMetadataOverride(c.env.DB, release.id, asset.id);
  const object = await c.env.APK_BUCKET.get(override?.r2_key ?? asset.r2_key);
  if (!object) return c.json({ error: "object not found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": "text/yaml; charset=utf-8",
      "cache-control": "no-store",
      "x-hands-metadata-source": override ? `replacement:${override.id}` : "build",
    },
  });
}

export async function handlePutElectronMetadata(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const release = await loadRelease(c);
  if (!release) return c.json({ error: "release not found" }, 404);
  if (!EDITABLE_STATUSES.has(release.status)) {
    return c.json({ error: `a ${release.status} release cannot be changed`, code: "release_not_editable" }, 409);
  }
  const file = c.req.param("file") ?? "";
  const assets = await buildAssets(c.env.DB, release.build_id);
  const asset = findMetadataAsset(assets, file);
  if (!asset) return c.json({ error: "metadata file not found in this release", code: "metadata_not_found" }, 404);

  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > ELECTRON_METADATA_MAX_BYTES) {
    return c.json({ error: `metadata must be at most ${ELECTRON_METADATA_MAX_BYTES} bytes`, code: "metadata_too_large" }, 413);
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return c.json({ error: "metadata must be UTF-8 text", code: "metadata_invalid" }, 400);
  }
  const originalObject = await c.env.APK_BUCKET.get(asset.r2_key);
  if (!originalObject) return c.json({ error: "the build's own metadata is missing" }, 500);
  const originalText = await originalObject.text();

  const fileNames = new Set<string>();
  for (const other of assets) {
    if (isElectronMetadataAsset(other)) continue;
    for (const name of candidateNames(other)) fileNames.add(name);
  }
  const check = checkReplacementMetadata(originalText, text, fileNames);
  if (!check.ok) {
    return c.json({ error: check.error, code: check.code, ...(check.detail ? { detail: check.detail } : {}) },
      check.code === "metadata_too_large" ? 413 : 422);
  }

  const id = crypto.randomUUID();
  const sha256 = await sha256Hex(bytes);
  const r2Key = `apps/${appId}/electron-metadata/${release.id}/${id}/${fileName(asset)}`;
  await c.env.APK_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: "text/yaml; charset=utf-8" } });
  const now = Date.now();
  const actor = currentActor(c);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO electron_metadata_overrides
         (id, release_id, asset_id, r2_key, sha256, size_bytes, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(id, release.id, asset.id, r2Key, sha256, bytes.byteLength, actor, now),
    await audit(c, appId, "release.electron_metadata_replaced", {
      release_id: release.id, file: fileName(asset), override_id: id, sha256,
    }),
  ]);
  const current = await currentElectronMetadataOverride(c.env.DB, release.id, asset.id);
  return c.json({ release_id: release.id, file: fileName(asset), current: current ? overrideJson(current) : null });
}

export async function handleRevertElectronMetadata(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const release = await loadRelease(c);
  if (!release) return c.json({ error: "release not found" }, 404);
  if (!EDITABLE_STATUSES.has(release.status)) {
    return c.json({ error: `a ${release.status} release cannot be changed`, code: "release_not_editable" }, 409);
  }
  const asset = findMetadataAsset(await buildAssets(c.env.DB, release.build_id), c.req.param("file") ?? "");
  if (!asset) return c.json({ error: "metadata file not found in this release", code: "metadata_not_found" }, 404);
  const current = await currentElectronMetadataOverride(c.env.DB, release.id, asset.id);
  if (!current) {
    return c.json({ error: "the build's own metadata is already served", code: "nothing_to_revert" }, 409);
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE electron_metadata_overrides SET reverted_at = ?1, reverted_by = ?2 WHERE id = ?3 AND reverted_at IS NULL",
    ).bind(now, currentActor(c), current.id),
    await audit(c, appId, "release.electron_metadata_reverted", {
      release_id: release.id, file: fileName(asset), override_id: current.id,
    }),
  ]);
  const next = await currentElectronMetadataOverride(c.env.DB, release.id, asset.id);
  return c.json({
    release_id: release.id,
    file: fileName(asset),
    reverted: overrideJson({ ...current, reverted_at: now, reverted_by: currentActor(c) }),
    current: next ? overrideJson(next) : null,
  });
}
