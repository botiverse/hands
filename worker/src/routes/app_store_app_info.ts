/** App Information is shared by the app's platforms, not a child of a version. */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { AscApiError, type AscApiCredentials } from "../lib/asc_api";
import { ASC_LOCALE_RE } from "../lib/app_store_screenshots";
import { categoryRelationship, listAppInfos, listInfoLocalizations, listOwnedVersions, listPrimaryCategories, listVersionLocales, writeInfoLocalization, writePrimaryCategory, type AppInfo, type InfoField, type InfoLocalization, type StoreVersion } from "../lib/app_store_app_info";
import { insertAuditLog } from "../lib/permissions";
import { APP_STORE_LOCALES } from "./app_store_metadata";
import { ascAppIdFor, errorBody, fail, loadCredentials, type AdminContext } from "./app_store_release";

const EDITABLE_VERSION = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "METADATA_REJECTED", "REJECTED", "INVALID_BINARY"]);
const OTHER_PLATFORM_SAFE_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "PREORDER_READY_FOR_SALE", "REPLACED_WITH_NEW_VERSION", "REMOVED_FROM_SALE", "DEVELOPER_REMOVED_FROM_SALE"]);
const KNOWN_PLATFORMS = new Set(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);
// Apple describes the draft as application-level information for a future release;
// it does not expose an AppInfo-to-version relationship. Never fall back to live info.
const SAFE_OTHER_INFOS = new Set(["READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_INFO"]);
const FIELDS = ["name", "subtitle"] as const;
type Fields = Partial<Record<InfoField, string>>;
type Input = { mode: "dry_run" | "commit"; version_string: string; localizations: Record<string, Fields>; primary_category?: string };
class InputError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));
const fingerprint = (value: string | null | undefined) => value == null ? null : { sha256: hash(value), chars: [...value].length };

export function normalizeAppInfoInput(raw: unknown): Input {
  if (!isObject(raw) || Object.keys(raw).some((k) => !["mode", "version_string", "localizations", "primary_category"].includes(k))) throw new InputError("INVALID_REQUEST", "body contains unsupported fields");
  if (raw.mode !== "dry_run" && raw.mode !== "commit") throw new InputError("MODE_REQUIRED", "mode must be dry_run or commit");
  if (typeof raw.version_string !== "string" || !raw.version_string.trim() || raw.version_string.length > 100) throw new InputError("VERSION_STRING_REQUIRED", "the exact version_string is required");
  if (raw.primary_category !== undefined && (typeof raw.primary_category !== "string" || !/^[A-Z][A-Z0-9_]{1,99}$/.test(raw.primary_category))) throw new InputError("INVALID_CATEGORY", "primary_category must be an Apple category ID such as PRODUCTIVITY");
  const localizations: Record<string, Fields> = {};
  if (raw.localizations !== undefined) {
    if (!isObject(raw.localizations) || Object.keys(raw.localizations).length > 60) throw new InputError("INVALID_REQUEST", "localizations must be a locale-to-fields object with at most 60 entries");
    for (const [locale, value] of Object.entries(raw.localizations)) {
      if (!ASC_LOCALE_RE.test(locale)) throw new InputError("INVALID_LOCALE", `invalid locale ${locale}`);
      if (!isObject(value) || !Object.keys(value).length) throw new InputError("INVALID_REQUEST", `${locale} must have name and/or subtitle`);
      const fields: Fields = {};
      for (const [key, text] of Object.entries(value)) {
        if (!FIELDS.includes(key as InfoField)) throw new InputError("UNKNOWN_FIELD", `${locale}: unsupported field ${key}`);
        if (typeof text !== "string" || !text.trim() || /[\u0000-\u001f\u007f]/.test(text)) throw new InputError("INVALID_FIELD", `${locale} ${key} must be a non-empty single-line string`);
        const length = [...text].length;
        if (length > 30 || (key === "name" && length < 2)) throw new InputError("INVALID_FIELD_LENGTH", `${locale} ${key} must be ${key === "name" ? "2–30" : "1–30"} characters`);
        fields[key as InfoField] = text;
      }
      localizations[locale] = fields;
    }
  }
  if (!Object.keys(localizations).length && !raw.primary_category) throw new InputError("INVALID_REQUEST", "provide localizations and/or primary_category");
  return { mode: raw.mode, version_string: raw.version_string, localizations, ...(raw.primary_category !== undefined ? { primary_category: raw.primary_category as string } : {}) };
}

interface Plan { locale: string; localization_id: string | null; action: "create" | "update" | "unchanged"; changed_fields: InfoField[]; before: Partial<Record<InfoField, string | null>>; after: Fields; blocker: string | null }
interface Snapshot { version: StoreVersion; observedPlatforms: string[]; info: AppInfo; localizations: InfoLocalization[]; versionLocales: string[]; category: string | null; subcategories: Array<string | null>; categoriesByPlatform: Record<string, string[]> }
class PlanError extends Error { constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); } }

async function snapshot(creds: AscApiCredentials, ascAppId: string, versionId: string, input: Input): Promise<Snapshot> {
  const versions = await listOwnedVersions(creds, ascAppId);
  const version = versions.find((v) => v.id === versionId);
  if (!version) throw new PlanError("VERSION_NOT_IN_APP", "version does not belong to this app");
  if (version.versionString !== input.version_string) throw new PlanError("VERSION_CHANGED", "version string no longer matches the requested version", { version });
  if (!EDITABLE_VERSION.has(version.state)) throw new PlanError("VERSION_NOT_EDITABLE", "the target version is not editable", { version });
  if (versions.filter((v) => v.platform === version.platform && v.versionString === version.versionString).length !== 1) throw new PlanError("VERSION_AMBIGUOUS", "multiple versions match this platform and version");
  if (versions.some((v) => !KNOWN_PLATFORMS.has(v.platform))) throw new PlanError("APP_INFO_PLATFORM_UNKNOWN", "an App Store version has an unknown platform; cannot safely assess the shared information");
  const otherActiveVersions = versions.filter((v) => v.platform !== version.platform && !OTHER_PLATFORM_SAFE_STATES.has(v.state));
  if (otherActiveVersions.length) throw new PlanError("APP_INFO_OTHER_PLATFORM_ACTIVE", "another platform has a version with an active or unknown state; shared App Information may affect that submission", { other_versions: otherActiveVersions });
  // Do not assume the provider can never return another in-flight version on
  // the selected platform. The AppInfo is application-scoped in that case too.
  const otherSamePlatform = versions.filter((v) => v.id !== version.id && v.platform === version.platform && !OTHER_PLATFORM_SAFE_STATES.has(v.state));
  if (otherSamePlatform.length) throw new PlanError("APP_INFO_OTHER_VERSION_ACTIVE", "another version on the selected platform has an active or unknown state; shared App Information may affect that submission", { other_versions: otherSamePlatform });
  const observedPlatforms = [...new Set(versions.map((v) => v.platform))].sort();
  const infos = await listAppInfos(creds, ascAppId);
  const editable = infos.filter((i) => i.state === "PREPARE_FOR_SUBMISSION");
  if (editable.length !== 1 || infos.some((i) => i.state !== "PREPARE_FOR_SUBMISSION" && !SAFE_OTHER_INFOS.has(i.state))) {
    throw new PlanError("APP_INFO_NOT_UNAMBIGUOUS", "exactly one draft App Information and no other pending or unknown App Information is required", { app_infos: infos });
  }
  const info = editable[0]!;
  const localizations = await listInfoLocalizations(creds, info.id);
  const versionLocales = await listVersionLocales(creds, version.id);
  const category = await categoryRelationship(creds, info.id, "primaryCategory");
  const subcategories = input.primary_category && input.primary_category !== category
    ? await Promise.all([categoryRelationship(creds, info.id, "primarySubcategoryOne"), categoryRelationship(creds, info.id, "primarySubcategoryTwo")]) : [];
  // App Information is shared. Validate the requested category for every platform
  // observed in the version-list response, not only the caller's target.
  // Bounded pagination cannot prove snapshot completeness or that an
  // unobserved, newly added platform does not exist.
  const categoriesByPlatform = Object.fromEntries(input.primary_category
    ? await Promise.all(observedPlatforms.map(async (platform) => [platform, await listPrimaryCategories(creds, platform)] as const))
    : []);
  return { version, observedPlatforms, info, localizations, versionLocales, category, subcategories, categoriesByPlatform };
}

function makePlan(s: Snapshot, input: Input) {
  const existing = new Map(s.localizations.map((l) => [l.locale, l]));
  const localizations: Plan[] = Object.entries(input.localizations).map(([locale, fields]) => {
    const row = existing.get(locale), keys = Object.keys(fields) as InfoField[];
    const unknown = !!row && keys.some((field) => !(field in row.fields));
    const changed = row ? keys.filter((field) => row.fields[field] !== fields[field]) : keys;
    const blocker = unknown ? "current_field_not_returned" : !row && !APP_STORE_LOCALES.has(locale) ? "locale_unknown" : !row && !fields.name ? "name_required_to_create" : !row && !s.versionLocales.includes(locale) ? "version_locale_missing" : null;
    return { locale, localization_id: row?.id ?? null, action: !row ? "create" : changed.length ? "update" : "unchanged", changed_fields: changed, before: Object.fromEntries(keys.map((key) => [key, row?.fields[key] ?? null])), after: fields, blocker };
  });
  const unavailablePlatforms = input.primary_category ? s.observedPlatforms.filter((platform) => !s.categoriesByPlatform[platform]?.includes(input.primary_category!)) : [];
  const category = input.primary_category ? { before: s.category, after: input.primary_category, action: input.primary_category === s.category ? "unchanged" : "update", unavailable_platforms: unavailablePlatforms, blocker: unavailablePlatforms.length ? "category_not_available_for_platform" : input.primary_category !== s.category && s.subcategories.some(Boolean) ? "existing_primary_subcategories" : null } : null;
  const afterLocales = new Set([...s.localizations.map((l) => l.locale), ...localizations.filter((p) => p.action === "create" && !p.blocker).map((p) => p.locale)]);
  const missingAppInfoLocales = s.versionLocales.filter((locale) => !afterLocales.has(locale));
  const missingVersionLocales = [...afterLocales].filter((locale) => !s.versionLocales.includes(locale)).sort();
  return { localizations, category, locale_consistency: { missing_app_info: missingAppInfoLocales, missing_version: missingVersionLocales } };
}

function signature(s: Snapshot) { return JSON.stringify(s); }
const versionView = (s: Snapshot) => ({ id: s.version.id, version_string: s.version.versionString, platform: s.version.platform, state: s.version.state });
const infoView = (s: Snapshot) => ({ id: s.info.id, state: s.info.state });

type Result = { target: string; action: string; status: "written" | "unchanged" | "failed" | "unknown" | "not_attempted"; localization_id?: string | null; error?: Record<string, unknown> };

export async function handlePushAppInfo(c: AdminContext) {
  let input: Input;
  try { input = normalizeAppInfoInput(await c.req.json().catch(() => null)); }
  catch (error) { if (error instanceof InputError) return c.json({ code: error.code, error: error.message }, 400); throw error; }
  // Product acceptance of application-scoped semantics does not verify Apple
  // write behavior or recovery. Keep every externally reachable commit blocked.
  if (input.mode === "commit") return c.json({ code: "APP_INFO_COMMIT_UNVERIFIED", error: "App Information writes are not yet verified; nothing was written" }, 409);
  return pushAppInfoCandidate(c, input);
}

/** Test the candidate machinery directly; the public route above does not allow commits. */
export async function pushAppInfoCandidate(c: AdminContext, input: Input) {
  const appId = c.req.param("appId") ?? "", versionId = c.req.param("versionId") ?? "";
  const operationId = crypto.randomUUID();
  let locked = false, releaseLock = true, mutationStarted = false;
  let targetHash = "";
  const results: Result[] = [];
  let s: Snapshot | null = null;
  try {
    const creds = await loadCredentials(c, appId), ascAppId = await ascAppIdFor(c, appId);
    targetHash = hash(`app-info:${ascAppId}`);
    if (input.mode === "commit") {
      const acquired = await c.env.DB.prepare("INSERT OR IGNORE INTO store_product_locks (provider, target_hash, operation_id, acquired_at) VALUES (?1, ?2, ?3, ?4)")
        .bind("apple_app_info", targetHash, operationId, Date.now()).run();
      if (acquired.meta.changes !== 1) return c.json({ code: "APP_INFO_LOCKED", error: "an App Information operation is active or requires recovery; do not retry until it is resolved" }, 409);
      locked = true;
    }
    s = await snapshot(creds, ascAppId, versionId, input);
    const plan = makePlan(s, input);
    const base = { operation_id: operationId, mode: input.mode, version: versionView(s), app_info: infoView(s), observed_platforms: s.observedPlatforms };
    const blocked = plan.localizations.some((p) => p.blocker) || !!plan.category?.blocker;
    if (blocked) return c.json({ ...base, code: "APP_INFO_PLAN_BLOCKED", error: "App Information plan is blocked; nothing was written", ...plan }, 409);
    if (input.mode === "dry_run") return c.json({ ...base, outcome: "planned", ...plan, writes: 0, warning: "Name availability is not checked or reserved by this preview. App Information is shared across platforms and is not bound to this version. Observed platforms come from version records and may omit newly added platforms. Language differences are a warning, not proof of an Apple submission requirement; verify them in App Store Connect before submitting." });

    const auditPlan = { localizations: plan.localizations.map((p) => ({ locale: p.locale, action: p.action, changed_fields: p.changed_fields, before: Object.fromEntries(Object.entries(p.before).map(([k,v]) => [k, fingerprint(v)])), after: Object.fromEntries(Object.entries(p.after).map(([k,v]) => [k, fingerprint(v)])) })), category: plan.category };
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "app_store.app_info.attempt", payload: { ...base, plan: auditPlan } });
    // Recheck all the read inputs after the lock and immediately before the first write.
    const fresh = await snapshot(creds, ascAppId, versionId, input);
    if (signature(fresh) !== signature(s)) return c.json({ ...base, code: "APP_INFO_CHANGED", error: "App Information changed during planning; nothing was written, run preview again" }, 409);
    const steps = [
      ...plan.localizations.map((p) => ({ target: p.locale, action: p.action, localization_id: p.localization_id, run: async () => writeInfoLocalization(creds, s!.info.id, p.locale, p.localization_id, Object.fromEntries(p.changed_fields.map((k) => [k, p.after[k]!])) as Fields) })),
      ...(plan.category ? [{ target: "primary_category", action: plan.category.action, localization_id: null, run: async () => { await writePrimaryCategory(creds, s!.info.id, plan.category!.after); return null; } }] : []),
    ];
    let stopped = false;
    for (const step of steps) {
      if (stopped) { results.push({ target: step.target, action: step.action, status: "not_attempted", localization_id: step.localization_id }); continue; }
      if (step.action === "unchanged") { results.push({ target: step.target, action: step.action, status: "unchanged", localization_id: step.localization_id }); continue; }
      try {
        // A failure after this point can mean Apple accepted a request even if no response arrived.
        mutationStarted = true; releaseLock = false;
        const id = await step.run();
        results.push({ target: step.target, action: step.action, status: "written", localization_id: id });
      } catch (error) {
        const definite = error instanceof AscApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
        results.push({ target: step.target, action: step.action, status: definite ? "failed" : "unknown", localization_id: step.localization_id, error: errorBody(error).body });
        stopped = true;
      }
    }
    // Read the selected exact resource, not whichever draft may now be selected.
    const afterRows = await listInfoLocalizations(creds, s.info.id);
    const afterCategory = await categoryRelationship(creds, s.info.id, "primaryCategory");
    const after = new Map(afterRows.map((r) => [r.locale, r]));
    const mismatches: Array<{ target: string; field: string; expected: string; actual: string | null }> = [];
    for (const p of plan.localizations) {
      const row = after.get(p.locale), result = results.find((r) => r.target === p.locale);
      if (result?.status === "written" || result?.status === "unchanged") {
        for (const field of Object.keys(p.after) as InfoField[]) if (!row || row.fields[field] !== p.after[field] || (result.localization_id && row.id !== result.localization_id)) mismatches.push({ target: p.locale, field, expected: p.after[field]!, actual: row?.fields[field] ?? null });
      }
    }
    const categoryResult = results.find((r) => r.target === "primary_category");
    if (plan.category && (categoryResult?.status === "written" || categoryResult?.status === "unchanged") && afterCategory !== plan.category.after) mismatches.push({ target: "primary_category", field: "primary_category", expected: plan.category.after, actual: afterCategory });
    const uncertain = results.some((r) => r.status === "unknown") || mismatches.length > 0;
    const failed = results.some((r) => r.status === "failed" || r.status === "unknown" || r.status === "not_attempted") || mismatches.length > 0;
    const outcome = failed ? "failed" : results.every((r) => r.status === "unchanged") ? "no_changes" : "committed";
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "app_store.app_info.result", payload: { ...base, outcome, results: results.map(({ error: _e, ...r }) => r), mismatches: mismatches.map((m) => ({ target: m.target, field: m.field, expected: fingerprint(m.expected), actual: fingerprint(m.actual) })) } });
    // A definitive rejection is safe to retry only after preceding accepted writes read back correctly.
    releaseLock = !uncertain;
    const body = { ...base, ok: !failed, outcome, results, mismatches, readback: { localizations: afterRows.map((r) => ({ locale: r.locale, id: r.id, fields: r.fields })), primary_category: afterCategory }, recovery_required: !releaseLock };
    if (failed) return c.json({ ...body, code: mismatches.length ? "APP_INFO_READBACK_MISMATCH" : "APP_INFO_WRITE_FAILED", error: "one or more App Information steps failed or were not confirmed; inspect the results before retrying" }, 502);
    return c.json(body);
  } catch (error) {
    if (mutationStarted) {
      return c.json({ ok: false, code: "APP_INFO_RECOVERY_REQUIRED", error: "a write may have completed or read-back failed; inspect Apple and recover the lock before retrying", operation_id: operationId, results, recovery_required: true, cause: errorBody(error).body }, 502);
    }
    if (error instanceof PlanError) return c.json({ code: error.code, error: error.message, ...error.details }, error.code === "VERSION_NOT_IN_APP" ? 404 : 409);
    return fail(c, error);
  } finally {
    if (locked && releaseLock) await c.env.DB.prepare("DELETE FROM store_product_locks WHERE provider = ?1 AND target_hash = ?2 AND operation_id = ?3").bind("apple_app_info", targetHash, operationId).run();
  }
}
