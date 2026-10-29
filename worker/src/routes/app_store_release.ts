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
  type AscAppStoreVersion,
  attachBuildToVersion,
  cancelReviewSubmission,
  createAppStoreVersion,
  findAppStoreVersion,
  findAppStoreVersionById,
  getAppStoreVersion,
  getReviewSubmissionVersionId,
  listAppStoreVersions,
  listReviewSubmissions,
  ascRequest,
  renameAppStoreVersion,
  resolveAscAppId,
  setVersionLocalization,
  submitVersionForReview,
} from "../lib/asc_api";

export type AdminContext = Context<AdminEnv & { Bindings: Env }>;

/**
 * Version states in which the record is still ours to edit and has never been
 * released. Anything else means Apple is holding it: WAITING_FOR_REVIEW / IN_REVIEW
 * (under consideration), PENDING_DEVELOPER_RELEASE / PENDING_APPLE_RELEASE
 * (approved, about to ship), READY_FOR_SALE (shipped). INVALID_BINARY is editable:
 * the fix is attaching a different build.
 *
 * Names are shared by Apple's AppStoreVersionState (appStoreState, deprecated) and
 * AppVersionState (appVersionState) enums.
 */
export const EDITABLE_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "METADATA_REJECTED",
  "REJECTED",
  "INVALID_BINARY",
]);

/**
 * Not yet released, but Apple holds the record: it cannot be edited or renamed, and
 * while it exists Apple refuses to create another version for the platform.
 */
const IN_FLIGHT_STATES = new Set([
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "READY_FOR_REVIEW",
  "WAITING_FOR_EXPORT_COMPLIANCE",
  "PENDING_CONTRACT",
  "PENDING_DEVELOPER_RELEASE",
  "PENDING_APPLE_RELEASE",
  "PROCESSING_FOR_APP_STORE",
  "PROCESSING_FOR_DISTRIBUTION",
  "ACCEPTED",
]);

/** Released or retired: history, never touched. */
const RELEASED_STATES = new Set([
  "READY_FOR_SALE",
  "READY_FOR_DISTRIBUTION",
  "PREORDER_READY_FOR_SALE",
  "REPLACED_WITH_NEW_VERSION",
  "REMOVED_FROM_SALE",
  "DEVELOPER_REMOVED_FROM_SALE",
]);

export type VersionStateClass = "editable" | "in_flight" | "released" | "unknown";

/**
 * Classify by appVersionState (Apple's current field) when present, else the
 * deprecated appStoreState. A state not listed above is "unknown", and every caller
 * treats unknown as "do not write".
 */
export function classifyVersionState(version: Pick<AscAppStoreVersion, "appVersionState" | "appStoreState">): VersionStateClass {
  const state = version.appVersionState ?? version.appStoreState;
  if (!state) return "unknown";
  if (EDITABLE_STATES.has(state)) return "editable";
  if (IN_FLIGHT_STATES.has(state)) return "in_flight";
  if (RELEASED_STATES.has(state)) return "released";
  return "unknown";
}

function stateOf(version: AscAppStoreVersion): string | null {
  return version.appVersionState ?? version.appStoreState ?? version.state;
}

/** Review states at which Apple will not accept a new submission for the platform. */
const IN_REVIEW_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW"]);

export class AppStoreReleaseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function loadCredentials(c: AdminContext, appId: string): Promise<AscApiCredentials> {
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) throw new AppStoreReleaseError(500, "ASC_CRED_ENC_KEY_MISSING", "server is missing ASC_CRED_ENC_KEY");
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) {
    throw new AppStoreReleaseError(400, "ASC_CREDENTIALS_REQUIRED", "no ASC credentials configured for this app");
  }
  return creds;
}

export async function ascAppIdFor(c: AdminContext, appId: string): Promise<string> {
  // Bundle ids live on the app's main channel, not on `apps` -- the release channel
  // is the one that names the real App Store record (preview/nightly carry beta
  // bundle ids that are not App Store apps). Same source appstore_review.ts reads.
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ id: string }>();
  if (!app) throw new AppStoreReleaseError(404, "APP_NOT_FOUND", "app not found");
  const row = await c.env.DB.prepare(
    "SELECT bundle_id FROM channels WHERE app_id = ?1 AND slug = 'main' LIMIT 1",
  ).bind(appId).first<{ bundle_id: string | null }>();
  if (!row?.bundle_id) throw new AppStoreReleaseError(400, "BUNDLE_ID_REQUIRED", "app has no bundle id");
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

/** Map an error to the status and body every App Store route returns. */
export function errorBody(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof AppStoreReleaseError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  // Surface Apple's own words rather than a generic 502. When App Store Connect
  // refuses a call (for example "another version is already pending release"), that
  // reason is the only thing that tells the caller what to do next, so it is passed
  // through as provider_cause in the same spirit as the Play adapter's receipts.
  if (error instanceof AscApiError) {
    return { status: 502, body: {
      error: error.message,
      code: "ASC_API_REJECTED",
      status: error.status,
      ...(error.detail ? { provider_cause: error.detail } : {}),
    } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 502, body: { error: message, code: "APP_STORE_RELEASE_FAILED" } };
}

export function fail(c: AdminContext, error: unknown) {
  const { status, body } = errorBody(error);
  return c.json(body, status as 400);
}

type PreparePlan =
  | { action: "created"; version: null }
  | { action: "reused"; version: AscAppStoreVersion }
  | { action: "renamed"; version: AscAppStoreVersion };

type PrepareRefusal = { status: 409; body: Record<string, unknown> };

function versionRef(v: AscAppStoreVersion) {
  return { version_id: v.id, version_string: v.versionString, state: stateOf(v) };
}

/**
 * Decide what prepare does, from Apple's full version list for the platform. Pure:
 * no writes, so dry_run and commit share it.
 *
 * Apple allows one not-yet-released version per platform. So:
 *   1. a version with the requested string exists -> reuse it if editable, else refuse;
 *   2. otherwise any unreleased version Apple is holding (in review, pending
 *      release, ...) -> refuse and name it (withdraw first);
 *   3. otherwise exactly one editable, never-released version with another string
 *      -> rename it to the requested string;
 *   4. otherwise -> create.
 * A state Hands does not recognise anywhere in the list refuses rather than guesses.
 */
export function planPrepare(versions: AscAppStoreVersion[], versionString: string): PreparePlan | PrepareRefusal {
  const exact = versions.find((v) => v.versionString === versionString);
  if (exact) {
    const cls = classifyVersionState(exact);
    if (cls === "editable") return { action: "reused", version: exact };
    const state = stateOf(exact);
    // Refuse to touch a version Apple is already handling. Reusing one that is
    // waiting for or in review would attach a different build to a submission under
    // Apple's consideration, and one already pending release is still the version
    // that will ship -- either way a single mis-call would corrupt a live submission.
    return { status: 409, body: {
      error: `version ${versionString} is in state ${state ?? "unknown"} and cannot be modified`,
      code: cls === "unknown" ? "VERSION_STATE_UNKNOWN" : "VERSION_NOT_EDITABLE",
      ...versionRef(exact),
      next_action: state === "PENDING_DEVELOPER_RELEASE"
        ? "this version is approved and waiting to be released; release or remove it before preparing another"
        : cls === "released"
          ? "this version string is already released; choose a higher version_string"
          : "withdraw the pending submission first if the version must be changed",
    } };
  }
  const others = versions.filter((v) => v.versionString !== versionString);
  const unknown = others.filter((v) => classifyVersionState(v) === "unknown");
  if (unknown.length > 0) {
    return { status: 409, body: {
      error: `version ${unknown[0]!.versionString ?? unknown[0]!.id} is in a state Hands does not recognise (${stateOf(unknown[0]!) ?? "none"}); refusing to create or rename`,
      code: "VERSION_STATE_UNKNOWN",
      ...versionRef(unknown[0]!),
      versions: unknown.map(versionRef),
    } };
  }
  const inFlight = others.filter((v) => classifyVersionState(v) === "in_flight");
  if (inFlight.length > 0) {
    const blocker = inFlight[0]!;
    const state = stateOf(blocker);
    return { status: 409, body: {
      error: `version ${blocker.versionString} is ${state}; Apple allows one unreleased version per platform, so ${versionString} cannot be created or take its place`,
      code: "VERSION_IN_FLIGHT",
      ...versionRef(blocker),
      versions: inFlight.map(versionRef),
      next_action: state === "WAITING_FOR_REVIEW" || state === "IN_REVIEW" || state === "READY_FOR_REVIEW"
        ? `withdraw it first (withdraw-app-store-version with version_id ${blocker.id}), then prepare ${versionString} again; the withdrawn version will be renamed`
        : state === "PENDING_DEVELOPER_RELEASE"
          ? "it is approved and waiting to be released; release it (or remove it in App Store Connect) before preparing another"
          : "wait for Apple to finish with it, then prepare again",
    } };
  }
  const editable = others.filter((v) => classifyVersionState(v) === "editable");
  if (editable.length > 1) {
    return { status: 409, body: {
      error: "more than one editable version exists for this platform; refusing to pick one to rename",
      code: "MULTIPLE_EDITABLE_VERSIONS",
      versions: editable.map(versionRef),
    } };
  }
  if (editable.length === 1) return { action: "renamed", version: editable[0]! };
  return { action: "created", version: null };
}

/**
 * Prepare the App Store version for a marketing version string and attach a build.
 *
 * Create, reuse, or rename -- see planPrepare. Renaming matters because App Store
 * Connect allows only one unreleased version per platform: after a withdrawal the
 * old version (e.g. 1.12.0, DEVELOPER_REJECTED) still occupies that slot, and a
 * blind create of 1.17.0 fails with "You cannot create a new version of the App in
 * the current state."
 *
 * Every write is read back (GET /v1/appStoreVersions/{id}?include=build) and the
 * request fails closed unless the version string and requested build match.
 * `mode: "dry_run"` returns the plan and writes nothing; the default stays
 * "commit" for existing callers.
 */
export async function handlePrepareAppStoreVersion(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => null)) as
    | { version_string?: unknown; platform?: unknown; release_type?: unknown; asc_build_id?: unknown; mode?: unknown }
    | null;
  const versionString = typeof body?.version_string === "string" ? body.version_string.trim() : "";
  const platform = typeof body?.platform === "string" ? body.platform.trim() : "IOS";
  const releaseType = typeof body?.release_type === "string" ? body.release_type.trim() : "MANUAL";
  const ascBuildId = typeof body?.asc_build_id === "string" ? body.asc_build_id.trim() : "";
  const mode = body?.mode === undefined ? "commit" : body.mode;
  if (!versionString) {
    return c.json({ error: "version_string is required", code: "VERSION_STRING_REQUIRED" }, 400);
  }
  if (!["MANUAL", "AFTER_APPROVAL", "SCHEDULED"].includes(releaseType)) {
    return c.json({ error: "release_type must be MANUAL, AFTER_APPROVAL or SCHEDULED", code: "INVALID_RELEASE_TYPE" }, 400);
  }
  if (mode !== "dry_run" && mode !== "commit") {
    return c.json({ error: 'mode must be "dry_run" or "commit"', code: "INVALID_MODE" }, 400);
  }
  let plan: PreparePlan | null = null;
  let versionId: string | null = null;
  const done: string[] = [];
  try {
    const creds = await loadCredentials(c, appId);
    const ascAppId = await ascAppIdFor(c, appId);
    if (ascBuildId) {
      // The build must be one of this app's, resolved from Apple's own list -- same
      // rule testflight.ts applies to asc_build_id. Checked before any write, so an
      // unknown build cannot leave a created or renamed version behind.
      const builds = await ascRequest<{ data?: Array<{ id?: unknown }> }>(
        creds,
        "GET",
        `/v1/builds?filter[app]=${encodeURIComponent(ascAppId)}&limit=200`,
      );
      if (!(builds.data ?? []).some((b) => b.id === ascBuildId)) {
        return c.json({ error: "asc_build_id does not belong to this app", code: "ASC_BUILD_NOT_IN_APP" }, 404);
      }
    }
    const decided = planPrepare(await listAppStoreVersions(creds, ascAppId, platform), versionString);
    if ("status" in decided) return c.json(decided.body, decided.status);
    plan = decided;
    const existing = plan.version;
    const summary = {
      action: plan.action,
      version_id: existing?.id ?? null,
      version_string: versionString,
      ...(plan.action === "renamed" ? { previous_version_string: existing!.versionString } : {}),
      platform,
      state: existing ? stateOf(existing) : null,
      // An existing version keeps its stored releaseType; prepare does not change it.
      release_type: existing ? existing.releaseType : releaseType,
      requested_release_type: releaseType,
      asc_build_id: ascBuildId || null,
      current_build_id: existing?.buildRelationshipReturned ? existing.buildId : null,
    };
    if (mode === "dry_run") {
      return c.json({ mode, ...summary, writes: [] });
    }

    if (plan.action === "created") {
      versionId = (await createAppStoreVersion(
        creds, ascAppId, versionString, platform, releaseType as "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED",
      )).id;
      done.push("create_version");
      if (ascBuildId) {
        await attachBuildToVersion(creds, versionId, ascBuildId);
        done.push("attach_build");
      }
    } else if (plan.action === "renamed") {
      versionId = existing!.id;
      await renameAppStoreVersion(creds, versionId, versionString, ascBuildId || null);
      done.push(ascBuildId ? "rename_version_and_attach_build" : "rename_version");
    } else {
      versionId = existing!.id;
      if (ascBuildId) {
        await attachBuildToVersion(creds, versionId, ascBuildId);
        done.push("attach_build");
      }
    }

    // Read back what Apple now holds. include=build is what makes buildId a fact;
    // if Apple does not return the relationship, a requested build cannot be
    // confirmed and the call fails rather than claiming it.
    const readback = await getAppStoreVersion(creds, versionId);
    const mismatches: string[] = [];
    if (!readback) mismatches.push("version_not_found");
    else {
      if (readback.versionString !== versionString) mismatches.push("version_string");
      if (ascBuildId && !readback.buildRelationshipReturned) mismatches.push("build_relationship_not_returned");
      else if (ascBuildId && readback.buildId !== ascBuildId) mismatches.push("build_id");
    }
    const readbackView = readback ? {
      version_string: readback.versionString,
      state: stateOf(readback),
      build_id: readback.buildRelationshipReturned ? readback.buildId : null,
      build_relationship_returned: readback.buildRelationshipReturned,
    } : null;
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "app_store.prepare_version",
      payload: {
        ...summary, version_id: versionId, steps: done,
        outcome: mismatches.length ? "readback_mismatch" : "ok",
        ...(mismatches.length ? { mismatches, readback: readbackView } : {}),
      },
    });
    if (mismatches.length) {
      return c.json({
        error: `App Store Connect read-back does not match the request (${mismatches.join(", ")})`,
        code: "READBACK_MISMATCH",
        ...summary,
        version_id: versionId,
        completed_steps: done,
        mismatches,
        readback: readbackView,
      }, 502);
    }
    return c.json({
      mode,
      ...summary,
      version_id: versionId,
      state: readbackView!.state,
      reused: plan.action !== "created",
      // From the read-back, not from the request. null = Apple did not return the
      // relationship, which is "not known", never "no build".
      build_attached: readback!.buildRelationshipReturned ? readback!.buildId !== null : null,
      build_id: readbackView!.build_id,
      completed_steps: done,
    });
  } catch (error) {
    if (done.length > 0) {
      // Something was written before the failure: say exactly what, so the caller
      // does not read a 502 as "nothing happened".
      await insertAuditLog(c.env.DB, c, {
        app_id: appId,
        action: "app_store.prepare_version",
        payload: { action: plan?.action ?? null, version_id: versionId, version_string: versionString,
          asc_build_id: ascBuildId || null, steps: done, outcome: "partial_failure" },
      }).catch(() => undefined);
      const base = errorBody(error).body;
      return c.json({ ...base, code: "PREPARE_PARTIALLY_APPLIED", cause_code: base.code ?? null,
        action: plan?.action ?? null, version_id: versionId, completed_steps: done }, 502);
    }
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
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "app_store.release_notes",
      payload: { version_id: versionId, locales: written },
    });
    return c.json({ version_id: versionId, locales: written });
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
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "app_store.submit",
      payload: { version_id: versionId, submission_id: submissionId },
    });
    return c.json({ version_id: versionId, submission_id: submissionId, submitted: true });
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
      await insertAuditLog(c.env.DB, c, {
        app_id: appId,
        action: "app_store.withdraw",
        payload: { submission_id: submissionId },
      });
      return c.json({ submission_id: submissionId, canceled: true });
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
      await insertAuditLog(c.env.DB, c, {
        app_id: appId,
        action: "app_store.withdraw",
        payload: { submission_id: submission.id, version_id: versionId },
      });
      return c.json({ submission_id: submission.id, version_id: versionId, canceled: true });
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
      // null when Apple did not return the build relationship: unknown, not "none".
      build_attached: version.buildRelationshipReturned ? version.buildId !== null : null,
      pending_submission: pending ? { id: pending.id, state: pending.state } : null,
    });
  } catch (error) {
    return fail(c, error);
  }
}
