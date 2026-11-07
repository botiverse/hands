import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAppRole } from "../src/lib/permissions";
import { handleInspectAppStoreScreenshots } from "../src/routes/app_store_screenshot_inspection";
import { installAscFake, makeContext, realCreds, type AscCall } from "./asc_fake";

let cachedCreds: any;
vi.mock("../src/lib/asc_credentials", () => ({ getAscCredentials: async () => (cachedCreds ??= await realCreds()) }));
vi.mock("../src/lib/asc_api", async (original) => ({
  ...(await original<typeof import("../src/lib/asc_api")>()),
  resolveAscAppId: async () => "asc-app-1",
}));

type Options = { owned?: boolean; listNext?: unknown; localizationNext?: unknown; screenshotNext?: unknown; incomplete?: boolean; duplicateSet?: boolean; duplicateLocale?: boolean };
function fake(options: Options = {}) {
  return installAscFake(({ method, path }: AscCall) => {
    if (method !== "GET") throw new Error("inspection must not write");
    if (path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) return { json: { data: [{ id: options.owned === false ? "other" : "ver-1" }] } };
    if (path.startsWith("/v1/appStoreVersions/ver-1/appStoreVersionLocalizations?")) {
      const second = path.includes("cursor=two");
      return { json: second
        ? { data: [options.duplicateLocale ? { id: "loc-en", attributes: { locale: "en-US" } } : { id: "loc-ja", attributes: { locale: "ja" } }] }
        : { data: [{ id: "loc-en", attributes: { locale: "en-US" } }], links: { next: options.localizationNext ?? null } } };
    }
    if (path.startsWith("/v1/appStoreVersionLocalizations/loc-en/appScreenshotSets?")) {
      const second = path.includes("cursor=two");
      return { json: second
        ? { data: [options.duplicateSet ? { id: "set-1", attributes: { screenshotDisplayType: "FAKE_TYPE_FROM_APPLE" } } : { id: "set-2", attributes: { screenshotDisplayType: null } }] }
        : { data: [{ id: "set-1", attributes: { screenshotDisplayType: "FAKE_TYPE_FROM_APPLE" } }], links: { next: options.listNext ?? null } } };
    }
    if (path.startsWith("/v1/appStoreVersionLocalizations/loc-ja/appScreenshotSets?")) return { json: { data: [] } };
    if (path.startsWith("/v1/appScreenshotSets/set-1?")) return { json: {
      data: { relationships: { appScreenshots: { data: [{ id: "shot-1" }], links: { next: options.screenshotNext ?? null } } } },
      included: options.incomplete ? [] : [{ type: "appScreenshots", id: "shot-1", attributes: {
        fileName: "official.png", imageAsset: { width: 1398, height: 2034, templateUrl: "https://secret-assets.example/token" },
        sourceFileChecksum: "private-md5", assetDeliveryState: { state: "COMPLETE" },
      } }],
    } };
    if (path.startsWith("/v1/appScreenshotSets/set-2?")) return { json: {
      data: { relationships: { appScreenshots: { data: [{ id: "shot-2" }] } } },
      included: [{ type: "appScreenshots", id: "shot-2", attributes: { fileName: "other.png", imageAsset: { width: "bad", height: -1 } } }],
    } };
    return undefined;
  });
}

function context(locale?: string, versionId = "ver-1") {
  const { c, statements } = makeContext({ params: { versionId } });
  c.req.query = (name: string) => name === "locale" ? locale : undefined;
  return { c, statements };
}

afterEach(() => vi.unstubAllGlobals());

describe("GET screenshot inspection", () => {
  it("returns only selected metadata, GETs only, with no D1 writes", async () => {
    const asc = fake();
    const { c, statements } = context("en-US");
    const res = await handleInspectAppStoreScreenshots(c);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ version_id: "ver-1", localizations: [{ locale: "en-US", sets: [{
      id: "set-1", display_type: "FAKE_TYPE_FROM_APPLE", screenshots: [{ id: "shot-1", file_name: "official.png", width: 1398, height: 2034, state: "COMPLETE" }],
    }] }] });
    expect(text).not.toContain("token");
    expect(text).not.toContain("private-md5");
    expect(asc.calls.length).toBeGreaterThan(1);
    expect(asc.calls.every((call) => call.method === "GET")).toBe(true);
    expect(statements).toEqual([]);
  });

  it("follows set and locale pages and renders absent/invalid attributes as null", async () => {
    const asc = fake({
      listNext: "https://api.appstoreconnect.apple.com/v1/appStoreVersionLocalizations/loc-en/appScreenshotSets?cursor=two",
      localizationNext: "https://api.appstoreconnect.apple.com/v1/appStoreVersions/ver-1/appStoreVersionLocalizations?cursor=two",
    });
    const { c } = context();
    const res = await handleInspectAppStoreScreenshots(c);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.localizations.map((x: any) => x.locale)).toEqual(["en-US", "ja"]);
    expect(body.localizations[0].sets[1]).toEqual({ id: "set-2", display_type: null,
      screenshots: [{ id: "shot-2", file_name: "other.png", width: null, height: null, state: null }] });
    expect(asc.writes()).toEqual([]);
  });

  it("refuses another app's version before reading its locales", async () => {
    const asc = fake({ owned: false });
    const { c } = context();
    const res = await handleInspectAppStoreScreenshots(c);
    expect(res.status).toBe(404);
    expect((await res.json() as any).code).toBe("VERSION_NOT_IN_APP");
    expect(asc.calls).toHaveLength(1);
    expect(asc.writes()).toEqual([]);
  });

  it("finds an owned version on a later page before reading any screenshot metadata", async () => {
    const asc = installAscFake(({ method, path }: AscCall) => {
      if (method !== "GET") throw new Error("inspection must not write");
      if (path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) {
        return { json: path.includes("cursor=two") ? { data: [{ id: "ver-1" }] } : {
          data: [{ id: "ver-old" }], links: { next: "https://api.appstoreconnect.apple.com/v1/apps/asc-app-1/appStoreVersions?cursor=two" },
        } };
      }
      if (path.startsWith("/v1/appStoreVersions/ver-1/appStoreVersionLocalizations?")) return { json: { data: [] } };
      return undefined;
    });
    const res = await handleInspectAppStoreScreenshots(context().c);
    expect(res.status).toBe(200);
    expect((await res.json() as any).localizations).toEqual([]);
    expect(asc.calls.filter((call) => call.path.includes("/appStoreVersions?")).length).toBe(2);
    expect(asc.writes()).toEqual([]);
  });

  it.each([
    ["cross-origin", "https://api.appstoreconnect.apple.com.evil.example/pwn"],
    ["another app", "https://api.appstoreconnect.apple.com/v1/apps/other/appStoreVersions?cursor=two"],
    ["non-string", 42],
  ])("rejects %s version-list pagination without reading the target version", async (_name, next) => {
    const asc = installAscFake(({ method, path }: AscCall) => {
      if (method === "GET" && path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) {
        return { json: { data: [], links: { next } } };
      }
      return undefined;
    });
    const res = await handleInspectAppStoreScreenshots(context().c);
    expect(res.status).toBe(502);
    expect((await res.json() as any).code).toBe("ASC_API_REJECTED");
    expect(asc.calls).toHaveLength(1);
    expect(asc.writes()).toEqual([]);
  });

  it("fails closed on malformed version-list data and bounds an endless list", async () => {
    const malformed = installAscFake(() => ({ json: { data: [null] } }));
    const bad = await handleInspectAppStoreScreenshots(context().c);
    expect(bad.status).toBe(502);
    expect((await bad.json() as any).code).toBe("ASC_API_REJECTED");
    expect(malformed.writes()).toEqual([]);
    const looping = installAscFake(({ path }) => path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")
      ? { json: { data: [], links: { next: "https://api.appstoreconnect.apple.com/v1/apps/asc-app-1/appStoreVersions?cursor=loop" } } }
      : undefined);
    const bounded = await handleInspectAppStoreScreenshots(context().c);
    expect(bounded.status).toBe(502);
    expect(looping.calls).toHaveLength(5);
    expect(looping.writes()).toEqual([]);
  });

  it("bounds repeated pagination even when pages contain no records", async () => {
    const asc = installAscFake(({ method, path }: AscCall) => {
      if (method !== "GET") throw new Error("inspection must not write");
      if (path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) return { json: { data: [{ id: "ver-1" }] } };
      if (path.startsWith("/v1/appStoreVersions/ver-1/appStoreVersionLocalizations?")) return { json: { data: [{ id: "loc-en", attributes: { locale: "en-US" } }] } };
      if (path.startsWith("/v1/appStoreVersionLocalizations/loc-en/appScreenshotSets?")) return { json: { data: [], links: { next: "https://api.appstoreconnect.apple.com/v1/appStoreVersionLocalizations/loc-en/appScreenshotSets?cursor=loop" } } };
      return undefined;
    });
    const res = await handleInspectAppStoreScreenshots(context().c);
    expect(res.status).toBe(502);
    expect(asc.calls.filter((call) => call.path.includes("/appScreenshotSets?")).length).toBe(5);
    expect(asc.writes()).toEqual([]);
  });

  it("rejects invalid and nonexistent locale without reporting an empty success", async () => {
    const asc = fake();
    const invalid = await handleInspectAppStoreScreenshots(context("../bad").c);
    expect(invalid.status).toBe(400);
    expect(asc.calls).toHaveLength(0);
    const missing = await handleInspectAppStoreScreenshots(context("fr-FR").c);
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).code).toBe("LOCALIZATION_NOT_FOUND");
    expect(asc.writes()).toEqual([]);
  });

  it.each([
    ["cross-origin pagination", { listNext: "https://api.appstoreconnect.apple.com.evil.example/pwn" }],
    ["unrelated path pagination", { listNext: "https://api.appstoreconnect.apple.com/v1/apps/other" }],
    ["non-string pagination", { listNext: 42 }],
    ["cross-origin locale pagination", { localizationNext: "https://api.appstoreconnect.apple.com.evil.example/pwn" }],
    ["non-string locale pagination", { localizationNext: 42 }],
    ["duplicate screenshot set across pages", { listNext: "https://api.appstoreconnect.apple.com/v1/appStoreVersionLocalizations/loc-en/appScreenshotSets?cursor=two", duplicateSet: true }],
    ["duplicate locale across pages", { localizationNext: "https://api.appstoreconnect.apple.com/v1/appStoreVersions/ver-1/appStoreVersionLocalizations?cursor=two", duplicateLocale: true }],
    ["partial screenshot linkage", { screenshotNext: "https://api.appstoreconnect.apple.com/next" }],
    ["missing included screenshot", { incomplete: true }],
  ])("fails closed on %s", async (_name, options) => {
    const asc = fake(options);
    const { c } = context();
    const res = await handleInspectAppStoreScreenshots(c);
    expect(res.status).toBe(502);
    expect((await res.json() as any).code).toBe("ASC_API_REJECTED");
    expect(asc.writes()).toEqual([]);
    expect(asc.calls.every((call) => call.url.startsWith("https://api.appstoreconnect.apple.com/"))).toBe(true);
  });
});

describe("screenshot inspection access", () => {
  const account = { id: "viewer-1", provider: "raft", provider_subject: "subject", server_id: "server",
    server_slug: "server", principal_type: "human", server_role: "member", username: "viewer", display_name: "Viewer",
    avatar_url: null, raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1, org_id: null, org_role: null };

  it("denies a caller without an app role before the inspection handler runs", async () => {
    const asc = fake();
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("admin_account", account); await next(); });
    app.get("/api/apps/:appId/app-store/versions/:versionId/screenshots", requireAppRole("viewer"), handleInspectAppStoreScreenshots);
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }) };
    const response = await app.request("https://hands.test/api/apps/app-1/app-store/versions/ver-1/screenshots", {},
      { DB: db, DASHBOARD_ORIGIN: "https://hands.test" } as unknown as Env);
    expect(response.status).toBe(403);
    expect((await response.json() as any).code).toBe("INSUFFICIENT_APP_ROLE");
    expect(asc.calls).toEqual([]);
  });

  it("allows an app viewer to inspect only an owned version", async () => {
    const asc = fake();
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("admin_account", account); await next(); });
    app.get("/api/apps/:appId/app-store/versions/:versionId/screenshots", requireAppRole("viewer"), handleInspectAppStoreScreenshots);
    const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
      first: async () => {
        if (/FROM app_members/.test(sql) && args[0] === "app-1") return { app_role: "viewer" };
        if (/SELECT id FROM apps/.test(sql)) return { id: "app-1" };
        if (/FROM channels/.test(sql)) return { bundle_id: "build.example.app" };
        return null;
      },
      all: async () => ({ results: [] }),
    }) }) };
    const env = { DB: db, DASHBOARD_ORIGIN: "https://hands.test", ASC_CRED_ENC_KEY: "test" } as unknown as Env;
    const ok = await app.request("https://hands.test/api/apps/app-1/app-store/versions/ver-1/screenshots?locale=en-US", {}, env);
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).localizations[0].sets[0].display_type).toBe("FAKE_TYPE_FROM_APPLE");
    const denied = await app.request("https://hands.test/api/apps/other-app/app-store/versions/ver-1/screenshots", {}, env);
    expect(denied.status).toBe(403);
    expect(asc.writes()).toEqual([]);
  });
});
