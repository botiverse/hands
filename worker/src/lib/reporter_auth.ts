import type { Context } from "hono";
import {
  isFeedbackTokenPermission,
  type FeedbackTokenPermission,
} from "./app_permissions";
import { loadDeployToken, type AppDeployToken } from "./deploy_tokens";
import {
  isReporterSessionToken,
  verifyReporterSession,
} from "./reporter_sessions";

export const REPORTER_ID_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

export type ReporterPrincipal = {
  appId: string;
  integrationId: string;
  reporterId: string;
  authMode: "deploy_token" | "session";
  sessionVerifyDurationMs: number | null;
};

type ReporterContext = Context<{ Bindings: Env }>;

export function reporterBearerValue(c: ReporterContext): string | null {
  const authorization = c.req.header("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const value = authorization.slice("Bearer ".length).trim();
  return value || null;
}

export async function authenticateReporter(
  c: ReporterContext,
  required: FeedbackTokenPermission,
): Promise<
  | { ok: true; principal: ReporterPrincipal }
  | { ok: false; response: Response }
> {
  const appId = c.req.param("appId") ?? "";
  const reporterId = (c.req.header("X-Hands-Reporter-Id") ?? "").trim();
  if (!REPORTER_ID_PATTERN.test(reporterId)) {
    return {
      ok: false,
      response: c.json(
        { error: "X-Hands-Reporter-Id must be a 16-200 character opaque base64url value" },
        400,
      ),
    };
  }

  const bearer = reporterBearerValue(c);
  if (!bearer) {
    return { ok: false, response: c.json({ error: "invalid or missing bearer token" }, 401) };
  }
  if (isReporterSessionToken(bearer)) {
    const verifyStartedAt = performance.now();
    const verified = await verifyReporterSession(c.env, bearer);
    const sessionVerifyDurationMs = Math.max(0, performance.now() - verifyStartedAt);
    if (!verified.ok) {
      return {
        ok: false,
        response: c.json(
          { error: verified.reason === "unavailable" ? "reporter session is not configured" : "invalid or missing bearer token" },
          verified.reason === "unavailable" ? 503 : 401,
        ),
      };
    }
    const claims = verified.claims;
    // Bind verified claims to the route and caller header before any D1 rate,
    // ownership, or data query. Downstream owner predicates remain defense in
    // depth, not the primary session boundary.
    if (
      claims.app_id !== appId
      || claims.reporter_id !== reporterId
      || !claims.scopes.includes(required)
    ) {
      return { ok: false, response: c.json({ error: "invalid reporter session grant" }, 403) };
    }
    return {
      ok: true,
      principal: {
        appId: claims.app_id,
        integrationId: claims.reporter_integration_id,
        reporterId: claims.reporter_id,
        authMode: "session",
        sessionVerifyDurationMs,
      },
    };
  }
  const token = await loadDeployToken(c.env, bearer);
  if (!token) {
    return { ok: false, response: c.json({ error: "invalid or missing bearer token" }, 401) };
  }

  const scopes = token.scopes;
  const grantValid = token.app_id === appId
    && token.app_role === null
    && token.reporter_integration_id !== null
    && token.reporter_integration_active === 1
    && scopes !== null
    && scopes.length > 0
    && scopes.every(isFeedbackTokenPermission)
    && scopes.includes(required);
  if (!grantValid) {
    return { ok: false, response: c.json({ error: "invalid reporter integration grant" }, 403) };
  }

  return {
    ok: true,
    principal: {
      appId,
      integrationId: token.reporter_integration_id!,
      reporterId,
      authMode: "deploy_token",
      sessionVerifyDurationMs: null,
    },
  };
}

export function isFeedbackOnlyToken(
  token: AppDeployToken,
  appId: string,
  required: FeedbackTokenPermission,
): boolean {
  return token.app_id === appId
    && token.app_role === null
    && token.reporter_integration_id !== null
    && token.reporter_integration_active === 1
    && token.scopes !== null
    && token.scopes.length > 0
    && token.scopes.every(isFeedbackTokenPermission)
    && token.scopes.includes(required);
}
