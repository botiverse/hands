/**
 * /api/apps/:appId/channels — list / create / update / delete channels
 *
 * A "channel" = a deployment lane (e.g., production / beta / internal).
 * Phase 1: channels carry bundle_id (parallel install override), password
 * (gated download), git_url (source URL this channel tracks), and a list
 * of enabled product_types.
 */

import type { Context } from "hono";
import { currentActor } from "../middleware/auth";

export async function handleListChannels(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, slug, name, bundle_id, password, git_url,
            enabled_product_types_json, metadata_json, created_at
     FROM channels WHERE app_id = ?1 ORDER BY created_at ASC`,
  ).bind(appId).all();
  return c.json({ channels: results });
}

export async function handleCreateChannel(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as {
    slug: string;
    name: string;
    bundle_id?: string;
    password?: string;
    git_url?: string;
    enabled_product_types?: string[];
    metadata?: Record<string, unknown>;
  };
  if (!body.slug || !body.name) {
    return c.json({ error: "slug, name required" }, 400);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO channels
     (id, app_id, slug, name, bundle_id, password, git_url,
      enabled_product_types_json, metadata_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(
    id,
    appId,
    body.slug,
    body.name,
    body.bundle_id ?? null,
    body.password ?? null,
    body.git_url ?? null,
    JSON.stringify(body.enabled_product_types ?? []),
    JSON.stringify(body.metadata ?? {}),
    now,
  ).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "channel.create",
      currentActor(c),
      JSON.stringify(body),
      now,
    )
    .run();

  return c.json({ id, app_id: appId, slug: body.slug, name: body.name }, 201);
}

export async function handleUpdateChannel(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const channelId = c.req.param("channelId") ?? "";
  const body = (await c.req.json()) as {
    name?: string;
    bundle_id?: string | null;
    password?: string | null;
    git_url?: string | null;
    enabled_product_types?: string[];
    metadata?: Record<string, unknown>;
  };

  const updates: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.name !== undefined) {
    updates.push(`name = ?${binds.length + 1}`);
    binds.push(body.name);
  }
  if (body.bundle_id !== undefined) {
    updates.push(`bundle_id = ?${binds.length + 1}`);
    binds.push(body.bundle_id || null);
  }
  if (body.password !== undefined) {
    updates.push(`password = ?${binds.length + 1}`);
    binds.push(body.password || null);
  }
  if (body.git_url !== undefined) {
    updates.push(`git_url = ?${binds.length + 1}`);
    binds.push(body.git_url || null);
  }
  if (body.enabled_product_types !== undefined) {
    updates.push(`enabled_product_types_json = ?${binds.length + 1}`);
    binds.push(JSON.stringify(body.enabled_product_types));
  }
  if (body.metadata !== undefined) {
    updates.push(`metadata_json = ?${binds.length + 1}`);
    binds.push(JSON.stringify(body.metadata));
  }
  if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);

  binds.push(channelId, appId);
  await c.env.DB.prepare(
    `UPDATE channels SET ${updates.join(", ")} WHERE id = ?${binds.length - 1} AND app_id = ?${binds.length}`,
  ).bind(...binds).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "channel.update",
      currentActor(c),
      JSON.stringify(body),
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
}

export async function handleDeleteChannel(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const channelId = c.req.param("channelId") ?? "";

  const usageCount = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM releases WHERE app_id = ?1 AND channel_id = ?2) AS release_count,
       (SELECT COUNT(*) FROM builds WHERE app_id = ?1 AND channel_id = ?2) AS build_count`,
  ).bind(appId, channelId).first<{ release_count: number; build_count: number }>();
  if (usageCount && (usageCount.release_count > 0 || usageCount.build_count > 0)) {
    return c.json(
      {
        error: `cannot delete channel with ${usageCount.release_count} release(s) and ${usageCount.build_count} build(s); move or delete them first`,
      },
      409,
    );
  }

  await c.env.DB.prepare(
    "DELETE FROM channels WHERE id = ?1 AND app_id = ?2",
  ).bind(channelId, appId).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "channel.delete",
      currentActor(c),
      JSON.stringify({ channel_id: channelId }),
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
}
