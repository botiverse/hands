/**
 * /api/apps/:appId/audit-logs — append-only audit log
 *
 * Every admin mutation (create app, create version, update version, etc.) inserts a row.
 * This endpoint lists them with actor display info joined from raft_accounts
 * (so the UI can show display_name + @username + agent badge without a
 * second round-trip per row).
 *
 * Filters: ?limit=, ?actor_id=, ?action_prefix=, ?since= (ms epoch)
 */

import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

interface AuditRow {
  id: string;
  app_id: string | null;
  action: string;
  actor: string;
  actor_id: string | null;
  actor_type: string | null;
  actor_display_name: string | null;
  actor_username: string | null;
  actor_avatar_url: string | null;
  actor_server_slug: string | null;
  payload: string;
  created_at: number;
}

function buildWhere(
  appId: string,
  filters: { actorId?: string; actionPrefix?: string; since?: number },
): { sql: string; params: (string | number)[] } {
  const where: string[] = ["l.app_id = ?"];
  const params: (string | number)[] = [appId];
  if (filters.actorId) {
    where.push("l.actor_id = ?");
    params.push(filters.actorId);
  }
  if (filters.actionPrefix) {
    where.push("l.action LIKE ?");
    params.push(`${filters.actionPrefix}%`);
  }
  if (typeof filters.since === "number") {
    where.push("l.created_at >= ?");
    params.push(filters.since);
  }
  return { sql: where.join(" AND "), params };
}

export async function handleListAuditLogs(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const actorId = c.req.query("actor_id");
  const actionPrefix = c.req.query("action_prefix");
  const sinceRaw = c.req.query("since");
  const since = sinceRaw ? Number(sinceRaw) : undefined;

  const { sql: whereSql, params } = buildWhere(appId, {
    ...(actorId ? { actorId } : {}),
    ...(actionPrefix ? { actionPrefix } : {}),
    ...(typeof since === "number" ? { since } : {}),
  });
  params.push(limit);
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.app_id, l.action, l.actor, l.actor_id, l.actor_type,
            a.display_name AS actor_display_name,
            a.username AS actor_username,
            a.avatar_url AS actor_avatar_url,
            a.server_slug AS actor_server_slug,
            l.payload, l.created_at
     FROM audit_logs l
     LEFT JOIN raft_accounts a ON a.id = l.actor_id
     WHERE ${whereSql}
     ORDER BY l.created_at DESC
     LIMIT ?${params.length}`,
  ).bind(...params).all<AuditRow>();
  return c.json({ logs: results });
}

/**
 * GET /api/users/:accountId/audit
 *
 * Scoped query: audit log entries performed BY a single account, across all
 * apps in the org(s) the caller can see. Useful for "what did this person
 * do this week?" admin views.
 *
 * Auth: viewer on at least one app in any of the caller's orgs is enough;
 * we then filter to entries that touch an app in those orgs. Otherwise
 * callers could enumerate across org boundaries.
 */

export async function handleListUserAudit(c: AdminContext) {
  // Resolve caller via auth middleware (sets c.get('admin_account')).
  const caller = c.get("admin_account");
  if (!caller?.id) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const accountId = c.req.param("accountId") ?? "";
  if (!accountId) return c.json({ error: "accountId required" }, 400);
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const sinceRaw = c.req.query("since");
  const since = sinceRaw ? Number(sinceRaw) : undefined;

  // Discover orgs the caller is a member of.
  const { results: callerOrgs } = await c.env.DB.prepare(
    `SELECT org_id FROM org_members WHERE account_id = ?1`,
  ).bind(caller.id).all<{ org_id: string }>();
  const orgIds = callerOrgs.map((r) => r.org_id);
  if (orgIds.length === 0) return c.json({ logs: [], total: 0 });

  // Resolve apps in those orgs.
  const placeholders = orgIds.map(() => "?").join(",");
  const params: (string | number)[] = [accountId];
  let extraWhere = "";
  if (since) {
    extraWhere = " AND l.created_at >= ?";
    params.push(since);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.app_id, a.slug AS app_slug, a.name AS app_name,
            l.action, l.actor, l.actor_id, l.actor_type,
            acc.display_name AS actor_display_name,
            acc.username AS actor_username,
            acc.avatar_url AS actor_avatar_url,
            acc.server_slug AS actor_server_slug,
            l.payload, l.created_at
     FROM audit_logs l
     LEFT JOIN apps a ON a.id = l.app_id
     LEFT JOIN raft_accounts acc ON acc.id = l.actor_id
     WHERE l.actor_id = ?1
       AND a.org_id IN (${placeholders})${extraWhere}
     ORDER BY l.created_at DESC
     LIMIT ?${params.length + 1}`,
  )
    .bind(...params, limit)
    .all<AuditRow & { app_slug: string | null; app_name: string | null }>();
  return c.json({ logs: results, total: results.length });
}