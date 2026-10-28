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

const mappingBytes = new TextEncoder().encode("com.example.A -> a:\n    void run() -> b\n");
const mappingDigest = bytesToHex(sha256(mappingBytes));

function mappingBody() {
  return new Blob([mappingBytes]).stream();
}

function mappingDeclaration(overrides: Partial<{ expectedSha256: string; expectedSize: number }> = {}) {
  return { expectedSha256: mappingDigest, expectedSize: mappingBytes.byteLength, ...overrides };
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
  /** symbolType Google echoes for a proguard upload (default: proguard). */
  mappingAckType?: string;
  /** Reject the proguard upload with this HTTP status. */
  mappingStatus?: number;
  /** Reject the commit of this edit id with 403 EDIT_IN_REVIEW-style prose. */
  failCommitOf?: string;
  /** Message for that rejection (default: in-review prose). */
  failCommitMessage?: string;
  /** tracks.releases.list answers, in order (lifecycle state of versionCode 42). */
  lifecycleStates?: string[];
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
  const mappingUploads: Array<{ sha256: string; size: number }> = [];
  let assertion = "";
  // Set by alreadyOnPlay(): makes the /tracks LIST report this versionCode as present,
  // which is what promote() consults before deciding to upload the bundle.
  let alreadyOnPlayVersion: string | null = null;
  // sha256 Google reports for that bundle; the skip is only safe when it matches.
  let alreadyOnPlaySha = "";
  const ALREADY_SHA = "a".repeat(64);
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
    // The bare /tracks list is what promote consults before deciding whether the
    // bundle still needs uploading; /tracks/<name> is the per-track read.
    // The skip decision asks Google which bytes it holds for this versionCode.
    // Matches the GET bundle list, whether or not a query string is present.
    if (method === "GET" && /\/bundles(\?|$)/.test(url)) {
      return Response.json({
        bundles: alreadyOnPlayVersion === null
          ? []
          : [{ versionCode: Number(alreadyOnPlayVersion), sha256: alreadyOnPlaySha }],
      });
    }
    if (method === "GET" && /\/tracks(\?|$)/.test(url)) {
      const releases = alreadyOnPlayVersion === null
        ? track.releases
        : [...(track.releases ?? []), { name: "elsewhere", versionCodes: [alreadyOnPlayVersion], status: "completed" }];
      return Response.json({ tracks: [{ track: track.track, releases }] });
    }
    if (method === "GET" && /\/tracks\/[^/]+\/releases$/.test(url)) {
      const state = options.lifecycleStates?.shift();
      const playTrack = decodeURIComponent(/\/tracks\/([^/]+)\/releases$/.exec(url)![1]!);
      return Response.json(state
        ? { releases: [{ track: playTrack, releaseName: "r", releaseLifecycleState: state, activeArtifacts: [{ versionCode: 42 }] }] }
        : {});
    }
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
    if (url.includes("/deobfuscationFiles/proguard")) {
      if (options.mappingStatus) {
        // Answer without reading the body, as Google may for an early refusal.
        return Response.json(
          { error: { errors: [{ reason: "insufficientPermissions" }], code: options.mappingStatus, message: "redacted-provider-text" } },
          { status: options.mappingStatus },
        );
      }
      const uploaded = new Uint8Array(await new Response(init.body).arrayBuffer());
      mappingUploads.push({ sha256: bytesToHex(sha256(uploaded)), size: uploaded.byteLength });
      return Response.json({ deobfuscationFile: { symbolType: options.mappingAckType ?? "proguard" } });
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
      if (options.failCommitOf && url.includes(`/edits/${options.failCommitOf}:commit`)) {
        return Response.json(
          { error: { code: 403, message: options.failCommitMessage ?? "Cannot commit the edit because another change is already in review." } },
          { status: 403 },
        );
      }
      return Response.json({ id: "edit-1" });
    }
    return Response.json({ error: "unexpected request" }, { status: 500 });
  });
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    requests,
    symbolsUploads,
    mappingUploads,
    assertion: () => assertion,
    track: () => track,
    /** Pretend Google Play already holds this versionCode (as after an earlier promote). */
    alreadyOnPlay: (versionCode: number, sha256: string = ALREADY_SHA) => {
      alreadyOnPlayVersion = String(versionCode);
      alreadyOnPlaySha = sha256;
    },
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
        bundle_uploaded: true,
        track: "internal",
        sha256: digest,
        rollout_percent: 100,
        deobfuscation_files: [],
        release_notes_languages: [],
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

  it("uploads a declared R8/ProGuard mapping with symbolType proguard after native symbols, before the track", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(
      promotion({ symbols: symbolsDeclaration(), mapping: mappingDeclaration() }),
      body(),
      symbolsBody(),
      environment(),
      mappingBody(),
    );
    expect(result).toMatchObject({ ok: true, value: {
      deobfuscation_files: [
        { symbol_type: "nativeCode", sha256: symbolsDigest, size_bytes: symbolsBytes.byteLength, uploaded: true },
        { symbol_type: "proguard", sha256: mappingDigest, size_bytes: mappingBytes.byteLength, uploaded: true },
      ],
    } });
    expect(fixture.mappingUploads).toEqual([{ sha256: mappingDigest, size: mappingBytes.byteLength }]);
    const order = fixture.requests.map((request) => {
      if (request.url.includes("/bundles?uploadType=media")) return "bundle";
      if (request.url.includes("/deobfuscationFiles/nativeCode")) return "symbols";
      if (request.url.includes("/deobfuscationFiles/proguard")) return "mapping";
      if (request.method === "PUT" && request.url.includes("/tracks/")) return "track";
      if (request.url.includes(":commit?")) return "commit";
      return null;
    }).filter(Boolean);
    expect(order).toEqual(["bundle", "symbols", "mapping", "track", "commit"]);
    expect(fixture.requests.find((request) => request.url.includes("/deobfuscationFiles/proguard"))!.url)
      .toContain("/apks/42/deobfuscationFiles/proguard?uploadType=media");
  });

  it("requires a proguard acknowledgement for a mapping and words the failure as a mapping, not native symbols", async () => {
    const fixture = googleFixture({ mappingAckType: "nativeCode" });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ mapping: mappingDeclaration() }), body(), null, environment(), mappingBody());
    expect(result).toMatchObject({ ok: false, error: {
      code: "play_mapping_malformed",
      message: "Google Play did not acknowledge a proguard deobfuscation file",
    } });
    expect(fixture.requests.filter((request) => request.url.includes(":commit?"))).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("reports mapping size and integrity failures with proguard wording", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const tooLarge = await service.promote(
      promotion({ mapping: mappingDeclaration({ expectedSize: 2_097_152_001 }) }), body(), null, environment(), mappingBody(),
    );
    expect(tooLarge).toMatchObject({ ok: false, error: {
      code: "mapping_too_large",
      message: "R8/ProGuard mapping (deobfuscation file, proguard) exceed the Google Play maximum size",
    } });
    expect(tooLarge.ok || tooLarge.error.message).not.toMatch(/native/i);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    const mismatch = await service.promote(
      promotion({ mapping: mappingDeclaration({ expectedSha256: "e".repeat(64) }) }), body(), null, environment(), mappingBody(),
    );
    expect(mismatch).toMatchObject({ ok: false, error: {
      code: "mapping_integrity_mismatch",
      message: "Streamed R8/ProGuard mapping (deobfuscation file, proguard) did not match the Hands identity",
    } });
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
  });

  it("classifies a rejected mapping upload as stage=upload_mapping", async () => {
    const fixture = googleFixture();
    const inner = fixture.fetchImpl;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).includes("/deobfuscationFiles/proguard")
      ? Response.json({ error: { errors: [{ reason: "insufficientPermissions" }], code: 403 } }, { status: 403 })
      : inner(input, init)) as typeof fetch;
    const service = createPlayAdapterService({ fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ mapping: mappingDeclaration() }), body(), null, environment(), mappingBody());
    expect(result).toMatchObject({ ok: false, error: { code: "play_api_rejected", cause: { stage: "upload_mapping" } } });
  });

  it("rejects a mapping stream without a declaration, and a declaration without a stream", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    expect(await service.promote(promotion(), body(), null, environment(), mappingBody())).toMatchObject({
      ok: false, error: { code: "promotion_request_invalid" },
    });
    expect(await service.promote(promotion({ mapping: mappingDeclaration() }), body(), null, environment())).toMatchObject({
      ok: false, error: { code: "promotion_request_invalid" },
    });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  function stepsOf(fixture: ReturnType<typeof googleFixture>) {
    return fixture.requests.map((request) => {
      const edit = /\/edits\/([^/:?]+)/.exec(request.url)?.[1] ?? "";
      if (request.method === "POST" && /\/edits$/.test(request.url)) return "create";
      if (request.url.includes("/bundles?uploadType=media")) return `bundle@${edit}`;
      if (request.url.includes("/deobfuscationFiles/nativeCode")) return `symbols@${edit}`;
      if (request.url.includes("/deobfuscationFiles/proguard")) return `mapping@${edit}`;
      if (request.method === "PUT") return `track@${edit}`;
      if (request.url.includes(":commit?")) return `commit@${edit}`;
      if (request.method === "DELETE") return `delete@${edit}`;
      return null;
    }).filter(Boolean);
  }

  it("still uploads native symbols and the mapping when Play already holds the bundle, in their own edit before the release edit", async () => {
    // Real case: receipt d5df9591 -- the bundle was pushed before mappings were
    // sent, so "bundle already on Play" must not imply "mapping already on Play".
    const fixture = googleFixture({ trackMaximum: 0 });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(
      promotion({ symbols: symbolsDeclaration(), mapping: mappingDeclaration() }),
      body(), symbolsBody(), environment(), mappingBody(),
    );
    expect(result).toMatchObject({ ok: true, value: { edit_id: "edit-2", bundle_uploaded: false, deobfuscation_files: [
      { symbol_type: "nativeCode", sha256: symbolsDigest, uploaded: true, edit: "existing_bundle" },
      { symbol_type: "proguard", sha256: mappingDigest, uploaded: true, edit: "existing_bundle" },
    ] } });
    expect(fixture.mappingUploads).toEqual([{ sha256: mappingDigest, size: mappingBytes.byteLength }]);
    expect(stepsOf(fixture)).toEqual([
      "create", "symbols@edit-1", "mapping@edit-1", "commit@edit-1",
      "create", "track@edit-2", "commit@edit-2",
      "create", // readback
      "delete@edit-3",
    ]);
  });

  it("does not fail the promote when Play refuses the mapping for a bundle it already holds, and reports the refusal", async () => {
    const fixture = googleFixture({ trackMaximum: 0, mappingStatus: 403 });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const stream = mappingBody();
    const result = await service.promote(promotion({ mapping: mappingDeclaration() }), body(), null, environment(), stream);
    expect(result).toMatchObject({ ok: true, value: { edit_id: "edit-2", bundle_uploaded: false } });
    const [file] = (result as { ok: true; value: { deobfuscation_files: unknown[] } }).value.deobfuscation_files;
    expect(file).toEqual({
      symbol_type: "proguard", sha256: mappingDigest, size_bytes: mappingBytes.byteLength,
      uploaded: false, edit: "existing_bundle", attempt: "rejected", stage: "upload_mapping",
      error_code: "play_api_rejected", http_status: 403, provider_reason: "insufficientPermissions", provider_cause: "OTHER",
    });
    expect(JSON.stringify(result)).not.toContain("redacted-provider-text");
    // Nothing was accepted, so the side edit is deleted, never committed; the release still commits.
    expect(stepsOf(fixture)).toEqual([
      "create", "mapping@edit-1", "delete@edit-1",
      "create", "track@edit-2", "commit@edit-2",
      "create", "delete@edit-3",
    ]);
    // The unread mapping stream is released, so the caller's tee stops buffering.
    expect(stream.locked).toBe(false);
    await expect(stream.getReader().read()).resolves.toMatchObject({ done: true });
  });

  it("reports a refused side-edit commit as rejected at commit_edit and still ships the release", async () => {
    const fixture = googleFixture({ trackMaximum: 0, failCommitOf: "edit-1" });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ mapping: mappingDeclaration() }), body(), null, environment(), mappingBody());
    expect(result).toMatchObject({ ok: true, value: { edit_id: "edit-2", deobfuscation_files: [{
      symbol_type: "proguard", uploaded: false, attempt: "rejected", stage: "commit_edit",
      error_code: "play_api_rejected", provider_cause: "EDIT_IN_REVIEW",
    }] } });
    expect(stepsOf(fixture)).toContain("commit@edit-2");
  });

  it("still fails closed on Hands' own integrity mismatch when the bundle is already on Play", async () => {
    const fixture = googleFixture({ trackMaximum: 0 });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(
      promotion({ mapping: mappingDeclaration({ expectedSha256: "e".repeat(64) }) }), body(), null, environment(), mappingBody(),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "mapping_integrity_mismatch" } });
    expect(stepsOf(fixture)).toEqual(["create", "mapping@edit-1", "delete@edit-1"]);
  });

  it("keeps a new bundle fail-closed when Play refuses its mapping", async () => {
    const fixture = googleFixture({ mappingStatus: 403 });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ mapping: mappingDeclaration() }), body(), null, environment(), mappingBody());
    expect(result).toMatchObject({ ok: false, error: { code: "play_api_rejected", cause: { stage: "upload_mapping" } } });
    expect(stepsOf(fixture)).toEqual(["create", "bundle@edit-1", "mapping@edit-1", "delete@edit-1"]);
  });

  it("puts release notes on the new track release only", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const notes = [{ language: "zh-CN", text: "修复" }, { language: "en-US", text: "Fixes" }, { language: "ja-JP", text: "修正" }];
    const result = await service.promote(promotion({ releaseNotes: notes }), body(), null, environment());
    expect(result).toMatchObject({ ok: true, value: { release_notes_languages: ["zh-CN", "en-US", "ja-JP"] } });
    expect(fixture.track().releases).toEqual([{ versionCodes: ["42"], status: "completed", releaseNotes: notes }]);
  });

  it("fails closed on release notes over 500 characters, never truncating", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const ok = await service.promote(
      promotion({ releaseNotes: [{ language: "en-US", text: "🐛".repeat(500) }] }), body(), null, environment(),
    );
    expect(ok).toMatchObject({ ok: true });
    const calls = (fixture.fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const tooLong = await service.promote(
      promotion({ releaseNotes: [{ language: "en-US", text: "x".repeat(501) }] }), body(), null, environment(),
    );
    expect(tooLong).toMatchObject({ ok: false, error: { code: "release_notes_too_long" } });
    expect((fixture.fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
    for (const bad of [
      [{ language: "en", text: "" }],
      [{ language: "EN_us", text: "x" }],
      [{ language: "en-US", text: "a" }, { language: "en-us", text: "b" }],
      "not-a-list",
    ]) {
      expect(await service.promote(promotion({ releaseNotes: bad as never }), body(), null, environment()))
        .toMatchObject({ ok: false, error: { code: "release_notes_invalid" } });
    }
  });

  it("deletes an uncommitted edit on exact-byte mismatch", async () => {
    const fixture = googleFixture({ uploadSha: "f".repeat(64) });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion(), body(), null, environment());
    expect(result).toMatchObject({ ok: false, error: { code: "play_bundle_mismatch" } });
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("skips the bundle upload when Play already holds this versionCode", async () => {
    // Pushing one build internal -> closed -> production used to re-upload the same
    // AAB each time and get 403 for a duplicate versionCode. Once the version is on
    // any track, only the track edit is needed.
    const fixture = googleFixture({ trackMaximum: 0, uploadVersionCode: 11301005 });
    // Play already holds this versionCode AND the same bytes, so only the track edit runs.
    fixture.alreadyOnPlay(11301005, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ versionCode: 11301005 }), body(), null, environment());
    expect(result).toMatchObject({ ok: true });
    expect(fixture.requests.filter((r) => String(r.url).includes("/bundles?uploadType=media"))).toHaveLength(0);
    expect(fixture.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
  });

  it("refuses when Play holds the same versionCode with DIFFERENT bytes", async () => {
    // A versionCode match alone is not proof the bytes are ours: the console may have
    // received a different build under the same code. Shipping those while the receipt
    // claims expectedSha256 would be an unverified certification.
    const fixture = googleFixture({ trackMaximum: 0, uploadVersionCode: 11301005 });
    fixture.alreadyOnPlay(11301005, "b".repeat(64)); // Play holds someone else's bytes
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ versionCode: 11301005 }), body(), null, environment());
    expect(result).toMatchObject({ ok: false, error: { code: "aab_integrity_mismatch" } });
    expect(fixture.requests.filter((r) => String(r.url).includes("/bundles?uploadType=media"))).toHaveLength(0);
    expect(fixture.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("reports each promote's own versionCode, in sequence", async () => {
    // NOTE: this passes with or without the explicit per-promote reset, because every
    // promote assigns lastBundleLookup before anything reads it. It is a behavioural
    // check, NOT proof that the reset is load-bearing -- that would need a promote
    // that fails before the lookup runs, which is a different test.
    const fixture = googleFixture({ trackMaximum: 0, uploadVersionCode: 11301005, uploadStatus: 400 });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const first = await service.promote(promotion({ versionCode: 11301005 }), body(), null, environment());
    expect(first).toMatchObject({ ok: false, error: { cause: { bundle_lookup: { wanted: 11301005 } } } });

    // Second call with a different versionCode must report ITS value, not the first's.
    const second = await service.promote(promotion({ versionCode: 11301006 }), body(), null, environment());
    expect(second).toMatchObject({ ok: false, error: { cause: { bundle_lookup: { wanted: 11301006 } } } });
  });

  it("puts the bundle lookup into the receipt cause when the upload is rejected", async () => {
    // 'Google returned nothing' and 'we failed to match what Google returned' produce
    // the same user-visible failure. Only this distinguishes them, and the operator
    // log is not reachable from a receipt.
    const fixture = googleFixture({ trackMaximum: 0, uploadVersionCode: 11301005, uploadStatus: 400 });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ versionCode: 11301005 }), body(), null, environment());
    expect(result).toMatchObject({
      ok: false,
      error: { code: "play_upload_rejected", cause: { bundle_lookup: { count: 0, version_codes: [], wanted: 11301005 } } },
    });
  });

  it("reports a failed bundle listing as bundle_lookup, not as an upload failure", async () => {
    // Review probe turned into a test. Before the fix the listing threw, the receipt
    // said stage=upload_bundle, and bundle_lookup was absent entirely -- pointing the
    // reader at the wrong stage and at a list they could not tell was ever fetched.
    const fixture = googleFixture({ trackMaximum: 0, uploadVersionCode: 11301005 });
    const original = fixture.fetchImpl;
    const wrapped = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET" && /\/bundles(\?|$)/.test(url)) {
        return new Response(JSON.stringify({ error: { code: 502, message: "backend error" } }), { status: 502 });
      }
      return original(input as never, init as never);
    });
    const service = createPlayAdapterService({ fetchImpl: wrapped as unknown as typeof fetch, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ versionCode: 11301005 }), body(), null, environment());
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "play_bundle_lookup_failed",
        cause: { stage: "bundle_lookup", bundle_lookup: { count: -1, version_codes: [], wanted: 11301005 } },
      },
    });
  });

  it("still uploads when the versionCode is not on any track", async () => {
    const fixture = googleFixture({ trackMaximum: 0, uploadVersionCode: 11301005 });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    expect(await service.promote(promotion({ versionCode: 11301005 }), body(), null, environment()))
      .toMatchObject({ ok: true });
    expect(fixture.requests.filter((r) => String(r.url).includes("/bundles?uploadType=media"))).toHaveLength(1);
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
        bundle_uploaded: true,
        track: "internal",
        sha256: digest,
        rollout_percent: 100,
        deobfuscation_files: [],
        release_notes_languages: [],
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

describe("changesNotSentForReview and sendForReview", () => {
  const commits = (fixture: ReturnType<typeof googleFixture>) =>
    fixture.requests.filter((request) => request.url.includes(":commit?")).map((request) => {
      const edit = /\/edits\/([^/:?]+):commit/.exec(request.url)?.[1];
      return `${edit}?${request.url.split("?")[1]}`;
    });

  function steps(fixture: ReturnType<typeof googleFixture>) {
    return fixture.requests.map((request) => {
      const edit = /\/edits\/([^/:?]+)/.exec(request.url)?.[1] ?? "";
      if (request.method === "POST" && /\/edits$/.test(request.url)) return "create";
      if (/\/tracks\/[^/]+\/releases$/.test(request.url)) return "lifecycle";
      if (request.method === "GET" && /\/bundles$/.test(request.url)) return `bundles@${edit}`;
      if (request.method === "GET" && request.url.includes("/tracks/")) return `track@${edit}`;
      if (request.url.includes(":commit?")) return `commit@${edit}`;
      if (request.method === "DELETE") return `delete@${edit}`;
      return null;
    }).filter(Boolean);
  }

  function sendInput(overrides: Record<string, unknown> = {}) {
    return { ...binding, handsTrack: "internal" as const, versionCode: 42, expectedSha256: digest, operationId: "operation-2", ...overrides };
  }

  it("promote without the flag commits with ERROR_IF_IN_REVIEW only and returns the same shape as before", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion(), body(), null, environment());
    expect(result.ok && "changes_not_sent_for_review" in result.value).toBe(false);
    expect(commits(fixture)).toEqual(["edit-1?changesInReviewBehavior=ERROR_IF_IN_REVIEW"]);
  });

  it("promote with the flag commits changesNotSentForReview=true, keeps ERROR_IF_IN_REVIEW, and says so", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ changesNotSentForReview: true }), body(), null, environment());
    expect(result).toMatchObject({ ok: true, value: { edit_id: "edit-1", version_code: 42, changes_not_sent_for_review: true } });
    expect(commits(fixture)).toEqual(["edit-1?changesInReviewBehavior=ERROR_IF_IN_REVIEW&changesNotSentForReview=true"]);
    expect(fixture.requests.some((request) => /CANCEL_IN_REVIEW/.test(request.url))).toBe(false);
  });

  it("with the flag, the existing-bundle side edit is not sent for review either", async () => {
    const fixture = googleFixture({ trackMaximum: 0 });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(
      promotion({ mapping: mappingDeclaration(), changesNotSentForReview: true }), body(), null, environment(), mappingBody(),
    );
    expect(result).toMatchObject({ ok: true, value: { edit_id: "edit-2", bundle_uploaded: false, changes_not_sent_for_review: true } });
    expect(commits(fixture)).toEqual([
      "edit-1?changesInReviewBehavior=ERROR_IF_IN_REVIEW&changesNotSentForReview=true",
      "edit-2?changesInReviewBehavior=ERROR_IF_IN_REVIEW&changesNotSentForReview=true",
    ]);
  });

  it("without the flag, the existing-bundle side edit commit is unchanged", async () => {
    const fixture = googleFixture({ trackMaximum: 0 });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    await service.promote(promotion({ mapping: mappingDeclaration() }), body(), null, environment(), mappingBody());
    expect(commits(fixture)).toEqual([
      "edit-1?changesInReviewBehavior=ERROR_IF_IN_REVIEW",
      "edit-2?changesInReviewBehavior=ERROR_IF_IN_REVIEW",
    ]);
  });

  it("with the flag, Google's in-review answer is reported as play_edit_in_review (no retry, no cancel)", async () => {
    const fixture = googleFixture({ failCommitOf: "edit-1" });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ changesNotSentForReview: true }), body(), null, environment());
    expect(result).toMatchObject({ ok: false, error: { status: 409, code: "play_edit_in_review", cause: { stage: "commit_edit", provider_cause: "EDIT_IN_REVIEW" } } });
    expect(commits(fixture)).toEqual(["edit-1?changesInReviewBehavior=ERROR_IF_IN_REVIEW&changesNotSentForReview=true"]);
  });

  it("with the flag, an unrecognised commit rejection is play_edit_state_unknown, never success", async () => {
    const fixture = googleFixture({ failCommitOf: "edit-1", failCommitMessage: "Etwas ist schiefgelaufen." });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ changesNotSentForReview: true }), body(), null, environment());
    expect(result).toMatchObject({ ok: false, error: { status: 502, code: "play_edit_state_unknown", cause: { stage: "commit_edit", provider_cause: "OTHER" } } });
    expect(JSON.stringify(result)).not.toContain("schiefgelaufen");
  });

  it("without the flag, the same in-review rejection keeps today's play_api_rejected error", async () => {
    const fixture = googleFixture({ failCommitOf: "edit-1" });
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion(), body(), null, environment());
    expect(result).toMatchObject({ ok: false, error: { status: 403, code: "play_api_rejected", cause: { stage: "commit_edit", provider_cause: "EDIT_IN_REVIEW" } } });
  });

  it("rejects a non-boolean flag before OAuth", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.promote(promotion({ changesNotSentForReview: "yes" as unknown as boolean }), body(), null, environment());
    expect(result).toMatchObject({ ok: false, error: { code: "promotion_request_invalid" } });
    expect(fixture.requests).toHaveLength(0);
  });

  it("sendForReview checks bundle and track, then commits WITHOUT changesNotSentForReview", async () => {
    const fixture = googleFixture({
      trackMaximum: 42,
      lifecycleStates: ["RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW", "RELEASE_LIFECYCLE_STATE_IN_REVIEW"],
    });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.sendForReview(sendInput(), environment());
    expect(result).toEqual({ ok: true, value: {
      edit_id: "edit-1",
      package_name: PACKAGE,
      version_code: 42,
      track: "internal",
      play_track: "qa",
      sha256: digest,
      track_release: { status: "completed", user_fraction: null },
      commit: { changes_in_review_behavior: "ERROR_IF_IN_REVIEW", changes_not_sent_for_review: false },
      lifecycle_before: "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW",
      lifecycle_after: "RELEASE_LIFECYCLE_STATE_IN_REVIEW",
    } });
    expect(steps(fixture)).toEqual(["lifecycle", "create", "bundles@edit-1", "track@edit-1", "commit@edit-1", "lifecycle"]);
    expect(commits(fixture)).toEqual(["edit-1?changesInReviewBehavior=ERROR_IF_IN_REVIEW"]);
    // Nothing is written in the edit: no upload, no track PUT.
    expect(fixture.requests.filter((request) => request.method === "PUT" || request.url.includes("uploadType"))).toHaveLength(0);
  });

  it("sendForReview records unknown lifecycle as null and still succeeds", async () => {
    const fixture = googleFixture({ trackMaximum: 42 });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.sendForReview(sendInput(), environment());
    expect(result).toMatchObject({ ok: true, value: { lifecycle_before: null, lifecycle_after: null } });
  });

  it("sendForReview reports another change in review as play_edit_in_review and deletes the edit", async () => {
    const fixture = googleFixture({ trackMaximum: 42, failCommitOf: "edit-1" });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.sendForReview(sendInput(), environment());
    expect(result).toMatchObject({ ok: false, error: { status: 409, code: "play_edit_in_review", cause: { stage: "commit_edit", provider_cause: "EDIT_IN_REVIEW" } } });
    expect(steps(fixture)).toEqual(["lifecycle", "create", "bundles@edit-1", "track@edit-1", "commit@edit-1", "delete@edit-1"]);
  });

  it("sendForReview refuses a versionCode the track does not carry, without committing", async () => {
    const fixture = googleFixture({ trackMaximum: 41 });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.sendForReview(sendInput(), environment());
    expect(result).toMatchObject({ ok: false, error: { status: 409, code: "play_release_not_on_track" } });
    expect(commits(fixture)).toEqual([]);
    expect(steps(fixture).at(-1)).toBe("delete@edit-1");
  });

  it("sendForReview refuses when Play holds no bundle, or different bytes, for the versionCode", async () => {
    const missing = googleFixture({ trackMaximum: 42 });
    const missingService = createPlayAdapterService({ fetchImpl: missing.fetchImpl, nowSeconds: () => NOW });
    expect(await missingService.sendForReview(sendInput(), environment()))
      .toMatchObject({ ok: false, error: { status: 409, code: "play_bundle_not_on_play" } });
    expect(commits(missing)).toEqual([]);

    const different = googleFixture({ trackMaximum: 42 });
    different.alreadyOnPlay(42, "b".repeat(64));
    const differentService = createPlayAdapterService({ fetchImpl: different.fetchImpl, nowSeconds: () => NOW });
    expect(await differentService.sendForReview(sendInput(), environment()))
      .toMatchObject({ ok: false, error: { status: 409, code: "aab_integrity_mismatch" } });
    expect(commits(different)).toEqual([]);
  });

  it("sendForReview leaves an unanswered commit alone and calls it ambiguous", async () => {
    const fixture = googleFixture({ trackMaximum: 42, commitThrows: true });
    fixture.alreadyOnPlay(42, digest);
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    const result = await service.sendForReview(sendInput(), environment());
    expect(result).toMatchObject({ ok: false, error: { status: 502, code: "play_commit_ambiguous" } });
    expect(fixture.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);
  });

  it("sendForReview validates input before OAuth", async () => {
    const fixture = googleFixture();
    const service = createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW });
    for (const bad of [{ versionCode: 0 }, { expectedSha256: "nope" }, { operationId: "" }, { handsTrack: "beta" }]) {
      const result = await service.sendForReview(sendInput(bad) as never, environment());
      expect(result).toMatchObject({ ok: false });
    }
    expect(fixture.requests).toHaveLength(0);
  });
});
