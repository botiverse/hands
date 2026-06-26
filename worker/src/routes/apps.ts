/**
 * /api/apps — CRUD on app definitions
 *
 * An "app" = a logical application (e.g., `myapp-android`).
 * Each app has many versions and channels.
 */

import type { Context } from "hono";

export async function handleListApps(c: Context<{ Bindings: Env }>) {
  const { results } = await c.env.DB.prepare(
    "SELECT id, slug, name, platform, created_at FROM apps ORDER BY created_at DESC",
  ).all<{
    id: string;
    slug: string;
    name: string;
    platform: string;
    created_at: number;
  }>();
  return c.json({ apps: results });
}

export async function handleCreateApp(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json()) as { slug: string; name: string; platform: string };
  if (!body.slug || !body.name || !body.platform) {
    return c.json({ error: "slug, name, platform required" }, 400);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).bind(id, body.slug, body.name, body.platform, Date.now()).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(crypto.randomUUID(), id, "app.create", "admin", JSON.stringify(body), Date.now()).run();

  return c.json({ id, slug: body.slug, name: body.name, platform: body.platform }, 201);
}

export async function handleGetApp(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId");
  const row = await c.env.DB.prepare(
    "SELECT id, slug, name, platform, created_at FROM apps WHERE id = ?1",
  ).bind(appId).first<{ id: string; slug: string; name: string; platform: string; created_at: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
}