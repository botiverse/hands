/**
 * GET /public/v2/apps/:slug/testflight/latest — unauthenticated.
 *
 * Lets a TestFlight build of an iOS app compare its own CFBundleVersion with
 * the newest build currently in external TestFlight testing, for apps whose
 * builds never become an active Hands release (so /updates/check has nothing
 * to say). Gated by apps.public_testflight_latest; an unknown, archived, or
 * not-opted-in app all answer the same 404, so the endpoint never reveals
 * whether a slug exists. The response carries only the version identity and
 * state — no ASC ids, group ids, TestFlight links, or download URLs.
 */

import type { Context } from "hono";
import { loadTestflightLatest } from "../lib/testflight_latest";

export async function handlePublicTestflightLatest(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required", code: "slug_required" }, 400);
  const app = await c.env.DB.prepare(
    "SELECT id, public_testflight_latest FROM apps WHERE slug = ?1 AND archived = 0",
  )
    .bind(slug)
    .first<{ id: string; public_testflight_latest: number }>();
  if (!app || !app.public_testflight_latest) {
    return c.json({ error: "not found" }, 404);
  }
  const row = await loadTestflightLatest(c.env.DB, app.id);
  if (!row) {
    return c.json({ error: "no external TestFlight build", code: "no_external_build" }, 404);
  }
  return c.json({
    version_name: row.version_name,
    version_code: row.version_code,
    external_build_state: row.external_build_state,
    updated_at: row.updated_at,
  });
}
