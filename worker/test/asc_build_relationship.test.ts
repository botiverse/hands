import { describe, expect, it, vi } from "vitest";
import { findAppStoreVersion, getReviewSubmissionVersionId } from "../src/lib/asc_api";

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
