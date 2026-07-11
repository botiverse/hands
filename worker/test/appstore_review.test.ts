/**
 * Unit tests for the read-only App Store review helpers: the JSON:API
 * response shapes must map to the flat summaries the panel consumes —
 * including a rejected version state and the build→betaAppReviewSubmission
 * join (present, and absent → null).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getAppStoreVersions,
  getBetaReviewStates,
  type AscApiCredentials,
} from "../src/lib/asc_api";

async function generateTestCreds(): Promise<AscApiCredentials> {
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
  return { key_id: "TESTKEY123", issuer_id: "issuer-uuid-1234", p8: pem };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAppStoreVersions", () => {
  it("maps appStoreVersions attributes to flat summaries and requests the right endpoint", async () => {
    const creds = await generateTestCreds();
    const fetchMock = vi.fn(async (_url: unknown) =>
      jsonResponse({
        data: [
          {
            type: "appStoreVersions",
            id: "v1",
            attributes: {
              versionString: "2.0.0",
              appStoreState: "READY_FOR_SALE",
              platform: "IOS",
              createdDate: "2026-01-01T00:00:00Z",
            },
          },
          {
            type: "appStoreVersions",
            id: "v2",
            attributes: {
              versionString: "2.1.0",
              appStoreState: "METADATA_REJECTED",
              platform: "IOS",
              createdDate: "2026-02-01T00:00:00Z",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const versions = await getAppStoreVersions(creds, "asc-app-1");
    expect(versions).toEqual([
      {
        versionString: "2.0.0",
        appStoreState: "READY_FOR_SALE",
        platform: "IOS",
        createdDate: "2026-01-01T00:00:00Z",
      },
      {
        versionString: "2.1.0",
        appStoreState: "METADATA_REJECTED",
        platform: "IOS",
        createdDate: "2026-02-01T00:00:00Z",
      },
    ]);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/v1/apps/asc-app-1/appStoreVersions");
    expect(url).toContain("limit=5");
    // No sparse fieldset — ASC rejects some fields[...] selectors.
    expect(url).not.toContain("fields[");
  });

  it("returns an empty array when the app has no versions", async () => {
    const creds = await generateTestCreds();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [] })));
    expect(await getAppStoreVersions(creds, "asc-app-1")).toEqual([]);
  });
});

describe("getBetaReviewStates", () => {
  it("fetches builds then joins each build's beta review submission state", async () => {
    const creds = await generateTestCreds();
    // `include` is not allowed on /apps/{id}/builds; the submission is fetched
    // per-build via /v1/builds/{id}/betaAppReviewSubmission.
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("/betaAppReviewSubmission")) {
        return jsonResponse({
          data: {
            type: "betaAppReviewSubmissions",
            id: "sub-1",
            attributes: { betaReviewState: "APPROVED" },
          },
        });
      }
      return jsonResponse({
        data: [
          {
            type: "builds",
            id: "b1",
            attributes: {
              version: "100",
              processingState: "VALID",
              uploadedDate: "2026-03-01T00:00:00Z",
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const builds = await getBetaReviewStates(creds, "asc-app-1");
    expect(builds).toEqual([
      {
        version: "100",
        processingState: "VALID",
        uploadedDate: "2026-03-01T00:00:00Z",
        betaReviewState: "APPROVED",
      },
    ]);
    const buildsUrl = String(fetchMock.mock.calls[0]![0]);
    expect(buildsUrl).toContain("/v1/apps/asc-app-1/builds");
    expect(buildsUrl).not.toContain("include");
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "/v1/builds/b1/betaAppReviewSubmission",
    );
  });

  it("yields betaReviewState null when a build has no beta review submission", async () => {
    const creds = await generateTestCreds();
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("/betaAppReviewSubmission")) {
        // Internal-only build: relationship resolves to no data.
        return jsonResponse({ data: null });
      }
      return jsonResponse({
        data: [
          {
            type: "builds",
            id: "b2",
            attributes: {
              version: "101",
              processingState: "PROCESSING",
              uploadedDate: "2026-03-02T00:00:00Z",
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const builds = await getBetaReviewStates(creds, "asc-app-1");
    expect(builds).toEqual([
      {
        version: "101",
        processingState: "PROCESSING",
        uploadedDate: "2026-03-02T00:00:00Z",
        betaReviewState: null,
      },
    ]);
    const buildsUrl = String(fetchMock.mock.calls[0]![0]);
    expect(buildsUrl).toContain("/v1/apps/asc-app-1/builds");
    expect(buildsUrl).not.toContain("include");
  });
});
