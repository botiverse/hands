/**
 * quiver Worker entry
 *
 * Adapted from cloudflare/templates/containers-template (Hono + Containers pattern).
 * Extends with D1 (apps / versions / channels / audit_logs) and R2 (APK binaries + icons).
 */

import { Container, getRandom } from "@cloudflare/containers";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { authMiddleware } from "./middleware/auth";
import { handleListApps, handleCreateApp, handleGetApp } from "./routes/apps";
import {
  handlePublicGetLatestVersion,
  handlePublicListChannels,
} from "./routes/public";
import { handleUploadApk } from "./routes/upload";
import {
  handleListVersions,
  handleCreateVersion,
  handleGetVersion,
  handleUpdateVersion,
  handleDeleteVersion,
} from "./routes/versions";
import { handleListChannels, handleCreateChannel } from "./routes/channels";
import { handleListAuditLogs } from "./routes/audit";
import { handleHealth } from "./routes/health";

// ---------- Container binding (APK parser) ----------

export class ApkParserContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m";

  override onStart() {
    console.log("APK parser container started");
  }
  override onStop() {
    console.log("APK parser container stopped");
  }
  override onError(error: unknown) {
    console.log("APK parser container error:", error);
  }
}

// ---------- Hono app ----------

const app = new Hono<{ Bindings: Env }>();

// CORS for the admin UI hosted at quiver-admin.pages.dev (and any other
// pages.dev preview URLs). In production you'd lock this down further.
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (origin === "https://quiver-admin.pages.dev") return origin;
      if (origin === "http://localhost:5173") return origin;
      // Allow any *.quiver-admin.pages.dev preview URL
      if (/^https:\/\/[a-f0-9]+\.quiver-admin\.pages\.dev$/.test(origin)) {
        return origin;
      }
      return origin;
    },
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "authorization"],
    credentials: false,
  }),
);

// Public — health check (no auth)
app.get("/health", handleHealth);

// Public — list versions for download link generation (no auth, read-only metadata)
// NOTE: actual APK binary download goes via signed R2 URL, not through Worker
app.get("/api/apps/:appId/versions", handleListVersions);
app.get("/api/apps/:appId/versions/:versionId", handleGetVersion);

// Public — client-facing lookups by human-readable slug (no auth)
app.get("/public/apps/:slug/latest", handlePublicGetLatestVersion);
app.get("/public/apps/:slug/channels", handlePublicListChannels);

// Admin — protected by Cloudflare Access JWT or API Token
const admin = new Hono<{ Bindings: Env; Variables: { cf_email?: string; cf_jwt?: string } }>();
admin.use("*", authMiddleware);

admin.get("/api/apps", handleListApps);
admin.post("/api/apps", handleCreateApp);
admin.get("/api/apps/:appId", handleGetApp);

admin.post("/api/apps/:appId/versions", handleCreateVersion);
admin.patch("/api/apps/:appId/versions/:versionId", handleUpdateVersion);
admin.delete("/api/apps/:appId/versions/:versionId", handleDeleteVersion);

// Multipart APK upload → R2 (admin only, validates + audits)
admin.post("/api/apps/:appId/upload", handleUploadApk);

admin.get("/api/apps/:appId/channels", handleListChannels);
admin.post("/api/apps/:appId/channels", handleCreateChannel);

admin.get("/api/apps/:appId/audit-logs", handleListAuditLogs);

// APK parsing — Worker → Container (forward raw APK bytes, get JSON metadata back)
admin.post("/api/parse-apk", async (c) => {
  const parser = await getRandom(c.env.APK_PARSER, 1);
  return parser.fetch(new Request("http://parser/parse", {
    method: "POST",
    body: await c.req.raw.arrayBuffer(),
    headers: { "content-type": "application/octet-stream" },
  }));
});

app.route("/", admin);

export default app;