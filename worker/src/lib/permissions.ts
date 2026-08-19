import type { Context, MiddlewareHandler } from "hono";
import { currentActorInfo, type AdminAccount, type AdminEnv } from "../middleware/auth";
import {
  hasDeployTokenPermission,
  resolveDeployTokenPermissions,
  type AppDeployToken,
} from "./deploy_tokens";
import {
  APP_PERMISSION_MINIMUM_ROLE,
  isAppAtLeast,
  isAppRole,
  strongestAppRole,
  type AppRole,
  type AppPermission,
} from "./app_permissions";
import { dashboardOrigin } from "./origin";

export { isAppAtLeast, isAppRole } from "./app_permissions";
export type { AppRole, AppPermission } from "./app_permissions";

export type OrgRole = "owner" | "admin" | "member" | "viewer";
export type EffectiveRole = OrgRole | AppRole;

type RoleContext = AdminEnv & { Bindings: Env };
export type AdminContext = Context<RoleContext>;

const orgRank: Record<OrgRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export function isOrgRole(value: unknown): value is OrgRole {
  return value === "owner" || value === "admin" || value === "member" || value === "viewer";
}

export function isOrgAtLeast(role: OrgRole | null | undefined, minimum: OrgRole) {
  if (!role) return false;
  return orgRank[role] >= orgRank[minimum];
}

function devTokenBypass(c: AdminContext) {
  return c.get("admin_actor") === "dev-token";
}

// App ids are UUIDs. A caller that passes a truncated/partial id (e.g. the
// 8-char short id `hands apps list` used to print) must fail as a client error
// AT THE RESOLUTION BOUNDARY — before any DB lookup or role check — with an
// explicit "use the full app id", instead of falling through to the role check
// and returning a misleading INSUFFICIENT_APP_ROLE.
//
// This is a SHAPE check only: it rejects an id built solely from UUID characters
// (hex + dashes) that is not a complete UUID — i.e. a truncated UUID. A
// well-formed UUID that simply does not exist (or that the caller may not access)
// is NOT rejected here; it continues to the normal indistinguishable role error,
// so this never becomes an app-existence oracle. Anything containing a non-UUID
// character (the synthetic slug-like ids used in tests, future schemes) is left
// untouched.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function appIdShapeError(c: AdminContext, appId: string) {
  if (UUID_RE.test(appId)) return null;
  if (!/^[0-9a-f-]+$/i.test(appId)) return null;
  return c.json(
    {
      error: "invalid_app_id",
      code: "EXACT_APP_ID_REQUIRED",
      next_action:
        `'${appId}' is not a complete app id. Pass the full app UUID ` +
        `(the ID column of \`hands apps list\`), not a shortened or partial id.`,
      app_id: appId,
    },
    400,
  );
}

export function currentAccount(c: AdminContext): AdminAccount | null {
  return c.get("admin_account") ?? null;
}

export function currentDeployToken(c: AdminContext): AppDeployToken | null {
  return c.get("admin_deploy_token") ?? null;
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

async function getOwnerServerRole(
  db: D1Database,
  appId: string,
  accountId: string,
  serverId: string,
  serverSlug: string | null,
): Promise<{ org_role: OrgRole | null; legacy_app_role: AppRole | null } | null> {
  const row = await db.prepare(
    `SELECT om.org_role, asg.app_role, asg.access_model
       FROM organizations o
       JOIN org_members om ON om.org_id = o.id AND om.account_id = ?2
       JOIN app_server_grants asg
         ON asg.app_id = ?1
        AND (
          (asg.server_id IS NOT NULL AND asg.server_id = ?3)
          OR (asg.server_slug IS NOT NULL AND asg.server_slug = ?4)
        )
      WHERE o.external_provider = 'raft'
        AND o.external_id = ?3
      LIMIT 1`,
  ).bind(appId, accountId, serverId, serverSlug).first<{
    org_role: OrgRole;
    app_role: AppRole;
    access_model: "legacy_role" | "owner_server";
  }>();
  if (!row) return null;
  return {
    org_role: row.access_model === "owner_server" ? row.org_role : null,
    legacy_app_role: row.access_model === "legacy_role" ? row.app_role : null,
  };
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
): Promise<{
  org_role: OrgRole | null;
  app_role: AppRole | null;
  server_app_role: AppRole | null;
  server_org_role: OrgRole | null;
  org_id: string | null;
}> {
  const orgId = input.orgId ?? (input.appId ? await getAppOrgId(db, input.appId) : null);
  const account = input.appId
    ? (await db.prepare("SELECT server_id, server_slug FROM raft_accounts WHERE id = ?1 LIMIT 1")
      .bind(accountId)
      .first<{ server_id: string; server_slug: string | null }>()) ?? null
    : null;
  const [orgRole, appRole, ownerServerRole] = await Promise.all([
    orgId ? getOrgMemberRole(db, orgId, accountId) : Promise.resolve(null),
    input.appId ? getAppMemberRole(db, input.appId, accountId) : Promise.resolve(null),
    input.appId && account
      ? getOwnerServerRole(
          db,
          input.appId,
          accountId,
          account.server_id,
          account.server_slug,
        )
      : Promise.resolve(null),
  ]);
  const serverAppRole = ownerServerRole?.legacy_app_role ?? null;
  const effectiveOrgRole = orgRole ?? ownerServerRole?.org_role ?? null;
  const roles = [appRole, serverAppRole].filter(Boolean) as AppRole[];
  const effectiveAppRole = strongestAppRole(roles);
  return {
    org_role: effectiveOrgRole,
    app_role: effectiveAppRole,
    server_app_role: serverAppRole,
    server_org_role: ownerServerRole?.org_role ?? null,
    org_id: orgId,
  };
}

// Machine-readable 403 for insufficient role: agents/CLI can act on it
// (required vs current role, a stable resource string, and manage_url pointing
// an admin to where the role is bumped) instead of parsing a message. Legacy
// org_role/app_role fields are kept for back-compat.
function forbiddenRole(
  c: AdminContext,
  scope: "org" | "app",
  requiredRole: string,
  currentRole: string | null,
  ids: {
    org_id?: string | null;
    app_id?: string | null;
    current_permissions?: AppPermission[];
  },
) {
  let resource = "";
  try {
    const u = new URL(c.req.url);
    resource = `${c.req.method} ${u.pathname}`;
  } catch {
    // request URL/method unavailable (e.g. tests) — keep defaults
  }
  const manageUrl = ids.org_id
    ? `${dashboardOrigin(c.env)}/orgs/${ids.org_id}/members`
    : ids.app_id
      ? `${dashboardOrigin(c.env)}/apps/${ids.app_id}/settings`
      : null;
  // Admin-native, actionable error: tell the caller (agent or human) exactly
  // what to do next — who can grant the role, where, and that an admin can
  // perform the action on their behalf — instead of a bare "forbidden". Code is
  // a stable UPPER_SNAKE machine token; next_action is a ready-to-print
  // sentence. admin_can_grant signals an admin path exists.
  const target = scope === "org" ? "this org" : "this app";
  const nextAction =
    `You have role '${currentRole ?? "none"}' but '${requiredRole}' is required for ${target}. ` +
    `Ask an admin of ${target} to grant you the '${requiredRole}' role` +
    (manageUrl ? ` (manage roles at ${manageUrl})` : "") +
    `, or have an admin perform this action for you.`;
  return c.json(
    {
      error: scope === "org" ? "insufficient_org_role" : "insufficient_app_role",
      code: scope === "org" ? "INSUFFICIENT_ORG_ROLE" : "INSUFFICIENT_APP_ROLE",
      next_action: nextAction,
      admin_can_grant: true,
      required_role: requiredRole,
      current_role: currentRole,
      resource,
      org_id: ids.org_id ?? null,
      app_id: ids.app_id ?? null,
      ...(ids.current_permissions
        ? { current_permissions: ids.current_permissions }
        : {}),
      manage_url: manageUrl,
      ...(scope === "org" ? { org_role: currentRole } : { app_role: currentRole }),
    },
    403,
  );
}

function forbiddenAppPermission(
  c: AdminContext,
  appId: string,
  permission: AppPermission,
  deployToken: AppDeployToken,
) {
  return c.json(
    {
      error: "insufficient_app_permission",
      code: "INSUFFICIENT_APP_PERMISSION",
      required_permission: permission,
      current_permissions: [...resolveDeployTokenPermissions(deployToken)],
      app_id: appId,
    },
    403,
  );
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
      response: forbiddenRole(c, "org", minimum, role, { org_id: orgId }),
    };
  }
  return { ok: true as const, role };
}

export async function ensureAppRole(
  c: AdminContext,
  appId: string,
  minimum: AppRole,
  opts?: { orgMinimum?: OrgRole },
) {
  if (devTokenBypass(c)) return { ok: true as const, app_role: "admin" as AppRole, org_role: "owner" as OrgRole };
  const shapeError = appIdShapeError(c, appId);
  if (shapeError) return { ok: false as const, response: shapeError };
  const deployToken = currentDeployToken(c);
  if (deployToken) {
    if (
      deployToken.app_id !== appId
      || resolveDeployTokenPermissions(deployToken).size === 0
      || !isAppAtLeast(deployToken.app_role, minimum)
    ) {
      return {
        ok: false as const,
        response: forbiddenRole(
          c,
          "app",
          minimum,
          deployToken.app_id === appId ? deployToken.app_role : null,
          {
            app_id: appId,
            current_permissions: [...resolveDeployTokenPermissions(deployToken)],
          },
        ),
      };
    }
    return {
      ok: true as const,
      org_role: null,
      app_role: deployToken.app_role,
      server_app_role: null,
      org_id: null,
    };
  }
  const account = currentAccount(c);
  if (!account) {
    // Actionable 401: an agent that hit this with a valid-looking session got
    // no resolvable account — tell it how to authenticate and that admin API
    // access needs a role on the app, rather than a bare "unauthorized".
    return {
      ok: false as const,
      response: c.json(
        {
          error: "unauthorized",
          code: "NOT_AUTHENTICATED",
          required_role: minimum,
          next_action:
            `Authenticate first: humans use \`hands login\`; agents run ` +
            `\`raft integration login --service <hands-service>\`. Then an admin must grant you the ` +
            `'${minimum}' role on this app (Access → Members). Admins can perform the release action on your behalf.`,
          login_url: `/api/auth/login?return=${encodeURIComponent("/")}`,
          manage_url: `${dashboardOrigin(c.env)}/apps/${appId}/settings`,
        },
        401,
      ),
    };
  }
  const role = await getEffectiveRole(c.env.DB, account.id, { appId });
  // Default org bar: a plain app action needs org admin (or the app-role
  // fallback below); a viewer action only needs org viewer. Callers can lower
  // the org bar via opts.orgMinimum (e.g. feedback triage → org member).
  const orgMinimum = opts?.orgMinimum ?? (minimum === "viewer" ? "viewer" : "admin");
  const orgAllows = isOrgAtLeast(role.org_role, orgMinimum);
  const appAllows = isAppAtLeast(role.app_role, minimum);
  if (!orgAllows && !appAllows) {
    return {
      ok: false as const,
      response: forbiddenRole(c, "app", minimum, role.app_role, {
        app_id: appId,
        org_id: role.org_id,
      }),
    };
  }
  return { ok: true as const, ...role };
}

export async function ensureAppPermission(
  c: AdminContext,
  appId: string,
  permission: AppPermission,
  opts?: { orgMinimum?: OrgRole },
) {
  if (devTokenBypass(c)) return { ok: true as const, app_permission: permission };
  const shapeError = appIdShapeError(c, appId);
  if (shapeError) return { ok: false as const, response: shapeError };
  const deployToken = currentDeployToken(c);
  if (deployToken) {
    if (deployToken.app_id !== appId || !hasDeployTokenPermission(deployToken, permission)) {
      return {
        ok: false as const,
        response: forbiddenAppPermission(c, appId, permission, deployToken),
      };
    }
    return { ok: true as const, app_permission: permission };
  }
  const minimumRole = APP_PERMISSION_MINIMUM_ROLE[permission];
  if (!minimumRole) {
    return {
      ok: false as const,
      response: c.json(
        {
          error: "insufficient_app_permission",
          code: "INSUFFICIENT_APP_PERMISSION",
          required_permission: permission,
          current_permissions: [],
          app_id: appId,
        },
        403,
      ),
    };
  }
  return ensureAppRole(c, appId, minimumRole, opts);
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
      const deployToken = c.get("admin_deploy_token");
      if (deployToken && deployToken.scopes === null && minimum === "viewer") {
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

/**
 * Console feedback routes: admit either the role, or a deploy token that carries
 * the permission explicitly.
 *
 * The token must be role-free and, critically, **not bound to a reporter
 * integration**. A bound token is confined by the reporter API to the tickets of
 * that one integration; admitting it here would hand it the whole app's
 * feedback. The binding decides scope, not the permission name — so the binding
 * is what this checks.
 *
 * A bound token simply falls through to the role check and is rejected there,
 * because `isAppAtLeast(null, …)` is false for a role-free token.
 */
export function requireAppRoleOrFeedbackPermission(
  minimum: AppRole,
  options: { orgMinimum?: OrgRole },
  ...permissions: AppPermission[]
): MiddlewareHandler<RoleContext> {
  return async (c, next) => {
    const appId = c.req.param("appId");
    if (!appId) return c.json({ error: "missing appId" }, 400);
    const token = currentDeployToken(c);
    if (
      token
      && token.app_id === appId
      && token.app_role === null
      && token.reporter_integration_id === null
      && permissions.some((permission) => resolveDeployTokenPermissions(token).has(permission))
    ) {
      // Which permission admitted them matters downstream: the comments endpoint
      // serves both public replies and internal notes.
      c.set("feedback_token_permissions", resolveDeployTokenPermissions(token));
      await next();
      return;
    }
    // The role branch must retain exactly the reach the guard it replaced had.
    // requireFeedbackTriageRole passed { orgMinimum: "member" }; dropping that
    // silently removed org-level members from routes they could always use.
    const allowed = await ensureAppRole(c, appId, minimum, options);
    if (!allowed.ok) return allowed.response;
    await next();
  };
}

export function requireAppPermission(permission: AppPermission): MiddlewareHandler<RoleContext> {
  return async (c, next) => {
    const appId = c.req.param("appId");
    if (!appId) return c.json({ error: "missing appId" }, 400);
    const allowed = await ensureAppPermission(c, appId, permission);
    if (!allowed.ok) return allowed.response;
    await next();
  };
}

/**
 * Feedback triage (update status/assignee, add comments) is a member-level
 * operation: any org member — not just app publishers/admins — can triage an
 * app's feedback tickets. Existing app publishers/admins still pass via the
 * app-role fallback; bare viewers (read-only) still cannot write.
 */
export function requireFeedbackTriageRole(): MiddlewareHandler<RoleContext> {
  return async (c, next) => {
    const appId = c.req.param("appId");
    if (!appId) return c.json({ error: "missing appId" }, 400);
    const allowed = await ensureAppRole(c, appId, "publisher", { orgMinimum: "member" });
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
