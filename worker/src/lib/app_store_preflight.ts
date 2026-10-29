/**
 * App Store submission preflight: is this version ready for review, and if not, why?
 *
 * Two halves:
 *   - `gatherPreflightSnapshot` reads Apple's state with GET requests only. A read
 *     that fails is recorded as `{ ok: false, error }`, never thrown, so one
 *     unreadable resource does not hide every other finding.
 *   - `evaluatePreflight` is a pure function over that snapshot. Every check is one
 *     row of PREFLIGHT_RULES, so the rules are unit-testable without fetch and the
 *     list of what is checked lives in one place.
 *
 * Resource paths in findings use Apple's own form (`/v1/appStoreVersionLocalizations/<id>`),
 * the same keys Apple uses in `meta.associatedErrors` when a submit is refused, so a
 * preflight finding and a real rejection map to the same fix.
 *
 * ASC field and endpoint names marked [verify] below come from App Store Connect API
 * knowledge, not from a recorded response; check them with a live read-only run.
 */
import {
  AscApiError,
  ascRequest,
  getReviewSubmissionVersionId,
  getScreenshotSetWithScreenshots,
  listReviewSubmissions,
  listScreenshotSets,
  listVersionLocalizations,
  toAppStoreVersion,
  type AscApiCredentials,
  type AscVersionLocalization,
  type RawAppStoreVersion,
  type VersionLocalizationField,
} from "./asc_api";
import { EDITABLE_STATES } from "../routes/app_store_release";
import { LOCALIZATION_LIMITS } from "../routes/app_store_metadata";

// ---------- Snapshot ----------

export interface PreflightReadError {
  status: number;
  code: string | null;
  title: string;
  detail: string | null;
}

/** A read either succeeded (value) or failed with Apple's error. Never thrown. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: PreflightReadError };

export interface PreflightVersion {
  id: string;
  versionString: string | null;
  state: string | null;
  platform: string | null;
  copyright: string | null;
  buildId: string | null;
  /** False when Apple did not return the build relationship: unknown, not "no build". */
  buildRelationshipReturned: boolean;
}

export interface PreflightBuild {
  id: string;
  /** CFBundleVersion (Apple's `builds.version` is the build number). */
  buildNumber: string | null;
  /** CFBundleShortVersionString, from the build's preReleaseVersion.version. [verify] */
  marketingVersion: string | null;
  processingState: string | null;
  expired: boolean | null;
  /** null = not answered on the build (Info.plist key absent and never set). [verify] */
  usesNonExemptEncryption: boolean | null;
}

export interface PreflightScreenshotSet {
  id: string;
  displayType: string | null;
  screenshots: Array<{ id: string; state: string | null; fileName: string | null }>;
}

export interface PreflightAppInfoLocalization {
  id: string;
  locale: string;
  name: string | null;
  privacyPolicyUrl: string | null;
}

/** Review contact and demo account. The password itself is never kept, only whether one is set. */
export interface PreflightReviewDetail {
  id: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  demoAccountRequired: boolean | null;
  demoAccountNamePresent: boolean;
  demoAccountPasswordPresent: boolean;
}

export interface PreflightSubmission {
  id: string;
  state: string | null;
  platform: string | null;
  /** The appStoreVersion it carries; only read for submissions that can block. */
  versionId: Read<string | null> | null;
}

export interface PreflightSnapshot {
  version: PreflightVersion;
  /** apps.primaryLocale. Non-primary locales fall back to the primary's screenshots. */
  primaryLocale: Read<string | null>;
  /** null = no build attached (or the relationship was not returned; see version). */
  build: Read<PreflightBuild> | null;
  localizations: Read<AscVersionLocalization[]>;
  /** Keyed by appStoreVersionLocalization id. */
  screenshotSets: Record<string, Read<PreflightScreenshotSet[]>>;
  /** The appInfo this version's submission would use; value null = Apple listed none. */
  appInfo: Read<{ id: string; state: string | null } | null>;
  /** null when there is no appInfo to read them from. */
  appInfoLocalizations: Read<PreflightAppInfoLocalization[]> | null;
  /** value null = Apple returned no declaration. null = no appInfo to read it from. */
  ageRating: Read<{ id: string } | null> | null;
  /** value null = no review detail exists for this version. */
  reviewDetail: Read<PreflightReviewDetail | null>;
  submissions: Read<PreflightSubmission[]>;
}

// ---------- Findings ----------

export type PreflightSeverity = "error" | "warning" | "info";

export interface PreflightFinding {
  severity: PreflightSeverity;
  check: string;
  locale?: string;
  display_type?: string;
  resource?: string;
  message: string;
  fix?: string;
}

export interface PreflightNotCheckable {
  check: string;
  reason: string;
}

export interface PreflightReport {
  version_id: string;
  version_string: string | null;
  state: string | null;
  /** No error finding, no unreadable resource, and every rule could run. */
  ready: boolean;
  findings: PreflightFinding[];
  checked: string[];
  not_checkable: PreflightNotCheckable[];
}

/** What a rule returns: findings, or "could not run" with the reason. */
type RuleResult = PreflightFinding[] | { skipped: string };

export interface PreflightRule {
  id: string;
  /** Where the rule comes from: an Apple doc, an observed rejection, or a fixture. */
  source: string;
  run: (s: PreflightSnapshot) => RuleResult;
}

const SUBMITTED_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW"]);
/** Review submissions that hold a version and block a new submission for the platform. */
const BLOCKING_SUBMISSION_STATES = new Set(["WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"]);
const DRAFT_SUBMISSION_STATE = "READY_FOR_REVIEW";

/** Apple requires a 6.9" (APP_IPHONE_67 covers 6.7" and 6.9") or a 6.5" iPhone set. */
export const REQUIRED_IPHONE_DISPLAY_TYPES = ["APP_IPHONE_67", "APP_IPHONE_65"];
/** 13" / 12.9" iPad; APP_IPAD_PRO_129 (2nd gen) has the same pixel size. */
export const REQUIRED_IPAD_DISPLAY_TYPES = ["APP_IPAD_PRO_3GEN_129", "APP_IPAD_PRO_129"];

/** Fields Apple requires on every appStoreVersionLocalization before review. */
export const REQUIRED_VERSION_LOCALIZATION_FIELDS: VersionLocalizationField[] = ["description", "keywords", "supportUrl"];
const LENGTH_CHECKED_FIELDS: VersionLocalizationField[] = ["description", "keywords", "promotionalText", "whatsNew"];

const blank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === "";
const locPath = (id: string) => `/v1/appStoreVersionLocalizations/${id}`;
const listingFix = (locale: string, field: string) =>
  `hands app-store localizations push <app> --version-name <version> --file listing.json --commit  # {"${locale}":{"${field}":"..."}}`;

function primaryOf(s: PreflightSnapshot): string | null {
  return s.primaryLocale.ok ? s.primaryLocale.value : null;
}

/** iPad support, conservatively: "yes" only when the version already has an iPad set somewhere. */
export function ipadSupport(s: PreflightSnapshot): "yes" | "unknown" {
  for (const sets of Object.values(s.screenshotSets)) {
    if (sets.ok && sets.value.some((set) => set.displayType?.startsWith("APP_IPAD"))) return "yes";
  }
  return "unknown";
}

export const PREFLIGHT_RULES: PreflightRule[] = [
  {
    id: "version_state",
    source: "Apple AppVersionState; Hands EDITABLE_STATES (routes/app_store_release.ts)",
    run: (s) => {
      const state = s.version.state;
      if (state && EDITABLE_STATES.has(state)) return [];
      if (state && SUBMITTED_STATES.has(state)) {
        return [{ severity: "info", check: "version_state", resource: `/v1/appStoreVersions/${s.version.id}`,
          message: `version is ${state}: already submitted for review` }];
      }
      return [{ severity: "error", check: "version_state", resource: `/v1/appStoreVersions/${s.version.id}`,
        message: `version is ${state ?? "in an unknown state"}; only PREPARE_FOR_SUBMISSION, DEVELOPER_REJECTED, REJECTED, METADATA_REJECTED or INVALID_BINARY can be submitted` }];
    },
  },
  {
    id: "build",
    source: "Apple: a version needs a VALID, unexpired build of the same CFBundleShortVersionString",
    run: (s) => {
      const resource = `/v1/appStoreVersions/${s.version.id}`;
      if (!s.version.buildRelationshipReturned) return { skipped: "Apple did not return the version's build relationship" };
      if (!s.version.buildId || !s.build) {
        return [{ severity: "error", check: "build", resource, message: "no build is attached to this version",
          fix: "hands app-store prepare <app> --version-name <version> --build <asc-build-id> --commit" }];
      }
      if (!s.build.ok) return { skipped: "build unreadable" };
      const b = s.build.value;
      const out: PreflightFinding[] = [];
      const buildRes = `/v1/builds/${b.id}`;
      if (b.processingState !== "VALID") {
        out.push({ severity: "error", check: "build", resource: buildRes,
          message: `attached build ${b.buildNumber ?? b.id} is ${b.processingState ?? "in an unknown processing state"}, not VALID` });
      }
      if (b.expired === true) {
        out.push({ severity: "error", check: "build", resource: buildRes, message: `attached build ${b.buildNumber ?? b.id} has expired`,
          fix: "attach a newer build with hands app-store prepare --build" });
      }
      if (b.marketingVersion && s.version.versionString && b.marketingVersion !== s.version.versionString) {
        out.push({ severity: "warning", check: "build", resource: buildRes,
          message: `attached build is version ${b.marketingVersion}, the App Store version is ${s.version.versionString}` });
      }
      return out;
    },
  },
  {
    id: "export_compliance",
    source: "Apple: builds.usesNonExemptEncryption (or ITSAppUsesNonExemptEncryption) must be answered",
    run: (s) => {
      if (!s.build) return { skipped: "no build attached" };
      if (!s.build.ok) return { skipped: "build unreadable" };
      if (s.build.value.usesNonExemptEncryption !== null) return [];
      return [{ severity: "warning", check: "export_compliance", resource: `/v1/builds/${s.build.value.id}`,
        message: "the build has no export compliance answer (usesNonExemptEncryption is unset); the version can stall at WAITING_FOR_EXPORT_COMPLIANCE",
        fix: "set ITSAppUsesNonExemptEncryption in Info.plist, or answer it in App Store Connect" }];
    },
  },
  {
    id: "copyright",
    source: "App Store Connect: copyright is required on the version (carried over from the previous version)",
    run: (s) => blank(s.version.copyright)
      ? [{ severity: "warning", check: "copyright", resource: `/v1/appStoreVersions/${s.version.id}`, message: "version has no copyright" }]
      : [],
  },
  {
    id: "localization_required_fields",
    source: "Apple associatedErrors on raft-ios 1.17.0 submit (2026-10-29): ENTITY_ERROR.ATTRIBUTE.REQUIRED supportUrl on zh-Hans/ja",
    run: (s) => {
      if (!s.localizations.ok) return { skipped: "version localizations unreadable" };
      if (s.localizations.value.length === 0) {
        return [{ severity: "error", check: "localization_required_fields", resource: `/v1/appStoreVersions/${s.version.id}`,
          message: "version has no localizations" }];
      }
      const out: PreflightFinding[] = [];
      for (const loc of s.localizations.value) {
        for (const field of REQUIRED_VERSION_LOCALIZATION_FIELDS) {
          if (!blank(loc.fields[field])) continue;
          out.push({ severity: "error", check: "localization_required_fields", locale: loc.locale, resource: locPath(loc.id),
            message: `You must provide a value for the attribute '${field}'`, fix: listingFix(loc.locale, field) });
        }
      }
      return out;
    },
  },
  {
    id: "localization_whats_new",
    source: "Apple: whatsNew is required for an update, not for an app's first version",
    run: (s) => {
      if (!s.localizations.ok) return { skipped: "version localizations unreadable" };
      return s.localizations.value.filter((loc) => blank(loc.fields.whatsNew)).map((loc) => ({
        severity: "info" as const, check: "localization_whats_new", locale: loc.locale, resource: locPath(loc.id),
        message: "whatsNew is empty; Apple requires it unless this is the app's first version (Hands cannot tell)",
        fix: listingFix(loc.locale, "whatsNew"),
      }));
    },
  },
  {
    id: "localization_lengths",
    source: "App Store Connect Help, platform version information (LOCALIZATION_LIMITS)",
    run: (s) => {
      if (!s.localizations.ok) return { skipped: "version localizations unreadable" };
      const out: PreflightFinding[] = [];
      for (const loc of s.localizations.value) {
        for (const field of LENGTH_CHECKED_FIELDS) {
          const value = loc.fields[field];
          if (!value) continue;
          const length = [...value].length;
          if (length > LOCALIZATION_LIMITS[field]) {
            out.push({ severity: "warning", check: "localization_lengths", locale: loc.locale, resource: locPath(loc.id),
              message: `${field} is ${length} characters; App Store Connect allows ${LOCALIZATION_LIMITS[field]}`, fix: listingFix(loc.locale, field) });
          }
        }
      }
      return out;
    },
  },
  {
    id: "app_info_localizations",
    source: "Apple: every version locale needs an appInfoLocalization with a name; privacyPolicyUrl is required for iOS apps",
    run: (s) => {
      if (!s.localizations.ok) return { skipped: "version localizations unreadable" };
      if (!s.appInfo.ok) return { skipped: "appInfo unreadable" };
      if (!s.appInfo.value) {
        return [{ severity: "error", check: "app_info_localizations", message: "Apple listed no appInfo for this app" }];
      }
      if (!s.appInfoLocalizations || !s.appInfoLocalizations.ok) return { skipped: "appInfoLocalizations unreadable" };
      const infos = new Map(s.appInfoLocalizations.value.map((l) => [l.locale, l]));
      const primary = primaryOf(s);
      const out: PreflightFinding[] = [];
      for (const loc of s.localizations.value) {
        const info = infos.get(loc.locale);
        if (!info) {
          out.push({ severity: "error", check: "app_info_localizations", locale: loc.locale, resource: `/v1/appInfos/${s.appInfo.value.id}`,
            message: `no app information (name) for ${loc.locale}; the version has a ${loc.locale} localization`,
            fix: "add the locale's app name in App Store Connect > App Information" });
          continue;
        }
        if (blank(info.name)) {
          out.push({ severity: "error", check: "app_info_localizations", locale: loc.locale, resource: `/v1/appInfoLocalizations/${info.id}`,
            message: "You must provide a value for the attribute 'name'" });
        }
        if (blank(info.privacyPolicyUrl)) {
          // [verify] Whether Apple falls back to the primary locale's privacy policy URL
          // for other locales is not confirmed; only the primary locale is an error.
          const isPrimary = primary === null || primary === loc.locale;
          out.push({ severity: isPrimary ? "error" : "warning", check: "app_info_localizations", locale: loc.locale,
            resource: `/v1/appInfoLocalizations/${info.id}`,
            message: isPrimary
              ? "You must provide a value for the attribute 'privacyPolicyUrl'"
              : "privacyPolicyUrl is empty for this locale (Apple may fall back to the primary locale's)" });
        }
      }
      return out;
    },
  },
  {
    id: "screenshots",
    source: "App Store Connect Help, screenshot specifications: 6.9\"/6.5\" iPhone required; 13\" iPad when the app runs on iPad; other locales fall back to the primary",
    run: (s) => {
      if (!s.localizations.ok) return { skipped: "version localizations unreadable" };
      const primary = primaryOf(s);
      const ipad = ipadSupport(s);
      const out: PreflightFinding[] = [];
      for (const loc of s.localizations.value) {
        // An unreadable locale is reported by unreadableFindings and keeps ready false.
        const read = s.screenshotSets[loc.id];
        if (!read || !read.ok) continue;
        const sets = read.value;
        const filled = (types: string[]) => sets.some((set) => set.displayType && types.includes(set.displayType) && set.screenshots.length > 0);
        // Apple: a locale without its own screenshots shows the primary locale's.
        const isPrimary = primary === loc.locale;
        const res = locPath(loc.id);
        if (!filled(REQUIRED_IPHONE_DISPLAY_TYPES)) {
          if (isPrimary) {
            out.push({ severity: "error", check: "screenshots", locale: loc.locale, display_type: "APP_IPHONE_67", resource: res,
              message: "primary locale has no 6.9\" (APP_IPHONE_67) or 6.5\" (APP_IPHONE_65) iPhone screenshots",
              fix: "hands app-store screenshots push <app> --version-name <version> --dir shots --commit" });
          } else if (primary === null) {
            out.push({ severity: "warning", check: "screenshots", locale: loc.locale, display_type: "APP_IPHONE_67", resource: res,
              message: "no 6.9\"/6.5\" iPhone screenshots; an error if this is the primary locale (primary locale unreadable)" });
          } else if (sets.length === 0) {
            out.push({ severity: "info", check: "screenshots", locale: loc.locale, resource: res,
              message: `no screenshots; App Store shows the primary locale's (${primary})` });
          }
        }
        if (isPrimary || primary === null) {
          if (ipad === "yes" && !filled(REQUIRED_IPAD_DISPLAY_TYPES)) {
            out.push({ severity: "warning", check: "screenshots", locale: loc.locale, display_type: "APP_IPAD_PRO_3GEN_129", resource: res,
              message: "the version has iPad screenshots elsewhere but no 13\" iPad (APP_IPAD_PRO_3GEN_129) set here; Apple requires it when the app runs on iPad" });
          }
        }
        for (const set of sets) {
          for (const shot of set.screenshots) {
            if (shot.state === "COMPLETE") continue;
            out.push({ severity: "error", check: "screenshots", locale: loc.locale, ...(set.displayType ? { display_type: set.displayType } : {}),
              resource: `/v1/appScreenshots/${shot.id}`,
              message: `screenshot ${shot.fileName ?? shot.id} is ${shot.state ?? "in an unknown state"}, not COMPLETE`,
              fix: "re-push the set with hands app-store screenshots push --commit" });
          }
        }
      }
      if (ipad === "unknown") {
        out.push({ severity: "info", check: "screenshots", display_type: "APP_IPAD_PRO_3GEN_129",
          message: "Hands cannot tell whether the build runs on iPad (UIDeviceFamily); if it does, Apple requires 13\" iPad screenshots on the primary locale" });
      }
      return out;
    },
  },
  {
    id: "review_detail",
    source: "Apple: App Review contact (name, phone, email) is required; demo account when sign-in is required",
    run: (s) => {
      if (!s.reviewDetail.ok) return { skipped: "appStoreReviewDetail unreadable" };
      const d = s.reviewDetail.value;
      if (!d) {
        return [{ severity: "error", check: "review_detail", resource: `/v1/appStoreVersions/${s.version.id}`,
          message: "version has no App Review information (contact name, phone, email)",
          fix: "fill App Review Information in App Store Connect" }];
      }
      const out: PreflightFinding[] = [];
      const resource = `/v1/appStoreReviewDetails/${d.id}`;
      for (const field of ["contactFirstName", "contactLastName", "contactPhone", "contactEmail"] as const) {
        if (blank(d[field])) {
          out.push({ severity: "error", check: "review_detail", resource, message: `You must provide a value for the attribute '${field}'` });
        }
      }
      if (d.demoAccountRequired === true && (!d.demoAccountNamePresent || !d.demoAccountPasswordPresent)) {
        out.push({ severity: "error", check: "review_detail", resource,
          message: "demoAccountRequired is true but the demo account name or password is empty" });
      }
      return out;
    },
  },
  {
    id: "age_rating",
    source: "Apple: an age rating declaration is required on the appInfo",
    run: (s) => {
      if (!s.ageRating) return { skipped: "no appInfo to read the age rating from" };
      if (!s.ageRating.ok) return { skipped: "ageRatingDeclaration unreadable" };
      if (s.ageRating.value) return [];
      return [{ severity: "warning", check: "age_rating", message: "no age rating declaration found on the app info",
        fix: "answer the age rating questionnaire in App Store Connect" }];
    },
  },
  {
    id: "review_submission",
    source: "Apple reviewSubmissions: one open submission per platform; UNRESOLVED_ISSUES stays open after a rejection",
    run: (s) => {
      if (!s.submissions.ok) return { skipped: "reviewSubmissions unreadable" };
      const platform = s.version.platform ?? "IOS";
      const out: PreflightFinding[] = [];
      for (const sub of s.submissions.value) {
        if ((sub.platform ?? platform) !== platform || !sub.state) continue;
        const resource = `/v1/reviewSubmissions/${sub.id}`;
        const holder = sub.versionId?.ok ? sub.versionId.value : null;
        const mine = holder === s.version.id;
        if (sub.state === DRAFT_SUBMISSION_STATE) {
          out.push({ severity: "info", check: "review_submission", resource,
            message: "an unsubmitted draft review submission exists; submit will reuse it" });
        } else if (BLOCKING_SUBMISSION_STATES.has(sub.state)) {
          if (mine) {
            out.push({ severity: "info", check: "review_submission", resource,
              message: sub.state === "UNRESOLVED_ISSUES"
                ? "Apple rejected this version (UNRESOLVED_ISSUES); submit resubmits the same submission after the fix"
                : `this version is already in review submission ${sub.id} (${sub.state})` });
          } else {
            out.push({ severity: "error", check: "review_submission", resource,
              message: `review submission ${sub.id} (${sub.state}) holds ${holder ? `version ${holder}` : "another version"} and blocks a new submission for ${platform}`,
              fix: `hands app-store withdraw <app> --version-name <that version> --commit` });
          }
        }
      }
      return out;
    },
  },
];

/** Not readable through the public App Store Connect API, or not read by Hands yet. */
export const PREFLIGHT_NOT_CHECKABLE: PreflightNotCheckable[] = [
  { check: "app_privacy", reason: "App Privacy (data collection) answers are not in the public App Store Connect API; confirm in App Store Connect" },
  { check: "pricing_availability", reason: "price schedule and territory availability are not read by Hands; set once in App Store Connect" },
  { check: "content_rights", reason: "apps.contentRightsDeclaration is not read by Hands yet" },
  { check: "categories", reason: "appInfo primary category is not read by Hands yet" },
];

/** Every failed read becomes one warning, named for what could not be read. */
function unreadableFindings(s: PreflightSnapshot): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const push = (what: string, read: Read<unknown> | null | undefined, resource?: string, locale?: string) => {
    if (!read || read.ok) return;
    const e = read.error;
    out.push({
      severity: "warning", check: `unreadable:${what}`, ...(locale ? { locale } : {}), ...(resource ? { resource } : {}),
      message: `could not read ${what}: ${e.status} ${e.code ?? ""} ${e.title}${e.detail ? ` (${e.detail})` : ""}`.replace(/\s+/g, " ").trim(),
    });
  };
  push("primary_locale", s.primaryLocale);
  push("build", s.build, s.version.buildId ? `/v1/builds/${s.version.buildId}` : undefined);
  push("localizations", s.localizations, `/v1/appStoreVersions/${s.version.id}`);
  if (s.localizations.ok) {
    for (const loc of s.localizations.value) push("screenshot_sets", s.screenshotSets[loc.id], locPath(loc.id), loc.locale);
  }
  push("app_info", s.appInfo);
  push("app_info_localizations", s.appInfoLocalizations);
  push("age_rating", s.ageRating);
  push("review_detail", s.reviewDetail, `/v1/appStoreVersions/${s.version.id}`);
  push("review_submissions", s.submissions);
  if (s.submissions.ok) {
    for (const sub of s.submissions.value) push("review_submission_items", sub.versionId, `/v1/reviewSubmissions/${sub.id}`);
  }
  return out;
}

const SEVERITY_ORDER: Record<PreflightSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Pure: the whole verdict from one snapshot. */
export function evaluatePreflight(s: PreflightSnapshot, rules: PreflightRule[] = PREFLIGHT_RULES): PreflightReport {
  const findings: PreflightFinding[] = unreadableFindings(s);
  const checked: string[] = [];
  const notCheckable: PreflightNotCheckable[] = [...PREFLIGHT_NOT_CHECKABLE];
  for (const rule of rules) {
    const result = rule.run(s);
    if (Array.isArray(result)) {
      checked.push(rule.id);
      findings.push(...result);
    } else {
      notCheckable.push({ check: rule.id, reason: result.skipped });
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const skippedRules = notCheckable.length - PREFLIGHT_NOT_CHECKABLE.length;
  return {
    version_id: s.version.id,
    version_string: s.version.versionString,
    state: s.version.state,
    ready: skippedRules === 0 && !findings.some((f) => f.severity === "error" || f.check.startsWith("unreadable:")),
    findings,
    checked,
    not_checkable: notCheckable,
  };
}

// ---------- Gathering (GET only) ----------

function toReadError(error: unknown): PreflightReadError {
  if (error instanceof AscApiError) {
    return { status: error.status, code: error.code, title: error.message, detail: error.detail };
  }
  return { status: 0, code: null, title: error instanceof Error ? error.message : String(error), detail: null };
}

async function read<T>(fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: toReadError(error) };
  }
}

const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const get = <T>(creds: AscApiCredentials, path: string) => ascRequest<T>(creds, "GET", path);

/** Read the version itself. This one throws: without the version there is nothing to check. */
export async function readPreflightVersion(creds: AscApiCredentials, versionId: string): Promise<PreflightVersion> {
  const res = await get<{ data?: RawAppStoreVersion & { attributes?: { copyright?: unknown } } }>(
    creds, `/v1/appStoreVersions/${encodeURIComponent(versionId)}?include=build`);
  const version = res?.data ? toAppStoreVersion(res.data) : null;
  if (!version) throw new AscApiError(502, "app_store_version_malformed", "App Store Connect returned no version");
  return {
    id: version.id,
    versionString: version.versionString,
    state: version.appVersionState ?? version.appStoreState ?? version.state,
    platform: version.platform,
    copyright: strOrNull(res.data?.attributes?.copyright),
    buildId: version.buildId,
    buildRelationshipReturned: version.buildRelationshipReturned,
  };
}

async function readBuild(creds: AscApiCredentials, buildId: string): Promise<PreflightBuild> {
  // [verify] include=preReleaseVersion on GET /v1/builds/{id}; its `version` attribute
  // is the CFBundleShortVersionString.
  const res = await get<{
    data?: { id?: unknown; attributes?: Record<string, unknown>; relationships?: { preReleaseVersion?: { data?: { id?: unknown } | null } } };
    included?: Array<{ type?: unknown; id?: unknown; attributes?: { version?: unknown } }>;
  }>(creds, `/v1/builds/${encodeURIComponent(buildId)}?include=preReleaseVersion`);
  const a = res?.data?.attributes ?? {};
  const preId = res?.data?.relationships?.preReleaseVersion?.data?.id;
  const pre = (res?.included ?? []).find((i) => i.type === "preReleaseVersions" && (preId === undefined || i.id === preId));
  return {
    id: buildId,
    buildNumber: strOrNull(a.version),
    marketingVersion: strOrNull(pre?.attributes?.version),
    processingState: strOrNull(a.processingState),
    expired: boolOrNull(a.expired),
    usesNonExemptEncryption: boolOrNull(a.usesNonExemptEncryption),
  };
}

async function readScreenshotSets(creds: AscApiCredentials, localizationId: string): Promise<PreflightScreenshotSet[]> {
  const sets = await listScreenshotSets(creds, localizationId);
  const out: PreflightScreenshotSet[] = [];
  for (const set of sets) {
    const shots = await getScreenshotSetWithScreenshots(creds, set.id);
    out.push({ id: set.id, displayType: set.displayType, screenshots: shots.map((s) => ({ id: s.id, state: s.state, fileName: s.fileName })) });
  }
  return out;
}

/**
 * Apple keeps one appInfo per live state plus one being edited. The one a new
 * submission uses is the one not yet live; with a single appInfo, that one.
 * [verify] appInfos.state (AppInfoState) vs the deprecated appStoreState.
 */
const LIVE_APP_INFO_STATES = new Set(["READY_FOR_DISTRIBUTION", "READY_FOR_SALE", "REPLACED_WITH_NEW_INFO"]);
async function readAppInfo(creds: AscApiCredentials, ascAppId: string): Promise<{ id: string; state: string | null } | null> {
  const res = await get<{ data?: Array<{ id?: unknown; attributes?: { state?: unknown; appStoreState?: unknown } }> }>(
    creds, `/v1/apps/${encodeURIComponent(ascAppId)}/appInfos?limit=10`);
  if (!Array.isArray(res?.data)) throw new AscApiError(502, "app_infos_malformed", "App Store Connect returned no appInfo list");
  const infos = res.data
    .filter((i): i is { id: string; attributes?: { state?: unknown; appStoreState?: unknown } } => typeof i.id === "string")
    .map((i) => ({ id: i.id, state: strOrNull(i.attributes?.state) ?? strOrNull(i.attributes?.appStoreState) }));
  return infos.find((i) => !i.state || !LIVE_APP_INFO_STATES.has(i.state)) ?? infos[0] ?? null;
}

async function readAppInfoLocalizations(creds: AscApiCredentials, appInfoId: string): Promise<PreflightAppInfoLocalization[]> {
  const res = await get<{ data?: Array<{ id?: unknown; attributes?: Record<string, unknown> }> }>(
    creds, `/v1/appInfos/${encodeURIComponent(appInfoId)}/appInfoLocalizations?limit=200`);
  if (!Array.isArray(res?.data)) throw new AscApiError(502, "app_info_localizations_malformed", "App Store Connect returned no appInfoLocalization list");
  return res.data
    .filter((l) => typeof l.id === "string" && typeof l.attributes?.locale === "string")
    .map((l) => ({
      id: l.id as string,
      locale: l.attributes!.locale as string,
      name: strOrNull(l.attributes?.name),
      privacyPolicyUrl: strOrNull(l.attributes?.privacyPolicyUrl),
    }));
}

/** A to-one related resource: Apple answers `data: null` (or 404) when none exists. */
async function readToOne<T>(creds: AscApiCredentials, path: string, map: (data: { id: string; attributes: Record<string, unknown> }) => T): Promise<T | null> {
  try {
    const res = await get<{ data?: { id?: unknown; attributes?: Record<string, unknown> } | null }>(creds, path);
    if (!res?.data || typeof res.data.id !== "string") return null;
    return map({ id: res.data.id, attributes: res.data.attributes ?? {} });
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return null;
    throw error;
  }
}

async function readSubmissions(creds: AscApiCredentials, ascAppId: string): Promise<PreflightSubmission[]> {
  const list = await listReviewSubmissions(creds, ascAppId);
  const out: PreflightSubmission[] = [];
  for (const sub of list) {
    const blocking = !!sub.state && BLOCKING_SUBMISSION_STATES.has(sub.state);
    out.push({ ...sub, versionId: blocking ? await read(() => getReviewSubmissionVersionId(creds, sub.id)) : null });
  }
  return out;
}

/**
 * Read everything the rules need. GET only. The version read is the one read that
 * may throw (the caller reports it as a failed preflight); every other failure is
 * recorded in the snapshot.
 */
export async function gatherPreflightSnapshot(
  creds: AscApiCredentials,
  ascAppId: string,
  versionId: string,
): Promise<PreflightSnapshot> {
  const version = await readPreflightVersion(creds, versionId);
  const primaryLocale = await read(async () => {
    const res = await get<{ data?: { attributes?: { primaryLocale?: unknown } } }>(
      creds, `/v1/apps/${encodeURIComponent(ascAppId)}?fields[apps]=primaryLocale`);
    return strOrNull(res?.data?.attributes?.primaryLocale);
  });
  const build = version.buildId ? await read(() => readBuild(creds, version.buildId!)) : null;
  const localizations = await read(() => listVersionLocalizations(creds, versionId));
  const screenshotSets: Record<string, Read<PreflightScreenshotSet[]>> = {};
  if (localizations.ok) {
    for (const loc of localizations.value) screenshotSets[loc.id] = await read(() => readScreenshotSets(creds, loc.id));
  }
  const appInfo = await read(() => readAppInfo(creds, ascAppId));
  const appInfoId = appInfo.ok && appInfo.value ? appInfo.value.id : null;
  const appInfoLocalizations = appInfoId ? await read(() => readAppInfoLocalizations(creds, appInfoId)) : null;
  // [verify] GET /v1/appInfos/{id}/ageRatingDeclaration (moved from appStoreVersions to appInfos by Apple).
  const ageRating = appInfoId
    ? await read(() => readToOne(creds, `/v1/appInfos/${encodeURIComponent(appInfoId)}/ageRatingDeclaration`, (d) => ({ id: d.id })))
    : null;
  const reviewDetail = await read(() => readToOne(creds, `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreReviewDetail`, (d) => ({
    id: d.id,
    contactFirstName: strOrNull(d.attributes.contactFirstName),
    contactLastName: strOrNull(d.attributes.contactLastName),
    contactPhone: strOrNull(d.attributes.contactPhone),
    contactEmail: strOrNull(d.attributes.contactEmail),
    demoAccountRequired: boolOrNull(d.attributes.demoAccountRequired),
    demoAccountNamePresent: !blank(strOrNull(d.attributes.demoAccountName)),
    // Only presence is kept; the password never leaves this function.
    demoAccountPasswordPresent: !blank(strOrNull(d.attributes.demoAccountPassword)),
  })));
  const submissions = await read(() => readSubmissions(creds, ascAppId));
  return { version, primaryLocale, build, localizations, screenshotSets, appInfo, appInfoLocalizations, ageRating, reviewDetail, submissions };
}
