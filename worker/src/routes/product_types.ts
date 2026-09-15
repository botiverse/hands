/**
 * /api/apps/:appId/product-types — list / create / update / delete product types
 *
 * A product type = "what we ship" (android-apk, electron-installer, ios-ipa, ...)
 * User-defined per app. The wizard seeds defaults; admin can add custom ones.
 * See docs/publish-architecture.md v3 §3.3.
 */

import type { Context } from "hono";
import { currentActor } from "../middleware/auth";

export async function handleListProductTypes(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, name, display_name, description, icon,
            supported_platforms_json, default_assets_json,
            parser_kind, schema_json, parent_product_type_id,
            created_at, updated_at
     FROM product_types
     WHERE app_id = ?1
     ORDER BY display_name ASC`,
  ).bind(appId).all();
  return c.json({ product_types: results });
}

export async function handleCreateProductType(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as {
    name: string;
    display_name: string;
    description?: string;
    icon?: string;
    supported_platforms?: string[];
    default_assets?: unknown[];
    parser_kind?: string;
    schema?: Record<string, unknown>;
    parent_product_type_id?: string;
  };
  if (!body.name || !body.display_name) {
    return c.json({ error: "name, display_name required" }, 400);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO product_types
     (id, app_id, name, display_name, description, icon,
      supported_platforms_json, default_assets_json,
      parser_kind, schema_json, parent_product_type_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  ).bind(
    id,
    appId,
    body.name,
    body.display_name,
    body.description ?? null,
    body.icon ?? null,
    JSON.stringify(body.supported_platforms ?? []),
    JSON.stringify(body.default_assets ?? []),
    body.parser_kind ?? "unknown",
    JSON.stringify(body.schema ?? {}),
    body.parent_product_type_id ?? null,
    now,
    now,
  ).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(
    crypto.randomUUID(),
    appId,
    "product_type.create",
    currentActor(c),
    JSON.stringify(body),
    now,
  ).run();

  return c.json(
    { id, app_id: appId, name: body.name, display_name: body.display_name },
    201,
  );
}

export async function handleUpdateProductType(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const ptId = c.req.param("ptId") ?? "";
  const body = (await c.req.json()) as {
    display_name?: string;
    description?: string | null;
    icon?: string | null;
    supported_platforms?: string[];
    default_assets?: unknown[];
    parser_kind?: string;
    schema?: Record<string, unknown>;
  };

  const updates: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.display_name !== undefined) {
    updates.push(`display_name = ?${binds.length + 1}`);
    binds.push(body.display_name);
  }
  if (body.description !== undefined) {
    updates.push(`description = ?${binds.length + 1}`);
    binds.push(body.description || null);
  }
  if (body.icon !== undefined) {
    updates.push(`icon = ?${binds.length + 1}`);
    binds.push(body.icon || null);
  }
  if (body.supported_platforms !== undefined) {
    updates.push(`supported_platforms_json = ?${binds.length + 1}`);
    binds.push(JSON.stringify(body.supported_platforms));
  }
  if (body.default_assets !== undefined) {
    updates.push(`default_assets_json = ?${binds.length + 1}`);
    binds.push(JSON.stringify(body.default_assets));
  }
  if (body.parser_kind !== undefined) {
    updates.push(`parser_kind = ?${binds.length + 1}`);
    binds.push(body.parser_kind);
  }
  if (body.schema !== undefined) {
    updates.push(`schema_json = ?${binds.length + 1}`);
    binds.push(JSON.stringify(body.schema));
  }
  if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);

  updates.push(`updated_at = ?${binds.length + 1}`);
  binds.push(Date.now());
  binds.push(ptId, appId);

  await c.env.DB.prepare(
    `UPDATE product_types SET ${updates.join(", ")} WHERE id = ?${binds.length - 1} AND app_id = ?${binds.length}`,
  ).bind(...binds).run();

  return c.json({ ok: true });
}

export async function handleDeleteProductType(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const ptId = c.req.param("ptId") ?? "";

  // Refuse if any builds reference this product_type
  const buildCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM builds WHERE app_id = ?1 AND product_type = (SELECT name FROM product_types WHERE id = ?2 AND app_id = ?1)",
  ).bind(appId, ptId).first<{ cnt: number }>();
  if (buildCount && buildCount.cnt > 0) {
    return c.json(
      {
        error: `cannot delete product_type with ${buildCount.cnt} build(s)`,
      },
      409,
    );
  }

  await c.env.DB.prepare(
    "DELETE FROM product_types WHERE id = ?1 AND app_id = ?2",
  ).bind(ptId, appId).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(
    crypto.randomUUID(),
    appId,
    "product_type.delete",
    currentActor(c),
    JSON.stringify({ product_type_id: ptId }),
    Date.now(),
  ).run();

  return c.json({ ok: true });
}