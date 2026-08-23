import type { Context } from "hono";
import { currentActorInfo, type AdminEnv } from "../middleware/auth";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type IntegrationRow = {
  id: string;
  app_id: string;
  name: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

export async function handleListReporterIntegrations(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const includeArchived = c.req.query("include_archived") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, name, created_at, updated_at, archived_at
     FROM app_reporter_integrations
     WHERE app_id = ?1 AND (?2 = 1 OR archived_at IS NULL)
     ORDER BY archived_at IS NULL DESC, created_at DESC, id DESC`,
  )
    .bind(appId, includeArchived ? 1 : 0)
    .all<IntegrationRow>();
  return c.json({ reporter_integrations: results });
}

export async function handleCreateReporterIntegration(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);
  if (name.length > 80) return c.json({ error: "name must be 80 characters or fewer" }, 400);

  const id = crypto.randomUUID();
  const now = Date.now();
  const actor = currentActorInfo(c);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO app_reporter_integrations
         (id, app_id, name, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?4, NULL)`,
      ).bind(id, appId, name, now),
      c.env.DB.prepare(
        `INSERT INTO audit_logs
         (id, app_id, action, actor, actor_id, actor_type, payload, created_at)
         VALUES (?1, ?2, 'reporter_integration.create', ?3, ?4, ?5, ?6, ?7)`,
      ).bind(
        crypto.randomUUID(),
        appId,
        actor.display_name,
        actor.id,
        actor.type,
        JSON.stringify({ integration_id: id, name }),
        now,
      ),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return c.json({ error: "a reporter integration with this name already exists" }, 409);
    }
    throw error;
  }
  return c.json({ id, app_id: appId, name, created_at: now, updated_at: now, archived_at: null }, 201);
}

export async function handleUpdateReporterIntegration(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const integrationId = c.req.param("integrationId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
  if (typeof body.archived !== "boolean") {
    return c.json({ error: "archived must be a boolean" }, 400);
  }
  const existing = await c.env.DB.prepare(
    `SELECT id, archived_at FROM app_reporter_integrations
     WHERE id = ?1 AND app_id = ?2`,
  )
    .bind(integrationId, appId)
    .first<{ id: string; archived_at: number | null }>();
  if (!existing) return c.json({ error: "reporter integration not found" }, 404);

  const alreadyArchived = existing.archived_at !== null;
  if (alreadyArchived === body.archived) {
    return c.json({ id: integrationId, archived: alreadyArchived, changed: false });
  }

  const now = Date.now();
  const actor = currentActorInfo(c);
  const auditPayload = JSON.stringify({ integration_id: integrationId, archived: body.archived });
  const statements = [
    c.env.DB.prepare(
      `UPDATE app_reporter_integrations
       SET archived_at = ?1, updated_at = ?2
       WHERE id = ?3 AND app_id = ?4`,
    ).bind(body.archived ? now : null, now, integrationId, appId),
  ];
  if (body.archived) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE app_deploy_tokens SET revoked_at = ?1
         WHERE app_id = ?2 AND reporter_integration_id = ?3 AND revoked_at IS NULL`,
      ).bind(now, appId, integrationId),
    );
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO audit_logs
       (id, app_id, action, actor, actor_id, actor_type, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      crypto.randomUUID(),
      appId,
      body.archived ? "reporter_integration.archive" : "reporter_integration.unarchive",
      actor.display_name,
      actor.id,
      actor.type,
      auditPayload,
      now,
    ),
  );
  await c.env.DB.batch(statements);
  return c.json({ id: integrationId, archived: body.archived, changed: true });
}
