import { afterEach, describe, expect, it, vi } from "vitest";
import { installAscFake, makeContext, realCreds, type AscCall } from "./asc_fake";

let cachedCreds: any = null;
vi.mock("../src/lib/asc_credentials", () => ({
  getAscCredentials: async () => (cachedCreds ??= await realCreds()),
}));
vi.mock("../src/lib/asc_api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/asc_api")>()),
  resolveAscAppId: async () => "asc-app-1",
}));

const { handlePushAppStoreLocalizations } = await import("../src/routes/app_store_metadata");

type Loc = { id: string; locale: string; [field: string]: string | null };

function fakeApple(opts: { versionState?: string; locs?: Loc[]; mangle?: (l: Loc) => Loc; failPatch?: boolean } = {}) {
  const locs: Loc[] = (opts.locs ?? [{ id: "loc-en", locale: "en-US", description: "Old", keywords: "chat", promotionalText: null }]).map((l) => ({ ...l }));
  const asc = installAscFake((call: AscCall) => {
    const { method, path } = call;
    if (method === "GET" && path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) {
      return { json: { data: [{ type: "appStoreVersions", id: "ver-117",
        attributes: { versionString: "1.17.0", appVersionState: opts.versionState ?? "PREPARE_FOR_SUBMISSION" },
        relationships: { build: { data: null } } }] } };
    }
    if (method === "GET" && path.startsWith("/v1/appStoreVersions/ver-117/appStoreVersionLocalizations?")) {
      return { json: { data: locs.map((l) => {
        const { id, ...attributes } = opts.mangle ? opts.mangle(l) : l;
        return { type: "appStoreVersionLocalizations", id, attributes };
      }) } };
    }
    const m = path.match(/^\/v1\/appStoreVersionLocalizations\/([^/?]+)$/);
    if (m && method === "PATCH") {
      if (opts.failPatch) return { status: 409, json: { errors: [{ title: "STATE_ERROR", detail: "not editable" }] } };
      Object.assign(locs.find((l) => l.id === m[1])!, call.body.data.attributes);
      return { json: { data: call.body.data } };
    }
    if (method === "POST" && path === "/v1/appStoreVersionLocalizations") {
      const id = `loc-${call.body.data.attributes.locale}`;
      locs.push({ id, ...call.body.data.attributes });
      return { status: 201, json: { data: { type: "appStoreVersionLocalizations", id } } };
    }
    return undefined;
  });
  return { asc, locs };
}

async function push(body: unknown) {
  const { c, audits } = makeContext({ body, params: { versionId: "ver-117" } });
  const res = await handlePushAppStoreLocalizations(c);
  return { res, json: (await res.json()) as any, audits };
}

afterEach(() => vi.unstubAllGlobals());

describe("App Store listing text", () => {
  it("dry_run plans create/update/unchanged and writes nothing", async () => {
    const { asc } = fakeApple();
    const { res, json } = await push({ mode: "dry_run", localizations: {
      "en-US": { description: "New", keywords: "chat" },
      ja: { description: "説明" },
    } });
    expect(res.status).toBe(200);
    expect(json.outcome).toBe("planned");
    expect(json.localizations).toEqual([
      expect.objectContaining({ locale: "en-US", action: "update", changed_fields: ["description"], before: { description: "Old", keywords: "chat" } }),
      expect.objectContaining({ locale: "ja", action: "create", changed_fields: ["description"] }),
    ]);
    expect(asc.writes()).toEqual([]);
  });

  it("commit PATCHes only changed fields, creates missing locales, and reads back", async () => {
    const { asc } = fakeApple();
    const { res, json, audits } = await push({ mode: "commit", localizations: {
      "en-US": { description: "New", keywords: "chat" },
      ja: { description: "説明", supportUrl: "https://raft.build/support" },
    } });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, outcome: "committed" });
    const writes = asc.writes();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PATCH /v1/appStoreVersionLocalizations/loc-en",
      "POST /v1/appStoreVersionLocalizations",
    ]);
    expect(writes[0]!.body.data.attributes).toEqual({ description: "New" });
    expect(writes[1]!.body.data.relationships.appStoreVersion.data.id).toBe("ver-117");
    // The audit row carries fingerprints, not the text.
    expect(JSON.stringify(audits[0]!.payload)).not.toContain("説明");
  });

  it("fails closed when Apple's read-back differs from what was written", async () => {
    fakeApple({ mangle: (l) => ({ ...l, description: l.description ? `${l.description} ` : null }) });
    const { res, json } = await push({ mode: "commit", localizations: { "en-US": { description: "New" } } });
    expect(res.status).toBe(502);
    expect(json).toMatchObject({ ok: false, code: "READBACK_MISMATCH" });
    expect(json.mismatches[0]).toMatchObject({ locale: "en-US", field: "description" });
  });

  it("reports a failed write as failure and later locales as not attempted", async () => {
    fakeApple({ failPatch: true });
    const { res, json } = await push({ mode: "commit", localizations: { "en-US": { description: "New" }, ja: { description: "x" } } });
    expect(res.status).toBe(502);
    expect(json.code).toBe("LOCALIZATIONS_FAILED");
    expect(json.results.map((r: any) => r.status)).toEqual(["failed", "not_attempted"]);
  });

  it("validates Apple's limits before any call", async () => {
    const { asc } = fakeApple();
    const { res, json } = await push({ mode: "commit", localizations: { "en-US": { keywords: "k".repeat(101) } } });
    expect(res.status).toBe(400);
    expect(json).toMatchObject({ code: "FIELD_TOO_LONG", field: "keywords", limit: 100 });
    expect((await push({ mode: "commit", localizations: { "en-US": { promotionalText: "p".repeat(171) } } })).json.limit).toBe(170);
    expect((await push({ mode: "commit", localizations: { "en-US": { supportUrl: "ftp://x" } } })).json.code).toBe("INVALID_URL");
    expect((await push({ mode: "commit", localizations: { "en-US": { name: "Raft" } } })).json.code).toBe("UNKNOWN_FIELD");
    expect(asc.calls).toEqual([]);
  });

  it("requires an explicit mode", async () => {
    fakeApple();
    const { res, json } = await push({ localizations: { "en-US": { description: "x" } } });
    expect(res.status).toBe(400);
    expect(json.code).toBe("MODE_REQUIRED");
  });

  it("allows only promotionalText while Apple holds the version", async () => {
    const { asc } = fakeApple({ versionState: "WAITING_FOR_REVIEW" });
    const blocked = await push({ mode: "commit", localizations: { "en-US": { description: "New" } } });
    expect(blocked.res.status).toBe(409);
    expect(blocked.json.localizations[0].blocker).toBe("version_not_editable");
    expect(asc.writes()).toEqual([]);
    const promo = await push({ mode: "commit", localizations: { "en-US": { promotionalText: "Now with agents" } } });
    expect(promo.res.status).toBe(200);
    expect(asc.writes().map((w) => w.body.data.attributes)).toEqual([{ promotionalText: "Now with agents" }]);
  });

  it("refuses to create a locale App Store Connect does not offer", async () => {
    const { asc } = fakeApple();
    const { res, json } = await push({ mode: "commit", localizations: { xx: { description: "x" } } });
    expect(res.status).toBe(409);
    expect(json.localizations[0].blocker).toBe("locale_unknown");
    expect(asc.writes()).toEqual([]);
  });
});
