import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import type { KeyLike } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPlayAdapterService } from "../src/index";
import type { PlayAdapterEnv, PlayBindingInput, PromotionRpcInput, TrackResource } from "../src/types";

const PACKAGE = "build.raft.app";
const NOW = 1_780_000_000;
const bytes = new TextEncoder().encode("exact-aab-bytes");
const digest = bytesToHex(sha256(bytes));

let binding: PlayBindingInput;
let publicKey: CryptoKey | KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  publicKey = pair.publicKey;
  binding = {
    credential: {
      type: "service_account",
      project_id: "tenant-project",
      client_email: "tenant-app@example.iam.gserviceaccount.com",
      private_key: await exportPKCS8(pair.privateKey),
      private_key_id: "key-1",
    },
    packageName: PACKAGE,
    tracks: { internal: "qa", closed: "closed-alpha", production: "production" },
  };
});

function environment(overrides: Partial<PlayAdapterEnv> = {}): PlayAdapterEnv {
  return { MAX_AAB_SIZE_BYTES: "209715200", ...overrides };
}

function body() {
  return new Blob([bytes]).stream();
}

function promotion(overrides: Partial<PromotionRpcInput> = {}): PromotionRpcInput {
  return {
    ...binding,
    handsTrack: "internal",
    versionCode: 42,
    expectedSha256: digest,
    expectedSize: bytes.byteLength,
    rolloutPercent: 100,
    operationId: "operation-1",
    ...overrides,
  };
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
          ? { error: JSON.stringify(binding.credential) }
          : { access_token: "access-token", expires_in: 3600 },
        { status: options.tokenStatus ?? 200 },
      );
    }
    let requestBody: unknown = null;
    if (typeof init.body === "string") requestBody = JSON.parse(init.body);
    requests.push({ url, method, body: requestBody });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-token");
    if (method === "POST" && /\/applications\/[^/]+\/edits$/.test(url)) {
      return Response.json({ id: `edit-${nextEdit++}` });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "GET" && url.includes("/tracks/")) return Response.json(track);
    if (url.includes("/bundles?uploadType=media")) {
      const uploaded = new Uint8Array(await new Response(init.body).arrayBuffer());
      return Response.json({ versionCode: 42, sha256: options.uploadSha ?? bytesToHex(sha256(uploaded)) });
    }
    if (method === "PUT" && url.includes("/tracks/")) {
      track = requestBody as TrackResource;
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

describe("Google Play adapter RPC service", () => {
  it("validates the tenant package and every configured track without committing a release", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.verifyBinding(binding, environment());
    expect(result).toEqual({
      ok: true,
      value: { client_email: binding.credential.client_email, package_name: PACKAGE, tracks: binding.tracks },
    });
    expect(fixture.requests.filter((request) => request.method === "GET").map((request) => request.url)).toEqual([
      expect.stringContaining("/tracks/qa"),
      expect.stringContaining("/tracks/closed-alpha"),
      expect.stringContaining("/tracks/production"),
    ]);
    expect(fixture.requests.filter((request) => request.url.includes(":commit"))).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("uses a one-hour RS256 assertion and reads the app-selected track", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.readTrackMaximum({ ...binding, handsTrack: "closed" }, environment());
    expect(result).toEqual({ ok: true, value: { max_version_code: 41 } });
    expect(decodeProtectedHeader(fixture.assertion())).toMatchObject({ alg: "RS256", kid: "key-1" });
    const verified = await jwtVerify(fixture.assertion(), publicKey, {
      algorithms: ["RS256"],
      issuer: binding.credential.client_email,
      audience: "https://oauth2.googleapis.com/token",
      currentDate: new Date(NOW * 1000),
    });
    expect(verified.payload).toMatchObject({ iat: NOW, exp: NOW + 3600 });
    expect(fixture.requests[1]!.url).toContain("/tracks/closed-alpha");
  });

  it("streams once, preserves releases, commits once, and reads back exact identity", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion(), body(), environment());
    expect(result).toEqual({
      ok: true,
      value: {
        edit_id: "edit-1",
        package_name: PACKAGE,
        version_code: 42,
        track: "internal",
        sha256: digest,
        rollout_percent: 100,
      },
    });
    expect(fixture.track().releases).toEqual([
      { name: "existing", versionCodes: ["41"], status: "completed" },
      { versionCodes: ["42"], status: "completed" },
    ]);
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.url.includes("/bundles?uploadType=media"))).toHaveLength(1);
  });

  it("deletes an uncommitted edit on exact-byte mismatch", async () => {
    const fixture = googleFixture({ uploadSha: "f".repeat(64) });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion(), body(), environment());
    expect(result).toMatchObject({ ok: false, error: { code: "play_bundle_mismatch" } });
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("stops a version race and does not undo an ambiguous commit", async () => {
    const race = googleFixture({ trackMaximum: 42 });
    const raceService = createPlayAdapterService({ fetchImpl: race.fetchImpl, nowSeconds: () => NOW });
    expect(await raceService.promote(promotion(), body(), environment())).toMatchObject({
      ok: false,
      error: { code: "play_version_conflict" },
    });
    expect(race.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(race.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);

    const ambiguous = googleFixture({ commitThrows: true });
    const ambiguousService = createPlayAdapterService({ fetchImpl: ambiguous.fetchImpl, nowSeconds: () => NOW });
    expect(await ambiguousService.promote(promotion(), body(), environment())).toMatchObject({
      ok: false,
      error: { code: "play_api_unavailable" },
    });
    expect(ambiguous.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(1);
    expect(ambiguous.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  it("rejects invalid tenant input and oversized bytes before OAuth", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    expect(await service.readTrackMaximum({ ...binding, packageName: "../bad", handsTrack: "internal" }, environment())).toMatchObject({
      ok: false,
      error: { code: "package_name_invalid" },
    });
    expect(await service.promote(promotion({ expectedSize: 16 }), body(), environment({ MAX_AAB_SIZE_BYTES: "15" }))).toMatchObject({
      ok: false,
      error: { code: "aab_too_large" },
    });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts provider bodies and per-app credentials from errors and logs", async () => {
    const fixture = googleFixture({ tokenStatus: 401 });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
      const result = await service.readTrackMaximum({ ...binding, handsTrack: "internal" }, environment());
      const text = JSON.stringify(result);
      expect(result).toMatchObject({ ok: false, error: { status: 403, code: "play_token_rejected" } });
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain("tenant-app@example");
      expect(log.mock.calls.flat().join(" ")).not.toContain("PRIVATE KEY");
      expect(log.mock.calls.flat().join(" ")).not.toContain("tenant-app@example");
    } finally {
      log.mockRestore();
    }
  });

  it("has no public route, preview URL, or global tenant credential in Wrangler config", () => {
    const config = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8");
    expect(config).toMatch(/"workers_dev": false/);
    expect(config).toMatch(/"preview_urls": false/);
    expect(config).not.toMatch(/"routes"\s*:/);
    expect(config).not.toMatch(/GOOGLE_PLAY_SERVICE_ACCOUNT_JSON|ALLOWED_PACKAGE_NAMES|CLOSED_TRACK_NAME/);
  });
});
