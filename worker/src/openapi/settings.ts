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
  register,
  success,
  type OpenApiRegistry,
} from "./common";

const AppChannelParams = AppIdParam.merge(ChannelIdParam);
const AppProductTypeParams = AppIdParam.merge(ProductTypeIdParam);
const AppReleaseTypeParams = AppIdParam.merge(ReleaseTypeIdParam);
const AppOperationParams = AppIdParam.merge(OperationIdParam);
const AppMemberParams = AppIdParam.merge(AccountIdParam);

function registerCollectionRoutes(
  registry: OpenApiRegistry,
  tag: string,
  basePath: string,
  itemPath: string,
  itemParams: any,
  bodyName: string,
) {
  const Body = GenericObject.openapi(bodyName);
  register(registry, {
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

  register(registry, {
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
    register(registry, {
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

export function registerSettingsRoutes(registry: OpenApiRegistry) {
  registerCollectionRoutes(
    registry,
    "Channels",
    "/api/apps/{appId}/channels",
    "/api/apps/{appId}/channels/{channelId}",
    AppChannelParams,
    "ChannelInput",
  );

  registerCollectionRoutes(
    registry,
    "Product types",
    "/api/apps/{appId}/product-types",
    "/api/apps/{appId}/product-types/{ptId}",
    AppProductTypeParams,
    "ProductTypeInput",
  );

  registerCollectionRoutes(
    registry,
    "Release types",
    "/api/apps/{appId}/release-types",
    "/api/apps/{appId}/release-types/{rtId}",
    AppReleaseTypeParams,
    "ReleaseTypeInput",
  );

  register(registry, {
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

  register(registry, {
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
    register(registry, {
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

  register(registry, {
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

  register(registry, {
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
    register(registry, {
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
}
