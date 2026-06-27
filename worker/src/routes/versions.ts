/**
 * /api/apps/:appId/versions — CRUD on app versions
 *
 * A "version" = one uploaded APK with metadata (versionCode, versionName, signature, etc.)
 * and a channel assignment.
 */

import type { Context } from "hono";
import { currentActor } from "../middleware/auth";
import {
  createOperation,
  updateOperation,
} from "./operations";

export async function handleListVersions(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const channel = c.req.query("channel");
  const enabled = c.req.query("enabled");

  const conditions = ["app_id = ?1"];
  const binds: (string | number)[] = [appId];

  if (channel) {
    conditions.push("channel = ?");
    binds.push(channel);
  }
  if (enabled !== undefined) {
    conditions.push("enabled = ?");
    binds.push(enabled === "true" ? 1 : 0);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, channel, version_name, version_code, package_name,
            signature_sha256, min_sdk, target_sdk, size_bytes, file_hash,
            r2_key, enabled, created_at
     FROM versions
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT 100`,
  ).bind(...binds).all();

  return c.json({ versions: results });
}

export async function handleGetVersion(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT v.*, a.slug AS app_slug
     FROM versions v JOIN apps a ON a.id = v.app_id
     WHERE v.app_id = ?1 AND v.id = ?2`,
  ).bind(appId, versionId).first<{ r2_key: string } & Record<string, unknown>>();
  if (!row) return c.json({ error: "not found" }, 404);

  // Issue a signed R2 URL for download (TTL from env).
  // Use the actual r2_key stored on the row (uploaded at apps/<appId>/pending/<hash>.apk).
  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  const downloadUrl = await generateSignedR2Url(c.env, row.r2_key, ttl);

  return c.json({ ...row, download_url: downloadUrl });
}

export async function handleCreateVersion(c: Context<{ Bindings: Env }>) {
  // The actual multipart upload + parse flow happens in 2 stages:
  // 1. POST /api/parse-apk — admin sends APK bytes → Container parses → returns metadata
  // 2. POST /api/versions — admin sends parsed metadata + R2 key (uploaded via signed PUT URL) → DB row
  //
  // For now, accept JSON body with pre-uploaded R2 key + parsed metadata.
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as {
    channel: string;
    version_name: string;
    version_code: number;
    package_name: string;
    signature_sha256: string;
    min_sdk?: number;
    target_sdk?: number;
    size_bytes: number;
    file_hash: string;
    r2_key: string;
  };

  // Validate required fields — versions.r2_key is NOT NULL in schema, so
  // a missing r2_key surfaces as a SQLITE_CONSTRAINT_NOTNULL with no
  // user-friendly error. Validate up front to surface clean 400s.
  if (!body.r2_key) {
    return c.json(
      { error: "r2_key required (upload APK first via /api/apps/:appId/upload)" },
      400,
    );
  }

  // Record operation log (publish step)
  const op = await createOperation(c.env.DB, {
    app_id: appId,
    kind: "publish",
    actor: currentActor(c),
    input: JSON.stringify(body),
  });
  await updateOperation(c.env.DB, op.id, {
    status: "in_progress",
    progress: 0.3,
  });

  const id = crypto.randomUUID();
  try {
    await insertVersion(c.env.DB, appId, body, id);

    await c.env.DB.prepare(
      "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(
        crypto.randomUUID(),
        appId,
        "version.create",
        currentActor(c),
        JSON.stringify(body),
        Date.now(),
      )
      .run();

    await updateOperation(c.env.DB, op.id, {
      status: "success",
      progress: 1,
      output: JSON.stringify({ version_id: id }),
      completed_at: Date.now(),
    });

    return c.json({ id, ...body }, 201);
  } catch (e) {
    await updateOperation(c.env.DB, op.id, {
      status: "failed",
      error: (e as Error).message,
      progress: 1,
      completed_at: Date.now(),
    });
    throw e;
  }
}

/**
 * Insert a versions row from a publish payload. Extracted from
 * handleCreateVersion so the same logic can be re-invoked from the retry
 * endpoint with the original input JSON stored on operation_logs.
 */
export async function insertVersion(
  db: D1Database,
  appId: string,
  body: {
    channel: string;
    version_name: string;
    version_code: number;
    package_name: string;
    signature_sha256: string;
    min_sdk?: number;
    target_sdk?: number;
    size_bytes: number;
    file_hash: string;
    r2_key: string;
  },
  id: string = crypto.randomUUID(),
): Promise<string> {
  await db
    .prepare(
      `INSERT INTO versions
       (id, app_id, channel, version_name, version_code, package_name,
        signature_sha256, min_sdk, target_sdk, size_bytes, file_hash,
        r2_key, enabled, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13)`,
    )
    .bind(
      id,
      appId,
      body.channel,
      body.version_name,
      body.version_code,
      body.package_name,
      body.signature_sha256,
      body.min_sdk ?? null,
      body.target_sdk ?? null,
      body.size_bytes,
      body.file_hash,
      body.r2_key,
      Date.now(),
    )
    .run();
  return id;
}

export async function handleUpdateVersion(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  const body = (await c.req.json()) as { enabled?: boolean; channel?: string };

  const updates: string[] = [];
  const binds: (string | number)[] = [];
  if (body.enabled !== undefined) {
    updates.push(`enabled = ?${binds.length + 1}`);
    binds.push(body.enabled ? 1 : 0);
  }
  if (body.channel !== undefined) {
    updates.push(`channel = ?${binds.length + 1}`);
    binds.push(body.channel);
  }
  if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);

  binds.push(versionId, appId);
  await c.env.DB.prepare(
    `UPDATE versions SET ${updates.join(", ")} WHERE id = ?${binds.length - 1} AND app_id = ?${binds.length}`,
  ).bind(...binds).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "version.update",
      currentActor(c),
      JSON.stringify({ versionId, ...body }),
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
}

export async function handleDeleteVersion(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  await c.env.DB.prepare(
    "DELETE FROM versions WHERE id = ?1 AND app_id = ?2",
  ).bind(versionId, appId).run();
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "version.delete",
      currentActor(c),
      JSON.stringify({ versionId }),
      Date.now(),
    )
    .run();
  return c.json({ ok: true });
}

// Generate a signed URL for an R2 object (works in both Workers and Node tests via @aws-sdk/s3-request-presigner)
async function generateSignedR2Url(env: Env, key: string, ttlSeconds: number): Promise<string> {
  // Workers can use the R2 binding's createPresignedUrl via S3 SDK
  // For now, return a Worker-proxied URL that does the same thing internally
  // TODO: switch to S3 presigner when adding real R2 access keys
  return `/api/r2/${encodeURIComponent(key)}?expires=${Math.floor(Date.now() / 1000) + ttlSeconds}`;
}
