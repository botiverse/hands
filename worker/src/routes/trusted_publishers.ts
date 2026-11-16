import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { currentAccount, insertAuditLog } from "../lib/permissions";
import { generateDeployToken, hashDeployToken, isDeployTokenRole, type DeployTokenRole } from "../lib/deploy_tokens";
import {
  GithubOidcError,
  normalizeRefPatterns,
  normalizeRepository,
  normalizeWorkflowPath,
  trustedPublisherMismatch,
  verifyGithubOidcToken,
  type GithubOidcClaims,
  type TrustedPublisher,
} from "../lib/github_oidc";
import { businessOrigin, requestOrigin } from "../lib/origin";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

/** Lifetime of a Hands token minted from a GitHub OIDC token. */
export const GITHUB_OIDC_DEPLOY_TOKEN_TTL_MS = 60 * 60 * 1000;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9 ._-]{1,255}$/;

type PublisherRow = {
  id: string;
  app_id: string;
  repository: string;
  repository_id: string | null;
  repository_owner_id: string | null;
  workflow_path: string;
  ref_patterns_json: string;
  environment: string | null;
  app_role: DeployTokenRole;
  created_by: string | null;
  created_by_actor: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

function parseRefPatterns(json: string): string[] {
  try {
    return normalizeRefPatterns(JSON.parse(json)) ?? [];
  } catch {
    return [];
  }
}

function toPublisher(row: PublisherRow): TrustedPublisher {
  return {
    id: row.id,
    app_id: row.app_id,
    repository: row.repository,
    repository_id: row.repository_id,
    repository_owner_id: row.repository_owner_id,
    workflow_path: row.workflow_path,
    ref_patterns: parseRefPatterns(row.ref_patterns_json),
    environment: row.environment,
  };
}

function toResponse(row: PublisherRow) {
  const { ref_patterns_json: _json, ...rest } = row;
  return { ...rest, provider: "github", ref_patterns: parseRefPatterns(row.ref_patterns_json) };
}

const SELECT_COLUMNS = `id, app_id, repository, repository_id, repository_owner_id, workflow_path, ref_patterns_json, environment,
  app_role, created_by, created_by_actor, created_at, last_used_at, revoked_at`;

export async function handleListTrustedPublishers(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const includeRevoked = c.req.query("include_revoked") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM app_github_trusted_publishers
     WHERE app_id = ?1 AND (?2 = 1 OR revoked_at IS NULL)
     ORDER BY revoked_at IS NULL DESC, created_at DESC`,
  ).bind(appId, includeRevoked ? 1 : 0).all<PublisherRow>();
  return c.json({ trusted_publishers: results.map(toResponse) });
}

export async function handleCreateTrustedPublisher(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const allowed = new Set(["provider", "repository", "repository_id", "workflow_path", "ref_patterns", "environment", "app_role", "app_id"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return c.json({ error: `unknown field(s): ${unknown.join(", ")} — accepted: repository, workflow_path, ref_patterns, environment, repository_id, app_role` }, 400);
  }
  if (body.provider !== undefined && body.provider !== "github") {
    return c.json({ error: "provider must be github" }, 400);
  }
  const repository = normalizeRepository(body.repository);
  if (!repository) return c.json({ error: "repository must be owner/repo" }, 400);
  const workflowPath = normalizeWorkflowPath(body.workflow_path);
  if (!workflowPath) return c.json({ error: "workflow_path must be .github/workflows/<file>.yml" }, 400);
  const refPatterns = normalizeRefPatterns(body.ref_patterns);
  if (!refPatterns) {
    return c.json({ error: "ref_patterns must be 1-20 patterns like refs/heads/main or refs/tags/v*" }, 400);
  }
  let environment: string | null = null;
  if (body.environment !== undefined && body.environment !== null && body.environment !== "") {
    if (typeof body.environment !== "string" || !ENVIRONMENT_PATTERN.test(body.environment)) {
      return c.json({ error: "environment must be a GitHub environment name" }, 400);
    }
    environment = body.environment;
  }
  let repositoryId: string | null = null;
  if (body.repository_id !== undefined && body.repository_id !== null && body.repository_id !== "") {
    repositoryId = String(body.repository_id).trim();
    if (!/^\d{1,20}$/.test(repositoryId)) return c.json({ error: "repository_id must be numeric" }, 400);
  }
  const appRole = body.app_role ?? "publisher";
  if (!isDeployTokenRole(appRole)) return c.json({ error: "app_role must be publisher or viewer" }, 400);

  const now = Date.now();
  const id = crypto.randomUUID();
  const account = currentAccount(c);
  await c.env.DB.prepare(
    `INSERT INTO app_github_trusted_publishers
     (id, app_id, repository, repository_id, workflow_path, ref_patterns_json, environment, app_role,
      created_by, created_by_actor, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    id, appId, repository, repositoryId, workflowPath, JSON.stringify(refPatterns), environment, appRole,
    account?.id ?? null, currentActor(c), now,
  ).run();
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "trusted_publisher.create",
    payload: { id, provider: "github", repository, repository_id: repositoryId, workflow_path: workflowPath, ref_patterns: refPatterns, environment, app_role: appRole },
  });
  const row = await c.env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM app_github_trusted_publishers WHERE id = ?1`)
    .bind(id).first<PublisherRow>();
  return c.json({ trusted_publisher: row ? toResponse(row) : null }, 201);
}

export async function handleRevokeTrustedPublisher(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const publisherId = c.req.param("publisherId") ?? "";
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE app_github_trusted_publishers SET revoked_at = ?1
     WHERE id = ?2 AND app_id = ?3 AND revoked_at IS NULL`,
  ).bind(now, publisherId, appId).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return c.json({ error: "trusted publisher not found" }, 404);
  // Tokens already minted through it stop working too.
  await c.env.DB.prepare(
    `UPDATE app_deploy_tokens SET revoked_at = ?1
     WHERE app_id = ?2 AND revoked_at IS NULL
       AND id IN (SELECT deploy_token_id FROM github_oidc_exchanges WHERE publisher_id = ?3)`,
  ).bind(now, appId, publisherId).run();
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "trusted_publisher.revoke", payload: { id: publisherId } });
  return c.json({ revoked: true });
}

/**
 * Exchange a GitHub Actions OIDC token for a short-lived Hands deploy token on
 * one app. Public: the GitHub token is the credential. Its audience must be
 * this Hands origin, and its repository, workflow and ref must match one of
 * the app's trusted publishers. Each GitHub token can be exchanged once.
 */
export async function handleGithubOidcExchange(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json().catch(() => null)) as { app?: unknown; token?: unknown } | null;
  const appRef = typeof body?.app === "string" ? body.app.trim() : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!appRef || !token) return c.json({ error: "app and token are required", code: "invalid_request" }, 400);
  if (token.length > 16_384) return c.json({ error: "token too large", code: "invalid_request" }, 400);

  // The configured public origin, so a workers.dev or preview hostname is not
  // also an accepted audience.
  const audience = businessOrigin(c.env, () => requestOrigin(c));
  let claims: GithubOidcClaims;
  try {
    claims = await verifyGithubOidcToken(token, audience);
  } catch (error) {
    if (error instanceof GithubOidcError) {
      const status = error.code === "jwks_unavailable" ? 503 : 401;
      return c.json({ error: error.message, code: `github_oidc_${error.code}`, audience }, status);
    }
    throw error;
  }

  const app = await c.env.DB.prepare(`SELECT id, slug FROM apps WHERE id = ?1 OR slug = ?1 LIMIT 1`)
    .bind(appRef).first<{ id: string; slug: string }>();
  const { results } = app
    ? await c.env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} FROM app_github_trusted_publishers WHERE app_id = ?1 AND revoked_at IS NULL
       ORDER BY created_at`,
    ).bind(app.id).all<PublisherRow>()
    : { results: [] as PublisherRow[] };
  const match = results.find((row) => trustedPublisherMismatch(toPublisher(row), claims) === null) ?? null;
  if (!app || !match) {
    // One answer whether the app is unknown, has no publishers, or none match,
    // so the endpoint cannot be used to probe apps. It echoes only the caller's
    // own claims, which is what a workflow author needs to compare.
    return c.json({
      error: "no trusted publisher on this app matches this workflow run",
      code: "github_oidc_no_trusted_publisher",
      repository: claims.repository,
      workflow_ref: claims.workflow_ref,
      ref: claims.ref,
      event_name: claims.event_name,
    }, 403);
  }

  const now = Date.now();
  const expiresAt = now + GITHUB_OIDC_DEPLOY_TOKEN_TTL_MS;
  const { token: deployToken, token_prefix } = generateDeployToken();
  const deployTokenId = crypto.randomUUID();
  const actor = `github:${claims.repository}/${match.workflow_path}`;
  const name = `github ${claims.repository} run ${claims.run_id}`.slice(0, 80);
  try {
    await c.env.DB.batch([
      // The jti claim first: a replayed GitHub token fails here and nothing is minted.
      c.env.DB.prepare(
        `INSERT INTO github_oidc_exchanges (jti, publisher_id, deploy_token_id, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(claims.jti, match.id, deployTokenId, claims.exp * 1000 + 60_000, now),
      c.env.DB.prepare(
        `INSERT INTO app_deploy_tokens
         (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by, created_by_actor, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8, ?9)`,
      ).bind(deployTokenId, app.id, name, token_prefix, await hashDeployToken(deployToken), match.app_role, actor, now, expiresAt),
      // Pin the repository id the first time a run is accepted.
      c.env.DB.prepare(
        `UPDATE app_github_trusted_publishers SET last_used_at = ?1, repository_id = COALESCE(repository_id, ?2),
           repository_owner_id = COALESCE(repository_owner_id, ?4)
         WHERE id = ?3`,
      ).bind(now, claims.repository_id, match.id, claims.repository_owner_id ?? null),
      c.env.DB.prepare(
        `INSERT INTO audit_logs (id, app_id, action, actor, actor_id, actor_type, payload, created_at)
         VALUES (?1, ?2, 'trusted_publisher.exchange', ?3, NULL, 'system', ?4, ?5)`,
      ).bind(crypto.randomUUID(), app.id, actor, JSON.stringify({
        trusted_publisher_id: match.id,
        deploy_token_prefix: token_prefix,
        expires_at: expiresAt,
        repository: claims.repository,
        repository_id: claims.repository_id,
        workflow_ref: claims.workflow_ref,
        ref: claims.ref,
        sha: claims.sha,
        run_id: claims.run_id,
        run_attempt: claims.run_attempt ?? null,
        event_name: claims.event_name,
        environment: claims.environment ?? null,
        github_actor: claims.actor ?? null,
        jti: claims.jti,
      }), now),
    ]);
  } catch (error) {
    const replay = await c.env.DB.prepare("SELECT 1 AS hit FROM github_oidc_exchanges WHERE jti = ?1")
      .bind(claims.jti).first();
    if (replay) {
      return c.json({ error: "this GitHub token was already exchanged; request a new one", code: "github_oidc_token_reused" }, 409);
    }
    throw error;
  }
  // Old exchange records are only replay guards; drop the expired ones.
  await c.env.DB.prepare("DELETE FROM github_oidc_exchanges WHERE expires_at < ?1")
    .bind(now - 24 * 60 * 60 * 1000).run().catch(() => undefined);

  return c.json({
    token: deployToken,
    token_prefix,
    expires_at: expiresAt,
    app_id: app.id,
    app_slug: app.slug,
    app_role: match.app_role,
    trusted_publisher_id: match.id,
  }, 201);
}
