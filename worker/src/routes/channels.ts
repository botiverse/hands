/**
 * /api/apps/:appId/channels — list / create channels
 *
 * A "channel" = a label for grouping versions (e.g., production / beta / internal).
 * Stored separately from versions so a version can be moved between channels
 * without re-uploading the APK.
 */

import type { Context } from "hono";

export async function handleListChannels(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId");
  const { results } = await c.env.DB.prepare(
    "SELECT id, app_id, slug, name, created_at FROM channels WHERE app_id = ?1 ORDER BY created_at DESC",
  ).bind(appId).all();
  return c.json({ channels: results });
}

export async function handleCreateChannel(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId");
  const body = (await c.req.json()) as { slug: string; name: string };
  if (!body.slug || !body.name) {
    return c.json({ error: "slug, name required" }, 400);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO channels (id, app_id, slug, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).bind(id, appId, body.slug, body.name, Date.now()).run();
  return c.json({ id, app_id: appId, slug: body.slug, name: body.name }, 201);
}