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
const Mode = z.string().optional().openapi({ description: '"dry_run" or "commit". Required for listing text and screenshots; there is no default, because they overwrite live store content. (Prepare defaults to commit for backward compatibility; its writes are reversible.) The CLI sends dry_run unless --commit.' });

const PrepareInput = z.object({
  // Required; declared optional so the handler's VERSION_STRING_REQUIRED code is what a caller sees.
  version_string: z.string().optional().openapi({ description: "Required. Marketing version, e.g. 1.17.0." }),
  platform: z.string().optional().openapi({ description: "IOS (default), MAC_OS, TV_OS, VISION_OS." }),
  release_type: z.string().optional().openapi({ description: "MANUAL | AFTER_APPROVAL. Applied to a created, reused, or renamed version; on an existing version it is PATCHed only when it differs from Apple's releaseType (in the same PATCH as a rename), and it is read back. Omitted: a created version gets MANUAL and an existing version keeps Apple's value. SCHEDULED is refused with 400 RELEASE_TYPE_SCHEDULED_UNSUPPORTED (Hands does not set earliestReleaseDate)." }),
  asc_build_id: z.string().optional().openapi({ description: "App Store Connect build id to attach; must belong to this app." }),
  mode: z.string().optional().openapi({ description: '"commit" (default) or "dry_run" (plan only, no writes). The commit default is kept for backward compatibility and is acceptable because prepare\'s writes are reversible (version string, build, and release type can be changed by another prepare). Screenshots and localizations have no default mode because they overwrite live store content; release has none because it is irreversible. The CLI is dry-run unless --commit for all of them.' }),
}).passthrough().openapi("AppStorePrepareInput");

const ReleaseInput = z.object({
  // Required; declared optional so the handler's MODE_REQUIRED / VERSION_STRING_REQUIRED codes are what a caller sees.
  mode: z.string().optional().openapi({ description: 'Required, no default: "dry_run" (reads only) or "commit".' }),
  version_string: z.string().optional().openapi({ description: "Required. The exact versionString the version must currently have." }),
  asc_build_id: z.string().optional().openapi({ description: "Optional. When given, the build Apple shows attached must be exactly this id." }),
}).passthrough().openapi("AppStoreReleaseInput");

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
      "mode defaults to commit for backward compatibility (prepare's writes are reversible); screenshots and localizations have no default mode because they overwrite live store content, and the CLI is dry-run unless --commit for all of them. " +
      "Reads every version for the platform (include=build). A version with the requested string is reused if editable. Otherwise an unreleased version Apple is holding (WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE, ...) refuses with 409 VERSION_IN_FLIGHT naming it (withdraw first). Otherwise exactly one editable, never-released version (PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED, METADATA_REJECTED, INVALID_BINARY) is renamed to the requested string and given the build; with none, a version is created. The response carries action (created | reused | renamed) and previous_version_string when renamed. release_type, when given, is applied to a reused or renamed version as well (PATCHed only when it differs from Apple's value, in the same PATCH as a rename); when omitted an existing version keeps Apple's releaseType. The response carries changes {version_string, build, release_type} ({from,to} or null). Every write is read back (GET /v1/appStoreVersions/{id}?include=build); a version string, build, or release type that does not match returns 502 READBACK_MISMATCH. mode dry_run returns the plan with no writes.",
    security: auth,
    request: { params: AppIdParam, body: { content: json(PrepareInput), required: true } },
    responses: {
      200: success("Version prepared (or planned) and read back.", GenericObject),
      400: error("Missing version_string, invalid release_type or mode, or RELEASE_TYPE_SCHEDULED_UNSUPPORTED."),
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
    description: "Refuses with 409 REVIEW_ALREADY_PENDING while another submission for the platform is waiting or in review. A rejected (UNRESOLVED_ISSUES) submission for the platform that holds this version is resubmitted in place (resubmitted: true); one holding another version is 409 UNRESOLVED_SUBMISSION_PENDING with no write.",
    security: auth,
    request: { params: AppVersionParams },
    responses: {
      200: success("Submitted.", GenericObject),
      403: error("App publisher role is required."),
      404: error("Version does not belong to this app."),
      409: error("REVIEW_ALREADY_PENDING or UNRESOLVED_SUBMISSION_PENDING: another submission is open."),
      502: error("Apple rejected the request."),
    },
  });
  routes.push({
    method: "post",
    path: "/api/apps/{appId}/app-store/versions/{versionId}/release",
    tags: ["App Store"],
    summary: "Release an approved version (PENDING_DEVELOPER_RELEASE) to the App Store -- irreversible",
    description:
      "Irreversible. mode is required (no default): dry_run reads only and returns the plan; commit releases. The caller asserts the exact version_string (and optionally asc_build_id); a mismatch is 409 RELEASE_CONFIRMATION_MISMATCH before any write. " +
      "Only PENDING_DEVELOPER_RELEASE is released. READY_FOR_SALE / READY_FOR_DISTRIBUTION (or another released/retired state) is 409 ALREADY_RELEASED -- not success; any other state (including PROCESSING_FOR_APP_STORE while Apple is already releasing) is 409 NOT_RELEASABLE with the state. " +
      "On commit Hands writes an operation receipt (kind app-store-release) and an app_store.release_intent audit row before POST /v1/appStoreVersionReleaseRequests; if they cannot be written nothing is sent (500 RELEASE_INTENT_NOT_RECORDED). It then reads the version back for up to ~30s: 200 outcome released only when Apple shows READY_FOR_SALE / READY_FOR_DISTRIBUTION; otherwise 202 outcome release_requested with observed_state, because Apple releases asynchronously. The outcome is recorded as app_store.release. " +
      "Apple's release-request resource cannot be listed, so duplicates are guarded by the version state plus the Hands receipt: a call within 6h of an accepted request returns 202 release_requested with prior_operation_id and sends nothing; a call while another is still running is 409 RELEASE_IN_PROGRESS.",
    security: auth,
    request: { params: AppVersionParams, body: { content: json(ReleaseInput), required: true } },
    responses: {
      200: success("dry_run plan (outcome planned), or released (outcome released, read back as READY_FOR_SALE / READY_FOR_DISTRIBUTION).", GenericObject),
      202: success("outcome release_requested: Apple accepted the request (now or in prior_operation_id) but the read-back does not show it live yet; observed_state says what Apple shows.", GenericObject),
      400: error("MODE_REQUIRED, INVALID_MODE, VERSION_STRING_REQUIRED, or INVALID_ASC_BUILD_ID."),
      403: error("App publisher role is required."),
      404: error("Version does not belong to this app."),
      409: error("RELEASE_CONFIRMATION_MISMATCH, ALREADY_RELEASED, NOT_RELEASABLE, or RELEASE_IN_PROGRESS; nothing sent to Apple."),
      500: error("RELEASE_INTENT_NOT_RECORDED; nothing sent to Apple."),
      502: error("Apple rejected the release request (ASC_API_REJECTED with provider_cause); operation_id and release_requested included."),
    },
  });
  routes.push({
    method: "post",
    path: "/api/apps/{appId}/app-store/withdraw",
    tags: ["App Store"],
    summary: "Withdraw a pending review submission",
    description: "Cancels the review submission holding version_id (waiting, in review, rejected UNRESOLVED_ISSUES, or an unsubmitted READY_FOR_REVIEW draft) or the exact submission_id, returning the version to an editable state.",
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
