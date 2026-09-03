import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import {
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from "jose";
import type { KeyLike } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPlayAdapter } from "../src/index";
import type { PlayAdapterEnv, TrackResource } from "../src/types";

const PACKAGE = "build.raft.app";
const NOW = 1_780_000_000;
const bytes = new TextEncoder().encode("exact-aab-bytes");
const digest = bytesToHex(sha256(bytes));

let credential = "";
let publicKey: CryptoKey | KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  publicKey = pair.publicKey;
  credential = JSON.stringify({
    type: "service_account",
    client_email: "hands-play@example.iam.gserviceaccount.com",
    private_key: await exportPKCS8(pair.privateKey),
    private_key_id: "key-1",
  });
});

function environment(overrides: Partial<PlayAdapterEnv> = {}): PlayAdapterEnv {
  return {
    GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: credential,
    ALLOWED_PACKAGE_NAMES: PACKAGE,
    GOOGLE_PLAY_CLOSED_TRACK_NAME: "closed-alpha",
    MAX_AAB_SIZE_BYTES: "209715200",
    ...overrides,
  };
}

function promotionRequest(overrides: Record<string, string> = {}, body: BodyInit = bytes): Request {
  return new Request(`https://play-adapter.internal/v1/apps/${PACKAGE}/edits`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-hands-track": "internal",
      "x-hands-version-code": "42",
      "x-hands-sha256": digest,
      "x-hands-size-bytes": String(bytes.byteLength),
      "x-hands-rollout-percent": "100",
      "x-hands-operation-id": "operation-1",
      ...overrides,
    },
    body,
  });
}

interface GoogleFixtureOptions {
  uploadSha?: string;
  trackMaximum?: number;
  tokenStatus?: number;
  commitThrows?: boolean;
}

function googleFixture(options: GoogleFixtureOptions = {}) {
  let nextEdit = 1;
  let track: TrackResource = {
    track: "qa",
    releases: [{ name: "existing", versionCodes: [String(options.trackMaximum ?? 41)], status: "completed" }],
  };
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  let assertion = "";
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url === "https://oauth2.googleapis.com/token") {
      assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
      return Response.json(
        options.tokenStatus && options.tokenStatus !== 200
          ? { error: credential }
          : { access_token: "access-token", expires_in: 3600 },
        { status: options.tokenStatus ?? 200 },
      );
    }
    let body: unknown = null;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    requests.push({ url, method, body });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-token");
    if (method === "POST" && /\/applications\/[^/]+\/edits$/.test(url)) {
      return Response.json({ id: `edit-${nextEdit++}` });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "GET" && url.includes("/tracks/")) return Response.json(track);
    if (url.includes("/bundles?uploadType=media")) {
      const uploaded = new Uint8Array(await new Response(init.body).arrayBuffer());
      return Response.json({
        versionCode: 42,
        sha256: options.uploadSha ?? bytesToHex(sha256(uploaded)),
      });
    }
    if (method === "PUT" && url.includes("/tracks/")) {
      track = body as TrackResource;
      return Response.json(track);
    }
    if (method === "POST" && url.includes(":commit?")) {
      if (options.commitThrows) throw new Error("ambiguous network failure");
      return Response.json({ id: "edit-1" });
    }
    return Response.json({ error: "unexpected request" }, { status: 500 });
  });
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    requests,
    assertion: () => assertion,
    track: () => track,
  };
}

describe("Google Play adapter", () => {
  it("uses a one-hour RS256 service-account assertion without exposing credentials", async () => {
    const fixture = googleFixture();
    const adapter = createPlayAdapter({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const response = await adapter.fetch(
      new Request(`https://play-adapter.internal/v1/apps/${PACKAGE}/tracks/internal`),
      environment(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ max_version_code: 41 });
    expect(decodeProtectedHeader(fixture.assertion())).toMatchObject({ alg: "RS256", kid: "key-1" });
    const verified = await jwtVerify(fixture.assertion(), publicKey, {
      algorithms: ["RS256"],
      issuer: "hands-play@example.iam.gserviceaccount.com",
      audience: "https://oauth2.googleapis.com/token",
      currentDate: new Date(NOW * 1000),
    });
    expect(verified.payload).toMatchObject({
      iat: NOW,
      exp: NOW + 3600,
      scope: "https://www.googleapis.com/auth/androidpublisher",
    });
    expect(fixture.requests.map((request) => request.method)).toEqual(["POST", "GET", "DELETE"]);
    expect(fixture.requests[1]!.url).toContain("/tracks/qa");
  });

  it("maps the contract closed track to the configured Play Console track", async () => {
    const fixture = googleFixture();
    const adapter = createPlayAdapter({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const response = await adapter.fetch(
      new Request(`https://play-adapter.internal/v1/apps/${PACKAGE}/tracks/closed`),
      environment(),
    );
    expect(response.status).toBe(200);
    expect(fixture.requests[1]!.url).toContain("/tracks/closed-alpha");
  });

  it("streams once, preserves existing releases, commits once, and reads back exact identity", async () => {
    const fixture = googleFixture();
    const adapter = createPlayAdapter({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const response = await adapter.fetch(promotionRequest(), environment());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      edit_id: "edit-1",
      package_name: PACKAGE,
      version_code: 42,
      track: "internal",
      sha256: digest,
      rollout_percent: 100,
    });
    expect(fixture.track().releases).toEqual([
      { name: "existing", versionCodes: ["41"], status: "completed" },
      { versionCodes: ["42"], status: "completed" },
    ]);
    const commits = fixture.requests.filter((request) => request.url.includes(":commit?"));
    expect(commits).toHaveLength(1);
    expect(commits[0]!.url).toContain("changesInReviewBehavior=ERROR_IF_IN_REVIEW");
    expect(fixture.requests.filter((request) => request.url.includes("/bundles?uploadType=media"))).toHaveLength(1);
  });

  it("deletes the uncommitted edit when Google reports a different AAB hash", async () => {
    const fixture = googleFixture({ uploadSha: "f".repeat(64) });
    const adapter = createPlayAdapter({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const response = await adapter.fetch(promotionRequest(), environment());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "play_bundle_mismatch" } });
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("rechecks the live track inside the edit and stops a version race", async () => {
    const fixture = googleFixture({ trackMaximum: 42 });
    const adapter = createPlayAdapter({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const response = await adapter.fetch(promotionRequest(), environment());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "play_version_conflict" } });
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("does not retry or delete an edit after an ambiguous commit attempt", async () => {
    const fixture = googleFixture({ commitThrows: true });
    const adapter = createPlayAdapter({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const response = await adapter.fetch(promotionRequest(), environment());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "play_api_unavailable" } });
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  it("models a partial production rollout and rejects partial test-track rollout before OAuth", async () => {
    const internalFixture = googleFixture();
    const adapter = createPlayAdapter({ fetchImpl: internalFixture.fetchImpl, nowSeconds: () => NOW });
    const rejected = await adapter.fetch(
      promotionRequest({ "x-hands-rollout-percent": "25" }),
      environment(),
    );
    expect(rejected.status).toBe(400);
    expect(internalFixture.fetchImpl).not.toHaveBeenCalled();

    const productionFixture = googleFixture();
    const production = createPlayAdapter({ fetchImpl: productionFixture.fetchImpl, nowSeconds: () => NOW });
    const accepted = await production.fetch(
      promotionRequest({ "x-hands-track": "production", "x-hands-rollout-percent": "25" }),
      environment(),
    );
    expect(accepted.status).toBe(200);
    expect(productionFixture.track().releases?.at(-1)).toEqual({
      versionCodes: ["42"],
      status: "inProgress",
      userFraction: 0.25,
    });
  });

  it("rejects disallowed packages and oversized AABs before credential use", async () => {
    const fixture = googleFixture();
    const adapter = createPlayAdapter({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const disallowed = await adapter.fetch(
      new Request("https://play-adapter.internal/v1/apps/other.example.app/tracks/internal"),
      environment(),
    );
    expect(disallowed.status).toBe(403);
    const oversized = await adapter.fetch(
      promotionRequest({ "x-hands-size-bytes": "16" }),
      environment({ MAX_AAB_SIZE_BYTES: "15" }),
    );
    expect(oversized.status).toBe(413);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts provider response bodies and credentials from errors and logs", async () => {
    const fixture = googleFixture({ tokenStatus: 401 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const adapter = createPlayAdapter({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
      const response = await adapter.fetch(
        new Request(`https://play-adapter.internal/v1/apps/${PACKAGE}/tracks/internal`),
        environment(),
      );
      const body = JSON.stringify(await response.json());
      expect(response.status).toBe(502);
      expect(body).not.toContain("PRIVATE KEY");
      expect(body).not.toContain("hands-play@example");
      expect(log.mock.calls.flat().join(" ")).not.toContain("PRIVATE KEY");
      expect(log.mock.calls.flat().join(" ")).not.toContain("hands-play@example");
    } finally {
      log.mockRestore();
    }
  });

  it("has no public route or preview URL in checked-in Wrangler config", () => {
    const config = readFileSync(
      fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
      "utf8",
    );
    expect(config).toMatch(/"workers_dev": false/);
    expect(config).toMatch(/"preview_urls": false/);
    expect(config).not.toMatch(/"routes"\s*:/);
  });
});
