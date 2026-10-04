import { handleAppleWebhook, handleCreateAppleWebhook, handleGetAppleWebhook, handleDeleteAppleWebhook, handleRegisterAppleWebhook } from "./routes/apple_webhooks";
import { handleStartGooglePlayOAuth, handleGooglePlayOAuthCallback } from "./routes/google_play_oauth";
import { handleUploadAgcMarketPackage, handleGetAgcMarketPackage } from "./routes/agc_market_packages";
/**
 * quiver Worker entry
 *
 * Adapted from cloudflare/templates/containers-template (Hono + Containers pattern).
 * Extends with D1 (apps / builds / releases / channels / audit_logs) and R2 (APK binaries + icons).
 *
 * The ApkParserContainer class is bundled into the container image and runs
 * inside it. Class methods (onStart, parseApk) can use `(this.ctx as any).container.exec.bind((this.ctx as any).container)()`
 * to spawn processes within the container — see
 * https://developers.cloudflare.com/containers/execute-commands/
 */

import { Container, getRandom } from "@cloudflare/containers";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { httpResponseTelemetry } from "./middleware/http_response_telemetry";
import { publicDocAssetPaths } from "./lib/public_docs";

import { authMiddleware, currentActor } from "./middleware/auth";
import { requireHandsAdmin } from "./middleware/hands_admin";
import {
  handleAgentLoginAction,
  handleAgentExchange,
  handleAgentRefresh,
} from "./routes/agent_login";
import {
  handleAgentManifest,
  handleAgentHelp,
  handleAgentMigrationHelp,
  handleAuthConfig,
  handleDashboardRedirect,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthMe,
  handleRaftCallback,
} from "./routes/auth";
import {
  handleInstallerLogin,
  handleInstallerLogout,
  handleInstallerRaftCallback,
  handleInstallerToken,
} from "./routes/installer_auth";
import { installerAuthMiddleware, type InstallerVariables } from "./lib/installer_auth";
import {
  handleDeleteInstallerSubscription,
  handleInstallerCatalog,
  handleInstallerManifest,
  handleInstallerSubscriptions,
  handlePutInstallerSubscription,
} from "./routes/installer";
import { handleHandsAdminOverview } from "./routes/hands_admin";
import {
  handleDeleteAgcCredentials,
  handleGetAgcCredentials,
  handleSetAgcCredentials,
  handleVerifyAgcCredentials,
} from "./routes/agc_credentials";
import { handleAppGalleryReview, handleGetAgcBuildSubmission, handleGetAgcSubmission, handleListAgcTestGroups, handleStartAgcInvitationTest, handleSubmitAgcInvitationTest } from "./routes/agc_testing";
import {
  handleListApps,
  handleCreateApp,
  handleTransferApp,
  handleGetApp,
  handleArchiveApp,
  handlePurgeApp,
  handleUpdateApp,
  handleUploadAppIcon,
  handlePublicAppIcon,
  handleGetClientKey,
  handleRotateClientKey,
  handleGetFeatureFlag,
  handleUpdateFeatureFlag,
} from "./routes/apps";
import {
  handlePublicListChannels,
} from "./routes/public";
import {
  handlePublicR2Download,
  handleInternalR2Download,
  handlePublicCliBinaryVersions,
  handlePublicV2Latest,
  handlePublicV2UpdateCheck,
} from "./routes/public_v2";
import { handleElectronGenericAsset } from "./routes/electron";
import { handleExternalLatestDl, handleExternalReleaseDl } from "./routes/external_dl";
import {
  handleCreateReleaseShare,
  handleListReleaseShares,
  handlePublicReleaseShareDownload,
  handlePublicReleaseShare,
  handleRevokeReleaseShare,
  handleUpdateReleaseShare,
  handleRebindReleaseShare,
  handleListAppShares,
  handlePublicReleaseShareUnlock,
  handlePublicReleaseShareIcon,
} from "./routes/shares";
import {
  handlePublicFeedbackSubmit,
  handlePublicMinidumpSubmit,
  handleListFeedback,
  handleListFeedbackMaterialDelta,
  handleGetFeedback,
  handleUpdateFeedback,
  handleAddFeedbackComment,
  handleResymbolicateFeedback,
  handleDownloadFeedbackAttachment,
  handleListCrashGroups,
  handleFeedbackStats,
  handlePresignFeedbackAttachments,
  handleFeedbackMultipartPart,
  handleCompleteFeedbackMultipart,
  handleAbortFeedbackMultipart,
} from "./routes/feedback";
import { handleDeviceRegister, handleDeviceAnalytics, handleDeviceDetail, handleVersionAnalytics } from "./routes/analytics";
import { handleSessionEvent, handleReleaseHealth } from "./routes/sessions";
import {
  handlePublicAppHistory,
  handlePublicAppHistoryDownload,
  handlePublicLatestReleaseDownload,
  handlePublicLatestReleaseLanding,
  handlePublicVersionLanding,
  handlePublicReleaseNotes,
  handlePublicReleaseNotesJson,
} from "./routes/history";
import {
  handleCreateAppDeployToken,
  handleGetAppPermissionModel,
  handleListAppDeployTokens,
  handleRevokeAppDeployToken,
} from "./routes/deploy_tokens";
import {
  handleCreateReporterIntegration,
  handleListReporterIntegrations,
  handleUpdateReporterIntegration,
} from "./routes/reporter_integrations";
import {
  handleAddReporterComment,
  handleCloseReporterFeedback,
  handleDownloadReporterAttachment,
  handleGetReporterFeedback,
  handleListReporterFeedback,
  cleanupReporterFeedbackData,
} from "./routes/reporter_feedback";
import { handleMintReporterSession } from "./routes/reporter_sessions";
import {
  handleBindReporterRouteSubject,
  handleBindReporterWebhook,
  handleGetReporterRouteMetadata,
} from "./routes/reporter_routes";
import {
  handleGetAscCredentials,
  handleSetAscCredentials,
  handleDeleteAscCredentials,
  handleVerifyAscCredentials,
} from "./routes/asc_credentials";
import {
  handleListTestflightGroups,
  handleTestflightExpire,
  handleTestflightPublish,
  handleTestflightPublishStatus,
  handleTestflightUpload,
  handleTestflightUploadStatus,
} from "./routes/testflight";
import { handleAppStoreReview } from "./routes/appstore_review";
import {
  handleGetBetaAppDescription,
  handleUpdateBetaAppDescription,
} from "./routes/testflight_beta_app_description";
import {
  handleCloseTestflightCrash,
  handleCloseTestflightFeedback,
  handleGetTestflightCrashLog,
  handleListTestflightCrashes,
  handleListTestflightFeedback,
} from "./routes/testflight_crashes";
import { handleGenerateDeltaPatches, handleDeltaSources } from "./routes/delta";
import { handleUploadApk } from "./routes/upload";
import {
  cleanupExpiredBuildAssetUploads,
  handleAbortBuildAssetUpload,
  handleBeginHostedBuildMigration,
  handleCompleteBuildAssetUpload,
  handleCompleteHostedBuildMigration,
  handleDeclareBuildAssetUpload,
  handleGetBuildAssetUpload,
} from "./routes/build_asset_uploads";
import {
  handleListOperations,
  handleGetOperation,
  handleRetryOperation,
  handleDeleteOperation,
  handleStreamOperations,
  createOperation,
  updateOperation,
} from "./routes/operations";
import {
  handleCreateBuild,
  handleCreateBuildAsset,
  handleDeleteBuild,
  handleDeleteBuildAsset,
  handleDownloadBuildAsset,
  handleGetBuild,
  handleListExternalBuildTargets,
  handleListBuildAssets,
  handleListBuilds,
  handlePublishExternalBuildVersion,
  handleUpdateBuild,
} from "./routes/builds";
import {
  handleCompleteIosSimulatorArtifact,
  handleCreateIosSimulatorArtifact,
  handleDownloadIosSimulatorArtifact,
  handleGetIosSimulatorArtifact,
  handleListIosSimulatorArtifacts,
} from "./routes/qa_artifacts";
import {
  handleCompleteAndroidReleaseArtifact,
  handleCreateAndroidReleaseArtifacts,
  handleGetAndroidReleaseArtifacts,
} from "./routes/android_release_artifacts";
import {
  handleCreateAcceptanceReceipt,
  handleGetPlayDistribution,
  handleHaltPlayDistribution,
  handleListDistributions,
  handleListReleaseReceipts,
  handlePromotePlayDistribution,
  handleRollbackPlayDistribution,
} from "./routes/play_distribution";
import {
  handleDeleteGooglePlayBinding,
  handleDisableGooglePlayBinding,
  handleEnableGooglePlayBinding,
  handleGetGooglePlayBinding,
  handleListGooglePlayTracks,
  handlePutGooglePlayBinding,
  handleVerifyGooglePlayBinding,
} from "./routes/google_play_bindings";
import {
  handleBumpRollout,
  handleCreateRelease,
  handleCreateReleaseDraft,
  handleDeleteRelease,
  handleForceUpdate,
  handleGetRelease,
  handleListReleases,
  handlePublishRelease,
  handleRollbackRelease,
  handleUpdateRelease,
  handleUpsertReleaseCheck,
  handleListReleaseChecks,
  handleListReleaseApprovals,
  handleApproveReleaseApproval,
  handleRejectReleaseApproval,
} from "./routes/releases";
import { handleListChannels, handleCreateChannel, handleUpdateChannel, handleDeleteChannel } from "./routes/channels";
import {
  handleAddDeviceGroupMember,
  handleCreateDeviceGroup,
  handleDeleteDeviceGroup,
  handleListDeviceGroups,
  handleRemoveDeviceGroupMember,
  handleUpdateDeviceGroup,
} from "./routes/device_groups";
import { handleListProductTypes, handleCreateProductType, handleUpdateProductType, handleDeleteProductType } from "./routes/product_types";
import { handleListReleaseTypes, handleCreateReleaseType, handleUpdateReleaseType, handleDeleteReleaseType } from "./routes/release_types";
import { handleListAuditLogs, handleListUserAudit } from "./routes/audit";
import {
  handleCreateAppWebhook,
  handleDeleteAppWebhook,
  handleListAppWebhookDeliveries,
  handleListAppWebhooks,
  handleUpdateAppWebhook,
  handleCreateWebhook,
  handleDeleteWebhook,
  handleListDeliveries,
  handleListWebhooks,
  handleWebhookQueue,
  reapWebhookDeliveries,
  handleUpdateWebhook,
} from "./routes/webhooks";
import { handleHealth } from "./routes/health";
import {
  handleAcceptInvite,
  handleAddAppMember,
  handleAddAppServerGrant,
  handleCreateOrgInvite,
  handleGetInvite,
  handleListAppMembers,
  handleListAppServerGrants,
  handleListOrgAuditLogs,
  handleListOrgInvites,
  handleListOrgMembers,
  handleListOrgs,
  handleRemoveAppMember,
  handleRemoveAppServerGrant,
  handleRemoveOrgMember,
  handleResendOrgInvite,
  handleRevokeOrgInvite,
  handleUpdateAppMember,
  handleUpdateAppServerGrant,
  handleUpdateOrgMember,
} from "./routes/orgs";
import {
  requireAppRole,
  requireAppRoleOrFeedbackPermission,
  requireCurrentOrgRole,
  requireFeedbackTriageRole,
  requireOrgRole,
} from "./lib/permissions";
import { openApiDocument } from "./openapi";
import { feedbackRoutes } from "./openapi/feedback";
import { registerAppRoutes } from "./openapi/apps";
import { registerAndroidDistributionRoutes } from "./openapi/android_distribution";
import { registerAuthRoutes } from "./openapi/auth";
import { registerBuildRoutes } from "./openapi/builds";
import { registerOrgRoutes } from "./openapi/orgs";
import { registerPublicRoutes } from "./openapi/public";
import { registerReleaseRoutes } from "./openapi/releases";
import { registerSettingsRoutes } from "./openapi/settings";
import type { RouteConfigDef } from "./openapi/common";

// Single source of truth for request schemas: every documented route is bound
// through .openapi() so the handler can never drift from the spec again.
// Index keyed "METHOD {openapi-path}"; register*() producers keep loop
// generation, so paths only exist at runtime — this map is built here once.
const specIndex = new Map<string, RouteConfigDef>();
for (const cfg of [
  ...Object.values(feedbackRoutes),
  ...registerAuthRoutes(),
  ...registerPublicRoutes(),
  ...registerAppRoutes(),
  ...registerAndroidDistributionRoutes(),
  ...registerBuildRoutes(),
  ...registerReleaseRoutes(),
  ...registerOrgRoutes(),
  ...registerSettingsRoutes(),
]) {
  specIndex.set(`${cfg.method.toUpperCase()} ${cfg.path}`, cfg);
}

// Look up a RouteConfig from a named domain map; throws at startup if the
// (method, path) isn't documented, so a spec↔route drift fails fast here
// instead of silently serving an unvalidated route.
const openapiLookup = (map: Record<string, RouteConfigDef>, key: string): RouteConfigDef => {
  const cfg = map[key];
  if (!cfg) throw new Error(`openapi route missing: ${key}`);
  return cfg;
};

const honoPathToSpecPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, "{$1}");

// Routes whose request body isn't JSON (file uploads, streams, multipart)
// must stay raw — the zod-openapi validator would otherwise reject them.
const isJsonBoundRoute = (cfg: RouteConfigDef): boolean => {
  const content = cfg.request?.body?.content as Record<string, unknown> | undefined;
  if (!content) return true;
  return Object.keys(content).every((k) => k === "application/json" || k.endsWith("+json"));
};

// Route/middleware signatures differ across Hono generics; the binding layer
// accepts both and only preserves ordering.
type HandlerOrMw = (c: any, next?: any) => unknown;
const bindRoute = (
  target: any,
  method: string,
  path: string,
  handlers: HandlerOrMw[],
) => {
  const cfg = specIndex.get(`${method.toUpperCase()} ${honoPathToSpecPath(path)}`);
  if (cfg && isJsonBoundRoute(cfg)) {
    const mw = handlers.slice(0, -1);
    target.openapi({ ...cfg, middleware: mw }, handlers[handlers.length - 1]);
  } else {
    target[method](path, ...handlers);
  }
};
const bindApp = (method: string, path: string, ...handlers: HandlerOrMw[]) =>
  bindRoute(app, method, path, handlers);
const bindAdmin = (method: string, path: string, ...handlers: HandlerOrMw[]) =>
  bindRoute(admin, method, path, handlers);
import {
  httpsRedirectUrl,
  requestOrigin,
} from "./lib/origin";

// ---------- Container binding (APK parser) ----------
//
// This class is compiled by wrangler and bundled into the container image.
// At runtime its methods run *inside* the container and have access to
// `(this.ctx as any).container.exec.bind((this.ctx as any).container)()` for spawning processes.

export interface ApkMetadata {
  package_name: string;
  version_name: string;
  version_code: number;
  min_sdk: number | null;
  target_sdk: number | null;
  app_label: string | null;
  signature_sha256: string;
  size_bytes: number;
  file_hash_sha256: string;
}

// Absolute paths inside the container image (Android SDK build-tools 34.0.0).
const AAPT_BIN = "/opt/android-sdk/build-tools/34.0.0/aapt";
const APKSIGNER_BIN = "/opt/android-sdk/build-tools/34.0.0/apksigner";
const TMP_DIR = "/tmp/quiver-apk";

export class ApkParserContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m";

  override async onStart() {
    // Sanity check + PATH/env diagnostics so we can see exactly what's wrong.
    const decoder = new TextDecoder();

    const whereProc = await (this.ctx as any).container.exec.bind((this.ctx as any).container)(["which", "aapt"]);
    const whereOut = await whereProc.output();
    console.log(
      `[apk-parser] which aapt: exit=${whereOut.exitCode ?? "?"} stdout="${decoder.decode(whereOut.stdout ?? new Uint8Array()).trim()}" stderr="${decoder.decode(whereOut.stderr ?? new Uint8Array()).trim()}"`,
    );

    const directProc = await (this.ctx as any).container.exec.bind((this.ctx as any).container)([AAPT_BIN, "version"]);
    const directOut = await directProc.output();
    console.log(
      `[apk-parser] direct ${AAPT_BIN} version: exit=${directOut.exitCode ?? "?"} stdout="${decoder.decode(directOut.stdout ?? new Uint8Array()).trim()}" stderr="${decoder.decode(directOut.stderr ?? new Uint8Array()).trim()}"`,
    );

    const pathProc = await (this.ctx as any).container.exec.bind((this.ctx as any).container)(["sh", "-c", "echo $PATH && ls /opt/android-sdk/build-tools/ 2>&1 | head -5"]);
    const pathOut = await pathProc.output();
    console.log(
      `[apk-parser] PATH + ls: ${decoder.decode(pathOut.stdout ?? new Uint8Array()).trim()}`,
    );
  }

  override onStop() {
    console.log("[apk-parser] container stopped");
  }
  override onError(error: unknown) {
    console.log("[apk-parser] container error:", error);
  }

  /**
   * Parse an APK and return its metadata.
   *
   * Called by the Worker via `container.fetch(...)` after writing the APK
   * bytes to a known in-container path. This method runs in the container
   * and uses `(this.ctx as any).container.exec.bind((this.ctx as any).container)()` to spawn aapt / apksigner.
   *
   * Path convention: the worker writes the APK to /tmp/quiver-apk/<id>.apk
   * first, then calls this method with the id.
   */
  async parseApk(id: string): Promise<ApkMetadata> {
    const apkPath = `${TMP_DIR}/${id}.apk`;

    // 1. aapt dump badging
    const aaptProc = await (this.ctx as any).container.exec.bind((this.ctx as any).container)([
      AAPT_BIN,
      "dump",
      "badging",
      apkPath,
    ]);
    const aaptOut = await aaptProc.output();
    if (aaptOut.exitCode !== 0) {
      const err = new TextDecoder().decode(aaptOut.stderr);
      throw new Error(`aapt dump badging failed (exit ${aaptOut.exitCode}): ${err}`);
    }
    const badging = new TextDecoder().decode(aaptOut.stdout);

    // 2. apksigner verify --print-certs
    const sigProc = await (this.ctx as any).container.exec.bind((this.ctx as any).container)([
      APKSIGNER_BIN,
      "verify",
      "--print-certs",
      apkPath,
    ]);
    const sigOut = await sigProc.output();
    if (sigOut.exitCode !== 0) {
      const err = new TextDecoder().decode(sigOut.stderr);
      throw new Error(
        `apksigner verify failed (exit ${sigOut.exitCode}): ${err}`,
      );
    }
    const certsOut = new TextDecoder().decode(sigOut.stdout);

    // 3. parse
    return parseBadgingAndCerts(badging, certsOut, id);
  }
}

function parseBadgingAndCerts(
  badging: string,
  certsOut: string,
  id: string,
): ApkMetadata {
  const packageName = badging.match(/^package: name='([^']+)'/m)?.[1] ?? "";
  const versionMatch = badging.match(
    /^package: name='[^']+'\s+versionCode='(\d+)'\s+versionName='([^']+)'/m,
  );
  const versionCode = Number(versionMatch?.[1] ?? "0");
  const versionName = versionMatch?.[2] ?? "";
  const sdkLine = badging.match(/sdkVersion:'(\d+)'/);
  const targetSdkLine = badging.match(/targetSdkVersion:'(\d+)'/);
  const labelLine = badging.match(
    /^application-label(?:-[a-z]+)?:'([^']+)'/m,
  );
  const minSdk = sdkLine ? Number(sdkLine[1]) : null;
  const targetSdk = targetSdkLine ? Number(targetSdkLine[1]) : null;
  const appLabel = labelLine?.[1] ?? null;

  const sha256Match = certsOut.match(/SHA-256 digest:\s*([0-9a-fA-F:]+)/);
  const signatureSha256 = sha256Match?.[1]?.replace(/:/g, "").toLowerCase() ?? "";

  // We don't compute file_hash_sha256 in the container anymore — the
  // Worker computes it from the bytes it uploaded (in the upload endpoint).
  // The container is invoked *after* the upload, so the Worker passes the
  // hash in via the parse-apk endpoint as a separate field. To keep the
  // method signature minimal we just store it client-side and the Worker
  // merges it back in.
  return {
    package_name: packageName,
    version_name: versionName,
    version_code: versionCode,
    min_sdk: minSdk,
    target_sdk: targetSdk,
    app_label: appLabel,
    signature_sha256: signatureSha256,
    size_bytes: 0, // populated by Worker from the upload request
    file_hash_sha256: id, // placeholder; Worker overwrites with real hash
  };
}

// ---------- Hono app ----------

const app = new OpenAPIHono<{ Bindings: Env }>({
  // Validation failures keep our plain `{error}` shape rather than zod-openapi's
  // default {success,error:{issues}} so callers that already parse `error`
  // see a consistent payload.
  defaultHook: (result, c) => {
    if (!result.success) {
      // ZodError#message is a serialized JSON array of issues; surface a
      // human-readable path:message summary instead.
      const detail = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return c.json({ error: "invalid request", detail }, 400);
    }
  },
});

app.use("*", httpResponseTelemetry);

app.use("*", async (c, next) => {
  const redirectUrl = httpsRedirectUrl(c);
  if (redirectUrl) {
    return c.redirect(redirectUrl, 308);
  }
  return next();
});

function allowedCorsOrigin(origin: string, env: Env): string | null {
  if (!origin) return "*";

  const allowed = (env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of allowed) {
    if (entry === "*") return origin;
    if (entry === origin) return origin;
    if (entry.includes("*")) {
      const pattern = new RegExp(
        `^${entry
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      if (pattern.test(origin)) return origin;
    }
  }

  return null;
}

// CORS is intentionally driven by environment config so deployment-specific
// admin/dev origins are not hardcoded in server code.
app.use(
  "*",
  cors({
    origin: (origin, c) => allowedCorsOrigin(origin, c.env),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "authorization"],
    credentials: false,
  }),
);

bindApp("post", "/api/apple/webhooks/:configId", handleAppleWebhook);

// Public — health check (no auth)
bindApp("get", "/health", handleHealth);
bindApp("get", "/.well-known/raft-agent-manifest.json", handleAgentManifest);
bindApp("get", "/openapi.json", (c) => c.json({
  ...openApiDocument,
  servers: [
    {
      url: requestOrigin(c),
      description: "Current request origin",
    },
    {
      url: "http://localhost:8787",
      description: "Local wrangler dev",
    },
  ],
}));
bindApp("get", "/api-docs", (c) => c.html(`<!doctype html>
<html lang="en">
  <head>
    <title>Hands API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <style>
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      .quiver-api-header {
        height: 56px;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 18px;
        border-bottom: 1px solid #e2e8f0;
        background: #ffffff;
      }
      .quiver-api-header a {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: #0f172a;
        font-size: 18px;
        font-weight: 500;
        text-decoration: none;
      }
      .quiver-api-header img { width: 32px; height: 32px; border-radius: 8px; }
      #app { min-height: calc(100vh - 57px); }
    </style>
  </head>
  <body>
    <header class="quiver-api-header">
      <a href="/" aria-label="Hands home">
        <img src="/favicon.svg" alt="" />
        <span>Hands</span>
      </a>
    </header>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '/openapi.json',
        theme: 'default',
        customCss: '#references { min-height: calc(100vh - 57px); }'
      })
    </script>
  </body>
</html>`));
async function handlePublicDocs(c: Context<{ Bindings: Env }>) {
  const path = new URL(c.req.url).pathname;
  // Raw-markdown twins: /docs.md (machine index) and /docs/<slug>.md. The build
  // (admin/scripts/build-docs.mjs) emits these from the same source as the HTML,
  // so they stay in lockstep. Serve the asset as-is (ASSETS 404s for unknown
  // files) with a markdown content type — no trailing-slash normalization.
  if (path.endsWith(".md")) {
    const asset = await c.env.ASSETS.fetch(new Request(new URL(path, c.req.url), c.req.raw));
    // ASSETS runs in single-page-app mode: unknown paths fall back to
    // index.html (200, text/html). Treat that HTML fallback as not-found for a
    // .md request — only a real markdown asset should be served here.
    const assetType = asset.headers.get("content-type") ?? "";
    if (asset.status === 404 || assetType.includes("text/html")) {
      return c.text("Not found", 404);
    }
    const headers = new Headers(asset.headers);
    headers.set("content-type", "text/markdown; charset=utf-8");
    return new Response(asset.body, { status: asset.status, headers });
  }
  const assetPaths = publicDocAssetPaths(path);
  if (!assetPaths) return c.text("Not found", 404);

  // Cloudflare Assets uses SPA fallback for the admin app, so an unknown docs
  // URL would otherwise return the root index.html with status 200. Generated
  // articles always have a Markdown twin; use that file as the automatic docs
  // manifest before serving the article HTML.
  if (assetPaths.markdownTwinPath) {
    const twin = await c.env.ASSETS.fetch(
      new Request(new URL(assetPaths.markdownTwinPath, c.req.url), c.req.raw),
    );
    const twinType = twin.headers.get("content-type") ?? "";
    if (twin.status === 404 || twinType.includes("text/html")) {
      return c.text("Not found", 404);
    }
  }
  return c.env.ASSETS.fetch(new Request(new URL(assetPaths.htmlPath, c.req.url), c.req.raw));
}

bindApp("get", "/docs", handlePublicDocs);
bindApp("get", "/docs.md", handlePublicDocs);
bindApp("get", "/docs/*", handlePublicDocs);

bindApp("get", "/api/auth/config", handleAuthConfig);
bindApp("get", "/api/auth/dashboard", handleDashboardRedirect);
bindApp("get", "/api/auth/login", handleAuthLogin);
bindApp("get", "/login/raft/callback", handleRaftCallback);
bindApp("get", "/api/auth/me", handleAuthMe);
bindApp("get", "/api/agent/help", handleAgentHelp);
bindApp("get", "/api/agent/migration-help", handleAgentMigrationHelp);
bindApp("post", "/api/auth/logout", handleAuthLogout);
// Agent CLI login token endpoints (RFC 057) — PUBLIC: the grant+verifier / refresh
// token is itself the credential (OAuth-token-endpoint style), so no prior session.
bindApp("post", "/api/auth/agent/exchange", handleAgentExchange);
bindApp("post", "/api/auth/agent/refresh", handleAgentRefresh);

bindApp("get", "/api/installer/v1/auth/login", handleInstallerLogin);
bindApp("get", "/login/raft/installer/callback", handleInstallerRaftCallback);
bindApp("post", "/api/installer/v1/auth/token", handleInstallerToken);
bindApp("post", "/api/installer/v1/auth/logout", handleInstallerLogout);

const installer = new Hono<{ Bindings: Env; Variables: InstallerVariables }>();
installer.use("/api/installer/v1/*", installerAuthMiddleware);
installer.get("/api/installer/v1/catalog", handleInstallerCatalog);
installer.get("/api/installer/v1/subscriptions", handleInstallerSubscriptions);
installer.put("/api/installer/v1/subscriptions/:appId/:channel", handlePutInstallerSubscription);
installer.delete("/api/installer/v1/subscriptions/:appId/:channel", handleDeleteInstallerSubscription);
installer.get("/api/installer/v1/apps/:appId/channels/:channel/manifest", handleInstallerManifest);
app.route("/", installer);

bindApp("get", "/public/apps/:slug/latest", handlePublicV2Latest);
bindApp("get", "/public/apps/:slug/channels", handlePublicListChannels);

// v2 endpoints with scope resolution (publish-architecture §5.4).
bindApp("get", "/public/v2/apps/:slug/latest", handlePublicV2Latest);
bindApp("get", "/public/v2/apps/:slug/updates/check", handlePublicV2UpdateCheck);
bindApp("get", "/public/v2/apps/:slug/versions", handlePublicCliBinaryVersions);
bindApp("get", "/public/v2/apps/:slug/release-notes", handlePublicReleaseNotesJson);
bindApp("get", "/public/r2/:key", handlePublicR2Download);
// Internal signed R2 fetch (delta-patch container pulls source APKs by key).
bindApp("get", "/internal/r2/:key", handleInternalR2Download);
bindApp("get", "/electron/:slug/:channel/:file", handleElectronGenericAsset);
bindApp("get", "/dl/:slug/releases/:releaseId/:file", handleExternalReleaseDl);
bindApp("get", "/dl/:slug/:channel/:file", handleExternalLatestDl);
bindApp("get", "/share/:token/download", handlePublicReleaseShareDownload);
bindApp("get", "/share/:token", handlePublicReleaseShare);
bindApp("post", "/share/:token/unlock", handlePublicReleaseShareUnlock);
bindApp("get", "/share/:token/icon", handlePublicReleaseShareIcon);
bindApp("post", "/public/v2/apps/:slug/feedback", handlePublicFeedbackSubmit);
bindApp("post", "/public/v2/apps/:slug/minidump", handlePublicMinidumpSubmit);
bindApp("post", "/public/v2/apps/:slug/devices", handleDeviceRegister);
bindApp("post", "/public/v2/apps/:slug/metrics", handleDeviceRegister);
bindApp("post", "/public/v2/apps/:slug/sessions", handleSessionEvent);
bindApp("post", "/public/v2/apps/:slug/feedback/presign", handlePresignFeedbackAttachments);
bindApp("put", "/public/v2/apps/:slug/feedback/multipart/part", handleFeedbackMultipartPart);
bindApp("post", "/public/v2/apps/:slug/feedback/multipart/complete", handleCompleteFeedbackMultipart);
bindApp("post", "/public/v2/apps/:slug/feedback/multipart/abort", handleAbortFeedbackMultipart);
app.openapi(openapiLookup(feedbackRoutes, "listReporter"), handleListReporterFeedback as any);
app.openapi(openapiLookup(feedbackRoutes, "mintReporterSession"), handleMintReporterSession as any);
app.openapi(openapiLookup(feedbackRoutes, "bindReporterRouteSubject"), handleBindReporterRouteSubject as any);
app.openapi(openapiLookup(feedbackRoutes, "getReporter"), handleGetReporterFeedback as any);
// This route accepts both JSON and multipart. Use the shared mixed-body
// dispatcher so JSON validators do not run against multipart input. The
// handler authenticates and validates either representation itself.
bindApp("post", "/api/apps/:appId/reporter-feedback/:ticketId/comments", handleAddReporterComment);
app.openapi(openapiLookup(feedbackRoutes, "closeReporter"), handleCloseReporterFeedback as any);
app.openapi(openapiLookup(feedbackRoutes, "downloadReporterAttachment"), handleDownloadReporterAttachment as any);

bindApp("get", "/public/apps/:slug/icon", handlePublicAppIcon);
bindApp("get", "/apps/:slug/history", handlePublicAppHistory);
bindApp("get", "/apps/:slug/history/:releaseId/download", handlePublicAppHistoryDownload);
bindApp("get", "/apps/:slug/latest", handlePublicLatestReleaseLanding);
bindApp("get", "/apps/:slug/latest/download", handlePublicLatestReleaseDownload);
// Version-pinned landing (`/apps/raft-android/v/1.12.0`). The fixed `v`
// segment keeps it clear of console SPA routes (`/apps/:appId/<tab>`).
bindApp("get", "/apps/:slug/v/:version{[0-9A-Za-z._+-]{1,64}}", handlePublicVersionLanding);
bindApp("get", "/notes/:slug", handlePublicReleaseNotes);
bindApp("get", "/api/invites/:token", handleGetInvite);

function isWorkerRoute(pathname: string): boolean {
  return pathname === "/health" ||
    pathname === "/openapi.json" ||
    pathname === "/api-docs" ||
    pathname === "/docs" ||
    pathname === "/login/raft/callback" ||
    pathname === "/login/raft/installer/callback" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/electron/") ||
    pathname.startsWith("/public/") ||
    pathname.startsWith("/share/") ||
    pathname.startsWith("/docs/") ||
    pathname.startsWith("/.well-known/");
}

app.use("*", async (c, next) => {
  if ((c.req.method === "GET" || c.req.method === "HEAD") && !isWorkerRoute(new URL(c.req.url).pathname)) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return next();
});

// Admin — protected by a Hands JWT or scoped deploy-token bearer auth.
// Exported so tests can enumerate the real route table rather than pattern-match
// the source: coverage should be decided by the router, not by whether a regex
// recognises a particular registration style.
export const admin = new OpenAPIHono<{
  Bindings: Env;
  Variables: {
    admin_account?: import("./middleware/auth").AdminAccount;
    admin_deploy_token?: import("./lib/deploy_tokens").AppDeployToken;
    admin_actor?: string;
    org_id?: string;
    org_role?: "owner" | "admin" | "member" | "viewer";
  };
}>({
  defaultHook: (result, c) => {
    if (!result.success) {
      // ZodError#message is a serialized JSON array of issues; surface a
      // human-readable path:message summary instead.
      const detail = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return c.json({ error: "invalid request", detail }, 400);
    }
  },
});
admin.use("*", authMiddleware);

// Agent CLI login (RFC 057) action — needs the authenticated agent session so it
// binds the grant to the pre-org-switch identity. Exchange/refresh are public.
bindAdmin("post", "/api/auth/agent/login", handleAgentLoginAction);

// Global Hands observability is server-admin scoped, not app-role scoped.
admin.use("/api/admin/observability/*", requireHandsAdmin);
bindAdmin("get", "/api/admin/observability/overview", handleHandsAdminOverview);

// Global error handler: surface unhandled exceptions as JSON instead of
// Hono's default empty "Internal Server Error" body. This makes every
// admin endpoint behave consistently when something downstream (D1 / R2 /
// Container / Access) throws, instead of forcing operators to read
// wrangler tail to figure out what went wrong.
admin.onError((err, c) => {
  console.error(
    `[admin ${c.req.method} ${c.req.path}] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  return c.json(
    {
      error: "internal server error",
      detail: err instanceof Error ? err.message : String(err),
    },
    500,
  );
});

// Container build readback. The deploy pipeline has no container probe at all: it passes
// --containers-rollout and prints the value, so "the workflow went green" has been the
// only evidence that a rebuilt image is serving. This route is the instrument for the
// container-side criterion - read it before and after a rollout.
//
// `build` comes from the container's own /health. On the image running today that key
// does not exist, so *key absent* means the old image is still serving and *key present*
// means the new one is - the old image cannot fabricate a key its code never emits, which
// rules out "the probe passed but hit the old image".
//
// Admin-gated on purpose. The exact deployed commit narrows a public repository's tree to
// one revision for anyone asking which known issues currently apply, and this readback is
// run by operators, not by clients.
bindAdmin("get", "/api/admin/container/build", async (c) => {
  const container = await getRandom(c.env.APK_PARSER, 1);
  const res = await container.fetch(new Request("http://container/health"));
  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Surface the raw body rather than a parse error: a container that answers with
    // something unparseable is a different failure from one that does not answer, and
    // collapsing them is how "no result" starts reading like "clean result".
    return c.json({ ok: false, status: res.status, raw: body.slice(0, 512) }, 502);
  }
  const build =
    typeof parsed === "object" && parsed !== null && "build" in parsed
      ? (parsed as { build?: unknown }).build
      : undefined;
  // How to read the response. `stamped` alone does not answer "is the old image still
  // serving", and the shorthand is what people quote:
  //
  //   ok:true   status:200  stamped:false  -> the old image is serving
  //   ok:false  status:5xx  stamped:false  -> the container answered but is unhealthy;
  //                                           NOT MEASURED, not a statement about which
  //                                           image is up
  //   (unreachable container throws, so there is no `stamped` field at all)
  //
  // Anything other than the first line is "not measured". Separating "could not read"
  // from "read an unstamped image" is the entire reason this endpoint exists, and the
  // separation is undone the moment someone reads one field instead of three.
  //
  // `stamped:true` needs no such qualification, and deliberately does not get one for
  // symmetry: the running image has no code that emits `build`, so a true cannot be
  // produced by anything except a rebuilt image.
  return c.json({
    ok: res.ok,
    status: res.status,
    // null, not omitted: an absent key here would be indistinguishable from this route
    // having failed to read one, which is the exact confusion the stamp exists to end.
    build: typeof build === "string" ? build : null,
    stamped: typeof build === "string",
  });
});

bindAdmin("get", "/api/orgs", handleListOrgs);
bindAdmin("get", "/api/orgs/:orgId/members", requireOrgRole("orgId", "viewer"), handleListOrgMembers);
bindAdmin("patch", "/api/orgs/:orgId/members/:accountId", requireOrgRole("orgId", "admin"), handleUpdateOrgMember);
bindAdmin("delete", "/api/orgs/:orgId/members/:accountId", requireOrgRole("orgId", "admin"), handleRemoveOrgMember);
bindAdmin("get", "/api/orgs/:orgId/invites", requireOrgRole("orgId", "admin"), handleListOrgInvites);
bindAdmin("post", "/api/orgs/:orgId/invites", requireOrgRole("orgId", "admin"), handleCreateOrgInvite);
bindAdmin("post", "/api/orgs/:orgId/invites/:inviteId/resend", requireOrgRole("orgId", "admin"), handleResendOrgInvite);
bindAdmin("delete", "/api/orgs/:orgId/invites/:inviteId", requireOrgRole("orgId", "admin"), handleRevokeOrgInvite);
bindAdmin("get", "/api/orgs/:orgId/audit-logs", requireOrgRole("orgId", "member"), handleListOrgAuditLogs);

// Webhooks (P2.5.8)
bindAdmin("get", "/api/orgs/:orgId/webhooks", requireOrgRole("orgId", "admin"), handleListWebhooks);
bindAdmin("post", "/api/orgs/:orgId/webhooks", requireOrgRole("orgId", "admin"), handleCreateWebhook);
bindAdmin("patch", "/api/orgs/:orgId/webhooks/:webhookId", requireOrgRole("orgId", "admin"), handleUpdateWebhook);
bindAdmin("delete", "/api/orgs/:orgId/webhooks/:webhookId", requireOrgRole("orgId", "admin"), handleDeleteWebhook);
bindAdmin("get", "/api/orgs/:orgId/webhooks/:webhookId/deliveries", requireOrgRole("orgId", "admin"), handleListDeliveries);
bindAdmin("get", "/api/apps/:appId/webhooks", requireAppRole("admin"), handleListAppWebhooks);
bindAdmin("post", "/api/apps/:appId/webhooks", requireAppRole("admin"), handleCreateAppWebhook);
bindAdmin("patch", "/api/apps/:appId/webhooks/:webhookId", requireAppRole("admin"), handleUpdateAppWebhook);
bindAdmin("delete", "/api/apps/:appId/webhooks/:webhookId", requireAppRole("admin"), handleDeleteAppWebhook);
bindAdmin("get", "/api/apps/:appId/webhooks/:webhookId/deliveries", requireAppRole("admin"), handleListAppWebhookDeliveries);

// Scheduled reaper (no auth — Worker Cron Trigger schedules `scheduled()` in exports)
// bindApp("get", "/api/webhook-reaper", handleReapDeliveries);  // removed; use scheduled() instead

bindAdmin("post", "/api/invites/:token/accept", handleAcceptInvite);

bindAdmin("get", "/api/apps", requireCurrentOrgRole("viewer"), handleListApps);
bindAdmin("post", "/api/apps", requireCurrentOrgRole("member"), handleCreateApp);
bindAdmin("post", "/api/apps/:appId/transfer", requireAppRole("admin"), handleTransferApp);
bindAdmin("get", "/api/apps/:appId", requireAppRole("viewer"), handleGetApp);
bindAdmin("patch", "/api/apps/:appId", requireAppRole("admin"), handleUpdateApp);
bindAdmin("post", "/api/apps/:appId/archive", requireAppRole("admin"), handleArchiveApp);
bindAdmin("post", "/api/apps/:appId/purge", requireAppRole("admin"), handlePurgeApp);
bindAdmin("get", "/api/apps/:appId/feature-flags/:key", requireAppRole("viewer"), handleGetFeatureFlag);
bindAdmin("get", "/api/apps/:appId/reporter-feedback-metadata", requireAppRole("viewer"), handleGetReporterRouteMetadata);
bindAdmin("put", "/api/apps/:appId/reporter-integrations/:integrationId/webhooks/:webhookId",
  requireAppRole("admin"),
  handleBindReporterWebhook,
);
// Feature flags are rollout controls (like bump-rollout / force-update), so they
// sit at the publisher (ship) tier rather than admin.
bindAdmin("put", "/api/apps/:appId/feature-flags/:key", requireAppRole("publisher"), handleUpdateFeatureFlag);

bindAdmin("get", "/api/apps/:appId/builds", requireAppRole("viewer"), handleListBuilds);
bindAdmin("post", "/api/apps/:appId/builds", requireAppRole("publisher"), handleCreateBuild);
bindAdmin("post", "/api/apps/:appId/builds/publish-version",
  requireAppRole("publisher"),
  handlePublishExternalBuildVersion,
);
bindAdmin("get", "/api/apps/:appId/builds/:buildId", requireAppRole("viewer"), handleGetBuild);
bindAdmin("patch", "/api/apps/:appId/builds/:buildId", requireAppRole("publisher"), handleUpdateBuild);
bindAdmin("delete", "/api/apps/:appId/builds/:buildId", requireAppRole("admin"), handleDeleteBuild);
bindAdmin("get", "/api/apps/:appId/builds/:buildId/assets", requireAppRole("viewer"), handleListBuildAssets);
bindAdmin("get", "/api/apps/:appId/builds/:buildId/external-targets",
  requireAppRole("viewer"),
  handleListExternalBuildTargets,
);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/assets", requireAppRole("publisher"), handleCreateBuildAsset);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/assets/uploads",
  requireAppRole("publisher"),
  handleDeclareBuildAssetUpload,
  handleGetBuildAssetUpload,
);
bindAdmin("get", "/api/apps/:appId/builds/:buildId/assets/:assetId/upload", requireAppRole("publisher"), handleGetBuildAssetUpload);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/assets/:assetId/upload/complete",
  requireAppRole("publisher"),
  handleCompleteBuildAssetUpload,
);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/assets/:assetId/upload/abort",
  requireAppRole("publisher"),
  handleAbortBuildAssetUpload,
);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/hosted-migration",
  requireAppRole("publisher"),
  handleBeginHostedBuildMigration,
);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/hosted-migration/complete",
  requireAppRole("publisher"),
  handleCompleteHostedBuildMigration,
);
bindAdmin("get", "/api/apps/:appId/builds/:buildId/assets/:assetId/download",
  requireAppRole("viewer"),
  handleDownloadBuildAsset,
);
bindAdmin("delete", "/api/apps/:appId/builds/:buildId/assets/:assetId",
  requireAppRole("admin"),
  handleDeleteBuildAsset,
);

// QA-only iOS simulator artifacts. These are immutable exact-byte fixtures
// for agent/device validation and are deliberately outside the release model.
bindAdmin("get", "/api/apps/:appId/qa-artifacts/ios-simulator",
  requireAppRole("viewer"),
  handleListIosSimulatorArtifacts,
);
bindAdmin("post", "/api/apps/:appId/qa-artifacts/ios-simulator",
  requireAppRole("publisher"),
  handleCreateIosSimulatorArtifact,
);
bindAdmin("get", "/api/apps/:appId/qa-artifacts/ios-simulator/:assetId",
  requireAppRole("viewer"),
  handleGetIosSimulatorArtifact,
);
bindAdmin("post", "/api/apps/:appId/qa-artifacts/ios-simulator/:assetId/complete",
  requireAppRole("publisher"),
  handleCompleteIosSimulatorArtifact,
);
bindAdmin("get", "/api/apps/:appId/qa-artifacts/ios-simulator/:assetId/download",
  requireAppRole("viewer"),
  handleDownloadIosSimulatorArtifact,
);

// Mobile CI declares one Android release build with exactly one AAB and one
// APK. The pair is sealed independently but becomes ready only as one bundle.
bindAdmin("post", "/api/apps/:appId/android-release-artifacts",
  requireAppRole("publisher"),
  handleCreateAndroidReleaseArtifacts,
);
bindAdmin("get", "/api/apps/:appId/android-release-artifacts/:buildId",
  requireAppRole("viewer"),
  handleGetAndroidReleaseArtifacts,
);
bindAdmin("post", "/api/apps/:appId/android-release-artifacts/:buildId/assets/:assetId/complete",
  requireAppRole("publisher"),
  handleCompleteAndroidReleaseArtifact,
);

bindAdmin("get", "/api/apps/:appId/releases", requireAppRole("viewer"), handleListReleases);
bindAdmin("post", "/api/apps/:appId/releases", requireAppRole("publisher"), handleCreateRelease);
bindAdmin("post", "/api/apps/:appId/releases/draft", requireAppRole("publisher"), handleCreateReleaseDraft);
bindAdmin("get", "/api/apps/:appId/releases/:releaseId", requireAppRole("viewer"), handleGetRelease);
bindAdmin("patch", "/api/apps/:appId/releases/:releaseId", requireAppRole("publisher"), handleUpdateRelease);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/publish", requireAppRole("publisher"), handlePublishRelease);
// Release human-approval queue (task #239): list pending approvals, and approve /
// reject them. approve/reject additionally enforce human-only inside the handler.
bindAdmin("get", "/api/apps/:appId/release-approvals", requireAppRole("admin"), handleListReleaseApprovals);
bindAdmin("post", "/api/apps/:appId/release-approvals/:requestId/approve", requireAppRole("admin"), handleApproveReleaseApproval);
bindAdmin("post", "/api/apps/:appId/release-approvals/:requestId/reject", requireAppRole("admin"), handleRejectReleaseApproval);
bindAdmin("delete", "/api/apps/:appId/releases/:releaseId", requireAppRole("publisher"), handleDeleteRelease);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/rollback", requireAppRole("publisher"), handleRollbackRelease);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/bump-rollout", requireAppRole("publisher"), handleBumpRollout);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/force-update", requireAppRole("publisher"), handleForceUpdate);
bindAdmin("get", "/api/apps/:appId/releases/:releaseId/checks", requireAppRole("viewer"), handleListReleaseChecks);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/checks", requireAppRole("publisher"), handleUpsertReleaseCheck);
bindAdmin("get", "/api/apps/:appId/releases/:releaseId/distributions",
  requireAppRole("viewer"),
  handleListDistributions,
);
bindAdmin("get", "/api/apps/:appId/releases/:releaseId/distributions/play",
  requireAppRole("viewer"),
  handleGetPlayDistribution,
);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/distributions/play/promote",
  requireAppRole("publisher"),
  handlePromotePlayDistribution,
);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/distributions/play/halt",
  requireAppRole("publisher"),
  handleHaltPlayDistribution,
);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/distributions/play/rollback",
  requireAppRole("publisher"),
  handleRollbackPlayDistribution,
);
bindAdmin("get", "/api/apps/:appId/releases/:releaseId/receipts",
  requireAppRole("viewer"),
  handleListReleaseReceipts,
);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/receipts/acceptance",
  requireAppRole("publisher"),
  handleCreateAcceptanceReceipt,
);
bindAdmin("post", "/api/apps/:appId/google-play-oauth/start", requireAppRole("admin"), handleStartGooglePlayOAuth);
bindAdmin("get", "/api/google-play/oauth/callback", handleGooglePlayOAuthCallback);
bindAdmin("get", "/api/apps/:appId/google-play-binding", requireAppRole("admin"), handleGetGooglePlayBinding);
bindAdmin("put", "/api/apps/:appId/google-play-binding", requireAppRole("admin"), handlePutGooglePlayBinding);
bindAdmin("post", "/api/apps/:appId/google-play-binding/tracks", requireAppRole("admin"), handleListGooglePlayTracks);
bindAdmin("post", "/api/apps/:appId/google-play-binding/verify", requireAppRole("admin"), handleVerifyGooglePlayBinding);
bindAdmin("post", "/api/apps/:appId/google-play-binding/enable", requireAppRole("admin"), handleEnableGooglePlayBinding);
bindAdmin("post", "/api/apps/:appId/google-play-binding/disable", requireAppRole("admin"), handleDisableGooglePlayBinding);
bindAdmin("delete", "/api/apps/:appId/google-play-binding", requireAppRole("admin"), handleDeleteGooglePlayBinding);
bindAdmin("get", "/api/apps/:appId/shares", requireAppRole("viewer"), handleListAppShares);
bindAdmin("post", "/api/apps/:appId/shares/:shareId/rebind", requireAppRole("publisher"), handleRebindReleaseShare);
bindAdmin("put", "/api/apps/:appId/icon", requireAppRole("publisher"), handleUploadAppIcon);
bindAdmin("get", "/api/apps/:appId/client-key", requireAppRole("admin"), handleGetClientKey);
bindAdmin("post", "/api/apps/:appId/rotate-client-key", requireAppRole("admin"), handleRotateClientKey);
bindAdmin("get", "/api/apps/:appId/feedback/crash-groups", requireAppRole("viewer"), handleListCrashGroups);
bindAdmin("get", "/api/apps/:appId/feedback/stats", requireAppRole("viewer"), handleFeedbackStats);
bindAdmin("get", "/api/apps/:appId/analytics/devices", requireAppRole("viewer"), handleDeviceAnalytics);
bindAdmin("get", "/api/apps/:appId/analytics/versions", requireAppRole("viewer"), handleVersionAnalytics);
bindAdmin("get", "/api/apps/:appId/analytics/devices/:deviceId", requireAppRole("viewer"), handleDeviceDetail);
bindAdmin("get", "/api/apps/:appId/release-health", requireAppRole("viewer"), handleReleaseHealth);
bindAdmin("get", "/api/apps/:appId/feedback", requireAppRoleOrFeedbackPermission("viewer", {}, "feedback:read"), handleListFeedback);
bindAdmin("get", "/api/apps/:appId/feedback/material-delta", requireAppRoleOrFeedbackPermission("viewer", {}, "feedback:read"), handleListFeedbackMaterialDelta);
bindAdmin("get", "/api/apps/:appId/feedback/:ticketId", requireAppRoleOrFeedbackPermission("viewer", {}, "feedback:read"), handleGetFeedback);
bindAdmin("patch", "/api/apps/:appId/feedback/:ticketId", requireAppRoleOrFeedbackPermission("publisher", { orgMinimum: "member" }, "feedback:triage"), handleUpdateFeedback);
// Both actions share this endpoint; handleAddFeedbackComment splits them on `internal`.
bindAdmin("post", "/api/apps/:appId/feedback/:ticketId/comments", requireAppRoleOrFeedbackPermission("publisher", { orgMinimum: "member" }, "feedback:comment", "feedback:triage"), handleAddFeedbackComment);
bindAdmin("post", "/api/apps/:appId/feedback/:ticketId/symbolicate", requireFeedbackTriageRole(), handleResymbolicateFeedback);
bindAdmin("get", "/api/apps/:appId/feedback/:ticketId/attachments/:attachmentId",
  // An attachment is the substance of most crash reports; reading a ticket
  // without being able to fetch its screenshot is not "read feedback".
  requireAppRoleOrFeedbackPermission("viewer", {}, "feedback:read"),
  handleDownloadFeedbackAttachment,
);
bindAdmin("get", "/api/apps/:appId/releases/:releaseId/shares", requireAppRole("viewer"), handleListReleaseShares);
bindAdmin("post", "/api/apps/:appId/releases/:releaseId/shares", requireAppRole("publisher"), handleCreateReleaseShare);
bindAdmin("patch", "/api/apps/:appId/releases/:releaseId/shares/:shareId", requireAppRole("publisher"), handleUpdateReleaseShare);
bindAdmin("delete", "/api/apps/:appId/releases/:releaseId/shares/:shareId", requireAppRole("publisher"), handleRevokeReleaseShare);

// Multipart APK upload → R2 (admin only, validates + audits)
bindAdmin("post", "/api/apps/:appId/upload", requireAppRole("publisher"), handleUploadApk);

// Operation log + SSE stream (admin)
bindAdmin("get", "/api/apps/:appId/operations", requireAppRole("viewer"), handleListOperations);
bindAdmin("get", "/api/apps/:appId/operations/stream", requireAppRole("viewer"), handleStreamOperations);
bindAdmin("get", "/api/apps/:appId/operations/:opId", requireAppRole("viewer"), handleGetOperation);
bindAdmin("post", "/api/apps/:appId/operations/:opId/retry", requireAppRole("publisher"), handleRetryOperation);
bindAdmin("delete", "/api/apps/:appId/operations/:opId", requireAppRole("admin"), handleDeleteOperation);

// Parse APK: write to R2, ask container to parse via exec(), return metadata
bindAdmin("post", "/api/parse-apk", requireCurrentOrgRole("member"), async (c) => {
  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (ab.byteLength > 200 * 1024 * 1024) {
    return c.json({ error: "APK too large (>200MB)" }, 413);
  }

  // Record operation log entry (start as in_progress).
  // NOTE: app_id is NULL for parse — parse runs before the user picks an app
  // (it's the very first step in the Upload dialog flow). operation_logs
  // app_id is nullable (migration 0003).
  const op = await createOperation(c.env.DB, {
    app_id: null,
    kind: "parse",
    actor: currentActor(c),
    input: JSON.stringify({ size_bytes: ab.byteLength }),
  });
  await updateOperation(c.env.DB, op.id, {
    status: "in_progress",
    progress: 0.1,
  });

  // 1. Compute hash and upload to a temp location in R2
  const bytes = new Uint8Array(ab);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const fileHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const tmpKey = `tmp/parse/${fileHash}.apk`;
  await c.env.APK_BUCKET.put(tmpKey, bytes, {
    httpMetadata: {
      contentType: "application/vnd.android.package-archive",
    },
  });

  await updateOperation(c.env.DB, op.id, { progress: 0.4 });

  // 2. Forward to container
  const container = await getRandom(c.env.APK_PARSER, 1);
  const fakeRequest = new Request("http://container/parse", {
    method: "POST",
    body: ab,
    headers: { "content-type": "application/octet-stream" },
  });
  try {
    const res = await container.fetch(fakeRequest);
    const text = await res.text();
    if (!res.ok) {
      console.error(
        `[parse-apk] container returned ${res.status}: ${text.slice(0, 500)}`,
      );
      await updateOperation(c.env.DB, op.id, {
        status: "failed",
        error: text.slice(0, 500),
        progress: 1,
        completed_at: Date.now(),
      });
      return c.json(
        {
          error: "parse failed",
          container_status: res.status,
          detail: text.slice(0, 500),
        },
        500,
      );
    }
    const metadata = JSON.parse(text);
    metadata.size_bytes = ab.byteLength;
    metadata.file_hash_sha256 = fileHash;
    c.env.APK_BUCKET.delete(tmpKey).catch(() => {});

    await updateOperation(c.env.DB, op.id, {
      status: "success",
      progress: 1,
      output: JSON.stringify(metadata),
      completed_at: Date.now(),
    });

    return c.json(metadata);
  } catch (err) {
    console.error(
      `[parse-apk] unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
    await updateOperation(c.env.DB, op.id, {
      status: "failed",
      error: (err as Error).message,
      progress: 1,
      completed_at: Date.now(),
    });
    // Return JSON error instead of letting Hono's default handler return
    // empty "Internal Server Error" — this is what masked the real cause
    // of the upload-500 bug for hours.
    return c.json(
      {
        error: "parse failed",
        detail: (err as Error).message,
      },
      500,
    );
  }
});

bindAdmin("get", "/api/apps/:appId/channels", requireAppRole("viewer"), handleListChannels);
bindAdmin("post", "/api/apps/:appId/channels", requireAppRole("admin"), handleCreateChannel);
bindAdmin("patch", "/api/apps/:appId/channels/:channelId", requireAppRole("admin"), handleUpdateChannel);
bindAdmin("delete", "/api/apps/:appId/channels/:channelId", requireAppRole("admin"), handleDeleteChannel);

bindAdmin("get", "/api/apps/:appId/device-groups", requireAppRole("publisher"), handleListDeviceGroups);
bindAdmin("post", "/api/apps/:appId/device-groups", requireAppRole("publisher"), handleCreateDeviceGroup);
bindAdmin("patch", "/api/apps/:appId/device-groups/:groupId", requireAppRole("publisher"), handleUpdateDeviceGroup);
bindAdmin("delete", "/api/apps/:appId/device-groups/:groupId", requireAppRole("publisher"), handleDeleteDeviceGroup);
bindAdmin("post", "/api/apps/:appId/device-groups/:groupId/members",
  requireAppRole("publisher"),
  handleAddDeviceGroupMember,
);
bindAdmin("delete", "/api/apps/:appId/device-groups/:groupId/members/:deviceId",
  requireAppRole("publisher"),
  handleRemoveDeviceGroupMember,
);

bindAdmin("get", "/api/apps/:appId/product-types", requireAppRole("viewer"), handleListProductTypes);
bindAdmin("post", "/api/apps/:appId/product-types", requireAppRole("admin"), handleCreateProductType);
bindAdmin("patch", "/api/apps/:appId/product-types/:ptId", requireAppRole("admin"), handleUpdateProductType);
bindAdmin("delete", "/api/apps/:appId/product-types/:ptId", requireAppRole("admin"), handleDeleteProductType);

bindAdmin("get", "/api/apps/:appId/release-types", requireAppRole("viewer"), handleListReleaseTypes);
bindAdmin("post", "/api/apps/:appId/release-types", requireAppRole("admin"), handleCreateReleaseType);
bindAdmin("patch", "/api/apps/:appId/release-types/:rtId", requireAppRole("admin"), handleUpdateReleaseType);
bindAdmin("delete", "/api/apps/:appId/release-types/:rtId", requireAppRole("admin"), handleDeleteReleaseType);

bindAdmin("get", "/api/apps/:appId/audit-logs", requireAppRole("viewer"), handleListAuditLogs);

// Per-user scoped audit (cross-app within orgs the caller is in).
bindAdmin("get", "/api/users/:accountId/audit", handleListUserAudit);
bindAdmin("get", "/api/apps/:appId/members", requireAppRole("viewer"), handleListAppMembers);
bindAdmin("post", "/api/apps/:appId/members", requireAppRole("admin"), handleAddAppMember);
bindAdmin("patch", "/api/apps/:appId/members/:accountId", requireAppRole("admin"), handleUpdateAppMember);
bindAdmin("delete", "/api/apps/:appId/members/:accountId", requireAppRole("admin"), handleRemoveAppMember);
bindAdmin("get", "/api/apps/:appId/server-grants", requireAppRole("viewer"), handleListAppServerGrants);
bindAdmin("post", "/api/apps/:appId/server-grants", requireAppRole("admin"), handleAddAppServerGrant);
bindAdmin("patch", "/api/apps/:appId/server-grants/:serverId", requireAppRole("admin"), handleUpdateAppServerGrant);
bindAdmin("delete", "/api/apps/:appId/server-grants/:serverId", requireAppRole("admin"), handleRemoveAppServerGrant);
bindAdmin("get", "/api/apps/:appId/deploy-tokens", requireAppRole("admin"), handleListAppDeployTokens);
bindAdmin("get", "/api/app-permissions", handleGetAppPermissionModel);
bindAdmin("post", "/api/apps/:appId/deploy-tokens", requireAppRole("admin"), handleCreateAppDeployToken);
bindAdmin("delete", "/api/apps/:appId/deploy-tokens/:tokenId", requireAppRole("admin"), handleRevokeAppDeployToken);
bindAdmin("get", "/api/apps/:appId/reporter-integrations", requireAppRole("admin"), handleListReporterIntegrations);
bindAdmin("post", "/api/apps/:appId/reporter-integrations", requireAppRole("admin"), handleCreateReporterIntegration);
bindAdmin("patch", "/api/apps/:appId/reporter-integrations/:integrationId",
  requireAppRole("admin"),
  handleUpdateReporterIntegration,
);

// App Store Connect API credentials (for Hands-orchestrated TestFlight uploads).
bindAdmin("get", "/api/apps/:appId/asc-credentials", requireAppRole("admin"), handleGetAscCredentials);
bindAdmin("post", "/api/apps/:appId/asc-credentials/verify", requireAppRole("admin"), handleVerifyAscCredentials);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/testflight-upload", requireAppRole("admin"), handleTestflightUpload);
bindAdmin("get", "/api/apps/:appId/testflight-uploads/:buildUploadId", requireAppRole("viewer"), handleTestflightUploadStatus);
bindAdmin("get", "/api/apps/:appId/builds/:buildId/testflight-groups", requireAppRole("viewer"), handleListTestflightGroups);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/testflight-expire", requireAppRole("admin"), handleTestflightExpire);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/testflight-publish", requireAppRole("publisher"), handleTestflightPublish);
bindAdmin("get", "/api/apps/:appId/builds/:buildId/testflight-publish", requireAppRole("viewer"), handleTestflightPublishStatus);
bindAdmin("get", "/api/apps/:appId/appstore-review", requireAppRole("viewer"), handleAppStoreReview);
bindAdmin("get", "/api/apps/:appId/testflight-beta-app-description",
  requireAppRole("viewer"),
  handleGetBetaAppDescription,
);
bindAdmin("put", "/api/apps/:appId/testflight-beta-app-description",
  requireAppRole("publisher"),
  handleUpdateBetaAppDescription,
);
bindAdmin("get", "/api/apps/:appId/testflight-feedback", requireAppRole("viewer"), handleListTestflightFeedback);
// Closing deletes the submission in App Store Connect: same bar as feedback triage.
bindAdmin("delete", "/api/apps/:appId/testflight-crashes/:submissionId",
  requireAppRoleOrFeedbackPermission("publisher", { orgMinimum: "member" }, "feedback:triage"),
  handleCloseTestflightCrash,
);
bindAdmin("delete", "/api/apps/:appId/testflight-feedback/:submissionId",
  requireAppRoleOrFeedbackPermission("publisher", { orgMinimum: "member" }, "feedback:triage"),
  handleCloseTestflightFeedback,
);
bindAdmin("get", "/api/apps/:appId/testflight-crashes", requireAppRole("viewer"), handleListTestflightCrashes);
bindAdmin("get", "/api/apps/:appId/testflight-crashes/:submissionId/log",
  requireAppRole("viewer"),
  handleGetTestflightCrashLog,
);
bindAdmin("get", "/api/apps/:appId/appgallery-review", requireAppRole("viewer"), handleAppGalleryReview);
bindAdmin("put", "/api/apps/:appId/asc-credentials", requireAppRole("admin"), handleSetAscCredentials);
bindAdmin("delete", "/api/apps/:appId/asc-credentials", requireAppRole("admin"), handleDeleteAscCredentials);
// AppGallery Connect Service Account and legacy API client credentials for OHOS publishing.
bindAdmin("get", "/api/apps/:appId/agc-credentials", requireAppRole("admin"), handleGetAgcCredentials);
bindAdmin("put", "/api/apps/:appId/agc-credentials", requireAppRole("admin"), handleSetAgcCredentials);
bindAdmin("delete", "/api/apps/:appId/agc-credentials", requireAppRole("admin"), handleDeleteAgcCredentials);
bindAdmin("post", "/api/apps/:appId/agc-credentials/verify", requireAppRole("admin"), handleVerifyAgcCredentials);
bindAdmin("get", "/api/apps/:appId/agc-test-groups", requireAppRole("admin"), handleListAgcTestGroups);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/agc-market-package", requireAppRole("admin"), handleUploadAgcMarketPackage);
bindAdmin("get", "/api/apps/:appId/builds/:buildId/agc-market-package", requireAppRole("admin"), handleGetAgcMarketPackage);
bindAdmin("get", "/api/apps/:appId/builds/:buildId/agc-invitation-test", requireAppRole("admin"), handleGetAgcBuildSubmission);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/agc-invitation-test", requireAppRole("admin"), handleStartAgcInvitationTest);
bindAdmin("get", "/api/apps/:appId/agc-submissions/:submissionId", requireAppRole("admin"), handleGetAgcSubmission);
bindAdmin("post", "/api/apps/:appId/agc-submissions/:submissionId/submit", requireAppRole("admin"), handleSubmitAgcInvitationTest);
bindAdmin("post", "/api/apps/:appId/builds/:buildId/generate-delta-patches",
  requireAppRole("publisher"),
  handleGenerateDeltaPatches,
);
// delta-sources is a read-only listing; align it with every other GET at viewer.
bindAdmin("get", "/api/apps/:appId/delta-sources", requireAppRole("viewer"), handleDeltaSources);

bindAdmin("post", "/api/apps/:appId/apple-webhook", requireAppRole("admin"), handleCreateAppleWebhook);
bindAdmin("get", "/api/apps/:appId/apple-webhook", requireAppRole("admin"), handleGetAppleWebhook);
bindAdmin("delete", "/api/apps/:appId/apple-webhook", requireAppRole("admin"), handleDeleteAppleWebhook);
bindAdmin("post", "/api/apps/:appId/apple-webhook/register", requireAppRole("admin"), handleRegisterAppleWebhook);
app.route("/", admin);

// ============================================================================
// Scheduled handler — Worker Cron Trigger (every 5 min)
// Reaps pending webhook deliveries and POSTs them to subscriber URLs.
// ============================================================================

export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const reaperStartedAt = Date.now();
  const reaper = reapWebhookDeliveries(env, {
    scheduledTime: controller.scheduledTime,
  }).then((summary) => {
    // Deliberately metadata-only: never log a subscriber URL, request body,
    // response body, signing secret, event id, or delivery id.
    console.info("hands_webhook_reaper_summary", JSON.stringify(summary));
  }).catch((error) => {
    console.error("hands_webhook_reaper_summary", JSON.stringify({
      scheduledTime: controller.scheduledTime,
      selected: 0,
      succeeded: 0,
      retried: 0,
      terminalized: 0,
      durationMs: Math.max(0, Date.now() - reaperStartedAt),
      errorCodes: { reaper_unhandled: 1 },
    }));
    throw error;
  });
  ctx.waitUntil(Promise.all([
    reaper,
    cleanupReporterFeedbackData(env),
    cleanupExpiredBuildAssetUploads(env),
  ]).then(() => undefined));
}

// The Workers runtime only looks at the default export for handlers: a bare
// Hono app provides fetch but silently drops the cron trigger and queue
// consumer (`scheduled`/`queue` as named exports are never invoked). Export
// all three explicitly.
export default {
  fetch: app.fetch,
  scheduled,
  queue: handleWebhookQueue,
};
