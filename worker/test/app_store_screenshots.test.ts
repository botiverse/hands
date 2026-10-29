import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAscFake, makeContext, png, realCreds, type AscCall } from "./asc_fake";

let cachedCreds: any = null;
vi.mock("../src/lib/asc_credentials", () => ({
  getAscCredentials: async () => (cachedCreds ??= await realCreds()),
}));
vi.mock("../src/lib/asc_api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/asc_api")>()),
  resolveAscAppId: async () => "asc-app-1",
}));

const { handlePushAppStoreScreenshots, SCREENSHOT_POLL } = await import("../src/routes/app_store_metadata");
const { SCREENSHOT_DISPLAY_TYPES, allowedSizes } = await import("../src/lib/app_store_screenshots");

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");

const A = png(1290, 2796, { seed: "a" });
const B = png(1290, 2796, { seed: "b" });
const C = png(1320, 2868, { seed: "c" });

type Shot = { id: string; fileName: string; fileSize: number; checksum: string | null; state: string };

/** Stateful fake of the screenshot resources for one version with one localization. */
function fakeApple(opts: {
  versionState?: string;
  locales?: string[];
  sets?: Array<{ id: string; locale: string; displayType: string; shots: Array<Omit<Shot, "fileName" | "fileSize"> & { fileName?: string }> }>;
  /** Reserved screenshots (1-based creation order) that Apple ends in FAILED. */
  failReserved?: number[];
  omitSetRelationship?: boolean;
} = {}) {
  const locales = (opts.locales ?? ["en-US"]).map((locale) => ({ id: `loc-${locale}`, locale }));
  const shots = new Map<string, Shot>();
  const sets = (opts.sets ?? []).map((s) => {
    for (const shot of s.shots) shots.set(shot.id, { fileName: `${shot.id}.png`, fileSize: 1, ...shot });
    return { id: s.id, locId: `loc-${s.locale}`, displayType: s.displayType, order: s.shots.map((x) => x.id) };
  });
  let reserved = 0;
  const failing = new Set<string>();
  const shotJson = (s: Shot) => ({
    type: "appScreenshots", id: s.id,
    attributes: {
      fileName: s.fileName, fileSize: s.fileSize, sourceFileChecksum: s.checksum,
      assetDeliveryState: { state: s.state, errors: s.state === "FAILED" ? [{ code: "IMAGE_TOOL_FAILURE", description: "could not process" }] : [] },
    },
  });
  const asc = installAscFake((call: AscCall) => {
    const { method, path } = call;
    if (method === "GET" && path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) {
      return { json: { data: [{ type: "appStoreVersions", id: "ver-117",
        attributes: { versionString: "1.17.0", appVersionState: opts.versionState ?? "PREPARE_FOR_SUBMISSION", platform: "IOS" },
        relationships: { build: { data: null } } }] } };
    }
    if (method === "GET" && path.startsWith("/v1/appStoreVersions/ver-117/appStoreVersionLocalizations?")) {
      return { json: { data: locales.map((l) => ({ type: "appStoreVersionLocalizations", id: l.id, attributes: { locale: l.locale } })) } };
    }
    let m = path.match(/^\/v1\/appStoreVersionLocalizations\/([^/]+)\/appScreenshotSets\?/);
    if (m && method === "GET") {
      return { json: { data: sets.filter((s) => s.locId === m![1]).map((s) => ({ type: "appScreenshotSets", id: s.id, attributes: { screenshotDisplayType: s.displayType } })) } };
    }
    m = path.match(/^\/v1\/appScreenshotSets\/([^/?]+)\?(.*)$/);
    if (m && method === "GET") {
      const set = sets.find((s) => s.id === m![1])!;
      return { json: {
        data: { type: "appScreenshotSets", id: set.id,
          ...(opts.omitSetRelationship ? {} : { relationships: { appScreenshots: { data: set.order.map((id) => ({ type: "appScreenshots", id })) } } }) },
        included: set.order.map((id) => shotJson(shots.get(id)!)),
      } };
    }
    if (method === "POST" && path === "/v1/appScreenshotSets") {
      const set = { id: `set-new-${sets.length + 1}`, locId: call.body.data.relationships.appStoreVersionLocalization.data.id,
        displayType: call.body.data.attributes.screenshotDisplayType, order: [] as string[] };
      sets.push(set);
      return { status: 201, json: { data: { type: "appScreenshotSets", id: set.id } } };
    }
    m = path.match(/^\/v1\/appScreenshotSets\/([^/]+)\/relationships\/appScreenshots$/);
    if (m && method === "PATCH") {
      sets.find((s) => s.id === m![1])!.order = call.body.data.map((d: { id: string }) => d.id);
      return { status: 204 };
    }
    if (method === "POST" && path === "/v1/appScreenshots") {
      reserved += 1;
      const id = `shot-new-${reserved}`;
      if (opts.failReserved?.includes(reserved)) failing.add(id);
      const { fileName, fileSize } = call.body.data.attributes;
      shots.set(id, { id, fileName, fileSize, checksum: null, state: "AWAITING_UPLOAD" });
      sets.find((s) => s.id === call.body.data.relationships.appScreenshotSet.data.id)!.order.push(id);
      // Two parts, so the offset/length handling is exercised.
      const half = Math.floor(fileSize / 2);
      return { status: 201, json: { data: { ...shotJson(shots.get(id)!), attributes: { ...shotJson(shots.get(id)!).attributes,
        uploadOperations: [
          { method: "PUT", url: `https://upload.example/${id}/0`, offset: 0, length: half, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
          { method: "PUT", url: `https://upload.example/${id}/1`, offset: half, length: fileSize - half, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
        ] } } } };
    }
    if (method === "PUT" && call.url.startsWith("https://upload.example/")) return { status: 200, json: {} };
    m = path.match(/^\/v1\/appScreenshots\/([^/?]+)$/);
    if (m && method === "PATCH") {
      const shot = shots.get(m[1]!)!;
      shot.checksum = call.body.data.attributes.sourceFileChecksum;
      shot.state = "UPLOAD_COMPLETE";
      return { json: { data: shotJson(shot) } };
    }
    if (m && method === "GET") {
      const shot = shots.get(m[1]!)!;
      if (shot.state === "UPLOAD_COMPLETE") shot.state = failing.has(shot.id) ? "FAILED" : "COMPLETE";
      return { json: { data: shotJson(shot) } };
    }
    if (m && method === "DELETE") {
      shots.delete(m[1]!);
      for (const s of sets) s.order = s.order.filter((id) => id !== m![1]);
      return { status: 204 };
    }
    return undefined;
  });
  return { asc, sets, shots };
}

function multipart(request: unknown, files: Record<string, Uint8Array>) {
  const form = new FormData();
  form.append("request", JSON.stringify(request));
  for (const [name, bytes] of Object.entries(files)) form.append(name, new Blob([bytes], { type: "image/png" }), `${name}.png`);
  return new Request("https://hands.test/screenshots", { method: "POST", body: form });
}

async function push(request: unknown, files: Record<string, Uint8Array>) {
  const { c, audits } = makeContext({ request: multipart(request, files), params: { versionId: "ver-117" } });
  const res = await handlePushAppStoreScreenshots(c);
  return { res, json: (await res.json()) as any, audits };
}

const set = (images: Array<[string, Uint8Array]>, extra: Record<string, unknown> = {}) => ({
  locale: "en-US", display_type: "APP_IPHONE_67", images: images.map(([part, bytes]) => ({ part, sha256: sha(bytes) })), ...extra,
});

beforeEach(() => { SCREENSHOT_POLL.intervalMs = 0; SCREENSHOT_POLL.timeoutMs = 1000; });
afterEach(() => vi.unstubAllGlobals());

describe("screenshot request validation happens before any Apple call", () => {
  it("rejects a size that is not allowed for the display type", async () => {
    const { asc } = fakeApple();
    const wrong = png(1080, 1920);
    const { res, json } = await push({ mode: "dry_run", sets: [set([["f1", wrong]])] }, { f1: wrong });
    expect(res.status).toBe(400);
    expect(json.code).toBe("SCREENSHOT_DIMENSIONS_INVALID");
    expect(json.error).toContain("1290x2796");
    expect(asc.calls).toEqual([]);
  });

  it("accepts landscape of an allowed size", () => {
    expect(allowedSizes("APP_IPHONE_67")).toContainEqual({ width: 2796, height: 1290 });
    expect(allowedSizes("APP_IPHONE_65")).toContainEqual({ width: 1242, height: 2688 });
    expect(allowedSizes("APP_IPAD_PRO_3GEN_129")).toContainEqual({ width: 2048, height: 2732 });
  });

  it("rejects a PNG with transparency", async () => {
    const { asc } = fakeApple();
    const alpha = png(1290, 2796, { alpha: true });
    const { res, json } = await push({ mode: "dry_run", sets: [set([["f1", alpha]])] }, { f1: alpha });
    expect(res.status).toBe(400);
    expect(json.code).toBe("SCREENSHOT_HAS_ALPHA");
    expect(asc.calls).toEqual([]);
  });

  it("rejects an unknown display type and lists Apple's values", async () => {
    fakeApple();
    const { res, json } = await push({ mode: "dry_run", sets: [set([["f1", A]], { display_type: "APP_IPHONE_DUO" })] }, { f1: A });
    expect(res.status).toBe(400);
    expect(json.code).toBe("INVALID_DISPLAY_TYPE");
    expect(json.allowed).toEqual([...SCREENSHOT_DISPLAY_TYPES]);
  });

  it("requires an explicit mode", async () => {
    fakeApple();
    const { res, json } = await push({ sets: [set([["f1", A]])] }, { f1: A });
    expect(res.status).toBe(400);
    expect(json.code).toBe("MODE_REQUIRED");
  });

  it("rejects more than 10 screenshots in a set", async () => {
    fakeApple();
    const files = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, png(1290, 2796, { seed: String(i) })]));
    const { res, json } = await push({ mode: "dry_run", sets: [set(Object.entries(files))] }, files);
    expect(res.status).toBe(400);
    expect(json.code).toBe("SCREENSHOT_COUNT_INVALID");
  });

  it("rejects bytes that do not match the declared sha256", async () => {
    fakeApple();
    const { res, json } = await push({ mode: "dry_run", sets: [{ ...set([["f1", A]]), images: [{ part: "f1", sha256: sha(B) }] }] }, { f1: A });
    expect(res.status).toBe(400);
    expect(json.code).toBe("SCREENSHOT_INTEGRITY_MISMATCH");
  });
});

describe("screenshot plan and commit", () => {
  it("dry_run reads current state with include=appScreenshots, returns the plan, and writes nothing", async () => {
    const { asc } = fakeApple({ sets: [{ id: "set-1", locale: "en-US", displayType: "APP_IPHONE_67", shots: [{ id: "old-1", checksum: "0".repeat(32), state: "COMPLETE" }] }] });
    const { res, json } = await push({ mode: "dry_run", sets: [set([["f1", A], ["f2", B]])] }, { f1: A, f2: B });
    expect(res.status).toBe(200);
    expect(json.outcome).toBe("planned");
    expect(json.writes).toBe(0);
    expect(json.sets[0]).toMatchObject({ action: "replace", screenshot_set_id: "set-1", existing: [{ id: "old-1" }] });
    expect(json.sets[0].desired.map((d: any) => d.md5)).toEqual([md5(A), md5(B)]);
    expect(asc.writes()).toEqual([]);
    expect(asc.calls.find((c) => c.path.startsWith("/v1/appScreenshotSets/set-1"))!.path).toContain("include=appScreenshots");
  });

  it("is idempotent: the same files in the same order, all COMPLETE, cause no write", async () => {
    const { asc } = fakeApple({ sets: [{ id: "set-1", locale: "en-US", displayType: "APP_IPHONE_67", shots: [
      { id: "s1", checksum: md5(A), state: "COMPLETE" }, { id: "s2", checksum: md5(B), state: "COMPLETE" },
    ] }] });
    const { res, json } = await push({ mode: "commit", sets: [set([["f1", A], ["f2", B]])] }, { f1: A, f2: B });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, outcome: "no_changes" });
    expect(json.sets[0].action).toBe("unchanged");
    expect(asc.writes()).toEqual([]);
  });

  it("only reorders when the same files are in another order", async () => {
    const { asc, sets } = fakeApple({ sets: [{ id: "set-1", locale: "en-US", displayType: "APP_IPHONE_67", shots: [
      { id: "s1", checksum: md5(A), state: "COMPLETE" }, { id: "s2", checksum: md5(B), state: "COMPLETE" },
    ] }] });
    const { res, json } = await push({ mode: "commit", sets: [set([["f2", B], ["f1", A]])] }, { f1: A, f2: B });
    expect(res.status).toBe(200);
    expect(json.sets[0]).toMatchObject({ action: "reorder", status: "ok", readback: { md5_order_match: true } });
    expect(asc.writes().map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH /v1/appScreenshotSets/set-1/relationships/appScreenshots"]);
    expect(sets[0]!.order).toEqual(["s2", "s1"]);
  });

  it("replaces a different set: delete, reserve, upload parts, commit with MD5, poll, order, read back", async () => {
    const { asc, sets } = fakeApple({ sets: [{ id: "set-1", locale: "en-US", displayType: "APP_IPHONE_67", shots: [{ id: "old-1", checksum: md5(C), state: "COMPLETE" }] }] });
    const { res, json, audits } = await push({ mode: "commit", sets: [set([["f1", A], ["f2", B]])] }, { f1: A, f2: B });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, outcome: "committed" });
    expect(json.sets[0]).toMatchObject({ action: "replace", status: "ok", deleted: ["old-1"], readback: { md5_order_match: true, all_complete: true, count: 2 } });
    expect(json.sets[0].images.map((i: any) => i.state)).toEqual(["COMPLETE", "COMPLETE"]);
    expect(sets[0]!.order).toEqual(["shot-new-1", "shot-new-2"]);
    const writes = asc.writes().map((w) => `${w.method} ${w.path}`);
    expect(writes[0]).toBe("DELETE /v1/appScreenshots/old-1");
    expect(writes).toContain("POST /v1/appScreenshots");
    expect(writes.at(-1)).toBe("PATCH /v1/appScreenshotSets/set-1/relationships/appScreenshots");
    // Upload parts go to Apple's asset host with Apple's headers and no ASC JWT,
    // and together cover the file exactly.
    const puts = asc.calls.filter((c) => c.method === "PUT" && c.url.includes("shot-new-1"));
    expect(puts).toHaveLength(2);
    expect(puts.every((p) => !p.headers.authorization && p.headers["content-type"] === "image/png")).toBe(true);
    const sent = puts.map((p) => new Uint8Array(p.rawBody as Uint8Array));
    expect(Buffer.concat(sent).equals(Buffer.from(A))).toBe(true);
    const commit = asc.calls.find((c) => c.method === "PATCH" && c.path === "/v1/appScreenshots/shot-new-1")!;
    expect(commit.body.data.attributes).toEqual({ uploaded: true, sourceFileChecksum: md5(A) });
    expect(audits[0]!.payload).toMatchObject({ mode: "commit", outcome: "committed" });
  });

  it("one screenshot ending FAILED makes the whole push a failure with per-image detail", async () => {
    const { asc } = fakeApple({ failReserved: [2] });
    const { res, json, audits } = await push({ mode: "commit", sets: [set([["f1", A], ["f2", B]])] }, { f1: A, f2: B });
    expect(res.status).toBe(502);
    expect(json.ok).toBe(false);
    expect(json.code).toBe("SCREENSHOTS_FAILED");
    expect(json.outcome).toBe("failed");
    expect(json.sets[0].status).toBe("failed");
    expect(json.sets[0].images[0]).toMatchObject({ screenshot_id: "shot-new-1", state: "COMPLETE" });
    expect(json.sets[0].images[1]).toMatchObject({ screenshot_id: "shot-new-2", state: "FAILED" });
    expect(json.sets[0].images[1].errors[0].code).toBe("IMAGE_TOOL_FAILURE");
    // The set was created (none existed), but not ordered as if it had succeeded.
    expect(asc.writes().some((w) => w.path.endsWith("/relationships/appScreenshots"))).toBe(false);
    expect(audits[0]!.payload.outcome).toBe("failed");
  });

  it("stops after the first failed set and reports the rest as not attempted", async () => {
    const { asc } = fakeApple({ locales: ["en-US", "ja"], failReserved: [1] });
    const { res, json } = await push({ mode: "commit", sets: [set([["f1", A]]), set([["f2", B]], { locale: "ja" })] }, { f1: A, f2: B });
    expect(res.status).toBe(502);
    expect(json.sets.map((s: any) => s.status)).toEqual(["failed", "not_attempted"]);
    expect(asc.writes().filter((w) => w.method === "POST" && w.path === "/v1/appScreenshotSets")).toHaveLength(1);
  });

  it("times out instead of waiting forever, and does not claim success", async () => {
    SCREENSHOT_POLL.timeoutMs = 0;
    const { asc } = fakeApple();
    // Never progress past UPLOAD_COMPLETE.
    const fetchImpl = (globalThis.fetch as any).getMockImplementation();
    (globalThis.fetch as any).mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET" && /\/v1\/appScreenshots\/shot-new-\d+$/.test(url)) {
        return new Response(JSON.stringify({ data: { type: "appScreenshots", id: url.split("/").pop(), attributes: { assetDeliveryState: { state: "UPLOAD_COMPLETE" } } } }));
      }
      return fetchImpl(input, init);
    });
    const { res, json } = await push({ mode: "commit", sets: [set([["f1", A]])] }, { f1: A });
    expect(res.status).toBe(502);
    expect(json.sets[0].images[0].state).toBe("TIMEOUT(UPLOAD_COMPLETE)");
    expect(asc.writes().some((w) => w.path.endsWith("/relationships/appScreenshots"))).toBe(false);
  });

  it("refuses with 409 and no writes when the locale has no localization on this version", async () => {
    const { asc } = fakeApple({ locales: ["en-US"] });
    const { res, json } = await push({ mode: "commit", sets: [set([["f1", A]], { locale: "ja" })] }, { f1: A });
    expect(res.status).toBe(409);
    expect(json.code).toBe("SCREENSHOT_PLAN_BLOCKED");
    expect(json.sets[0].blocker).toBe("localization_missing");
    expect(asc.writes()).toEqual([]);
  });

  it("refuses with 409 and no writes while Apple holds the version", async () => {
    const { asc } = fakeApple({ versionState: "WAITING_FOR_REVIEW" });
    const { res, json } = await push({ mode: "commit", sets: [set([["f1", A]])] }, { f1: A });
    expect(res.status).toBe(409);
    expect(json.sets[0].blocker).toBe("version_not_editable");
    expect(asc.writes()).toEqual([]);
  });

  it("fails closed when Apple omits the set's screenshot relationship (not asked != empty)", async () => {
    const { asc } = fakeApple({ omitSetRelationship: true, sets: [{ id: "set-1", locale: "en-US", displayType: "APP_IPHONE_67", shots: [{ id: "s1", checksum: md5(A), state: "COMPLETE" }] }] });
    const { res, json } = await push({ mode: "commit", sets: [set([["f1", A]])] }, { f1: A });
    expect(res.status).toBe(502);
    expect(json.code).toBe("ASC_API_REJECTED");
    expect(asc.writes()).toEqual([]);
  });

  it("refuses a version id that is not this app's", async () => {
    const { asc } = fakeApple();
    const { c } = makeContext({ request: multipart({ mode: "commit", sets: [set([["f1", A]])] }, { f1: A }), params: { versionId: "ver-theirs" } });
    const res = await handlePushAppStoreScreenshots(c);
    expect(res.status).toBe(404);
    expect(asc.writes()).toEqual([]);
  });
});
