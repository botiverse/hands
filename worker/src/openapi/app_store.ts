import { z } from "@hono/zod-openapi";
import {
  AppIdParam,
  GenericObject,
  auth,
  error,
  json,
  success,
  type RouteConfigDef,
  type RouteConfigList,
} from "./common";
import { SCREENSHOT_DISPLAY_TYPES } from "../lib/app_store_screenshots";

const VersionIdParam = z.object({
  versionId: z.string().openapi({
    param: { name: "versionId", in: "path" },
    example: "ebb676c0-0000-0000-0000-000000000000",
    description: "App Store Connect appStoreVersions id (from prepare).",
  }),
});
const AppVersionParams = AppIdParam.merge(VersionIdParam);

// Bodies are documented, not narrowed: the handlers validate every field and return
// a stable `code` for each failure, so these schemas stay permissive (passthrough)
// to keep those codes reachable when the route is bound through the spec.
const Mode = z.string().optional().openapi({ description: '"dry_run" or "commit". Required for listing text and screenshots; there is no default.' });

const PrepareInput = z.object({
  // Required; declared optional so the handler's VERSION_STRING_REQUIRED code is what a caller sees.
  version_string: z.string().optional().openapi({ description: "Required. Marketing version, e.g. 1.17.0." }),
  platform: z.string().optional().openapi({ description: "IOS (default), MAC_OS, TV_OS, VISION_OS." }),
  release_type: z.string().optional().openapi({ description: "MANUAL (default) | AFTER_APPROVAL | SCHEDULED. Only used when a version is created." }),
  asc_build_id: z.string().optional().openapi({ description: "App Store Connect build id to attach; must belong to this app." }),
  mode: z.string().optional().openapi({ description: '"commit" (default, for existing callers) or "dry_run" (plan only, no writes).' }),
}).passthrough().openapi("AppStorePrepareInput");

const NotesInput = z.object({
  notes: z.record(z.string(), z.string()).openapi({ description: "Locale-to-What's New text." }),
}).passthrough().openapi("AppStoreReleaseNotesInput");

const WithdrawInput = z.object({
  version_id: z.string().optional(),
  submission_id: z.string().optional(),
}).passthrough().openapi("AppStoreWithdrawInput");

const LocalizationFields = z.object({
  description: z.string().optional().openapi({ description: "At most 4000 characters." }),
  keywords: z.string().optional().openapi({ description: "Comma-separated, at most 100 characters." }),
  promotionalText: z.string().optional().openapi({ description: "At most 170 characters; the only field writable while Apple holds the version." }),
  marketingUrl: z.string().optional().openapi({ description: "http(s) URL." }),
  supportUrl: z.string().optional().openapi({ description: "http(s) URL." }),
  whatsNew: z.string().optional().openapi({ description: "At most 4000 characters." }),
}).passthrough();

const LocalizationsInput = z.object({
  mode: Mode,
  localizations: z.record(z.string(), LocalizationFields).optional().openapi({
    description: 'Locale-to-fields map, e.g. {"en-US":{"description":"...","keywords":"chat,agents"}}. Only supplied fields are written.',
  }),
}).passthrough().openapi("AppStoreLocalizationsInput");

const ScreenshotsRequest = z.object({
  mode: Mode,
  sets: z.array(z.object({
    locale: z.string().openapi({ example: "en-US" }),
    display_type: z.enum(SCREENSHOT_DISPLAY_TYPES).openapi({ description: "Apple ScreenshotDisplayType. Types without a Hands size table are refused (SCREENSHOT_DISPLAY_TYPE_NOT_SUPPORTED)." }),
    images: z.array(z.object({
      part: z.string().openapi({ description: "Name of the multipart file part." }),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })).min(1).max(10).openapi({ description: "Display order. 1-10 per set." }),
  })).min(1),
}).openapi("AppStoreScreenshotsRequest");

const ScreenshotsMultipart = z.object({
  request: z.string().openapi({ description: "AppStoreScreenshotsRequest as JSON text." }),
}).catchall(z.any().openapi({ type: "string", format: "binary" })).openapi("AppStoreScreenshotsMultipart");

const StatusQuery = z.object({
  version_string: z.string().optional().openapi({ description: "Required. Marketing version to look up." }),
  platform: z.string().optional(),
});

export function registerAppStoreRoutes(): RouteConfigList {
  const routes: RouteConfigDef[] = [];
  routes.push({
    method: "post",
    path: "/api/apps/{appId}/app-store/versions",
    tags: ["App Store"],
    summary: "Prepare the App Store version: create, reuse, or rename, and attach a build",
    description:
      "Reads every version for the platform (include=build). A version with the requested string is reused if editable. Otherwise an unreleased version Apple is holding (WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE, ...) refuses with 409 VERSION_IN_FLIGHT naming it (withdraw first). Otherwise exactly one editable, never-released version (PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED, METADATA_REJECTED, INVALID_BINARY) is renamed to the requested string and given the build; with none, a version is created. The response carries action (created | reused | renamed) and previous_version_string when renamed. Every write is read back (GET /v1/appStoreVersions/{id}?include=build); a version string or build that does not match returns 502 READBACK_MISMATCH. mode dry_run returns the plan with no writes.",
    security: auth,
    request: { params: AppIdParam, body: { content: json(PrepareInput), required: true } },
    responses: {
      200: success("Version prepared (or planned) and read back.", GenericObject),
      400: error("Missing version_string, or invalid release_type or mode."),
      403: error("App publisher role is required."),
      404: error("App, ASC app, or asc_build_id not found for this app."),
      409: error("VERSION_NOT_EDITABLE, VERSION_IN_FLIGHT, VERSION_STATE_UNKNOWN, or MULTIPLE_EDITABLE_VERSIONS; nothing written."),
      502: error("Apple rejected a call, read-back mismatched (READBACK_MISMATCH), or a step failed after earlier writes (PREPARE_PARTIALLY_APPLIED with completed_steps)."),
    },
  });
  routes.push({
    method: "post",
    path: "/api/apps/{appId}/app-store/versions/{versionId}/notes",
    tags: ["App Store"],
    summary: "Upsert localized What's New text",
    security: auth,
    request: { params: AppVersionParams, body: { content: json(NotesInput), required: true } },
    responses: {
      200: success("Locales written.", GenericObject),
      400: error("notes is not a locale-to-text object."),
      403: error("App publisher role is required."),
      404: error("Version does not belong to this app."),
      502: error("Apple rejected the request."),
    },
  });
  routes.push({
    method: "post",
    path: "/api/apps/{appId}/app-store/versions/{versionId}/localizations",
    tags: ["App Store"],
    summary: "Write App Store listing text (dry run or commit)",
    description:
      "Writes only the supplied appStoreVersionLocalizations fields (description, keywords, promotionalText, marketingUrl, supportUrl, whatsNew) of the supplied locales: PATCH changed fields of an existing localization, POST a missing one. Apple's limits are checked before any call (description 4000, keywords 100, promotionalText 170, whatsNew 4000 characters). mode is required: dry_run reads and returns the per-locale plan (create | update | unchanged with changed fields and before/after) and writes nothing. A blocker (version not editable for fields other than promotionalText, or a locale App Store Connect does not offer) returns 409 LOCALIZATION_PLAN_BLOCKED with the plan. Commit ends with a read-back that must equal every requested field (502 READBACK_MISMATCH otherwise).",
    security: auth,
    request: { params: AppVersionParams, body: { content: json(LocalizationsInput), required: true } },
    responses: {
      200: success("Planned (dry_run), committed, or no_changes.", GenericObject),
      400: error("Request, locale, field, URL, or length validation failed; no Apple call."),
      403: error("App publisher role is required."),
      404: error("Version does not belong to this app."),
      409: error("LOCALIZATION_PLAN_BLOCKED; nothing written."),
      502: error("A write failed (LOCALIZATIONS_FAILED) or read-back mismatched (READBACK_MISMATCH); per-locale results included."),
    },
  });
  routes.push({
    method: "post",
    path: "/api/apps/{appId}/app-store/versions/{versionId}/screenshots",
    tags: ["App Store"],
    summary: "Replace App Store screenshot sets (dry run or commit)",
    description:
      "multipart/form-data: a `request` JSON part plus one file part per declared image (at most 24 MiB of images per push, 15 MiB per image). Each image is checked before any Apple call: sha256 integrity, PNG or JPEG, no transparency, exact pixel size for the display type, 1-10 per set. Per (locale, display_type): the version localization must exist (else 409 SCREENSHOT_PLAN_BLOCKED; create it with the localizations endpoint); the screenshot set is created if missing. Existing screenshots are compared by MD5 (Apple's sourceFileChecksum): identical files in identical order, all COMPLETE, are left alone (unchanged); identical files in another order are only reordered; anything else is replaced (delete existing, reserve, upload operations, commit with MD5, poll assetDeliveryState to COMPLETE, set order), then read back. mode is required; dry_run reads and returns the plan with no writes. Commit stops at the first failed set; any image not COMPLETE (FAILED, timeout) makes the response 502 SCREENSHOTS_FAILED with per-image state.",
    security: auth,
    request: { params: AppVersionParams, body: { content: { "multipart/form-data": { schema: ScreenshotsMultipart } }, required: true } },
    responses: {
      200: success("Planned (dry_run), committed, or no_changes, with per-set detail.", GenericObject),
      400: error("Request or image validation failed; no Apple call."),
      403: error("App publisher role is required."),
      404: error("Version does not belong to this app."),
      409: error("SCREENSHOT_PLAN_BLOCKED (version not editable or localization missing); nothing written."),
      502: error("SCREENSHOTS_FAILED with per-set and per-image state, or Apple rejected a read."),
    },
  });
  routes.push({
    method: "post",
    path: "/api/apps/{appId}/app-store/versions/{versionId}/submit",
    tags: ["App Store"],
    summary: "Submit a prepared version for review",
    description: "Refuses with 409 REVIEW_ALREADY_PENDING while another submission for the platform is waiting or in review.",
    security: auth,
    request: { params: AppVersionParams },
    responses: {
      200: success("Submitted.", GenericObject),
      403: error("App publisher role is required."),
      404: error("Version does not belong to this app."),
      409: error("Another submission is pending."),
      502: error("Apple rejected the request."),
    },
  });
  routes.push({
    method: "post",
    path: "/api/apps/{appId}/app-store/withdraw",
    tags: ["App Store"],
    summary: "Withdraw a pending review submission",
    description: "Cancels the review submission holding version_id (or the exact submission_id), returning the version to an editable state.",
    security: auth,
    request: { params: AppIdParam, body: { content: json(WithdrawInput), required: false } },
    responses: {
      200: success("Submission canceled.", GenericObject),
      400: error("version_id or submission_id is required."),
      403: error("App publisher role is required."),
      404: error("No pending submission for that version, or the id does not belong to this app."),
      502: error("Apple rejected the request."),
    },
  });
  routes.push({
    method: "get",
    path: "/api/apps/{appId}/app-store/status",
    tags: ["App Store"],
    summary: "Read one version's review state",
    security: auth,
    request: { params: AppIdParam, query: StatusQuery },
    responses: {
      200: success("Version state, build attachment, and pending submission.", GenericObject),
      400: error("version_string is required."),
      403: error("App viewer role is required."),
      404: error("Version not found."),
      502: error("Apple rejected the request."),
    },
  });
  return routes;
}
