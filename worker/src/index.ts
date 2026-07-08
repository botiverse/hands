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
import type { Context } from "hono";
import { cors } from "hono/cors";

import { authMiddleware, currentActor } from "./middleware/auth";
import {
  handleAgentManifest,
  handleAuthConfig,
  handleAuthLogin,
  handleAuthLogout,
  handleAuthMe,
  handleRaftCallback,
} from "./routes/auth";
import {
  handleListApps,
  handleCreateApp,
  handleGetApp,
  handleArchiveApp,
  handlePurgeApp,
  handleUpdateApp,
  handleUploadAppIcon,
  handlePublicAppIcon,
  handleGetClientKey,
  handleRotateClientKey,
} from "./routes/apps";
import {
  handlePublicListChannels,
} from "./routes/public";
import {
  handlePublicR2Download,
  handlePublicV2Latest,
  handlePublicV2UpdateCheck,
} from "./routes/public_v2";
import { handleElectronGenericAsset } from "./routes/electron";
import {
  handleCreateReleaseShare,
  handleListReleaseShares,
  handlePublicReleaseShareDownload,
  handlePublicReleaseShare,
  handleRevokeReleaseShare,
  handleUpdateReleaseShare,
  handleListAppShares,
  handlePublicReleaseShareUnlock,
  handlePublicReleaseShareIcon,
} from "./routes/shares";
import {
  handlePublicFeedbackSubmit,
  handlePublicMinidumpSubmit,
  handleListFeedback,
  handleGetFeedback,
  handleUpdateFeedback,
  handleAddFeedbackComment,
  handleDownloadFeedbackAttachment,
  handleListCrashGroups,
  handleFeedbackStats,
  handlePresignFeedbackAttachments,
} from "./routes/feedback";
import { handleDeviceRegister, handleDeviceAnalytics, handleDeviceDetail } from "./routes/analytics";
import {
  handlePublicAppHistory,
  handlePublicAppHistoryDownload,
  handlePublicReleaseNotes,
  handlePublicReleaseNotesJson,
} from "./routes/history";
import {
  handleCreateAppDeployToken,
  handleListAppDeployTokens,
  handleRevokeAppDeployToken,
} from "./routes/deploy_tokens";
import { handleUploadApk } from "./routes/upload";
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
  handleListBuildAssets,
  handleListBuilds,
  handleUpdateBuild,
} from "./routes/builds";
import {
  handleBumpRollout,
  handleCreateRelease,
  handleDeleteRelease,
  handleForceUpdate,
  handleGetRelease,
  handleListReleases,
  handlePublishRelease,
  handleRollbackRelease,
  handleUpdateRelease,
} from "./routes/releases";
import { handleListChannels, handleCreateChannel, handleUpdateChannel, handleDeleteChannel } from "./routes/channels";
import { handleListProductTypes, handleCreateProductType, handleUpdateProductType, handleDeleteProductType } from "./routes/product_types";
import { handleListReleaseTypes, handleCreateReleaseType, handleUpdateReleaseType, handleDeleteReleaseType } from "./routes/release_types";
import { handleListAuditLogs, handleListUserAudit } from "./routes/audit";
import {
  handleCreateWebhook,
  handleDeleteWebhook,
  handleListDeliveries,
  handleListWebhooks,
  handleReapDeliveries,
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
  requireCurrentOrgRole,
  requireOrgRole,
} from "./lib/permissions";
import { openApiDocument } from "./openapi";
import { httpsRedirectUrl, requestOrigin } from "./lib/origin";

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

const app = new Hono<{ Bindings: Env }>();

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

// Public — health check (no auth)
app.get("/health", handleHealth);
app.get("/.well-known/slock-agent-manifest.json", handleAgentManifest);
app.get("/.well-known/raft-agent-manifest.json", handleAgentManifest);
app.get("/openapi.json", (c) => c.json({
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
app.get("/api-docs", (c) => c.html(`<!doctype html>
<html lang="en">
  <head>
    <title>Quiver API Reference</title>
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
      <a href="/" aria-label="Quiver home">
        <img src="/favicon.svg" alt="" />
        <span>Quiver</span>
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
const publicDocs = new Set([
  "/docs/",
  "/docs/agent-guide/",
  "/docs/admin-user-guide/",
  "/docs/android-sdk/",
  "/docs/ios-sdk/",
  "/docs/ohos-sdk/",
  "/docs/electron-sdk/",
  "/docs/cli-reference/",
  "/docs/agent-cli-feedback/",
  "/docs/public-api-reference/",
]);

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
  const normalizedPath = path.endsWith("/") ? path : `${path}/`;
  if (!publicDocs.has(normalizedPath)) {
    return c.text("Not found", 404);
  }
  return c.env.ASSETS.fetch(new Request(new URL(normalizedPath, c.req.url), c.req.raw));
}

app.get("/docs", handlePublicDocs);
app.get("/docs.md", handlePublicDocs);
app.get("/docs/*", handlePublicDocs);

app.get("/api/auth/config", handleAuthConfig);
app.get("/api/auth/login", handleAuthLogin);
app.get("/login/raft/callback", handleRaftCallback);
app.get("/api/auth/me", handleAuthMe);
app.post("/api/auth/logout", handleAuthLogout);

app.get("/public/apps/:slug/latest", handlePublicV2Latest);
app.get("/public/apps/:slug/channels", handlePublicListChannels);

// v2 endpoints with scope resolution (publish-architecture §5.4).
app.get("/public/v2/apps/:slug/latest", handlePublicV2Latest);
app.get("/public/v2/apps/:slug/updates/check", handlePublicV2UpdateCheck);
app.get("/public/v2/apps/:slug/release-notes", handlePublicReleaseNotesJson);
app.get("/public/r2/:key", handlePublicR2Download);
app.get("/electron/:slug/:channel/:file", handleElectronGenericAsset);
app.get("/share/:token/download", handlePublicReleaseShareDownload);
app.get("/share/:token", handlePublicReleaseShare);
app.post("/share/:token/unlock", handlePublicReleaseShareUnlock);
app.get("/share/:token/icon", handlePublicReleaseShareIcon);
app.post("/public/v2/apps/:slug/feedback", handlePublicFeedbackSubmit);
app.post("/public/v2/apps/:slug/minidump", handlePublicMinidumpSubmit);
app.post("/public/v2/apps/:slug/devices", handleDeviceRegister);
app.post("/public/v2/apps/:slug/feedback/presign", handlePresignFeedbackAttachments);
app.get("/public/apps/:slug/icon", handlePublicAppIcon);
app.get("/apps/:slug/history", handlePublicAppHistory);
app.get("/apps/:slug/history/:releaseId/download", handlePublicAppHistoryDownload);
app.get("/notes/:slug", handlePublicReleaseNotes);
app.get("/api/invites/:token", handleGetInvite);

function isWorkerRoute(pathname: string): boolean {
  return pathname === "/health" ||
    pathname === "/openapi.json" ||
    pathname === "/api-docs" ||
    pathname === "/docs" ||
    pathname === "/login/raft/callback" ||
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

// Admin — protected by Quiver's Login with Raft session cookie.
const admin = new Hono<{
  Bindings: Env;
  Variables: {
    admin_account?: import("./middleware/auth").AdminAccount;
    admin_deploy_token?: import("./lib/deploy_tokens").AppDeployToken;
    admin_actor?: string;
    org_id?: string;
    org_role?: "owner" | "admin" | "member" | "viewer";
  };
}>();
admin.use("*", authMiddleware);

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

admin.get("/api/orgs", handleListOrgs);
admin.get("/api/orgs/:orgId/members", requireOrgRole("orgId", "viewer"), handleListOrgMembers);
admin.patch("/api/orgs/:orgId/members/:accountId", requireOrgRole("orgId", "admin"), handleUpdateOrgMember);
admin.delete("/api/orgs/:orgId/members/:accountId", requireOrgRole("orgId", "admin"), handleRemoveOrgMember);
admin.get("/api/orgs/:orgId/invites", requireOrgRole("orgId", "admin"), handleListOrgInvites);
admin.post("/api/orgs/:orgId/invites", requireOrgRole("orgId", "admin"), handleCreateOrgInvite);
admin.post("/api/orgs/:orgId/invites/:inviteId/resend", requireOrgRole("orgId", "admin"), handleResendOrgInvite);
admin.delete("/api/orgs/:orgId/invites/:inviteId", requireOrgRole("orgId", "admin"), handleRevokeOrgInvite);
admin.get("/api/orgs/:orgId/audit-logs", requireOrgRole("orgId", "member"), handleListOrgAuditLogs);

// Webhooks (P2.5.8)
admin.get("/api/orgs/:orgId/webhooks", requireOrgRole("orgId", "admin"), handleListWebhooks);
admin.post("/api/orgs/:orgId/webhooks", requireOrgRole("orgId", "admin"), handleCreateWebhook);
admin.patch("/api/orgs/:orgId/webhooks/:webhookId", requireOrgRole("orgId", "admin"), handleUpdateWebhook);
admin.delete("/api/orgs/:orgId/webhooks/:webhookId", requireOrgRole("orgId", "admin"), handleDeleteWebhook);
admin.get("/api/orgs/:orgId/webhooks/:webhookId/deliveries", requireOrgRole("orgId", "admin"), handleListDeliveries);

// Scheduled reaper (no auth — Worker Cron Trigger schedules `scheduled()` in exports)
// app.get("/api/webhook-reaper", handleReapDeliveries);  // removed; use scheduled() instead

admin.post("/api/invites/:token/accept", handleAcceptInvite);

admin.get("/api/apps", requireCurrentOrgRole("viewer"), handleListApps);
admin.post("/api/apps", requireCurrentOrgRole("member"), handleCreateApp);
admin.get("/api/apps/:appId", requireAppRole("viewer"), handleGetApp);
admin.patch("/api/apps/:appId", requireAppRole("admin"), handleUpdateApp);
admin.post("/api/apps/:appId/archive", requireAppRole("admin"), handleArchiveApp);
admin.post("/api/apps/:appId/purge", requireAppRole("admin"), handlePurgeApp);

admin.get("/api/apps/:appId/builds", requireAppRole("viewer"), handleListBuilds);
admin.post("/api/apps/:appId/builds", requireAppRole("publisher"), handleCreateBuild);
admin.get("/api/apps/:appId/builds/:buildId", requireAppRole("viewer"), handleGetBuild);
admin.patch("/api/apps/:appId/builds/:buildId", requireAppRole("publisher"), handleUpdateBuild);
admin.delete("/api/apps/:appId/builds/:buildId", requireAppRole("admin"), handleDeleteBuild);
admin.get("/api/apps/:appId/builds/:buildId/assets", requireAppRole("viewer"), handleListBuildAssets);
admin.post("/api/apps/:appId/builds/:buildId/assets", requireAppRole("publisher"), handleCreateBuildAsset);
admin.get(
  "/api/apps/:appId/builds/:buildId/assets/:assetId/download",
  requireAppRole("viewer"),
  handleDownloadBuildAsset,
);
admin.delete(
  "/api/apps/:appId/builds/:buildId/assets/:assetId",
  requireAppRole("admin"),
  handleDeleteBuildAsset,
);

admin.get("/api/apps/:appId/releases", requireAppRole("viewer"), handleListReleases);
admin.post("/api/apps/:appId/releases", requireAppRole("publisher"), handleCreateRelease);
admin.get("/api/apps/:appId/releases/:releaseId", requireAppRole("viewer"), handleGetRelease);
admin.patch("/api/apps/:appId/releases/:releaseId", requireAppRole("publisher"), handleUpdateRelease);
admin.post("/api/apps/:appId/releases/:releaseId/publish", requireAppRole("publisher"), handlePublishRelease);
admin.delete("/api/apps/:appId/releases/:releaseId", requireAppRole("publisher"), handleDeleteRelease);
admin.post("/api/apps/:appId/releases/:releaseId/rollback", requireAppRole("publisher"), handleRollbackRelease);
admin.post("/api/apps/:appId/releases/:releaseId/bump-rollout", requireAppRole("publisher"), handleBumpRollout);
admin.post("/api/apps/:appId/releases/:releaseId/force-update", requireAppRole("publisher"), handleForceUpdate);
admin.get("/api/apps/:appId/shares", requireAppRole("viewer"), handleListAppShares);
admin.put("/api/apps/:appId/icon", requireAppRole("publisher"), handleUploadAppIcon);
admin.get("/api/apps/:appId/client-key", requireAppRole("admin"), handleGetClientKey);
admin.post("/api/apps/:appId/rotate-client-key", requireAppRole("admin"), handleRotateClientKey);
admin.get("/api/apps/:appId/feedback/crash-groups", requireAppRole("viewer"), handleListCrashGroups);
admin.get("/api/apps/:appId/feedback/stats", requireAppRole("viewer"), handleFeedbackStats);
admin.get("/api/apps/:appId/analytics/devices", requireAppRole("viewer"), handleDeviceAnalytics);
admin.get("/api/apps/:appId/analytics/devices/:deviceId", requireAppRole("viewer"), handleDeviceDetail);
admin.get("/api/apps/:appId/feedback", requireAppRole("viewer"), handleListFeedback);
admin.get("/api/apps/:appId/feedback/:ticketId", requireAppRole("viewer"), handleGetFeedback);
admin.patch("/api/apps/:appId/feedback/:ticketId", requireAppRole("publisher"), handleUpdateFeedback);
admin.post("/api/apps/:appId/feedback/:ticketId/comments", requireAppRole("publisher"), handleAddFeedbackComment);
admin.get("/api/apps/:appId/feedback/:ticketId/attachments/:attachmentId", requireAppRole("viewer"), handleDownloadFeedbackAttachment);
admin.get("/api/apps/:appId/releases/:releaseId/shares", requireAppRole("viewer"), handleListReleaseShares);
admin.post("/api/apps/:appId/releases/:releaseId/shares", requireAppRole("publisher"), handleCreateReleaseShare);
admin.patch("/api/apps/:appId/releases/:releaseId/shares/:shareId", requireAppRole("publisher"), handleUpdateReleaseShare);
admin.delete("/api/apps/:appId/releases/:releaseId/shares/:shareId", requireAppRole("publisher"), handleRevokeReleaseShare);

// Multipart APK upload → R2 (admin only, validates + audits)
admin.post("/api/apps/:appId/upload", requireAppRole("publisher"), handleUploadApk);

// Operation log + SSE stream (admin)
admin.get("/api/apps/:appId/operations", requireAppRole("viewer"), handleListOperations);
admin.get("/api/apps/:appId/operations/stream", requireAppRole("viewer"), handleStreamOperations);
admin.get("/api/apps/:appId/operations/:opId", requireAppRole("viewer"), handleGetOperation);
admin.post("/api/apps/:appId/operations/:opId/retry", requireAppRole("publisher"), handleRetryOperation);
admin.delete("/api/apps/:appId/operations/:opId", requireAppRole("admin"), handleDeleteOperation);

// Parse APK: write to R2, ask container to parse via exec(), return metadata
admin.post("/api/parse-apk", requireCurrentOrgRole("member"), async (c) => {
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

admin.get("/api/apps/:appId/channels", requireAppRole("viewer"), handleListChannels);
admin.post("/api/apps/:appId/channels", requireAppRole("admin"), handleCreateChannel);
admin.patch("/api/apps/:appId/channels/:channelId", requireAppRole("admin"), handleUpdateChannel);
admin.delete("/api/apps/:appId/channels/:channelId", requireAppRole("admin"), handleDeleteChannel);

admin.get("/api/apps/:appId/product-types", requireAppRole("viewer"), handleListProductTypes);
admin.post("/api/apps/:appId/product-types", requireAppRole("admin"), handleCreateProductType);
admin.patch("/api/apps/:appId/product-types/:ptId", requireAppRole("admin"), handleUpdateProductType);
admin.delete("/api/apps/:appId/product-types/:ptId", requireAppRole("admin"), handleDeleteProductType);

admin.get("/api/apps/:appId/release-types", requireAppRole("viewer"), handleListReleaseTypes);
admin.post("/api/apps/:appId/release-types", requireAppRole("admin"), handleCreateReleaseType);
admin.patch("/api/apps/:appId/release-types/:rtId", requireAppRole("admin"), handleUpdateReleaseType);
admin.delete("/api/apps/:appId/release-types/:rtId", requireAppRole("admin"), handleDeleteReleaseType);

admin.get("/api/apps/:appId/audit-logs", requireAppRole("viewer"), handleListAuditLogs);

// Per-user scoped audit (cross-app within orgs the caller is in).
admin.get("/api/users/:accountId/audit", handleListUserAudit);
admin.get("/api/apps/:appId/members", requireAppRole("viewer"), handleListAppMembers);
admin.post("/api/apps/:appId/members", requireAppRole("admin"), handleAddAppMember);
admin.patch("/api/apps/:appId/members/:accountId", requireAppRole("admin"), handleUpdateAppMember);
admin.delete("/api/apps/:appId/members/:accountId", requireAppRole("admin"), handleRemoveAppMember);
admin.get("/api/apps/:appId/server-grants", requireAppRole("viewer"), handleListAppServerGrants);
admin.post("/api/apps/:appId/server-grants", requireAppRole("admin"), handleAddAppServerGrant);
admin.patch("/api/apps/:appId/server-grants/:serverId", requireAppRole("admin"), handleUpdateAppServerGrant);
admin.delete("/api/apps/:appId/server-grants/:serverId", requireAppRole("admin"), handleRemoveAppServerGrant);
admin.get("/api/apps/:appId/deploy-tokens", requireAppRole("admin"), handleListAppDeployTokens);
admin.post("/api/apps/:appId/deploy-tokens", requireAppRole("admin"), handleCreateAppDeployToken);
admin.delete("/api/apps/:appId/deploy-tokens/:tokenId", requireAppRole("admin"), handleRevokeAppDeployToken);

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
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // Build a minimal Hono context for the reaper handler.
  const fakeC = {
    env,
    req: { param: () => ({}) },
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
  } as unknown as Parameters<typeof handleReapDeliveries>[0];
  ctx.waitUntil(handleReapDeliveries(fakeC));
}

export default app;
