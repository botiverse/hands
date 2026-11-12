import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { currentAccount, currentDeployToken, auditLogStatement } from "../lib/permissions";
import {
  ORG_TOKEN_ALLOWED_SCOPES,
  generateOrgAccessToken,
  hashOrgAccessToken,
  isOrgTokenScope,
  orgEligibleAppSql,
  parseOrgTokenScopes,
} from "../lib/org_access_tokens";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type OrgAccessTokenRow = {
  id: string;
  org_id: string;
  name: string;
  token_prefix: string;
  scopes_json: string;
  all_apps: number;
  created_by: string | null;
  created_by_actor: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
};

type TokenApp = { id: string; slug: string; name: string };

const MAX_EXPIRES_IN_DAYS = 3650;
/**
 * Create and revoke commit the token change and one audit row per covered app in
 * a single D1 batch, so neither can land without the other. This bounds that
 * batch well inside D1's per-invocation query limit.
 */
const MAX_COVERED_APPS = 200;

/** Every app an org token of org ?1 may cover: owned or co-owned (orgEligibleAppSql). */
function eligibleAppIds(db: D1Database, orgId: string) {
  return db.prepare(
    `SELECT a.id FROM apps a WHERE ${orgEligibleAppSql("a", "?1")} ORDER BY a.id`,
  ).bind(orgId).all<{ id: string }>();
}

/**
 * Management is for session principals only. requireOrgRole already rejects a
 * principal without an account, but an org or deploy token must never mint,
 * list, or revoke org tokens even if that guard is ever loosened.
 */
function rejectTokenPrincipal(c: AdminContext) {
  if (currentDeployToken(c) || c.get("admin_org_token_id")) {
    return c.json({ error: "org access tokens can only be managed from a signed-in session" }, 403);
  }
  return null;
}

function toResponse(row: OrgAccessTokenRow, apps: TokenApp[]) {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    token_prefix: row.token_prefix,
    scopes: parseOrgTokenScopes(row.scopes_json),
    all_apps: row.all_apps === 1,
    apps: row.all_apps === 1 ? [] : apps,
    created_by: row.created_by,
    created_by_actor: row.created_by_actor,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

/** App ids an audit row must be written for: selected apps, or every eligible app now. */
async function auditAppIds(db: D1Database, orgId: string, tokenId: string, allApps: boolean): Promise<string[]> {
  const { results } = allApps
    ? await eligibleAppIds(db, orgId)
    : await db.prepare(
      `SELECT ta.app_id AS id FROM org_access_token_apps ta
       JOIN apps a ON a.id = ta.app_id
       WHERE ta.token_id = ?1 AND ${orgEligibleAppSql("a", "?2")}
       ORDER BY ta.app_id`,
    ).bind(tokenId, orgId).all<{ id: string }>();
  return results.map((row) => row.id);
}

export async function handleListOrgAccessTokens(c: AdminContext) {
  const rejected = rejectTokenPrincipal(c);
  if (rejected) return rejected;
  const orgId = c.req.param("orgId") ?? "";
  const includeRevoked = c.req.query("include_revoked") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT id, org_id, name, token_prefix, scopes_json, all_apps, created_by,
            created_by_actor, created_at, expires_at, last_used_at, revoked_at
     FROM org_access_tokens
     WHERE org_id = ?1
       AND (?2 = 1 OR revoked_at IS NULL)
     ORDER BY revoked_at IS NULL DESC, created_at DESC`,
  ).bind(orgId, includeRevoked ? 1 : 0).all<OrgAccessTokenRow>();
  const { results: appRows } = await c.env.DB.prepare(
    `SELECT ta.token_id, a.id, a.slug, a.name
     FROM org_access_token_apps ta
     JOIN org_access_tokens t ON t.id = ta.token_id
     JOIN apps a ON a.id = ta.app_id AND ${orgEligibleAppSql("a", "t.org_id")}
     WHERE t.org_id = ?1
     ORDER BY a.slug`,
  ).bind(orgId).all<TokenApp & { token_id: string }>();
  const appsByToken = new Map<string, TokenApp[]>();
  for (const { token_id, ...app } of appRows) {
    const list = appsByToken.get(token_id) ?? [];
    list.push(app);
    appsByToken.set(token_id, list);
  }
  return c.json({
    access_tokens: results.map((row) => toResponse(row, appsByToken.get(row.id) ?? [])),
  });
}

export async function handleCreateOrgAccessToken(c: AdminContext) {
  const rejected = rejectTokenPrincipal(c);
  if (rejected) return rejected;
  const orgId = c.req.param("orgId") ?? "";
  const raw = await c.req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return c.json({ error: "body must be a JSON object" }, 400);
  }
  const body = raw as Record<string, unknown>;

  // Strict: an unrecognized field must 400, never silently mint a broader or
  // longer-lived token than asked for. org_id is tolerated because the
  // agent-manifest layer mirrors path params into the body.
  const allowedKeys = new Set(["name", "scopes", "app_ids", "all_apps", "expires_in_days", "expires_at", "org_id"]);
  const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    return c.json(
      { error: `unknown field(s): ${unknownKeys.join(", ")} — accepted: name, scopes, app_ids | all_apps, expires_in_days | expires_at (unix ms)` },
      400,
    );
  }
  if (body.org_id !== undefined && body.org_id !== orgId) {
    return c.json({ error: "org_id in body does not match the path" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);
  if (name.length > 80) return c.json({ error: "name must be 80 characters or fewer" }, 400);

  if (!Array.isArray(body.scopes) || body.scopes.length === 0 || !body.scopes.every(isOrgTokenScope)) {
    return c.json(
      { error: `scopes must be a non-empty array drawn from: ${ORG_TOKEN_ALLOWED_SCOPES.join(", ")}` },
      400,
    );
  }
  const scopes = [...new Set(body.scopes)];

  const hasAppIds = body.app_ids !== undefined && body.app_ids !== null;
  const hasAllApps = body.all_apps !== undefined && body.all_apps !== null && body.all_apps !== false;
  if (hasAppIds === hasAllApps) {
    return c.json({ error: "provide exactly one of app_ids (non-empty array) or all_apps: true" }, 400);
  }
  if (hasAllApps && body.all_apps !== true) {
    return c.json({ error: "all_apps must be true when provided" }, 400);
  }
  let appIds: string[] = [];
  if (hasAppIds) {
    if (
      !Array.isArray(body.app_ids)
      || body.app_ids.length === 0
      || !body.app_ids.every((id) => typeof id === "string" && id.trim().length > 0)
    ) {
      return c.json({ error: "app_ids must be a non-empty array of app ids" }, 400);
    }
    appIds = [...new Set((body.app_ids as string[]).map((id) => id.trim()))];
    if (appIds.length > MAX_COVERED_APPS) {
      return c.json({ error: `app_ids may list at most ${MAX_COVERED_APPS} apps` }, 400);
    }
    // Read the org's eligible app ids (owned or co-owned) and compare in memory:
    // an IN (...) list would hit D1's bound-parameter limit long before the app cap.
    const { results } = await eligibleAppIds(c.env.DB, orgId);
    const found = new Set(results.map((row) => row.id));
    const missing = appIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return c.json({
        error: "every app in app_ids must be owned by this organization or co-owned by it as an owner server",
        app_ids: missing,
      }, 400);
    }
  }

  if (body.expires_at != null && body.expires_in_days != null) {
    return c.json({ error: "provide expires_at or expires_in_days, not both" }, 400);
  }
  let expiresAt: number | null = null;
  if (body.expires_in_days != null) {
    const days = body.expires_in_days;
    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0 || days > MAX_EXPIRES_IN_DAYS) {
      return c.json({ error: `expires_in_days must be a number with 0 < days <= ${MAX_EXPIRES_IN_DAYS}` }, 400);
    }
    expiresAt = Date.now() + Math.round(days * 24 * 60 * 60 * 1000);
  } else if (body.expires_at != null) {
    const value = body.expires_at;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return c.json({ error: "expires_at must be a unix timestamp in milliseconds" }, 400);
    }
    if (value < Date.now() + 60_000) {
      return c.json({ error: "expires_at must be at least 60 seconds in the future" }, 400);
    }
    if (value > Date.now() + MAX_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000) {
      return c.json({ error: `expires_at must be at most ${MAX_EXPIRES_IN_DAYS} days in the future` }, 400);
    }
    expiresAt = Math.floor(value);
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const { token, token_prefix } = generateOrgAccessToken();
  const tokenHash = await hashOrgAccessToken(token);
  const account = currentAccount(c);
  const actor = currentActor(c);

  const insertToken = c.env.DB.prepare(
    `INSERT INTO org_access_tokens
       (id, org_id, name, token_prefix, token_hash, scopes_json, all_apps,
        created_by, created_by_actor, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL)`,
  ).bind(
    id, orgId, name, token_prefix, tokenHash, JSON.stringify(scopes), hasAllApps ? 1 : 0,
    account?.id ?? null, actor, now, expiresAt,
  );
  const insertApps = appIds.map((appId) =>
    c.env.DB.prepare(
      "INSERT INTO org_access_token_apps (token_id, app_id) VALUES (?1, ?2)",
    ).bind(id, appId)
  );
  // Audit rows are written per covered app (audit_logs is app-scoped), in the same
  // batch as the token: a token must never exist without its creation record.
  const coveredApps = hasAllApps
    ? (await eligibleAppIds(c.env.DB, orgId)).results.map((row) => row.id)
    : appIds;
  if (hasAllApps && coveredApps.length === 0) {
    // Nothing to record the creation against, and nothing for the token to read yet.
    return c.json({ error: "all_apps needs at least one app the organization owns or co-owns" }, 400);
  }
  if (coveredApps.length > MAX_COVERED_APPS) {
    return c.json({
      error: `all_apps covers more than ${MAX_COVERED_APPS} apps; select apps with app_ids instead`,
    }, 400);
  }
  const auditPayload = { id, org_id: orgId, name, token_prefix, scopes, all_apps: hasAllApps, expires_at: expiresAt };
  const auditRows = coveredApps.map((appId) => auditLogStatement(c.env.DB, c, {
    app_id: appId,
    action: "org_access_token.create",
    payload: auditPayload,
    created_at: now,
  }));
  await c.env.DB.batch([insertToken, ...insertApps, ...auditRows]);

  const apps = hasAllApps
    ? []
    : (await c.env.DB.prepare(
      `SELECT a.id, a.slug, a.name FROM org_access_token_apps ta
       JOIN apps a ON a.id = ta.app_id
       WHERE ta.token_id = ?1 ORDER BY a.slug`,
    ).bind(id).all<TokenApp>()).results;

  return c.json(
    {
      token,
      access_token: toResponse({
        id,
        org_id: orgId,
        name,
        token_prefix,
        scopes_json: JSON.stringify(scopes),
        all_apps: hasAllApps ? 1 : 0,
        created_by: account?.id ?? null,
        created_by_actor: actor,
        created_at: now,
        expires_at: expiresAt,
        last_used_at: null,
        revoked_at: null,
      }, apps),
    },
    201,
  );
}

export async function handleRevokeOrgAccessToken(c: AdminContext) {
  const rejected = rejectTokenPrincipal(c);
  if (rejected) return rejected;
  const orgId = c.req.param("orgId") ?? "";
  const tokenId = c.req.param("tokenId") ?? "";
  const existing = await c.env.DB.prepare(
    `SELECT id, name, token_prefix, scopes_json, all_apps, revoked_at
     FROM org_access_tokens WHERE id = ?1 AND org_id = ?2 LIMIT 1`,
  ).bind(tokenId, orgId).first<{
    id: string;
    name: string;
    token_prefix: string;
    scopes_json: string;
    all_apps: number;
    revoked_at: number | null;
  }>();
  if (!existing) return c.json({ error: "not found" }, 404);
  // Already revoked: report the original revocation, write nothing new.
  if (existing.revoked_at !== null) {
    return c.json({ ok: true, id: tokenId, revoked_at: existing.revoked_at });
  }

  const now = Date.now();
  const revoke = c.env.DB.prepare(
    "UPDATE org_access_tokens SET revoked_at = ?1 WHERE id = ?2 AND org_id = ?3 AND revoked_at IS NULL",
  ).bind(now, tokenId, orgId);

  const allApps = existing.all_apps === 1;
  const auditPayload = {
    id: existing.id,
    org_id: orgId,
    name: existing.name,
    token_prefix: existing.token_prefix,
    scopes: parseOrgTokenScopes(existing.scopes_json),
    all_apps: allApps,
  };
  // Revocation and its audit rows commit together. Coverage beyond the cap (an
  // all_apps token in an org that has since grown) is recorded on the first
  // MAX_COVERED_APPS apps; the revocation itself never depends on the audit count.
  const auditRows = (await auditAppIds(c.env.DB, orgId, existing.id, allApps))
    .slice(0, MAX_COVERED_APPS)
    .map((appId) => auditLogStatement(c.env.DB, c, {
      app_id: appId,
      action: "org_access_token.revoke",
      payload: auditPayload,
      created_at: now,
    }));
  await c.env.DB.batch([revoke, ...auditRows]);

  return c.json({ ok: true, id: tokenId, revoked_at: now });
}
