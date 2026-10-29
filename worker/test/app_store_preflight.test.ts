import { describe, expect, it } from "vitest";
import {
  PREFLIGHT_RULES,
  evaluatePreflight,
  type PreflightSnapshot,
  type Read,
} from "../src/lib/app_store_preflight";
import { parseAssociatedErrors } from "../src/lib/asc_api";

/**
 * The preflight rules are a pure function over a snapshot of Apple's state, so they
 * are tested here without fetch. The fixture is modelled on raft-ios 1.17.0 as it
 * stood on 2026-10-29 before the zh-Hans/ja supportUrl fix: Apple refused the submit
 * with associatedErrors naming exactly those two localizations.
 */

const ok = <T>(value: T): Read<T> => ({ ok: true, value });
const failed = (status: number, code: string, detail: string): Read<never> => ({ ok: false, error: { status, code, title: "An unexpected error occurred.", detail } });

const VERSION_ID = "ebb676c0-c99e-49c0-9279-4ce16d08d86d";
const LOC = { en: "loc-en-US-0001", zh: "loc-zh-Hans-0002", ja: "loc-ja-0003" };

function shots(prefix: string, n = 8, state = "COMPLETE") {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, state, fileName: `${String(i + 1).padStart(2, "0")}.png` }));
}
function iphoneSets(locale: string) {
  return ok([
    { id: `set-${locale}-67`, displayType: "APP_IPHONE_67", screenshots: shots(`shot-${locale}-67`) },
    { id: `set-${locale}-65`, displayType: "APP_IPHONE_65", screenshots: shots(`shot-${locale}-65`) },
  ]);
}
const fullFields = (locale: string) => ({
  description: `Raft ${locale} description`,
  keywords: "chat,agents,raft",
  promotionalText: null,
  marketingUrl: "https://raft.build",
  supportUrl: "https://docs.raft.build/support/",
  whatsNew: "Bug fixes",
});

/** A snapshot Apple would accept. */
function complete(): PreflightSnapshot {
  return {
    version: { id: VERSION_ID, versionString: "1.17.0", state: "PREPARE_FOR_SUBMISSION", platform: "IOS",
      copyright: "2026 Botiverse", buildId: "build-117", buildRelationshipReturned: true },
    primaryLocale: ok("en-US"),
    build: ok({ id: "build-117", buildNumber: "3", marketingVersion: "1.17.0", processingState: "VALID", expired: false, usesNonExemptEncryption: false }),
    localizations: ok([
      { id: LOC.en, locale: "en-US", fields: fullFields("en-US") },
      { id: LOC.zh, locale: "zh-Hans", fields: fullFields("zh-Hans") },
      { id: LOC.ja, locale: "ja", fields: fullFields("ja") },
    ]),
    screenshotSets: { [LOC.en]: iphoneSets("en"), [LOC.zh]: iphoneSets("zh"), [LOC.ja]: iphoneSets("ja") },
    appInfo: ok({ id: "appinfo-1", state: "PREPARE_FOR_SUBMISSION" }),
    appInfoLocalizations: ok([
      { id: "ail-en", locale: "en-US", name: "Raft", privacyPolicyUrl: "https://raft.build/privacy" },
      { id: "ail-zh", locale: "zh-Hans", name: "Raft", privacyPolicyUrl: "https://raft.build/privacy" },
      { id: "ail-ja", locale: "ja", name: "Raft", privacyPolicyUrl: "https://raft.build/privacy" },
    ]),
    ageRating: ok({ id: "age-1" }),
    reviewDetail: ok({ id: "rd-1", contactFirstName: "A", contactLastName: "B", contactPhone: "+1 555 0100", contactEmail: "review@example.com",
      demoAccountRequired: true, demoAccountNamePresent: true, demoAccountPasswordPresent: true }),
    submissions: ok([]),
  };
}

/** raft-ios 1.17.0 before the fix: zh-Hans and ja were created without supportUrl. */
function raft117(): PreflightSnapshot {
  const s = complete();
  s.localizations = ok([
    { id: LOC.en, locale: "en-US", fields: fullFields("en-US") },
    { id: LOC.zh, locale: "zh-Hans", fields: { ...fullFields("zh-Hans"), supportUrl: null, marketingUrl: null } },
    { id: LOC.ja, locale: "ja", fields: { ...fullFields("ja"), supportUrl: null, marketingUrl: null } },
  ]);
  s.submissions = ok([{ id: "sub-draft", state: "READY_FOR_REVIEW", platform: "IOS", versionId: null }]);
  return s;
}

/**
 * What Apple answered to the 1.17.0 submit, in its errors[].meta.associatedErrors
 * shape. Reconstructed from the incident notes (resource per localization, code
 * ENTITY_ERROR.ATTRIBUTE.REQUIRED, Apple's wording); replace with the recorded body
 * once one is saved under fixtures/asc/.
 */
const APPLE_1_17_0_ERRORS = [{
  status: "409", code: "STATE_ERROR.ENTITY_STATE_INVALID", title: "appStoreVersions with id 'ebb676c0' is not in valid state.",
  detail: "This resource cannot be reviewed, please check associated errors to see why.",
  meta: { associatedErrors: {
    [`/v1/appStoreVersionLocalizations/${LOC.zh}`]: [{ code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", detail: "You must provide a value for the attribute 'supportUrl' with this request" }],
    [`/v1/appStoreVersionLocalizations/${LOC.ja}`]: [{ code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", detail: "You must provide a value for the attribute 'supportUrl' with this request" }],
  } },
}];

const errorsOf = (s: PreflightSnapshot) => evaluatePreflight(s).findings.filter((f) => f.severity === "error");
const checksOf = (s: PreflightSnapshot, check: string) => evaluatePreflight(s).findings.filter((f) => f.check === check);

describe("App Store preflight rules", () => {
  it("raft-ios 1.17.0: reports exactly the blockers Apple returned, on the same resources", () => {
    const report = evaluatePreflight(raft117());
    expect(report.ready).toBe(false);
    const errors = report.findings.filter((f) => f.severity === "error");
    const apple = parseAssociatedErrors(APPLE_1_17_0_ERRORS);
    expect(errors.map((e) => e.resource).sort()).toEqual(apple.map((a) => a.resource).sort());
    for (const e of errors) {
      const match = apple.find((a) => a.resource === e.resource)!;
      expect(match.detail!.startsWith(e.message)).toBe(true);
    }
    expect(errors).toEqual([
      expect.objectContaining({ check: "localization_required_fields", locale: "zh-Hans", resource: `/v1/appStoreVersionLocalizations/${LOC.zh}`, message: "You must provide a value for the attribute 'supportUrl'" }),
      expect.objectContaining({ check: "localization_required_fields", locale: "ja", resource: `/v1/appStoreVersionLocalizations/${LOC.ja}`, message: "You must provide a value for the attribute 'supportUrl'" }),
    ]);
    expect(errors[0]!.fix).toContain('"zh-Hans":{"supportUrl"');
    // The draft left by an earlier attempt is reused, not a blocker.
    expect(checksOf(raft117(), "review_submission")).toEqual([expect.objectContaining({ severity: "info" })]);
  });

  it("a complete version is ready, with every rule run", () => {
    const report = evaluatePreflight(complete());
    expect(report.findings.filter((f) => f.severity !== "info")).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.checked).toEqual(PREFLIGHT_RULES.map((r) => r.id));
    expect(report.not_checkable.map((n) => n.check)).toEqual(expect.arrayContaining(["app_privacy", "pricing_availability"]));
    expect(report).toMatchObject({ version_id: VERSION_ID, version_string: "1.17.0", state: "PREPARE_FOR_SUBMISSION" });
  });

  it("version state: editable passes, submitted is info, anything else is an error", () => {
    for (const state of ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]) {
      const s = complete(); s.version.state = state;
      expect(checksOf(s, "version_state")).toEqual([]);
    }
    for (const state of ["WAITING_FOR_REVIEW", "IN_REVIEW"]) {
      const s = complete(); s.version.state = state;
      expect(checksOf(s, "version_state")).toEqual([expect.objectContaining({ severity: "info", message: expect.stringContaining("already submitted") })]);
    }
    const live = complete(); live.version.state = "READY_FOR_SALE";
    expect(checksOf(live, "version_state")[0]!.severity).toBe("error");
    const unknown = complete(); unknown.version.state = null;
    expect(checksOf(unknown, "version_state")[0]!.severity).toBe("error");
  });

  it("build: none attached, not VALID, expired are errors; another version string is a warning", () => {
    const none = complete(); none.version.buildId = null; none.build = null;
    expect(checksOf(none, "build")).toEqual([expect.objectContaining({ severity: "error", message: "no build is attached to this version" })]);
    const processing = complete(); (processing.build as any).value.processingState = "PROCESSING";
    expect(checksOf(processing, "build")).toEqual([expect.objectContaining({ severity: "error", message: expect.stringContaining("PROCESSING, not VALID") })]);
    const expired = complete(); (expired.build as any).value.expired = true;
    expect(checksOf(expired, "build")).toEqual([expect.objectContaining({ severity: "error", message: expect.stringContaining("expired") })]);
    const other = complete(); (other.build as any).value.marketingVersion = "1.16.1";
    expect(checksOf(other, "build")).toEqual([expect.objectContaining({ severity: "warning", message: expect.stringContaining("1.16.1") })]);
    const unknownRel = complete(); unknownRel.version.buildRelationshipReturned = false;
    const r = evaluatePreflight(unknownRel);
    expect(r.not_checkable).toContainEqual(expect.objectContaining({ check: "build" }));
    expect(r.ready).toBe(false);
  });

  it("localizations: description, keywords, supportUrl required per locale in Apple's words; whatsNew is info", () => {
    const s = complete();
    (s.localizations as any).value[0].fields = { ...fullFields("en-US"), description: "  ", keywords: null, whatsNew: "" };
    const findings = checksOf(s, "localization_required_fields");
    expect(findings.map((f) => f.message)).toEqual([
      "You must provide a value for the attribute 'description'",
      "You must provide a value for the attribute 'keywords'",
    ]);
    expect(findings.every((f) => f.severity === "error" && f.resource === `/v1/appStoreVersionLocalizations/${LOC.en}`)).toBe(true);
    expect(checksOf(s, "localization_whats_new")).toEqual([expect.objectContaining({ severity: "info", locale: "en-US", message: expect.stringContaining("first version") })]);
    const none = complete(); none.localizations = ok([]);
    expect(checksOf(none, "localization_required_fields")[0]!.severity).toBe("error");
  });

  it("length limits are warnings at Apple's limits, not one character before", () => {
    const s = complete();
    (s.localizations as any).value[0].fields = { ...fullFields("en-US"), description: "x".repeat(4000), keywords: "k".repeat(101), promotionalText: "p".repeat(171), whatsNew: "😀".repeat(4001) };
    const findings = checksOf(s, "localization_lengths");
    expect(findings.map((f) => f.message)).toEqual([
      "keywords is 101 characters; App Store Connect allows 100",
      "promotionalText is 171 characters; App Store Connect allows 170",
      "whatsNew is 4001 characters; App Store Connect allows 4000",
    ]);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  it("app info: each version locale needs a named appInfoLocalization; privacy URL required on the primary", () => {
    const s = complete();
    s.appInfoLocalizations = ok([
      { id: "ail-en", locale: "en-US", name: "Raft", privacyPolicyUrl: null },
      { id: "ail-zh", locale: "zh-Hans", name: "", privacyPolicyUrl: null },
    ]);
    const findings = checksOf(s, "app_info_localizations");
    expect(findings).toEqual([
      expect.objectContaining({ severity: "error", locale: "en-US", resource: "/v1/appInfoLocalizations/ail-en", message: "You must provide a value for the attribute 'privacyPolicyUrl'" }),
      expect.objectContaining({ severity: "error", locale: "zh-Hans", resource: "/v1/appInfoLocalizations/ail-zh", message: "You must provide a value for the attribute 'name'" }),
      expect.objectContaining({ severity: "error", locale: "ja", resource: "/v1/appInfos/appinfo-1", message: expect.stringContaining("no app information") }),
      expect.objectContaining({ severity: "warning", locale: "zh-Hans", message: expect.stringContaining("privacyPolicyUrl") }),
    ]);
    const noInfo = complete(); noInfo.appInfo = ok(null); noInfo.appInfoLocalizations = null; noInfo.ageRating = null;
    expect(checksOf(noInfo, "app_info_localizations")[0]!.severity).toBe("error");
  });

  it("screenshots: primary needs a 6.9\"/6.5\" iPhone set; other locales fall back; every screenshot COMPLETE", () => {
    const s = complete();
    s.screenshotSets[LOC.en] = ok([{ id: "set-en-55", displayType: "APP_IPHONE_55", screenshots: shots("x") }]);
    s.screenshotSets[LOC.zh] = ok([]);
    s.screenshotSets[LOC.ja] = ok([{ id: "set-ja-67", displayType: "APP_IPHONE_67", screenshots: [...shots("ja", 2), { id: "ja-bad", state: "FAILED", fileName: "03.png" }] }]);
    const findings = checksOf(s, "screenshots");
    expect(findings.filter((f) => f.severity === "error")).toEqual([
      expect.objectContaining({ locale: "en-US", display_type: "APP_IPHONE_67", message: expect.stringContaining("primary locale has no") }),
      expect.objectContaining({ locale: "ja", display_type: "APP_IPHONE_67", resource: "/v1/appScreenshots/ja-bad", message: expect.stringContaining("FAILED, not COMPLETE") }),
    ]);
    expect(findings).toContainEqual(expect.objectContaining({ severity: "info", locale: "zh-Hans", message: expect.stringContaining("primary locale's (en-US)") }));
    // An empty 6.9" set does not count.
    const empty = complete(); empty.screenshotSets[LOC.en] = ok([{ id: "e", displayType: "APP_IPHONE_67", screenshots: [] }]);
    expect(errorsOf(empty)).toEqual([expect.objectContaining({ check: "screenshots", locale: "en-US" })]);
    // 6.5" alone satisfies the iPhone requirement.
    const only65 = complete(); only65.screenshotSets[LOC.en] = ok([{ id: "s", displayType: "APP_IPHONE_65", screenshots: shots("s") }]);
    expect(errorsOf(only65)).toEqual([]);
  });

  it("screenshots: iPad unknown is info; an iPad set elsewhere without a 13\" set on the primary is a warning", () => {
    expect(checksOf(complete(), "screenshots")).toEqual([expect.objectContaining({ severity: "info", message: expect.stringContaining("cannot tell whether the build runs on iPad") })]);
    const s = complete();
    s.screenshotSets[LOC.ja] = ok([...(iphoneSets("ja") as any).value, { id: "ipad-11", displayType: "APP_IPAD_PRO_3GEN_11", screenshots: shots("i") }]);
    expect(checksOf(s, "screenshots")).toEqual([expect.objectContaining({ severity: "warning", locale: "en-US", display_type: "APP_IPAD_PRO_3GEN_129" })]);
    s.screenshotSets[LOC.en] = ok([...(iphoneSets("en") as any).value, { id: "ipad-13", displayType: "APP_IPAD_PRO_3GEN_129", screenshots: shots("j") }]);
    expect(checksOf(s, "screenshots")).toEqual([]);
  });

  it("review detail: contact fields required; demo account required needs name and password", () => {
    const s = complete();
    s.reviewDetail = ok({ id: "rd-1", contactFirstName: "A", contactLastName: null, contactPhone: "", contactEmail: "x@y.z",
      demoAccountRequired: true, demoAccountNamePresent: true, demoAccountPasswordPresent: false });
    expect(checksOf(s, "review_detail").map((f) => [f.severity, f.message])).toEqual([
      ["error", "You must provide a value for the attribute 'contactLastName'"],
      ["error", "You must provide a value for the attribute 'contactPhone'"],
      ["error", "demoAccountRequired is true but the demo account name or password is empty"],
    ]);
    const notRequired = complete();
    (notRequired.reviewDetail as any).value = { ...(notRequired.reviewDetail as any).value, demoAccountRequired: false, demoAccountNamePresent: false, demoAccountPasswordPresent: false };
    expect(checksOf(notRequired, "review_detail")).toEqual([]);
    const missing = complete(); missing.reviewDetail = ok(null);
    expect(checksOf(missing, "review_detail")[0]!.severity).toBe("error");
  });

  it("age rating: missing is a warning", () => {
    const s = complete(); s.ageRating = ok(null);
    expect(checksOf(s, "age_rating")).toEqual([expect.objectContaining({ severity: "warning" })]);
  });

  it("review submissions: another version holding the platform is an error; this version is info", () => {
    const other = complete();
    other.submissions = ok([{ id: "sub-rej", state: "UNRESOLVED_ISSUES", platform: "IOS", versionId: ok("ver-116") }]);
    expect(checksOf(other, "review_submission")).toEqual([expect.objectContaining({ severity: "error", resource: "/v1/reviewSubmissions/sub-rej", message: expect.stringContaining("ver-116") })]);
    const mine = complete();
    mine.submissions = ok([{ id: "sub-rej", state: "UNRESOLVED_ISSUES", platform: "IOS", versionId: ok(VERSION_ID) }]);
    expect(checksOf(mine, "review_submission")).toEqual([expect.objectContaining({ severity: "info", message: expect.stringContaining("resubmits") })]);
    const waiting = complete();
    waiting.submissions = ok([{ id: "sub-w", state: "WAITING_FOR_REVIEW", platform: "IOS", versionId: ok("ver-old") }]);
    expect(checksOf(waiting, "review_submission")[0]!.severity).toBe("error");
    // Another platform's submission does not block, and a finished one is ignored.
    const mac = complete();
    mac.submissions = ok([{ id: "m", state: "IN_REVIEW", platform: "MAC_OS", versionId: ok("x") }, { id: "c", state: "COMPLETE", platform: "IOS", versionId: null }]);
    expect(checksOf(mac, "review_submission")).toEqual([]);
    // Holder unknown (items unreadable) is treated as another version: fail closed.
    const unknown = complete();
    unknown.submissions = ok([{ id: "u", state: "UNRESOLVED_ISSUES", platform: "IOS", versionId: failed(400, "PARAMETER_ERROR.INVALID", "bad include") }]);
    expect(checksOf(unknown, "review_submission")[0]!.severity).toBe("error");
    expect(checksOf(unknown, "unreadable:review_submission_items")).toHaveLength(1);
  });

  it("an unreadable resource is a warning naming Apple's error, skips its rules, and keeps ready false", () => {
    const s = complete();
    s.appInfo = failed(403, "FORBIDDEN_ERROR", "The API key in use does not allow this request");
    s.appInfoLocalizations = null;
    s.ageRating = null;
    s.screenshotSets[LOC.ja] = failed(500, "UNEXPECTED_ERROR", "boom");
    const report = evaluatePreflight(s);
    expect(report.findings).toContainEqual(expect.objectContaining({ severity: "warning", check: "unreadable:app_info", message: expect.stringContaining("403 FORBIDDEN_ERROR") }));
    expect(report.findings).toContainEqual(expect.objectContaining({ severity: "warning", check: "unreadable:screenshot_sets", locale: "ja" }));
    expect(report.not_checkable).toContainEqual(expect.objectContaining({ check: "app_info_localizations" }));
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.ready).toBe(false);
    // One unreadable locale alone (every rule still runs, no error) still is not ready.
    const one = complete();
    one.screenshotSets[LOC.ja] = failed(500, "UNEXPECTED_ERROR", "boom");
    const partial = evaluatePreflight(one);
    expect(partial.checked).toEqual(PREFLIGHT_RULES.map((r) => r.id));
    expect(partial.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(partial.ready).toBe(false);
  });
});
