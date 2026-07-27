import type { Context } from "hono";
import {
  isFeedbackTokenPermission,
  type FeedbackTokenPermission,
} from "./app_permissions";
import { loadDeployToken, type AppDeployToken } from "./deploy_tokens";

export const REPORTER_ID_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

export type ReporterPrincipal = {
  appId: string;
  integrationId: string;
  reporterId: string;
  token: AppDeployToken;
};

type ReporterContext = Context<{ Bindings: Env }>;

function bearerValue(c: ReporterContext): string | null {
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

  const bearer = bearerValue(c);
  if (!bearer) {
    return { ok: false, response: c.json({ error: "invalid or missing bearer token" }, 401) };
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
      token,
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
