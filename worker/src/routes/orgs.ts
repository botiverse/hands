import type { Context } from "hono";
import { currentActorInfo, type AdminEnv } from "../middleware/auth";
import { requestOrigin } from "../lib/origin";
import {
  currentAccount,
  ensureAppRole,
  ensureOrgRole,
  insertAuditLog,
  isAppRole,
  isOrgAtLeast,
  isOrgRole,
  type AppRole,
  type OrgRole,
} from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
type PublicContext = Context<{ Bindings: Env }>;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function now() {
  return Date.now();
}

function appOrigin(c: Context<any>) {
  return requestOrigin(c);
}

function normalizeEmail(email: unknown) {
  return String(email ?? "").trim().toLowerCase();
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getAppOrg(
  db: D1Database,
  appId: string,
): Promise<{ id: string; org_id: string | null; slug: string; name: string } | null> {
  return db
    .prepare("SELECT id, org_id, slug, name FROM apps WHERE id = ?1 LIMIT 1")
    .bind(appId)
    .first<{ id: string; org_id: string | null; slug: string; name: string }>();
}

async function countOrgOwners(db: D1Database, orgId: string) {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM org_members WHERE org_id = ?1 AND org_role = 'owner'")
    .bind(orgId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function findAccountById(db: D1Database, accountId: string) {
  return db
    .prepare(
      `SELECT id, provider, provider_subject, server_id, server_slug, principal_type,
              server_role, username, display_name, avatar_url, raw_profile,
              created_at, updated_at, last_login_at
       FROM raft_accounts
       WHERE id = ?1
       LIMIT 1`,
    )
    .bind(accountId)
    .first<{ id: string; principal_type: "human" | "agent"; display_name: string }>();
}

export async function handleListOrgs(c: AdminContext) {
  const account = currentAccount(c);
  if (!account) {
    if (c.get("admin_actor") === "dev-token") {
      const { results } = await c.env.DB.prepare(
        `SELECT id, slug, name, external_provider, external_id, created_at, archived
         FROM organizations
         ORDER BY created_at DESC`,
      ).all();
      return c.json({ orgs: results });
    }
    return c.json({ error: "unauthorized" }, 401);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.slug, o.name, o.external_provider, o.external_id,
            o.created_at, o.archived,
            CASE MAX(CASE om.org_role
              WHEN 'owner' THEN 4
              WHEN 'admin' THEN 3
              WHEN 'member' THEN 2
              ELSE 1
            END)
              WHEN 4 THEN 'owner'
              WHEN 3 THEN 'admin'
              WHEN 2 THEN 'member'
              ELSE 'viewer'
            END AS org_role
     FROM org_members om
     JOIN organizations o ON o.id = om.org_id
     JOIN raft_accounts linked ON linked.id = om.account_id
     WHERE linked.provider = ?1
       AND linked.provider_subject = ?2
       AND linked.principal_type = ?3
     GROUP BY o.id, o.slug, o.name, o.external_provider, o.external_id,
              o.created_at, o.archived
     ORDER BY o.created_at DESC`,
  ).bind(account.provider, account.provider_subject, account.principal_type).all();
  return c.json({ orgs: results });
}

export async function handleListOrgMembers(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const allowed = await ensureOrgRole(c, orgId, "viewer");
  if (!allowed.ok) return allowed.response;
  const { results } = await c.env.DB.prepare(
    `SELECT om.id, om.org_id, om.account_id, om.org_role, om.invited_by, om.joined_at,
            a.provider, a.provider_subject, a.server_id, a.server_slug,
            a.principal_type, a.server_role, a.username, a.display_name,
            a.avatar_url, a.created_at AS account_created_at,
            a.updated_at AS account_updated_at, a.last_login_at
     FROM org_members om
     JOIN raft_accounts a ON a.id = om.account_id
     WHERE om.org_id = ?1
     ORDER BY
       CASE om.org_role
         WHEN 'owner' THEN 1
         WHEN 'admin' THEN 2
         WHEN 'member' THEN 3
         ELSE 4
       END,
       lower(a.display_name) ASC`,
  ).bind(orgId).all();
  return c.json({ members: results });
}

export async function handleUpdateOrgMember(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const accountId = c.req.param("accountId") ?? "";
  const allowed = await ensureOrgRole(c, orgId, "admin");
  if (!allowed.ok) return allowed.response;
  const body = (await c.req.json().catch(() => ({}))) as { org_role?: unknown };
  if (!isOrgRole(body.org_role)) {
    return c.json({ error: "org_role must be owner/admin/member/viewer" }, 400);
  }
  const target = await c.env.DB.prepare(
    "SELECT org_role FROM org_members WHERE org_id = ?1 AND account_id = ?2",
  ).bind(orgId, accountId).first<{ org_role: OrgRole }>();
  if (!target) return c.json({ error: "member not found" }, 404);
  if (target.org_role === "owner" && body.org_role !== "owner" && (await countOrgOwners(c.env.DB, orgId)) <= 1) {
    return c.json({ error: "cannot remove the last org owner" }, 409);
  }
  await c.env.DB.prepare(
    "UPDATE org_members SET org_role = ?1 WHERE org_id = ?2 AND account_id = ?3",
  ).bind(body.org_role, orgId, accountId).run();
  return c.json({ ok: true, org_id: orgId, account_id: accountId, org_role: body.org_role });
}

export async function handleRemoveOrgMember(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const accountId = c.req.param("accountId") ?? "";
  const allowed = await ensureOrgRole(c, orgId, "admin");
  if (!allowed.ok) return allowed.response;
  const target = await c.env.DB.prepare(
    "SELECT org_role FROM org_members WHERE org_id = ?1 AND account_id = ?2",
  ).bind(orgId, accountId).first<{ org_role: OrgRole }>();
  if (!target) return c.json({ error: "member not found" }, 404);
  if (target.org_role === "owner" && (await countOrgOwners(c.env.DB, orgId)) <= 1) {
    return c.json({ error: "cannot remove the last org owner" }, 409);
  }
  await c.env.DB.prepare(
    "DELETE FROM org_members WHERE org_id = ?1 AND account_id = ?2",
  ).bind(orgId, accountId).run();
  return c.json({ ok: true, org_id: orgId, account_id: accountId });
}

export async function handleListOrgInvites(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const allowed = await ensureOrgRole(c, orgId, "admin");
  if (!allowed.ok) return allowed.response;
  const status = c.req.query("status");
  const where = status ? "WHERE i.org_id = ?1 AND i.status = ?2" : "WHERE i.org_id = ?1";
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.org_id, i.app_id, i.email, i.role, i.status, i.message,
            i.created_at, i.expires_at, i.accepted_at, i.accepted_by,
            i.revoked_at, i.revoked_by, i.invited_by,
            inviter.display_name AS invited_by_display_name,
            app.name AS app_name,
            app.slug AS app_slug
     FROM invites i
     LEFT JOIN raft_accounts inviter ON inviter.id = i.invited_by
     LEFT JOIN apps app ON app.id = i.app_id
     ${where}
     ORDER BY i.created_at DESC`,
  ).bind(...(status ? [orgId, status] : [orgId])).all();
  return c.json({ invites: results });
}

export async function handleCreateOrgInvite(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const allowed = await ensureOrgRole(c, orgId, "admin");
  if (!allowed.ok) return allowed.response;
  const actor = currentActorInfo(c);
  if (!actor.id) return c.json({ error: "invites require a Raft account" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    email?: unknown;
    role?: unknown;
    app_id?: string | null;
    message?: string | null;
  };
  const email = normalizeEmail(body.email);
  if (!email || !email.includes("@")) return c.json({ error: "valid email required" }, 400);
  const role = String(body.role ?? "");
  const appId = body.app_id || null;
  if (appId) {
    const app = await getAppOrg(c.env.DB, appId);
    if (!app || app.org_id !== orgId) return c.json({ error: "app not found in org" }, 404);
    if (!isAppRole(role)) return c.json({ error: "role must be admin/publisher/viewer for app invites" }, 400);
  } else if (!isOrgRole(role)) {
    return c.json({ error: "role must be owner/admin/member/viewer for org invites" }, 400);
  }

  const timestamp = now();
  const id = crypto.randomUUID();
  const token = randomToken();
  try {
    await c.env.DB.prepare(
      `INSERT INTO invites
       (id, org_id, app_id, email, role, token, invited_by, status, message,
        created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10)`,
    ).bind(
      id,
      orgId,
      appId,
      email,
      role,
      token,
      actor.id,
      body.message || null,
      timestamp,
      timestamp + INVITE_TTL_MS,
    ).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE") || message.includes("SQLITE_CONSTRAINT")) {
      return c.json({ error: "pending invite already exists for this email" }, 409);
    }
    throw error;
  }
  return c.json(
    {
      id,
      org_id: orgId,
      app_id: appId,
      email,
      role,
      status: "pending",
      invite_url: `${appOrigin(c)}/invites/${token}`,
      created_at: timestamp,
      expires_at: timestamp + INVITE_TTL_MS,
    },
    201,
  );
}

export async function handleResendOrgInvite(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const inviteId = c.req.param("inviteId") ?? "";
  const allowed = await ensureOrgRole(c, orgId, "admin");
  if (!allowed.ok) return allowed.response;
  const token = randomToken();
  const timestamp = now();
  await c.env.DB.prepare(
    `UPDATE invites
     SET token = ?1, expires_at = ?2, status = 'pending'
     WHERE id = ?3 AND org_id = ?4 AND status = 'pending'`,
  ).bind(token, timestamp + INVITE_TTL_MS, inviteId, orgId).run();
  return c.json({
    ok: true,
    id: inviteId,
    invite_url: `${appOrigin(c)}/invites/${token}`,
    expires_at: timestamp + INVITE_TTL_MS,
  });
}

export async function handleRevokeOrgInvite(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const inviteId = c.req.param("inviteId") ?? "";
  const allowed = await ensureOrgRole(c, orgId, "admin");
  if (!allowed.ok) return allowed.response;
  const actor = currentActorInfo(c);
  await c.env.DB.prepare(
    `UPDATE invites
     SET status = 'revoked', revoked_at = ?1, revoked_by = ?2
     WHERE id = ?3 AND org_id = ?4 AND status = 'pending'`,
  ).bind(now(), actor.id, inviteId, orgId).run();
  return c.json({ ok: true, id: inviteId, status: "revoked" });
}

export async function handleGetInvite(c: PublicContext) {
  const token = c.req.param("token") ?? "";
  const invite = await c.env.DB.prepare(
    `SELECT i.id, i.org_id, i.app_id, i.email, i.role, i.status, i.message,
            i.created_at, i.expires_at,
            inviter.display_name AS invited_by_display_name,
            org.name AS org_name,
            app.name AS app_name
     FROM invites i
     JOIN organizations org ON org.id = i.org_id
     LEFT JOIN apps app ON app.id = i.app_id
     LEFT JOIN raft_accounts inviter ON inviter.id = i.invited_by
     WHERE i.token = ?1
     LIMIT 1`,
  ).bind(token).first();
  if (!invite) return c.json({ error: "invite not found" }, 404);
  return c.json(invite);
}

export async function handleAcceptInvite(c: AdminContext) {
  const token = c.req.param("token") ?? "";
  const account = currentAccount(c);
  if (!account) return c.json({ error: "unauthorized" }, 401);
  const invite = await c.env.DB.prepare(
    `SELECT id, org_id, app_id, role, status, expires_at
     FROM invites
     WHERE token = ?1
     LIMIT 1`,
  ).bind(token).first<{
    id: string;
    org_id: string;
    app_id: string | null;
    role: string;
    status: string;
    expires_at: number;
  }>();
  if (!invite) return c.json({ error: "invite not found" }, 404);
  if (invite.status !== "pending") return c.json({ error: `invite is ${invite.status}` }, 409);
  const timestamp = now();
  if (invite.expires_at < timestamp) {
    await c.env.DB.prepare(
      "UPDATE invites SET status = 'expired' WHERE id = ?1 AND status = 'pending'",
    ).bind(invite.id).run();
    return c.json({ error: "invite expired" }, 410);
  }

  const membershipStatement = invite.app_id
    ? c.env.DB.prepare(
        `INSERT INTO org_members
         (id, org_id, account_id, org_role, invited_by, joined_at)
         VALUES (?1, ?2, ?3, 'viewer', NULL, ?4)
         ON CONFLICT(org_id, account_id) DO NOTHING`,
      ).bind(`orgmem_${account.id}_${invite.org_id}`, invite.org_id, account.id, timestamp)
    : c.env.DB.prepare(
        `INSERT INTO org_members
         (id, org_id, account_id, org_role, invited_by, joined_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)
         ON CONFLICT(org_id, account_id) DO UPDATE SET org_role = excluded.org_role`,
      ).bind(`orgmem_${account.id}_${invite.org_id}`, invite.org_id, account.id, invite.role, timestamp);

  const statements: D1PreparedStatement[] = [
    membershipStatement,
    c.env.DB.prepare(
      `UPDATE invites
       SET status = 'accepted', accepted_at = ?1, accepted_by = ?2
       WHERE id = ?3`,
    ).bind(timestamp, account.id, invite.id),
  ];
  if (invite.app_id) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO app_members
         (id, app_id, account_id, app_role, invited_by, joined_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)
         ON CONFLICT(app_id, account_id) DO UPDATE SET app_role = excluded.app_role`,
      ).bind(`appmem_${invite.app_id}_${account.id}`, invite.app_id, account.id, invite.role, timestamp),
    );
  }
  await c.env.DB.batch(statements);
  return c.json({ ok: true, org_id: invite.org_id, app_id: invite.app_id });
}

export async function handleListOrgAuditLogs(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const allowed = await ensureOrgRole(c, orgId, "member");
  if (!allowed.ok) return allowed.response;
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.app_id, a.slug AS app_slug, a.name AS app_name,
            l.action, l.actor, l.actor_id, l.actor_type,
            acc.display_name AS actor_display_name,
            acc.username AS actor_username,
            acc.avatar_url AS actor_avatar_url,
            l.payload, l.created_at
     FROM audit_logs l
     JOIN apps a ON a.id = l.app_id
     LEFT JOIN raft_accounts acc ON acc.id = l.actor_id
     WHERE a.org_id = ?1
     ORDER BY l.created_at DESC
     LIMIT ?2`,
  ).bind(orgId, limit).all();
  return c.json({ logs: results });
}

export async function handleListAppMembers(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const allowed = await ensureAppRole(c, appId, "viewer");
  if (!allowed.ok) return allowed.response;
  const { results } = await c.env.DB.prepare(
    `SELECT am.id, am.app_id, am.account_id, am.app_role, am.invited_by, am.joined_at,
            a.provider, a.provider_subject, a.server_id, a.server_slug,
            a.principal_type, a.server_role, a.username, a.display_name,
            a.avatar_url, a.last_login_at
     FROM app_members am
     JOIN raft_accounts a ON a.id = am.account_id
     WHERE am.app_id = ?1
     ORDER BY
       CASE am.app_role
         WHEN 'admin' THEN 1
         WHEN 'publisher' THEN 2
         ELSE 3
       END,
       lower(a.display_name) ASC`,
  ).bind(appId).all();
  return c.json({ members: results });
}

export async function handleListAppServerGrants(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const allowed = await ensureAppRole(c, appId, "viewer");
  if (!allowed.ok) return allowed.response;
  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, server_id, server_slug, app_role, granted_by, created_at, updated_at
     FROM app_server_grants
     WHERE app_id = ?1
     ORDER BY lower(COALESCE(server_slug, server_id)) ASC`,
  ).bind(appId).all();
  return c.json({ server_grants: results });
}

export async function handleAddAppServerGrant(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const allowed = await ensureAppRole(c, appId, "admin");
  if (!allowed.ok) return allowed.response;
  const actor = currentActorInfo(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    server_id?: unknown;
    server_slug?: unknown;
    app_role?: unknown;
  };
  const serverId = String(body.server_id ?? "").trim() || null;
  const serverSlug = body.server_slug === undefined || body.server_slug === null
    ? null
    : String(body.server_slug).trim() || null;
  if (!serverId && !serverSlug) return c.json({ error: "server_id or server_slug required" }, 400);
  if (!isAppRole(body.app_role)) return c.json({ error: "app_role must be admin/publisher/viewer" }, 400);
  const timestamp = now();
  const existing = await c.env.DB.prepare(
    `SELECT id
     FROM app_server_grants
     WHERE app_id = ?1
       AND (
         (?2 IS NOT NULL AND server_id = ?3)
         OR (?4 IS NOT NULL AND server_slug = ?5)
       )
     LIMIT 1`,
  ).bind(appId, serverId, serverId, serverSlug, serverSlug).first<{ id: string }>();
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE app_server_grants
       SET server_id = ?1, server_slug = ?2, app_role = ?3, granted_by = ?4, updated_at = ?5
       WHERE id = ?6`,
    ).bind(serverId, serverSlug, body.app_role, actor.id, timestamp, existing.id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO app_server_grants
       (id, app_id, server_id, server_slug, app_role, granted_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(
      crypto.randomUUID(),
      appId,
      serverId,
      serverSlug,
      body.app_role,
      actor.id,
      timestamp,
    ).run();
  }
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "app_server_grant.upsert",
    payload: { server_id: serverId, server_slug: serverSlug, app_role: body.app_role },
    created_at: timestamp,
  });
  return c.json({ ok: true, app_id: appId, server_id: serverId, server_slug: serverSlug, app_role: body.app_role }, 201);
}

export async function handleUpdateAppServerGrant(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const serverKey = c.req.param("serverId") ?? "";
  const allowed = await ensureAppRole(c, appId, "admin");
  if (!allowed.ok) return allowed.response;
  const body = (await c.req.json().catch(() => ({}))) as {
    server_id?: unknown;
    server_slug?: unknown;
    app_role?: unknown;
  };
  if (!isAppRole(body.app_role)) return c.json({ error: "app_role must be admin/publisher/viewer" }, 400);
  const serverId = body.server_id === undefined || body.server_id === null
    ? null
    : String(body.server_id).trim() || null;
  const serverSlug = body.server_slug === undefined || body.server_slug === null
    ? null
    : String(body.server_slug).trim() || null;
  if (!serverId && !serverSlug) return c.json({ error: "server_id or server_slug required" }, 400);
  await c.env.DB.prepare(
    `UPDATE app_server_grants
     SET server_id = ?1, server_slug = ?2, app_role = ?3, updated_at = ?4
     WHERE app_id = ?5
       AND (id = ?6 OR server_id = ?7 OR server_slug = ?8)`,
  ).bind(serverId, serverSlug, body.app_role, now(), appId, serverKey, serverKey, serverKey).run();
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "app_server_grant.role_changed",
    payload: { server_id: serverId, server_slug: serverSlug, app_role: body.app_role },
  });
  return c.json({ ok: true, app_id: appId, server_id: serverId, server_slug: serverSlug, app_role: body.app_role });
}

export async function handleRemoveAppServerGrant(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const serverKey = c.req.param("serverId") ?? "";
  const allowed = await ensureAppRole(c, appId, "admin");
  if (!allowed.ok) return allowed.response;
  await c.env.DB.prepare(
    "DELETE FROM app_server_grants WHERE app_id = ?1 AND (id = ?2 OR server_id = ?3 OR server_slug = ?4)",
  ).bind(appId, serverKey, serverKey, serverKey).run();
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "app_server_grant.removed",
    payload: { server_key: serverKey },
  });
  return c.json({ ok: true, app_id: appId, server_key: serverKey });
}

export async function handleAddAppMember(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const allowed = await ensureAppRole(c, appId, "admin");
  if (!allowed.ok) return allowed.response;
  const actor = currentActorInfo(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    account_id?: string;
    app_role?: unknown;
  };
  if (!body.account_id) return c.json({ error: "account_id required" }, 400);
  if (!isAppRole(body.app_role)) return c.json({ error: "app_role must be admin/publisher/viewer" }, 400);
  const account = await findAccountById(c.env.DB, body.account_id);
  if (!account) return c.json({ error: "account not found" }, 404);
  const app = await getAppOrg(c.env.DB, appId);
  if (!app?.org_id) return c.json({ error: "app org not found" }, 404);
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO org_members
       (id, org_id, account_id, org_role, invited_by, joined_at)
       VALUES (?1, ?2, ?3, 'viewer', ?4, ?5)
       ON CONFLICT(org_id, account_id) DO NOTHING`,
    ).bind(`orgmem_${body.account_id}_${app.org_id}`, app.org_id, body.account_id, actor.id, timestamp),
    c.env.DB.prepare(
      `INSERT INTO app_members
       (id, app_id, account_id, app_role, invited_by, joined_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(app_id, account_id) DO UPDATE SET app_role = excluded.app_role`,
    ).bind(`appmem_${appId}_${body.account_id}`, appId, body.account_id, body.app_role, actor.id, timestamp),
  ]);
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "app_member.upsert",
    payload: { account_id: body.account_id, app_role: body.app_role },
    created_at: timestamp,
  });
  return c.json({ ok: true, app_id: appId, account_id: body.account_id, app_role: body.app_role }, 201);
}

export async function handleUpdateAppMember(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const accountId = c.req.param("accountId") ?? "";
  const allowed = await ensureAppRole(c, appId, "admin");
  if (!allowed.ok) return allowed.response;
  const body = (await c.req.json().catch(() => ({}))) as { app_role?: unknown };
  if (!isAppRole(body.app_role)) return c.json({ error: "app_role must be admin/publisher/viewer" }, 400);
  await c.env.DB.prepare(
    "UPDATE app_members SET app_role = ?1 WHERE app_id = ?2 AND account_id = ?3",
  ).bind(body.app_role, appId, accountId).run();
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "app_member.role_changed",
    payload: { account_id: accountId, app_role: body.app_role },
  });
  return c.json({ ok: true, app_id: appId, account_id: accountId, app_role: body.app_role });
}

export async function handleRemoveAppMember(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const accountId = c.req.param("accountId") ?? "";
  const allowed = await ensureAppRole(c, appId, "admin");
  if (!allowed.ok) return allowed.response;
  await c.env.DB.prepare(
    "DELETE FROM app_members WHERE app_id = ?1 AND account_id = ?2",
  ).bind(appId, accountId).run();
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "app_member.removed",
    payload: { account_id: accountId },
  });
  return c.json({ ok: true, app_id: appId, account_id: accountId });
}
