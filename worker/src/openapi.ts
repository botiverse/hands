export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Quiver API",
    version: "0.1.0",
    description:
      "Interactive API reference for Quiver. The first covered endpoint is the public update-check API used by apps to discover the latest release.",
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
  ],
  paths: {
    "/public/v2/apps/{slug}/latest": {
      get: {
        tags: ["Public update"],
        summary: "Check latest release for an app",
        description:
          "Resolves the best active release for a client on a channel, optionally filtered by product type and scoped by platform/cohort/IP. Use this to test update checks for a Quiver app.",
        operationId: "getPublicV2LatestRelease",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            description: "App slug, for example `myapp-android`.",
            schema: { type: "string" },
            example: "myapp-android",
          },
          {
            name: "channel",
            in: "query",
            required: false,
            description:
              "Distribution channel. New apps are seeded with `main`, `preview`, and `nightly`.",
            schema: { type: "string", default: "main" },
            example: "main",
          },
          {
            name: "product_type",
            in: "query",
            required: false,
            description:
              "Optional product/package family, such as `android-apk`. If omitted, Quiver picks the newest matching active release on the channel.",
            schema: { type: "string" },
            example: "android-apk",
          },
          {
            name: "X-Quiver-Client-Platform",
            in: "header",
            required: false,
            description:
              "Client platform or platform+arch tuple used for scoped release matching and asset filtering, for example `android` or `android-arm64-v8a`.",
            schema: { type: "string" },
            example: "android",
          },
          {
            name: "X-Quiver-Cohort",
            in: "header",
            required: false,
            description:
              "Optional cohort token used to match `user_cohort` release scopes.",
            schema: { type: "string" },
            example: "internal-testers",
          },
        ],
        responses: {
          "200": {
            description: "Resolved release and downloadable assets.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublicLatestResponse" },
                examples: {
                  resolved: {
                    value: {
                      app: { slug: "myapp-android", platform: "android" },
                      channel: "main",
                      build: {
                        id: "build_123",
                        version: "1.2.3",
                        version_code: 42,
                        release_type: "stable",
                        changelog: "Bug fixes",
                        released_at: 1782496667235,
                      },
                      assets: [
                        {
                          platform: "android",
                          arch: null,
                          variant: null,
                          filetype: "apk",
                          size_bytes: 1063178,
                          signature: null,
                          download_url: "https://...",
                        },
                      ],
                      scoped: {
                        scope_type: "full",
                        scope_value: "all",
                        release_id: "rel_123",
                      },
                      fallback_release: null,
                      expires_in: 3600,
                    },
                  },
                },
              },
            },
          },
          "404": {
            description:
              "App, channel, active release, or matching scoped release was not found.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "500": {
            description: "Matched release data is inconsistent or signing failed.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/public/v2/apps/{slug}/updates/check": {
      get: {
        tags: ["Public update"],
        summary: "Check whether a client should update",
        description:
          "SDK-friendly update check. The server resolves the active release, applies scope matching, compares the caller's current version code, chooses one compatible asset, and returns a flat update/no-update result.",
        operationId: "checkPublicV2Update",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            description: "App slug, for example `myapp-android`.",
            schema: { type: "string" },
            example: "myapp-android",
          },
          {
            name: "current_version_code",
            in: "query",
            required: true,
            description:
              "The versionCode currently installed on the client. If the latest matching release is not newer, the response has `update_available: false` and no asset.",
            schema: { type: "integer", minimum: 0 },
            example: 42,
          },
          {
            name: "channel",
            in: "query",
            required: false,
            description: "Distribution channel.",
            schema: { type: "string", default: "main" },
            example: "main",
          },
          {
            name: "product_type",
            in: "query",
            required: false,
            description: "Product/package family, such as `android-apk`.",
            schema: { type: "string", default: "android-apk" },
            example: "android-apk",
          },
          {
            name: "platform",
            in: "query",
            required: false,
            description:
              "Client platform or platform+arch tuple. Examples: `android`, `android-arm64-v8a`.",
            schema: { type: "string" },
            example: "android",
          },
          {
            name: "arch",
            in: "query",
            required: false,
            description: "Optional client architecture used for asset selection.",
            schema: { type: "string" },
            example: "arm64-v8a",
          },
          {
            name: "filetype",
            in: "query",
            required: false,
            description: "Requested asset file type. Android SDKs normally use `apk`.",
            schema: { type: "string", default: "apk" },
            example: "apk",
          },
          {
            name: "X-Quiver-Client-Platform",
            in: "header",
            required: false,
            description:
              "Header alternative to the `platform` query parameter. Also used for platform-scoped releases.",
            schema: { type: "string" },
            example: "android-arm64-v8a",
          },
          {
            name: "X-Quiver-Client-Arch",
            in: "header",
            required: false,
            description: "Header alternative to the `arch` query parameter.",
            schema: { type: "string" },
            example: "arm64-v8a",
          },
          {
            name: "X-Quiver-Cohort",
            in: "header",
            required: false,
            description:
              "Optional cohort token used to match `user_cohort` release scopes.",
            schema: { type: "string" },
            example: "internal-testers",
          },
        ],
        responses: {
          "200": {
            description:
              "Update decision. `asset` and `latest` are present only when `update_available` is true.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublicUpdateCheckResponse" },
                examples: {
                  updateAvailable: {
                    value: {
                      update_available: true,
                      app: { slug: "myapp-android", platform: "android" },
                      channel: "main",
                      current_version_code: 42,
                      latest: {
                        build_id: "build_123",
                        version: "1.2.4",
                        version_code: 43,
                        changelog: "Bug fixes",
                        force_update: false,
                        released_at: 1782496667235,
                      },
                      asset: {
                        platform: "android",
                        arch: "arm64-v8a",
                        variant: null,
                        filetype: "apk",
                        size_bytes: 1063178,
                        signature: null,
                        download_url: "https://...",
                      },
                      scoped: {
                        scope_type: "full",
                        scope_value: "all",
                        release_id: "rel_123",
                      },
                      expires_in: 3600,
                    },
                  },
                  noUpdate: {
                    value: {
                      update_available: false,
                      app: { slug: "myapp-android", platform: "android" },
                      channel: "main",
                      current_version_code: 43,
                      latest_version_code: 43,
                      scoped: {
                        scope_type: "full",
                        scope_value: "all",
                        release_id: "rel_123",
                      },
                      checked_at: 1782496667235,
                    },
                  },
                },
              },
            },
          },
          "400": {
            description: "`current_version_code` is missing or invalid.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "404": {
            description:
              "App, channel, active release, matching scoped release, or compatible requested asset was not found.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "500": {
            description: "Matched release data is inconsistent or signing failed.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          error: { type: "string" },
          detail: { type: "string" },
        },
        required: ["error"],
        additionalProperties: true,
      },
      PublicLatestResponse: {
        type: "object",
        required: ["app", "channel", "build", "assets", "scoped", "expires_in"],
        properties: {
          app: {
            type: "object",
            required: ["slug", "platform"],
            properties: {
              slug: { type: "string" },
              platform: { type: "string" },
            },
          },
          channel: { type: "string" },
          build: {
            type: "object",
            required: ["id", "version", "version_code", "released_at"],
            properties: {
              id: { type: "string" },
              version: { type: "string" },
              version_code: { type: "integer" },
              release_type: {
                type: "string",
                description:
                  "Internal compatibility field. Quiver's product UI now uses channel as the only release lane.",
              },
              changelog: { type: ["string", "null"] },
              force_update: { type: "boolean" },
              released_at: { type: "integer" },
            },
          },
          assets: {
            type: "array",
            items: { $ref: "#/components/schemas/PublicAsset" },
          },
          scoped: {
            type: "object",
            required: ["scope_type", "scope_value", "release_id"],
            properties: {
              scope_type: {
                type: "string",
                enum: ["full", "platform", "user_cohort", "ip_range"],
              },
              scope_value: { type: "string" },
              release_id: { type: "string" },
            },
          },
          fallback_release: {
            oneOf: [
              { type: "null" },
              { type: "object", additionalProperties: true },
            ],
          },
          expires_in: { type: "integer" },
        },
      },
      PublicAsset: {
        type: "object",
        required: ["platform", "filetype", "size_bytes", "download_url"],
        properties: {
          platform: { type: "string" },
          arch: { type: ["string", "null"] },
          variant: { type: ["string", "null"] },
          filetype: { type: "string" },
          size_bytes: { type: "integer" },
          signature: { type: ["string", "null"] },
          download_url: { type: "string", format: "uri" },
        },
      },
      PublicUpdateCheckResponse: {
        oneOf: [
          { $ref: "#/components/schemas/PublicUpdateAvailableResponse" },
          { $ref: "#/components/schemas/PublicNoUpdateResponse" },
        ],
      },
      PublicUpdateAvailableResponse: {
        type: "object",
        required: [
          "update_available",
          "app",
          "channel",
          "current_version_code",
          "latest",
          "asset",
          "scoped",
          "expires_in",
        ],
        properties: {
          update_available: { const: true },
          app: {
            type: "object",
            required: ["slug", "platform"],
            properties: {
              slug: { type: "string" },
              platform: { type: "string" },
            },
          },
          channel: { type: "string" },
          current_version_code: { type: "integer" },
          latest: {
            type: "object",
            required: ["build_id", "version", "version_code", "force_update", "released_at"],
            properties: {
              build_id: { type: "string" },
              version: { type: "string" },
              version_code: { type: "integer" },
              changelog: { type: ["string", "null"] },
              force_update: { type: "boolean" },
              released_at: { type: "integer" },
            },
          },
          asset: { $ref: "#/components/schemas/PublicAsset" },
          scoped: {
            type: "object",
            required: ["scope_type", "scope_value", "release_id"],
            properties: {
              scope_type: {
                type: "string",
                enum: ["full", "platform", "user_cohort", "ip_range"],
              },
              scope_value: { type: "string" },
              release_id: { type: "string" },
            },
          },
          expires_in: { type: "integer" },
        },
      },
      PublicNoUpdateResponse: {
        type: "object",
        required: [
          "update_available",
          "app",
          "channel",
          "current_version_code",
          "latest_version_code",
          "scoped",
          "checked_at",
        ],
        properties: {
          update_available: { const: false },
          app: {
            type: "object",
            required: ["slug", "platform"],
            properties: {
              slug: { type: "string" },
              platform: { type: "string" },
            },
          },
          channel: { type: "string" },
          current_version_code: { type: "integer" },
          latest_version_code: { type: "integer" },
          scoped: {
            type: "object",
            required: ["scope_type", "scope_value", "release_id"],
            properties: {
              scope_type: {
                type: "string",
                enum: ["full", "platform", "user_cohort", "ip_range"],
              },
              scope_value: { type: "string" },
              release_id: { type: "string" },
            },
          },
          checked_at: { type: "integer" },
        },
      },
    },
  },
} as const;
