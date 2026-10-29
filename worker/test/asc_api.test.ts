/**
 * Unit tests for the App Store Connect API client: the ES256 JWT must
 * verify against the corresponding public key and carry the claims Apple
 * requires, and the Build Upload calls must send the exact resource shapes
 * from the buildUploads schema.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createAscJwt,
  ascRequest,
  createBuildUpload,
  createBuildUploadFile,
  commitBuildUploadFile,
  expireAscBuild,
  resolveAscBuild,
  resolveAscAppId,
  AscApiError,
  type AscApiCredentials,
} from "../src/lib/asc_api";

async function generateTestCreds(): Promise<{
  creds: AscApiCredentials;
  publicKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
  return {
    creds: { key_id: "TESTKEY123", issuer_id: "issuer-uuid-1234", p8: pem },
    publicKey: pair.publicKey,
  };
}

function decodeSegment(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAscJwt", () => {
  it("produces a verifiable ES256 JWT with Apple's required claims", async () => {
    const { creds, publicKey } = await generateTestCreds();
    const now = 1_752_000_000;
    const jwt = await createAscJwt(creds, now);
    const [h, p, s] = jwt.split(".");
    expect(h && p && s).toBeTruthy();

    const header = decodeSegment(h!);
    expect(header).toEqual({ alg: "ES256", kid: "TESTKEY123", typ: "JWT" });

    const payload = decodeSegment(p!);
    expect(payload.iss).toBe("issuer-uuid-1234");
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(payload.iat).toBe(now);
    // Apple rejects tokens valid longer than 20 minutes
    expect((payload.exp as number) - now).toBeLessThanOrEqual(20 * 60);

    const sigB64 = s!.replace(/-/g, "+").replace(/_/g, "/");
    const sigBin = atob(sigB64);
    const sig = new Uint8Array(sigBin.length);
    for (let i = 0; i < sigBin.length; i++) sig[i] = sigBin.charCodeAt(i);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});

describe("ascRequest", () => {
  it("sends a bearer JWT and parses JSON", async () => {
    const { creds } = await generateTestCreds();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      expect(auth.startsWith("Bearer ")).toBe(true);
      expect(auth.split(".").length).toBe(3 - 1 + 1); // header.payload.sig
      return new Response(JSON.stringify({ data: [{ id: "app-1" }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const id = await resolveAscAppId(creds, "build.raft.app");
    expect(id).toBe("app-1");
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/v1/apps?filter[bundleId]=build.raft.app");
  });

  it("throws AscApiError with Apple's error detail on failure", async () => {
    const { creds } = await generateTestCreds();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            errors: [{ title: "NOT_AUTHORIZED", detail: "Key lacks access" }],
          }),
          { status: 403 },
        ),
      ),
    );
    await expect(ascRequest(creds, "GET", "/v1/apps")).rejects.toMatchObject({
      status: 403,
      message: "NOT_AUTHORIZED",
      detail: "Key lacks access",
    } satisfies Partial<AscApiError>);
  });
});

describe("build upload resource shapes", () => {
  it("createBuildUpload sends the buildUploads create schema", async () => {
    const { creds } = await generateTestCreds();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        data: {
          type: "buildUploads",
          attributes: {
            cfBundleShortVersionString: "1.2.0",
            cfBundleVersion: "1020000",
            platform: "IOS",
          },
          relationships: {
            app: { data: { type: "apps", id: "app-1" } },
          },
        },
      });
      return new Response(
        JSON.stringify({
          data: {
            id: "bu-1",
            attributes: {
              state: {
                state: "AWAITING_UPLOAD",
                errors: [],
                warnings: [],
                infos: [],
              },
            },
          },
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const bu = await createBuildUpload(creds, {
      ascAppId: "app-1",
      version: "1.2.0",
      buildNumber: "1020000",
    });
    expect(bu.id).toBe("bu-1");
    expect(bu.attributes.state?.state).toBe("AWAITING_UPLOAD");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/v1/buildUploads");
  });

  it("createBuildUploadFile sends the ipa file schema and returns uploadOperations", async () => {
    const { creds } = await generateTestCreds();
    const ops = [
      {
        url: "https://upload.example/part1",
        method: "PUT",
        offset: 0,
        length: 5,
        requestHeaders: [{ name: "x-part", value: "1" }],
      },
    ];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.data.type).toBe("buildUploadFiles");
      expect(body.data.attributes).toEqual({
        assetType: "ASSET",
        fileName: "app.ipa",
        fileSize: 5,
        uti: "com.apple.ipa",
      });
      expect(body.data.relationships.buildUpload.data).toEqual({
        type: "buildUploads",
        id: "bu-1",
      });
      return new Response(
        JSON.stringify({
          data: { id: "file-1", attributes: { uploadOperations: ops } },
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const file = await createBuildUploadFile(creds, {
      buildUploadId: "bu-1",
      fileName: "app.ipa",
      fileSize: 5,
    });
    expect(file.attributes.uploadOperations).toEqual(ops);
  });

  it("commitBuildUploadFile PATCHes uploaded:true with an optional sha256", async () => {
    const { creds } = await generateTestCreds();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toContain("/v1/buildUploadFiles/file-1");
      expect(init?.method).toBe("PATCH");
      const body = JSON.parse(String(init?.body));
      expect(body.data.id).toBe("file-1");
      expect(body.data.attributes.uploaded).toBe(true);
      expect(body.data.attributes.sourceFileChecksums.file).toEqual({
        algorithm: "SHA_256",
        hash: "abc123",
      });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await commitBuildUploadFile(creds, { fileId: "file-1", sha256: "abc123" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("TestFlight build resolution", () => {
  it("matches the exact app, marketing version, build number, and platform", async () => {
    const { creds } = await generateTestCreds();
    const fetchMock = vi.fn(async (url: unknown) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/v1/builds");
      expect(parsed.searchParams.get("filter[app]")).toBe("app-1");
      expect(parsed.searchParams.get("filter[version]")).toBe("1000005");
      expect(parsed.searchParams.get("filter[preReleaseVersion.version]")).toBe(
        "1.0.0",
      );
      expect(parsed.searchParams.get("filter[preReleaseVersion.platform]")).toBe(
        "IOS",
      );
      return Response.json({
        data: [
          {
            id: "build-1",
            attributes: {
              version: "1000005",
              processingState: "VALID",
              expired: false,
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const build = await resolveAscBuild(creds, {
      ascAppId: "app-1",
      version: "1.0.0",
      buildNumber: "1000005",
    });
    expect(build?.id).toBe("build-1");
  });

  it("expires only the exact ASC Build resource with the documented PATCH shape", async () => {
    const { creds } = await generateTestCreds();
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(new URL(String(url)).pathname).toBe("/v1/builds/build-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        data: {
          type: "builds",
          id: "build-1",
          attributes: { expired: true },
        },
      });
      return Response.json({
        data: {
          id: "build-1",
          attributes: {
            version: "1000005",
            processingState: "VALID",
            expired: true,
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const build = await expireAscBuild(creds, "build-1");
    expect(build.id).toBe("build-1");
    expect(build.attributes.expired).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("App Store submission", () => {
  /** Records every call so a test can assert the sequence, not just the result. */
  async function withFetch(handler: (url: string, method: string, body: any) => unknown) {
    const { creds } = await generateTestCreds();
    const calls: Array<{ url: string; method: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const parsed = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), method, body: parsed });
      return new Response(JSON.stringify(handler(String(url), method, parsed) ?? {}), { status: 200 });
    }));
    return { creds, calls };
  }

  it("creates a version with MANUAL release so approval does not ship it", async () => {
    const { createAppStoreVersion } = await import("../src/lib/asc_api");
    const { creds, calls } = await withFetch(() => ({ data: { id: "ver-1" } }));
    const version = await createAppStoreVersion(creds, "app-1", "1.15.2", "IOS", "MANUAL");
    expect(version.id).toBe("ver-1");
    expect(calls[0]!.url).toContain("/v1/appStoreVersions");
    expect(calls[0]!.body.data.attributes).toMatchObject({
      versionString: "1.15.2", platform: "IOS", releaseType: "MANUAL",
    });
  });

  it("withdraws by cancelling the review submission, not by setting appStoreState", async () => {
    // appStoreState is a read-only lifecycle enum; cancelling the submission is the
    // documented mechanism, and the deprecated DELETE endpoint must not be used.
    const { cancelReviewSubmission } = await import("../src/lib/asc_api");
    const { creds, calls } = await withFetch(() => ({ data: { id: "sub-1" } }));
    await cancelReviewSubmission(creds, "sub-1");
    expect(calls[0]!.url).toContain("/v1/reviewSubmissions/sub-1");
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body.data.attributes).toEqual({ canceled: true });
    expect(calls.some((c) => c.url.includes("appStoreVersionSubmissions"))).toBe(false);
  });

  it("submits in the documented three steps, ending with submitted:true", async () => {
    const { submitVersionForReview } = await import("../src/lib/asc_api");
    const { creds, calls } = await withFetch((url, method) =>
      method === "POST" && url.endsWith("/v1/reviewSubmissions") ? { data: { id: "sub-9" } } : {});
    const result = await submitVersionForReview(creds, "app-1", "ver-1", "IOS");
    expect(result.submissionId).toBe("sub-9");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/v1/reviewSubmissions");
    expect(calls[1]!.url).toContain("/v1/reviewSubmissionItems");
    // The item relates to the version as `appStoreVersion`; `appStoreVersionForReview`
    // is the reviewSubmission's relationship and Apple rejects it here with
    // "The provided entity includes an unknown relationship" (1.17.0, 2026-10-29).
    expect(calls[1]!.body.data.relationships.appStoreVersion.data.id).toBe("ver-1");
    expect(calls[1]!.body.data.relationships.appStoreVersionForReview).toBeUndefined();
    expect(calls[2]!.method).toBe("PATCH");
    expect(calls[2]!.body.data.attributes).toEqual({ submitted: true });
    expect(result.reused).toBe(false);
  });

  it("reuses a given draft instead of creating a second submission", async () => {
    const { submitVersionForReview } = await import("../src/lib/asc_api");
    const { creds, calls } = await withFetch(() => ({}));
    const result = await submitVersionForReview(creds, "app-1", "ver-1", "IOS", { reuseSubmissionId: "sub-draft" });
    expect(result).toEqual({ submissionId: "sub-draft", reused: true });
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissions"))).toBe(false);
    expect(calls[0]!.body.data.relationships.reviewSubmission.data.id).toBe("sub-draft");
    expect(calls[1]!.url).toContain("/v1/reviewSubmissions/sub-draft");
  });

  it("cancels the draft it created when adding the version fails, and rethrows", async () => {
    // Otherwise every failed attempt leaves an empty draft behind in App Store Connect.
    const { submitVersionForReview } = await import("../src/lib/asc_api");
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const { creds } = await withFetch(() => ({}));
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url); const method = init?.method ?? "GET";
      calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "POST" && u.endsWith("/v1/reviewSubmissions")) return new Response(JSON.stringify({ data: { id: "sub-new" } }));
      if (u.endsWith("/v1/reviewSubmissionItems")) {
        return new Response(JSON.stringify({ errors: [{ status: "409", detail: "nope" }] }), { status: 409 });
      }
      return new Response(JSON.stringify({ data: {} }));
    }));
    await expect(submitVersionForReview(creds, "app-1", "ver-1", "IOS")).rejects.toThrow();
    const cancel = calls.find((c) => c.method === "PATCH" && c.url.includes("/v1/reviewSubmissions/sub-new"));
    expect(cancel?.body.data.attributes).toEqual({ canceled: true });
    expect(calls.some((c) => c.body?.data?.attributes?.submitted === true)).toBe(false);
  });

  it("does not cancel a reused draft when a later step fails", async () => {
    // The draft predates this call; cancelling it is a decision for the caller.
    const { submitVersionForReview } = await import("../src/lib/asc_api");
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const { creds } = await withFetch(() => ({}));
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url); const method = init?.method ?? "GET";
      calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.endsWith("/v1/reviewSubmissionItems")) {
        return new Response(JSON.stringify({ errors: [{ status: "409", detail: "nope" }] }), { status: 409 });
      }
      return new Response(JSON.stringify({ data: {} }));
    }));
    await expect(submitVersionForReview(creds, "app-1", "ver-1", "IOS", { reuseSubmissionId: "sub-draft" })).rejects.toThrow();
    expect(calls.some((c) => c.body?.data?.attributes?.canceled === true)).toBe(false);
  });

  it("patches an existing localization instead of creating a duplicate", async () => {
    const { setVersionLocalization } = await import("../src/lib/asc_api");
    const { creds, calls } = await withFetch((url, method) => {
      if (method === "GET") return { data: [{ id: "loc-zh", attributes: { locale: "zh-Hans" } }] };
      return {};
    });
    await setVersionLocalization(creds, "ver-1", "zh-Hans", "修复若干问题");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.url).toContain("/appStoreVersionLocalizations/loc-zh");
    expect(calls[1]!.body.data.attributes).toEqual({ whatsNew: "修复若干问题" });
  });
});

describe("ASC associated errors", () => {
  it("keeps Apple's per-resource blockers from meta.associatedErrors", async () => {
    // "This resource cannot be reviewed, please check associated errors to see why."
    // names nothing; the blockers are only in meta.associatedErrors (1.17.0, 2026-10-29).
    const { parseAssociatedErrors } = await import("../src/lib/asc_api");
    const out = parseAssociatedErrors([{
      status: "409", code: "STATE_ERROR.ENTITY_STATE_INVALID",
      title: "appStoreVersions with id 'v1' is not in valid state.",
      detail: "This resource cannot be reviewed, please check associated errors to see why.",
      meta: { associatedErrors: {
        "/v1/appScreenshotSets/s1": [{ code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", detail: "screenshots required" }],
        "/v1/appInfoLocalizations/l1": [{ code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", title: "name required" }],
      } },
    }]);
    expect(out).toEqual([
      { resource: "/v1/appScreenshotSets/s1", code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", detail: "screenshots required" },
      { resource: "/v1/appInfoLocalizations/l1", code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", detail: "name required" },
    ]);
  });

  it("is bounded and tolerates junk", async () => {
    const { parseAssociatedErrors } = await import("../src/lib/asc_api");
    expect(parseAssociatedErrors(undefined)).toEqual([]);
    expect(parseAssociatedErrors([{ meta: { associatedErrors: { "/x": "nope" } } }])).toEqual([]);
    const many = Array.from({ length: 50 }, () => ({ code: "C", detail: "d".repeat(1000) }));
    const out = parseAssociatedErrors([{ meta: { associatedErrors: { "/x": many } } }]);
    expect(out).toHaveLength(30);
    expect(out[0]!.detail!.length).toBe(300);
  });
});
