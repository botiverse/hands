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
