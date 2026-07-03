import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const docs = new OpenAPIHono();

const AppIdParam = z.object({
  appId: z.string().openapi({
    param: { name: "appId", in: "path" },
    example: "app_123",
  }),
});

const ReleaseIdParam = z.object({
  releaseId: z.string().openapi({
    param: { name: "releaseId", in: "path" },
    example: "rel_123",
  }),
});

const ShareIdParam = z.object({
  shareId: z.string().openapi({
    param: { name: "shareId", in: "path" },
    example: "share_123",
  }),
});

const ServerIdParam = z.object({
  serverId: z.string().openapi({
    param: { name: "serverId", in: "path" },
    example: "oranix-main",
  }),
});

const TokenIdParam = z.object({
  tokenId: z.string().openapi({
    param: { name: "tokenId", in: "path" },
    example: "token_123",
  }),
});

const AppReleaseParams = AppIdParam.merge(ReleaseIdParam);
const AppReleaseShareParams = AppReleaseParams.merge(ShareIdParam);
const AppServerGrantParams = AppIdParam.merge(ServerIdParam);
const AppDeployTokenParams = AppIdParam.merge(TokenIdParam);

const ErrorResponse = z
  .object({
    error: z.string(),
    detail: z.string().optional(),
  })
  .catchall(z.unknown())
  .openapi("ErrorResponse");

const PublicApp = z
  .object({
    slug: z.string(),
    platform: z.string(),
  })
  .openapi("PublicApp");

const PublicScope = z
  .object({
    scope_type: z.enum(["full", "platform", "user_cohort", "ip_range"]),
    scope_value: z.string(),
    release_id: z.string(),
  })
  .openapi("PublicScope");

const PublicAsset = z
  .object({
    platform: z.string(),
    arch: z.string().nullable(),
    variant: z.string().nullable(),
    filetype: z.string(),
    size_bytes: z.number().int(),
    signature: z.string().nullable(),
    download_url: z.string().url(),
  })
  .openapi("PublicAsset");

const PublicLatestResponse = z
  .object({
    app: PublicApp,
    channel: z.string(),
    build: z.object({
      id: z.string(),
      version: z.string(),
      version_code: z.number().int(),
      release_type: z.string().optional(),
      changelog: z.string().nullable().optional(),
      force_update: z.boolean().optional(),
      released_at: z.number().int(),
    }),
    assets: z.array(PublicAsset),
    scoped: PublicScope,
    fallback_release: z.record(z.string(), z.unknown()).nullable(),
    expires_in: z.number().int(),
  })
  .openapi("PublicLatestResponse");

const PublicUpdateAvailableResponse = z
  .object({
    update_available: z.literal(true),
    app: PublicApp,
    channel: z.string(),
    current_version_code: z.number().int(),
    latest: z.object({
      build_id: z.string(),
      version: z.string(),
      version_code: z.number().int(),
      changelog: z.string().nullable().optional(),
      force_update: z.boolean(),
      released_at: z.number().int(),
    }),
    asset: PublicAsset,
    scoped: PublicScope,
    expires_in: z.number().int(),
  })
  .openapi("PublicUpdateAvailableResponse");

const PublicNoUpdateResponse = z
  .object({
    update_available: z.literal(false),
    app: PublicApp,
    channel: z.string(),
    current_version_code: z.number().int(),
    latest_version_code: z.number().int(),
    scoped: PublicScope,
    checked_at: z.number().int(),
  })
  .openapi("PublicNoUpdateResponse");

const PublicUpdateCheckResponse = z
  .union([PublicUpdateAvailableResponse, PublicNoUpdateResponse])
  .openapi("PublicUpdateCheckResponse");

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

const CreateReleaseShareRequest = z
  .object({
    ttl_seconds: z.number().int().min(60).max(2_592_000).optional().openapi({
      description: "Time-to-live in seconds. Defaults to 24 hours.",
    }),
    expires_at: z.number().int().optional().openapi({
      description: "Absolute expiry as unix timestamp in milliseconds.",
    }),
  })
  .openapi("CreateReleaseShareRequest");

const CreateReleaseShareResponse = z
  .object({
    id: z.string(),
    release_id: z.string(),
    share_url: z.string().url(),
    expires_at: z.number().int(),
    revoked_at: z.number().int().nullable(),
  })
  .openapi("CreateReleaseShareResponse");

const AppRole = z.enum(["viewer", "publisher", "admin"]);

const AppServerGrant = z
  .object({
    id: z.string(),
    app_id: z.string(),
    server_id: z.string().nullable(),
    server_slug: z.string().nullable(),
    app_role: AppRole.openapi({
      description:
        "Backend compatibility role. The admin UI currently presents server grants as visibility grants.",
    }),
    granted_by: z.string().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .openapi("AppServerGrant");

const UpsertAppServerGrantRequest = z
  .object({
    server_id: z.string().optional(),
    server_slug: z.string().optional(),
    app_role: AppRole.default("viewer"),
  })
  .openapi("UpsertAppServerGrantRequest");

const AppServerGrantMutationResponse = z
  .object({
    ok: z.literal(true),
    app_id: z.string(),
    server_id: z.string().nullable(),
    server_slug: z.string().nullable(),
    app_role: AppRole,
  })
  .openapi("AppServerGrantMutationResponse");

const RemoveAppServerGrantResponse = z
  .object({
    ok: z.literal(true),
    app_id: z.string(),
    server_key: z.string(),
  })
  .openapi("RemoveAppServerGrantResponse");

const DeployTokenRole = z.enum(["viewer", "publisher"]);

const AppDeployToken = z
  .object({
    id: z.string(),
    app_id: z.string(),
    name: z.string(),
    token_prefix: z.string(),
    app_role: DeployTokenRole,
    created_by: z.string().nullable(),
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
    app_role: DeployTokenRole,
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

const RevokeResponse = z
  .object({
    ok: z.literal(true),
    id: z.string(),
    revoked_at: z.number().int(),
  })
  .openapi("RevokeResponse");

const json = (schema: z.ZodType) => ({
  "application/json": { schema },
});

const error = (description: string) => ({
  description,
  content: json(ErrorResponse),
});

const auth = [{ bearerAuth: [] }, { cookieAuth: [] }];

docs.openAPIRegistry.registerPath(createRoute({
  method: "get",
  path: "/public/v2/apps/{slug}/latest",
  tags: ["Public update"],
  summary: "Check latest release for an app",
  description:
    "Resolves the best active release for a client on a channel, optionally filtered by product type and scoped by platform/cohort/IP.",
  request: {
    params: z.object({
      slug: z.string().openapi({
        param: { name: "slug", in: "path" },
        example: "myapp-android",
      }),
    }),
    query: z.object({
      channel: z.string().default("main").optional(),
      product_type: z.string().optional(),
    }),
    headers: z.object({
      "X-Quiver-Client-Platform": z.string().optional(),
      "X-Quiver-Cohort": z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Resolved release and downloadable assets.",
      content: json(PublicLatestResponse),
    },
    404: error("App, channel, active release, or matching scoped release was not found."),
    500: error("Matched release data is inconsistent or signing failed."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "get",
  path: "/public/v2/apps/{slug}/updates/check",
  tags: ["Public update"],
  summary: "Check whether a client should update",
  description:
    "SDK-friendly update check. Resolves the active release, compares version code, chooses one compatible asset, and returns update/no-update.",
  request: {
    params: z.object({
      slug: z.string().openapi({
        param: { name: "slug", in: "path" },
        example: "myapp-android",
      }),
    }),
    query: z.object({
      current_version_code: z.coerce.number().int().min(0),
      channel: z.string().default("main").optional(),
      product_type: z.string().default("android-apk").optional(),
      platform: z.string().optional(),
      arch: z.string().optional(),
      filetype: z.string().default("apk").optional(),
    }),
    headers: z.object({
      "X-Quiver-Client-Platform": z.string().optional(),
      "X-Quiver-Client-Arch": z.string().optional(),
      "X-Quiver-Cohort": z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Update decision.",
      content: json(PublicUpdateCheckResponse),
    },
    400: error("current_version_code is missing or invalid."),
    404: error("No matching app, channel, release, or compatible asset was found."),
    500: error("Matched release data is inconsistent or signing failed."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "get",
  path: "/api/apps/{appId}/releases/{releaseId}/shares",
  tags: ["Release shares"],
  summary: "List release share links",
  security: auth,
  request: { params: AppReleaseParams },
  responses: {
    200: {
      description: "Release share list.",
      content: json(z.object({ shares: z.array(ReleaseShare) })),
    },
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
    404: error("Release was not found."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "post",
  path: "/api/apps/{appId}/releases/{releaseId}/shares",
  tags: ["Release shares"],
  summary: "Create a public release share link",
  security: auth,
  request: {
    params: AppReleaseParams,
    body: {
      content: json(CreateReleaseShareRequest),
      required: false,
    },
  },
  responses: {
    201: {
      description: "Created share link.",
      content: json(CreateReleaseShareResponse),
    },
    400: error("Invalid request."),
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
    404: error("Release was not found."),
    409: error("Release cannot be shared, for example because it is cancelled."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "delete",
  path: "/api/apps/{appId}/releases/{releaseId}/shares/{shareId}",
  tags: ["Release shares"],
  summary: "Revoke a release share link",
  security: auth,
  request: { params: AppReleaseShareParams },
  responses: {
    200: {
      description: "Revoked share.",
      content: json(RevokeResponse),
    },
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
    404: error("Share was not found."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "get",
  path: "/api/apps/{appId}/server-grants",
  tags: ["App access"],
  summary: "List Raft server grants for an app",
  security: auth,
  request: { params: AppIdParam },
  responses: {
    200: {
      description: "Server grant list.",
      content: json(z.object({ server_grants: z.array(AppServerGrant) })),
    },
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "post",
  path: "/api/apps/{appId}/server-grants",
  tags: ["App access"],
  summary: "Add or update a Raft server visibility grant",
  security: auth,
  request: {
    params: AppIdParam,
    body: {
      content: json(UpsertAppServerGrantRequest),
      required: true,
    },
  },
  responses: {
    201: {
      description: "Upserted server grant.",
      content: json(AppServerGrantMutationResponse),
    },
    400: error("Invalid request."),
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "patch",
  path: "/api/apps/{appId}/server-grants/{serverId}",
  tags: ["App access"],
  summary: "Update a Raft server visibility grant",
  security: auth,
  request: {
    params: AppServerGrantParams,
    body: {
      content: json(UpsertAppServerGrantRequest),
      required: true,
    },
  },
  responses: {
    200: {
      description: "Updated server grant.",
      content: json(AppServerGrantMutationResponse),
    },
    400: error("Invalid request."),
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "delete",
  path: "/api/apps/{appId}/server-grants/{serverId}",
  tags: ["App access"],
  summary: "Remove a Raft server visibility grant",
  security: auth,
  request: { params: AppServerGrantParams },
  responses: {
    200: {
      description: "Removed server grant.",
      content: json(RemoveAppServerGrantResponse),
    },
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "get",
  path: "/api/apps/{appId}/deploy-tokens",
  tags: ["App access"],
  summary: "List app deploy tokens",
  description: "Raw token values are never returned after creation.",
  security: auth,
  request: {
    params: AppIdParam,
    query: z.object({
      include_revoked: z.enum(["1"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Deploy token list.",
      content: json(z.object({ deploy_tokens: z.array(AppDeployToken) })),
    },
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "post",
  path: "/api/apps/{appId}/deploy-tokens",
  tags: ["App access"],
  summary: "Create an app deploy token",
  description:
    "Creates an app-scoped deploy token. The raw token is returned once in this response; store it directly in a secret manager.",
  security: auth,
  request: {
    params: AppIdParam,
    body: {
      content: json(CreateAppDeployTokenRequest),
      required: true,
    },
  },
  responses: {
    201: {
      description: "Created deploy token. token is shown once.",
      content: json(CreateAppDeployTokenResponse),
    },
    400: error("Invalid request."),
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
  },
}));

docs.openAPIRegistry.registerPath(createRoute({
  method: "delete",
  path: "/api/apps/{appId}/deploy-tokens/{tokenId}",
  tags: ["App access"],
  summary: "Revoke an app deploy token",
  security: auth,
  request: { params: AppDeployTokenParams },
  responses: {
    200: {
      description: "Revoked deploy token.",
      content: json(RevokeResponse),
    },
    401: error("Missing or invalid authentication."),
    403: error("Authenticated account or token does not have the required role."),
    404: error("Deploy token was not found."),
  },
}));

export const openApiDocument = docs.getOpenAPI31Document({
  openapi: "3.1.0",
  info: {
    title: "Quiver API",
    version: "0.1.0",
    description:
      "Interactive API reference for Quiver. Generated from Hono/Zod route definitions.",
  },
  servers: [
    {
      url: "/",
      description: "Current origin",
    },
    {
      url: "http://localhost:8787",
      description: "Local wrangler dev",
    },
  ],
  tags: [
    {
      name: "Public update",
      description: "Client-facing release resolution endpoints.",
    },
    {
      name: "Release shares",
      description: "Create and manage revocable public release share pages.",
    },
    {
      name: "App access",
      description: "Manage app visibility and scoped automation credentials.",
    },
  ],
});

openApiDocument.components ??= {};
openApiDocument.components.securitySchemes = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    description: "Quiver bearer token. Use app deploy tokens for CI and agents.",
  },
  cookieAuth: {
    type: "apiKey",
    in: "cookie",
    name: "quiver_session",
    description: "Browser session cookie set by Login with Raft.",
  },
};
