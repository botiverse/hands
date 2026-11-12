import { z } from "@hono/zod-openapi";
import {
  AccountIdParam,
  AppIdParam,
  GenericObject,
  InviteIdParam,
  InviteTokenParam,
  OrgIdParam,
  OrgRole,
  TokenIdParam,
  WebhookIdParam,
  auth,
  error,
  json,
  success,
  type RouteConfigDef,
  type RouteConfigList,
} from "./common";

const OrgMemberParams = OrgIdParam.merge(AccountIdParam);
const OrgInviteParams = OrgIdParam.merge(InviteIdParam);
const OrgWebhookParams = OrgIdParam.merge(WebhookIdParam);
const AppWebhookParams = AppIdParam.merge(WebhookIdParam);
const OrgAccessTokenParams = OrgIdParam.merge(TokenIdParam);

const OrgAccessTokenScope = z.enum(["app:read", "feedback:read"]);

const OrgAccessToken = z
  .object({
    id: z.string(),
    org_id: z.string(),
    name: z.string(),
    token_prefix: z.string(),
    scopes: z.array(OrgAccessTokenScope),
    all_apps: z.boolean(),
    apps: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })).openapi({
      description: "Selected apps. Empty when all_apps is true.",
    }),
    created_by: z.string().nullable(),
    created_by_actor: z.string(),
    created_at: z.number().int(),
    expires_at: z.number().int().nullable(),
    last_used_at: z.number().int().nullable(),
    revoked_at: z.number().int().nullable(),
  })
  .openapi("OrgAccessToken");

const CreateOrgAccessTokenRequest = z
  .object({
    name: z.string().min(1).max(80),
    scopes: z.array(OrgAccessTokenScope).min(1),
    app_ids: z.array(z.string()).min(1).optional().openapi({
      description: "Apps the token may read. Every app must belong to this organization. Provide exactly one of app_ids or all_apps.",
    }),
    all_apps: z.literal(true).optional().openapi({
      description: "Cover every app in the organization, including apps created later.",
    }),
    expires_in_days: z.number().positive().max(3650).optional(),
    expires_at: z.number().int().optional().openapi({
      description:
        "Optional absolute expiry as unix timestamp in milliseconds. Must be at least 60 seconds in the future.",
    }),
  })
  .openapi("CreateOrgAccessTokenRequest");

const CreateOrgAccessTokenResponse = z
  .object({
    token: z.string().openapi({
      description:
        "Raw bearer token. It is returned only once and should be stored directly in a secret manager.",
    }),
    access_token: OrgAccessToken,
  })
  .openapi("CreateOrgAccessTokenResponse");

const InviteInput = z
  .object({
    email: z.string().email(),
    role: z.string().optional(),
    app_id: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
  })
  .openapi("InviteInput");

const WebhookInput = z
  .object({
    url: z.string().url().optional(),
    secret: z.string().optional(),
    events: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .openapi("WebhookInput");

export function registerOrgRoutes(): RouteConfigList {
  const routes: RouteConfigDef[] = [];
  routes.push({
    method: "get",
    path: "/api/orgs",
    tags: ["Organizations"],
    summary: "List organizations for the current principal",
    security: auth,
    responses: {
      200: success("Organization list.", z.object({ orgs: z.array(GenericObject) })),
      401: error("Missing or invalid authentication."),
    },
  });

  routes.push({
    method: "get",
    path: "/api/orgs/{orgId}/members",
    tags: ["Organizations"],
    summary: "List organization members",
    security: auth,
    request: { params: OrgIdParam },
    responses: {
      200: success("Organization member list.", z.object({ members: z.array(GenericObject) })),
      403: error("Current principal cannot view org members."),
    },
  });

  routes.push({
    method: "patch",
    path: "/api/orgs/{orgId}/members/{accountId}",
    tags: ["Organizations"],
    summary: "Update organization member role",
    security: auth,
    request: {
      params: OrgMemberParams,
      body: { content: json(z.object({ org_role: OrgRole })), required: true },
    },
    responses: {
      200: success("Updated member.", GenericObject),
      400: error("Invalid role."),
      403: error("Current principal cannot update org members."),
    },
  });

  routes.push({
    method: "delete",
    path: "/api/orgs/{orgId}/members/{accountId}",
    tags: ["Organizations"],
    summary: "Remove organization member",
    security: auth,
    request: { params: OrgMemberParams },
    responses: {
      200: success("Removed member.", GenericObject),
      403: error("Current principal cannot remove org members."),
    },
  });

  for (const [method, path, summary] of [
    ["get", "/api/orgs/{orgId}/invites", "List organization invites"],
    ["post", "/api/orgs/{orgId}/invites", "Create organization or app invite link"],
    ["post", "/api/orgs/{orgId}/invites/{inviteId}/resend", "Refresh invite link"],
    ["delete", "/api/orgs/{orgId}/invites/{inviteId}", "Revoke invite link"],
  ] as const) {
    const hasInviteId = path.includes("{inviteId}");
    routes.push({
      method,
      path,
      tags: ["Invites"],
      summary,
      security: auth,
      request: {
        params: hasInviteId ? OrgInviteParams : OrgIdParam,
        ...(method === "post" && !hasInviteId
          ? { body: { content: json(InviteInput), required: true } }
          : {}),
        ...(method === "get"
          ? { query: z.object({ status: z.string().optional() }) }
          : {}),
      },
      responses: {
        [method === "post" && !hasInviteId ? 201 : 200]: success("Invite operation result.", GenericObject),
        400: error("Invalid invite request."),
        403: error("Current principal cannot manage invites."),
        404: error("Invite was not found."),
      },
    });
  }

  routes.push({
    method: "post",
    path: "/api/invites/{token}/accept",
    tags: ["Invites"],
    summary: "Accept an invite as the current principal",
    security: auth,
    request: { params: InviteTokenParam },
    responses: {
      200: success("Accepted invite.", GenericObject),
      403: error("Current principal cannot accept this invite."),
      404: error("Invite was not found."),
      409: error("Invite is not pending."),
      410: error("Invite expired."),
    },
  });

  routes.push({
    method: "get",
    path: "/api/orgs/{orgId}/audit-logs",
    tags: ["Audit"],
    summary: "List organization audit logs",
    security: auth,
    request: {
      params: OrgIdParam,
      query: z.object({
        actor_id: z.string().optional(),
        action_prefix: z.string().optional(),
      }),
    },
    responses: {
      200: success("Audit log list.", z.object({ audit_logs: z.array(GenericObject) }).catchall(z.unknown())),
      403: error("Current principal cannot view org audit logs."),
    },
  });

  routes.push({
    method: "get",
    path: "/api/orgs/{orgId}/access-tokens",
    tags: ["Organizations"],
    summary: "List organization access tokens",
    description: "Org admin only, from a signed-in session. Raw token values and hashes are never returned.",
    security: auth,
    request: {
      params: OrgIdParam,
      query: z.object({ include_revoked: z.enum(["1"]).optional() }),
    },
    responses: {
      200: success("Organization access token list.", z.object({ access_tokens: z.array(OrgAccessToken) })),
      401: error("Missing or invalid authentication."),
      403: error("Current principal cannot manage organization access tokens."),
    },
  });

  routes.push({
    method: "post",
    path: "/api/orgs/{orgId}/access-tokens",
    tags: ["Organizations"],
    summary: "Create an organization access token",
    description:
      "Creates a read-only, fine-grained token over selected apps of this organization (app_ids) or all of them (all_apps). Allowed scopes are app:read and feedback:read. The token only works on /api/apps/{appId} paths for apps it covers. The raw token is returned once in this response; store it directly in a secret manager.",
    security: auth,
    request: {
      params: OrgIdParam,
      body: { content: json(CreateOrgAccessTokenRequest), required: true },
    },
    responses: {
      201: success("Created organization access token. token is shown once.", CreateOrgAccessTokenResponse),
      400: error("Invalid request."),
      401: error("Missing or invalid authentication."),
      403: error("Current principal cannot manage organization access tokens."),
    },
  });

  routes.push({
    method: "delete",
    path: "/api/orgs/{orgId}/access-tokens/{tokenId}",
    tags: ["Organizations"],
    summary: "Revoke an organization access token",
    security: auth,
    request: { params: OrgAccessTokenParams },
    responses: {
      200: success(
        "Revoked organization access token.",
        z.object({ ok: z.literal(true), id: z.string(), revoked_at: z.number().int() }),
      ),
      401: error("Missing or invalid authentication."),
      403: error("Current principal cannot manage organization access tokens."),
      404: error("Organization access token was not found."),
    },
  });

  for (const [method, path, summary] of [
    ["get", "/api/orgs/{orgId}/webhooks", "List webhooks"],
    ["post", "/api/orgs/{orgId}/webhooks", "Create webhook"],
    ["patch", "/api/orgs/{orgId}/webhooks/{webhookId}", "Update webhook"],
    ["delete", "/api/orgs/{orgId}/webhooks/{webhookId}", "Delete webhook"],
    ["get", "/api/orgs/{orgId}/webhooks/{webhookId}/deliveries", "List webhook deliveries"],
  ] as const) {
    const hasWebhookId = path.includes("{webhookId}");
    const needsBody = method === "post" || method === "patch";
    routes.push({
      method,
      path,
      tags: ["Webhooks"],
      summary,
      security: auth,
      request: {
        params: hasWebhookId ? OrgWebhookParams : OrgIdParam,
        ...(needsBody ? { body: { content: json(WebhookInput), required: true } } : {}),
      },
      responses: {
        [method === "post" ? 201 : 200]: success("Webhook operation result.", GenericObject),
        400: error("Invalid webhook request."),
        403: error("Current principal cannot manage webhooks."),
        404: error("Webhook was not found."),
      },
    });
  }

  // App-scoped webhooks: app admins manage webhooks bound to their own app.
  // The server forces app_id = {appId}; org-wide webhooks are not visible here.
  for (const [method, path, summary] of [
    ["get", "/api/apps/{appId}/webhooks", "List app webhooks"],
    ["post", "/api/apps/{appId}/webhooks", "Create app webhook"],
    ["patch", "/api/apps/{appId}/webhooks/{webhookId}", "Update app webhook"],
    ["delete", "/api/apps/{appId}/webhooks/{webhookId}", "Delete app webhook"],
    ["get", "/api/apps/{appId}/webhooks/{webhookId}/deliveries", "List app webhook deliveries"],
  ] as const) {
    const hasWebhookId = path.includes("{webhookId}");
    const needsBody = method === "post" || method === "patch";
    routes.push({
      method,
      path,
      tags: ["Webhooks"],
      summary,
      security: auth,
      request: {
        params: hasWebhookId ? AppWebhookParams : AppIdParam,
        ...(needsBody ? { body: { content: json(WebhookInput), required: true } } : {}),
      },
      responses: {
        [method === "post" ? 201 : 200]: success("Webhook operation result.", GenericObject),
        400: error("Invalid webhook request."),
        403: error("Current principal is not an admin of this app."),
        404: error("Webhook was not found on this app."),
      },
    });
  }
  return routes;
}

