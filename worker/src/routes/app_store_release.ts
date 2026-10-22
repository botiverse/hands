/**
 * App Store release actions: create a version, attach a build, write localized
 * release notes, submit for review, and read back review state.
 *
 * Scope note: submitting for review and reporting the outcome are automated here.
 * Acting on a rejection is deliberately NOT automated -- a rejection usually needs
 * a human to decide whether the fix is copy or code, so the reason is surfaced and
 * the decision is left to a person.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import { insertAuditLog } from "../lib/permissions";
import {
  AscApiError,
  type AscApiCredentials,
  attachBuildToVersion,
  cancelReviewSubmission,
  createAppStoreVersion,
  findAppStoreVersion,
  findAppStoreVersionById,
  getReviewSubmissionVersionId,
  listReviewSubmissions,
  ascRequest,
  resolveAscAppId,
  setVersionLocalization,
  submitVersionForReview,
} from "../lib/asc_api";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

/**
 * Version states in which the record is still ours to edit. Anything else means
 * Apple is holding it: WAITING_FOR_REVIEW / IN_REVIEW (under consideration),
 * PENDING_DEVELOPER_RELEASE / PENDING_APPLE_RELEASE (approved, about to ship),
 * READY_FOR_SALE (shipped), or a rejection state that needs a human decision.
 */
const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "METADATA_REJECTED",
  "REJECTED",
]);

/** Review states at which Apple will not accept a new submission for the platform. */
const IN_REVIEW_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW"]);

class AppStoreReleaseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function loadCredentials(c: AdminContext, appId: string): Promise<AscApiCredentials> {
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) throw new AppStoreReleaseError(500, "ASC_CRED_ENC_KEY_MISSING", "server is missing ASC_CRED_ENC_KEY");
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) {
    throw new AppStoreReleaseError(400, "ASC_CREDENTIALS_REQUIRED", "no ASC credentials configured for this app");
  }
  return creds;
}

async function ascAppIdFor(c: AdminContext, appId: string): Promise<string> {
  const row = await c.env.DB.prepare(
    "SELECT bundle_id, asc_app_id FROM apps WHERE id = ?1",
  ).bind(appId).first<{ bundle_id: string | null; asc_app_id: string | null }>();
  if (!row) throw new AppStoreReleaseError(404, "APP_NOT_FOUND", "app not found");
  if (row.asc_app_id) return row.asc_app_id;
  if (!row.bundle_id) throw new AppStoreReleaseError(400, "BUNDLE_ID_REQUIRED", "app has no bundle id");
  const bundleId: string = row.bundle_id;
  // resolveAscAppId returns null when Apple has no app with that bundle id, which
  // is a configuration problem rather than an empty result worth caching.
  const resolved = await resolveAscAppId(await loadCredentials(c, appId), bundleId);
  if (!resolved) {
    throw new AppStoreReleaseError(404, "ASC_APP_NOT_FOUND", `no App Store Connect app matches bundle id ${bundleId}`);
  }
  return resolved;
}

/**
 * Assert an Apple resource id belongs to THIS app before using it.
 *
 * App Store Connect team keys are not scoped per app: the same credential can act
 * on every app the team owns. `testflight.ts` already treats this as a rule
 * (:1258 build id must match the Hands tuple, :596 group ids must be in the app's
 * list). These routes must hold the same invariant, or a publisher of app A can
 * cancel app B's review, rewrite B's release notes, or submit B's version by
 * passing B's id.
 *
 * Unmatched ids return 404 rather than 403: the caller has no business learning
 * whether that id exists elsewhere.
 */
async function assertOwnedVersion(
  creds: AscApiCredentials,
  ascAppId: string,
  versionId: string,
): Promise<void> {
  const versions = await ascRequest<{ data?: Array<{ id?: unknown }> }>(
    creds,
    "GET",
    `/v1/apps/${encodeURIComponent(ascAppId)}/appStoreVersions?limit=200`,
  );
  const owned = (versions.data ?? []).some((v) => v.id === versionId);
  if (!owned) {
    throw new AppStoreReleaseError(404, "VERSION_NOT_IN_APP", "app store version does not belong to this app");
  }
}

async function assertOwnedSubmission(
  creds: AscApiCredentials,
  ascAppId: string,
  submissionId: string,
): Promise<void> {
  const submissions = await listReviewSubmissions(creds, ascAppId);
  if (!submissions.some((s) => s.id === submissionId)) {
    throw new AppStoreReleaseError(404, "SUBMISSION_NOT_IN_APP", "review submission does not belong to this app");
  }
}

/**
 * Record an audit row AFTER an external effect has already happened.
 *
 * Failing the request here would report failure for a submission or withdrawal
 * Apple has already accepted, inviting a retry that does the work twice. The
 * effect is real; the audit is a record of it, so a write failure is logged and
 * surfaced in the response instead of replacing a success with a 500.
 */
async function auditAfterEffect(
  c: AdminContext,
  appId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    await insertAuditLog(c.env.DB, c, { app_id: appId, action, payload });
    return true;
  } catch (error) {
    // The comment above promises this is visible, so it must actually be visible:
    // the caller is usually an agent that will not read `audited:false` in a 200.
    // Same shape as asset_upload_seal_intent_reset_failed in build_asset_uploads.ts.
    console.error("app_store_audit_write_failed", {
      action,
      app_id: appId,
      ...payload,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function fail(c: AdminContext, error: unknown) {
  if (error instanceof AppStoreReleaseError) {
    return c.json({ error: error.message, code: error.code }, error.status as 400);
  }
  // Surface Apple's own words rather than a generic 502. When App Store Connect
  // refuses a call (for example "another version is already pending release"), that
  // reason is the only thing that tells the caller what to do next, so it is passed
  // through as provider_cause in the same spirit as the Play adapter's receipts.
  if (error instanceof AscApiError) {
    return c.json({
      error: error.message,
      code: "ASC_API_REJECTED",
      status: error.status,
      ...(error.detail ? { provider_cause: error.detail } : {}),
    }, 502);
  }
  const message = error instanceof Error ? error.message : String(error);
  return c.json({ error: message, code: "APP_STORE_RELEASE_FAILED" }, 502);
}

/**
 * Create (or reuse) the App Store version for a build and attach the build to it.
 *
 * Reusing an existing editable version rather than creating a second one matters:
 * App Store Connect allows one editable version per platform, so a blind create
 * fails when a version is already prepared.
 */
export async function handlePrepareAppStoreVersion(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => null)) as
    | { version_string?: unknown; platform?: unknown; release_type?: unknown; asc_build_id?: unknown }
    | null;
  const versionString = typeof body?.version_string === "string" ? body.version_string.trim() : "";
  const platform = typeof body?.platform === "string" ? body.platform.trim() : "IOS";
  const releaseType = typeof body?.release_type === "string" ? body.release_type.trim() : "MANUAL";
  const ascBuildId = typeof body?.asc_build_id === "string" ? body.asc_build_id.trim() : "";
  if (!versionString) {
    return c.json({ error: "version_string is required", code: "VERSION_STRING_REQUIRED" }, 400);
  }
  if (!["MANUAL", "AFTER_APPROVAL", "SCHEDULED"].includes(releaseType)) {
    return c.json({ error: "release_type must be MANUAL, AFTER_APPROVAL or SCHEDULED", code: "INVALID_RELEASE_TYPE" }, 400);
  }
  try {
    const creds = await loadCredentials(c, appId);
    const ascAppId = await ascAppIdFor(c, appId);
    const existing = await findAppStoreVersion(creds, ascAppId, versionString, platform);
    // Refuse to touch a version Apple is already handling. Reusing one that is
    // waiting for or in review would attach a different build to a submission under
    // Apple's consideration, and one already pending release is still the version
    // that will ship -- either way a single mis-call would corrupt a live submission.
    if (existing && existing.state && !EDITABLE_STATES.has(existing.state)) {
      return c.json({
        error: `version ${versionString} is in state ${existing.state} and cannot be modified`,
        code: "VERSION_NOT_EDITABLE",
        version_id: existing.id,
        version_string: existing.versionString,
        state: existing.state,
        next_action: existing.state === "PENDING_DEVELOPER_RELEASE"
          ? "this version is approved and waiting to be released; release or remove it before preparing another"
          : "withdraw the pending submission first if the version must be changed",
      }, 409);
    }
    const version = existing ?? (await createAppStoreVersion(
      creds,
      ascAppId,
      versionString,
      platform,
      releaseType as "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED",
    ));
    if (ascBuildId) {
      // The build must be one of this app's, resolved from Apple's own list — same
      // rule testflight.ts applies to asc_build_id.
      const builds = await ascRequest<{ data?: Array<{ id?: unknown }> }>(
        creds,
        "GET",
        `/v1/builds?filter[app]=${encodeURIComponent(ascAppId)}&limit=200`,
      );
      if (!(builds.data ?? []).some((b) => b.id === ascBuildId)) {
        return c.json({ error: "asc_build_id does not belong to this app", code: "ASC_BUILD_NOT_IN_APP" }, 404);
      }
      await attachBuildToVersion(creds, version.id, ascBuildId);
    }
    const audited = await auditAfterEffect(c, appId, "app_store.prepare_version", {
      version_id: version.id, version_string: versionString, release_type: releaseType,
      ...(ascBuildId ? { asc_build_id: ascBuildId } : {}),
    });
    return c.json({
      audited,
      version_id: version.id,
      version_string: versionString,
      platform,
      // When an existing version is reused, its stored releaseType keeps governing
      // app behaviour -- echoing the requested value would claim MANUAL on a version
      // that actually ships AFTER_APPROVAL.
      release_type: existing ? (existing.releaseType ?? null) : releaseType,
      requested_release_type: releaseType,
      state: "state" in version ? version.state : null,
      reused: existing !== null,
      build_attached: Boolean(ascBuildId),
    });
  } catch (error) {
    return fail(c, error);
  }
}

/** Upsert per-locale What's New, one locale per entry. */
export async function handleSetAppStoreReleaseNotes(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  const body = (await c.req.json().catch(() => null)) as { notes?: unknown } | null;
  const notes = body?.notes;
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) {
    return c.json({ error: "notes must be a locale-to-text object", code: "INVALID_NOTES" }, 400);
  }
  const entries = Object.entries(notes as Record<string, unknown>);
  if (entries.length === 0) {
    return c.json({ error: "notes must contain at least one locale", code: "INVALID_NOTES" }, 400);
  }
  try {
    const creds = await loadCredentials(c, appId);
    await assertOwnedVersion(creds, await ascAppIdFor(c, appId), versionId);
    const written: string[] = [];
    for (const [locale, text] of entries) {
      if (typeof text !== "string") {
        return c.json({ error: `notes.${locale} must be a string`, code: "INVALID_NOTES" }, 400);
      }
      await setVersionLocalization(creds, versionId, locale, text);
      written.push(locale);
    }
    const audited = await auditAfterEffect(c, appId, "app_store.release_notes", { version_id: versionId, locales: written });
    return c.json({ version_id: versionId, locales: written, audited });
  } catch (error) {
    return fail(c, error);
  }
}

/**
 * Submit a prepared version for review.
 *
 * Refuses when another submission for the platform is already waiting or in
 * review: App Store Connect would reject it anyway, but a named error tells the
 * caller to withdraw first instead of guessing.
 */
export async function handleSubmitAppStoreVersion(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  try {
    const creds = await loadCredentials(c, appId);
    const ascAppId = await ascAppIdFor(c, appId);
    await assertOwnedVersion(creds, ascAppId, versionId);
    const submissions = await listReviewSubmissions(creds, ascAppId);
    for (const submission of submissions) {
      if (submission.state && IN_REVIEW_STATES.has(submission.state)) {
        const owner = await getReviewSubmissionVersionId(creds, submission.id);
        return c.json({
          error: "another review submission is already pending for this platform",
          code: "REVIEW_ALREADY_PENDING",
          submission_id: submission.id,
          submission_state: submission.state,
          version_id: owner,
          next_action: "withdraw it first with withdraw-app-store-version, or wait for the outcome",
        }, 409);
      }
    }
    // Submit on the version's own platform; hardcoding IOS would fail for a MAC_OS
    // version and silently claim the wrong one.
    const target = await findAppStoreVersionById(creds, ascAppId, versionId);
    const { submissionId } = await submitVersionForReview(creds, ascAppId, versionId, target?.platform ?? "IOS");
    const audited = await auditAfterEffect(c, appId, "app_store.submit", { version_id: versionId, submission_id: submissionId });
    return c.json({ version_id: versionId, submission_id: submissionId, submitted: true, audited });
  } catch (error) {
    return fail(c, error);
  }
}

/** Withdraw the pending submission for a version (or by submission id when given). */
export async function handleWithdrawAppStoreVersion(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => ({}) )) as { version_id?: unknown; submission_id?: unknown };
  try {
    const creds = await loadCredentials(c, appId);
    const submissionId = typeof body.submission_id === "string" ? body.submission_id : null;
    if (submissionId) {
      await assertOwnedSubmission(creds, await ascAppIdFor(c, appId), submissionId);
      await cancelReviewSubmission(creds, submissionId);
      const audited = await auditAfterEffect(c, appId, "app_store.withdraw", { submission_id: submissionId });
      return c.json({ submission_id: submissionId, canceled: true, audited });
    }
    const versionId = typeof body.version_id === "string" ? body.version_id : "";
    if (!versionId) {
      return c.json({ error: "version_id or submission_id is required", code: "TARGET_REQUIRED" }, 400);
    }
    const ascAppId = await ascAppIdFor(c, appId);
    await assertOwnedVersion(creds, ascAppId, versionId);
    for (const submission of await listReviewSubmissions(creds, ascAppId)) {
      if (!submission.state || !IN_REVIEW_STATES.has(submission.state)) continue;
      if ((await getReviewSubmissionVersionId(creds, submission.id)) !== versionId) continue;
      await cancelReviewSubmission(creds, submission.id);
      const audited = await auditAfterEffect(c, appId, "app_store.withdraw", { submission_id: submission.id, version_id: versionId });
      return c.json({ submission_id: submission.id, version_id: versionId, canceled: true, audited });
    }
    return c.json({ error: "no pending submission found for that version", code: "NO_PENDING_SUBMISSION" }, 404);
  } catch (error) {
    return fail(c, error);
  }
}

/** Read back the review state of one version. Read-only. */
export async function handleGetAppStoreReleaseStatus(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const versionString = c.req.query("version_string")?.trim();
  const platform = c.req.query("platform")?.trim() || "IOS";
  if (!versionString) {
    return c.json({ error: "version_string is required", code: "VERSION_STRING_REQUIRED" }, 400);
  }
  try {
    const creds = await loadCredentials(c, appId);
    const ascAppId = await ascAppIdFor(c, appId);
    const version = await findAppStoreVersion(creds, ascAppId, versionString, platform);
    if (!version) {
      return c.json({ error: "version not found", code: "VERSION_NOT_FOUND" }, 404);
    }
    const submissions = await listReviewSubmissions(creds, ascAppId);
    const pending = submissions.find((s) => s.state && IN_REVIEW_STATES.has(s.state)) ?? null;
    return c.json({
      version_id: version.id,
      version_string: version.versionString,
      state: version.state,
      build_attached: version.buildId !== null,
      pending_submission: pending ? { id: pending.id, state: pending.state } : null,
    });
  } catch (error) {
    return fail(c, error);
  }
}
