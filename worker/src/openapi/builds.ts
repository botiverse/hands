import { z } from "@hono/zod-openapi";
import {
  AppIdParam,
  AssetIdParam,
  BuildIdParam,
  GenericObject,
  auth,
  binary,
  error,
  json,
  multipart,
  register,
  success,
  type OpenApiRegistry,
} from "./common";

const AppBuildParams = AppIdParam.merge(BuildIdParam);
const AppBuildAssetParams = AppBuildParams.merge(AssetIdParam);
const AppQaArtifactParams = AppIdParam.merge(AssetIdParam);

const BuildInput = z
  .object({
    channel_id: z.string().optional(),
    product_type: z.string().optional(),
    release_type: z.string().optional(),
    version_name: z.string().optional(),
    version_code: z.number().int().optional(),
    changelog: z.string().nullable().optional(),
    source_commit: z.string().nullable().optional(),
    source_branch: z.string().nullable().optional(),
    ci_provider: z.string().nullable().optional(),
    ci_run_id: z.string().nullable().optional(),
    ci_url: z.string().nullable().optional(),
    metadata_json: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown())
  .openapi("BuildInput");

const BuildAssetInput = z
  .object({
    artifact_kind: z.string().default("installable").optional(),
    platform: z.string(),
    arch: z.string().nullable().optional(),
    variant: z.string().nullable().optional(),
    filetype: z.string(),
    r2_key: z.string().optional(),
    file_hash: z.string().optional(),
    size_bytes: z.number().int().optional(),
    signature: z.string().nullable().optional(),
    metadata_json: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown())
  .openapi("BuildAssetInput");

const ExternalBuildVersionInput = z
  .object({
    channel_id: z.string(),
    version_name: z.string(),
    version_code: z.number().int().nonnegative(),
    target: z.enum([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]),
    source_url: z.string().url(),
    raw_sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    raw_size_bytes: z.number().int().nonnegative(),
    gzip_sha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
    gzip_size_bytes: z.number().int().nonnegative().nullable().optional(),
    node_version: z.string().nullable().optional(),
    product_type: z.string().default("cli-binary").optional(),
    release_type: z.string().default("stable").optional(),
    metadata_json: z.record(z.string(), z.unknown()).optional(),
    provenance_json: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ExternalBuildVersionInput");

const IosSimulatorQaArtifactInput = z
  .object({
    channel_id: z.string().optional(),
    filename: z.string().regex(/\.app\.zip$/i),
    size_bytes: z.number().int().positive().max(500 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    source_commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
    version_name: z.string().min(1),
    build_number: z.union([z.string().min(1), z.number().int().nonnegative()]),
    bundle_id: z.string().min(3),
    github_run_id: z.union([z.string().min(1), z.number().int().nonnegative()]),
    github_artifact_id: z.union([z.string().min(1), z.number().int().nonnegative()]).nullable().optional(),
    github_repository: z.string().nullable().optional(),
    github_job_id: z.union([z.string().min(1), z.number().int().nonnegative()]).nullable().optional(),
    source_ref: z.string().nullable().optional(),
    metadata_json: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("IosSimulatorQaArtifactInput");

export function registerBuildRoutes(registry: OpenApiRegistry) {
  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/builds",
    tags: ["Builds"],
    summary: "List builds for an app",
    security: auth,
    request: {
      params: AppIdParam,
      query: z.object({
        channel_id: z.string().optional(),
        product_type: z.string().optional(),
      }),
    },
    responses: {
      200: success("Build list.", z.object({ builds: z.array(GenericObject) })),
      403: error("Current principal cannot view builds."),
      404: error("App was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/builds",
    tags: ["Builds"],
    summary: "Create a build",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(BuildInput), required: true },
    },
    responses: {
      201: success("Created build.", GenericObject),
      400: error("Invalid build payload."),
      403: error("Current principal cannot create builds."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/builds/publish-version",
    tags: ["Builds"],
    summary: "Register an immutable externally hosted build target",
    description:
      "Creates or reuses a Node build ledger entry. The external HTTPS URL remains the byte authority; Hands records hashes, sizes, and runtime metadata without pretending the artifact is stored in Hands R2.",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(ExternalBuildVersionInput), required: true },
    },
    responses: {
      200: success("Idempotent replay of an identical declaration.", GenericObject),
      201: success("Registered external build target.", GenericObject),
      400: error("Invalid external build declaration."),
      403: error("Current principal cannot publish builds."),
      404: error("App was not found."),
      409: error("App platform or immutable declaration conflicts."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/builds/{buildId}",
    tags: ["Builds"],
    summary: "Get a build",
    security: auth,
    request: { params: AppBuildParams },
    responses: {
      200: success("Build details.", GenericObject),
      403: error("Current principal cannot view this build."),
      404: error("Build was not found."),
    },
  });

  register(registry, {
    method: "patch",
    path: "/api/apps/{appId}/builds/{buildId}",
    tags: ["Builds"],
    summary: "Update a build",
    security: auth,
    request: {
      params: AppBuildParams,
      body: { content: json(BuildInput.partial()), required: true },
    },
    responses: {
      200: success("Updated build.", GenericObject),
      400: error("Invalid build payload."),
      403: error("Current principal cannot update this build."),
      404: error("Build was not found."),
    },
  });

  register(registry, {
    method: "delete",
    path: "/api/apps/{appId}/builds/{buildId}",
    tags: ["Builds"],
    summary: "Delete a build",
    security: auth,
    request: { params: AppBuildParams },
    responses: {
      200: success("Deleted build.", GenericObject),
      403: error("Current principal cannot delete this build."),
      404: error("Build was not found."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/qa-artifacts/ios-simulator",
    tags: ["QA artifacts"],
    summary: "List exact iOS simulator QA artifacts",
    description:
      "Lists QA-only .app.zip fixtures. These records are not releases and are never eligible for update offers.",
    security: auth,
    request: {
      params: AppIdParam,
      query: z.object({
        source_commit: z.string().optional(),
        github_run_id: z.string().optional(),
        sha256: z.string().optional(),
      }),
    },
    responses: {
      200: success("QA artifact list.", z.object({ artifacts: z.array(GenericObject) })),
      403: error("Current principal cannot view QA artifacts."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/qa-artifacts/ios-simulator",
    tags: ["QA artifacts"],
    summary: "Create an exact iOS simulator QA artifact upload",
    description:
      "Creates a QA-only build/asset ledger entry and returns a one-hour presigned PUT URL. The filename must end in .app.zip; IPA/APK release publishing is intentionally not used.",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: json(IosSimulatorQaArtifactInput), required: true },
    },
    responses: {
      201: success("Created pending QA artifact and upload URL.", GenericObject),
      400: error("Invalid QA artifact declaration."),
      403: error("Current principal cannot create QA artifacts."),
      503: error("Direct R2 upload signing is unavailable."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/qa-artifacts/ios-simulator/{assetId}",
    tags: ["QA artifacts"],
    summary: "Read one exact iOS simulator QA artifact",
    security: auth,
    request: { params: AppQaArtifactParams },
    responses: {
      200: success("QA artifact with build/asset ids and full provenance.", GenericObject),
      403: error("Current principal cannot view QA artifacts."),
      404: error("QA artifact was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/qa-artifacts/ios-simulator/{assetId}/complete",
    tags: ["QA artifacts"],
    summary: "Verify and complete an iOS simulator QA artifact upload",
    description:
      "One-shot completion: streams the uploaded object through SHA-256, compares exact size and digest, then copies verified bytes to an immutable R2 key before marking ready.",
    security: auth,
    request: { params: AppQaArtifactParams },
    responses: {
      200: success("Verified exact bytes; QA artifact is ready.", GenericObject),
      403: error("Current principal cannot complete QA artifacts."),
      404: error("QA artifact or uploaded object was not found."),
      409: error("Upload is not present yet."),
      422: error("Uploaded bytes do not match the declared size/SHA-256."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/qa-artifacts/ios-simulator/{assetId}/download",
    tags: ["QA artifacts"],
    summary: "Download an exact iOS simulator QA artifact",
    description:
      "The authenticated API path is the durable reference. Add ?presign=1 to receive a short-lived anonymous object URL for curl, ditto, simctl, or Stamp.",
    security: auth,
    request: { params: AppQaArtifactParams },
    responses: {
      200: {
        description: "Binary .app.zip stream, or JSON containing download_url when presign=1.",
        content: {
          ...binary(),
          "application/json": { schema: GenericObject },
          "application/zip": { schema: z.string().openapi({ format: "binary" }) },
        },
      },
      403: error("Current principal cannot download QA artifacts."),
      404: error("QA artifact or stored object was not found."),
      409: error("QA artifact has not completed exact-byte verification."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/builds/{buildId}/assets",
    tags: ["Builds"],
    summary: "List build assets",
    security: auth,
    request: { params: AppBuildParams },
    responses: {
      200: success("Build asset list.", z.object({ assets: z.array(GenericObject) })),
      403: error("Current principal cannot view build assets."),
      404: error("Build was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/builds/{buildId}/assets",
    tags: ["Builds"],
    summary: "Create build asset metadata",
    security: auth,
    request: {
      params: AppBuildParams,
      body: { content: json(BuildAssetInput), required: true },
    },
    responses: {
      201: success("Created build asset.", GenericObject),
      400: error("Invalid build asset payload."),
      403: error("Current principal cannot create build assets."),
      404: error("Build was not found."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/builds/{buildId}/external-targets",
    tags: ["Builds"],
    summary: "List externally hosted targets for a build",
    security: auth,
    request: { params: AppBuildParams },
    responses: {
      200: success(
        "External build target declarations.",
        z.object({ targets: z.array(GenericObject) }),
      ),
      403: error("Current principal cannot view build targets."),
      404: error("Build was not found."),
    },
  });

  register(registry, {
    method: "get",
    path: "/api/apps/{appId}/builds/{buildId}/assets/{assetId}/download",
    tags: ["Builds"],
    summary: "Download a build asset",
    description:
      "Streams an authenticated build asset, including installable and support artifacts such as metadata, mapping, or symbols.",
    security: auth,
    request: { params: AppBuildAssetParams },
    responses: {
      200: {
        description: "Binary asset stream. Content-Disposition contains the suggested filename.",
        content: {
          ...binary(),
          "application/vnd.android.package-archive": {
            schema: z.string().openapi({ format: "binary" }),
          },
          "application/json": {
            schema: z.string().openapi({ format: "binary" }),
          },
          "application/zip": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
      401: error("Missing or invalid authentication."),
      403: error("Authenticated account or token does not have the required role."),
      404: error("Build asset or stored object was not found."),
    },
  });

  register(registry, {
    method: "delete",
    path: "/api/apps/{appId}/builds/{buildId}/assets/{assetId}",
    tags: ["Builds"],
    summary: "Delete a build asset",
    security: auth,
    request: { params: AppBuildAssetParams },
    responses: {
      200: success("Deleted build asset.", GenericObject),
      403: error("Current principal cannot delete build assets."),
      404: error("Build asset was not found."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/apps/{appId}/upload",
    tags: ["Builds"],
    summary: "Upload an APK to object storage",
    security: auth,
    request: {
      params: AppIdParam,
      body: { content: multipart(), required: true },
    },
    responses: {
      200: success("Uploaded APK.", GenericObject),
      400: error("Invalid multipart upload."),
      403: error("Current principal cannot upload artifacts."),
    },
  });

  register(registry, {
    method: "post",
    path: "/api/parse-apk",
    tags: ["Builds"],
    summary: "Parse APK metadata without creating a build",
    security: auth,
    request: {
      body: { content: multipart(), required: true },
    },
    responses: {
      200: success("Parsed APK metadata.", GenericObject),
      400: error("Invalid APK upload."),
      403: error("Current principal cannot parse APKs."),
    },
  });
}
