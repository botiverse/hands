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
  register,
  success,
  type OpenApiRegistry,
} from "./common";

const AppBuildParams = AppIdParam.merge(BuildIdParam);
const AppBuildAssetParams = AppBuildParams.merge(AssetIdParam);
const AppReleaseParams = AppIdParam.merge(ReleaseIdParam);

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const SourceCommit = z.string().regex(/^[0-9a-f]{40}$/);
const AndroidArtifactDeclaration = z.object({
  kind: z.enum(["aab", "apk"]),
  filename: z.string().min(1).max(255),
  size_bytes: z.number().int().positive().max(4 * 1024 * 1024 * 1024),
  sha256: Sha256,
}).strict();

const AndroidReleaseArtifactInput = z.object({
  channel_id: z.string().min(1).max(128).optional(),
  source: z.object({
    repository: z.string().min(1).max(255),
    commit_sha: SourceCommit,
    ci_run_id: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]),
  }).strict(),
  package_name: z.string().min(3).max(255),
  version_name: z.string().min(1).max(128),
  version_code: z.number().int().positive(),
  upload_key_cert_sha256: Sha256,
  artifacts: z.array(AndroidArtifactDeclaration).length(2).openapi({
    description: "Exactly one AAB and one APK; duplicate or missing kinds are rejected.",
  }),
}).strict().openapi("AndroidReleaseArtifactInput");

const AcceptanceReceiptInput = z.object({
  artifact_id: z.string().min(1),
  verdict: z.enum(["pass", "fail"]),
  matrix_ref: z.string().min(1),
  note: z.string().optional(),
  expected_revision: z.number().int().nonnegative(),
}).strict().openapi("AcceptanceReceiptInput");

const PlayApprovalInput = z.object({
  expected_revision: z.number().int().nonnegative(),
  approval: z.object({ note: z.string().min(1) }).strict(),
}).strict();

const PlayPromotionInput = PlayApprovalInput.extend({
  track: z.enum(["internal", "closed", "production"]),
  rollout_percent: z.number().int().min(0).max(100).optional(),
}).strict().openapi("PlayPromotionInput");

export function registerAndroidDistributionRoutes(registry: OpenApiRegistry) {
  register(registry, {
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

  register(registry, {
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

  register(registry, {
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

  register(registry, {
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

  register(registry, {
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

  register(registry, {
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

  register(registry, {
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

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/releases/{releaseId}/distributions/play/promote",
    tags: ["Android distribution"],
    summary: "Promote the accepted exact AAB through the server-side Play adapter",
    description:
      "Requires immutable binding, latest passing AAB acceptance, track max + 1 versionCode, one edit lock, no live hold, and explicit human approval. No Play credential reaches this API caller.",
    security: auth,
    request: {
      params: AppReleaseParams,
      body: { content: json(PlayPromotionInput), required: true },
    },
    responses: {
      200: success("Play readback matched and immutable receipt was appended.", GenericObject),
      400: error("A promotion gate failed."),
      403: error("Human approval, publisher role, or live-hold gate failed."),
      409: error("Release revision, versionCode, or edit lock conflicts."),
      502: error("Server-side Play adapter failed or returned mismatched readback."),
    },
  });

  for (const action of ["halt", "rollback"] as const) {
    register(registry, {
      method: "post",
      path: `/api/apps/{appId}/releases/{releaseId}/distributions/play/${action}`,
      tags: ["Android distribution"],
      summary: action === "halt" ? "Halt a Play distribution" : "Rollback by republishing a prior accepted AAB",
      description: "P0 validates human approval and then fails closed until the server-side Play adapter implements this operation.",
      security: auth,
      request: {
        params: AppReleaseParams,
        body: { content: json(PlayApprovalInput), required: true },
      },
      responses: {
        403: error("Human approval or publisher role is missing."),
        502: error("Operation is not implemented by the server-side Play adapter."),
      },
    });
  }
}
