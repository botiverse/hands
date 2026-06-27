/**
 * quiver Worker entry
 *
 * Adapted from cloudflare/templates/containers-template (Hono + Containers pattern).
 * Extends with D1 (apps / versions / channels / audit_logs) and R2 (APK binaries + icons).
 *
 * The ApkParserContainer class is bundled into the container image and runs
 * inside it. Class methods (onStart, parseApk) can use `this.ctx.container.exec()`
 * to spawn processes within the container — see
 * https://developers.cloudflare.com/containers/execute-commands/
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
//
// This class is compiled by wrangler and bundled into the container image.
// At runtime its methods run *inside* the container and have access to
// `this.ctx.container.exec()` for spawning processes.

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

    const whereProc = await this.ctx.container.exec(["which", "aapt"]);
    const whereOut = await whereProc.output();
    console.log(
      `[apk-parser] which aapt: exit=${whereOut.exitCode} stdout="${decoder.decode(whereOut.stdout).trim()}" stderr="${decoder.decode(whereOut.stderr).trim()}"`,
    );

    const directProc = await this.ctx.container.exec([AAPT_BIN, "version"]);
    const directOut = await directProc.output();
    console.log(
      `[apk-parser] direct ${AAPT_BIN} version: exit=${directOut.exitCode} stdout="${decoder.decode(directOut.stdout).trim()}" stderr="${decoder.decode(directOut.stderr).trim()}"`,
    );

    const pathProc = await this.ctx.container.exec(["sh", "-c", "echo $PATH && ls /opt/android-sdk/build-tools/ 2>&1 | head -5"]);
    const pathOut = await pathProc.output();
    console.log(
      `[apk-parser] PATH + ls: ${decoder.decode(pathOut.stdout).trim()}`,
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
   * and uses `this.ctx.container.exec()` to spawn aapt / apksigner.
   *
   * Path convention: the worker writes the APK to /tmp/quiver-apk/<id>.apk
   * first, then calls this method with the id.
   */
  async parseApk(id: string): Promise<ApkMetadata> {
    const apkPath = `${TMP_DIR}/${id}.apk`;

    // 1. aapt dump badging
    const aaptProc = await this.ctx.container.exec([
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
    const sigProc = await this.ctx.container.exec([
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

// CORS for the admin UI hosted at quiver-admin.pages.dev (and any other
// pages.dev preview URLs). In production you'd lock this down further.
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (origin === "https://quiver-admin.pages.dev") return origin;
      if (origin === "http://localhost:5173") return origin;
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

app.get("/api/apps/:appId/versions", handleListVersions);
app.get("/api/apps/:appId/versions/:versionId", handleGetVersion);

app.get("/public/apps/:slug/latest", handlePublicGetLatestVersion);
app.get("/public/apps/:slug/channels", handlePublicListChannels);

// Admin — protected by Cloudflare Access JWT or API Token
const admin = new Hono<{
  Bindings: Env;
  Variables: { cf_email?: string; cf_jwt?: string };
}>();
admin.use("*", authMiddleware);

admin.get("/api/apps", handleListApps);
admin.post("/api/apps", handleCreateApp);
admin.get("/api/apps/:appId", handleGetApp);

admin.post("/api/apps/:appId/versions", handleCreateVersion);
admin.patch("/api/apps/:appId/versions/:versionId", handleUpdateVersion);
admin.delete("/api/apps/:appId/versions/:versionId", handleDeleteVersion);

// Multipart APK upload → R2 (admin only, validates + audits)
admin.post("/api/apps/:appId/upload", handleUploadApk);

// Parse APK: write to R2, ask container to parse via exec(), return metadata
admin.post("/api/parse-apk", async (c) => {
  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (ab.byteLength > 200 * 1024 * 1024) {
    return c.json({ error: "APK too large (>200MB)" }, 413);
  }

  // 1. Compute hash and upload to a temp location in R2 (we don't need to
  //    commit to a per-version key yet — admin UI does that after parse).
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

  // 2. Forward to container: write bytes to in-container tmp, call parseApk.
  const container = await getRandom(c.env.APK_PARSER, 1);
  // We need the container to fetch the bytes. Pass a request that the
  // container's fetch() handler reads, writes to disk, and parses.
  const fakeRequest = new Request("http://container/parse", {
    method: "POST",
    body: ab,
    headers: { "content-type": "application/octet-stream" },
  });
  // Use a wrapper that delegates to the container's parseApk method via
  // the same id (fileHash). Easier: use the @cloudflare/containers
  // container.fetch() with a custom internal endpoint we register in the
  // class below.
  return container.fetch(fakeRequest).then(async (res) => {
    const text = await res.text();
    if (!res.ok) {
      return c.json(
        {
          error: "parse failed",
          container_status: res.status,
          detail: text.slice(0, 500),
        },
        500,
      );
    }
    // Container returned the metadata as JSON. Patch in the real hash +
    // size (the container doesn't know the original bytes' size — we do).
    const metadata = JSON.parse(text);
    metadata.size_bytes = ab.byteLength;
    metadata.file_hash_sha256 = fileHash;
    // Clean up the R2 tmp key (best-effort).
    c.env.APK_BUCKET.delete(tmpKey).catch(() => {});
    return c.json(metadata);
  });
});

admin.get("/api/apps/:appId/channels", handleListChannels);
admin.post("/api/apps/:appId/channels", handleCreateChannel);

admin.get("/api/apps/:appId/audit-logs", handleListAuditLogs);

app.route("/", admin);

export default app;