import { describe, expect, it, vi } from "vitest";
import {
  findAppStoreVersion,
  getAppStoreVersion,
  getReviewSubmissionVersionId,
  getScreenshotSetWithScreenshots,
  listAppStoreVersions,
} from "../src/lib/asc_api";

/**
 * `include=build` is not optional here.
 *
 * JSON:API omits `relationships.build` unless the request asks for it, so a version
 * list fetched without it looks identical to a version with no build attached. The
 * status route turns that into `build_attached: false`, which reads as a factual
 * claim about App Store. It is not: it is a statement about our own query.
 *
 * This was reported as a production anomaly -- "1.12.0 has no build attached, so
 * Apple has nothing to review" -- and nearly drove a withdrawal decision. The build
 * may well have been attached the whole time.
 */

function mockAsc(payload: unknown) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
  return calls;
}

async function realCreds() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  return {
    key_id: "TESTKEY123",
    issuer_id: "issuer-uuid-1234",
    p8: `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`,
  } as never;
}

describe("App Store version lookup asks Apple for the build relationship", () => {
  it("requests include=build so relationships.build is present", async () => {
    const calls = mockAsc({ data: [] });
    await findAppStoreVersion(await realCreds(), "app-1", "1.12.0").catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain("include=build");
    vi.unstubAllGlobals();
  });

  it("reports the build id when Apple returns the relationship", async () => {
    mockAsc({
      data: [
        {
          id: "ver-1",
          attributes: { versionString: "1.12.0", appStoreState: "WAITING_FOR_REVIEW" },
          relationships: { build: { data: { id: "build-abc" } } },
        },
      ],
    });
    const version = await findAppStoreVersion(await realCreds(), "app-1", "1.12.0");
    expect(version?.buildId).toBe("build-abc");
    vi.unstubAllGlobals();
  });

  it("returns null only when Apple says the relationship is empty", async () => {
    mockAsc({
      data: [
        {
          id: "ver-1",
          attributes: { versionString: "1.12.0", appStoreState: "WAITING_FOR_REVIEW" },
          relationships: { build: { data: null } },
        },
      ],
    });
    const version = await findAppStoreVersion(await realCreds(), "app-1", "1.12.0");
    expect(version?.buildId).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("submission item lookup asks Apple for the version relationship", () => {
  it("requests include=appStoreVersionForReview", async () => {
    const calls = mockAsc({ data: [] });
    await getReviewSubmissionVersionId(await realCreds(), "sub-1").catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain("include=appStoreVersionForReview");
    vi.unstubAllGlobals();
  });

  it("identifies the version a submission carries", async () => {
    mockAsc({
      data: [
        { relationships: { appStoreVersionForReview: { data: { id: "ver-9" } } } },
      ],
    });
    expect(await getReviewSubmissionVersionId(await realCreds(), "sub-1")).toBe("ver-9");
    vi.unstubAllGlobals();
  });
});

describe("prepare's version reads ask for the build relationship", () => {
  it("listAppStoreVersions requests include=build and the platform filter", async () => {
    const calls = mockAsc({ data: [] });
    await listAppStoreVersions(await realCreds(), "app-1", "IOS");
    expect(calls[0]).toContain("include=build");
    expect(calls[0]).toContain("filter[platform]=IOS");
    vi.unstubAllGlobals();
  });

  it("getAppStoreVersion (read-back) requests include=build", async () => {
    const calls = mockAsc({ data: { id: "ver-1", attributes: { versionString: "1.17.0" }, relationships: { build: { data: null } } } });
    const version = await getAppStoreVersion(await realCreds(), "ver-1");
    expect(calls[0]).toBe("https://api.appstoreconnect.apple.com/v1/appStoreVersions/ver-1?include=build");
    // Apple said "no build": the relationship was returned with data null.
    expect(version).toMatchObject({ buildId: null, buildRelationshipReturned: true });
    vi.unstubAllGlobals();
  });

  it("distinguishes 'Apple returned no relationship' from 'Apple says no build'", async () => {
    mockAsc({ data: { id: "ver-1", attributes: { versionString: "1.17.0" } } });
    const version = await getAppStoreVersion(await realCreds(), "ver-1");
    expect(version).toMatchObject({ buildId: null, buildRelationshipReturned: false });
    vi.unstubAllGlobals();
  });

  it("listAppStoreVersions follows links.next instead of deciding from the first page", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      calls.push(String(url));
      const page2 = String(url).includes("cursor=2");
      return new Response(JSON.stringify(page2
        ? { data: [{ id: "ver-2", attributes: { versionString: "1.12.0", appVersionState: "DEVELOPER_REJECTED" } }] }
        : { data: [{ id: "ver-1", attributes: { versionString: "1.11.0" } }],
            links: { next: "https://api.appstoreconnect.apple.com/v1/apps/app-1/appStoreVersions?include=build&cursor=2" } }));
    }));
    const versions = await listAppStoreVersions(await realCreds(), "app-1", "IOS");
    expect(versions.map((v) => v.id)).toEqual(["ver-1", "ver-2"]);
    expect(calls).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});

describe("screenshot set reads ask for the screenshots relationship", () => {
  it("requests include=appScreenshots and keeps Apple's order", async () => {
    const calls = mockAsc({
      data: { id: "set-1", relationships: { appScreenshots: { data: [{ type: "appScreenshots", id: "s2" }, { type: "appScreenshots", id: "s1" }] } } },
      included: [
        { type: "appScreenshots", id: "s1", attributes: { sourceFileChecksum: "AA", assetDeliveryState: { state: "COMPLETE" } } },
        { type: "appScreenshots", id: "s2", attributes: { sourceFileChecksum: "bb", assetDeliveryState: { state: "COMPLETE" } } },
      ],
    });
    const shots = await getScreenshotSetWithScreenshots(await realCreds(), "set-1");
    expect(calls[0]).toContain("include=appScreenshots");
    expect(shots.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(shots[1]!.sourceFileChecksum).toBe("aa");
    vi.unstubAllGlobals();
  });

  it("throws when the relationship is missing rather than reporting an empty set", async () => {
    mockAsc({ data: { id: "set-1" } });
    await expect(getScreenshotSetWithScreenshots(await realCreds(), "set-1")).rejects.toThrow(/relationship/);
    vi.unstubAllGlobals();
  });
});
