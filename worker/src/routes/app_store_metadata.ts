/**
 * App Store version metadata through Hands: screenshots and listing text.
 *
 * Both endpoints take an explicit `mode` with no default. `dry_run` validates the
 * request, reads Apple's current state with GETs only, and returns the plan.
 * `commit` performs it. A blocker (version not editable, localization missing)
 * returns 409 with the plan in both modes and writes nothing.
 *
 * Nothing here claims success it did not observe: every commit ends with a
 * read-back from Apple, and any failed or mismatched item makes the whole
 * response a failure with per-item detail. A screenshot that was uploaded and
 * committed but that Apple is still processing when the poll budget runs out is
 * reported as `uploaded_pending`: not a success, not a rejection.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { insertAuditLog } from "../lib/permissions";
import {
  AscApiError,
  type AscApiCredentials,
  type AscScreenshot,
  type AscVersionLocalization,
  type VersionLocalizationField,
  VERSION_LOCALIZATION_FIELDS,
  commitScreenshot,
  createScreenshotSet,
  createVersionLocalizationWithFields,
  deleteScreenshot,
  findAppStoreVersionById,
  getScreenshot,
  getScreenshotSetWithScreenshots,
  listScreenshotSets,
  listVersionLocalizations,
  performUploadOperations,
  reorderScreenshots,
  reserveScreenshot,
  updateVersionLocalizationFields,
} from "../lib/asc_api";
import {
  ASC_LOCALE_RE,
  ScreenshotInputError,
  normalizeScreenshotPush,
  readScreenshotMultipart,
  type ScreenshotPush,
  type ScreenshotSetInput,
} from "../lib/app_store_screenshots";
import {
  type AdminContext,
  AppStoreReleaseError,
  ascAppIdFor,
  classifyVersionState,
  errorBody,
  fail,
  loadCredentials,
} from "./app_store_release";

/** Bounded wait for Apple's asset processing. Exported so tests can shorten it. */
export const SCREENSHOT_POLL = { intervalMs: 2000, timeoutMs: 120_000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadVersion(creds: AscApiCredentials, ascAppId: string, versionId: string) {
  // Scoped to this app's own version list: ASC team keys are not app-scoped.
  const version = await findAppStoreVersionById(creds, ascAppId, versionId);
  if (!version) throw new AppStoreReleaseError(404, "VERSION_NOT_IN_APP", "app store version does not belong to this app");
  return version;
}

function versionView(version: { id: string; versionString: string | null; appVersionState: string | null; appStoreState: string | null }) {
  return { id: version.id, version_string: version.versionString, state: version.appVersionState ?? version.appStoreState };
}

// ---------- Screenshots ----------

type SetAction = "unchanged" | "reorder" | "replace" | "upload" | "create_set_and_upload";

interface SetPlan {
  input: ScreenshotSetInput;
  localizationId: string | null;
  setId: string | null;
  existing: AscScreenshot[];
  action: SetAction | null;
  blocker: string | null;
  /** For reorder: existing ids in the desired order. */
  reorderIds?: string[];
}

function planSet(input: ScreenshotSetInput, existing: AscScreenshot[], setId: string | null): Pick<SetPlan, "action" | "reorderIds"> {
  if (!setId) return { action: "create_set_and_upload" };
  if (existing.length === 0) return { action: "upload" };
  const desired = input.images.map((image) => image.md5);
  const allComplete = existing.every((shot) => shot.state === "COMPLETE" && shot.sourceFileChecksum);
  if (allComplete && existing.length === desired.length) {
    if (existing.every((shot, index) => shot.sourceFileChecksum === desired[index])) return { action: "unchanged" };
    // Same files in another order: map each desired checksum to an unused existing id.
    const pool = [...existing];
    const ids: string[] = [];
    for (const checksum of desired) {
      const at = pool.findIndex((shot) => shot.sourceFileChecksum === checksum);
      if (at < 0) return { action: "replace" };
      ids.push(pool[at]!.id);
      pool.splice(at, 1);
    }
    return { action: "reorder", reorderIds: ids };
  }
  return { action: "replace" };
}

function existingView(shots: AscScreenshot[]) {
  return shots.map((shot) => ({ id: shot.id, md5: shot.sourceFileChecksum, state: shot.state, file_name: shot.fileName, file_size: shot.fileSize }));
}

function desiredView(input: ScreenshotSetInput) {
  return input.images.map((image) => ({
    sha256: image.sha256, md5: image.md5, size_bytes: image.size_bytes, width: image.width, height: image.height,
    content_type: image.content_type, file_name: image.file_name,
  }));
}

async function buildScreenshotPlan(creds: AscApiCredentials, versionId: string, push: ScreenshotPush, editable: boolean) {
  const localizations = await listVersionLocalizations(creds, versionId);
  const byLocale = new Map(localizations.map((l) => [l.locale, l]));
  const setsByLocalization = new Map<string, Awaited<ReturnType<typeof listScreenshotSets>>>();
  const plans: SetPlan[] = [];
  for (const input of push.sets) {
    const localization = byLocale.get(input.locale);
    if (!localization) {
      plans.push({ input, localizationId: null, setId: null, existing: [], action: null, blocker: "localization_missing" });
      continue;
    }
    let sets = setsByLocalization.get(localization.id);
    if (!sets) {
      sets = await listScreenshotSets(creds, localization.id);
      setsByLocalization.set(localization.id, sets);
    }
    const set = sets.find((s) => s.displayType === input.display_type) ?? null;
    const existing = set ? await getScreenshotSetWithScreenshots(creds, set.id) : [];
    const decided = planSet(input, existing, set?.id ?? null);
    plans.push({
      input, localizationId: localization.id, setId: set?.id ?? null, existing,
      action: decided.action, blocker: editable || decided.action === "unchanged" ? null : "version_not_editable",
      ...(decided.reorderIds ? { reorderIds: decided.reorderIds } : {}),
    });
  }
  return { plans, locales: localizations.map((l) => l.locale) };
}

function planView(plan: SetPlan) {
  return {
    locale: plan.input.locale,
    display_type: plan.input.display_type,
    action: plan.action,
    blocker: plan.blocker,
    screenshot_set_id: plan.setId,
    existing: existingView(plan.existing),
    desired: desiredView(plan.input),
  };
}

interface ImageResult {
  index: number;
  sha256: string;
  md5: string;
  screenshot_id: string | null;
  state: string;
  errors?: Array<{ code: string | null; description: string | null }>;
  error?: string;
}

interface SetResult {
  locale: string;
  display_type: string;
  action: SetAction | null;
  /**
   * uploaded_pending: every image was uploaded and committed, none was rejected,
   * but at least one was still processing at Apple when the poll budget ran out.
   * The set's order and read-back were not done yet. Not a success.
   */
  status: "ok" | "failed" | "uploaded_pending" | "not_attempted";
  screenshot_set_id: string | null;
  deleted: string[];
  images: ImageResult[];
  readback?: { md5_order_match: boolean; all_complete: boolean; count: number };
  error?: Record<string, unknown>;
}

/**
 * Timed-out states that mean "Apple accepted the upload and is still processing it":
 * after the commit PATCH Apple moves a screenshot to UPLOAD_COMPLETE, then COMPLETE or
 * FAILED. Any other state at the deadline (AWAITING_UPLOAD after a successful commit,
 * UNKNOWN) is not a known in-progress state, so it stays a failure.
 */
const PENDING_TIMEOUT_STATES = new Set(["TIMEOUT(UPLOAD_COMPLETE)"]);

const GLOBAL_HINT_RE = /\b(state|version|editable|locked?)\b/i;

/**
 * Whether an error thrown while committing one set should stop the remaining sets.
 * The rule is conservative: an error is set-local only when it clearly is, and
 * anything else stops the run (one clear error beats N identical ones).
 *
 * Set-local, later sets still run:
 * - Apple's per-image outcome (assetDeliveryState FAILED) and a read-back mismatch.
 *   These are not exceptions; commitSet records them on the set.
 * - An AscApiError with HTTP 400, 409 or 422: Apple refused this specific request
 *   (an invalid attribute, a conflict on this set or screenshot), unless its title or
 *   detail mentions a state, the version, editability or a lock. Apple's 409
 *   STATE_ERROR ("...because of the state of another resource") is therefore global.
 *
 * Global, later sets are reported not_attempted:
 * - 401/403 (key revoked or lacks the role), 404 (version, localization or set gone),
 *   429 (rate limited), 5xx, our own 502 for a malformed Apple response, network
 *   errors, and anything that is not an AscApiError.
 */
export function isGlobalScreenshotError(error: unknown): boolean {
  if (!(error instanceof AscApiError)) return true;
  if (error.status !== 400 && error.status !== 409 && error.status !== 422) return true;
  return GLOBAL_HINT_RE.test(`${error.message} ${error.detail ?? ""}`);
}

async function pollUntilDelivered(creds: AscApiCredentials, results: ImageResult[]) {
  const pending = () => results.filter((r) => r.screenshot_id && r.state !== "COMPLETE" && r.state !== "FAILED" && !r.error);
  const deadline = Date.now() + SCREENSHOT_POLL.timeoutMs;
  while (pending().length > 0) {
    for (const result of pending()) {
      const shot = await getScreenshot(creds, result.screenshot_id!);
      result.state = shot?.state ?? "UNKNOWN";
      if (shot?.errors.length) result.errors = shot.errors;
    }
    if (pending().length === 0) break;
    if (Date.now() >= deadline) {
      for (const result of pending()) result.state = `TIMEOUT(${result.state})`;
      break;
    }
    await sleep(SCREENSHOT_POLL.intervalMs);
  }
}

async function commitSet(creds: AscApiCredentials, plan: SetPlan): Promise<SetResult> {
  const result: SetResult = {
    locale: plan.input.locale, display_type: plan.input.display_type, action: plan.action,
    status: "ok", screenshot_set_id: plan.setId, deleted: [], images: [],
  };
  if (plan.action === "unchanged") return result;
  try {
    if (plan.action === "reorder") {
      await reorderScreenshots(creds, plan.setId!, plan.reorderIds!);
    } else {
      let setId = plan.setId;
      if (!setId) {
        setId = await createScreenshotSet(creds, plan.localizationId!, plan.input.display_type);
        result.screenshot_set_id = setId;
      }
      for (const shot of plan.existing) {
        await deleteScreenshot(creds, shot.id);
        result.deleted.push(shot.id);
      }
      for (const [index, image] of plan.input.images.entries()) {
        const item: ImageResult = { index, sha256: image.sha256, md5: image.md5, screenshot_id: null, state: "NOT_STARTED" };
        result.images.push(item);
        try {
          const reserved = await reserveScreenshot(creds, setId, image.file_name, image.size_bytes);
          item.screenshot_id = reserved.id;
          item.state = "RESERVED";
          await performUploadOperations(reserved.uploadOperations, image.bytes);
          item.state = "UPLOADED";
          await commitScreenshot(creds, reserved.id, image.md5);
          item.state = "COMMITTED";
        } catch (error) {
          item.error = String(errorBody(error).body.error ?? error);
          item.state = item.state === "NOT_STARTED" ? "RESERVE_FAILED" : `${item.state}_THEN_FAILED`;
          // A global error (auth, rate limit, Apple down) would fail every later image
          // the same way: stop this set and, via the handler, the run.
          if (isGlobalScreenshotError(error)) throw error;
        }
      }
      await pollUntilDelivered(creds, result.images);
      const ids = result.images.map((image) => image.screenshot_id);
      if (result.images.every((image) => image.state === "COMPLETE") && ids.every(Boolean)) {
        await reorderScreenshots(creds, setId, ids as string[]);
      }
    }
    if (result.images.some((image) => image.state !== "COMPLETE")) {
      // Uploaded and committed, nothing rejected, only Apple's processing outran the
      // poll: pending, not failed. Order and read-back are left to a later dry run.
      const pendingOnly = result.images.every((image) => !image.error && image.screenshot_id
        && (image.state === "COMPLETE" || PENDING_TIMEOUT_STATES.has(image.state)));
      result.status = pendingOnly ? "uploaded_pending" : "failed";
      return result;
    }
    // Read back the set: order and checksums must equal the request, all COMPLETE.
    const after = await getScreenshotSetWithScreenshots(creds, result.screenshot_set_id!);
    const desired = plan.input.images.map((image) => image.md5);
    result.readback = {
      md5_order_match: after.length === desired.length && after.every((shot, i) => shot.sourceFileChecksum === desired[i]),
      all_complete: after.every((shot) => shot.state === "COMPLETE"),
      count: after.length,
    };
    if (!result.readback.md5_order_match || !result.readback.all_complete) result.status = "failed";
  } catch (error) {
    result.status = "failed";
    result.error = { ...errorBody(error).body, scope: isGlobalScreenshotError(error) ? "global" : "set" };
  }
  return result;
}

/** What to do about sets Apple is still processing. No automatic retry. */
export const SCREENSHOTS_PENDING_NEXT_ACTION =
  "Apple is still processing some screenshots. Run the dry run again later: if every set is `unchanged`, files and order are confirmed; if a set shows `reorder` or `replace`, run --commit again.";

const setName = (r: SetResult) => `${r.locale} ${r.display_type}`;

function auditSets(results: SetResult[]) {
  return results.map((r) => ({
    locale: r.locale, display_type: r.display_type, action: r.action, status: r.status,
    screenshot_set_id: r.screenshot_set_id, deleted: r.deleted,
    images: r.images.map((i) => ({ sha256: i.sha256, md5: i.md5, screenshot_id: i.screenshot_id, state: i.state })),
  }));
}

/**
 * POST /api/apps/:appId/app-store/versions/:versionId/screenshots (multipart).
 *
 * Per (locale, display_type): the localization must already exist (create it with
 * the localizations endpoint); the set is created if missing. A set whose
 * screenshots already match the request by MD5 (Apple's sourceFileChecksum), in
 * order and all COMPLETE, is left alone; same files in another order are only
 * reordered; anything else is replaced (delete existing, upload, poll, order).
 * Sets are committed independently: a set-local failure does not stop later sets.
 * Only a global error (see isGlobalScreenshotError) stops the run; later sets are
 * then reported "not_attempted". Outcome precedence: failed > uploaded_pending >
 * committed / no_changes.
 */
export async function handlePushAppStoreScreenshots(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  let push: ScreenshotPush;
  try {
    const { body, parts } = await readScreenshotMultipart(c.req.raw);
    push = normalizeScreenshotPush(body, parts);
  } catch (error) {
    if (error instanceof ScreenshotInputError) {
      return c.json({ error: error.message, code: error.code, ...error.details }, 400);
    }
    throw error;
  }
  const operationId = crypto.randomUUID();
  try {
    const creds = await loadCredentials(c, appId);
    const ascAppId = await ascAppIdFor(c, appId);
    const version = await loadVersion(creds, ascAppId, versionId);
    const editable = classifyVersionState(version) === "editable";
    const { plans, locales } = await buildScreenshotPlan(creds, versionId, push, editable);
    const blocked = plans.filter((p) => p.blocker);
    const base = { operation_id: operationId, mode: push.mode, version: versionView(version) };
    if (blocked.length > 0) {
      return c.json({
        ...base,
        error: blocked.some((p) => p.blocker === "version_not_editable")
          ? `version ${version.versionString} is ${versionView(version).state}; screenshots can only change while it is editable`
          : `no localization for ${[...new Set(blocked.map((p) => p.input.locale))].join(", ")} on this version; create it with the localizations endpoint first`,
        code: "SCREENSHOT_PLAN_BLOCKED",
        version_locales: locales,
        sets: plans.map(planView),
        writes: 0,
      }, 409);
    }
    if (push.mode === "dry_run") {
      await insertAuditLog(c.env.DB, c, {
        app_id: appId, action: "app_store.screenshots",
        payload: { ...base, outcome: "planned", sets: plans.map((p) => ({ locale: p.input.locale, display_type: p.input.display_type, action: p.action,
          desired: p.input.images.map((i) => ({ sha256: i.sha256, md5: i.md5 })) })) },
      });
      return c.json({ ...base, outcome: "planned", sets: plans.map(planView), writes: 0 });
    }
    const results: SetResult[] = [];
    let stoppedBy: SetResult | null = null;
    for (const plan of plans) {
      if (stoppedBy) {
        results.push({ locale: plan.input.locale, display_type: plan.input.display_type, action: plan.action,
          status: "not_attempted", screenshot_set_id: plan.setId, deleted: [], images: [] });
        continue;
      }
      const result = await commitSet(creds, plan);
      results.push(result);
      if (result.status === "failed" && result.error?.scope === "global") stoppedBy = result;
    }
    const failedSets = results.filter((r) => r.status === "failed" || r.status === "not_attempted").map(setName);
    const pendingSets = results.filter((r) => r.status === "uploaded_pending").map(setName);
    const outcome = failedSets.length > 0 ? "failed"
      : pendingSets.length > 0 ? "uploaded_pending"
      : results.every((r) => r.action === "unchanged") ? "no_changes" : "committed";
    await insertAuditLog(c.env.DB, c, {
      app_id: appId, action: "app_store.screenshots",
      payload: { ...base, outcome, sets: auditSets(results) },
    });
    const summary = { failed_sets: failedSets, pending_sets: pendingSets };
    if (failedSets.length > 0) {
      const stop = stoppedBy
        ? `; stopped at ${setName(stoppedBy)} on an error that would affect every set (${String(stoppedBy.error?.error ?? "unknown")}), later sets not attempted`
        : "";
      return c.json({
        ...base, ok: false, outcome,
        error: `${failedSets.length} screenshot set(s) did not reach the requested state${stop}; see sets[].images[].state`,
        code: "SCREENSHOTS_FAILED",
        ...summary,
        next_action: pendingSets.length > 0
          ? `Fix the failed sets and push again. ${SCREENSHOTS_PENDING_NEXT_ACTION}`
          : "Fix the failed sets and push again.",
        sets: results,
      }, 502);
    }
    if (pendingSets.length > 0) {
      // 202: Apple accepted the uploads and is still processing them. ok stays false.
      return c.json({
        ...base, ok: false, outcome,
        error: `${pendingSets.length} screenshot set(s) uploaded but still processing at Apple: ${pendingSets.join(", ")}`,
        code: "SCREENSHOTS_PENDING",
        ...summary,
        next_action: SCREENSHOTS_PENDING_NEXT_ACTION,
        sets: results,
      }, 202);
    }
    return c.json({ ...base, ok: true, outcome, ...summary, sets: results });
  } catch (error) {
    return fail(c, error);
  }
}

// ---------- Listing text (appStoreVersionLocalizations) ----------

/** Apple's documented maximum lengths (App Store Connect Help, "Platform version information"). */
export const LOCALIZATION_LIMITS: Record<VersionLocalizationField, number> = {
  description: 4000,
  keywords: 100,
  promotionalText: 170,
  whatsNew: 4000,
  marketingUrl: 2048,
  supportUrl: 2048,
};

/**
 * Locales App Store Connect accepts for a new localization. Only used to refuse a
 * create early; a locale the version already has is accepted as Apple reports it.
 */
export const APP_STORE_LOCALES = new Set([
  "ar-SA", "ca", "cs", "da", "de-DE", "el", "en-AU", "en-CA", "en-GB", "en-US", "es-ES", "es-MX",
  "fi", "fr-CA", "fr-FR", "he", "hi", "hr", "hu", "id", "it", "ja", "ko", "ms", "nl-NL", "no",
  "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sv", "th", "tr", "uk", "vi", "zh-Hans", "zh-Hant",
]);

type LocalizationInput = Record<string, Partial<Record<VersionLocalizationField, string>>>;

class LocalizationInputError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

const codePoints = (value: string) => [...value].length;

export function normalizeLocalizationPush(body: unknown): { mode: "dry_run" | "commit"; localizations: LocalizationInput } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new LocalizationInputError("INVALID_REQUEST", "body must be a JSON object");
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "mode" && key !== "localizations") throw new LocalizationInputError("INVALID_REQUEST", `unknown field ${key}`);
  }
  if (raw.mode !== "dry_run" && raw.mode !== "commit") {
    throw new LocalizationInputError("MODE_REQUIRED", 'mode must be "dry_run" or "commit"; there is no default');
  }
  const map = raw.localizations;
  if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length === 0 || Object.keys(map).length > 60) {
    throw new LocalizationInputError("INVALID_REQUEST", "localizations must be a non-empty locale-to-fields object");
  }
  const out: LocalizationInput = {};
  for (const [locale, value] of Object.entries(map as Record<string, unknown>)) {
    if (!ASC_LOCALE_RE.test(locale)) throw new LocalizationInputError("INVALID_LOCALE", `${locale} is not an App Store Connect locale code`);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new LocalizationInputError("INVALID_REQUEST", `${locale} must be an object of ${VERSION_LOCALIZATION_FIELDS.join(", ")}`);
    }
    const fields: Partial<Record<VersionLocalizationField, string>> = {};
    for (const [field, text] of Object.entries(value as Record<string, unknown>)) {
      if (!(VERSION_LOCALIZATION_FIELDS as readonly string[]).includes(field)) {
        throw new LocalizationInputError("UNKNOWN_FIELD", `${locale}: ${field} is not an appStoreVersionLocalizations field (expected ${VERSION_LOCALIZATION_FIELDS.join(", ")})`);
      }
      const name = field as VersionLocalizationField;
      if (typeof text !== "string" || !text.trim()) throw new LocalizationInputError("INVALID_FIELD", `${locale} ${name} must be a non-empty string`);
      const length = codePoints(text);
      if (length > LOCALIZATION_LIMITS[name]) {
        throw new LocalizationInputError("FIELD_TOO_LONG", `${locale} ${name} is ${length} characters; App Store Connect allows ${LOCALIZATION_LIMITS[name]}`,
          { locale, field: name, length, limit: LOCALIZATION_LIMITS[name] });
      }
      if (name === "marketingUrl" || name === "supportUrl") {
        let ok = false;
        try { ok = ["http:", "https:"].includes(new URL(text).protocol); } catch { ok = false; }
        if (!ok) throw new LocalizationInputError("INVALID_URL", `${locale} ${name} must be an http(s) URL`);
      }
      fields[name] = text;
    }
    if (Object.keys(fields).length === 0) throw new LocalizationInputError("INVALID_REQUEST", `${locale} has no fields to write`);
    out[locale] = fields;
  }
  return { mode: raw.mode, localizations: out };
}

const fingerprint = (value: string | null | undefined) =>
  value == null ? null : { sha256: bytesToHex(sha256(new TextEncoder().encode(value))), chars: codePoints(value) };

interface LocalePlan {
  locale: string;
  localization_id: string | null;
  action: "create" | "update" | "unchanged";
  changed_fields: VersionLocalizationField[];
  before: Partial<Record<VersionLocalizationField, string | null>>;
  after: Partial<Record<VersionLocalizationField, string>>;
  blocker: string | null;
  /** Set on a create that lacks fields Apple requires before it will review the version. */
  missing_fields?: VersionLocalizationField[];
}

/**
 * Fields a new localization must carry. Apple accepts a POST without them, then
 * refuses the review submission (ENTITY_ERROR.ATTRIBUTE.REQUIRED on supportUrl for a
 * zh-Hans/ja created with only whatsNew, 2026-10-29). Updates may send a subset.
 */
export const LOCALIZATION_CREATE_REQUIRED: readonly VersionLocalizationField[] = ["description", "keywords", "supportUrl"];

function planLocalizations(input: LocalizationInput, existing: AscVersionLocalization[], editable: boolean): LocalePlan[] {
  const byLocale = new Map(existing.map((l) => [l.locale, l]));
  return Object.entries(input).map(([locale, fields]) => {
    const current = byLocale.get(locale);
    const names = Object.keys(fields) as VersionLocalizationField[];
    const changed = current ? names.filter((name) => current.fields[name] !== fields[name]) : names;
    const action = !current ? "create" : changed.length ? "update" : "unchanged";
    // Promotional text is the one field Apple lets you change on a version it holds.
    const needsEditable = action !== "unchanged" && changed.some((name) => name !== "promotionalText");
    const missing = current ? [] : LOCALIZATION_CREATE_REQUIRED.filter((name) => !fields[name]?.trim());
    const blocker = !current && !APP_STORE_LOCALES.has(locale) ? "locale_unknown"
      : needsEditable && !editable ? "version_not_editable"
      : missing.length > 0 ? "missing_required_fields" : null;
    return {
      locale,
      localization_id: current?.id ?? null,
      action,
      changed_fields: changed,
      before: Object.fromEntries(names.map((name) => [name, current?.fields[name] ?? null])),
      after: fields,
      blocker,
      ...(missing.length > 0 ? { missing_fields: missing } : {}),
    };
  });
}

/**
 * POST /api/apps/:appId/app-store/versions/:versionId/localizations.
 *
 * Writes only the supplied fields of the supplied locales: PATCH an existing
 * localization (changed fields only), POST a missing one. A missing one must carry
 * description, keywords and supportUrl (Apple refuses review without them), else the
 * plan is blocked with missing_required_fields. Commit stops at the first
 * failed locale and ends with a read-back that must equal every requested field.
 */
export async function handlePushAppStoreLocalizations(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  let input: ReturnType<typeof normalizeLocalizationPush>;
  try {
    input = normalizeLocalizationPush(await c.req.json().catch(() => null));
  } catch (error) {
    if (error instanceof LocalizationInputError) return c.json({ error: error.message, code: error.code, ...error.details }, 400);
    throw error;
  }
  const operationId = crypto.randomUUID();
  try {
    const creds = await loadCredentials(c, appId);
    const ascAppId = await ascAppIdFor(c, appId);
    const version = await loadVersion(creds, ascAppId, versionId);
    const editable = classifyVersionState(version) === "editable";
    const existing = await listVersionLocalizations(creds, versionId);
    const plans = planLocalizations(input.localizations, existing, editable);
    const base = { operation_id: operationId, mode: input.mode, version: versionView(version) };
    const auditPlan = plans.map((p) => ({
      locale: p.locale, action: p.action, changed_fields: p.changed_fields,
      before: Object.fromEntries(Object.entries(p.before).map(([k, v]) => [k, fingerprint(v)])),
      after: Object.fromEntries(Object.entries(p.after).map(([k, v]) => [k, fingerprint(v)])),
    }));
    const blocked = plans.filter((p) => p.blocker);
    if (blocked.length > 0) {
      return c.json({
        ...base,
        error: `cannot write ${blocked.map((p) => `${p.locale} (${p.blocker}${p.blocker === "missing_required_fields" ? `: ${p.missing_fields!.join(", ")}` : ""})`).join(", ")}`,
        code: "LOCALIZATION_PLAN_BLOCKED",
        localizations: plans,
        writes: 0,
      }, 409);
    }
    if (input.mode === "dry_run") {
      await insertAuditLog(c.env.DB, c, { app_id: appId, action: "app_store.localizations", payload: { ...base, outcome: "planned", localizations: auditPlan } });
      return c.json({ ...base, outcome: "planned", localizations: plans, writes: 0 });
    }
    const results: Array<{ locale: string; action: string; status: "written" | "unchanged" | "failed" | "not_attempted"; localization_id: string | null; error?: Record<string, unknown> }> = [];
    let stopped = false;
    for (const plan of plans) {
      if (plan.action === "unchanged") { results.push({ locale: plan.locale, action: plan.action, status: "unchanged", localization_id: plan.localization_id }); continue; }
      if (stopped) { results.push({ locale: plan.locale, action: plan.action, status: "not_attempted", localization_id: plan.localization_id }); continue; }
      try {
        if (plan.action === "create") {
          const id = await createVersionLocalizationWithFields(creds, versionId, plan.locale, plan.after);
          results.push({ locale: plan.locale, action: plan.action, status: "written", localization_id: id });
        } else {
          const changed = Object.fromEntries(plan.changed_fields.map((name) => [name, plan.after[name]!]));
          await updateVersionLocalizationFields(creds, plan.localization_id!, changed);
          results.push({ locale: plan.locale, action: plan.action, status: "written", localization_id: plan.localization_id });
        }
      } catch (error) {
        results.push({ locale: plan.locale, action: plan.action, status: "failed", localization_id: plan.localization_id, error: errorBody(error).body });
        stopped = true;
      }
    }
    // Read back every requested field, including "unchanged" ones.
    const after = new Map((await listVersionLocalizations(creds, versionId)).map((l) => [l.locale, l]));
    const mismatches = plans.flatMap((plan) => {
      const row = after.get(plan.locale);
      return (Object.keys(plan.after) as VersionLocalizationField[])
        .filter((name) => row?.fields[name] !== plan.after[name])
        .map((name) => ({ locale: plan.locale, field: name, expected: fingerprint(plan.after[name]), actual: fingerprint(row?.fields[name]) }));
    });
    const writeFailed = results.some((r) => r.status === "failed" || r.status === "not_attempted");
    const ok = !writeFailed && mismatches.length === 0;
    const outcome = !ok ? "failed" : results.every((r) => r.status === "unchanged") ? "no_changes" : "committed";
    await insertAuditLog(c.env.DB, c, {
      app_id: appId, action: "app_store.localizations",
      payload: { ...base, outcome, localizations: auditPlan, results: results.map(({ error: _e, ...r }) => r), mismatches },
    });
    if (!ok) {
      return c.json({
        ...base, ok: false, outcome,
        error: writeFailed ? "one or more localizations were not written" : "App Store Connect read-back does not match the request",
        code: writeFailed ? "LOCALIZATIONS_FAILED" : "READBACK_MISMATCH",
        results, mismatches,
      }, 502);
    }
    return c.json({ ...base, ok: true, outcome, results, localizations: plans });
  } catch (error) {
    return fail(c, error);
  }
}
