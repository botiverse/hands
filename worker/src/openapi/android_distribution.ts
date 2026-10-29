import { z } from "@hono/zod-openapi";
import {
  AppIdParam,
  AssetIdParam,
  BuildIdParam,
  GenericObject,
  ReleaseIdParam,
  auth,
  error,
  json,
  success,
  type RouteConfigDef,
  type RouteConfigList,
} from "./common";

const AppBuildParams = AppIdParam.merge(BuildIdParam);
const AppBuildAssetParams = AppBuildParams.merge(AssetIdParam);
const AppReleaseParams = AppIdParam.merge(ReleaseIdParam);

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const SourceCommit = z.string().regex(/^[0-9a-f]{40}$/);
const AndroidArtifactDeclaration = z.object({
  kind: z.enum(["aab", "apk", "symbols"]),
  filename: z.string().min(1).max(255),
  // Runtime normalization enforces the tighter per-kind bound: symbols zips are
  // capped at 2,097,152,000 bytes (Google mediaUpload.maxSize for
  // edits.deobfuscationfiles.upload, androidpublisher v3 discovery document).
  size_bytes: z.number().int().positive().max(4 * 1024 * 1024 * 1024),
  sha256: Sha256,
}).passthrough();

const AndroidReleaseArtifactInput = z.object({
  channel_id: z.string().min(1).max(128).optional(),
  source: z.object({
    repository: z.string().min(1).max(255),
    commit_sha: SourceCommit,
    ci_run_id: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]),
  }).passthrough(),
  package_name: z.string().min(3).max(255),
  version_name: z.string().min(1).max(128),
  version_code: z.number().int().positive(),
  upload_key_cert_sha256: Sha256,
  artifacts: z.array(AndroidArtifactDeclaration).min(2).max(3).openapi({
    description: "Exactly one AAB and one APK, plus at most one optional native debug symbols zip (kind=symbols, filename ends with .zip); duplicate or missing kinds are rejected.",
  }),
}).passthrough().openapi("AndroidReleaseArtifactInput");

const AcceptanceReceiptInput = z.object({
  artifact_id: z.string().min(1),
  verdict: z.enum(["pass", "fail"]),
  matrix_ref: z.string().min(1),
  note: z.string().optional(),
  expected_revision: z.number().int().nonnegative(),
}).passthrough().openapi("AcceptanceReceiptInput");

const PlayApprovalInput = z.object({
  expected_revision: z.number().int().nonnegative(),
  approval: z.object({ note: z.string().min(1) }).passthrough(),
}).passthrough();

const PlayPromotionInput = PlayApprovalInput.extend({
  track: z.enum(["internal", "closed", "production"]),
  rollout_percent: z.number().int().min(0).max(100).optional(),
  changes_not_sent_for_review: z.boolean().optional().openapi({ description: "Default false (unchanged behavior: the commit sends the release for review). When true, every edit of this promotion is committed with changesNotSentForReview=true (always with changesInReviewBehavior=ERROR_IF_IN_REVIEW): bundle, track release, release notes and deobfuscation files are saved on Play but not sent for review; send them later with .../distributions/play/send-for-review or Play Console. The receipt records review.requested=false. If Google still answers that another change is in review, the response is 409 code edit_in_review, failure_code play_edit_in_review; an unrecognised commit answer is 502 edit_state_unknown." }),
}).passthrough().openapi("PlayPromotionInput");

const PlaySendForReviewInput = PlayApprovalInput.extend({
  track: z.enum(["internal", "closed", "production"]),
}).passthrough().openapi("PlaySendForReviewInput");

const PlayUploadSymbolsInput = PlayApprovalInput.extend({
  mode: z.enum(["dry_run", "commit"]).optional().openapi({ description: "Default dry_run: the adapter opens a Play edit, checks the versionCode is on Play, and deletes the edit; nothing is written (no receipt, revision unchanged). commit uploads and commits." }),
  kinds: z.array(z.enum(["proguard", "nativeCode"])).min(1).optional().openapi({ description: "Deobfuscation file types to upload. Default: every sealed deobfuscation asset on the release's build (R8/ProGuard mapping = proguard, native debug symbols zip = nativeCode). A requested kind the build does not have fails with failure_code no_symbols." }),
}).passthrough().openapi("PlayUploadSymbolsInput");

const PlayRollbackInput = PlayApprovalInput.extend({
  to_version_code: z.number().int().positive(),
}).passthrough().openapi("PlayRollbackInput");

const GooglePlayBindingInput = z.object({
  service_account_json: z.union([
    z.string().min(1),
    z.record(z.string(), z.unknown()),
  ]).optional().openapi({ description: "Optional service-account JSON. Omit to configure the already connected Google OAuth account; private material is never returned." }),
  package_name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
  tracks: z.object({
    internal: z.string().min(1).max(128),
    closed: z.string().min(1).max(128),
    production: z.string().min(1).max(128),
  }).passthrough(),
}).passthrough().openapi("GooglePlayBindingInput");

/** androidpublisher v3 `Listing` (discovery revision 20261027), field names verbatim. */
const PlayListing = z.object({
  language: z.string().min(2).max(16).openapi({ description: "Play store listing language tag (BCP-47 as Play lists it, e.g. en-US, zh-CN, ja-JP, iw-IL, es-419). Must be one of Play's store listing languages." }),
  title: z.string().max(30).optional().openapi({ description: "Localized app name; at most 30 characters (Unicode code points)." }),
  shortDescription: z.string().max(80).optional().openapi({ description: "At most 80 characters." }),
  fullDescription: z.string().max(4000).optional().openapi({ description: "At most 4,000 characters." }),
  video: z.string().max(2048).optional().openapi({ description: "Promotional YouTube video URL; empty string clears it." }),
}).strict().openapi("PlayListing");

/** Hands' declaration of one image to upload; `sha256` and `aiGeneratedState` are Google `Image` field names. */
const PlayImageDeclaration = z.object({
  part: z.string().min(1).openapi({ description: "Name of the multipart file part carrying this image's bytes." }),
  sha256: Sha256,
  aiGeneratedState: z.enum(["aiGeneratedStateUnspecified", "aiGeneratedStateNotAiGenerated", "aiGeneratedStateAiGeneratedDeveloperAttested"]).optional()
    .openapi({ description: "edits.images.upload aiGeneratedState, passed through when present." }),
}).strict();

const PlayImageSet = z.object({
  language: z.string().min(2).max(16),
  imageType: z.enum(["appImageTypeUnspecified", "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots", "tvScreenshots", "wearScreenshots", "icon", "featureGraphic", "tvBanner"])
    .openapi({ description: "Google's full imageType enum. appImageTypeUnspecified is rejected as image_type_not_supported." }),
  images: z.array(PlayImageDeclaration).min(1).max(8).openapi({ description: "In display order. The set replaces Play's (edits.images.deleteall, then upload); skipped when Play already holds the same sha256 sequence." }),
}).strict().openapi("PlayImageSet");

const PlayStoreListingPushInput = z.object({
  mode: z.enum(["dry_run", "commit"]).openapi({ description: "dry_run: apply inside a fresh edit, edits.validate, then delete the edit. commit: apply, validate, edits.commit (ERROR_IF_IN_REVIEW), read back." }),
  listings: z.array(PlayListing).max(100).openapi({ description: "Listing resources to write. Absent fields keep Play's current value; Hands writes edits.listings.update with the merged resource. A language not yet on Play needs title, shortDescription and fullDescription." }),
  delete_unlisted_languages: z.boolean().optional().openapi({ description: "Default false. When true, edits.listings.delete every current language not in listings (never the app's default language)." }),
  changes_not_sent_for_review: z.boolean().optional().openapi({ description: "Default false. When true, edits.commit is sent changesNotSentForReview=true: the change joins the app's pending changes and must be sent for review from Play Console." }),
  images: z.array(PlayImageSet).max(200).optional().openapi({ description: "Multipart only. Image sets applied in the same edit after the text. Format, pixel size, count and byte limits are checked before any Play call." }),
}).strict().openapi("PlayStoreListingPushInput");

const PlayStoreListingMultipart = z.object({
  request: z.string().openapi({ description: "PlayStoreListingPushInput as JSON text." }),
}).catchall(z.any().openapi({ type: "string", format: "binary" })).openapi("PlayStoreListingMultipart");

export function registerAndroidDistributionRoutes(): RouteConfigList {
  const routes: RouteConfigDef[] = [];
  routes.push({
    method: "post", path: "/api/apps/{appId}/google-play-oauth/start",
    tags: ["Android distribution"], summary: "Start human Google Play OAuth authorization",
    security: auth,
    request: { params: AppIdParam, body: { required: false, content: json(GooglePlayBindingInput.omit({ service_account_json: true }).partial()) } },
    responses: { 200: success("Google authorization URL; no credential is returned.", GenericObject),
      400: error("Invalid package or tracks."), 403: error("Human app administrator required."),
      404: error("Android app not found."), 503: error("OAuth or credential encryption unavailable.") },
  });
  routes.push({
    method: "get", path: "/api/google-play/oauth/callback",
    tags: ["Android distribution"], summary: "Consume one Google Play authorization callback",
    security: auth,
    request: { query: z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional() }) },
    responses: { 303: { description: "Redirect to app Integrations with a non-secret outcome." },
      400: error("Invalid, expired, consumed, or mismatched authorization."),
      403: error("App administrator role required.") },
  });

  routes.push({
    method: "post",
    path: "/api/apps/{appId}/android-release-artifacts",
    tags: ["Android distribution"],
    summary: "Declare one immutable Android AAB and APK bundle",
    description:
      "Creates one build identity and two direct-upload declarations. The parent becomes ready only after both exact objects are verified and sealed by Hands.",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(AndroidReleaseArtifactInput), required: true },
    },
    responses: {
      201: success("Created immutable AAB/APK upload bundle.", GenericObject),
      400: error("Declaration is invalid."),
      403: error("App publisher role is required."),
      404: error("App was not found."),
      409: error("An immutable identity conflicts."),
      503: error("Direct artifact upload is unavailable."),
    },
  });

  routes.push({
    method: "get",
    path: "/api/apps/{appId}/google-play-binding",
    tags: ["Android distribution"],
    summary: "Read this app's Google Play binding metadata",
    description: "Returns only non-secret app-scoped metadata. Stored service-account private material is never returned.",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("Google Play binding metadata or null.", GenericObject),
      403: error("App admin role is required."),
      404: error("App was not found."),
    },
  });

  routes.push({
    method: "put",
    path: "/api/apps/{appId}/google-play-binding",
    tags: ["Android distribution"],
    summary: "Validate and replace this app's encrypted Google Play binding",
    description: "Validates package and track access through the private adapter before encrypting the app-scoped credential and enabling the binding.",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(GooglePlayBindingInput), required: true },
    },
    responses: {
      200: success("Binding validated, encrypted, and enabled.", GenericObject),
      400: error("Credential, package, tracks, or platform is invalid."),
      403: error("App admin role is required."),
      502: error("Google Play rejected validation."),
      503: error("The private Play adapter is unavailable."),
    },
  });

  routes.push({
    method: "post", path: "/api/apps/{appId}/google-play-binding/tracks", tags: ["Android distribution"],
    summary: "Discover the selected app's real Google Play tracks",
    description: "Uses the saved Google credential (or a supplied service-account credential) to read tracks in a temporary edit, then deletes the edit without publishing or saving configuration.",
    security: auth,
    request: { params: AppIdParam, body: { content: json(z.object({ package_name: z.string().optional(), service_account_json: z.unknown().optional() })), required: true } },
    responses: { 200: success("Actual Play package and track identifiers.", GenericObject), 400: error("Package or connection is missing."), 403: error("App admin role is required."), 409: error("Connection changed during discovery."), 502: error("Play discovery failed."), 503: error("Play adapter unavailable.") },
  });

  for (const action of ["verify", "enable", "disable"] as const) {
    routes.push({
      method: "post",
      path: `/api/apps/{appId}/google-play-binding/${action}`,
      tags: ["Android distribution"],
      summary: action === "verify"
        ? "Revalidate this app's stored Google Play binding"
        : `${action === "enable" ? "Enable" : "Disable"} Google Play promotion for this app`,
      security: auth,
      request: { params: AppIdParam },
      responses: {
        200: success("Binding state updated.", GenericObject),
        403: error("App admin role is required."),
        404: error("Binding was not found."),
        502: error("Google Play validation failed."),
      },
    });
  }

  routes.push({
    method: "delete",
    path: "/api/apps/{appId}/google-play-binding",
    tags: ["Android distribution"],
    summary: "Delete this app's encrypted Google Play binding",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("Binding and encrypted credential deleted.", GenericObject),
      403: error("App admin role is required."),
    },
  });

  routes.push({
    method: "get",
    path: "/api/apps/{appId}/android-release-artifacts/{buildId}",
    tags: ["Android distribution"],
    summary: "Read an Android release artifact bundle",
    security: auth,
    request: { params: AppBuildParams },
    responses: {
      200: success("Shared build identity and exact per-asset seal state.", GenericObject),
      403: error("App viewer role is required."),
      404: error("Artifact bundle was not found."),
    },
  });

  routes.push({
    method: "post",
    path: "/api/apps/{appId}/android-release-artifacts/{buildId}/assets/{assetId}/complete",
    tags: ["Android distribution"],
    summary: "Verify and seal one uploaded Android artifact",
    description:
      "Streams one uploaded object through SHA-256 verification into an immutable final key. The caller cannot resubmit identity fields.",
    security: auth,
    request: { params: AppBuildAssetParams },
    responses: {
      200: success("Artifact sealed; returns the current two-asset bundle.", GenericObject),
      403: error("App publisher role is required."),
      404: error("Artifact or uploaded object was not found."),
      409: error("Artifact state or immutable key conflicts."),
      422: error("Uploaded size or SHA-256 does not match."),
    },
  });

  routes.push({
    method: "get",
    path: "/api/apps/{appId}/releases/{releaseId}/receipts",
    tags: ["Android distribution"],
    summary: "List append-only release receipts",
    security: auth,
    request: { params: AppReleaseParams },
    responses: {
      200: success("Acceptance and Google Play receipt chain.", GenericObject),
      403: error("App viewer role is required."),
    },
  });

  routes.push({
    method: "post",
    path: "/api/apps/{appId}/releases/{releaseId}/receipts/acceptance",
    tags: ["Android distribution"],
    summary: "Append a Hands acceptance receipt",
    description:
      "Binds the verdict to one exact sealed AAB or APK and advances the release revision with compare-and-set.",
    security: auth,
    request: {
      params: AppReleaseParams,
      body: { content: json(AcceptanceReceiptInput), required: true },
    },
    responses: {
      201: success("Acceptance receipt appended.", GenericObject),
      400: error("Receipt input is invalid."),
      403: error("App publisher role is required."),
      404: error("Release artifact was not found."),
      409: error("Artifact state or release revision conflicts."),
    },
  });

  routes.push({
    method: "get",
    path: "/api/apps/{appId}/releases/{releaseId}/distributions",
    tags: ["Android distribution"],
    summary: "List Hands and Google Play distribution state",
    security: auth,
    request: { params: AppReleaseParams },
    responses: {
      200: success("Distribution states.", GenericObject),
      403: error("App viewer role is required."),
    },
  });

  routes.push({
    method: "get",
    path: "/api/apps/{appId}/releases/{releaseId}/distributions/play",
    tags: ["Android distribution"],
    summary: "Read Google Play distribution state",
    security: auth,
    request: { params: AppReleaseParams },
    responses: {
      200: success("Google Play state or null.", GenericObject),
      403: error("App viewer role is required."),
    },
  });

  routes.push({
    method: "post",
    path: "/api/apps/{appId}/releases/{releaseId}/distributions/play/promote",
    tags: ["Android distribution"],
    summary: "Promote the accepted exact AAB through the server-side Play adapter",
    description:
      "Requires immutable binding, latest passing AAB acceptance, versionCode greater than the target track maximum (at most 2100000000), one edit lock, no live hold, and an explicit submission note from an authenticated human or agent publisher. No Play credential reaches this API caller. A sealed native symbols zip is uploaded as deobfuscation symbolType nativeCode and a sealed R8/ProGuard mapping (proguard-mapping asset) as symbolType proguard: in the release edit (fail-closed) for a new bundle, or in a separate edit committed first (fail-soft, refusals recorded) when Play already holds the bundle; a localized JSON changelog becomes the track release's releaseNotes (Hands keys mapped to Play BCP-47 tags, Markdown bold markers stripped, at most 500 characters per language). A changelog key with no Play language mapping is skipped and listed in the receipt, never fatal; over-long notes, or two keys mapping to one Play language with different text, fail the release_notes gate before any Play call. The receipt records what was uploaded, sent, skipped, or absent.",
    security: auth,
    request: {
      params: AppReleaseParams,
      body: { content: json(PlayPromotionInput), required: true },
    },
    responses: {
      200: success("Play readback matched and immutable receipt was appended.", GenericObject),
      400: error("A promotion gate failed."),
      403: error("Authenticated publisher, submission note, or live-hold gate failed."),
      409: error("Release revision, versionCode, or edit lock conflicts; with changes_not_sent_for_review, also another change in review (edit_in_review)."),
      502: error("Server-side Play adapter failed or returned mismatched readback; with changes_not_sent_for_review, an unrecognised commit answer is edit_state_unknown."),
    },
  });

  routes.push({
    method: "post",
    path: "/api/apps/{appId}/releases/{releaseId}/distributions/play/send-for-review",
    tags: ["Android distribution"],
    summary: "Send the release's pending Google Play changes for review",
    description:
      "Step two after promote with changes_not_sent_for_review=true. Requires the same publisher, revision, sealed/accepted AAB, live-hold and binding gates as promote, a Hands promotion of this release's versionCode to the requested track, and the package-scoped Play edit lock. The adapter opens an edit, checks that Play holds the accepted AAB (sha256) for the versionCode and that the track carries it, then commits the edit with changesInReviewBehavior=ERROR_IF_IN_REVIEW and without changesNotSentForReview. Hands never cancels a review in progress: another change in review returns 409 code edit_in_review (failure_code play_edit_in_review); an unrecognised or unanswered commit returns 502 code edit_state_unknown. Google does not document whether such a commit submits changes saved earlier without review, so the receipt (kind play-promotion, action send-for-review) records the release lifecycle state read before and after (review.lifecycle_before/after); verify it in Play Console.",
    security: auth,
    request: {
      params: AppReleaseParams,
      body: { content: json(PlaySendForReviewInput), required: true },
    },
    responses: {
      200: success("Commit accepted by Google; immutable receipt appended.", GenericObject),
      400: error("A gate failed (not promoted to this track through Hands, acceptance, binding)."),
      403: error("Authenticated publisher, binding, or live-hold gate failed."),
      409: error("Release revision or edit lock conflicts, another change is in review (edit_in_review), or Play does not hold this release on the track."),
      502: error("Server-side Play adapter failed, or Google's answer was unrecognised (edit_state_unknown); see receipt_id."),
    },
  });

  routes.push({
    method: "post",
    path: "/api/apps/{appId}/releases/{releaseId}/distributions/play/upload-symbols",
    tags: ["Android distribution"],
    summary: "Upload deobfuscation files for a versionCode already on Google Play",
    description:
      "Uploads the release build's sealed R8/ProGuard mapping (deobfuscationFileType proguard) and/or native debug symbols zip (nativeCode) to Google Play for the release's versionCode, in one Play edit that changes nothing else: no track, rollout, bundle or release notes, and play_distribution_state is not touched. Unlike promote there is no versionCode-above-track-maximum gate; instead the adapter checks that Play already holds a bundle for this versionCode with the release's AAB sha256 (409 gate_failed, failure_code version_not_on_play or aab_integrity_mismatch, otherwise). Gates: authenticated human or agent publisher (deploy tokens are refused), expected_revision, approval note, sealed AAB, sealed requested files within Google's 2,097,152,000-byte bound, no live hold, verified/enabled binding for the package, and the package-scoped Play edit lock. mode defaults to dry_run (edit inserted, checked, deleted; no receipt; revision unchanged). commit bumps the revision, uploads each file, commits with changesInReviewBehavior=ERROR_IF_IN_REVIEW and without changesNotSentForReview, and appends a play-promotion receipt with action upload-symbols (failed-closed on any failure). Any failure deletes the Play edit. Re-running is safe: an upload replaces the file of the same type for that versionCode.",
    security: auth,
    request: {
      params: AppReleaseParams,
      body: { content: json(PlayUploadSymbolsInput), required: true },
    },
    responses: {
      200: success("dry_run: the plan {mode, version_code, package_name, files, version_on_play}; commit: {mode, receipt_id, edit_id, version_code, files, revision}.", GenericObject),
      400: error("A gate failed (no_symbols, not sealed, too large, binding)."),
      403: error("Authenticated publisher (not a deploy token), binding, or live-hold gate failed."),
      409: error("Release revision or edit lock conflicts, the versionCode is not on Play, or another change is in review (edit_in_review)."),
      502: error("Server-side Play adapter failed, or Google's commit answer was unrecognised or missing (edit_state_unknown); see receipt_id."),
    },
  });

  for (const action of ["halt", "rollback"] as const) {
    routes.push({
      method: "post",
      path: `/api/apps/{appId}/releases/{releaseId}/distributions/play/${action}`,
      tags: ["Android distribution"],
      summary: action === "halt" ? "Halt a Play distribution" : "Rollback by republishing a prior accepted AAB",
      description: "Validates publisher authority and an explicit submission note, then returns unavailable until the server-side Play adapter implements this operation.",
      security: auth,
      request: {
        params: AppReleaseParams,
        body: {
          content: json(action === "rollback" ? PlayRollbackInput : PlayApprovalInput),
          required: true,
        },
      },
      responses: {
        403: error("Authenticated publisher or submission note is missing."),
        502: error("Operation is not implemented by the server-side Play adapter."),
      },
    });
  }
  routes.push({
    method: "get",
    path: "/api/apps/{appId}/distributions/play/store-listing",
    tags: ["Android distribution"],
    summary: "Read the Google Play store listing text (edits.listings.list)",
    description: "Reads every language's Listing and the app's defaultLanguage in a throwaway Play edit, which is then deleted. App publisher (the read uses the app's Google credential).",
    security: auth,
    request: { params: AppIdParam },
    responses: {
      200: success("package_name, default_language and listings (Google Listing resources).", GenericObject),
      403: error("App publisher role, or a verified and enabled Google Play binding, is required."),
      502: error("Play adapter failed."),
    },
  });
  routes.push({
    method: "post",
    path: "/api/apps/{appId}/distributions/play/store-listing",
    tags: ["Android distribution"],
    summary: "Update Google Play store listing text and images in one edit (dry run or commit)",
    description:
      "Whitelisted edits.listings.update/delete only; nothing touches tracks, releases or bundles. Languages and character limits are validated before any Play call (failure_code listing_language_unsupported, listing_field_too_long, ...). One package-scoped Play edit lock is shared with promote. The response carries the per-language plan (create/update/delete/unchanged with changed fields and before/after). An immutable receipt records actor, edit id, mode, languages and per-field sha256/length. A commit blocked by another change in review returns 409 code edit_in_review, failure_code play_edit_in_review; nothing was committed. A validate/commit answer Hands cannot classify (no known structured reason or message pattern), or a commit response that is not this edit's AppEdit, returns 502 code edit_state_unknown, failure_code play_edit_state_unknown, with cause.tried (patterns checked) and the provider message's sha256/length only; it is never reported as success. Images (edits.images deleteall + upload) need multipart/form-data: a `request` JSON part plus one file part per declared image; at most 24 MiB of images per push; each image is checked against Play's documented format, pixel size and count before any Play call (failure_code image_dimensions_invalid, image_format_unsupported, image_count_invalid, image_type_not_supported, ...).",
    security: auth,
    request: { params: AppIdParam, body: { content: { ...json(PlayStoreListingPushInput), "multipart/form-data": { schema: PlayStoreListingMultipart } }, required: true } },
    responses: {
      200: success("Validated (dry_run), committed, or no_changes; receipt appended.", GenericObject),
      400: error("Request, language, or limit validation failed (no Play call)."),
      403: error("Authenticated human or agent publisher and a verified, enabled binding are required."),
      409: error("Another Hands Play edit is active, or another change is in review on Google Play."),
      502: error("Play adapter failed, readback mismatched, or Google's answer was unrecognised (edit_state_unknown); see receipt_id."),
    },
  });
  routes.push({
    method: "get",
    path: "/api/apps/{appId}/distributions/play/store-listing/receipts",
    tags: ["Android distribution"],
    summary: "List store listing push receipts (newest first)",
    security: auth,
    request: { params: AppIdParam, query: z.object({ limit: z.string().optional() }) },
    responses: {
      200: success("Immutable store listing receipts.", GenericObject),
      403: error("App viewer role is required."),
    },
  });
  return routes;
}
