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
      url: "https://quiver-worker.artin.workers.dev",
      description: "Production worker",
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
    },
  },
} as const;
