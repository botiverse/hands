import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptP8 } from "../src/lib/asc_credentials";
import {
  handleCloseTestflightCrash,
  handleCloseTestflightFeedback,
  handleListTestflightFeedback,
  handleGetTestflightCrashLog,
  handleListTestflightCrashes,
  parseCrashLimit,
} from "../src/routes/testflight_crashes";

async function testCreds() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  return {
    key_id: "TESTKEY123",
    issuer_id: "issuer-uuid-1234",
    p8: `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`,
  };
}

async function setup(platform = "ios") {
  const creds = await testCreds();
  const encrypted = await encryptP8(creds.p8, "test-key");
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes("SELECT platform FROM apps")) return { platform };
          if (sql.includes("SELECT bundle_id FROM channels")) return { bundle_id: "build.raft.app" };
          if (sql.includes("FROM app_asc_credentials")) {
            return {
              id: "cred-1",
              app_id: "app-1",
              key_id: creds.key_id,
              issuer_id: creds.issuer_id,
              created_by_actor: "tester",
              created_at: 1,
              updated_at: 1,
              p8_ciphertext_b64: encrypted.ciphertext_b64,
              p8_iv_b64: encrypted.iv_b64,
            };
          }
          return null;
        },
      };
    },
  };
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}?${url.searchParams.toString()}`);
      if (method === "DELETE") {
        if (url.pathname === "/v1/betaFeedbackCrashSubmissions/crash-1") return new Response(null, { status: 204 });
        if (url.pathname === "/v1/betaFeedbackScreenshotSubmissions/shot-1") return new Response(null, { status: 204 });
        return Response.json({ errors: [{ title: "UNEXPECTED DELETE" }] }, { status: 500 });
      }
      if (url.pathname === "/v1/apps/asc-app-1/betaFeedbackScreenshotSubmissions") {
        return Response.json({
          data: [
            {
              id: "shot-1",
              attributes: {
                createdDate: "2026-09-27T20:00:00Z",
                deviceModel: "iPhone17,1",
                osVersion: "26.0",
                email: "tester@example.com",
                comment: "button is cut off",
                buildBundleId: "build.raft.app",
                screenshots: [
                  { url: "https://asc.example/shot.png?sig=1", width: 1179, height: 2556, expirationDate: "2026-09-28T20:00:00Z" },
                ],
              },
              relationships: { build: { data: { id: "asc-build-1" } } },
            },
          ],
        });
      }
      if (url.pathname === "/v1/betaFeedbackScreenshotSubmissions/shot-1") {
        return Response.json({ data: { id: "shot-1", attributes: { buildBundleId: "build.raft.app" } } });
      }
      if (url.pathname === "/v1/betaFeedbackScreenshotSubmissions/shot-other") {
        return Response.json({ data: { id: "shot-other", attributes: { buildBundleId: "com.other.app" } } });
      }
      if (url.pathname === "/v1/betaFeedbackCrashSubmissions/crash-nolog") {
        return Response.json({ data: { id: "crash-nolog", attributes: { buildBundleId: "build.raft.app" } } });
      }
      if (url.pathname === "/v1/betaFeedbackCrashSubmissions/crash-nolog/crashLog") {
        return Response.json({ errors: [{ title: "The specified resource does not exist" }] }, { status: 404 });
      }
      if (url.pathname === "/v1/apps") return Response.json({ data: [{ id: "asc-app-1" }] });
      if (url.pathname === "/v1/builds" && url.searchParams.get("filter[version]") === "11200001") {
        return Response.json({ data: [{ id: "asc-build-1", attributes: { version: "11200001" } }] });
      }
      if (url.pathname === "/v1/builds" && url.searchParams.get("filter[version]")) {
        return Response.json({ data: [] });
      }
      if (url.pathname === "/v1/builds" && url.searchParams.get("filter[id]")) {
        return Response.json({
          data: [
            {
              id: "asc-build-1",
              attributes: { version: "11200001" },
              relationships: { preReleaseVersion: { data: { id: "pre-1" } } },
            },
          ],
          included: [{ id: "pre-1", type: "preReleaseVersions", attributes: { version: "1.12.0" } }],
        });
      }
      if (url.pathname === "/v1/apps/asc-app-1/betaFeedbackCrashSubmissions") {
        return Response.json({
          data: [
            {
              id: "crash-1",
              attributes: {
                createdDate: "2026-09-27T19:00:00Z",
                deviceModel: "iPhone16,1",
                osVersion: "26.0",
                email: "tester@example.com",
                comment: "crashed on open",
                buildBundleId: "build.raft.app",
              },
              relationships: { build: { data: { id: "asc-build-1" } } },
            },
          ],
        });
      }
      if (url.pathname === "/v1/betaFeedbackCrashSubmissions/crash-1") {
        return Response.json({ data: { id: "crash-1", attributes: { buildBundleId: "build.raft.app" } } });
      }
      if (url.pathname === "/v1/betaFeedbackCrashSubmissions/crash-other") {
        return Response.json({ data: { id: "crash-other", attributes: { buildBundleId: "com.other.app" } } });
      }
      if (url.pathname === "/v1/betaFeedbackCrashSubmissions/crash-1/crashLog") {
        return Response.json({ data: { id: "log-1", attributes: { logText: "Incident Identifier: X\nThread 0 Crashed" } } });
      }
      return Response.json({ errors: [{ title: "UNEXPECTED", detail: url.pathname }] }, { status: 500 });
    }),
  );
  const app = new Hono();
  app.get("/api/apps/:appId/testflight-crashes", handleListTestflightCrashes as any);
  app.get("/api/apps/:appId/testflight-crashes/:submissionId/log", handleGetTestflightCrashLog as any);
  app.get("/api/apps/:appId/testflight-feedback", handleListTestflightFeedback as any);
  app.delete("/api/apps/:appId/testflight-crashes/:submissionId", handleCloseTestflightCrash as any);
  app.delete("/api/apps/:appId/testflight-feedback/:submissionId", handleCloseTestflightFeedback as any);
  const env = { DB: db, ASC_CRED_ENC_KEY: "test-key" } as any;
  return { app, env, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("TestFlight crash pull", () => {
  it("lists crashes for one build number with version labels and no tester email", async () => {
    const { app, env, calls } = await setup();
    const res = await app.request("/api/apps/app-1/testflight-crashes?build=11200001", undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.asc_app_id).toBe("asc-app-1");
    expect(body.crashes).toEqual([
      expect.objectContaining({
        id: "crash-1",
        asc_build_id: "asc-build-1",
        build_number: "11200001",
        version: "1.12.0",
        device_model: "iPhone16,1",
        comment: "crashed on open",
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("tester@example.com");
    expect(calls.some((c) => c.includes("betaFeedbackCrashSubmissions") && c.includes("filter%5Bbuild%5D=asc-build-1"))).toBe(true);
  });

  it("404s an unknown build number and rejects non-iOS apps / bad limits", async () => {
    const { app, env } = await setup();
    const missing = await app.request("/api/apps/app-1/testflight-crashes?build=999", undefined, env);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).code).toBe("ASC_BUILD_NOT_FOUND");
    const bad = await app.request("/api/apps/app-1/testflight-crashes?limit=0", undefined, env);
    expect(bad.status).toBe(400);
    const android = await setup("android");
    const res = await android.app.request("/api/apps/app-1/testflight-crashes", undefined, android.env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("APP_NOT_IOS");
    expect(parseCrashLimit(undefined)).toBe(20);
    expect(() => parseCrashLimit("201")).toThrow();
  });

  it("serves the crash log as a .ips attachment, scoped to the app's bundle", async () => {
    const { app, env } = await setup();
    const res = await app.request("/api/apps/app-1/testflight-crashes/crash-1/log", undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain("testflight-crash-crash-1.ips");
    expect(await res.text()).toContain("Thread 0 Crashed");

    const other = await app.request("/api/apps/app-1/testflight-crashes/crash-other/log", undefined, env);
    expect(other.status).toBe(404);
    const invalid = await app.request("/api/apps/app-1/testflight-crashes/..%2Fx/log", undefined, env);
    expect(invalid.status).toBe(400);
  });

  it("maps Apple's missing crash log 404 to CRASH_LOG_NOT_AVAILABLE", async () => {
    const { app, env } = await setup();
    const res = await app.request("/api/apps/app-1/testflight-crashes/crash-nolog/log", undefined, env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("CRASH_LOG_NOT_AVAILABLE");
  });

  it("lists screenshot feedback with screenshots and build labels, no tester email", async () => {
    const { app, env } = await setup();
    const res = await app.request("/api/apps/app-1/testflight-feedback?build=11200001", undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.feedback).toEqual([
      expect.objectContaining({
        id: "shot-1",
        build_number: "11200001",
        version: "1.12.0",
        comment: "button is cut off",
        screenshots: [
          { url: "https://asc.example/shot.png?sig=1", width: 1179, height: 2556, expires_at: "2026-09-28T20:00:00Z" },
        ],
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("tester@example.com");
  });

  it("closes a crash or screenshot submission via Apple's DELETE only when explicitly called", async () => {
    const { app, env, calls } = await setup();
    await app.request("/api/apps/app-1/testflight-feedback", undefined, env);
    await app.request("/api/apps/app-1/testflight-crashes", undefined, env);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);

    const crash = await app.request("/api/apps/app-1/testflight-crashes/crash-1", { method: "DELETE" }, env);
    expect(crash.status).toBe(200);
    expect(await crash.json()).toMatchObject({ ok: true, id: "crash-1", kind: "crash" });
    const shot = await app.request("/api/apps/app-1/testflight-feedback/shot-1", { method: "DELETE" }, env);
    expect(shot.status).toBe(200);
    expect(calls).toContain("DELETE /v1/betaFeedbackCrashSubmissions/crash-1?");
    expect(calls).toContain("DELETE /v1/betaFeedbackScreenshotSubmissions/shot-1?");

    const other = await app.request("/api/apps/app-1/testflight-feedback/shot-other", { method: "DELETE" }, env);
    expect(other.status).toBe(404);
    expect(calls.some((c) => c.includes("DELETE /v1/betaFeedbackScreenshotSubmissions/shot-other"))).toBe(false);
  });
});
