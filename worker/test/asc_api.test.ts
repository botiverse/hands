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
});
