/**
 * /api/apps — CRUD on app definitions
 *
 * An "app" = a logical application (e.g., `myapp-android`).
 * Each app has many versions and channels.
 */

import type { Context } from "hono";
import { currentActor } from "../middleware/auth";

export async function handleListApps(c: Context<{ Bindings: Env }>) {
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, name, platform, description, archived, archived_at, created_at
     FROM apps ORDER BY archived ASC, created_at DESC`,
  ).all<{
    id: string;
    slug: string;
    name: string;
    platform: string;
    description: string | null;
    archived: number;
    archived_at: number | null;
    created_at: number;
  }>();
  return c.json({ apps: results });
}

export async function handleCreateApp(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json()) as {
    slug: string;
    name: string;
    platform: string;
    description?: string;
  };
  if (!body.slug || !body.name || !body.platform) {
    return c.json({ error: "slug, name, platform required" }, 400);
  }
  const id = crypto.randomUUID();
  const now = Date.now();

  // Seed default product_types, release_types, channels for the new app.
  // (Phase 2.3 app-creation wizard path; small enough to inline here.)
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO apps (id, slug, name, platform, description, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(id, body.slug, body.name, body.platform, body.description ?? null, now),
    // product_types
    c.env.DB.prepare(
      `INSERT INTO product_types (id, app_id, name, display_name, description, supported_platforms_json, default_assets_json, parser_kind, schema_json, created_at, updated_at) VALUES (?, ?, 'android-apk', 'Android APK', 'Android application package', '[]', '[{"platform":"android","filetype":"apk"}]', 'apk-aapt', '{"requires_native_codes":true}', ?, ?)`,
    ).bind(crypto.randomUUID(), id, now, now),
    c.env.DB.prepare(
      `INSERT INTO product_types (id, app_id, name, display_name, description, supported_platforms_json, default_assets_json, parser_kind, schema_json, created_at, updated_at) VALUES (?, ?, 'electron-installer', 'Electron desktop app', 'Cross-platform desktop app', '["darwin-arm64","darwin-x64","linux-x64","linux-arm64","win32-x64","win32-arm64"]', '[{"platform":"darwin-arm64","filetype":"dmg"}]', 'electron-asar', '{}', ?, ?)`,
    ).bind(crypto.randomUUID(), id, now, now),
    c.env.DB.prepare(
      `INSERT INTO product_types (id, app_id, name, display_name, description, supported_platforms_json, default_assets_json, parser_kind, schema_json, created_at, updated_at) VALUES (?, ?, 'rn-bundle', 'React Native OTA bundle', 'JS bundle hot-update', '[]', '[{"platform":"rn","filetype":"bundle"}]', 'rn-bundle', '{}', ?, ?)`,
    ).bind(crypto.randomUUID(), id, now, now),
    // release_types
    c.env.DB.prepare(
      `INSERT INTO release_types (id, app_id, name, display_name, color, description, created_at, updated_at) VALUES (?, ?, 'stable', 'Stable', '#10b981', 'Production-ready', ?, ?)`,
    ).bind(crypto.randomUUID(), id, now, now),
    c.env.DB.prepare(
      `INSERT INTO release_types (id, app_id, name, display_name, color, description, created_at, updated_at) VALUES (?, ?, 'rc', 'RC', '#3b82f6', 'Release candidate', ?, ?)`,
    ).bind(crypto.randomUUID(), id, now, now),
    c.env.DB.prepare(
      `INSERT INTO release_types (id, app_id, name, display_name, color, description, created_at, updated_at) VALUES (?, ?, 'beta', 'Beta', '#f59e0b', 'Public beta', ?, ?)`,
    ).bind(crypto.randomUUID(), id, now, now),
    c.env.DB.prepare(
      `INSERT INTO release_types (id, app_id, name, display_name, color, description, created_at, updated_at) VALUES (?, ?, 'internal', 'Internal', '#6b7280', 'Internal team only', ?, ?)`,
    ).bind(crypto.randomUUID(), id, now, now),
    // channels (with default bundle_id overrides for parallel install)
    c.env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url, enabled_product_types_json, metadata_json, created_at) VALUES (?, ?, 'production', 'Production', NULL, NULL, NULL, '["android-apk","electron-installer","rn-bundle"]', '{}', ?)`,
    ).bind(crypto.randomUUID(), id, now),
    c.env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url, enabled_product_types_json, metadata_json, created_at) VALUES (?, ?, 'beta', 'Beta', ?, NULL, NULL, '["android-apk","rn-bundle"]', '{}', ?)`,
    ).bind(crypto.randomUUID(), id, body.slug + '.beta', now),
    c.env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url, enabled_product_types_json, metadata_json, created_at) VALUES (?, ?, 'internal', 'Internal', ?, NULL, NULL, '["android-apk"]', '{}', ?)`,
    ).bind(crypto.randomUUID(), id, body.slug + '.internal', now),
    // audit log
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(crypto.randomUUID(), id, "app.create", currentActor(c), JSON.stringify(body), now),
  ]);

  return c.json({ id, slug: body.slug, name: body.name, platform: body.platform }, 201);
}

export async function handleArchiveApp(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as { archived?: boolean };
  const targetArchived = body.archived !== false; // default to true (archive action)
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE apps SET archived = ?1, archived_at = CASE WHEN ?1 = 1 THEN ?2 ELSE NULL END WHERE id = ?3`,
  ).bind(targetArchived ? 1 : 0, now, appId).run();
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      targetArchived ? "app.archive" : "app.unarchive",
      currentActor(c),
      JSON.stringify({ archived: targetArchived }),
      now,
    )
    .run();
  return c.json({ ok: true, archived: targetArchived });
}

export async function handleGetApp(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT id, slug, name, platform, description, archived, archived_at, created_at
     FROM apps WHERE id = ?1`,
  ).bind(appId).first<{
    id: string;
    slug: string;
    name: string;
    platform: string;
    description: string | null;
    archived: number;
    archived_at: number | null;
    created_at: number;
  }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
}
