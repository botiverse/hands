import { afterEach, describe, expect, it, vi } from "vitest";
import { installAscFake, makeContext, realCreds, type AscCall } from "./asc_fake";

let cachedCreds: Awaited<ReturnType<typeof realCreds>> | null = null;
vi.mock("../src/lib/asc_credentials", () => ({ getAscCredentials: async () => (cachedCreds ??= await realCreds()) }));
vi.mock("../src/lib/asc_api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/asc_api")>()), resolveAscAppId: async () => "asc-app-1" }));
const { handlePushAppInfo, normalizeAppInfoInput, pushAppInfoCandidate } = await import("../src/routes/app_store_app_info");

type Loc = { id: string; locale: string; name?: string | null; subtitle?: string | null };
type Options = { versionState?: string; versionString?: string; otherVersions?: Array<{ id: string; platform: string; state: string }>; infos?: Array<{ id: string; state: string }>; locs?: Loc[]; versionLocales?: string[]; unavailableCategoryPlatform?: string; subcategory?: string | null; failLocale?: string; uncertain?: boolean; mangle?: boolean; readbackError?: boolean; pagination?: "foreign" | "path" | "cycle" | "bad-next"; duplicate?: boolean; conflictOnFirst?: boolean; changeOnRecheck?: boolean };
const appInfo = (i: { id: string; state: string }) => ({ type: "appInfos", id: i.id, attributes: { state: i.state } });
function fakeApple(o: Options = {}) {
  const locs: Loc[] = (o.locs ?? [{ id: "en", locale: "en-US", name: "Old", subtitle: "Old subtitle" }, { id: "zh", locale: "zh-Hans", name: "旧名", subtitle: "旧副标题" }]).map((l) => ({ ...l }));
  let category = "UTILITIES", versionReads = 0, written = false;
  const asc = installAscFake((call: AscCall) => {
    const { method, path, body } = call;
    if (method === "GET" && path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) {
      versionReads++;
      let next: unknown = null;
      if (o.pagination === "foreign") next = "https://api.appstoreconnect.apple.com.evil.test/v1/apps/asc-app-1/appStoreVersions?page=2";
      if (o.pagination === "path") next = "https://api.appstoreconnect.apple.com/v1/apps/other/appStoreVersions?page=2";
      if (o.pagination === "bad-next") next = { url: "bad" };
      if (o.pagination === "cycle") next = "https://api.appstoreconnect.apple.com/v1/apps/asc-app-1/appStoreVersions?limit=200";
      const v = { type: "appStoreVersions", id: "ver-122", attributes: { versionString: o.versionString ?? "1.22.0", platform: "IOS", appVersionState: o.changeOnRecheck && versionReads > 1 ? "WAITING_FOR_REVIEW" : o.versionState ?? "PREPARE_FOR_SUBMISSION" } };
      const other = (o.otherVersions ?? []).map((other) => ({ type: "appStoreVersions", id: other.id, attributes: { versionString: "1.0", platform: other.platform, appVersionState: other.state } }));
      return { json: { data: o.duplicate ? [v, v] : [v, ...other], links: { self: call.url, next } } };
    }
    if (method === "GET" && path.startsWith("/v1/apps/asc-app-1/appInfos?")) return { json: { data: (o.infos ?? [{ id: "live", state: "READY_FOR_DISTRIBUTION" }, { id: "draft", state: "PREPARE_FOR_SUBMISSION" }]).map(appInfo), links: { self: call.url } } };
    if (method === "GET" && path.startsWith("/v1/appStoreVersions/ver-122/appStoreVersionLocalizations?")) return { json: { data: (o.versionLocales ?? ["en-US", "zh-Hans", "ja"]).map((locale) => ({ type: "appStoreVersionLocalizations", id: `version-${locale}`, attributes: { locale } })), links: { self: call.url } } };
    if (method === "GET" && path.startsWith("/v1/appInfos/draft/appInfoLocalizations?")) {
      if (o.readbackError && written) return { status: 500, json: { errors: [{ title: "readback unavailable" }] } };
      return { json: { data: locs.map(({ id, ...attributes }) => ({ type: "appInfoLocalizations", id, attributes: o.mangle && written ? { ...attributes, name: attributes.name ? `${attributes.name}x` : attributes.name } : attributes })), links: { self: call.url } } };
    }
    if (method === "GET" && path === "/v1/appInfos/draft/relationships/primaryCategory") return { json: { data: { type: "appCategories", id: category } } };
    if (method === "GET" && /\/relationships\/primarySubcategory(One|Two)$/.test(path)) return { json: { data: o.subcategory ? { type: "appCategories", id: o.subcategory } : null } };
    if (method === "GET" && path.startsWith("/v1/appCategories?")) {
      const platform = new URL(call.url).searchParams.get("filter[platforms]");
      return { json: { data: (platform === o.unavailableCategoryPlatform ? ["UTILITIES"] : ["UTILITIES", "PRODUCTIVITY"]).map((id) => ({ type: "appCategories", id })), links: { self: call.url } } };
    }
    if (method === "PATCH" && path.startsWith("/v1/appInfoLocalizations/")) {
      const id = path.split("/").pop(), loc = locs.find((l) => l.id === id)!;
      if (o.failLocale === loc.locale || (o.conflictOnFirst && loc.locale === "en-US")) {
        if (o.uncertain) throw new Error("connection lost after request");
        return { status: 409, json: { errors: [{ status: "409", code: "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE", title: "Name is not available", detail: "The name you entered is already in use.", source: { pointer: "/data/attributes/name" } }] } };
      }
      Object.assign(loc, body.data.attributes); written = true; return { json: { data: body.data } };
    }
    if (method === "POST" && path === "/v1/appInfoLocalizations") {
      const { locale, ...fields } = body.data.attributes; const id = `new-${locale}`;
      locs.push({ id, locale, ...fields }); written = true;
      return { status: 201, json: { data: { type: "appInfoLocalizations", id } } };
    }
    if (method === "PATCH" && path === "/v1/appInfos/draft") { category = body.data.relationships.primaryCategory.data.id; written = true; return { json: { data: body.data } }; }
    return undefined;
  });
  return { asc, locs };
}

const desired = { version_string: "1.22.0", primary_category: "PRODUCTIVITY", localizations: { "en-US": { name: "New Name", subtitle: "A subtitle" }, "zh-Hans": { name: "新名称" }, ja: { name: "新しい名前", subtitle: "副題" } } };
async function push(body: unknown = { mode: "dry_run", ...desired }, candidate = true) {
  const ctx = makeContext({ body, params: { versionId: "ver-122" } });
  // Exercise the isolated candidate code as well as the guarded public route.
  // Invalid inputs still go through public parsing so these tests cover validation.
  let input: ReturnType<typeof normalizeAppInfoInput> | undefined;
  if (candidate) {
    try { input = normalizeAppInfoInput(body); } catch { /* handled by the public route */ }
  }
  const res = input ? await pushAppInfoCandidate(ctx.c, input) : await handlePushAppInfo(ctx.c);
  return { status: res.status, json: await res.json() as any, audits: ctx.audits, statements: ctx.statements };
}
afterEach(() => vi.unstubAllGlobals());

describe("App Information", () => {
  it("rejects every public commit before any Apple request, lock, or audit", async () => {
    const { asc } = fakeApple(); const out = await push({ mode: "commit", ...desired }, false);
    expect(out.status).toBe(409); expect(out.json.code).toBe("APP_INFO_COMMIT_UNVERIFIED");
    expect(asc.calls).toEqual([]); expect(out.statements).toEqual([]); expect(out.audits).toEqual([]);
  });
  it("previews all differences with Apple GETs only, warning names are not reserved", async () => {
    const { asc } = fakeApple(); const out = await push({ mode: "dry_run", ...desired }, false);
    expect(out.status).toBe(200); expect(out.json.outcome).toBe("planned");
    expect(out.json).toMatchObject({ app_info: { id: "draft" }, category: { before: "UTILITIES", after: "PRODUCTIVITY", action: "update" }, localizations: [{ locale: "en-US", action: "update" }, { locale: "zh-Hans", action: "update" }, { locale: "ja", action: "create" }] });
    expect(out.json.warning).toContain("not checked or reserved"); expect(asc.writes()).toEqual([]);
    expect(asc.calls.every((c) => !c.path.includes("/v1/appInfos/live/"))).toBe(true);
  });
  it("writes only requested changed fields, creates a locale on the selected info, updates category and reads back", async () => {
    const { asc } = fakeApple(); const out = await push({ mode: "commit", ...desired });
    expect(out.status).toBe(200); expect(out.json).toMatchObject({ ok: true, outcome: "committed", recovery_required: false, readback: { primary_category: "PRODUCTIVITY" } });
    const writes = asc.writes(); expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH /v1/appInfoLocalizations/en", "PATCH /v1/appInfoLocalizations/zh", "POST /v1/appInfoLocalizations", "PATCH /v1/appInfos/draft"]);
    expect(writes[0]!.body.data.attributes).toEqual({ name: "New Name", subtitle: "A subtitle" });
    expect(writes[1]!.body.data.attributes).toEqual({ name: "新名称" });
    expect(writes[2]!.body.data.relationships.appInfo.data.id).toBe("draft");
    expect(writes[3]!.body.data.relationships).toEqual({ primaryCategory: { data: { type: "appCategories", id: "PRODUCTIVITY" } } });
    expect(out.audits.length).toBe(2); expect(JSON.stringify(out.audits)).not.toContain("New Name"); expect(JSON.stringify(out.audits)).not.toContain("新しい名前");
    expect(out.statements.some((s) => s.sql.startsWith("DELETE FROM store_product_locks"))).toBe(true);
  });
  it("is idempotent when Apple already has the requested values", async () => {
    const { asc } = fakeApple(); const out = await push({ mode: "commit", version_string: "1.22.0", localizations: { "en-US": { name: "Old" } }, primary_category: "UTILITIES" });
    expect(out.json.outcome).toBe("no_changes"); expect(asc.writes()).toEqual([]);
  });
  it("retains Apple's conflict reason and reports prior writes and unattempted steps", async () => {
    const { asc } = fakeApple({ failLocale: "zh-Hans" }); const out = await push({ mode: "commit", ...desired });
    expect(out.status).toBe(502); expect(out.json.results.map((r: any) => r.status)).toEqual(["written", "failed", "not_attempted", "not_attempted"]);
    expect(out.json.results[1].error).toMatchObject({ provider_code: "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE", provider_cause: "The name you entered is already in use.", provider_source: "/data/attributes/name" });
    expect(asc.writes().length).toBe(2); expect(out.json.recovery_required).toBe(false);
  });
  it("retains the lock on a lost response, even if a read is successful", async () => {
    fakeApple({ failLocale: "zh-Hans", uncertain: true }); const out = await push({ mode: "commit", ...desired });
    expect(out.json.results.map((r: any) => r.status)).toEqual(["written", "unknown", "not_attempted", "not_attempted"]);
    expect(out.json.recovery_required).toBe(true); expect(out.statements.some((s) => s.sql.startsWith("DELETE FROM store_product_locks"))).toBe(false);
  });
  it("retains the lock when readback differs or fails", async () => {
    fakeApple({ mangle: true }); const mismatch = await push({ mode: "commit", ...desired });
    expect(mismatch.json).toMatchObject({ code: "APP_INFO_READBACK_MISMATCH", recovery_required: true });
    expect(mismatch.json.mismatches.some((m: any) => m.target === "en-US" && m.field === "name")).toBe(true);
    expect(mismatch.statements.some((s) => s.sql.startsWith("DELETE FROM store_product_locks"))).toBe(false);
    fakeApple({ readbackError: true }); const failed = await push({ mode: "commit", ...desired });
    expect(failed.json).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true });
    expect(failed.json.results[0].status).toBe("written");
  });
  it.each([
    [{ versionState: "READY_FOR_DISTRIBUTION" }, "VERSION_NOT_EDITABLE"],
    [{ versionString: "1.21.0" }, "VERSION_CHANGED"],
    [{ infos: [{ id: "live", state: "READY_FOR_DISTRIBUTION" }] }, "APP_INFO_NOT_UNAMBIGUOUS"],
    [{ infos: [{ id: "a", state: "PREPARE_FOR_SUBMISSION" }, { id: "b", state: "PREPARE_FOR_SUBMISSION" }] }, "APP_INFO_NOT_UNAMBIGUOUS"],
    [{ infos: [{ id: "a", state: "PREPARE_FOR_SUBMISSION" }, { id: "b", state: "IN_REVIEW" }] }, "APP_INFO_NOT_UNAMBIGUOUS"],
    [{ infos: [{ id: "a", state: "PREPARE_FOR_SUBMISSION" }, { id: "b", state: "UNKNOWN" }] }, "APP_INFO_NOT_UNAMBIGUOUS"],
    [{ subcategory: "GAMES_ACTION" }, "APP_INFO_PLAN_BLOCKED"],
  ] as Array<[Options, string]>)("fails closed for %j", async (options, code) => {
    const { asc } = fakeApple(options); const out = await push({ mode: "commit", ...desired });
    expect(out.json.code).toBe(code); expect(asc.writes()).toEqual([]);
  });
  it("blocks missing name for create, unknown current fields, and unsupported categories", async () => {
    const { asc } = fakeApple({ locs: [{ id: "en", locale: "en-US", name: "Old" }] });
    const out = await push({ mode: "commit", version_string: "1.22.0", primary_category: "NONEXISTENT", localizations: { "en-US": { subtitle: "New" }, ja: { subtitle: "副題" } } });
    expect(out.json).toMatchObject({ code: "APP_INFO_PLAN_BLOCKED", category: { blocker: "category_not_available_for_platform" }, localizations: [{ blocker: "current_field_not_returned" }, { blocker: "name_required_to_create" }] });
    expect(asc.writes()).toEqual([]);
  });
  it("rejects malformed/unsafe pagination and duplicates rather than using a partial list", async () => {
    for (const options of [{ pagination: "foreign" }, { pagination: "path" }, { pagination: "cycle" }, { pagination: "bad-next" }, { duplicate: true }] as Options[]) {
      const { asc } = fakeApple(options); const out = await push({ mode: "commit", ...desired });
      expect(out.status).toBe(502); expect(asc.writes()).toEqual([]);
    }
  });
  it("checks the category on each platform observed in version records", async () => {
    const { asc } = fakeApple({ otherVersions: [{ id: "mac-live", platform: "MAC_OS", state: "READY_FOR_DISTRIBUTION" }], unavailableCategoryPlatform: "MAC_OS" });
    const out = await push({ mode: "commit", ...desired });
    expect(out.status).toBe(409); expect(out.json.category).toMatchObject({ blocker: "category_not_available_for_platform", unavailable_platforms: ["MAC_OS"] });
    expect(out.json.observed_platforms).toEqual(["IOS", "MAC_OS"]); expect(asc.writes()).toEqual([]);
  });
  it("blocks active or unknown version states on other platforms and unknown platforms", async () => {
    for (const other of [
      { id: "mac-review", platform: "MAC_OS", state: "IN_REVIEW" },
      { id: "tv-draft", platform: "TV_OS", state: "PREPARE_FOR_SUBMISSION" },
      { id: "mac-unknown", platform: "MAC_OS", state: "FUTURE_STATE" },
      { id: "platform-unknown", platform: "FUTURE_OS", state: "READY_FOR_DISTRIBUTION" },
    ]) {
      const { asc } = fakeApple({ otherVersions: [other] }); const out = await push({ mode: "commit", ...desired });
      expect(out.status).toBe(409); expect(out.json.code).toBe(other.platform === "FUTURE_OS" ? "APP_INFO_PLATFORM_UNKNOWN" : "APP_INFO_OTHER_PLATFORM_ACTIVE");
      expect(asc.writes()).toEqual([]);
    }
  });
  it("blocks another active or unknown version on the selected platform", async () => {
    for (const state of ["PREPARE_FOR_SUBMISSION", "IN_REVIEW", "FUTURE_STATE"]) {
      const { asc } = fakeApple({ otherVersions: [{ id: "other-ios", platform: "IOS", state }] });
      const out = await push({ mode: "commit", ...desired });
      expect(out.status).toBe(409);
      expect(out.json).toMatchObject({ code: "APP_INFO_OTHER_VERSION_ACTIVE", other_versions: [{ id: "other-ios", platform: "IOS", state }] });
      expect(asc.writes()).toEqual([]);
    }
  });
  it("blocks new App Information locales absent from the version and reports unmatched locale sets", async () => {
    const { asc } = fakeApple({ versionLocales: ["en-US", "zh-Hans", "fr-FR"] });
    const out = await push({ mode: "commit", ...desired });
    expect(out.status).toBe(409);
    expect(out.json.localizations.find((p: any) => p.locale === "ja").blocker).toBe("version_locale_missing");
    expect(out.json.locale_consistency).toEqual({ missing_app_info: ["fr-FR"], missing_version: [] });
    expect(asc.writes()).toEqual([]);
  });
  it("reports existing App Information locales absent from the version without creating or deleting them", async () => {
    const { asc } = fakeApple({ versionLocales: ["en-US"] });
    const out = await push({ mode: "dry_run", version_string: "1.22.0", localizations: { "en-US": { name: "New Name" } } });
    expect(out.status).toBe(200); expect(out.json.locale_consistency).toEqual({ missing_app_info: [], missing_version: ["zh-Hans"] });
    expect(asc.writes()).toEqual([]);
  });
  it("rechecks editability before any write", async () => {
    const { asc } = fakeApple({ changeOnRecheck: true }); const out = await push({ mode: "commit", ...desired });
    expect(out.json.code).toBe("VERSION_NOT_EDITABLE"); expect(asc.writes()).toEqual([]);
  });
  it("validates input before Apple calls", async () => {
    const { asc } = fakeApple();
    for (const input of [
      { ...desired }, { mode: "commit", ...desired, bad: true }, { mode: "commit", ...desired, version_string: "" },
      { mode: "commit", version_string: "1.22.0", localizations: { ja: { name: "X" } } },
      { mode: "commit", version_string: "1.22.0", localizations: { ja: { name: "x".repeat(31) } } },
      { mode: "commit", version_string: "1.22.0", localizations: { ja: { subtitle: "a\nb" } } },
      { mode: "commit", version_string: "1.22.0", localizations: { ja: { privacyPolicyUrl: "x" } } },
    ]) expect((await push(input)).status).toBe(400);
    expect(asc.calls).toEqual([]);
  });
});
