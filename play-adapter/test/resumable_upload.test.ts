import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPlayAdapterService } from "../src/index";
import {
  DEFAULT_RESUMABLE_CHUNK_BYTES,
  DEFAULT_RESUMABLE_THRESHOLD_BYTES,
  persistedBytes,
  resumableUploadOptions,
} from "../src/resumable_upload";
import type { PlayAdapterEnv, PlayBindingInput, PromotionRpcInput, TrackResource } from "../src/types";

const PACKAGE = "build.raft.app";
const NOW = 1_780_000_000;
const KIB256 = 262_144;
const SESSION = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/build.raft.app/edits/edit-1/apks/42/deobfuscationFiles/proguard?uploadType=resumable&upload_id=session-1";

const aab = new TextEncoder().encode("exact-aab-bytes");
const aabDigest = bytesToHex(sha256(aab));

/** 600,000 bytes: three chunks of 256 KiB, the last one partial. */
const big = new Uint8Array(600_000).map((_, index) => (index * 31 + 7) % 251);
const bigDigest = bytesToHex(sha256(big));
const small = new TextEncoder().encode("com.example.A -> a:\n");
const smallDigest = bytesToHex(sha256(small));

/** Stream in uneven pieces so chunk boundaries never line up with reads. */
function stream(bytes: Uint8Array, piece = 100_003): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + piece));
      offset += piece;
    },
  });
}

/** Small threshold/chunk so a 600 KB file is "large". */
const RESUMABLE_ENV: PlayAdapterEnv = {
  MAX_AAB_SIZE_BYTES: "209715200",
  PLAY_RESUMABLE_UPLOAD_THRESHOLD_BYTES: String(KIB256),
  PLAY_RESUMABLE_CHUNK_BYTES: String(KIB256),
};
const DEFAULT_ENV: PlayAdapterEnv = { MAX_AAB_SIZE_BYTES: "209715200" };

let binding: PlayBindingInput;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  binding = {
    credential: {
      type: "service_account",
      client_email: "tenant-app@example.iam.gserviceaccount.com",
      private_key: await exportPKCS8(pair.privateKey),
      private_key_id: "key-1",
    },
    packageName: PACKAGE,
    tracks: { internal: "qa", closed: "closed-alpha", production: "production" },
  };
});

type ChunkAnswer =
  | { status: number; body?: unknown }
  | { persistOnly: number }
  | { throws: true };

interface FixtureOptions {
  /** Play already holds versionCode 42 with the AAB digest (upload-symbols / existing-bundle path). */
  onPlay?: boolean;
  initiationStatus?: number;
  initiationLocation?: string | null;
  /** Override the answer for the n-th data PUT (0-based). Unlisted PUTs behave normally. */
  chunk?: (index: number) => ChunkAnswer | undefined;
  /** Override the answer for the n-th status query (0-based). */
  query?: (index: number) => ChunkAnswer | undefined;
  simpleStatus?: number;
}

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  bytes: Uint8Array | null;
}

function google(options: FixtureOptions = {}) {
  let nextEdit = 1;
  const requests: Recorded[] = [];
  let track: TrackResource = { track: "qa", releases: [{ versionCodes: ["41"], status: "completed" }] };
  /** What Google holds for the resumable session. */
  let persisted = new Uint8Array(0);
  let declaredTotal = -1;
  let dataPuts = 0;
  let queries = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access-token", expires_in: 3600 });
    const headers = new Headers(init.headers);
    const bytes = init.body === undefined || init.body === null || typeof init.body === "string"
      ? null
      : new Uint8Array(await new Response(init.body).arrayBuffer());
    requests.push({ url, method, headers, bytes });
    expect(headers.get("authorization")).toBe("Bearer access-token");
    if (method === "POST" && /\/edits$/.test(url)) return Response.json({ id: `edit-${nextEdit++}` });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "GET" && /\/bundles$/.test(url)) {
      return Response.json({ bundles: options.onPlay ? [{ versionCode: 42, sha256: aabDigest }] : [] });
    }
    if (url.includes("/bundles?uploadType=media")) return Response.json({ versionCode: 42, sha256: bytesToHex(sha256(bytes!)) });
    if (method === "GET" && url.includes("/tracks/")) return Response.json(track);
    if (method === "PUT" && url.includes("/tracks/")) {
      track = JSON.parse(String(init.body)) as TrackResource;
      return Response.json(track);
    }
    if (url.includes(":commit?")) return Response.json({ id: "edit-1" });
    if (url.endsWith("?uploadType=media") && url.includes("/deobfuscationFiles/")) {
      if (options.simpleStatus) return Response.json({ error: { code: options.simpleStatus, message: "too big" } }, { status: options.simpleStatus });
      return Response.json({ deobfuscationFile: { symbolType: /deobfuscationFiles\/([A-Za-z]+)/.exec(url)![1] } });
    }
    if (method === "POST" && url.endsWith("?uploadType=resumable")) {
      declaredTotal = Number(headers.get("x-upload-content-length"));
      persisted = new Uint8Array(0);
      const status = options.initiationStatus ?? 200;
      if (status !== 200) return Response.json({ error: { code: status, message: "provider prose" } }, { status });
      const location = options.initiationLocation === undefined ? SESSION : options.initiationLocation;
      return new Response(null, { status: 200, headers: location ? { location } : {} });
    }
    if (method === "PUT" && url === SESSION) {
      const range = headers.get("content-range") ?? "";
      const progress = () => persisted.byteLength === declaredTotal
        ? Response.json({ deobfuscationFile: { symbolType: "proguard" } })
        : new Response(null, { status: 308, headers: persisted.byteLength ? { range: `bytes=0-${persisted.byteLength - 1}` } : {} });
      const answer = (override: ChunkAnswer | undefined, data: Uint8Array | null): Response => {
        if (override && "throws" in override) throw new TypeError("network lost");
        if (override && "status" in override) {
          return override.body === undefined ? new Response(null, { status: override.status }) : Response.json(override.body, { status: override.status });
        }
        if (data) {
          const keep = override && "persistOnly" in override ? override.persistOnly : data.byteLength;
          const next = new Uint8Array(persisted.byteLength + keep);
          next.set(persisted);
          next.set(data.subarray(0, keep), persisted.byteLength);
          persisted = next;
        }
        return progress();
      };
      if (range === `bytes */${declaredTotal}`) {
        expect(headers.get("content-length")).toBe("0");
        return answer(options.query?.(queries++), null);
      }
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      expect(match).not.toBeNull();
      const [start, end, total] = [Number(match![1]), Number(match![2]), Number(match![3])];
      expect(total).toBe(declaredTotal);
      expect(start).toBe(persisted.byteLength);
      expect(bytes!.byteLength).toBe(end - start + 1);
      expect(headers.get("content-length")).toBe(String(bytes!.byteLength));
      return answer(options.chunk?.(dataPuts++), bytes);
    }
    return Response.json({ error: "unexpected request" }, { status: 500 });
  });
  const sessionPuts = () => requests.filter((request) => request.method === "PUT" && request.url === SESSION);
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    requests,
    persisted: () => persisted,
    sessionPuts,
    ranges: () => sessionPuts().map((request) => request.headers.get("content-range")),
    steps: () => requests.map((request) => {
      if (request.method === "POST" && /\/edits$/.test(request.url)) return "create";
      if (request.url.includes(":commit?")) return "commit";
      if (request.method === "DELETE") return "delete";
      if (request.url.endsWith("?uploadType=resumable")) return "initiate";
      if (request.url === SESSION) return "chunk";
      if (request.url.includes("/deobfuscationFiles/")) return "simple";
      if (request.url.includes("/bundles?uploadType=media")) return "bundle";
      return null;
    }).filter(Boolean),
  };
}

function service(fixture: ReturnType<typeof google>) {
  return createPlayAdapterService({ fetchImpl: fixture.fetchImpl, nowSeconds: () => NOW, resumableRetryDelayMs: 0 });
}

function uploadInput(declared: { expectedSha256: string; expectedSize: number }) {
  return {
    credential: binding.credential, packageName: PACKAGE, mode: "commit" as const, versionCode: 42,
    expectedSha256: aabDigest, operationId: "operation-1", mapping: declared, symbols: null,
  };
}

function promotion(mapping: { expectedSha256: string; expectedSize: number }): PromotionRpcInput {
  return {
    ...binding, handsTrack: "internal", versionCode: 42, expectedSha256: aabDigest, expectedSize: aab.byteLength,
    rolloutPercent: 100, operationId: "operation-2", mapping,
  };
}

const BIG = { expectedSha256: bigDigest, expectedSize: big.byteLength };

describe("resumable upload configuration", () => {
  it("defaults to 32 MiB threshold and 8 MiB chunks", () => {
    expect(resumableUploadOptions({})).toMatchObject({ thresholdBytes: 33_554_432, chunkBytes: 8_388_608 });
    expect(DEFAULT_RESUMABLE_THRESHOLD_BYTES).toBe(33_554_432);
    expect(DEFAULT_RESUMABLE_CHUNK_BYTES).toBe(8_388_608);
  });

  it("accepts valid values and falls back to the default for invalid ones", () => {
    expect(resumableUploadOptions({ PLAY_RESUMABLE_UPLOAD_THRESHOLD_BYTES: "1000", PLAY_RESUMABLE_CHUNK_BYTES: "524288" }))
      .toMatchObject({ thresholdBytes: 1000, chunkBytes: 524_288 });
    for (const chunk of ["1000000", "0", "-262144", "abc", "262144.5", ""]) {
      expect(resumableUploadOptions({ PLAY_RESUMABLE_CHUNK_BYTES: chunk }).chunkBytes).toBe(DEFAULT_RESUMABLE_CHUNK_BYTES);
    }
    for (const threshold of ["0", "-1", "1e9", "x"]) {
      expect(resumableUploadOptions({ PLAY_RESUMABLE_UPLOAD_THRESHOLD_BYTES: threshold }).thresholdBytes).toBe(DEFAULT_RESUMABLE_THRESHOLD_BYTES);
    }
  });

  it("parses Google's 308 Range header", () => {
    expect(persistedBytes(null)).toBe(0);
    expect(persistedBytes("bytes=0-262143")).toBe(262_144);
    expect(persistedBytes("bytes=5-10")).toBeNull();
    expect(persistedBytes("garbage")).toBeNull();
  });

  it("a bad chunk size in env falls back to 8 MiB chunks on the wire", async () => {
    const fixture = google({ onPlay: true });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG),
      { ...RESUMABLE_ENV, PLAY_RESUMABLE_CHUNK_BYTES: "300000" }, stream(big), null);
    expect(result).toMatchObject({ ok: true });
    // One PUT: the 8 MiB default chunk holds the whole 600 KB file.
    expect(fixture.ranges()).toEqual(["bytes 0-599999/600000"]);
  });
});

describe("deobfuscation upload below the threshold", () => {
  it("keeps the simple media upload request unchanged", async () => {
    const fixture = google({ onPlay: true });
    const result = await service(fixture).uploadDeobfuscation(
      uploadInput({ expectedSha256: smallDigest, expectedSize: small.byteLength }), RESUMABLE_ENV, stream(small), null);
    expect(result).toMatchObject({ ok: true, value: { files: [{ symbol_type: "proguard", uploaded: true, sha256: smallDigest }] } });
    const upload = fixture.requests.find((request) => request.url.includes("/deobfuscationFiles/"))!;
    expect(upload.url).toBe(`https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}/edits/edit-1/apks/42/deobfuscationFiles/proguard?uploadType=media`);
    expect(upload.method).toBe("POST");
    expect([...upload.headers.keys()].sort()).toEqual(["authorization", "content-type"]);
    expect(upload.headers.get("content-type")).toBe("application/octet-stream");
    expect(upload.bytes).toEqual(small);
    expect(fixture.steps()).toEqual(["create", "simple", "commit"]);
  });

  it("uses the simple upload for a 600 KB file under the default 32 MiB threshold", async () => {
    const fixture = google({ onPlay: true });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), DEFAULT_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: true });
    expect(fixture.steps()).toEqual(["create", "simple", "commit"]);
  });

  it("reads a 413 on the simple upload as play_upload_too_large and deletes the edit", async () => {
    const fixture = google({ onPlay: true, simpleStatus: 413 });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), DEFAULT_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: false, error: { code: "play_upload_too_large", cause: { stage: "upload_mapping" } } });
    expect(result.ok || result.error.message).toContain("http_status=413");
    expect(fixture.steps()).toEqual(["create", "simple", "delete"]);
  });
});

describe("deobfuscation upload at or above the threshold (resumable)", () => {
  it("initiates a session, PUTs 256 KiB-multiple chunks with Content-Range, follows 308s and parses the final answer", async () => {
    const fixture = google({ onPlay: true });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: true, value: {
      mode: "commit", files: [{ symbol_type: "proguard", sha256: bigDigest, size_bytes: 600_000, uploaded: true, edit: "upload_deobfuscation" }],
    } });
    const initiation = fixture.requests.find((request) => request.url.endsWith("?uploadType=resumable"))!;
    expect(initiation.url).toBe(`https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}/edits/edit-1/apks/42/deobfuscationFiles/proguard?uploadType=resumable`);
    expect(initiation.method).toBe("POST");
    expect(initiation.headers.get("x-upload-content-type")).toBe("application/octet-stream");
    expect(initiation.headers.get("x-upload-content-length")).toBe("600000");
    expect(initiation.headers.get("content-type")).toBe("application/json; charset=UTF-8");
    expect(fixture.ranges()).toEqual([
      "bytes 0-262143/600000",
      "bytes 262144-524287/600000",
      "bytes 524288-599999/600000",
    ]);
    expect(bytesToHex(sha256(fixture.persisted()))).toBe(bigDigest);
    expect(fixture.steps()).toEqual(["create", "initiate", "chunk", "chunk", "chunk", "commit"]);
  });

  it("resumes from the persisted offset when a 308 Range reports fewer bytes than were sent", async () => {
    const fixture = google({ onPlay: true, chunk: (index) => index === 0 ? { persistOnly: 100_000 } : undefined });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: true, value: { files: [{ uploaded: true, sha256: bigDigest }] } });
    expect(fixture.ranges()).toEqual([
      "bytes 0-262143/600000",
      "bytes 100000-362143/600000",
      "bytes 362144-599999/600000",
    ]);
    expect(bytesToHex(sha256(fixture.persisted()))).toBe(bigDigest);
  });

  it("queries the session after a 5xx or a network error and resumes", async () => {
    const fixture = google({
      onPlay: true,
      chunk: (index) => index === 1 ? { status: 503 } : index === 2 ? { throws: true } : undefined,
    });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: true, value: { files: [{ uploaded: true, sha256: bigDigest }] } });
    expect(fixture.ranges()).toEqual([
      "bytes 0-262143/600000",
      "bytes 262144-524287/600000", // 503
      "bytes */600000",
      "bytes 262144-524287/600000", // network error
      "bytes */600000",
      "bytes 262144-524287/600000",
      "bytes 524288-599999/600000",
    ]);
    expect(bytesToHex(sha256(fixture.persisted()))).toBe(bigDigest);
  });

  it("accepts a status query that reports the upload already complete after the final chunk's answer was lost", async () => {
    const fixture = google({ onPlay: true, chunk: (index) => index === 2 ? { persistOnly: 600_000 - 524_288 } : undefined });
    // Persist the last chunk but lose its answer: make the fixture throw AFTER persisting.
    const inner = fixture.fetchImpl;
    let lost = false;
    const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await inner(input, init);
      if (!lost && new Headers(init?.headers).get("content-range") === "bytes 524288-599999/600000") {
        lost = true;
        throw new TypeError("connection reset after upload");
      }
      return response;
    }) as typeof fetch;
    const adapter = createPlayAdapterService({ fetchImpl: wrapped, nowSeconds: () => NOW, resumableRetryDelayMs: 0 });
    const result = await adapter.uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: true, value: { files: [{ uploaded: true }] } });
    expect(fixture.ranges().at(-1)).toBe("bytes */600000");
    expect(fixture.steps().at(-1)).toBe("commit");
  });

  it("fails play_upload_interrupted when chunks keep failing beyond the retry budget, and deletes the edit", async () => {
    const fixture = google({ onPlay: true, chunk: (index) => index >= 1 ? { status: 503 } : undefined });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: false, error: { status: 502, code: "play_upload_interrupted", cause: { stage: "upload_mapping" } } });
    // 1 good chunk, then 4 failed attempts of chunk 2 (first + 3 retries), each retry preceded by a status query.
    expect(fixture.ranges().filter((range) => range === "bytes 262144-524287/600000")).toHaveLength(4);
    expect(fixture.ranges().filter((range) => range === "bytes */600000")).toHaveLength(3);
    expect(fixture.steps().at(-1)).toBe("delete");
    expect(fixture.steps()).not.toContain("commit");
  });

  it("fails play_upload_interrupted on a 4xx session answer (expired session) without retrying", async () => {
    const fixture = google({ onPlay: true, chunk: (index) => index === 1 ? { status: 404, body: { error: { code: 404 } } } : undefined });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: false, error: { code: "play_upload_interrupted" } });
    expect(fixture.ranges()).toHaveLength(2);
    expect(fixture.steps()).toEqual(["create", "initiate", "chunk", "chunk", "delete"]);
  });

  it("fails play_upload_incomplete when Google reports progress before the held chunk", async () => {
    const fixture = google({ onPlay: true, chunk: (index) => index === 1 ? { status: 308 } : undefined });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
    // 308 without Range = 0 bytes persisted, but bytes 0..262143 are no longer held.
    expect(result).toMatchObject({ ok: false, error: { code: "play_upload_incomplete" } });
    expect(fixture.steps().at(-1)).toBe("delete");
  });

  it("fails play_upload_incomplete when Google answers 200 before every byte was sent", async () => {
    const fixture = google({ onPlay: true, chunk: (index) => index === 0 ? { status: 200, body: { deobfuscationFile: { symbolType: "proguard" } } } : undefined });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: false, error: { code: "play_upload_incomplete" } });
    expect(fixture.steps()).toEqual(["create", "initiate", "chunk", "delete"]);
  });

  it("maps a 413 on initiation to play_upload_too_large and never sends a chunk", async () => {
    const fixture = google({ onPlay: true, initiationStatus: 413 });
    const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
    expect(result).toMatchObject({ ok: false, error: { status: 502, code: "play_upload_too_large", cause: { stage: "upload_mapping" } } });
    expect(result.ok || result.error.message).not.toContain("provider prose");
    expect(fixture.steps()).toEqual(["create", "initiate", "delete"]);
  });

  it("maps an initiation without Location, a non-200, or a foreign Location to play_upload_session_failed", async () => {
    for (const options of [
      { initiationLocation: null },
      { initiationStatus: 403 },
      { initiationLocation: "https://attacker.example/upload" },
    ] satisfies FixtureOptions[]) {
      const fixture = google({ onPlay: true, ...options });
      const result = await service(fixture).uploadDeobfuscation(uploadInput(BIG), RESUMABLE_ENV, stream(big), null);
      expect(result).toMatchObject({ ok: false, error: { code: "play_upload_session_failed" } });
      expect(fixture.steps()).toEqual(["create", "initiate", "delete"]);
      expect(fixture.requests.some((request) => request.url.includes("attacker"))).toBe(false);
    }
  });

  it("refuses bytes that do not match the declaration before sending the final chunk, and never commits", async () => {
    for (const [declared, body] of [
      [{ expectedSha256: "c".repeat(64), expectedSize: big.byteLength }, stream(big)],
      [BIG, stream(big.slice(0, 599_999))],
      [{ expectedSha256: bigDigest, expectedSize: 599_999 }, stream(big)],
    ] as const) {
      const fixture = google({ onPlay: true });
      const result = await service(fixture).uploadDeobfuscation(uploadInput(declared), RESUMABLE_ENV, body, null);
      expect(result).toMatchObject({ ok: false, error: { status: 409, code: "mapping_integrity_mismatch" } });
      // Google never receives the complete file.
      expect(fixture.persisted().byteLength).toBeLessThan(declared.expectedSize);
      expect(fixture.steps()).not.toContain("commit");
      expect(fixture.steps().at(-1)).toBe("delete");
    }
  });
});

describe("promote with a large mapping", () => {
  it("leaves the AAB upload request unchanged and uploads the mapping resumably in the release edit", async () => {
    const fixture = google();
    const result = await service(fixture).promote(promotion(BIG), new Blob([aab]).stream(), null, RESUMABLE_ENV, stream(big));
    expect(result).toMatchObject({ ok: true, value: { deobfuscation_files: [{ symbol_type: "proguard", uploaded: true, edit: "promotion" }] } });
    const bundle = fixture.requests.find((request) => request.url.includes("/bundles?uploadType=media"))!;
    expect(bundle.url).toBe(`https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}/edits/edit-1/bundles?uploadType=media`);
    expect(bundle.method).toBe("POST");
    expect([...bundle.headers.keys()].sort()).toEqual(["authorization", "content-type"]);
    expect(bundle.headers.get("content-type")).toBe("application/octet-stream");
    expect(bundle.bytes).toEqual(aab);
    expect(fixture.steps()).toEqual(["create", "bundle", "initiate", "chunk", "chunk", "chunk", "commit", "create", "delete"]);
  });

  it.each([
    ["play_upload_too_large", { initiationStatus: 413 }],
    ["play_upload_session_failed", { initiationLocation: null }],
    ["play_upload_interrupted", { chunk: (index: number) => index >= 1 ? { status: 500 } : undefined }],
    ["play_upload_incomplete", { chunk: (index: number) => index === 0 ? { status: 201, body: {} } : undefined }],
  ] as Array<[string, FixtureOptions]>)("fails closed with %s and deletes the release edit", async (code, options) => {
    const fixture = google(options);
    const result = await service(fixture).promote(promotion(BIG), new Blob([aab]).stream(), null, RESUMABLE_ENV, stream(big));
    expect(result).toMatchObject({ ok: false, error: { code, cause: { stage: "upload_mapping" } } });
    expect(fixture.steps()).not.toContain("commit");
    expect(fixture.steps().at(-1)).toBe("delete");
    expect(fixture.requests.some((request) => request.method === "PUT" && request.url.includes("/tracks/"))).toBe(false);
  });

  it("fails closed on a mapping identity mismatch without completing the upload", async () => {
    const fixture = google();
    const result = await service(fixture).promote(
      promotion({ expectedSha256: "d".repeat(64), expectedSize: big.byteLength }), new Blob([aab]).stream(), null, RESUMABLE_ENV, stream(big));
    expect(result).toMatchObject({ ok: false, error: { status: 409, code: "mapping_integrity_mismatch" } });
    expect(fixture.persisted().byteLength).toBeLessThan(big.byteLength);
    expect(fixture.steps()).not.toContain("commit");
    expect(fixture.steps().at(-1)).toBe("delete");
  });

  it("reports an interrupted upload fail-soft when Play already holds the bundle, and still ships the release", async () => {
    const fixture = google({ onPlay: true, chunk: () => ({ status: 503 }) });
    const result = await service(fixture).promote(promotion(BIG), new Blob([aab]).stream(), null, RESUMABLE_ENV, stream(big));
    expect(result).toMatchObject({ ok: true, value: {
      bundle_uploaded: false,
      deobfuscation_files: [{ symbol_type: "proguard", uploaded: false, attempt: "rejected", stage: "upload_mapping",
        error_code: "play_upload_interrupted", edit: "existing_bundle" }],
    } });
    // The side edit is deleted, never committed; the release edit commits once.
    expect(fixture.steps().filter((step) => step === "commit")).toHaveLength(1);
  });
});
