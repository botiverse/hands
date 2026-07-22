import { z } from "@hono/zod-openapi";
import {
  ErrorResponse,
  GenericObject,
  InviteTokenParam,
  R2KeyParam,
  SlugParam,
  auth,
  binary,
  error,
  html,
  json,
  multipart,
  register,
  success,
  type OpenApiRegistry,
} from "./common";

const PublicApp = z
  .object({
    slug: z.string(),
    platform: z.string(),
  })
  .openapi("PublicApp");

const PublicScope = z
  .object({
    scope_type: z.enum(["full", "platform", "user_cohort", "ip_range", "device_group"]),
    scope_value: z.string(),
    release_id: z.string(),
    rollout_cohort_count: z.number().int().nullable().optional(),
  })
  .openapi("PublicScope");

const PublicAsset = z
  .object({
    platform: z.string(),
    arch: z.string().nullable().optional(),
    variant: z.string().nullable().optional(),
    filetype: z.string(),
    size_bytes: z.number().int(),
    signature: z.string().nullable().optional(),
    download_url: z.string().url(),
  })
  .openapi("PublicAsset");

const ReleaseNotes = z.record(z.string(), z.string()).nullable().openapi("ReleaseNotes");

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
      release_notes: ReleaseNotes.optional(),
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
      release_notes: ReleaseNotes.optional(),
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

const PublicChannelsResponse = z
  .object({
    app: PublicApp,
    channels: z.array(GenericObject),
  })
  .openapi("PublicChannelsResponse");

const PublicReleaseNotesResponse = z
  .object({
    app: z.object({
      slug: z.string(),
      name: z.string(),
      platform: z.string(),
    }),
    requested_version_code: z.number().int().nullable(),
    lang: z.string().nullable(),
    releases: z.array(z.object({
      release_id: z.string(),
      status: z.string(),
      channel: z.string(),
      version: z.string(),
      version_code: z.number().int(),
      released_at: z.number().int(),
      changelog: z.string().nullable(),
      release_notes: ReleaseNotes,
    })),
  })
  .openapi("PublicReleaseNotesResponse");

const FeedbackSubmitResponse = z
  .object({
    id: z.string(),
    status: z.string(),
    attachments: z.number().int().optional(),
    attachment_names: z.array(z.string()).optional(),
    reference: z.string().optional(),
    ticket_url: z.string().nullable().optional(),
    idempotent_replay: z.boolean().optional(),
  })
  .openapi("FeedbackSubmitResponse");

const MetricsIngestRequest = z
  .object({
    version_name: z.string().optional(),
    version_code: z.number().int().optional(),
    channel: z.string().optional(),
    platform: z.string().optional(),
    arch: z.string().optional(),
    os_version: z.string().optional(),
    device_model: z.string().optional(),
    locale: z.string().optional(),
  })
  .catchall(z.unknown())
  .openapi("MetricsIngestRequest");

const MetricsIngestResponse = z.object({ ok: z.boolean() }).openapi("MetricsIngestResponse");

const InviteResponse = GenericObject.openapi("InviteResponse");

export function registerPublicRoutes(registry: OpenApiRegistry) {
  register(registry, {
    method: "get",
    path: "/public/v2/apps/{slug}/latest",
    tags: ["Public update"],
    summary: "Check latest release for an app",
    description:
      "Resolves the best active release for a client on a channel, optionally filtered by product type and scoped by platform/cohort/IP.",
    request: {
      params: SlugParam,
      query: z.object({
        channel: z.string().default("main").optional(),
        product_type: z.string().optional(),
        lang: z.string().optional(),
        device_id: z.string().optional(),
      }),
      headers: z.object({
        "X-Hands-Client-Platform": z.string().optional(),
        "X-Hands-Cohort": z.string().optional(),
        "X-Hands-Lang": z.string().optional(),
        "X-Hands-Device-Id": z.string().optional(),
      }),
    },
    responses: {
      200: success("Resolved release and downloadable assets.", PublicLatestResponse),
      404: error("App, channel, active release, or matching scoped release was not found."),
      500: error("Matched release data is inconsistent or signing failed."),
    },
  });

  register(registry, {
    method: "get",
    path: "/public/apps/{slug}/latest",
    tags: ["Public update"],
    summary: "Legacy latest endpoint backed by the release resolver",
    request: {
      params: SlugParam,
      query: z.object({
        channel: z.string().default("main").optional(),
        product_type: z.string().optional(),
      }),
    },
    responses: {
      200: success("Resolved release and downloadable assets.", PublicLatestResponse),
      404: error("No matching release was found."),
    },
  });

  register(registry, {
    method: "get",
    path: "/public/v2/apps/{slug}/updates/check",
    tags: ["Public update"],
    summary: "Check whether a client should update",
    description:
      "SDK-friendly update check. Resolves the active release, compares version code, chooses one compatible asset, and returns update/no-update.",
    request: {
      params: SlugParam,
      query: z.object({
        current_version_code: z.coerce.number().int().min(0),
        channel: z.string().default("main").optional(),
        product_type: z.string().default("android-apk").optional(),
        platform: z.string().optional(),
        arch: z.string().optional(),
        filetype: z.string().default("apk").optional(),
        lang: z.string().optional(),
        device_id: z.string().optional(),
      }),
      headers: z.object({
        "X-Hands-Client-Platform": z.string().optional(),
        "X-Hands-Client-Arch": z.string().optional(),
        "X-Hands-Cohort": z.string().optional(),
        "X-Hands-Lang": z.string().optional(),
        "X-Hands-Device-Id": z.string().optional(),
      }),
    },
    responses: {
      200: success("Update decision.", PublicUpdateCheckResponse),
      400: error("current_version_code is missing or invalid."),
      404: error("No matching app, channel, release, or compatible asset was found."),
      500: error("Matched release data is inconsistent or signing failed."),
    },
  });

  register(registry, {
    method: "get",
    path: "/public/v2/apps/{slug}/release-notes",
    tags: ["Public update"],
    summary: "Get structured public release notes",
    description:
      "Returns public release notes as structured per-language objects for consumers that need JSON instead of the HTML /notes page.",
    request: {
      params: SlugParam,
      query: z.object({
        version_code: z.number().int().optional(),
        lang: z.string().optional(),
      }),
      headers: z.object({
        "Accept-Language": z.string().optional(),
      }),
    },
    responses: {
      200: success("Structured release notes.", PublicReleaseNotesResponse),
      404: error("App was not found or public history/release notes are disabled."),
    },
  });

  register(registry, {
    method: "get",
    path: "/public/apps/{slug}/channels",
    tags: ["Public update"],
    summary: "List public channels for an app",
    request: { params: SlugParam },
    responses: {
      200: success("Channel list.", PublicChannelsResponse),
      404: error("App was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/public/v2/apps/{slug}/metrics",
    tags: ["Public metrics"],
    summary: "Report SDK runtime metrics",
    description:
      "Canonical SDK metrics ingest endpoint. Clients send a throttled launch/install ping with a stable per-install X-Hands-Device-Id and build/runtime metadata. This powers active-device and version-distribution analytics; it is not an unthrottled online heartbeat.",
    request: {
      params: SlugParam,
      query: z.object({ client_key: z.string().optional(), device_id: z.string().optional() }),
      headers: z.object({
        "X-Hands-Client-Key": z.string().optional(),
        "X-Hands-Device-Id": z.string().optional(),
      }),
      body: { content: json(MetricsIngestRequest), required: false },
    },
    responses: {
      202: success("Metrics accepted.", MetricsIngestResponse),
      400: error("Device id is missing or invalid."),
      401: error("Missing or invalid client key."),
      404: error("App was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/public/v2/apps/{slug}/devices",
    tags: ["Public metrics"],
    summary: "Compatibility alias for SDK runtime metrics",
    description:
      "Legacy alias for /public/v2/apps/{slug}/metrics. New SDKs should use /metrics.",
    request: {
      params: SlugParam,
      query: z.object({ client_key: z.string().optional(), device_id: z.string().optional() }),
      headers: z.object({
        "X-Hands-Client-Key": z.string().optional(),
        "X-Hands-Device-Id": z.string().optional(),
      }),
      body: { content: json(MetricsIngestRequest), required: false },
    },
    responses: {
      202: success("Metrics accepted.", MetricsIngestResponse),
      400: error("Device id is missing or invalid."),
      401: error("Missing or invalid client key."),
      404: error("App was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/public/v2/apps/{slug}/feedback",
    tags: ["Public feedback"],
    summary: "Submit feedback or crash report",
    description:
      "Accepts SDK/client feedback, bug reports, and crash reports. Requires the app client key in X-Hands-Client-Key or client_key. An optional multipart submission_id UUID makes retries idempotent: an exact replay returns the existing ticket, while reusing the UUID for a different payload returns 409. Trusted server proxies may send an optional opaque, integration-scoped X-Hands-Reporter-Id together with an app-scoped bearer token granted feedback:write; Hands persists the external subject as the pseudonymous ticket owner and rate-limits by reporter instead of the proxy's shared IP.",
    request: {
      params: SlugParam,
      query: z.object({ client_key: z.string().optional() }),
      headers: z.object({
        "X-Hands-Client-Key": z.string().optional(),
        "X-Hands-Reporter-Id": z.string().optional(),
        Authorization: z.string().optional(),
      }),
      body: {
        content: multipart(),
        required: true,
      },
    },
    responses: {
      200: success("Returned an existing ticket for an idempotent replay.", FeedbackSubmitResponse),
      201: success("Created feedback ticket.", FeedbackSubmitResponse),
      400: error("Invalid feedback payload."),
      401: error("Missing or invalid client key."),
      409: error("Submission id was already used for a different payload."),
      413: error("Attachment is too large."),
      429: error("Rate limit exceeded."),
    },
  });

  register(registry, {
    method: "get",
    path: "/public/apps/{slug}/icon",
    tags: ["Public pages"],
    summary: "Download app icon",
    request: { params: SlugParam },
    responses: {
      200: { description: "Icon image.", content: binary() },
      404: error("App or icon was not found."),
    },
  });

  register(registry, {
    method: "get",
    path: "/electron/{slug}/{channel}/{file}",
    tags: ["Public update"],
    summary: "Serve Electron generic-provider update metadata or artifacts",
    description:
      "Hosts electron-builder generated files as-is for electron-updater's generic provider. Store latest*.yml, installers, and .blockmap files as build assets on an active electron-installer release.",
    request: {
      params: z.object({
        slug: z.string().openapi({ param: { name: "slug", in: "path" } }),
        channel: z.string().openapi({ param: { name: "channel", in: "path" } }),
        file: z.string().openapi({
          param: { name: "file", in: "path" },
          example: "latest.yml",
        }),
      }),
      query: z.object({
        product_type: z.string().default("electron-installer").optional(),
      }),
    },
    responses: {
      200: { description: "Electron updater metadata or binary artifact.", content: binary() },
      404: error("No active Electron release or matching asset was found."),
    },
  });

  register(registry, {
    method: "get",
    path: "/tauri/{slug}/{channel}/{target}/{arch}/{currentVersion}",
    tags: ["Public update"],
    summary: "Check for a signed Tauri update",
    description:
      "Returns the Tauri v2 dynamic updater response for the active tauri-updater release, or 204 when the channel has no newer compatible version.",
    request: {
      params: z.object({
        slug: z.string().openapi({ param: { name: "slug", in: "path" } }),
        channel: z.string().openapi({ param: { name: "channel", in: "path" } }),
        target: z.enum(["darwin", "windows", "linux"]).openapi({ param: { name: "target", in: "path" } }),
        arch: z.enum(["x86_64", "aarch64", "i686", "armv7"]).openapi({ param: { name: "arch", in: "path" } }),
        currentVersion: z.string().openapi({ param: { name: "currentVersion", in: "path" }, example: "1.2.3" }),
      }),
    },
    responses: {
      200: success("Signed Tauri update manifest.", z.object({
        version: z.string(), url: z.string().url(), signature: z.string(),
        notes: z.string().optional(), pub_date: z.string().optional(),
      })),
      204: { description: "No newer update is available." },
      400: error("Updater parameters are invalid."),
      404: error("The active release lacks a matching signed artifact."),
    },
  });

  register(registry, {
    method: "get",
    path: "/tauri/{slug}/{channel}/artifacts/{releaseId}/{target}/{arch}/{file}",
    tags: ["Public update"],
    summary: "Download an active Tauri updater artifact",
    request: {
      params: z.object({
        slug: z.string().openapi({ param: { name: "slug", in: "path" } }),
        channel: z.string().openapi({ param: { name: "channel", in: "path" } }),
        releaseId: z.string().openapi({ param: { name: "releaseId", in: "path" } }),
        target: z.enum(["darwin", "windows", "linux"]).openapi({ param: { name: "target", in: "path" } }),
        arch: z.enum(["x86_64", "aarch64", "i686", "armv7"]).openapi({ param: { name: "arch", in: "path" } }),
        file: z.string().openapi({ param: { name: "file", in: "path" } }),
      }),
    },
    responses: {
      200: { description: "Immutable signed Tauri updater bundle.", content: binary() },
      404: error("The active release or matching artifact was not found."),
    },
  });

  register(registry, {
    method: "get",
    path: "/public/r2/{key}",
    tags: ["Public downloads"],
    summary: "Download a signed public release artifact",
    request: {
      params: R2KeyParam,
      query: z.object({
        expires: z.coerce.number().int(),
        sig: z.string(),
      }),
    },
    responses: {
      200: { description: "Artifact stream.", content: binary() },
      302: { description: "Redirect to presigned object storage URL." },
      400: error("Invalid signature parameters."),
      403: error("Signature expired or invalid."),
      404: error("Artifact is not attached to an active release."),
    },
  });

  register(registry, {
    method: "get",
    path: "/share/{token}",
    tags: ["Public pages"],
    summary: "Render a public release share page",
    request: { params: InviteTokenParam },
    responses: {
      200: { description: "Share page HTML.", content: html() },
      404: error("Share link is expired, revoked, or unavailable."),
    },
  });

  register(registry, {
    method: "post",
    path: "/share/{token}/unlock",
    tags: ["Public pages"],
    summary: "Unlock a password-protected share page",
    request: {
      params: InviteTokenParam,
      body: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: z.object({ password: z.string() }),
          },
        },
        required: true,
      },
    },
    responses: {
      302: { description: "Redirects back to the share page after successful unlock." },
      401: error("Password is invalid."),
      404: error("Share link is expired, revoked, or unavailable."),
    },
  });

  register(registry, {
    method: "get",
    path: "/share/{token}/download",
    tags: ["Public downloads"],
    summary: "Download a release share artifact",
    request: { params: InviteTokenParam },
    responses: {
      302: { description: "Redirects to a signed artifact URL." },
      401: error("Password unlock is required."),
      404: error("Share link is expired, revoked, or unavailable."),
    },
  });

  register(registry, {
    method: "get",
    path: "/share/{token}/icon",
    tags: ["Public pages"],
    summary: "Download icon for a share page",
    request: { params: InviteTokenParam },
    responses: {
      200: { description: "Icon image.", content: binary() },
      404: error("Share or icon was not found."),
    },
  });

  register(registry, {
    method: "get",
    path: "/apps/{slug}/latest",
    tags: ["Public pages"],
    summary: "Render the latest active release landing page",
    request: {
      params: SlugParam,
      query: z.object({ channel: z.string().optional(), lang: z.string().optional() }),
    },
    responses: {
      200: { description: "Latest release landing page HTML.", content: html() },
      404: error("App history is private or no active release exists."),
    },
  });

  register(registry, {
    method: "get",
    path: "/apps/{slug}/latest/download",
    tags: ["Public downloads"],
    summary: "Download the latest active release artifact",
    request: {
      params: SlugParam,
      query: z.object({ channel: z.string().optional() }),
    },
    responses: {
      302: { description: "Redirects to a signed latest-release artifact URL." },
      404: error("App history is private or no active release exists."),
    },
  });

  register(registry, {
    method: "get",
    path: "/apps/{slug}/history",
    tags: ["Public pages"],
    summary: "Render public version history",
    request: { params: SlugParam },
    responses: {
      200: { description: "Version history HTML.", content: html() },
      404: error("App history is disabled or unavailable."),
    },
  });

  register(registry, {
    method: "get",
    path: "/apps/{slug}/history/{releaseId}/download",
    tags: ["Public downloads"],
    summary: "Download a version history release artifact",
    request: { params: SlugParam.merge(z.object({
      releaseId: z.string().openapi({
        param: { name: "releaseId", in: "path" },
        example: "rel_123",
      }),
    })) },
    responses: {
      302: { description: "Redirects to a signed artifact URL." },
      404: error("Release or public history page was not found."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/invites/{token}",
    tags: ["Invites"],
    summary: "Read invite details before accepting",
    request: { params: InviteTokenParam },
    responses: {
      200: success("Invite details.", InviteResponse),
      404: error("Invite was not found."),
    },
  });
}

export { ErrorResponse };
