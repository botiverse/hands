import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPlayAdapterService, normalizePlayApiPath } from "../src/index";
import type { PlayAdapterEnv, PlayDiscoveryInput } from "../src/types";

const PACKAGE = "build.raft.app";
let binding: PlayDiscoveryInput;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  binding = {
    credential: {
      type: "service_account",
      client_email: "tenant-app@example.iam.gserviceaccount.com",
      private_key: await exportPKCS8(pair.privateKey),
    },
    packageName: PACKAGE,
  };
});

const env: PlayAdapterEnv = { MAX_AAB_SIZE_BYTES: "209715200" };

describe("play-adapter callPlayApi", () => {
  it("normalizes package-relative and full application paths and rejects cross-package or traversal", () => {
    expect(normalizePlayApiPath(PACKAGE, "edits")).toEqual({
      canonicalPath: `/androidpublisher/v3/applications/${PACKAGE}/edits`,
      inlineQuery: {},
    });
    expect(normalizePlayApiPath(PACKAGE, "/edits/123/tracks/production?changesNotSentForReview=true")).toEqual({
      canonicalPath: `/androidpublisher/v3/applications/${PACKAGE}/edits/123/tracks/production`,
      inlineQuery: { changesNotSentForReview: ["true"] },
    });
    expect(
      normalizePlayApiPath(PACKAGE, `/androidpublisher/v3/applications/${PACKAGE}/reviews`),
    ).toEqual({
      canonicalPath: `/androidpublisher/v3/applications/${PACKAGE}/reviews`,
      inlineQuery: {},
    });
    expect(() =>
      normalizePlayApiPath(PACKAGE, "/androidpublisher/v3/applications/com.other.app/edits"),
    ).toThrow(/targets package 'com.other.app'/);
    expect(() => normalizePlayApiPath(PACKAGE, "../other")).toThrow(/traversal/);
    expect(() => normalizePlayApiPath(PACKAGE, "https://evil.example/edits")).toThrow(/full URL/);
  });

  it("executes authenticated calls against Google Play and returns status + data", async () => {
    const seen: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "play-token", expires_in: 3600 });
      }
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer play-token");
      seen.push({
        method: init.method ?? "GET",
        url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
      return Response.json({ id: "edit-42", expiryTimeSeconds: "999999" });
    });

    const service = createPlayAdapterService({ fetchImpl });
    const result = await service.callPlayApi(
      {
        ...binding,
        operationId: "op-test-1",
        method: "POST",
        path: "edits",
        query: { foo: "bar" },
        body: { expiryTimeSeconds: "999999" },
      },
      env,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        package_name: PACKAGE,
        method: "POST",
        path: `/androidpublisher/v3/applications/${PACKAGE}/edits?foo=bar`,
        status: 200,
        body: { id: "edit-42", expiryTimeSeconds: "999999" },
      });
    }
    expect(seen).toEqual([
      {
        method: "POST",
        url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/edits?foo=bar`,
        body: { expiryTimeSeconds: "999999" },
      },
    ]);
  });
});
