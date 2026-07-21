import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { currentAccount, insertAuditLog } from "../lib/permissions";
import {
  generateDeployToken,
  hashDeployToken,
  isDeployTokenRole,
  resolveAppGrantPermissions,
  type DeployTokenRole,
} from "../lib/deploy_tokens";
import {
  APP_PERMISSIONS,
  APP_PERMISSION_DESCRIPTIONS,
  APP_PERMISSION_LABELS,
  APP_ROLE_PERMISSIONS,
  isAppPermission,
  type AppPermission,
} from "../lib/app_permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export function handleGetAppPermissionModel(c: AdminContext) {
  return c.json({
    permissions: APP_PERMISSIONS.map((permission) => ({
      permission,
      label: APP_PERMISSION_LABELS[permission],
      description: APP_PERMISSION_DESCRIPTIONS[permission],
    })),
    roles: Object.entries(APP_ROLE_PERMISSIONS).map(([role, permissions]) => ({
      role,
      permissions,
    })),
  });
}

type DeployTokenRow = {
  id: string;
  app_id: string;
  name: string;
  token_prefix: string;
  app_role: DeployTokenRole | null;
  scopes_json: string | null;
  created_by: string | null;
  created_by_actor: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
};

function parseExpiresAt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("expires_at must be a unix timestamp in milliseconds");
  }
  const min = Date.now() + 60_000;
  if (value < min) throw new Error("expires_at must be at least 60 seconds in the future");
  return Math.floor(value);
}

function toResponse(row: DeployTokenRow) {
  let scopes: AppPermission[] | null = null;
  let grantValid = true;
  if (row.scopes_json !== null) {
    try {
      const parsed = JSON.parse(row.scopes_json);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isAppPermission)) {
        scopes = parsed;
      } else {
        scopes = [];
        grantValid = false;
      }
    } catch {
      scopes = [];
      grantValid = false;
    }
  }
  const token = {
    id: row.id,
    app_id: row.app_id,
    name: row.name,
    token_prefix: row.token_prefix,
    app_role: row.app_role,
    scopes,
    created_by: row.created_by,
    created_by_actor: row.created_by_actor,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
  return {
    ...token,
    grant_valid: grantValid && (token.app_role !== null || token.scopes !== null),
    effective_permissions: grantValid
      ? [...resolveAppGrantPermissions(token.app_role, token.scopes)]
      : [],
  };
}

export async function handleListAppDeployTokens(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const includeRevoked = c.req.query("include_revoked") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, name, token_prefix, app_role, scopes_json, created_by,
            created_by_actor, created_at, expires_at, last_used_at, revoked_at
     FROM app_deploy_tokens
     WHERE app_id = ?1
       AND (?2 = 1 OR revoked_at IS NULL)
     ORDER BY revoked_at IS NULL DESC, created_at DESC`,
  )
    .bind(appId, includeRevoked ? 1 : 0)
    .all<DeployTokenRow>();
  return c.json({ deploy_tokens: results.map(toResponse) });
}

export async function handleCreateAppDeployToken(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    app_role?: unknown;
    scopes?: unknown;
    expires_at?: unknown;
    expires_in_days?: unknown;
  } & Record<string, unknown>;

  // Token minting is strict-validated: an unrecognized field must 400, never
  // silently mint a broader token than the caller asked for (a misspelled
  // expiry field used to yield a NON-EXPIRING token).
  // app_id appears in the body when invoked through the agent-manifest layer
  // (path params are mirrored into the body); accept and ignore it.
  const allowedKeys = new Set(["name", "app_role", "scopes", "expires_at", "expires_in_days", "app_id"]);
  const unknownKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    return c.json(
      { error: `unknown field(s): ${unknownKeys.join(", ")} — accepted: name, app_role, scopes, expires_at (unix ms), expires_in_days` },
      400,
    );
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);
  if (name.length > 80) return c.json({ error: "name must be 80 characters or fewer" }, 400);
  const appRole = body.app_role == null ? null : body.app_role;
  if (appRole !== null && !isDeployTokenRole(appRole)) {
    return c.json({ error: "app_role must be publisher or viewer" }, 400);
  }
  let scopes: AppPermission[] | null = null;
  if (body.scopes != null) {
    if (!Array.isArray(body.scopes) || body.scopes.length === 0 || !body.scopes.every(isAppPermission)) {
      return c.json({ error: "scopes must be a non-empty array of supported permissions" }, 400);
    }
    scopes = [...new Set(body.scopes)] as AppPermission[];
  }
  if (appRole === null && scopes === null) {
    return c.json({ error: "provide app_role, scopes, or both" }, 400);
  }

  if (body.expires_at != null && body.expires_in_days != null) {
    return c.json({ error: "provide expires_at or expires_in_days, not both" }, 400);
  }
  let expiresAt: number | null;
  try {
    if (body.expires_in_days != null) {
      const days = Number(body.expires_in_days);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        throw new Error("expires_in_days must be a positive number of days (max 3650)");
      }
      expiresAt = Date.now() + Math.round(days * 24 * 60 * 60 * 1000);
    } else {
      expiresAt = parseExpiresAt(body.expires_at);
    }
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const { token, token_prefix } = generateDeployToken();
  const tokenHash = await hashDeployToken(token);
  const account = currentAccount(c);
  const actor = currentActor(c);

  await c.env.DB.prepare(
    `INSERT INTO app_deploy_tokens
     (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by,
      created_by_actor, created_at, expires_at, last_used_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL)`,
  )
    .bind(
      id,
      appId,
      name,
      token_prefix,
      tokenHash,
      appRole,
      scopes ? JSON.stringify(scopes) : null,
      account?.id ?? null,
      actor,
      now,
      expiresAt,
    )
    .run();

  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "deploy_token.create",
    payload: {
      id,
      name,
      token_prefix,
      app_role: appRole,
      scopes,
      effective_permissions: [...resolveAppGrantPermissions(appRole, scopes)],
      expires_at: expiresAt,
    },
    created_at: now,
  });

  return c.json(
    {
      token,
      deploy_token: {
        id,
        app_id: appId,
        name,
        token_prefix,
        app_role: appRole,
        scopes,
        grant_valid: true,
        effective_permissions: [...resolveAppGrantPermissions(appRole, scopes)],
        created_by: account?.id ?? null,
        created_by_actor: actor,
        created_at: now,
        expires_at: expiresAt,
        last_used_at: null,
        revoked_at: null,
      },
    },
    201,
  );
}

export async function handleRevokeAppDeployToken(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const tokenId = c.req.param("tokenId") ?? "";
  const now = Date.now();
  const existing = await c.env.DB.prepare(
    "SELECT id, name, token_prefix FROM app_deploy_tokens WHERE id = ?1 AND app_id = ?2 LIMIT 1",
  )
    .bind(tokenId, appId)
    .first<{ id: string; name: string; token_prefix: string }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  await c.env.DB.prepare(
    "UPDATE app_deploy_tokens SET revoked_at = ?1 WHERE id = ?2 AND app_id = ?3",
  )
    .bind(now, tokenId, appId)
    .run();

  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "deploy_token.revoke",
    payload: {
      id: existing.id,
      name: existing.name,
      token_prefix: existing.token_prefix,
    },
    created_at: now,
  });

  return c.json({ ok: true, id: tokenId, revoked_at: now });
}
