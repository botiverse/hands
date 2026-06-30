/**
 * /api/apps — CRUD on app definitions
 *
 * An "app" = a logical application (e.g., `myapp-android`).
 * Each app has channels, builds, and releases.
 */

import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

async function currentOrgId(c: AdminContext): Promise<string> {
  const orgId = c.get("org_id");
  if (orgId) return orgId;
  const row = await c.env.DB.prepare(
    "SELECT id FROM organizations WHERE id = 'default' LIMIT 1",
  ).first<{ id: string }>();
  return row?.id || "default";
}

export async function handleListApps(c: AdminContext) {
  const orgId = c.get("org_id");
  const query = orgId
    ? {
        sql: `SELECT id, org_id, slug, name, platform, description, archived, archived_at, created_at
              FROM apps
              WHERE org_id = ?1
              ORDER BY archived ASC, created_at DESC`,
        params: [orgId],
      }
    : {
        sql: `SELECT id, org_id, slug, name, platform, description, archived, archived_at, created_at
              FROM apps
              ORDER BY archived ASC, created_at DESC`,
        params: [],
      };
  const { results } = await c.env.DB.prepare(
    query.sql,
  ).bind(...query.params).all<{
    id: string;
    org_id: string | null;
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

export async function handleCreateApp(c: AdminContext) {
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
  const orgId = await currentOrgId(c);

  // Seed default product_types and distribution channels for the new app.
  // (Phase 2.3 app-creation wizard path; small enough to inline here.)
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO apps (id, org_id, slug, name, platform, description, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(id, orgId, body.slug, body.name, body.platform, body.description ?? null, now),
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
    // channels (with default bundle_id overrides for parallel install)
    c.env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url, enabled_product_types_json, metadata_json, created_at) VALUES (?, ?, 'main', 'Main', NULL, NULL, NULL, '["android-apk","electron-installer","rn-bundle"]', '{}', ?)`,
    ).bind(crypto.randomUUID(), id, now),
    c.env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url, enabled_product_types_json, metadata_json, created_at) VALUES (?, ?, 'preview', 'Preview', ?, NULL, NULL, '["android-apk","rn-bundle"]', '{}', ?)`,
    ).bind(crypto.randomUUID(), id, body.slug + '.preview', now),
    c.env.DB.prepare(
      `INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url, enabled_product_types_json, metadata_json, created_at) VALUES (?, ?, 'nightly', 'Nightly', ?, NULL, NULL, '["android-apk"]', '{}', ?)`,
    ).bind(crypto.randomUUID(), id, body.slug + '.nightly', now),
    // audit log
    c.env.DB.prepare(
      "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(crypto.randomUUID(), id, "app.create", currentActor(c), JSON.stringify(body), now),
  ]);

  return c.json({ id, org_id: orgId, slug: body.slug, name: body.name, platform: body.platform }, 201);
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
    `SELECT a.id, a.org_id, a.slug, a.name, a.platform, a.description,
            a.archived, a.archived_at, a.created_at,
            a.default_channel_id,
            ch.slug AS default_channel_slug,
            ch.name AS default_channel_name
     FROM apps a
     LEFT JOIN channels ch ON ch.id = a.default_channel_id
     WHERE a.id = ?1`,
  ).bind(appId).first<{
    id: string;
    org_id: string | null;
    slug: string;
    name: string;
    platform: string;
    description: string | null;
    archived: number;
    archived_at: number | null;
    created_at: number;
    default_channel_id: string | null;
    default_channel_slug: string | null;
    default_channel_name: string | null;
  }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
}

export async function handleUpdateApp(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string | null;
    default_channel_id?: string | null;
  };
  // Confirm app exists.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM apps WHERE id = ?1`,
  ).bind(appId).first<{ id: string }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const updates: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name must be a non-empty string" }, 400);
    }
    updates.push("name = ?");
    binds.push(body.name.trim());
  }
  if (body.description !== undefined) {
    updates.push("description = ?");
    binds.push(body.description ?? null);
  }
  if (body.default_channel_id !== undefined) {
    if (body.default_channel_id === null) {
      updates.push("default_channel_id = ?");
      binds.push(null);
    } else {
      const ch = await c.env.DB
        .prepare("SELECT id FROM channels WHERE id = ?1 AND app_id = ?2")
        .bind(body.default_channel_id, appId)
        .first<{ id: string }>();
      if (!ch) {
        return c.json(
          { error: "default_channel_id does not belong to this app" },
          400,
        );
      }
      updates.push("default_channel_id = ?");
      binds.push(body.default_channel_id);
    }
  }
  if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);

  await c.env.DB.prepare(
    `UPDATE apps SET ${updates.join(", ")} WHERE id = ?${binds.length + 1}`,
  ).bind(...binds, appId).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "app.update",
      currentActor(c),
      JSON.stringify(body),
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
}
