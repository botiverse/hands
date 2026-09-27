/**
 * TestFlight crash feedback pull (task #246).
 *
 * GET /api/apps/:appId/testflight-crashes?build=<build number>&version=<x.y.z>&limit=<n>
 *   Newest-first tester-submitted TestFlight crashes for the iOS app resolved
 *   from the main channel's bundle id, optionally narrowed to one build.
 * GET /api/apps/:appId/testflight-crashes/:submissionId/log
 *   The raw crash log text for one submission (text/plain), ready to save as .ips.
 *
 * Only crashes that a tester chose to share from the TestFlight prompt exist in
 * this Apple API. Crashes the tester did not share show up only in Xcode
 * Organizer, so an empty list does not prove a build never crashed.
 * Tester emails are not returned.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import {
  AscApiError,
  ascRequest,
  findAscBuildsByNumber,
  getBetaCrashLogText,
  getBetaFeedbackCrashSubmission,
  listBetaFeedbackCrashSubmissions,
  resolveAscAppId,
  type AscApiCredentials,
  type BetaFeedbackCrashSubmission,
} from "../lib/asc_api";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const SUBMISSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

class CrashPullError extends Error {
  constructor(
    readonly status: 400 | 404 | 500,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function resolveIosAppContext(c: AdminContext): Promise<{
  bundleId: string;
  ascAppId: string;
  creds: AscApiCredentials;
}> {
  const appId = c.req.param("appId") ?? "";
  const app = await c.env.DB.prepare("SELECT platform FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ platform: string }>();
  if (!app) throw new CrashPullError(404, "APP_NOT_FOUND", "app not found");
  if (app.platform !== "ios") {
    throw new CrashPullError(400, "APP_NOT_IOS", "TestFlight crashes are available only for iOS apps");
  }
  const bundleRow = await c.env.DB.prepare(
    "SELECT bundle_id FROM channels WHERE app_id = ?1 AND slug = 'main' LIMIT 1",
  )
    .bind(appId)
    .first<{ bundle_id: string | null }>();
  const bundleId = (bundleRow?.bundle_id ?? "").trim();
  if (!bundleId) {
    throw new CrashPullError(400, "BUNDLE_ID_NOT_CONFIGURED", "the main channel has no App Store bundle id");
  }
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    throw new CrashPullError(500, "ASC_ENCRYPTION_NOT_CONFIGURED", "server is missing ASC_CRED_ENC_KEY");
  }
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) {
    throw new CrashPullError(400, "ASC_CREDENTIALS_NOT_CONFIGURED", "no ASC credentials configured for this app");
  }
  const ascAppId = await resolveAscAppId(creds, bundleId);
  if (!ascAppId) {
    throw new CrashPullError(404, "ASC_APP_NOT_FOUND", `no App Store Connect app record for bundle id ${bundleId}`);
  }
  return { bundleId, ascAppId, creds };
}

function errorResponse(c: AdminContext, error: unknown) {
  if (error instanceof CrashPullError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof AscApiError) {
    const notFound = error.status === 404;
    return c.json(
      {
        error: error.message,
        code: notFound ? "ASC_NOT_FOUND" : "ASC_API_ERROR",
        upstream_status: error.status,
        detail: error.detail,
      },
      notFound ? 404 : 502,
    );
  }
  throw error;
}

/** Map ASC build ids → {build_number, version} (best-effort; one request). */
async function describeBuilds(
  creds: AscApiCredentials,
  ids: string[],
): Promise<Map<string, { build_number: string | null; version: string | null }>> {
  const out = new Map<string, { build_number: string | null; version: string | null }>();
  if (ids.length === 0) return out;
  try {
    const res = await ascRequest<{
      data: Array<{
        id: string;
        attributes?: { version?: string | null };
        relationships?: { preReleaseVersion?: { data?: { id: string } | null } };
      }>;
      included?: Array<{ id: string; type: string; attributes?: { version?: string | null } }>;
    }>(
      creds,
      "GET",
      `/v1/builds?filter[id]=${ids.map(encodeURIComponent).join(",")}&include=preReleaseVersion&limit=${Math.min(ids.length, 200)}`,
    );
    const versions = new Map(
      (res.included ?? [])
        .filter((item) => item.type === "preReleaseVersions")
        .map((item) => [item.id, item.attributes?.version ?? null]),
    );
    for (const build of res.data ?? []) {
      const pre = build.relationships?.preReleaseVersion?.data?.id;
      out.set(build.id, {
        build_number: build.attributes?.version ?? null,
        version: pre ? versions.get(pre) ?? null : null,
      });
    }
  } catch {
    // Build labels are a convenience; the crash list is still useful without them.
  }
  return out;
}

function publicCrash(
  item: BetaFeedbackCrashSubmission,
  builds: Map<string, { build_number: string | null; version: string | null }>,
) {
  const a = item.attributes ?? {};
  const buildId = item.relationships?.build?.data?.id ?? null;
  const label = buildId ? builds.get(buildId) : undefined;
  return {
    id: item.id,
    created_at: a.createdDate ?? null,
    asc_build_id: buildId,
    build_number: label?.build_number ?? null,
    version: label?.version ?? null,
    device_model: a.deviceModel ?? null,
    os_version: a.osVersion ?? null,
    architecture: a.architecture ?? null,
    locale: a.locale ?? null,
    connection_type: a.connectionType ?? null,
    battery_percentage: a.batteryPercentage ?? null,
    app_uptime_ms: a.appUptimeInMilliseconds ?? null,
    comment: a.comment ?? null,
  };
}

export function parseCrashLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new CrashPullError(400, "INVALID_LIMIT", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return n;
}

export async function handleListTestflightCrashes(c: AdminContext) {
  try {
    const limit = parseCrashLimit(c.req.query("limit"));
    const buildNumber = c.req.query("build")?.trim() || undefined;
    const version = c.req.query("version")?.trim() || undefined;
    if (version && !buildNumber) {
      throw new CrashPullError(400, "BUILD_REQUIRED", "version filter needs build (the build number)");
    }
    const { bundleId, ascAppId, creds } = await resolveIosAppContext(c);

    let submissions: BetaFeedbackCrashSubmission[];
    if (buildNumber) {
      const builds = await findAscBuildsByNumber(creds, { ascAppId, buildNumber, version });
      if (builds.length === 0) {
        throw new CrashPullError(
          404,
          "ASC_BUILD_NOT_FOUND",
          `no App Store Connect build ${buildNumber}${version ? ` (${version})` : ""} for ${bundleId}`,
        );
      }
      const perBuild = await Promise.all(
        builds.map((b) => listBetaFeedbackCrashSubmissions(creds, { ascAppId, ascBuildId: b.id, limit })),
      );
      submissions = perBuild
        .flat()
        .sort((x, y) => (y.attributes?.createdDate ?? "").localeCompare(x.attributes?.createdDate ?? ""))
        .slice(0, limit);
    } else {
      submissions = await listBetaFeedbackCrashSubmissions(creds, { ascAppId, limit });
    }

    const buildIds = [
      ...new Set(submissions.map((s) => s.relationships?.build?.data?.id).filter((v): v is string => !!v)),
    ];
    const labels = await describeBuilds(creds, buildIds);
    return c.json({
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      filter: { build: buildNumber ?? null, version: version ?? null, limit },
      crashes: submissions.map((s) => publicCrash(s, labels)),
      note: "Only crashes testers chose to share from TestFlight appear here; unshared crashes are only in Xcode Organizer.",
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}

export async function handleGetTestflightCrashLog(c: AdminContext) {
  try {
    const submissionId = c.req.param("submissionId") ?? "";
    if (!SUBMISSION_ID.test(submissionId)) {
      throw new CrashPullError(400, "INVALID_SUBMISSION_ID", "invalid crash submission id");
    }
    const { bundleId, creds } = await resolveIosAppContext(c);
    // ASC keys are team-wide: make sure the submission belongs to THIS app's bundle.
    const submission = await getBetaFeedbackCrashSubmission(creds, submissionId);
    const submissionBundle = submission.attributes?.buildBundleId ?? null;
    if (submissionBundle && submissionBundle !== bundleId) {
      throw new CrashPullError(404, "CRASH_NOT_FOUND", "crash submission not found for this app");
    }
    const text = await getBetaCrashLogText(creds, submissionId);
    if (!text) {
      throw new CrashPullError(404, "CRASH_LOG_NOT_AVAILABLE", "Apple has no crash log for this submission");
    }
    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="testflight-crash-${submissionId}.ips"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(c, error);
  }
}
