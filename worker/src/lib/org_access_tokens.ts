/**
 * Org-level fine-grained access tokens (`qvot_` prefix).
 *
 * An org admin picks a set of the org's apps (or all of them) and a set of
 * permissions. On each request the token is resolved against exactly one app —
 * the one named in the request path — and turned into a synthetic, role-free
 * `AppDeployToken` for that app, so every existing app permission check applies
 * unchanged.
 */

import { isAppPermission, type AppPermission } from "./app_permissions";
import { sha256Hex, type AppDeployToken } from "./deploy_tokens";

export const ORG_TOKEN_PREFIX = "qvot";

/** v1 is read-only. Nothing here may write, publish, or administer. */
export const ORG_TOKEN_ALLOWED_SCOPES = ["app:read", "feedback:read"] as const satisfies readonly AppPermission[];

export function isOrgTokenScope(value: unknown): value is (typeof ORG_TOKEN_ALLOWED_SCOPES)[number] {
  return typeof value === "string" && (ORG_TOKEN_ALLOWED_SCOPES as readonly string[]).includes(value);
}

export function isOrgAccessTokenBearer(token: string | undefined): token is string {
  return typeof token === "string" && token.startsWith(`${ORG_TOKEN_PREFIX}_`);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function generateOrgAccessToken(): { token: string; token_prefix: string } {
  const prefixBytes = new Uint8Array(8);
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(prefixBytes);
  crypto.getRandomValues(secretBytes);
  const token_prefix = `${ORG_TOKEN_PREFIX}_${base64Url(prefixBytes)}`;
  return { token_prefix, token: `${token_prefix}_${base64Url(secretBytes)}` };
}

export async function hashOrgAccessToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/**
 * Parses stored scopes, failing closed: anything that is not a non-empty array
 * of v1-allowed scopes yields an empty grant (the deploy-token sentinel for
 * "corrupt grant", which every permission check rejects).
 */
export function parseOrgTokenScopes(scopesJson: string | null): AppPermission[] {
  if (scopesJson === null) return [];
  try {
    const parsed = JSON.parse(scopesJson);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s) => isAppPermission(s) && isOrgTokenScope(s))) {
      return parsed as AppPermission[];
    }
  } catch {
    // fall through
  }
  return [];
}

/**
 * The app id an org token request targets: the first segment after
 * `/api/apps/`. Returns null for any path outside `/api/apps/<appId>[/...]`.
 * The raw path segment is compared to `apps.id` exactly — a slug or an encoded
 * variant never resolves, so it cannot be used to slip past the boundary.
 */
export function orgTokenTargetAppId(pathname: string): string | null {
  const match = /^\/api\/apps\/([^/]+)(?:\/.*)?$/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * The single definition of "apps eligible for an org token of org X", as a SQL
 * predicate over an `apps` row. An app is eligible when the org owns it
 * (`apps.org_id = X`) or co-owns it through an `owner_server` grant, under the
 * same rule that gives an account access (getOwnerServerRole): X is a
 * non-archived `raft` organization, the token's creator is still a member of X
 * with a Raft account on X's own server, and the grant names that server by id or
 * by the creator's own server slug. `legacy_role` grants never count. A creator
 * who leaves X (or whose account is deleted) takes the co-owned apps out of the
 * token; demotion within X does not, matching the account path.
 *
 * Coverage, create validation, audit lists, and the list display all use this
 * predicate, so they cannot drift. Because it is evaluated on every request,
 * removing the grant (or flipping it to legacy_role) ends access immediately.
 *
 * The arguments are SQL expressions chosen by the caller in code — a table alias,
 * and column references or `?N` placeholders for the org and the creator — never
 * request data, so every value stays a bound parameter.
 */
export function orgEligibleAppSql(appAlias: string, orgIdExpr: string, accountIdExpr: string): string {
  const expr = /^(?:[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?|\?\d+)$/i;
  if (!/^[a-z_][a-z0-9_]*$/i.test(appAlias) || !expr.test(orgIdExpr) || !expr.test(accountIdExpr)) {
    throw new Error("orgEligibleAppSql takes an identifier and columns or ?N placeholders");
  }
  return `(
    ${appAlias}.org_id = ${orgIdExpr}
    OR EXISTS (
      SELECT 1
      FROM app_server_grants g
      JOIN organizations o
        ON o.id = ${orgIdExpr}
       AND o.external_provider = 'raft'
       AND o.archived = 0
      WHERE g.app_id = ${appAlias}.id
        AND g.access_model = 'owner_server'
        AND EXISTS (
          -- Exactly the account path (getOwnerServerRole): the token's creator must be
          -- an account of the org's own server, still a member of the org, and the
          -- grant must name that server by id or by the creator's own server slug.
          -- An admin invited from another server never inherits the co-ownership,
          -- and a creator who leaves takes the co-owned apps out of the token.
          SELECT 1
          FROM raft_accounts ra
          JOIN org_members om ON om.org_id = o.id AND om.account_id = ra.id
          WHERE ra.id = ${accountIdExpr}
            AND ra.server_id = o.external_id
            AND (
              g.server_id = ra.server_id
              OR (g.server_slug IS NOT NULL AND g.server_slug = ra.server_slug)
            )
        )
    )
  )`;
}

export type OrgTokenResolution =
  | { kind: "unknown" }
  | { kind: "not_covered"; org_token_id: string }
  | { kind: "ok"; token: AppDeployToken; org_id: string };

type OrgTokenLookupRow = {
  id: string;
  org_id: string;
  name: string;
  token_prefix: string;
  scopes_json: string;
  created_by: string | null;
  created_by_actor: string;
  created_at: number;
  expires_at: number | null;
  covered_app_id: string | null;
  covered_app_slug: string | null;
};

/**
 * Resolve an org token for one target app. Token validity (hash, not revoked,
 * not expired) and coverage (the app exists, is eligible for the token's org —
 * owned or co-owned, see orgEligibleAppSql — and is either selected or covered
 * by all_apps) are decided in one query.
 */
export async function resolveOrgAccessToken(
  env: Env,
  bearer: string,
  appId: string,
): Promise<OrgTokenResolution> {
  if (!isOrgAccessTokenBearer(bearer)) return { kind: "unknown" };
  const tokenHash = await hashOrgAccessToken(bearer);
  const now = Date.now();
  const lookup = env.DB.prepare(
    `SELECT t.id, t.org_id, t.name, t.token_prefix, t.scopes_json, t.created_by,
            t.created_by_actor, t.created_at, t.expires_at,
            a.id AS covered_app_id, a.slug AS covered_app_slug
     FROM org_access_tokens t
     LEFT JOIN apps a
       ON a.id = ?2
      AND ${orgEligibleAppSql("a", "t.org_id", "t.created_by")}
      AND (
        t.all_apps = 1
        OR EXISTS (
          SELECT 1 FROM org_access_token_apps ta
          WHERE ta.token_id = t.id AND ta.app_id = a.id
        )
      )
     WHERE t.token_hash = ?1
       AND t.revoked_at IS NULL
       AND (t.expires_at IS NULL OR t.expires_at > ?3)
     LIMIT 1`,
  ).bind(tokenHash, appId, now);
  const touch = env.DB.prepare(
    `UPDATE org_access_tokens SET last_used_at = ?1
     WHERE token_hash = ?2 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?1)`,
  ).bind(now, tokenHash);
  const [lookupResult] = await env.DB.batch([lookup, touch]);
  const row = lookupResult?.results[0] as OrgTokenLookupRow | undefined;
  if (!row) return { kind: "unknown" };
  if (row.covered_app_id === null || row.covered_app_id !== appId) {
    return { kind: "not_covered", org_token_id: row.id };
  }
  return {
    kind: "ok",
    org_id: row.org_id,
    token: {
      id: row.id,
      app_id: row.covered_app_id,
      app_slug: row.covered_app_slug ?? row.covered_app_id,
      name: row.name,
      token_prefix: row.token_prefix,
      app_role: null,
      scopes: parseOrgTokenScopes(row.scopes_json),
      created_by: row.created_by,
      created_by_actor: row.created_by_actor,
      created_at: row.created_at,
      expires_at: row.expires_at,
      last_used_at: now,
      revoked_at: null,
      reporter_integration_id: null,
      reporter_integration_active: null,
    },
  };
}
