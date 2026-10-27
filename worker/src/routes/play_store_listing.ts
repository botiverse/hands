/**
 * Google Play store listing text (androidpublisher v3 edits.listings) through Hands.
 *
 * Whitelisted, 1:1 with Google: the request carries Google's `Listing` resource
 * (language, title, shortDescription, fullDescription, video) and nothing else.
 * No generic path/body proxy, nothing that touches tracks, releases or bundles.
 *
 * Every write: app publisher role (route middleware) -> authenticated human or
 * agent -> verified, enabled binding -> request validation (languages, limits)
 * before any Play call -> one package-scoped Play edit lock -> adapter (the only
 * holder of the Google credential) -> immutable receipt.
 *
 * Transaction: one edit per push. `mode:"dry_run"` applies the change inside a
 * fresh edit, runs edits.validate and deletes the edit; `mode:"commit"` validates
 * and commits. The adapter's apply step takes an edit id, so an "apply to an
 * existing edit" API can be added later without changing this one.
 */
import type { Context } from "hono";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { currentActor, currentActorInfo, type AdminEnv } from "../middleware/auth";
import { getGooglePlayBinding, hasGooglePlayConfiguration, type GooglePlayBinding } from "../lib/google_play_bindings";
import { isPlayListingLanguage, suggestPlayListingLanguage } from "../lib/play_listing_languages";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

/** androidpublisher v3 `Listing` field names, exactly as the discovery document spells them. */
export const LISTING_FIELDS = ["title", "shortDescription", "fullDescription", "video"] as const;
type ListingField = typeof LISTING_FIELDS[number];
export type PlayListing = { language: string } & Partial<Record<ListingField, string>>;

/**
 * Play Console character limits (support.google.com/googleplay/android-developer/answer/9859152):
 * app name 30, short description 80, full description 4,000, counted per character
 * for full- and half-width alike (Hands counts Unicode code points). `video` has no
 * documented limit; the bound only keeps a request finite. The adapter enforces the
 * same numbers at its own boundary.
 */
export const LISTING_LIMITS: Record<ListingField, number> = {
  title: 30,
  shortDescription: 80,
  fullDescription: 4000,
  video: 2048,
};
const MAX_LANGUAGES = 100;
const LOCK_STALE_MS = 15 * 60 * 1000;

export interface StoreListingPushInput {
  mode: "dry_run" | "commit";
  listings: PlayListing[];
  delete_unlisted_languages: boolean;
  changes_not_sent_for_review: boolean;
}

export class StoreListingInputError extends Error {
  constructor(readonly failureCode: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

function codePoints(value: string): number {
  return [...value].length;
}

/** Validate a push body completely before any Play call. Throws StoreListingInputError. */
export function normalizeStoreListingPush(body: unknown): StoreListingPushInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new StoreListingInputError("listing_request_invalid", "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["mode", "listings", "delete_unlisted_languages", "changes_not_sent_for_review"].includes(key)) {
      throw new StoreListingInputError("listing_request_invalid", `unknown field ${key}`);
    }
  }
  if (raw.mode !== "dry_run" && raw.mode !== "commit") {
    throw new StoreListingInputError("listing_mode_required", 'mode must be "dry_run" or "commit"');
  }
  for (const flag of ["delete_unlisted_languages", "changes_not_sent_for_review"]) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") {
      throw new StoreListingInputError("listing_request_invalid", `${flag} must be a boolean`);
    }
  }
  const deleteUnlisted = raw.delete_unlisted_languages === true;
  if (!Array.isArray(raw.listings) || raw.listings.length > MAX_LANGUAGES || (raw.listings.length === 0 && !deleteUnlisted)) {
    throw new StoreListingInputError("listing_request_invalid", `listings must be a list of 1-${MAX_LANGUAGES} Listing resources`);
  }
  const seen = new Set<string>();
  const unsupported: Array<{ language: string; suggestion: string | null }> = [];
  const listings: PlayListing[] = [];
  for (const item of raw.listings as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new StoreListingInputError("listing_request_invalid", "each listing must be an object");
    }
    const row = item as Record<string, unknown>;
    const language = typeof row.language === "string" ? row.language : "";
    if (!language) throw new StoreListingInputError("listing_language_invalid", "each listing needs a language");
    if (!isPlayListingLanguage(language)) {
      unsupported.push({ language, suggestion: suggestPlayListingLanguage(language) });
      continue;
    }
    if (seen.has(language)) {
      throw new StoreListingInputError("listing_language_duplicate", `${language} appears more than once`);
    }
    seen.add(language);
    const listing: PlayListing = { language };
    for (const key of Object.keys(row)) {
      if (key !== "language" && !(LISTING_FIELDS as readonly string[]).includes(key)) {
        throw new StoreListingInputError("listing_field_unknown", `${language}: ${key} is not a Google Play Listing field (expected ${LISTING_FIELDS.join(", ")})`);
      }
    }
    for (const field of LISTING_FIELDS) {
      const value = row[field];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new StoreListingInputError("listing_field_invalid", `${language} ${field} must be a string`);
      }
      if (field !== "video" && !value.trim()) {
        throw new StoreListingInputError("listing_field_empty", `${language} ${field} must not be empty`);
      }
      const length = codePoints(value);
      if (length > LISTING_LIMITS[field]) {
        throw new StoreListingInputError("listing_field_too_long",
          `${language} ${field} is ${length} characters; Google Play allows ${LISTING_LIMITS[field]}`,
          { language, field, length, limit: LISTING_LIMITS[field] });
      }
      listing[field] = value;
    }
    if (LISTING_FIELDS.every((field) => listing[field] === undefined)) {
      throw new StoreListingInputError("listing_field_missing", `${language} has no Listing fields to write`);
    }
    listings.push(listing);
  }
  if (unsupported.length > 0) {
    throw new StoreListingInputError("listing_language_unsupported",
      `not a Google Play store listing language: ${unsupported.map((u) => u.suggestion ? `${u.language} (did you mean ${u.suggestion}?)` : u.language).join(", ")}`,
      { unsupported });
  }
  return {
    mode: raw.mode,
    listings,
    delete_unlisted_languages: deleteUnlisted,
    changes_not_sent_for_review: raw.changes_not_sent_for_review === true,
  };
}

type Failure = {
  code: "gate_failed" | "forbidden" | "edit_conflict" | "edit_in_review" | "edit_state_unknown" | "play_api_error";
  failure_code: string;
  message: string;
  receipt_id?: string | null;
  [key: string]: unknown;
};

function fail(c: Context<any>, status: 400 | 403 | 409 | 502 | 503, failure: Failure) {
  return c.json({ error: { receipt_id: null, ...failure } }, status);
}

async function resolveBinding(c: AdminContext): Promise<GooglePlayBinding | Response> {
  if (!c.env.PLAY_RELEASE_SERVICE) {
    return fail(c, 503, { code: "play_api_error", failure_code: "play_service_unavailable", message: "Google Play release service is not configured" });
  }
  let binding: GooglePlayBinding | null;
  try {
    binding = await getGooglePlayBinding(c.env.DB, c.req.param("appId") ?? "", c.env.PLAY_CRED_ENC_KEYS);
  } catch {
    return fail(c, 502, { code: "play_api_error", failure_code: "play_credentials_unavailable", message: "Google Play credentials are unavailable for this app" });
  }
  if (!binding || !hasGooglePlayConfiguration(binding) || binding.enabled !== 1 || binding.verification_state !== "verified" || !binding.package_name) {
    return fail(c, 403, { code: "forbidden", failure_code: "play_binding_not_ready", message: "Google Play must be bound, verified, and enabled for this app" });
  }
  return binding;
}

function hex(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

/** Per-field fingerprint for the receipt: the text itself is not persisted. */
function fingerprint(listing: PlayListing | null) {
  if (!listing) return null;
  const out: Record<string, { sha256: string; chars: number }> = {};
  for (const field of LISTING_FIELDS) {
    const value = listing[field];
    if (value !== undefined) out[field] = { sha256: hex(value), chars: codePoints(value) };
  }
  return out;
}

const ACTIONS = new Set(["create", "update", "delete", "unchanged"]);
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9._]{0,60}$/;

type NarrowCause = {
  stage?: string;
  provider_cause?: string;
  cause_source?: "structured" | "message";
  message_sha256?: string;
  message_length?: number;
  tried?: string[];
};

/**
 * Keep only fields whose shape is ours: identifiers, a hex digest, a length and the
 * adapter's own pattern descriptions. Anything else the adapter (or Google through
 * it) might add is dropped before it reaches a receipt or a response.
 */
function narrowCause(value: unknown): NarrowCause | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const out: NarrowCause = {};
  for (const key of ["stage", "provider_cause"] as const) {
    const raw = source[key];
    if (typeof raw === "string" && IDENTIFIER_RE.test(raw)) out[key] = raw;
  }
  if (source.cause_source === "structured" || source.cause_source === "message") out.cause_source = source.cause_source;
  if (typeof source.message_sha256 === "string" && /^[0-9a-f]{64}$/.test(source.message_sha256)) out.message_sha256 = source.message_sha256;
  if (Number.isSafeInteger(source.message_length) && (source.message_length as number) >= 0) out.message_length = source.message_length as number;
  if (Array.isArray(source.tried)) {
    const tried = source.tried.filter((item): item is string => typeof item === "string" && item.length <= 200 && /^[A-Z_]+: /.test(item)).slice(0, 16);
    if (tried.length) out.tried = tried;
  }
  return Object.keys(out).length ? out : null;
}

async function takeListingLock(db: D1Database, appId: string, packageName: string, operationId: string, actor: string): Promise<boolean> {
  const now = Date.now();
  // A listing push lives inside one request; a row older than this is a crashed one.
  await db.prepare("DELETE FROM play_store_listing_locks WHERE app_id = ?1 AND package_name = ?2 AND acquired_at < ?3")
    .bind(appId, packageName, now - LOCK_STALE_MS).run();
  try {
    const result = await db.prepare(
      `INSERT INTO play_store_listing_locks (app_id, package_name, operation_id, acquired_by, acquired_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE NOT EXISTS (SELECT 1 FROM play_edit_locks WHERE app_id = ?1 AND package_name = ?2)`,
    ).bind(appId, packageName, operationId, actor, now).run();
    return (result.meta?.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

async function releaseListingLock(db: D1Database, operationId: string) {
  await db.prepare("DELETE FROM play_store_listing_locks WHERE operation_id = ?1").bind(operationId).run();
}

async function insertReceipt(db: D1Database, row: {
  id: string; appId: string; packageName: string; operationId: string;
  mode: "dry_run" | "commit"; verdict: "validated" | "committed" | "no_changes" | "failed-closed";
  editId: string | null; languages: string[]; payload: unknown; actor: string; createdAt: number;
}) {
  await db.prepare(
    `INSERT INTO play_store_listing_receipts
     (id, app_id, package_name, operation_id, mode, verdict, play_edit_id, languages_json, payload_json, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    row.id, row.appId, row.packageName, row.operationId, row.mode, row.verdict, row.editId,
    JSON.stringify(row.languages), JSON.stringify(row.payload), row.actor, row.createdAt,
  ).run();
}

/** GET: the live listing, as Google's Listing resources. App publisher. */
export async function handleGetPlayStoreListing(c: AdminContext) {
  const binding = await resolveBinding(c);
  if (binding instanceof Response) return binding;
  let reply;
  try {
    reply = await c.env.PLAY_RELEASE_SERVICE!.readStoreListings({ credential: binding.credential, packageName: binding.package_name! });
  } catch {
    return fail(c, 502, { code: "play_api_error", failure_code: "play_adapter_unavailable", message: "Google Play store listing read failed" });
  }
  if (!reply?.ok) {
    return fail(c, 502, { code: "play_api_error", failure_code: reply?.error?.code ?? "play_adapter_error", message: reply?.error?.message ?? "Google Play store listing read failed" });
  }
  return c.json({
    package_name: reply.value.package_name,
    default_language: reply.value.default_language,
    listings: reply.value.listings,
  });
}

/** POST: push listings in one edit (dry_run or commit). App publisher. */
export async function handlePushPlayStoreListing(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const actorType = currentActorInfo(c).type;
  if (actorType !== "human" && actorType !== "agent") {
    return fail(c, 403, { code: "forbidden", failure_code: "actor_not_allowed", message: "Store listing changes require an authenticated human or agent publisher" });
  }
  let input: StoreListingPushInput;
  try {
    input = normalizeStoreListingPush(await c.req.json().catch(() => null));
  } catch (error) {
    if (!(error instanceof StoreListingInputError)) throw error;
    return fail(c, 400, { code: "gate_failed", failure_code: error.failureCode, message: error.message, ...error.details });
  }
  const binding = await resolveBinding(c);
  if (binding instanceof Response) return binding;
  const packageName = binding.package_name!;
  const actor = currentActor(c);
  const operationId = crypto.randomUUID();
  if (!(await takeListingLock(c.env.DB, appId, packageName, operationId, actor))) {
    return fail(c, 409, { code: "edit_conflict", failure_code: "play_edit_locked", message: "another Hands Play edit is active for this package" });
  }
  try {
    const requested = input.listings.map((listing) => listing.language);
    const base = {
      schema_version: 1,
      kind: "play-store-listing",
      operation_id: operationId,
      actor,
      package_name: packageName,
      mode: input.mode,
      requested: {
        languages: requested,
        delete_unlisted_languages: input.delete_unlisted_languages,
        changes_not_sent_for_review: input.changes_not_sent_for_review,
        listings: Object.fromEntries(input.listings.map((listing) => [listing.language, fingerprint(listing)])),
      },
    };
    let reply;
    try {
      reply = await c.env.PLAY_RELEASE_SERVICE!.pushStoreListings({
        credential: binding.credential,
        packageName,
        operationId,
        mode: input.mode,
        listings: input.listings,
        deleteUnlistedLanguages: input.delete_unlisted_languages,
        changesNotSentForReview: input.changes_not_sent_for_review,
      });
    } catch {
      reply = { ok: false as const, error: { status: 502, code: "play_adapter_unavailable", message: "Google Play store listing request failed" } };
    }
    const receiptId = crypto.randomUUID();
    const createdAt = Date.now();
    if (!reply?.ok) {
      const code = typeof reply?.error?.code === "string" && IDENTIFIER_RE.test(reply.error.code) ? reply.error.code : "play_adapter_error";
      const cause = narrowCause(reply?.error?.cause);
      await insertReceipt(c.env.DB, {
        id: receiptId, appId, packageName, operationId, mode: input.mode, verdict: "failed-closed",
        editId: null, languages: requested, actor, createdAt,
        payload: { ...base, receipt_id: receiptId, created_at: new Date(createdAt).toISOString(),
          result: { status: "failed-closed", failure_code: code, ...(cause ? { cause } : {}) } },
      });
      const status = reply?.error?.status;
      if (code === "play_edit_in_review" || code === "play_changes_not_sent_for_review") {
        return fail(c, 409, { code: "edit_in_review", failure_code: code, message: reply.error.message, receipt_id: receiptId, ...(cause ? { cause } : {}) });
      }
      if (code === "play_edit_state_unknown" || code === "play_commit_ambiguous") {
        return fail(c, 502, { code: "edit_state_unknown", failure_code: code, message: reply.error.message, receipt_id: receiptId, ...(cause ? { cause } : {}) });
      }
      return fail(c, status === 400 ? 400 : 502, {
        code: status === 400 ? "gate_failed" : "play_api_error",
        failure_code: code,
        message: reply?.error?.message ?? "Google Play store listing request failed",
        receipt_id: receiptId,
        ...(cause ? { cause } : {}),
      });
    }
    const value = reply.value;
    const changes = (Array.isArray(value.changes) ? value.changes : [])
      .filter((change) => change && typeof change.language === "string" && ACTIONS.has(change.action));
    const verdict = value.outcome === "committed" ? "committed" : value.outcome === "no_changes" ? "no_changes" : "validated";
    await insertReceipt(c.env.DB, {
      id: receiptId, appId, packageName, operationId, mode: input.mode, verdict,
      editId: typeof value.edit_id === "string" ? value.edit_id : null,
      languages: changes.filter((change) => change.action !== "unchanged").map((change) => change.language),
      actor, createdAt,
      payload: {
        ...base,
        receipt_id: receiptId,
        created_at: new Date(createdAt).toISOString(),
        play: {
          edit_id: value.edit_id,
          default_language: value.default_language,
          // dry_run: edits.validate passed and the edit was deleted; commit: committed
          // and read back from a new edit by the adapter.
          edit_disposition: verdict === "committed" ? "committed" : "deleted",
          changes_not_sent_for_review: value.changes_not_sent_for_review === true,
        },
        changes: changes.map((change) => ({
          language: change.language,
          action: change.action,
          changed_fields: change.changed_fields,
          before: fingerprint(change.before),
          after: fingerprint(change.after),
        })),
        result: { status: verdict },
      },
    });
    return c.json({
      receipt_id: receiptId,
      operation_id: operationId,
      package_name: packageName,
      edit_id: value.edit_id,
      mode: input.mode,
      outcome: value.outcome,
      default_language: value.default_language,
      changes_not_sent_for_review: value.changes_not_sent_for_review === true,
      changes,
    });
  } finally {
    await releaseListingLock(c.env.DB, operationId);
  }
}

/** GET receipts, newest first. App viewer. */
export async function handleListPlayStoreListingReceipts(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const limitRaw = Number(c.req.query("limit") ?? 20);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
  const result = await c.env.DB.prepare(
    `SELECT id, package_name, operation_id, mode, verdict, play_edit_id, languages_json, payload_json, created_by, created_at
     FROM play_store_listing_receipts WHERE app_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2`,
  ).bind(appId, limit).all();
  const parse = (value: unknown) => {
    try { return JSON.parse(String(value)); } catch { return null; }
  };
  return c.json({
    receipts: result.results.map((row) => ({
      id: row.id,
      package_name: row.package_name,
      operation_id: row.operation_id,
      mode: row.mode,
      verdict: row.verdict,
      play_edit_id: row.play_edit_id,
      languages: parse(row.languages_json),
      payload: parse(row.payload_json),
      created_by: row.created_by,
      created_at: row.created_at,
    })),
  });
}
