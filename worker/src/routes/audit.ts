/**
 * /api/apps/:appId/audit-logs — append-only audit log
 *
 * Every admin mutation (create app, create version, update version, etc.) inserts a row.
 * This endpoint just lists them.
 */

import type { Context } from "hono";

export async function handleListAuditLogs(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId");
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, action, actor, payload, created_at
     FROM audit_logs
     WHERE app_id = ?1
     ORDER BY created_at DESC
     LIMIT ?2`,
  ).bind(appId, limit).all();
  return c.json({ logs: results });
}