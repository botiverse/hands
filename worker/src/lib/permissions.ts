import type { Context, MiddlewareHandler } from "hono";
import { currentActorInfo, type AdminAccount, type AdminEnv } from "../middleware/auth";

export type OrgRole = "owner" | "admin" | "member" | "viewer";
export type AppRole = "admin" | "publisher" | "viewer";
export type EffectiveRole = OrgRole | AppRole;

type RoleContext = AdminEnv & { Bindings: Env };
export type AdminContext = Context<RoleContext>;

const orgRank: Record<OrgRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

const appRank: Record<AppRole, number> = {
  viewer: 1,
  publisher: 2,
  admin: 3,
};

export function isOrgRole(value: unknown): value is OrgRole {
  return value === "owner" || value === "admin" || value === "member" || value === "viewer";
}

export function isAppRole(value: unknown): value is AppRole {
  return value === "admin" || value === "publisher" || value === "viewer";
}

export function isOrgAtLeast(role: OrgRole | null | undefined, minimum: OrgRole) {
  if (!role) return false;
  return orgRank[role] >= orgRank[minimum];
}

export function isAppAtLeast(role: AppRole | null | undefined, minimum: AppRole) {
  if (!role) return false;
  return appRank[role] >= appRank[minimum];
}

function devTokenBypass(c: AdminContext) {
  return c.get("admin_actor") === "dev-token";
}

export function currentAccount(c: AdminContext): AdminAccount | null {
  return c.get("admin_account") ?? null;
}

export async function getOrgMemberRole(
  db: D1Database,
  orgId: string,
  accountId: string,
): Promise<OrgRole | null> {
  const row = await db
    .prepare(
      `SELECT org_role
       FROM org_members
       WHERE org_id = ?1 AND account_id = ?2
       LIMIT 1`,
    )
    .bind(orgId, accountId)
    .first<{ org_role: OrgRole }>();
  return row?.org_role ?? null;
}

export async function getAppMemberRole(
  db: D1Database,
  appId: string,
  accountId: string,
): Promise<AppRole | null> {
  const row = await db
    .prepare(
      `SELECT app_role
       FROM app_members
       WHERE app_id = ?1 AND account_id = ?2
       LIMIT 1`,
    )
    .bind(appId, accountId)
    .first<{ app_role: AppRole }>();
  return row?.app_role ?? null;
}

export async function getAppServerGrantRole(
  db: D1Database,
  appId: string,
  serverId: string | null | undefined,
  serverSlug?: string | null,
): Promise<AppRole | null> {
  if (!serverId && !serverSlug) return null;
  const row = await db
    .prepare(
      `SELECT app_role
       FROM app_server_grants
       WHERE app_id = ?1
         AND (
           (?2 IS NOT NULL AND server_id = ?3)
           OR (?4 IS NOT NULL AND server_slug = ?5)
         )
       LIMIT 1`,
    )
    .bind(appId, serverId ?? null, serverId ?? null, serverSlug ?? null, serverSlug ?? null)
    .first<{ app_role: AppRole }>();
  return row?.app_role ?? null;
}

export async function getAppOrgId(db: D1Database, appId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT org_id FROM apps WHERE id = ?1 LIMIT 1")
    .bind(appId)
    .first<{ org_id: string | null }>();
  return row?.org_id ?? null;
}

export async function getEffectiveRole(
  db: D1Database,
  accountId: string,
  input: { orgId?: string | null; appId?: string | null },
): Promise<{ org_role: OrgRole | null; app_role: AppRole | null; server_app_role: AppRole | null; org_id: string | null }> {
  const orgId = input.orgId ?? (input.appId ? await getAppOrgId(db, input.appId) : null);
  const account = input.appId
    ? (await db.prepare("SELECT server_id, server_slug FROM raft_accounts WHERE id = ?1 LIMIT 1")
      .bind(accountId)
      .first<{ server_id: string; server_slug: string | null }>()) ?? null
    : null;
  const [orgRole, appRole, serverAppRole] = await Promise.all([
    orgId ? getOrgMemberRole(db, orgId, accountId) : Promise.resolve(null),
    input.appId ? getAppMemberRole(db, input.appId, accountId) : Promise.resolve(null),
    input.appId && account
      ? getAppServerGrantRole(db, input.appId, account.server_id, account.server_slug)
      : Promise.resolve(null),
  ]);
  const roles = [appRole, serverAppRole].filter(Boolean) as AppRole[];
  const effectiveAppRole = roles.sort((a, b) => appRank[b] - appRank[a])[0] ?? null;
  return { org_role: orgRole, app_role: effectiveAppRole, server_app_role: serverAppRole, org_id: orgId };
}

export async function ensureOrgRole(c: AdminContext, orgId: string, minimum: OrgRole) {
  if (devTokenBypass(c)) return { ok: true as const, role: "owner" as OrgRole };
  const account = currentAccount(c);
  if (!account) {
    return { ok: false as const, response: c.json({ error: "unauthorized" }, 401) };
  }
  const role = await getOrgMemberRole(c.env.DB, orgId, account.id);
  if (!isOrgAtLeast(role, minimum)) {
    return {
      ok: false as const,
      response: c.json({ error: "forbidden", required_role: minimum, org_role: role }, 403),
    };
  }
  return { ok: true as const, role };
}

export async function ensureAppRole(c: AdminContext, appId: string, minimum: AppRole) {
  if (devTokenBypass(c)) return { ok: true as const, app_role: "admin" as AppRole, org_role: "owner" as OrgRole };
  const account = currentAccount(c);
  if (!account) {
    return { ok: false as const, response: c.json({ error: "unauthorized" }, 401) };
  }
  const role = await getEffectiveRole(c.env.DB, account.id, { appId });
  const orgAllowsAdmin = isOrgAtLeast(role.org_role, "admin");
  const appAllows = isAppAtLeast(role.app_role, minimum);
  if (!orgAllowsAdmin && !appAllows) {
    return {
      ok: false as const,
      response: c.json(
        {
          error: "forbidden",
          required_role: minimum,
          org_role: role.org_role,
          app_role: role.app_role,
        },
        403,
      ),
    };
  }
  return { ok: true as const, ...role };
}

export function requireOrgRole(paramName: string, minimum: OrgRole): MiddlewareHandler<RoleContext> {
  return async (c, next) => {
    const orgId = c.req.param(paramName);
    if (!orgId) return c.json({ error: `missing ${paramName}` }, 400);
    const allowed = await ensureOrgRole(c, orgId, minimum);
    if (!allowed.ok) return allowed.response;
    await next();
  };
}

export function requireCurrentOrgRole(minimum: OrgRole): MiddlewareHandler<RoleContext> {
  return async (c, next) => {
    const orgId = c.get("org_id");
    if (!orgId) {
      if (devTokenBypass(c)) {
        await next();
        return;
      }
      return c.json({ error: "missing org context" }, 403);
    }
    const allowed = await ensureOrgRole(c, orgId, minimum);
    if (!allowed.ok) return allowed.response;
    await next();
  };
}

export function requireAppRole(minimum: AppRole): MiddlewareHandler<RoleContext> {
  return async (c, next) => {
    const appId = c.req.param("appId");
    if (!appId) return c.json({ error: "missing appId" }, 400);
    const allowed = await ensureAppRole(c, appId, minimum);
    if (!allowed.ok) return allowed.response;
    await next();
  };
}

export async function insertAuditLog(
  db: D1Database,
  c: AdminContext,
  input: {
    app_id: string;
    action: string;
    payload: unknown;
    created_at?: number;
  },
) {
  const actor = currentActorInfo(c);
  await db
    .prepare(
      `INSERT INTO audit_logs
       (id, app_id, action, actor, actor_id, actor_type, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      crypto.randomUUID(),
      input.app_id,
      input.action,
      actor.display_name,
      actor.id,
      actor.type,
      JSON.stringify(input.payload),
      input.created_at ?? Date.now(),
    )
    .run();
}
