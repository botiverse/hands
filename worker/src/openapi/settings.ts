import { z } from "@hono/zod-openapi";
import {
  AccountIdParam,
  AppIdParam,
  AppRole,
  ChannelIdParam,
  GenericObject,
  OperationIdParam,
  ProductTypeIdParam,
  ReleaseTypeIdParam,
  auth,
  error,
  json,
  success,
  type RouteConfigDef,
  type RouteConfigList,
} from "./common";

const AppChannelParams = AppIdParam.merge(ChannelIdParam);
const AppProductTypeParams = AppIdParam.merge(ProductTypeIdParam);
const AppReleaseTypeParams = AppIdParam.merge(ReleaseTypeIdParam);
const AppOperationParams = AppIdParam.merge(OperationIdParam);
const AppMemberParams = AppIdParam.merge(AccountIdParam);

function collectionRoutes(
  routes: RouteConfigDef[],
  tag: string,
  basePath: string,
  itemPath: string,
  itemParams: any,
  bodyName: string,
) {
  const Body = GenericObject.openapi(bodyName);
  routes.push( {
    method: "get",
    path: basePath,
    tags: [tag],
    summary: `List ${tag.toLowerCase()}`,
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success(`${tag} list.`, GenericObject),
      403: error(`Current principal cannot view ${tag.toLowerCase()}.`),
    },
  });

  routes.push( {
    method: "post",
    path: basePath,
    tags: [tag],
    summary: `Create ${tag.toLowerCase()} item`,
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(Body), required: true },
    },
    responses: {
      201: success(`${tag} item created.`, GenericObject),
      400: error("Invalid request."),
      403: error(`Current principal cannot create ${tag.toLowerCase()}.`),
    },
  });

  for (const method of ["patch", "delete"] as const) {
    routes.push( {
      method,
      path: itemPath,
      tags: [tag],
      summary: `${method === "patch" ? "Update" : "Delete"} ${tag.toLowerCase()} item`,
      security: auth,
      request: {
        params: itemParams,
        ...(method === "patch" ? { body: { content: json(Body), required: true } } : {}),
      },
      responses: {
        200: success(`${tag} item ${method === "patch" ? "updated" : "deleted"}.`, GenericObject),
        400: error("Invalid request."),
        403: error(`Current principal cannot modify ${tag.toLowerCase()}.`),
        404: error(`${tag} item was not found.`),
      },
    });
  }
}

export function registerSettingsRoutes(): RouteConfigList {
  const routes: RouteConfigDef[] = [];
  collectionRoutes(routes,
    "Channels",
    "/api/apps/{appId}/channels",
    "/api/apps/{appId}/channels/{channelId}",
    AppChannelParams,
    "ChannelInput",
  );

  collectionRoutes(routes,
    "Product types",
    "/api/apps/{appId}/product-types",
    "/api/apps/{appId}/product-types/{ptId}",
    AppProductTypeParams,
    "ProductTypeInput",
  );

  collectionRoutes(routes,
    "Release types",
    "/api/apps/{appId}/release-types",
    "/api/apps/{appId}/release-types/{rtId}",
    AppReleaseTypeParams,
    "ReleaseTypeInput",
  );

  routes.push( {
    method: "get",
    path: "/api/apps/{appId}/audit-logs",
    tags: ["Audit"],
    summary: "List app audit logs",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("App audit log list.", GenericObject),
      403: error("Current principal cannot view app audit logs."),
    },
  });

  routes.push( {
    method: "get",
    path: "/api/users/{accountId}/audit",
    tags: ["Audit"],
    summary: "List audit logs for a user",
    security: auth,
    request: { params: AccountIdParam },
    responses: {
      200: success("User audit log list.", GenericObject),
      403: error("Current principal cannot view user audit logs."),
    },
  });

  for (const [method, path, summary] of [
    ["get", "/api/apps/{appId}/members", "List app members"],
    ["post", "/api/apps/{appId}/members", "Add app member"],
    ["patch", "/api/apps/{appId}/members/{accountId}", "Update app member role"],
    ["delete", "/api/apps/{appId}/members/{accountId}", "Remove app member"],
  ] as const) {
    const hasAccount = path.includes("{accountId}");
    const needsBody = method === "post" || method === "patch";
    routes.push( {
      method,
      path,
      tags: ["App access"],
      summary,
      security: auth,
      request: {
        params: hasAccount ? AppMemberParams : AppIdParam,
        ...(needsBody
          ? {
              body: {
                content: json(z.object({ account_id: z.string().optional(), app_role: AppRole.optional() }).catchall(z.unknown())),
                required: true,
              },
            }
          : {}),
      },
      responses: {
        [method === "post" ? 201 : 200]: success("App member operation result.", GenericObject),
        400: error("Invalid member request."),
        403: error("Current principal cannot manage app members."),
        404: error("App member was not found."),
      },
    });
  }

  routes.push( {
    method: "get",
    path: "/api/apps/{appId}/operations",
    tags: ["Operations"],
    summary: "List app operations",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("Operation list.", GenericObject),
      403: error("Current principal cannot view operations."),
    },
  });

  routes.push( {
    method: "get",
    path: "/api/apps/{appId}/operations/stream",
    tags: ["Operations"],
    summary: "Stream app operation events",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: {
        description: "Server-sent event stream.",
        content: {
          "text/event-stream": { schema: { type: "string" } },
        },
      },
      403: error("Current principal cannot stream operations."),
    },
  });

  for (const [method, path, summary] of [
    ["get", "/api/apps/{appId}/operations/{opId}", "Get app operation"],
    ["post", "/api/apps/{appId}/operations/{opId}/retry", "Retry app operation"],
    ["delete", "/api/apps/{appId}/operations/{opId}", "Delete app operation"],
  ] as const) {
    routes.push( {
      method,
      path,
      tags: ["Operations"],
      summary,
      security: auth,
      request: { params: AppOperationParams },
      responses: {
        200: success("Operation result.", GenericObject),
        403: error("Current principal cannot modify operations."),
        404: error("Operation was not found."),
      },
    });
  }
  const AppleWebhookInput = z.object({ apple_app_id: z.string().regex(/^\d+$/).max(64) }).openapi("AppleWebhookInput");
  routes.push({
    method: "post", path: "/api/apps/{appId}/apple-webhook", tags: ["Apple webhooks"],
    summary: "Create Apple ingress configuration and reveal its secret once", security: auth,
    request: { params: AppIdParam, body: { content: json(AppleWebhookInput), required: true } },
    responses: { 201: success("New configuration; keep the returned secret private.", GenericObject),
      400: error("Invalid Apple app ID or non-iOS app."), 403: error("App admin required."),
      409: error("Configuration already exists."), 503: error("Encryption is not configured.") },
  });
  routes.push({ method: "post", path: "/api/apps/{appId}/apple-webhook/register", tags: ["Apple webhooks"],
    summary: "Register existing Apple ingress using stored App Store Connect credentials", security: auth,
    request: { params: AppIdParam }, responses: { 200: success("Apple subscription verified without revealing secrets.", GenericObject),
      403: error("App admin required."), 409: error("Configuration or credentials missing or duplicate subscriptions."),
      502: error("Apple registration or readback failed."), 503: error("Encryption unavailable.") } });
  for (const method of ["get", "delete"] as const) {
    routes.push({ method, path: "/api/apps/{appId}/apple-webhook", tags: ["Apple webhooks"],
      summary: method === "get" ? "Get Apple webhook metadata without secrets" : "Invalidate Apple ingress configuration",
      security: auth, request: { params: AppIdParam },
      responses: { 200: success("Configuration result.", GenericObject), 403: error("App admin required.") },
    });
  }
  return routes;
}
