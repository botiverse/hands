/**
 * /api/apps — CRUD on app definitions
 *
 * An "app" = a logical application (e.g., `myapp-android`).
 * Each app has channels, builds, and releases.
 */

import type { Context } from "hono";
import { APP_PLATFORMS, isAppPlatform } from "../lib/app_platform";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { currentAccount, currentDeployToken } from "../lib/permissions";

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
  const deployToken = currentDeployToken(c);
  if (deployToken) {
    const row = await c.env.DB.prepare(
      `SELECT id, org_id, slug, name, platform,
              description, archived, archived_at, created_at, public_history
       FROM apps
       WHERE id = ?1
       LIMIT 1`,
    )
      .bind(deployToken.app_id)
      .first<{
        id: string;
        org_id: string | null;
        slug: string;
        name: string;
        platform: string;
        description: string | null;
        archived: number;
        archived_at: number | null;
        created_at: number;
        public_history: number;
      }>();
    return c.json({ apps: row ? [row] : [] });
  }

  const orgId = c.get("org_id");
  const account = currentAccount(c);
  const query = orgId && account
    ? {
        sql: `SELECT a.id, a.org_id, a.slug, a.name, a.platform,
                     a.description, a.archived, a.archived_at, a.created_at, a.public_history
              FROM apps a
              WHERE a.org_id = ?1
                 OR EXISTS (
                   SELECT 1
                   FROM app_server_grants asg
                   WHERE asg.app_id = a.id
                     AND (
                       asg.server_id = ?2
                       OR (?3 IS NOT NULL AND asg.server_slug = ?4)
                     )
                 )
              ORDER BY a.archived ASC, a.created_at DESC`,
        params: [orgId, account.server_id, account.server_slug ?? null, account.server_slug ?? null],
      }
    : orgId
    ? {
        sql: `SELECT id, org_id, slug, name, platform,
                     description, archived, archived_at, created_at, public_history
              FROM apps
              WHERE org_id = ?1
              ORDER BY archived ASC, created_at DESC`,
        params: [orgId],
      }
    : {
        sql: `SELECT id, org_id, slug, name, platform,
                     description, archived, archived_at, created_at, public_history
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
  if (!isAppPlatform(body.platform)) {
    return c.json(
      {
        error: "unsupported app platform",
        code: "UNSUPPORTED_APP_PLATFORM",
        supported_platforms: APP_PLATFORMS,
      },
      400,
    );
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const orgId = await currentOrgId(c);
  const duplicate = await c.env.DB.prepare(
    "SELECT id FROM apps WHERE slug = ?1 LIMIT 1",
  )
    .bind(body.slug)
    .first<{ id: string }>();
  if (duplicate) {
    return c.json(
      {
        error: "app slug already exists",
        code: "APP_SLUG_CONFLICT",
        slug: body.slug,
      },
      409,
    );
  }

  // Seed default product_types and distribution channels for the new app.
  // (Phase 2.3 app-creation wizard path; small enough to inline here.)
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO apps (id, org_id, slug, name, platform, description, created_at, client_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      ).bind(
        id,
        orgId,
        body.slug,
        body.name,
        body.platform,
        body.description ?? null,
        now,
        generateClientKey(),
      ),
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
      c.env.DB.prepare(
        `INSERT INTO product_types (id, app_id, name, display_name, description, supported_platforms_json, default_assets_json, parser_kind, schema_json, created_at, updated_at) VALUES (?, ?, 'ios-ipa', 'iOS app', 'iOS IPA distributed through TestFlight, ad-hoc, or enterprise lanes', '["ios"]', '[{"platform":"ios","filetype":"ipa"},{"platform":"ios","filetype":"dsym.zip","artifact_kind":"dsym"}]', 'ipa-info', '{"distribution_profile_required":true}', ?, ?)`,
      ).bind(crypto.randomUUID(), id, now, now),
      c.env.DB.prepare(
        `INSERT INTO product_types (id, app_id, name, display_name, description, supported_platforms_json, default_assets_json, parser_kind, schema_json, created_at, updated_at) VALUES (?, ?, 'ohos-app', 'OHOS app', 'Signed App Pack and HAP artifacts for AppGallery and sideloading', '["ohos"]', '[{"platform":"ohos","filetype":"app"},{"platform":"ohos","filetype":"hap"}]', 'ohos-package', '{}', ?, ?)`,
      ).bind(crypto.randomUUID(), id, now, now),
      c.env.DB.prepare(
        `INSERT INTO product_types (id, app_id, name, display_name, description, supported_platforms_json, default_assets_json, parser_kind, schema_json, created_at, updated_at) VALUES (?, ?, 'cli-binary', 'Node / CLI binary', 'Externally hosted Node SEA or CLI binaries', '["darwin-arm64","darwin-x64","linux-arm64","linux-x64","win32-arm64","win32-x64"]', '[]', 'external', '{"external_source":true}', ?, ?)`,
      ).bind(crypto.randomUUID(), id, now, now),
      // channels (with default bundle_id overrides for parallel install)
      c.env.DB.prepare(
        `INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url, enabled_product_types_json, metadata_json, created_at) VALUES (?, ?, 'main', 'Main', NULL, NULL, NULL, '["android-apk","electron-installer","rn-bundle","ios-ipa","ohos-app","cli-binary"]', '{}', ?)`,
      ).bind(crypto.randomUUID(), id, now),
      c.env.DB.prepare(
        `INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url, enabled_product_types_json, metadata_json, created_at) VALUES (?, ?, 'preview', 'Preview', ?, NULL, NULL, '["android-apk","rn-bundle","ios-ipa"]', '{}', ?)`,
      ).bind(crypto.randomUUID(), id, body.slug + ".preview", now),
      c.env.DB.prepare(
        `INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url, enabled_product_types_json, metadata_json, created_at) VALUES (?, ?, 'nightly', 'Nightly', ?, NULL, NULL, '["android-apk"]', '{}', ?)`,
      ).bind(crypto.randomUUID(), id, body.slug + ".nightly", now),
      // audit log
      c.env.DB.prepare(
        "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).bind(
        crypto.randomUUID(),
        id,
        "app.create",
        currentActor(c),
        JSON.stringify(body),
        now,
      ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Preserve the documented 409 contract under a concurrent create race.
    // Other batch failures still reach the global error handler unchanged.
    if (
      message.includes("apps.slug") &&
      (message.includes("UNIQUE") || message.includes("SQLITE_CONSTRAINT"))
    ) {
      return c.json(
        {
          error: "app slug already exists",
          code: "APP_SLUG_CONFLICT",
          slug: body.slug,
        },
        409,
      );
    }
    throw error;
  }

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

/**
 * Hard delete: removes the app row (children cascade) and every R2 object it
 * owns (build assets, feedback attachments, icon, apps/<id>/ prefix). Only
 * allowed on archived apps — archive first, purge second. Irreversible; the
 * DB keeps no tombstone (children cascade), so the response is the record.
 */
export async function handlePurgeApp(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await c.env.DB.prepare(
    "SELECT id, slug, archived, icon_r2_key FROM apps WHERE id = ?1",
  )
    .bind(appId)
    .first<{ id: string; slug: string; archived: number; icon_r2_key: string | null }>();
  if (!app) return c.json({ error: "not found" }, 404);
  if (!app.archived) {
    return c.json({ error: "archive the app before purging it" }, 409);
  }
  const body = (await c.req.json().catch(() => ({}))) as { confirm_slug?: string };
  if (body.confirm_slug !== app.slug) {
    return c.json({ error: "confirm_slug must match the app slug" }, 400);
  }

  // Collect every known R2 key, then sweep the app's prefixes for strays.
  const keys = new Set<string>();
  if (app.icon_r2_key) keys.add(app.icon_r2_key);
  const [assets, attachments] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.r2_key AS r2_key FROM build_assets a
       JOIN builds b ON b.id = a.build_id WHERE b.app_id = ?1`,
    )
      .bind(appId)
      .all<{ r2_key: string }>(),
    c.env.DB.prepare(
      `SELECT fa.r2_key AS r2_key FROM feedback_attachments fa
       JOIN feedback_tickets t ON t.id = fa.ticket_id WHERE t.app_id = ?1`,
    )
      .bind(appId)
      .all<{ r2_key: string }>(),
  ]);
  for (const row of assets.results) keys.add(row.r2_key);
  for (const row of attachments.results) keys.add(row.r2_key);
  for (const prefix of [`apps/${appId}/`, `feedback/${appId}/`]) {
    let cursor: string | undefined;
    do {
      const page = await c.env.APK_BUCKET.list(
        cursor ? { prefix, cursor, limit: 1000 } : { prefix, limit: 1000 },
      );
      for (const obj of page.objects) keys.add(obj.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  const keyList = [...keys];
  for (let i = 0; i < keyList.length; i += 500) {
    await c.env.APK_BUCKET.delete(keyList.slice(i, i + 500));
  }

  // Children (builds, releases, tickets, tokens, audit rows, …) cascade.
  await c.env.DB.prepare("DELETE FROM apps WHERE id = ?1").bind(appId).run();

  console.log(
    `app purged: id=${appId} slug=${app.slug} actor=${currentActor(c)} r2_objects=${keyList.length}`,
  );
  return c.json({ ok: true, purged_app_id: appId, slug: app.slug, r2_objects_deleted: keyList.length });
}

export async function handleGetApp(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT a.id, a.org_id, a.slug, a.name, a.platform, a.description,
            a.archived, a.archived_at, a.created_at, a.public_history,
            a.delta_updates_enabled,
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
    public_history: number;
    delta_updates_enabled: number;
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
    public_history?: boolean;
    delta_updates_enabled?: boolean;
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
  if (body.public_history !== undefined) {
    updates.push("public_history = ?");
    binds.push(body.public_history ? 1 : 0);
  }
  if (body.delta_updates_enabled !== undefined) {
    updates.push("delta_updates_enabled = ?");
    binds.push(body.delta_updates_enabled ? 1 : 0);
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

/** Defaults returned when an app has no explicit feature_flags row for a key. */
const FEATURE_FLAG_DEFAULTS = {
  default_enabled: 0,
  rollout_percent: 0,
  allow_device_ids: "[]",
  deny_device_ids: "[]",
  allow_cohorts: "[]",
  platforms: "[]",
};

/** GET /api/apps/:appId/feature-flags/:key — read a feature flag (viewer). */
export async function handleGetFeatureFlag(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const key = c.req.param("key") ?? "";
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ id: string }>();
  if (!app) return c.json({ error: "not found" }, 404);
  const row = await c.env.DB.prepare(
    `SELECT id, app_id, key, default_enabled, rollout_percent, allow_device_ids,
            deny_device_ids, allow_cohorts, platforms, updated_at, updated_by
     FROM feature_flags WHERE app_id = ?1 AND key = ?2`,
  )
    .bind(appId, key)
    .first();
  if (!row) {
    return c.json({
      app_id: appId,
      key,
      ...FEATURE_FLAG_DEFAULTS,
      updated_at: null,
      updated_by: null,
    });
  }
  return c.json(row);
}

/** PUT /api/apps/:appId/feature-flags/:key — upsert a feature flag (publisher). */
export async function handleUpdateFeatureFlag(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const key = c.req.param("key") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as {
    default_enabled?: boolean;
    rollout_percent?: number;
    allow_device_ids?: string[];
    deny_device_ids?: string[];
    allow_cohorts?: string[];
    platforms?: string[];
  };
  // Confirm app exists.
  const existing = await c.env.DB.prepare("SELECT id FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ id: string }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");

  if (body.rollout_percent !== undefined) {
    if (
      typeof body.rollout_percent !== "number" ||
      !Number.isInteger(body.rollout_percent) ||
      body.rollout_percent < 0 ||
      body.rollout_percent > 100
    ) {
      return c.json({ error: "rollout_percent must be an integer 0..100" }, 400);
    }
  }
  const arrayFields = [
    "allow_device_ids",
    "deny_device_ids",
    "allow_cohorts",
    "platforms",
  ] as const;
  for (const field of arrayFields) {
    if (body[field] !== undefined && !isStringArray(body[field])) {
      return c.json({ error: `${field} must be an array of strings` }, 400);
    }
  }

  // Load the current row (if any) so a partial PUT preserves the other fields.
  const current = await c.env.DB.prepare(
    `SELECT default_enabled, rollout_percent, allow_device_ids, deny_device_ids,
            allow_cohorts, platforms
     FROM feature_flags WHERE app_id = ?1 AND key = ?2`,
  )
    .bind(appId, key)
    .first<{
      default_enabled: number;
      rollout_percent: number;
      allow_device_ids: string;
      deny_device_ids: string;
      allow_cohorts: string;
      platforms: string;
    }>();

  const defaultEnabled =
    body.default_enabled !== undefined
      ? body.default_enabled
        ? 1
        : 0
      : current?.default_enabled ?? 0;
  const rolloutPercent =
    body.rollout_percent !== undefined
      ? body.rollout_percent
      : current?.rollout_percent ?? 0;
  const allowDeviceIds =
    body.allow_device_ids !== undefined
      ? JSON.stringify(body.allow_device_ids)
      : current?.allow_device_ids ?? "[]";
  const denyDeviceIds =
    body.deny_device_ids !== undefined
      ? JSON.stringify(body.deny_device_ids)
      : current?.deny_device_ids ?? "[]";
  const allowCohorts =
    body.allow_cohorts !== undefined
      ? JSON.stringify(body.allow_cohorts)
      : current?.allow_cohorts ?? "[]";
  const platforms =
    body.platforms !== undefined
      ? JSON.stringify(body.platforms)
      : current?.platforms ?? "[]";
  const now = Date.now();
  const actor = currentActor(c);

  await c.env.DB.prepare(
    `INSERT INTO feature_flags
       (id, app_id, key, default_enabled, rollout_percent, allow_device_ids,
        deny_device_ids, allow_cohorts, platforms, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(app_id, key) DO UPDATE SET
       default_enabled = excluded.default_enabled,
       rollout_percent = excluded.rollout_percent,
       allow_device_ids = excluded.allow_device_ids,
       deny_device_ids = excluded.deny_device_ids,
       allow_cohorts = excluded.allow_cohorts,
       platforms = excluded.platforms,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  )
    .bind(
      crypto.randomUUID(),
      appId,
      key,
      defaultEnabled,
      rolloutPercent,
      allowDeviceIds,
      denyDeviceIds,
      allowCohorts,
      platforms,
      now,
      actor,
    )
    .run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "app.feature_flag.update",
      actor,
      JSON.stringify({ key, ...body }),
      now,
    )
    .run();

  return c.json({ ok: true });
}

const APP_ICON_MAX_BYTES = 1024 * 1024;

/** PUT /api/apps/:appId/icon — upload a PNG/WebP app icon (<=1MB). */
export async function handleUploadAppIcon(c: AdminContext) {
  const appId = c.req.param("appId");
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ id: string }>();
  if (!app) return c.json({ error: "app not found" }, 404);

  const contentType = c.req.header("content-type") ?? "";
  if (!/^image\/(png|webp|jpeg)$/.test(contentType)) {
    return c.json({ error: "content-type must be image/png, image/webp, or image/jpeg" }, 400);
  }
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (bytes.byteLength > APP_ICON_MAX_BYTES) {
    return c.json({ error: "icon too large (max 1MB)" }, 400);
  }
  const key = `apps/${appId}/icon`;
  await c.env.APK_BUCKET.put(key, bytes, {
    httpMetadata: { contentType },
  });
  await c.env.DB.prepare("UPDATE apps SET icon_r2_key = ?1 WHERE id = ?2")
    .bind(key, appId)
    .run();
  return c.json({ ok: true, icon_r2_key: key });
}

/** GET /public/apps/:slug/icon — public, cacheable app icon. */
export async function handlePublicAppIcon(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  const app = await c.env.DB.prepare(
    "SELECT icon_r2_key FROM apps WHERE slug = ?1",
  )
    .bind(slug)
    .first<{ icon_r2_key: string | null }>();
  if (!app?.icon_r2_key) return c.json({ error: "no icon" }, 404);
  const object = await c.env.APK_BUCKET.get(app.icon_r2_key);
  if (!object) return c.json({ error: "no icon" }, 404);
  const headers = new Headers({ "cache-control": "public, max-age=300" });
  object.writeHttpMetadata?.(headers);
  return new Response(object.body, { headers });
}

/** qk_-prefixed random client key (Sentry-DSN-style shared credential). */
export function generateClientKey(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `qk_${hex}`;
}

/** POST /api/apps/:appId/rotate-client-key (admin). */
export async function handleRotateClientKey(c: AdminContext) {
  const appId = c.req.param("appId");
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ id: string }>();
  if (!app) return c.json({ error: "app not found" }, 404);
  const key = generateClientKey();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE apps SET client_key = ?1 WHERE id = ?2").bind(key, appId),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?1, ?2, 'app.client_key_rotated', ?3, '{}', ?4)`,
    ).bind(crypto.randomUUID(), appId, currentActor(c), now),
  ]);
  return c.json({ app_id: appId, client_key: key, rotated_at: now });
}

/** GET /api/apps/:appId/client-key (admin) — view the current key. */
export async function handleGetClientKey(c: AdminContext) {
  const appId = c.req.param("appId");
  const app = await c.env.DB.prepare("SELECT client_key FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ client_key: string | null }>();
  if (!app) return c.json({ error: "app not found" }, 404);
  return c.json({ app_id: appId, client_key: app.client_key });
}
