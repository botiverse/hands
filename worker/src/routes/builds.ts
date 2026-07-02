import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { emitWebhookEvent } from "./webhooks";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type JsonRecord = Record<string, unknown>;

export interface BuildInput {
  channel_id: string;
  product_type: string;
  release_type: string;
  version_name: string;
  version_code: number;
  changelog?: string | null;
  source?: string;
  status?: string;
  build_metadata_json?: unknown;
  parsed_metadata_json?: unknown;
  provenance_json?: unknown;
  should_force_update?: boolean;
  availability_at?: number | null;
}

export interface BuildAssetInput {
  artifact_kind?: string;
  platform: string;
  arch?: string | null;
  variant?: string | null;
  filetype: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  signature?: string | null;
  signing_credential_id?: string | null;
  metadata_json?: unknown;
}

interface BuildRow {
  id: string;
  app_id: string;
  channel_id: string | null;
  product_type: string;
  release_type: string;
  version_name: string;
  version_code: number;
  changelog: string | null;
  source: string;
  status: string;
  build_metadata_json: string;
  parsed_metadata_json: string;
  should_force_update: number;
  availability_at: number | null;
  provenance_json: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function jsonString(value: unknown, fallback: JsonRecord = {}): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? fallback);
}

async function insertAuditLog(
  db: D1Database,
  appId: string,
  action: string,
  actor: string,
  payload: unknown,
  now = Date.now(),
) {
  await db
    .prepare(
      "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(crypto.randomUUID(), appId, action, actor, JSON.stringify(payload), now)
    .run();
}

export async function getBuildForApp(
  db: D1Database,
  appId: string,
  buildId: string,
): Promise<BuildRow | null> {
  return await db
    .prepare("SELECT * FROM builds WHERE app_id = ?1 AND id = ?2")
    .bind(appId, buildId)
    .first<BuildRow>();
}

export async function createBuild(
  db: D1Database,
  appId: string,
  input: BuildInput,
  actor: string,
  id = crypto.randomUUID(),
): Promise<string> {
  if (!input.channel_id || !input.product_type) {
    throw new Error("channel_id, product_type required");
  }
  if (!input.version_name || !Number.isFinite(Number(input.version_code))) {
    throw new Error("version_name, version_code required");
  }

  const channel = await db
    .prepare("SELECT id FROM channels WHERE app_id = ?1 AND id = ?2")
    .bind(appId, input.channel_id)
    .first<{ id: string }>();
  if (!channel) throw new Error("channel_id not found for app");

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO builds
       (id, app_id, channel_id, product_type, release_type, version_name,
        version_code, changelog, source, status, build_metadata_json,
        parsed_metadata_json, should_force_update, availability_at,
        provenance_json, created_at, updated_at, completed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
    )
    .bind(
      id,
      appId,
      input.channel_id,
      input.product_type,
      input.release_type ?? "stable",
      input.version_name,
      Number(input.version_code),
      input.changelog ?? null,
      input.source ?? "web",
      input.status ?? "pending",
      jsonString(input.build_metadata_json),
      jsonString(input.parsed_metadata_json),
      input.should_force_update ? 1 : 0,
      input.availability_at ?? null,
      jsonString(input.provenance_json),
      now,
      now,
      input.status === "succeeded" ? now : null,
    )
    .run();

  await insertAuditLog(
    db,
    appId,
    "build.create",
    actor,
    { id, ...input, release_type: input.release_type ?? "stable" },
    now,
  );
  return id;
}

export async function createBuildAsset(
  db: D1Database,
  appId: string,
  buildId: string,
  input: BuildAssetInput,
  actor: string,
  id = crypto.randomUUID(),
): Promise<string> {
  if (!input.platform || !input.filetype || !input.r2_key || !input.file_hash) {
    throw new Error("platform, filetype, r2_key, file_hash required");
  }
  if (!Number.isFinite(Number(input.size_bytes))) {
    throw new Error("size_bytes required");
  }
  const build = await getBuildForApp(db, appId, buildId);
  if (!build) throw new Error("build not found");

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO build_assets
       (id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key, file_hash,
        size_bytes, signature, signing_credential_id, metadata_json,
        download_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14)`,
    )
    .bind(
      id,
      buildId,
      input.artifact_kind ?? "installable",
      input.platform,
      input.arch ?? null,
      input.variant ?? null,
      input.filetype,
      input.r2_key,
      input.file_hash,
      Number(input.size_bytes),
      input.signature ?? null,
      input.signing_credential_id ?? null,
      jsonString(input.metadata_json),
      now,
    )
    .run();

  await insertAuditLog(db, appId, "build_asset.create", actor, { id, buildId, ...input }, now);
  return id;
}

export async function resolveChannelId(
  db: D1Database,
  appId: string,
  channelIdOrSlug: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM channels WHERE app_id = ?1 AND (id = ?2 OR slug = ?3)")
    .bind(appId, channelIdOrSlug, channelIdOrSlug)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function handleListBuilds(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const conditions = ["b.app_id = ?1"];
  const binds: (string | number)[] = [appId];
  const productType = c.req.query("product_type");
  const channel = c.req.query("channel");
  const status = c.req.query("status");
  const versionName = c.req.query("version_name");

  if (productType) {
    conditions.push(`b.product_type = ?${binds.length + 1}`);
    binds.push(productType);
  }
  if (channel) {
    conditions.push(`(c.id = ?${binds.length + 1} OR c.slug = ?${binds.length + 2})`);
    binds.push(channel, channel);
  }
  if (status) {
    conditions.push(`b.status = ?${binds.length + 1}`);
    binds.push(status);
  }
  if (versionName) {
    conditions.push(`b.version_name = ?${binds.length + 1}`);
    binds.push(versionName);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.app_id, b.channel_id, c.slug AS channel, b.product_type,
            b.release_type, b.status, b.version_name, b.version_code,
            b.changelog, b.source, b.should_force_update, b.availability_at,
            b.provenance_json, b.created_at, b.updated_at, b.completed_at
     FROM builds b
     LEFT JOIN channels c ON c.id = b.channel_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY b.created_at DESC
     LIMIT 200`,
  )
    .bind(...binds)
    .all();

  return c.json({ builds: results });
}

export async function handleGetBuild(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT b.*, c.slug AS channel
     FROM builds b
     LEFT JOIN channels c ON c.id = b.channel_id
     WHERE b.app_id = ?1 AND b.id = ?2`,
  )
    .bind(appId, buildId)
    .first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
}

export async function handleCreateBuild(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as BuildInput;
  try {
    const id = await createBuild(c.env.DB, appId, body, currentActor(c));
    // Emit webhook event (P2.5.8). Best-effort.
    const orgId = c.get("org_id");
    if (orgId && (body.status === "succeeded" || body.status === "failed")) {
      c.executionCtx?.waitUntil(
        emitWebhookEvent(c.env.DB, {
          orgId,
          appId,
          event: body.status === "succeeded" ? "build:succeeded" : "build:failed",
          body: { build_id: id, app_id: appId, version_name: body.version_name, version_code: body.version_code },
        }),
      );
    }
    return c.json({ id, app_id: appId, ...body }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
}

export async function handleUpdateBuild(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const body = (await c.req.json()) as {
    changelog?: string | null;
    provenance_json?: unknown;
    should_force_update?: boolean;
    availability_at?: number | null;
    status?: string;
  };
  const existing = await getBuildForApp(c.env.DB, appId, buildId);
  if (!existing) return c.json({ error: "not found" }, 404);

  const updates: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.changelog !== undefined) {
    updates.push(`changelog = ?${binds.length + 1}`);
    binds.push(body.changelog ?? null);
  }
  if (body.provenance_json !== undefined) {
    updates.push(`provenance_json = ?${binds.length + 1}`);
    binds.push(jsonString(body.provenance_json));
  }
  if (body.should_force_update !== undefined) {
    updates.push(`should_force_update = ?${binds.length + 1}`);
    binds.push(body.should_force_update ? 1 : 0);
  }
  if (body.availability_at !== undefined) {
    updates.push(`availability_at = ?${binds.length + 1}`);
    binds.push(body.availability_at ?? null);
  }
  if (body.status !== undefined) {
    updates.push(`status = ?${binds.length + 1}`);
    binds.push(body.status);
    updates.push(`completed_at = ?${binds.length + 1}`);
    binds.push(body.status === "succeeded" || body.status === "failed" ? Date.now() : null);
  }
  if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);

  updates.push(`updated_at = ?${binds.length + 1}`);
  binds.push(Date.now());
  binds.push(buildId, appId);
  await c.env.DB.prepare(
    `UPDATE builds SET ${updates.join(", ")} WHERE id = ?${binds.length - 1} AND app_id = ?${binds.length}`,
  )
    .bind(...binds)
    .run();
  await insertAuditLog(c.env.DB, appId, "build.update", currentActor(c), { buildId, ...body });
  // Emit webhook event (P2.5.8) when status transitions to terminal.
  if (body.status === "succeeded" || body.status === "failed") {
    const orgId = c.get("org_id");
    if (orgId) {
      c.executionCtx?.waitUntil(
        emitWebhookEvent(c.env.DB, {
          orgId,
          appId,
          event: body.status === "succeeded" ? "build:succeeded" : "build:failed",
          body: { build_id: buildId, app_id: appId, status: body.status },
        }),
      );
    }
  }
  return c.json({ ok: true });
}

export async function handleListBuildAssets(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const build = await getBuildForApp(c.env.DB, appId, buildId);
  if (!build) return c.json({ error: "build not found" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key,
            file_hash, size_bytes, signature, signing_credential_id,
            metadata_json, download_count, created_at
     FROM build_assets
     WHERE build_id = ?1
     ORDER BY created_at ASC`,
  )
    .bind(buildId)
    .all();
  return c.json({ assets: results });
}

export async function handleCreateBuildAsset(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const body = (await c.req.json()) as BuildAssetInput;
  try {
    const id = await createBuildAsset(c.env.DB, appId, buildId, body, currentActor(c));
    return c.json({ id, build_id: buildId, ...body }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
}

export async function handleDeleteBuildAsset(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const build = await getBuildForApp(c.env.DB, appId, buildId);
  if (!build) return c.json({ error: "build not found" }, 404);
  const asset = await c.env.DB.prepare(
    "SELECT id FROM build_assets WHERE id = ?1 AND build_id = ?2",
  )
    .bind(assetId, buildId)
    .first<{ id: string }>();
  if (!asset) return c.json({ error: "asset not found" }, 404);

  await c.env.DB.prepare("DELETE FROM build_assets WHERE id = ?1 AND build_id = ?2")
    .bind(assetId, buildId)
    .run();
  await insertAuditLog(c.env.DB, appId, "build_asset.delete", currentActor(c), { buildId, assetId });
  return c.json({ ok: true });
}

export async function handleDeleteBuild(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const build = await getBuildForApp(c.env.DB, appId, buildId);
  if (!build) return c.json({ error: "not found" }, 404);

  const assetCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM build_assets WHERE build_id = ?1",
  )
    .bind(buildId)
    .first<{ cnt: number }>();
  if ((assetCount?.cnt ?? 0) > 0) {
    return c.json({ error: `cannot delete build with ${assetCount!.cnt} asset(s)` }, 409);
  }
  const releaseCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM releases WHERE app_id = ?1 AND build_id = ?2",
  )
    .bind(appId, buildId)
    .first<{ cnt: number }>();
  if ((releaseCount?.cnt ?? 0) > 0) {
    return c.json({ error: `cannot delete build with ${releaseCount!.cnt} release(s)` }, 409);
  }

  await c.env.DB.prepare("DELETE FROM builds WHERE id = ?1 AND app_id = ?2")
    .bind(buildId, appId)
    .run();
  await insertAuditLog(c.env.DB, appId, "build.delete", currentActor(c), { buildId });
  return c.json({ ok: true });
}
