import { z } from "@hono/zod-openapi";
import {
  AccountIdParam,
  GenericObject,
  InviteIdParam,
  InviteTokenParam,
  OrgIdParam,
  OrgRole,
  WebhookIdParam,
  auth,
  error,
  json,
  register,
  success,
  type OpenApiRegistry,
} from "./common";

const OrgMemberParams = OrgIdParam.merge(AccountIdParam);
const OrgInviteParams = OrgIdParam.merge(InviteIdParam);
const OrgWebhookParams = OrgIdParam.merge(WebhookIdParam);

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

export function registerOrgRoutes(registry: OpenApiRegistry) {
  register(registry, {
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

  register(registry, {
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

  register(registry, {
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

  register(registry, {
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
    register(registry, {
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

  register(registry, {
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

  register(registry, {
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

  for (const [method, path, summary] of [
    ["get", "/api/orgs/{orgId}/webhooks", "List webhooks"],
    ["post", "/api/orgs/{orgId}/webhooks", "Create webhook"],
    ["patch", "/api/orgs/{orgId}/webhooks/{webhookId}", "Update webhook"],
    ["delete", "/api/orgs/{orgId}/webhooks/{webhookId}", "Delete webhook"],
    ["get", "/api/orgs/{orgId}/webhooks/{webhookId}/deliveries", "List webhook deliveries"],
  ] as const) {
    const hasWebhookId = path.includes("{webhookId}");
    const needsBody = method === "post" || method === "patch";
    register(registry, {
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
}

