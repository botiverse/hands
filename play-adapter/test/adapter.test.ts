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
const symbolsBytes = new TextEncoder().encode("exact-native-symbols-zip");
const symbolsDigest = bytesToHex(sha256(symbolsBytes));

function symbolsBody() {
  return new Blob([symbolsBytes]).stream();
}

function symbolsDeclaration(overrides: Partial<{ expectedSha256: string; expectedSize: number }> = {}) {
  return { expectedSha256: symbolsDigest, expectedSize: symbolsBytes.byteLength, ...overrides };
}

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
  /** Reject the AAB upload itself, to exercise the upload-stage rejection path. */
  uploadStatus?: number;
  uploadVersionCode?: number;
  trackMaximum?: number;
  tokenStatus?: number;
  commitThrows?: boolean;
  symbolsStatus?: number;
  symbolsMalformed?: boolean;
}

function googleFixture(options: GoogleFixtureOptions = {}) {
  let nextEdit = 1;
  const trackMaximum = options.trackMaximum ?? 41;
  let track: TrackResource = {
    track: "qa",
    releases: trackMaximum === 0
      ? []
      : [{ name: "existing", versionCodes: [String(trackMaximum)], status: "completed" }],
  };
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const symbolsUploads: Array<{ sha256: string; size: number }> = [];
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
      if (options.uploadStatus) {
        return Response.json(
          { error: { code: options.uploadStatus, status: "PERMISSION_DENIED",
            message: "Version code 11500010 has already been used." } },
          { status: options.uploadStatus },
        );
      }
      return Response.json({ versionCode: options.uploadVersionCode ?? 42, sha256: options.uploadSha ?? bytesToHex(sha256(uploaded)) });
    }
    if (url.includes("/deobfuscationFiles/nativeCode")) {
      const uploaded = new Uint8Array(await new Response(init.body).arrayBuffer());
      symbolsUploads.push({ sha256: bytesToHex(sha256(uploaded)), size: uploaded.byteLength });
      if (options.symbolsStatus) {
        return Response.json(
          { error: { errors: [{ reason: "insufficientPermissions" }], code: 403, message: "redacted-provider-text" } },
          { status: options.symbolsStatus },
        );
      }
      if (options.symbolsMalformed) return Response.json({});
      return Response.json({ deobfuscationFile: { symbolType: "nativeCode" } });
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
    symbolsUploads,
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
    const result = await service.promote(promotion(), body(), null, environment());
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
    // The previous completed release is superseded, not carried alongside: Play
    // rejects a track body with two completed releases. Before this fix the body was
    // exactly the two-entry array above, which is what produced the production
    // failure (receipt f3686db1, provider_cause=MULTIPLE_COMPLETED).
    expect(fixture.track().releases).toEqual([
      { versionCodes: ["42"], status: "completed" },
    ]);
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.url.includes("/bundles?uploadType=media"))).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.url.includes("/deobfuscationFiles/"))).toHaveLength(0);
  });

  it("uploads declared native symbols inside the edit before the track update and commits once", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(
      promotion({ symbols: symbolsDeclaration() }),
      body(),
      symbolsBody(),
      environment(),
    );
    expect(result).toMatchObject({ ok: true, value: { edit_id: "edit-1", version_code: 42, track: "internal" } });
    expect(fixture.symbolsUploads).toEqual([{ sha256: symbolsDigest, size: symbolsBytes.byteLength }]);
    const order = fixture.requests.map((request) => {
      if (request.url.includes("/bundles?uploadType=media")) return "bundle";
      if (request.url.includes("/deobfuscationFiles/nativeCode")) return "symbols";
      if (request.method === "PUT" && request.url.includes("/tracks/")) return "track";
      if (request.url.includes(":commit?")) return "commit";
      return null;
    }).filter(Boolean);
    expect(order).toEqual(["bundle", "symbols", "track", "commit"]);
    expect(fixture.requests.find((request) => request.url.includes("/deobfuscationFiles/nativeCode"))!.url)
      .toContain(`/apks/42/deobfuscationFiles/nativeCode?uploadType=media`);
  });

  it("fails closed and deletes the edit when Google rejects the symbols upload", async () => {
    const fixture = googleFixture({ symbolsStatus: 403 });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ symbols: symbolsDeclaration() }), body(), symbolsBody(), environment());
    expect(result).toMatchObject({ ok: false, error: { code: "play_api_rejected" } });
    expect(result.ok || result.error.message).toContain("stage=upload_symbols");
    expect(result.ok || result.error.message).not.toContain("redacted-provider-text");
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("fails closed on symbols exact-byte mismatch without touching the track", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(
      promotion({ symbols: symbolsDeclaration({ expectedSha256: "e".repeat(64) }) }),
      body(),
      symbolsBody(),
      environment(),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "symbols_integrity_mismatch" } });
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("fails closed when Google does not acknowledge a nativeCode symbol type", async () => {
    const fixture = googleFixture({ symbolsMalformed: true });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ symbols: symbolsDeclaration() }), body(), symbolsBody(), environment());
    expect(result).toMatchObject({ ok: false, error: { code: "play_symbols_malformed" } });
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("rejects malformed symbols declarations and undeclared streams before OAuth", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    // declared but no stream
    expect(await service.promote(promotion({ symbols: symbolsDeclaration() }), body(), null, environment())).toMatchObject({
      ok: false,
      error: { code: "promotion_request_invalid" },
    });
    // stream without declaration
    expect(await service.promote(promotion(), body(), symbolsBody(), environment())).toMatchObject({
      ok: false,
      error: { code: "promotion_request_invalid" },
    });
    // bad digest
    expect(await service.promote(promotion({ symbols: { expectedSha256: "nothex", expectedSize: 10 } }), body(), symbolsBody(), environment())).toMatchObject({
      ok: false,
      error: { code: "promotion_request_invalid" },
    });
    // over the Google mediaUpload bound (2,097,152,000 bytes)
    expect(await service.promote(
      promotion({ symbols: symbolsDeclaration({ expectedSize: 2_097_152_001 }) }),
      body(),
      symbolsBody(),
      environment(),
    )).toMatchObject({ ok: false, error: { code: "symbols_too_large" } });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("deletes an uncommitted edit on exact-byte mismatch", async () => {
    const fixture = googleFixture({ uploadSha: "f".repeat(64) });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion(), body(), null, environment());
    expect(result).toMatchObject({ ok: false, error: { code: "play_bundle_mismatch" } });
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it.each([
    { trackMaximum: 0, versionCode: 11301005 },
    { trackMaximum: 100, versionCode: 11301005 },
    { trackMaximum: 2099999999, versionCode: 2100000000 },
  ])("promotes $versionCode above track maximum $trackMaximum", async ({ trackMaximum, versionCode }) => {
    const fixture = googleFixture({ trackMaximum, uploadVersionCode: versionCode });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    expect(await service.promote(promotion({ versionCode }), body(), null, environment())).toEqual({
      ok: true,
      value: {
        edit_id: "edit-1",
        package_name: PACKAGE,
        version_code: versionCode,
        track: "internal",
        sha256: digest,
        rollout_percent: 100,
      },
    });
    // Only the new completed release remains, whether or not the track already had
    // one; a second completed in the same body is what Play rejects.
    expect(fixture.track().releases).toEqual([
      { versionCodes: [String(versionCode)], status: "completed" },
    ]);
    expect(fixture.requests.filter((request) => request.url.includes("/bundles?uploadType=media"))).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(1);
  });

  it("sends only one completed release when the track already had one", async () => {
    // Production failure: a track that had already shipped carried its completed
    // release forward and appended another, and Play rejected the body with
    // "Track has more than one completed release" (receipt f3686db1,
    // provider_cause=MULTIPLE_COMPLETED). Inspect the body actually PUT, not just the
    // resulting fixture state, so a future refactor cannot quietly reintroduce it.
    const fixture = googleFixture({ trackMaximum: 41, uploadVersionCode: 42 });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    expect((await service.promote(promotion({ versionCode: 42 }), body(), null, environment())).ok).toBe(true);

    const put = fixture.requests.filter(
      (request) => request.method === "PUT" && request.url.includes("/tracks/"),
    );
    expect(put).toHaveLength(1);
    const raw = put[0]!.body;
    const sent = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      releases: Array<{ status?: string; versionCodes?: string[] }>;
    };
    const completed = sent.releases.filter((release) => release.status === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.versionCodes).toEqual(["42"]);
  });

  it("reports the upload stage and a classified cause when the AAB upload is rejected", async () => {
    // Production: a second promote of the same versionCode failed with 403 at the
    // upload step, and the receipt carried only {code: play_upload_rejected} -- no
    // cause, so it looked exactly like a permission problem. The stage must survive
    // (upload vs track update) AND the cause must travel.
    const fixture = googleFixture({ trackMaximum: 41, uploadVersionCode: 42, uploadStatus: 403 });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ versionCode: 42 }), body(), null, environment());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Stays upload-specific: a generic play_api_rejected would erase the stage
    // distinction every existing receipt already relies on.
    expect(result.error.code).toBe("play_upload_rejected");
    expect(result.error.message).toContain("upload_bundle");
    expect(result.error.cause).toMatchObject({ stage: "upload_bundle", provider_cause: "DUPLICATE_VERSION" });
    // Google's own text never travels.
    expect(JSON.stringify(result)).not.toContain("already been used");
  });

  it("keeps the live completed release beside a staged rollout", async () => {
    // The drop applies ONLY when the incoming release is completed. A staged rollout
    // (inProgress) runs beside the current live release by Play's own rule, so
    // removing that completed release would take the live version off the track --
    // the opposite failure to the one this PR fixes. Pinned so a later simplification
    // to "always drop the old completed" cannot pass review.
    const fixture = googleFixture({ trackMaximum: 41, uploadVersionCode: 42 });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const promoted = await service.promote(
      promotion({ versionCode: 42, handsTrack: "production", rolloutPercent: 20 }),
      body(),
      null,
      environment(),
    );
    expect(promoted.ok).toBe(true);

    const put = fixture.requests.filter(
      (request) => request.method === "PUT" && request.url.includes("/tracks/"),
    );
    expect(put).toHaveLength(1);
    const raw = put[0]!.body;
    const sent = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      releases: Array<{ status?: string; versionCodes?: string[] }>;
    };
    expect(sent.releases).toEqual([
      { name: "existing", versionCodes: ["41"], status: "completed" },
      { versionCodes: ["42"], status: "inProgress", userFraction: 0.2 },
    ]);
  });

  it.each([
    { trackMaximum: 11301005, versionCode: 11301005 },
    { trackMaximum: 11301005, versionCode: 11301004 },
    { trackMaximum: 2100000000, versionCode: 2100000001 },
  ])("rejects version $versionCode against track maximum $trackMaximum before changing the track", async ({ trackMaximum, versionCode }) => {
    const fixture = googleFixture({ trackMaximum, uploadVersionCode: versionCode });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    expect(await service.promote(promotion({ versionCode }), body(), null, environment())).toMatchObject({
      ok: false,
      error: { code: "play_version_conflict" },
    });
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("stops a version race and does not undo an ambiguous commit", async () => {
    const race = googleFixture({ trackMaximum: 42 });
    const raceService = createPlayAdapterService({ fetchImpl: race.fetchImpl, nowSeconds: () => NOW });
    expect(await raceService.promote(promotion(), body(), null, environment())).toMatchObject({
      ok: false,
      error: { code: "play_version_conflict" },
    });
    expect(race.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(race.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);

    const ambiguous = googleFixture({ commitThrows: true });
    const ambiguousService = createPlayAdapterService({ fetchImpl: ambiguous.fetchImpl, nowSeconds: () => NOW });
    expect(await ambiguousService.promote(promotion(), body(), null, environment())).toMatchObject({
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
    expect(await service.promote(promotion({ expectedSize: 16 }), body(), null, environment({ MAX_AAB_SIZE_BYTES: "15" }))).toMatchObject({
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
