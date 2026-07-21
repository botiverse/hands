/**
 * TestFlight upload lane (sdk-parity / TestFlight-on-Hands Part 2b).
 *
 * POST /api/apps/:appId/builds/:buildId/testflight-upload
 *   Streams the build's installable IPA from R2 straight to Apple using the
 *   official Build Upload API: create buildUpload → register the file →
 *   PUT each part per Apple's uploadOperations → commit → first state poll.
 *   Synchronous by design — the work is IO-bound (a 40MB IPA is a handful of
 *   part PUTs) and the caller gets the final commit state in one response.
 *   Progress is mirrored into the operations stream for the admin UI.
 *
 * GET /api/apps/:appId/testflight-uploads/:buildUploadId
 *   Polls Apple for the processing state (AWAITING_UPLOAD → PROCESSING →
 *   COMPLETE | FAILED).
 *
 * GET /api/apps/:appId/builds/:buildId/testflight-groups
 *   Lists the App Store Connect beta groups available to the exact iOS app.
 *
 * POST /api/apps/:appId/builds/:buildId/testflight-publish
 *   Assigns one already-processed ASC build to internal or external groups,
 *   upserts localized What to Test text, submits external Beta App Review,
 *   and optionally enables/sends tester notifications.
 *
 * GET /api/apps/:appId/builds/:buildId/testflight-publish
 *   Refreshes the live processing, group, beta-review, notification, and
 *   expiration state without mutating App Store production release state.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { currentActor } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import {
  AscApiError,
  addBuildToBetaGroups,
  commitBuildUploadFile,
  createBetaAppReviewSubmission,
  createBuildUpload,
  createBuildUploadFile,
  getAssignedBetaGroupIds,
  getBetaAppReviewSubmission,
  getBetaBuildLocalizations,
  getBuildBetaDetail,
  getBuildUpload,
  listBetaGroups,
  resolveAscAppId,
  resolveAscBuild,
  sendBuildBetaNotification,
  updateBuildBetaAutoNotify,
  upsertBetaBuildLocalizations,
  type AscBuildResource,
  type AscApiCredentials,
  type BetaAppReviewSubmissionResource,
  type BetaGroupResource,
  type BuildUploadStateInfo,
  type BuildBetaDetailResource,
} from "../lib/asc_api";
import { createOperation, updateOperation } from "./operations";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type TestflightDistribution = "internal" | "external";

interface HandsTestflightBuild {
  id: string;
  product_type: string;
  version_name: string;
  version_code: number;
  build_metadata_json: string;
}

interface TestflightPublishInput {
  distribution: TestflightDistribution;
  group_ids: string[];
  what_to_test: Record<string, string>;
  notify_testers: boolean;
  bundle_id?: string;
}

export class TestflightPublishError extends Error {
  status: 400 | 404 | 409;
  code: string;
  details: Record<string, unknown>;

  constructor(
    status: 400 | 404 | 409,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function loadHandsTestflightBuild(
  c: AdminContext,
  appId: string,
  buildIdParam: string,
): Promise<HandsTestflightBuild> {
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.product_type, b.version_name, b.version_code,
            b.build_metadata_json
     FROM builds b
     WHERE b.app_id = ?1 AND b.id LIKE ?2 || '%' LIMIT 2`,
  )
    .bind(appId, buildIdParam)
    .all<HandsTestflightBuild>();
  if (!rows.results || rows.results.length !== 1) {
    throw new TestflightPublishError(
      404,
      "HANDS_BUILD_NOT_FOUND",
      "build not found (or ambiguous short id)",
    );
  }
  const build = rows.results[0]!;
  if (build.product_type !== "ios-ipa") {
    throw new TestflightPublishError(
      400,
      "HANDS_BUILD_NOT_IOS",
      "TestFlight distribution requires an ios-ipa Hands build",
      { product_type: build.product_type },
    );
  }
  return build;
}

function bundleIdFromMetadata(raw: string): string {
  try {
    const metadata = JSON.parse(raw || "{}") as {
      bundle_id?: unknown;
      ios?: { bundle_id?: unknown };
    };
    const candidate = metadata.bundle_id ?? metadata.ios?.bundle_id;
    return typeof candidate === "string" ? candidate.trim() : "";
  } catch {
    return "";
  }
}

async function resolveBuildBundleId(
  c: AdminContext,
  build: HandsTestflightBuild,
  requested?: string,
): Promise<string> {
  const requestedBundleId = requested?.trim() ?? "";
  let metadataBundleId = bundleIdFromMetadata(build.build_metadata_json);
  if (!metadataBundleId) {
    const metaAsset = await c.env.DB.prepare(
      `SELECT r2_key FROM build_assets
       WHERE build_id = ?1 AND artifact_kind = 'metadata-file' LIMIT 1`,
    )
      .bind(build.id)
      .first<{ r2_key: string }>();
    if (metaAsset) {
      const obj = await c.env.APK_BUCKET.get(metaAsset.r2_key);
      if (obj) {
        try {
          const metadata = (await obj.json()) as {
            bundle_id?: unknown;
            ios?: { bundle_id?: unknown };
          };
          const candidate = metadata.bundle_id ?? metadata.ios?.bundle_id;
          metadataBundleId =
            typeof candidate === "string" ? candidate.trim() : "";
        } catch {
          // The actionable error below covers malformed metadata.
        }
      }
    }
  }
  const expectedBundleId = metadataBundleId;
  if (
    expectedBundleId &&
    requestedBundleId &&
    expectedBundleId !== requestedBundleId
  ) {
    throw new TestflightPublishError(
      400,
      "BUNDLE_ID_MISMATCH",
      "bundle_id does not match the immutable build metadata",
      { metadata_bundle_id: expectedBundleId },
    );
  }
  const bundleId = expectedBundleId || requestedBundleId;
  if (!bundleId) {
    throw new TestflightPublishError(
      400,
      "BUNDLE_ID_REQUIRED",
      'bundle_id not found in immutable build metadata; pass {"bundle_id":"..."}',
    );
  }
  return bundleId;
}

async function loadAscCredentials(
  c: AdminContext,
  appId: string,
): Promise<AscApiCredentials> {
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    throw new Error("server is missing ASC_CRED_ENC_KEY");
  }
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) {
    throw new TestflightPublishError(
      400,
      "ASC_CREDENTIALS_REQUIRED",
      "no ASC credentials configured - add them in Settings > TestFlight first",
    );
  }
  return creds;
}

export function parsePublishInput(raw: unknown): TestflightPublishInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const distribution = body.distribution;
  if (distribution !== "internal" && distribution !== "external") {
    throw new TestflightPublishError(
      400,
      "INVALID_DISTRIBUTION",
      "distribution must be internal or external",
    );
  }
  if (!Array.isArray(body.group_ids)) {
    throw new TestflightPublishError(
      400,
      "GROUP_IDS_REQUIRED",
      "group_ids must be a non-empty array of App Store Connect beta group ids",
    );
  }
  const groupIds = Array.from(
    new Set(
      body.group_ids
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  if (groupIds.length === 0 || groupIds.length !== body.group_ids.length) {
    throw new TestflightPublishError(
      400,
      "INVALID_GROUP_IDS",
      "group_ids must contain only non-empty unique strings",
    );
  }

  const whatToTest: Record<string, string> = {};
  if (body.what_to_test !== undefined) {
    if (
      !body.what_to_test ||
      typeof body.what_to_test !== "object" ||
      Array.isArray(body.what_to_test)
    ) {
      throw new TestflightPublishError(
        400,
        "INVALID_WHAT_TO_TEST",
        "what_to_test must be an object mapping locale to text",
      );
    }
    for (const [locale, value] of Object.entries(
      body.what_to_test as Record<string, unknown>,
    )) {
      const normalizedLocale = locale.trim();
      const text = typeof value === "string" ? value.trim() : "";
      if (!normalizedLocale || !text) {
        throw new TestflightPublishError(
          400,
          "INVALID_WHAT_TO_TEST",
          "what_to_test locales and text must be non-empty strings",
        );
      }
      whatToTest[normalizedLocale] = text;
    }
  }

  if (
    body.notify_testers !== undefined &&
    typeof body.notify_testers !== "boolean"
  ) {
    throw new TestflightPublishError(
      400,
      "INVALID_NOTIFY_TESTERS",
      "notify_testers must be a boolean",
    );
  }
  if (body.bundle_id !== undefined && typeof body.bundle_id !== "string") {
    throw new TestflightPublishError(
      400,
      "INVALID_BUNDLE_ID",
      "bundle_id must be a non-empty string",
    );
  }
  const bundleId =
    typeof body.bundle_id === "string" ? body.bundle_id.trim() : undefined;
  if (body.bundle_id !== undefined && !bundleId) {
    throw new TestflightPublishError(
      400,
      "INVALID_BUNDLE_ID",
      "bundle_id must be a non-empty string",
    );
  }
  return {
    distribution,
    group_ids: groupIds,
    what_to_test: whatToTest,
    notify_testers: body.notify_testers ?? false,
    ...(bundleId ? { bundle_id: bundleId } : {}),
  };
}

function publicGroup(group: BetaGroupResource) {
  return {
    id: group.id,
    name: group.attributes.name,
    is_internal: group.attributes.isInternalGroup,
    has_access_to_all_builds: group.attributes.hasAccessToAllBuilds,
    public_link_enabled: group.attributes.publicLinkEnabled,
  };
}

interface TestflightSnapshot {
  assignedGroupIds: string[];
  localizations: Array<{ id: string; locale: string | null; whats_new: string | null }>;
  betaReview: BetaAppReviewSubmissionResource | null;
  betaDetail: BuildBetaDetailResource;
}

async function readTestflightSnapshot(
  creds: AscApiCredentials,
  ascBuildId: string,
): Promise<TestflightSnapshot> {
  const [assignedGroupIds, localizations, betaReview, betaDetail] =
    await Promise.all([
      getAssignedBetaGroupIds(creds, ascBuildId),
      getBetaBuildLocalizations(creds, ascBuildId),
      getBetaAppReviewSubmission(creds, ascBuildId),
      getBuildBetaDetail(creds, ascBuildId),
    ]);
  return {
    assignedGroupIds,
    localizations: localizations.map((item) => ({
      id: item.id,
      locale: item.attributes.locale,
      whats_new: item.attributes.whatsNew,
    })),
    betaReview,
    betaDetail,
  };
}

function publishState(
  build: AscBuildResource,
  snapshot: TestflightSnapshot | null,
  distribution?: TestflightDistribution,
): string {
  if (build.attributes.expired) return "expired";
  const processing = build.attributes.processingState;
  if (processing === "PROCESSING") return "processing";
  if (processing === "FAILED" || processing === "INVALID") {
    return "processing_failed";
  }
  if (!snapshot) return "ready";
  if (distribution === "internal") {
    const state = snapshot.betaDetail.attributes.internalBuildState;
    if (state === "IN_BETA_TESTING") return "testing";
    if (state === "READY_FOR_BETA_TESTING") return "ready";
    if (state === "EXPIRED") return "expired";
    if (state === "PROCESSING_EXCEPTION") return "processing_failed";
    if (
      state === "MISSING_EXPORT_COMPLIANCE" ||
      state === "IN_EXPORT_COMPLIANCE_REVIEW"
    ) {
      return "blocked_export_compliance";
    }
    return (state ?? "ready").toLowerCase();
  }
  if (distribution === "external") {
    const review = snapshot.betaReview?.attributes.betaReviewState;
    const state = snapshot.betaDetail.attributes.externalBuildState;
    if (review === "REJECTED" || state === "BETA_REJECTED") {
      return "rejected";
    }
    if (state === "EXPIRED") return "expired";
    if (state === "PROCESSING_EXCEPTION") return "processing_failed";
    if (
      state === "MISSING_EXPORT_COMPLIANCE" ||
      state === "IN_EXPORT_COMPLIANCE_REVIEW"
    ) {
      return "blocked_export_compliance";
    }
    if (state === "NOT_APPLICABLE") return "not_applicable";
    if (review === "WAITING_FOR_REVIEW") return "waiting_for_review";
    if (review === "IN_REVIEW") return "in_review";
    if (state === "IN_BETA_TESTING") return "testing";
    if (state === "BETA_APPROVED" || review === "APPROVED") {
      return snapshot.betaDetail.attributes.autoNotifyEnabled
        ? "approved"
        : "approved_not_notified";
    }
    return (state ?? "ready_for_beta_submission").toLowerCase();
  }
  return "ready";
}

function assertBuildCanDistribute(
  build: AscBuildResource,
  distribution: TestflightDistribution,
) {
  if (build.attributes.expired) {
    throw new TestflightPublishError(409, "ASC_BUILD_EXPIRED", "the TestFlight build is expired");
  }
  if (build.attributes.processingState !== "VALID") {
    throw new TestflightPublishError(
      409,
      "ASC_BUILD_NOT_READY",
      `App Store Connect build is ${build.attributes.processingState ?? "not ready"}`,
      { processing_state: build.attributes.processingState },
    );
  }
  if (distribution === "external") {
    const audience = build.attributes.buildAudienceType;
    if (audience !== "APP_STORE_ELIGIBLE") {
      throw new TestflightPublishError(
        409,
        audience === "INTERNAL_ONLY"
          ? "ASC_BUILD_INTERNAL_ONLY"
          : "ASC_BUILD_AUDIENCE_NOT_ELIGIBLE",
        audience === "INTERNAL_ONLY"
          ? "this build was uploaded as TestFlight Internal Only and cannot be distributed externally"
          : "App Store Connect did not explicitly mark this build as eligible for external TestFlight distribution",
        { build_audience_type: audience ?? null },
      );
    }
  }
}

function assertBetaStateCanDistribute(
  distribution: TestflightDistribution,
  betaDetail: BuildBetaDetailResource,
) {
  const state =
    distribution === "internal"
      ? betaDetail.attributes.internalBuildState
      : betaDetail.attributes.externalBuildState;
  if (distribution === "external" && state === "BETA_REJECTED") {
    throw new TestflightPublishError(
      409,
      "BETA_REVIEW_REJECTED",
      "this build's TestFlight Beta App Review was rejected",
      { beta_state: state },
    );
  }
  if (
    state === "MISSING_EXPORT_COMPLIANCE" ||
    state === "IN_EXPORT_COMPLIANCE_REVIEW" ||
    state === "PROCESSING" ||
    state === "PROCESSING_EXCEPTION" ||
    state === "EXPIRED" ||
    state === "NOT_APPLICABLE"
  ) {
    throw new TestflightPublishError(
      409,
      "ASC_BETA_STATE_NOT_READY",
      `TestFlight ${distribution} build state is ${state}`,
      { beta_state: state },
    );
  }
}

function selectedGroupsOrThrow(
  groups: BetaGroupResource[],
  input: TestflightPublishInput,
): BetaGroupResource[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const missing = input.group_ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new TestflightPublishError(
      404,
      "ASC_BETA_GROUP_NOT_FOUND",
      `beta group ids not found for this app: ${missing.join(", ")}`,
      { missing_group_ids: missing },
    );
  }
  const selected = input.group_ids.map((id) => byId.get(id)!);
  const wrongKind = selected.filter(
    (group) =>
      group.attributes.isInternalGroup !== (input.distribution === "internal"),
  );
  if (wrongKind.length > 0) {
    throw new TestflightPublishError(
      400,
      "ASC_BETA_GROUP_TYPE_MISMATCH",
      `selected groups do not match distribution=${input.distribution}`,
      {
        mismatched_groups: wrongKind.map((group) => ({
          id: group.id,
          name: group.attributes.name,
          is_internal: group.attributes.isInternalGroup,
        })),
      },
    );
  }
  return selected;
}

function statusPayload(args: {
  handsBuild: HandsTestflightBuild;
  bundleId: string;
  ascAppId: string;
  ascBuild: AscBuildResource;
  groups: BetaGroupResource[];
  snapshot: TestflightSnapshot | null;
  distribution?: TestflightDistribution;
}) {
  const assigned = new Set(args.snapshot?.assignedGroupIds ?? []);
  const assignedGroups = args.groups.filter(
    (group) => assigned.has(group.id) || group.attributes.hasAccessToAllBuilds,
  );
  return {
    hands_build_id: args.handsBuild.id,
    bundle_id: args.bundleId,
    asc_app_id: args.ascAppId,
    asc_build_id: args.ascBuild.id,
    version: args.handsBuild.version_name,
    build_number: String(args.handsBuild.version_code),
    processing_state: args.ascBuild.attributes.processingState,
    build_audience_type: args.ascBuild.attributes.buildAudienceType,
    uploaded_at: args.ascBuild.attributes.uploadedDate,
    expiration_date: args.ascBuild.attributes.expirationDate,
    expired: args.ascBuild.attributes.expired,
    state: publishState(args.ascBuild, args.snapshot, args.distribution),
    distribution: args.distribution ?? null,
    assigned_groups: assignedGroups.map(publicGroup),
    localizations: args.snapshot?.localizations ?? [],
    beta_review: args.snapshot?.betaReview
      ? {
          id: args.snapshot.betaReview.id,
          state: args.snapshot.betaReview.attributes.betaReviewState,
          submitted_at: args.snapshot.betaReview.attributes.submittedDate,
        }
      : null,
    beta_detail: args.snapshot
      ? {
          id: args.snapshot.betaDetail.id,
          auto_notify_enabled:
            args.snapshot.betaDetail.attributes.autoNotifyEnabled,
          internal_build_state:
            args.snapshot.betaDetail.attributes.internalBuildState,
          external_build_state:
            args.snapshot.betaDetail.attributes.externalBuildState,
        }
      : null,
  };
}

export async function publishProcessedAscBuild(
  creds: AscApiCredentials,
  args: {
    handsBuild: HandsTestflightBuild;
    bundleId: string;
    ascAppId: string;
    ascBuild: AscBuildResource;
    input: TestflightPublishInput;
  },
) {
  if (args.input.distribution === "internal" && args.input.notify_testers) {
    throw new TestflightPublishError(
      400,
      "NOTIFY_EXTERNAL_ONLY",
      "notify_testers applies only to external TestFlight distribution",
    );
  }

  assertBuildCanDistribute(args.ascBuild, args.input.distribution);
  const groups = await listBetaGroups(creds, args.ascAppId);
  const selected = selectedGroupsOrThrow(groups, args.input);
  let snapshot = await readTestflightSnapshot(creds, args.ascBuild.id);
  assertBetaStateCanDistribute(
    args.input.distribution,
    snapshot.betaDetail,
  );

  if (
    args.input.distribution === "external" &&
    snapshot.betaReview?.attributes.betaReviewState === "REJECTED"
  ) {
    throw new TestflightPublishError(
      409,
      "BETA_REVIEW_REJECTED",
      "this build's TestFlight Beta App Review was rejected",
    );
  }

  if (
    args.input.distribution === "external" &&
    Object.keys(args.input.what_to_test).length === 0 &&
    !snapshot.localizations.some((item) => item.whats_new?.trim())
  ) {
    throw new TestflightPublishError(
      400,
      "WHAT_TO_TEST_REQUIRED",
      "external TestFlight distribution requires at least one What to Test localization",
    );
  }

  await upsertBetaBuildLocalizations(
    creds,
    args.ascBuild.id,
    args.input.what_to_test,
  );

  const assigned = new Set(snapshot.assignedGroupIds);
  const missingGroupIds = selected
    .filter(
      (group) =>
        !assigned.has(group.id) && !group.attributes.hasAccessToAllBuilds,
    )
    .map((group) => group.id);
  await addBuildToBetaGroups(creds, args.ascBuild.id, missingGroupIds);

  let notification: "not_requested" | "scheduled" | "sent" | "already_sent" =
    "not_requested";
  if (args.input.distribution === "external") {
    let detail = snapshot.betaDetail;
    let review = snapshot.betaReview;
    const wasApproved =
      review?.attributes.betaReviewState === "APPROVED" ||
      detail.attributes.externalBuildState === "BETA_APPROVED" ||
      detail.attributes.externalBuildState === "IN_BETA_TESTING";
    if (
      !wasApproved &&
      detail.attributes.autoNotifyEnabled !== args.input.notify_testers
    ) {
      detail = await updateBuildBetaAutoNotify(creds, {
        buildBetaDetailId: detail.id,
        enabled: args.input.notify_testers,
      });
    }

    if (!review && !wasApproved) {
      try {
        review = await createBetaAppReviewSubmission(creds, args.ascBuild.id);
      } catch (error) {
        if (!(error instanceof AscApiError) || error.status !== 409) {
          throw error;
        }
        review = await getBetaAppReviewSubmission(creds, args.ascBuild.id);
        if (!review) throw error;
      }
    }

    if (args.input.notify_testers) {
      const approved =
        wasApproved || review?.attributes.betaReviewState === "APPROVED";
      if (approved) {
        if (detail.attributes.externalBuildState === "IN_BETA_TESTING") {
          notification = "already_sent";
        } else if (detail.attributes.autoNotifyEnabled) {
          notification = "scheduled";
        } else {
          try {
            await sendBuildBetaNotification(creds, args.ascBuild.id);
            notification = "sent";
          } catch (error) {
            if (!(error instanceof AscApiError) || error.status !== 409) {
              throw error;
            }
            const refreshed = await getBuildBetaDetail(creds, args.ascBuild.id);
            if (refreshed.attributes.externalBuildState !== "IN_BETA_TESTING") {
              throw error;
            }
            notification = "already_sent";
          }
        }
      } else {
        notification = "scheduled";
      }
    }
  }

  snapshot = await readTestflightSnapshot(creds, args.ascBuild.id);
  const payload = statusPayload({
    handsBuild: args.handsBuild,
    bundleId: args.bundleId,
    ascAppId: args.ascAppId,
    ascBuild: args.ascBuild,
    groups,
    snapshot,
    distribution: args.input.distribution,
  });
  return {
    ok: true,
    ...payload,
    requested_group_ids: args.input.group_ids,
    notification,
  };
}

function testflightErrorResponse(c: AdminContext, error: unknown) {
  if (error instanceof TestflightPublishError) {
    return c.json(
      { error: error.message, code: error.code, ...error.details },
      error.status,
    );
  }
  if (error instanceof AscApiError) {
    return c.json(
      {
        error: error.message,
        code: error.status === 409 ? "ASC_CONFLICT" : "ASC_API_ERROR",
        detail: error.detail,
        upstream_status: error.status,
      },
      error.status === 409 ? 409 : 502,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: message }, 500);
}

export async function handleListTestflightGroups(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  try {
    const build = await loadHandsTestflightBuild(
      c,
      appId,
      c.req.param("buildId") ?? "",
    );
    const bundleId = await resolveBuildBundleId(
      c,
      build,
      c.req.query("bundle_id"),
    );
    const creds = await loadAscCredentials(c, appId);
    const ascAppId = await resolveAscAppId(creds, bundleId);
    if (!ascAppId) {
      throw new TestflightPublishError(
        404,
        "ASC_APP_NOT_FOUND",
        `no App Store Connect app record for bundle id ${bundleId}`,
      );
    }
    const groups = await listBetaGroups(creds, ascAppId);
    return c.json({
      hands_build_id: build.id,
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      groups: groups.map(publicGroup),
    });
  } catch (error) {
    return testflightErrorResponse(c, error);
  }
}

export async function handleTestflightPublishStatus(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  try {
    const build = await loadHandsTestflightBuild(
      c,
      appId,
      c.req.param("buildId") ?? "",
    );
    const bundleId = await resolveBuildBundleId(
      c,
      build,
      c.req.query("bundle_id"),
    );
    const distributionParam = c.req.query("distribution");
    if (
      distributionParam !== undefined &&
      distributionParam !== "internal" &&
      distributionParam !== "external"
    ) {
      throw new TestflightPublishError(
        400,
        "INVALID_DISTRIBUTION",
        "distribution must be internal or external",
      );
    }
    const distribution =
      distributionParam === "internal" || distributionParam === "external"
        ? distributionParam
        : undefined;
    const creds = await loadAscCredentials(c, appId);
    const ascAppId = await resolveAscAppId(creds, bundleId);
    if (!ascAppId) {
      throw new TestflightPublishError(
        404,
        "ASC_APP_NOT_FOUND",
        `no App Store Connect app record for bundle id ${bundleId}`,
      );
    }
    const ascBuild = await resolveAscBuild(creds, {
      ascAppId,
      version: build.version_name,
      buildNumber: String(build.version_code),
    });
    if (!ascBuild) {
      return c.json({
        hands_build_id: build.id,
        bundle_id: bundleId,
        asc_app_id: ascAppId,
        asc_build_id: null,
        version: build.version_name,
        build_number: String(build.version_code),
        state: "waiting_for_processing",
        distribution: distribution ?? null,
      });
    }
    if (
      ascBuild.attributes.processingState !== "VALID" ||
      ascBuild.attributes.expired
    ) {
      return c.json(
        statusPayload({
          handsBuild: build,
          bundleId,
          ascAppId,
          ascBuild,
          groups: [],
          snapshot: null,
          ...(distribution ? { distribution } : {}),
        }),
      );
    }
    const [groups, snapshot] = await Promise.all([
      listBetaGroups(creds, ascAppId),
      readTestflightSnapshot(creds, ascBuild.id),
    ]);
    return c.json(
      statusPayload({
        handsBuild: build,
        bundleId,
        ascAppId,
        ascBuild,
        groups,
        snapshot,
        ...(distribution ? { distribution } : {}),
      }),
    );
  } catch (error) {
    return testflightErrorResponse(c, error);
  }
}

export async function handleTestflightPublish(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  let op: Awaited<ReturnType<typeof createOperation>> | null = null;
  try {
    const input = parsePublishInput(await c.req.json().catch(() => ({})));
    const build = await loadHandsTestflightBuild(
      c,
      appId,
      c.req.param("buildId") ?? "",
    );
    const bundleId = await resolveBuildBundleId(c, build, input.bundle_id);
    op = await createOperation(c.env.DB, {
      app_id: appId,
      kind: "testflight-publish",
      actor: currentActor(c),
      input: JSON.stringify({
        hands_build_id: build.id,
        bundle_id: bundleId,
        distribution: input.distribution,
        group_ids: input.group_ids,
        what_to_test: input.what_to_test,
        notify_testers: input.notify_testers,
      }),
    });
    await updateOperation(c.env.DB, op.id, {
      status: "in_progress",
      progress: 5,
    });

    const creds = await loadAscCredentials(c, appId);
    const ascAppId = await resolveAscAppId(creds, bundleId);
    if (!ascAppId) {
      throw new TestflightPublishError(
        404,
        "ASC_APP_NOT_FOUND",
        `no App Store Connect app record for bundle id ${bundleId}`,
      );
    }
    const ascBuild = await resolveAscBuild(creds, {
      ascAppId,
      version: build.version_name,
      buildNumber: String(build.version_code),
    });
    if (!ascBuild) {
      throw new TestflightPublishError(
        409,
        "ASC_BUILD_NOT_AVAILABLE",
        "the exact App Store Connect build is not available yet; upload it and wait for processing",
        {
          version: build.version_name,
          build_number: String(build.version_code),
          state: "waiting_for_processing",
        },
      );
    }

    await updateOperation(c.env.DB, op.id, {
      status: "in_progress",
      progress: 10,
    });

    const result = await publishProcessedAscBuild(creds, {
      handsBuild: build,
      bundleId,
      ascAppId,
      ascBuild,
      input,
    });
    await updateOperation(c.env.DB, op.id, {
      status: "success",
      progress: 100,
      output: JSON.stringify(result),
      completed_at: Date.now(),
    });
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "testflight.publish",
      payload: {
        build_id: build.id,
        asc_build_id: ascBuild.id,
        distribution: input.distribution,
        group_ids: input.group_ids,
        notify_testers: input.notify_testers,
      },
    });
    return c.json({ operation_id: op.id, ...result });
  } catch (error) {
    if (op) {
      const detail =
        error instanceof TestflightPublishError
          ? { error: error.message, code: error.code, ...error.details }
          : error instanceof AscApiError
            ? {
                error: error.message,
                code:
                  error.status === 409 ? "ASC_CONFLICT" : "ASC_API_ERROR",
                detail: error.detail,
                upstream_status: error.status,
              }
            : { error: error instanceof Error ? error.message : String(error) };
      await updateOperation(c.env.DB, op.id, {
        status: "failed",
        error: JSON.stringify(detail),
        completed_at: Date.now(),
      });
    }
    return testflightErrorResponse(c, error);
  }
}

export async function handleTestflightUpload(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildIdParam = c.req.param("buildId") ?? "";
  const build = await c.env.DB.prepare(
    `SELECT id, version_name, version_code FROM builds
     WHERE app_id = ?1 AND id LIKE ?2 || '%' LIMIT 2`,
  )
    .bind(appId, buildIdParam)
    .all<{ id: string; version_name: string; version_code: number }>();
  if (!build.results || build.results.length !== 1) {
    return c.json({ error: "build not found (or ambiguous short id)" }, 404);
  }
  const b = build.results[0]!;

  const asset = await c.env.DB.prepare(
    `SELECT r2_key, size_bytes, file_hash FROM build_assets
     WHERE build_id = ?1 AND artifact_kind = 'installable' AND filetype = 'ipa'
     LIMIT 1`,
  )
    .bind(b.id)
    .first<{ r2_key: string; size_bytes: number; file_hash: string | null }>();
  if (!asset) return c.json({ error: "build has no installable IPA asset" }, 404);

  // The immutable build metadata is authoritative. A caller may repeat the
  // bundle id as an assertion, but cannot redirect an existing IPA to another
  // ASC app. The body is only a fallback for older builds without metadata.
  const body = (await c.req.json().catch(() => ({}))) as { bundle_id?: unknown };
  const requestedBundleId =
    typeof body.bundle_id === "string" ? body.bundle_id.trim() : "";
  let metadataBundleId = "";
  const metaAsset = await c.env.DB.prepare(
    `SELECT r2_key FROM build_assets
     WHERE build_id = ?1 AND artifact_kind = 'metadata-file' LIMIT 1`,
  )
    .bind(b.id)
    .first<{ r2_key: string }>();
  if (metaAsset) {
    const obj = await c.env.APK_BUCKET.get(metaAsset.r2_key);
    if (obj) {
      try {
        const meta = (await obj.json()) as { bundle_id?: string };
        metadataBundleId = (meta.bundle_id ?? "").trim();
      } catch {
        // fall through to the error below
      }
    }
  }
  if (
    metadataBundleId &&
    requestedBundleId &&
    metadataBundleId !== requestedBundleId
  ) {
    return c.json(
      {
        error: "bundle_id does not match the immutable build metadata",
        code: "BUNDLE_ID_MISMATCH",
        metadata_bundle_id: metadataBundleId,
      },
      400,
    );
  }
  const bundleId = metadataBundleId || requestedBundleId;
  if (!bundleId) {
    return c.json(
      { error: "bundle_id not found in build metadata; pass {\"bundle_id\": …} in the body" },
      400,
    );
  }

  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "server is missing ASC_CRED_ENC_KEY" }, 500);
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) {
    return c.json(
      { error: "no ASC credentials configured — add them in Settings → TestFlight first" },
      400,
    );
  }

  const op = await createOperation(c.env.DB, {
    app_id: appId,
    kind: "testflight-upload",
    actor: currentActor(c),
    input: JSON.stringify({
      build_id: b.id,
      version_name: b.version_name,
      version_code: b.version_code,
      bundle_id: bundleId,
      size_bytes: asset.size_bytes,
    }),
  });
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "testflight.upload",
    payload: { build_id: b.id, version: b.version_name, version_code: b.version_code },
  });

  const fileName = `${bundleId}-${b.version_name}-${b.version_code}.ipa`;
  try {
    const result = await runUpload(c.env, creds, {
      bundleId,
      version: b.version_name,
      buildNumber: String(b.version_code),
      r2Key: asset.r2_key,
      fileSize: asset.size_bytes,
      fileName,
      onProgress: async (progress, note) => {
        await updateOperation(c.env.DB, op.id, {
          status: "in_progress",
          progress,
          output: JSON.stringify({ note }),
        });
      },
    });
    await updateOperation(c.env.DB, op.id, {
      status: "success",
      progress: 100,
      output: JSON.stringify(result),
      completed_at: Date.now(),
    });
    return c.json({ operation_id: op.id, ...result });
  } catch (e) {
    const detail =
      e instanceof AscApiError
        ? { status: e.status, error: e.message, detail: e.detail }
        : { error: e instanceof Error ? e.message : String(e) };
    await updateOperation(c.env.DB, op.id, {
      status: "failed",
      error: JSON.stringify(detail),
      completed_at: Date.now(),
    });
    return c.json({ operation_id: op.id, ok: false, ...detail }, 502);
  }
}

async function runUpload(
  env: Env,
  creds: AscApiCredentials,
  args: {
    bundleId: string;
    version: string;
    buildNumber: string;
    r2Key: string;
    fileSize: number;
    fileName: string;
    onProgress: (progress: number, note: string) => Promise<void>;
  },
): Promise<{
  ok: boolean;
  asc_app_id: string;
  build_upload_id: string;
  parts_uploaded: number;
  state: BuildUploadStateInfo | null;
}> {
  const ascAppId = await resolveAscAppId(creds, args.bundleId);
  if (!ascAppId) {
    throw new Error(
      `no App Store Connect app record for bundle id ${args.bundleId} — create it under My Apps`,
    );
  }
  await args.onProgress(10, `resolved ASC app ${ascAppId}`);

  const buildUpload = await createBuildUpload(creds, {
    ascAppId,
    version: args.version,
    buildNumber: args.buildNumber,
  });
  await args.onProgress(20, `created buildUpload ${buildUpload.id}`);

  const file = await createBuildUploadFile(creds, {
    buildUploadId: buildUpload.id,
    fileName: args.fileName,
    fileSize: args.fileSize,
  });
  const operations = file.attributes.uploadOperations ?? [];
  if (operations.length === 0) {
    throw new Error("Apple returned no uploadOperations for the file");
  }
  await args.onProgress(25, `Apple wants ${operations.length} part(s)`);

  let done = 0;
  for (const part of operations) {
    const object = await env.APK_BUCKET.get(args.r2Key, {
      range: { offset: part.offset, length: part.length },
    });
    if (!object) throw new Error(`IPA object missing from storage (${args.r2Key})`);
    const bytes = await object.arrayBuffer();
    const headers: Record<string, string> = {};
    for (const h of part.requestHeaders ?? []) headers[h.name] = h.value;
    const res = await fetch(part.url, { method: part.method || "PUT", headers, body: bytes });
    if (!res.ok) {
      throw new Error(`part upload failed: HTTP ${res.status} at offset ${part.offset}`);
    }
    done += 1;
    await args.onProgress(
      25 + Math.round((done / operations.length) * 60),
      `uploaded part ${done}/${operations.length}`,
    );
  }

  // Checksum omitted: Apple's validator rejected our SHA_256 shape (409
  // 'not a valid value for sourceFileChecksums') and the field is optional.
  await commitBuildUploadFile(creds, { fileId: file.id });
  await args.onProgress(90, "committed — Apple is processing");

  // One immediate state read; the status endpoint keeps polling afterwards.
  const state = (await getBuildUpload(creds, buildUpload.id)).attributes.state ?? null;
  return {
    ok: true,
    asc_app_id: ascAppId,
    build_upload_id: buildUpload.id,
    parts_uploaded: done,
    state,
  };
}

export async function handleTestflightUploadStatus(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildUploadId = c.req.param("buildUploadId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "server is missing ASC_CRED_ENC_KEY" }, 500);
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ error: "no ASC credentials configured" }, 400);
  try {
    const bu = await getBuildUpload(creds, buildUploadId);
    return c.json({
      build_upload_id: bu.id,
      state: bu.attributes.state,
      version: bu.attributes.cfBundleShortVersionString,
      build_number: bu.attributes.cfBundleVersion,
      uploaded_at: bu.attributes.uploadedDate,
    });
  } catch (e) {
    if (e instanceof AscApiError) {
      return c.json({ error: e.message, detail: e.detail, status: e.status }, 502);
    }
    throw e;
  }
}
