import { afterEach, describe, expect, it, vi } from "vitest";
import { gatherPreflightSnapshot } from "../src/lib/app_store_preflight";
import { handleGetAppStorePreflight } from "../src/routes/app_store_preflight";

/**
 * The preflight route against a stubbed App Store Connect. The property that matters
 * most: it never sends anything but GET, whatever Apple answers.
 */
function makeContext() {
  const appId = "app-1";
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (/SELECT id FROM apps/i.test(sql)) return { id: appId };
          if (/FROM channels/i.test(sql)) return { bundle_id: "build.raft.app" };
          return null;
        },
        run: async () => { throw new Error(`preflight must not write to D1: ${sql}`); },
      }),
    }),
  };
  return {
    env: { DB: db, ASC_CRED_ENC_KEY: "k" },
    req: {
      param: (name: string) => (name === "appId" ? appId : name === "versionId" ? "ver-1" : ""),
      query: () => undefined,
      json: async () => ({}),
    },
    get: () => "test:viewer",
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
  } as any;
}

async function realCreds() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  return { key_id: "TESTKEY123", issuer_id: "issuer-uuid-1234", p8: `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----` };
}
let cachedCreds: any = null;
vi.mock("../src/lib/asc_credentials", () => ({ getAscCredentials: async () => (cachedCreds ??= await realCreds()) }));
vi.mock("../src/lib/asc_api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/asc_api")>()),
  resolveAscAppId: async () => "asc-app-1",
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const shots = (prefix: string) => ({
  data: { id: prefix, relationships: { appScreenshots: { data: [{ id: `${prefix}-1` }, { id: `${prefix}-2` }] } } },
  included: [1, 2].map((i) => ({ type: "appScreenshots", id: `${prefix}-${i}`, attributes: { fileName: `0${i}.png`, assetDeliveryState: { state: "COMPLETE" } } })),
});

/** raft-ios 1.17.0-like: ja has no supportUrl; age rating read fails. */
function apple(url: string): Response {
  const path = url.replace("https://api.appstoreconnect.apple.com", "");
  if (path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) return json({ data: [{ id: "ver-1" }] });
  if (path === "/v1/appStoreVersions/ver-1?include=build") {
    return json({ data: { id: "ver-1", attributes: { versionString: "1.17.0", appVersionState: "PREPARE_FOR_SUBMISSION", platform: "IOS", copyright: "2026 Botiverse" },
      relationships: { build: { data: { type: "builds", id: "build-1" } } } } });
  }
  if (path === "/v1/apps/asc-app-1?fields[apps]=primaryLocale") return json({ data: { id: "asc-app-1", attributes: { primaryLocale: "en-US" } } });
  if (path === "/v1/builds/build-1?include=preReleaseVersion") {
    return json({ data: { id: "build-1", attributes: { version: "3", processingState: "VALID", expired: false, usesNonExemptEncryption: false },
      relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "pre-1" } } } },
    included: [{ type: "preReleaseVersions", id: "pre-1", attributes: { version: "1.17.0" } }] });
  }
  if (path.startsWith("/v1/appStoreVersions/ver-1/appStoreVersionLocalizations")) {
    const f = { description: "d", keywords: "k", whatsNew: "w", supportUrl: "https://docs.raft.build/support/" };
    return json({ data: [
      { id: "loc-en", attributes: { locale: "en-US", ...f } },
      { id: "loc-ja", attributes: { locale: "ja", ...f, supportUrl: null } },
    ] });
  }
  if (path.startsWith("/v1/appStoreVersionLocalizations/loc-en/appScreenshotSets")) return json({ data: [{ id: "set-en", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }] });
  if (path.startsWith("/v1/appStoreVersionLocalizations/loc-ja/appScreenshotSets")) return json({ data: [{ id: "set-ja", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }] });
  if (path.startsWith("/v1/appScreenshotSets/set-en?")) return json(shots("set-en"));
  if (path.startsWith("/v1/appScreenshotSets/set-ja?")) return json(shots("set-ja"));
  if (path.startsWith("/v1/apps/asc-app-1/appInfos")) {
    return json({ data: [
      { id: "ai-live", attributes: { state: "READY_FOR_DISTRIBUTION" } },
      { id: "ai-edit", attributes: { state: "PREPARE_FOR_SUBMISSION" } },
    ] });
  }
  if (path.startsWith("/v1/appInfos/ai-edit/appInfoLocalizations")) {
    return json({ data: [
      { id: "ail-en", attributes: { locale: "en-US", name: "Raft", privacyPolicyUrl: "https://raft.build/privacy" } },
      { id: "ail-ja", attributes: { locale: "ja", name: "Raft", privacyPolicyUrl: "https://raft.build/privacy" } },
    ] });
  }
  if (path === "/v1/appInfos/ai-edit/ageRatingDeclaration") {
    return json({ errors: [{ status: "500", code: "UNEXPECTED_ERROR", title: "An unexpected error occurred.", detail: "try again" }] }, 500);
  }
  if (path === "/v1/appStoreVersions/ver-1/appStoreReviewDetail") {
    return json({ data: { id: "rd-1", attributes: { contactFirstName: "A", contactLastName: "B", contactPhone: "+1", contactEmail: "a@b.c",
      demoAccountRequired: true, demoAccountName: "reviewer", demoAccountPassword: "s3cret-demo-pw" } } });
  }
  if (path.startsWith("/v1/apps/asc-app-1/reviewSubmissions")) {
    return json({ data: [{ id: "sub-rej", attributes: { state: "UNRESOLVED_ISSUES", platform: "IOS" } }] });
  }
  if (path.startsWith("/v1/reviewSubmissions/sub-rej/items")) {
    return json({ data: [{ relationships: { appStoreVersion: { data: { id: "ver-1" } } } }] });
  }
  throw new Error(`unexpected request ${path}`);
}

afterEach(() => vi.unstubAllGlobals());

describe("GET app-store/versions/:versionId/preflight", () => {
  it("reads with GET only and reports Apple's blockers, unreadable resources, and no secrets", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      requests.push({ method: (init?.method ?? "GET").toUpperCase(), url: String(url) });
      return apple(String(url));
    }));
    const res = await handleGetAppStorePreflight(makeContext());
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(requests.length).toBeGreaterThan(10);
    expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(requests.every((r) => r.url.startsWith("https://api.appstoreconnect.apple.com/"))).toBe(true);
    // The demo password is read only to know it is set; it never appears in the report.
    expect(text).not.toContain("s3cret-demo-pw");
    const body = JSON.parse(text);
    expect(body).toMatchObject({ version_id: "ver-1", version_string: "1.17.0", state: "PREPARE_FOR_SUBMISSION", ready: false });
    expect(body.findings.filter((f: any) => f.severity === "error")).toEqual([
      expect.objectContaining({ check: "localization_required_fields", locale: "ja", resource: "/v1/appStoreVersionLocalizations/loc-ja", message: "You must provide a value for the attribute 'supportUrl'" }),
    ]);
    expect(body.findings).toContainEqual(expect.objectContaining({ severity: "warning", check: "unreadable:age_rating", message: expect.stringContaining("500 UNEXPECTED_ERROR") }));
    // The editable appInfo is the one read, not the live one.
    expect(requests.some((r) => r.url.includes("/v1/appInfos/ai-edit/appInfoLocalizations"))).toBe(true);
    expect(requests.some((r) => r.url.includes("/v1/appInfos/ai-live/"))).toBe(false);
    // UNRESOLVED_ISSUES holding this very version: info, not a blocker.
    expect(body.findings).toContainEqual(expect.objectContaining({ severity: "info", check: "review_submission" }));
    expect(body.checked).toContain("screenshots");
    expect(body.not_checkable).toContainEqual(expect.objectContaining({ check: "age_rating" }));
  });

  it("the snapshot keeps only whether a demo password is set, never the password", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => apple(String(url))));
    const snapshot = await gatherPreflightSnapshot(await realCreds(), "asc-app-1", "ver-1");
    expect(JSON.stringify(snapshot)).not.toContain("s3cret-demo-pw");
    expect(snapshot.reviewDetail).toMatchObject({ ok: true, value: { demoAccountRequired: true, demoAccountNamePresent: true, demoAccountPasswordPresent: true } });
  });

  it("refuses a version id that is not this app's (404), still GET only", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      methods.push((init?.method ?? "GET").toUpperCase());
      if (String(url).includes("/v1/apps/asc-app-1/appStoreVersions?")) return json({ data: [{ id: "someone-else" }] });
      throw new Error(`unexpected request ${url}`);
    }));
    const res = await handleGetAppStorePreflight(makeContext());
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe("VERSION_NOT_IN_APP");
    expect(methods).toEqual(["GET"]);
  });

  it("a failing version read is a 502 with Apple's words, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/v1/apps/asc-app-1/appStoreVersions?")) return json({ data: [{ id: "ver-1" }] });
      return json({ errors: [{ status: "403", code: "FORBIDDEN_ERROR", title: "This request is forbidden for security reasons", detail: "key role" }] }, 403);
    }));
    const res = await handleGetAppStorePreflight(makeContext());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "ASC_API_REJECTED", provider_code: "FORBIDDEN_ERROR" });
  });
});
