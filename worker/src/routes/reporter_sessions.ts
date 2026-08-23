import type { Context } from "hono";
import { isFeedbackTokenPermission } from "../lib/app_permissions";
import { loadDeployToken } from "../lib/deploy_tokens";
import { computeReporterAuditHash } from "../lib/reporter_audit";
import { REPORTER_ID_PATTERN, reporterBearerValue } from "../lib/reporter_auth";
import {
  mintReporterSession,
  normalizeRequestedReporterSessionScopes,
  reporterSessionEnabled,
} from "../lib/reporter_sessions";

type ReporterSessionContext = Context<{ Bindings: Env }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MINT_WINDOW_MS = 60_000;
const MINT_REPORTER_LIMIT = 30;
const MINT_INTEGRATION_LIMIT = 300;

function timingDuration(start: number, end: number): string {
  return Math.max(0, end - start).toFixed(1);
}

async function consumeMintQuota(
  c: ReporterSessionContext,
  input: {
    appId: string;
    integrationId: string;
    tokenId: string;
    reporterHash: string;
    auditKeyVersion: string;
  },
) {
  const now = Date.now();
  const windowStartedAt = Math.floor(now / MINT_WINDOW_MS) * MINT_WINDOW_MS;
  const upsert = (bucket: string) => c.env.DB.prepare(
    `INSERT INTO feedback_reporter_session_mint_rate_windows
     (app_id, reporter_integration_id, deploy_token_id, reporter_hash,
      audit_key_version, window_started_at, request_count, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
     ON CONFLICT(app_id, reporter_integration_id, deploy_token_id,
                 reporter_hash, audit_key_version, window_started_at)
     DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at
     RETURNING request_count`,
  ).bind(
    input.appId,
    input.integrationId,
    input.tokenId,
    bucket,
    input.auditKeyVersion,
    windowStartedAt,
    now,
  );
  const [reporterResult, integrationResult] = await c.env.DB.batch([
    upsert(input.reporterHash),
    upsert("integration-total"),
  ]);
  const reporterCount = (reporterResult?.results[0] as { request_count?: number } | undefined)
    ?.request_count ?? 0;
  const integrationCount = (integrationResult?.results[0] as { request_count?: number } | undefined)
    ?.request_count ?? 0;
  if (reporterCount > MINT_REPORTER_LIMIT || integrationCount > MINT_INTEGRATION_LIMIT) {
    c.header(
      "Retry-After",
      String(Math.max(1, Math.ceil((windowStartedAt + MINT_WINDOW_MS - now) / 1000))),
    );
    return false;
  }
  return true;
}

export async function handleMintReporterSession(c: ReporterSessionContext) {
  // Disabled is indistinguishable from an absent route and retains the current
  // deploy-token-only behavior without new timing names.
  if (!reporterSessionEnabled(c.env)) return c.json({ error: "not found" }, 404);
  const startedAt = performance.now();
  const appId = (c.req.param("appId") ?? "").trim();
  const reporterId = (c.req.header("X-Hands-Reporter-Id") ?? "").trim();
  if (!UUID_RE.test(appId) || !REPORTER_ID_PATTERN.test(reporterId)) {
    return c.json({ error: "invalid reporter session request" }, 400);
  }
  const bearer = reporterBearerValue(c);
  if (!bearer) return c.json({ error: "invalid or missing bearer token" }, 401);
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 1024) {
    return c.json({ error: "invalid reporter session request" }, 400);
  }
  const token = await loadDeployToken(c.env, bearer);
  if (!token) return c.json({ error: "invalid or missing bearer token" }, 401);
  let body: unknown;
  try {
    const rawBody = await c.req.text();
    if (new TextEncoder().encode(rawBody).byteLength > 1024) {
      return c.json({ error: "invalid reporter session request" }, 400);
    }
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid reporter session request" }, 400);
  }
  const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  if (!bodyRecord || Object.keys(bodyRecord).length !== 1 || !("scopes" in bodyRecord)) {
    return c.json({ error: "invalid reporter session request" }, 400);
  }
  const requestedScopes = normalizeRequestedReporterSessionScopes(bodyRecord.scopes);
  if (!requestedScopes) return c.json({ error: "invalid reporter session request" }, 400);
  const tokenScopes = token.scopes;
  const grantValid = token.app_id === appId
    && token.app_role === null
    && token.reporter_integration_id !== null
    && token.reporter_integration_active === 1
    && tokenScopes !== null
    && tokenScopes.length > 0
    && tokenScopes.every(isFeedbackTokenPermission)
    && requestedScopes.every((scope) => tokenScopes.includes(scope));
  if (!grantValid) return c.json({ error: "invalid reporter integration grant" }, 403);
  const auditKey = c.env.FEEDBACK_AUDIT_HMAC_KEY;
  const auditKeyVersion = c.env.FEEDBACK_AUDIT_KEY_VERSION?.trim();
  if (!auditKey || !auditKeyVersion) {
    return c.json({ error: "reporter session is not configured" }, 503);
  }
  const reporterHash = await computeReporterAuditHash({
    key: auditKey,
    appId,
    integrationId: token.reporter_integration_id!,
    reporterId,
  });
  if (!reporterHash) return c.json({ error: "reporter session is not configured" }, 503);
  if (!await consumeMintQuota(c, {
    appId,
    integrationId: token.reporter_integration_id!,
    tokenId: token.id,
    reporterHash,
    auditKeyVersion,
  })) return c.json({ error: "reporter session mint rate limit exceeded" }, 429);
  const minted = await mintReporterSession(c.env, {
    appId,
    integrationId: token.reporter_integration_id!,
    reporterId,
    tokenId: token.id,
    scopes: requestedScopes,
  });
  if (!minted) return c.json({ error: "reporter session is not configured" }, 503);
  const completedAt = performance.now();
  c.header("Cache-Control", "private, no-store");
  c.header("Server-Timing", `hands_session_mint;dur=${timingDuration(startedAt, completedAt)}`);
  return c.json({
    session_token: minted.token,
    expires_at: minted.claims.exp,
    reporter_integration_id: minted.claims.reporter_integration_id,
    scopes: minted.claims.scopes,
  }, 201);
}
