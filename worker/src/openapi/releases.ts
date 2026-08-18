import { z } from "@hono/zod-openapi";
import {
  AppIdParam,
  AppPermission,
  AppRole,
  DeployTokenRole,
  GenericObject,
  ReleaseIdParam,
  ServerIdParam,
  ShareIdParam,
  TokenIdParam,
  auth,
  error,
  json,
  register,
  success,
  type OpenApiRegistry,
} from "./common";

const AppReleaseParams = AppIdParam.merge(ReleaseIdParam);
const AppReleaseShareParams = AppReleaseParams.merge(ShareIdParam);
const AppServerGrantParams = AppIdParam.merge(ServerIdParam);
const AppDeployTokenParams = AppIdParam.merge(TokenIdParam);

const ReleaseInput = z
  .object({
    build_id: z.string().optional(),
    channel_id: z.string().optional(),
    product_type: z.string().optional(),
    release_type: z.string().optional(),
    status: z.enum(["draft", "active"]).optional(),
    changelog: z.string().nullable().optional(),
    release_notes: z.record(z.string(), z.string()).nullable().optional(),
    rollout_cohort_count: z.number().int().min(0).max(100).nullable().optional().openapi({
      description: "Stable full-scope rollout percentage. Null or omitted means 100%.",
    }),
    should_force_update: z.boolean().optional(),
    scopes: z.array(GenericObject).min(1).optional().openapi({
      description: "Exact non-empty scope set. full:all may be combined only with device_group entries.",
    }),
  })
  .catchall(z.unknown())
  .openapi("ReleaseInput");

const RevisionMutationInput = z
  .object({
    expected_revision: z.number().int().nonnegative().optional().openapi({
      description: "Revision from fresh release detail. Stale values return RELEASE_REVISION_CONFLICT.",
    }),
  })
  .catchall(z.unknown())
  .openapi("RevisionMutationInput");

const PublishReleaseInput = z
  .object({
    expected_revision: z.number().int().nonnegative().optional().openapi({
      description: "Revision from the same fresh detail read as expected_scopes.",
    }),
    expected_scope: GenericObject.optional().openapi({
      description: "Legacy single-scope precondition. Do not combine with expected_scopes.",
    }),
    expected_scopes: z.array(GenericObject).min(1).optional().openapi({
      description: "Canonical exact release scope-set precondition.",
    }),
  })
  .catchall(z.unknown())
  .openapi("PublishReleaseInput");

const ReleaseShare = z
  .object({
    id: z.string(),
    token_hash: z.string().openapi({
      description: "Hash of the public share token. The raw token is not returned.",
    }),
    created_at: z.number().int(),
    expires_at: z.number().int(),
    revoked_at: z.number().int().nullable(),
    view_count: z.number().int(),
    unique_view_count: z.number().int(),
    download_count: z.number().int(),
    unique_download_count: z.number().int(),
  })
  .openapi("ReleaseShare");

const ReleaseShareRequest = z
  .object({
    ttl_seconds: z.number().int().min(60).max(2_592_000).optional().openapi({
      description: "Time-to-live in seconds. Defaults to 7 days.",
    }),
    expires_at: z.number().int().optional().openapi({
      description: "Absolute expiry as unix timestamp in milliseconds.",
    }),
    password: z.string().nullable().optional(),
  })
  .openapi("ReleaseShareRequest");

const CreateReleaseShareResponse = z
  .object({
    id: z.string(),
    release_id: z.string(),
    share_url: z.string().url(),
    expires_at: z.number().int(),
    revoked_at: z.number().int().nullable().optional(),
    has_password: z.boolean().optional(),
  })
  .openapi("CreateReleaseShareResponse");

const UpdateReleaseShareResponse = z
  .object({
    id: z.string(),
    release_id: z.string().optional(),
    expires_at: z.number().int(),
    revoked_at: z.number().int().nullable().optional(),
    has_password: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .openapi("UpdateReleaseShareResponse");

const RevokeResponse = z
  .object({
    ok: z.literal(true),
    id: z.string(),
    revoked_at: z.number().int().optional(),
  })
  .catchall(z.unknown())
  .openapi("RevokeResponse");

const AppServerGrant = z
  .object({
    id: z.string(),
    app_id: z.string(),
    server_id: z.string().nullable(),
    server_slug: z.string().nullable(),
    app_role: AppRole.openapi({
      description:
        "Deprecated compatibility field. Additional owner-server enforcement derives the caller's app role from their role in that Raft server.",
    }),
    access_model: z.enum(["legacy_role", "owner_server"]),
    granted_by: z.string().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .openapi("AppServerGrant");

const UpsertAppServerGrantRequest = z
  .object({
    server_id: z.string().optional(),
    server_slug: z.string().optional(),
  })
  .openapi("UpsertAppServerGrantRequest");

const AppDeployToken = z
  .object({
    id: z.string(),
    app_id: z.string(),
    name: z.string(),
    token_prefix: z.string(),
    app_role: DeployTokenRole.nullable(),
    scopes: z.array(AppPermission).nullable(),
    grant_valid: z.boolean(),
    effective_permissions: z.array(AppPermission),
    created_by: z.string().nullable().optional(),
    created_by_actor: z.string(),
    created_at: z.number().int(),
    expires_at: z.number().int().nullable(),
    last_used_at: z.number().int().nullable(),
    revoked_at: z.number().int().nullable(),
  })
  .openapi("AppDeployToken");

const CreateAppDeployTokenRequest = z
  .object({
    name: z.string().min(1).max(80),
    app_role: DeployTokenRole.optional(),
    scopes: z.array(AppPermission).min(1).optional(),
    expires_at: z.number().int().nullable().optional().openapi({
      description:
        "Optional absolute expiry as unix timestamp in milliseconds. Must be at least 60 seconds in the future.",
    }),
  })
  .openapi("CreateAppDeployTokenRequest");

const CreateAppDeployTokenResponse = z
  .object({
    token: z.string().openapi({
      description:
        "Raw bearer token. It is returned only once and should be stored directly in a secret manager.",
    }),
    deploy_token: AppDeployToken,
  })
  .openapi("CreateAppDeployTokenResponse");

const AppPermissionModel = z.object({
  permissions: z.array(z.object({
    permission: AppPermission,
    label: z.string(),
    description: z.string(),
  })),
  roles: z.array(z.object({
    role: AppRole,
    permissions: z.array(AppPermission),
  })),
}).openapi("AppPermissionModel");

export function registerReleaseRoutes(registry: OpenApiRegistry) {
  register(registry, {
    method: "get",
    path: "/api/app-permissions",
    tags: ["App access"],
    summary: "Read the app permission registry and role bundles",
    security: auth,
    responses: {
      200: success("App permission model.", AppPermissionModel),
      401: error("Missing or invalid authentication."),
    },
  });
  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/releases",
    tags: ["Releases"],
    summary: "List releases",
    security: auth,
    request: {
      params: AppIdParam,
      query: z.object({
        channel: z.string().optional(),
        channel_id: z.string().optional(),
        product_type: z.string().optional(),
        release_type: z.string().optional(),
        status: z.string().optional(),
        version_code: z.coerce.number().int().nonnegative().optional(),
      }),
    },
    responses: {
      200: success("Release list.", z.object({ releases: z.array(GenericObject) })),
      403: error("Current principal cannot view releases."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/releases",
    tags: ["Releases"],
    summary: "Create a release lifecycle for an unoccupied or cancelled build version",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(ReleaseInput), required: true },
    },
    responses: {
      201: success("Created release.", GenericObject),
      400: error("Invalid release payload."),
      403: error("Current principal cannot create releases."),
      409: error("A non-cancelled release already exists for this app/channel/product/release-type/version."),
    },
  });

  for (const [method, path, summary, bodyRequired] of [
    ["get", "/api/apps/{appId}/releases/{releaseId}", "Get a release", false],
    ["patch", "/api/apps/{appId}/releases/{releaseId}", "Update release metadata and scopes with a revision precondition", true],
    ["post", "/api/apps/{appId}/releases/{releaseId}/publish", "Publish a draft with exact revision and expected_scopes preconditions", true],
    ["delete", "/api/apps/{appId}/releases/{releaseId}", "Cancel a release with a revision precondition", false],
    ["post", "/api/apps/{appId}/releases/{releaseId}/rollback", "Restore a cancelled draft to draft or a previously active release to active", false],
    ["post", "/api/apps/{appId}/releases/{releaseId}/bump-rollout", "Update rollout percentage with a revision precondition", true],
    ["post", "/api/apps/{appId}/releases/{releaseId}/force-update", "Toggle force update with a revision precondition", true],
  ] as const) {
    const isPublish = path.endsWith("/publish");
    const isRollback = path.endsWith("/rollback");
    register(registry, {
      method,
      path,
      tags: ["Releases"],
      summary,
      security: auth,
      request: {
        params: AppReleaseParams,
        ...(method === "delete"
          ? {
              query: z.object({
                expected_revision: z.coerce.number().int().nonnegative().optional(),
              }),
            }
          : {}),
        ...(bodyRequired || isRollback
          ? {
              body: {
                content: json(isPublish ? PublishReleaseInput : RevisionMutationInput),
                required: bodyRequired,
              },
            }
          : {}),
      },
      responses: {
        200: success("Release operation result.", GenericObject),
        400: error("Invalid release operation."),
        403: error("Current principal cannot modify this release."),
        404: error("Release was not found."),
        409: error("Release revision, lifecycle, or exact scope precondition conflict."),
      },
    });
  }

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/shares",
    tags: ["Release shares"],
    summary: "List all share links for an app",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("App share list.", z.object({ shares: z.array(GenericObject) })),
      403: error("Current principal cannot view shares."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/releases/{releaseId}/shares",
    tags: ["Release shares"],
    summary: "List release share links",
    security: auth,
    request: { params: AppReleaseParams },
    responses: {
      200: success("Release share list.", z.object({ shares: z.array(ReleaseShare) })),
      401: error("Missing or invalid authentication."),
      403: error("Authenticated account or token does not have the required role."),
      404: error("Release was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/releases/{releaseId}/shares",
    tags: ["Release shares"],
    summary: "Create a public release share link",
    security: auth,
    request: {
      params: AppReleaseParams,
      body: { content: json(ReleaseShareRequest), required: false },
    },
    responses: {
      201: success("Created share link.", CreateReleaseShareResponse),
      400: error("Invalid request."),
      401: error("Missing or invalid authentication."),
      403: error("Authenticated account or token does not have the required role."),
      404: error("Release was not found."),
      409: error("Release cannot be shared, for example because it is cancelled."),
    },
  });

  register(registry, {
    method: "patch",
    path: "/api/apps/{appId}/releases/{releaseId}/shares/{shareId}",
    tags: ["Release shares"],
    summary: "Renew, password-protect, or change a release share",
    security: auth,
    request: {
      params: AppReleaseShareParams,
      body: { content: json(ReleaseShareRequest), required: false },
    },
    responses: {
      200: success("Updated share.", UpdateReleaseShareResponse),
      400: error("Invalid request."),
      401: error("Missing or invalid authentication."),
      403: error("Authenticated account or token does not have the required role."),
      404: error("Share was not found."),
      409: error("Share cannot be updated, for example because it is revoked."),
    },
  });

  register(registry, {
    method: "delete",
    path: "/api/apps/{appId}/releases/{releaseId}/shares/{shareId}",
    tags: ["Release shares"],
    summary: "Revoke a release share link",
    security: auth,
    request: { params: AppReleaseShareParams },
    responses: {
      200: success("Revoked share.", RevokeResponse),
      401: error("Missing or invalid authentication."),
      403: error("Authenticated account or token does not have the required role."),
      404: error("Share was not found."),
    },
  });

  registerAccessRoutes(registry);
}

function registerAccessRoutes(registry: OpenApiRegistry) {
  for (const [method, path, summary] of [
    ["get", "/api/apps/{appId}/server-grants", "List additional owner servers for an app"],
    ["post", "/api/apps/{appId}/server-grants", "Add an owner server to an app"],
    ["patch", "/api/apps/{appId}/server-grants/{serverId}", "Reject legacy role changes for an owner server"],
    ["delete", "/api/apps/{appId}/server-grants/{serverId}", "Remove an additional owner server"],
  ] as const) {
    const hasServerId = path.includes("{serverId}");
    const needsBody = method === "post" || method === "patch";
    register(registry, {
      method,
      path,
      tags: ["App access"],
      summary,
      security: auth,
      request: {
        params: hasServerId ? AppServerGrantParams : AppIdParam,
        ...(needsBody
          ? { body: { content: json(UpsertAppServerGrantRequest), required: true } }
          : {}),
      },
      responses: {
        [method === "post" ? 201 : 200]: success(
          "Server grant operation result.",
          method === "get" ? z.object({ server_grants: z.array(AppServerGrant) }) : GenericObject,
        ),
        400: error("Invalid request."),
        401: error("Missing or invalid authentication."),
        403: error("Authenticated account or token does not have the required role."),
      },
    });
  }

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/deploy-tokens",
    tags: ["App access"],
    summary: "List app deploy tokens",
    description: "Raw token values are never returned after creation.",
    security: auth,
    request: {
      params: AppIdParam,
      query: z.object({ include_revoked: z.enum(["1"]).optional() }),
    },
    responses: {
      200: success("Deploy token list.", z.object({ deploy_tokens: z.array(AppDeployToken) })),
      401: error("Missing or invalid authentication."),
      403: error("Authenticated account or token does not have the required role."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/deploy-tokens",
    tags: ["App access"],
    summary: "Create an app deploy token",
    description:
      "Creates an app-scoped deploy token. Provide app_role, scopes, or both; at least one grant is required and effective permissions are their union. The raw token is returned once in this response; store it directly in a secret manager.",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(CreateAppDeployTokenRequest), required: true },
    },
    responses: {
      201: success("Created deploy token. token is shown once.", CreateAppDeployTokenResponse),
      400: error("Invalid request."),
      401: error("Missing or invalid authentication."),
      403: error("Authenticated account or token does not have the required role."),
    },
  });

  register(registry, {
    method: "delete",
    path: "/api/apps/{appId}/deploy-tokens/{tokenId}",
    tags: ["App access"],
    summary: "Revoke an app deploy token",
    security: auth,
    request: { params: AppDeployTokenParams },
    responses: {
      200: success("Revoked deploy token.", RevokeResponse),
      401: error("Missing or invalid authentication."),
      403: error("Authenticated account or token does not have the required role."),
      404: error("Deploy token was not found."),
    },
  });
}
