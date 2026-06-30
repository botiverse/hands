/**
 * /public/* routes — client-facing endpoints (no auth required).
 *
 * Designed for clients that need public app metadata by app slug
 * (human-readable) instead of internal app UUID.
 */

import type { Context } from "hono";

export async function handlePublicListChannels(
  c: Context<{ Bindings: Env }>,
) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);

  const app = await c.env.DB.prepare(
    "SELECT id, slug FROM apps WHERE slug = ?",
  )
    .bind(slug)
    .first<{ id: string; slug: string }>();

  if (!app) return c.json({ error: `app '${slug}' not found` }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT slug, name FROM channels WHERE app_id = ?1 ORDER BY slug`,
  )
    .bind(app.id)
    .all();

  return c.json({ app: app.slug, channels: results });
}
