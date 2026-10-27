import { PlayAdapterError } from "./errors";
import type { GooglePlayClient } from "./google_play";
import { PLAY_LISTING_FIELDS } from "./types";
import type {
  PlayListing,
  PlayListingField,
  StoreListingChange,
  StoreListingMode,
  StoreListingPushResult,
  StoreListingReadResult,
} from "./types";

/**
 * Play Console store listing character limits ("Create and set up your app",
 * support.google.com/googleplay/android-developer/answer/9859152): app name 30,
 * short description 80, full description 4,000. Google states the limits apply
 * to full-width and half-width characters alike, so Hands counts Unicode code
 * points. Discovery documents no limit for `video` (a YouTube URL); Hands bounds
 * it only so a request cannot carry an unbounded string.
 */
export const LISTING_LIMITS: Record<PlayListingField, number> = {
  title: 30,
  shortDescription: 80,
  fullDescription: 4000,
  video: 2048,
};

/** Fields Play Console requires before a language can be published. */
const REQUIRED_FOR_NEW_LANGUAGE: PlayListingField[] = ["title", "shortDescription", "fullDescription"];
const PLAY_LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
/** Play lists 86 store listing languages; one request may name each at most once. */
export const MAX_LISTING_LANGUAGES = 100;

export function codePoints(value: string): number {
  return [...value].length;
}

/**
 * Shape and limit checks at the adapter trust boundary. The supported-language
 * list is enforced by Hands before any Play call; the adapter re-checks shape,
 * uniqueness and Google's documented limits, and refuses rather than truncates.
 */
export function storeListingsInput(value: unknown): PlayListing[] {
  if (!Array.isArray(value) || value.length > MAX_LISTING_LANGUAGES) {
    throw new PlayAdapterError(400, "listing_request_invalid", "Store listings must be a list of Listing resources");
  }
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    const language = typeof row?.language === "string" ? row.language : "";
    if (!row || !PLAY_LANGUAGE.test(language) || seen.has(language.toLowerCase())) {
      throw new PlayAdapterError(400, "listing_language_invalid", "Each listing needs a unique Play language tag");
    }
    seen.add(language.toLowerCase());
    const listing: PlayListing = { language };
    for (const key of Object.keys(row)) {
      if (key !== "language" && !(PLAY_LISTING_FIELDS as readonly string[]).includes(key)) {
        throw new PlayAdapterError(400, "listing_field_unknown", `Listing field ${key} is not a Google Play Listing field`);
      }
    }
    for (const field of PLAY_LISTING_FIELDS) {
      const raw = row[field];
      if (raw === undefined) continue;
      if (typeof raw !== "string") {
        throw new PlayAdapterError(400, "listing_field_invalid", `${language} ${field} must be a string`);
      }
      if (field !== "video" && !raw.trim()) {
        throw new PlayAdapterError(400, "listing_field_empty", `${language} ${field} must not be empty`);
      }
      if (codePoints(raw) > LISTING_LIMITS[field]) {
        throw new PlayAdapterError(400, "listing_field_too_long", `${language} ${field} exceeds ${LISTING_LIMITS[field]} characters`);
      }
      listing[field] = raw;
    }
    if (PLAY_LISTING_FIELDS.every((field) => listing[field] === undefined)) {
      throw new PlayAdapterError(400, "listing_field_missing", `${language} has no Listing fields to write`);
    }
    return listing;
  });
}

function changedFields(before: PlayListing | null, after: PlayListing | null): PlayListingField[] {
  return PLAY_LISTING_FIELDS.filter((field) => (before?.[field] ?? "") !== (after?.[field] ?? ""));
}

/** Merge requested fields over what Play holds; the result is the full resource edits.listings.update writes. */
function merged(current: PlayListing | undefined, requested: PlayListing): PlayListing {
  const out: PlayListing = { language: requested.language };
  for (const field of PLAY_LISTING_FIELDS) {
    const value = requested[field] ?? current?.[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/**
 * Plan the per-language diff against the listings Play holds in `editId`.
 * Pure: no Play call. Exported for tests and so a later "apply to an existing
 * edit" path can reuse it unchanged.
 */
export function planStoreListings(
  current: PlayListing[],
  requested: PlayListing[],
  options: { deleteUnlistedLanguages: boolean; defaultLanguage: string | null },
): StoreListingChange[] {
  const byLanguage = new Map(current.map((listing) => [listing.language, listing]));
  const changes: StoreListingChange[] = [];
  for (const listing of requested) {
    const before = byLanguage.get(listing.language);
    const after = merged(before, listing);
    if (!before) {
      const missing = REQUIRED_FOR_NEW_LANGUAGE.filter((field) => !after[field]);
      if (missing.length > 0) {
        throw new PlayAdapterError(400, "listing_fields_required", `${listing.language} is a new language and needs ${missing.join(", ")}`);
      }
    }
    const fields = changedFields(before ?? null, after);
    changes.push({
      language: listing.language,
      action: !before ? "create" : fields.length > 0 ? "update" : "unchanged",
      changed_fields: fields,
      before: before ?? null,
      after,
    });
  }
  if (options.deleteUnlistedLanguages) {
    const wanted = new Set(requested.map((listing) => listing.language));
    for (const listing of current) {
      if (wanted.has(listing.language)) continue;
      if (options.defaultLanguage && listing.language === options.defaultLanguage) {
        throw new PlayAdapterError(400, "listing_default_language_delete", `${listing.language} is the app's default language and cannot be deleted`);
      }
      changes.push({ language: listing.language, action: "delete", changed_fields: changedFields(listing, null), before: listing, after: null });
    }
  }
  return changes;
}

/**
 * Apply a planned diff to an already-open edit: one edits.listings.update per
 * create/update, one edits.listings.delete per delete. Does not validate, commit
 * or delete the edit -- that is the caller's transaction decision. Google's
 * update response must echo what was written.
 */
export async function applyStoreListingChanges(
  client: GooglePlayClient,
  packageName: string,
  editId: string,
  changes: StoreListingChange[],
): Promise<void> {
  for (const change of changes) {
    if (change.action === "create" || change.action === "update") {
      const written = await client.updateListing(packageName, editId, change.after!);
      if (changedFields(change.after, written).length > 0) {
        throw new PlayAdapterError(502, "play_listing_readback_mismatch", `Google Play did not echo the ${change.language} listing Hands wrote`, { stage: "update_listing" });
      }
    } else if (change.action === "delete") {
      await client.deleteListing(packageName, editId, change.language);
    }
  }
}

/** Read every listing plus the default language in a throwaway edit. */
export async function readStoreListings(client: GooglePlayClient, packageName: string): Promise<StoreListingReadResult> {
  const editId = await client.createEdit(packageName);
  let result: StoreListingReadResult;
  try {
    const defaultLanguage = await client.getDefaultLanguage(packageName, editId);
    const listings = await client.listListings(packageName, editId);
    result = {
      package_name: packageName,
      default_language: defaultLanguage,
      listings: listings.sort((a, b) => a.language.localeCompare(b.language)),
    };
  } catch (error) {
    await client.cleanupOrThrow(packageName, editId, error);
  }
  await client.deleteEdit(packageName, editId);
  return result!;
}

/**
 * Translate a commit rejection Google answered into a specific, actionable code.
 * The classified cause is a constant from provider_errors; Google's text never
 * reaches here.
 */
function commitRejection(error: unknown): unknown {
  if (!(error instanceof PlayAdapterError) || error.code !== "play_api_rejected") return error;
  const cause = error.cause_detail?.provider_cause;
  if (cause === "EDIT_IN_REVIEW") {
    return new PlayAdapterError(409, "play_edit_in_review",
      "Another change for this app is in review on Google Play (Hands commits with ERROR_IF_IN_REVIEW and never cancels it); the store listing was not committed. Wait for the review to finish, then push again.",
      error.cause_detail);
  }
  if (cause === "CHANGES_NOT_SENT_FOR_REVIEW") {
    return new PlayAdapterError(409, "play_changes_not_sent_for_review",
      "Google Play requires this app's changes to be sent for review from Play Console; the store listing was not committed. Push again with changes_not_sent_for_review=true to add it to the pending changes, then send them for review in Play Console.",
      error.cause_detail);
  }
  return error;
}

/**
 * One edit per push: open -> read -> plan -> apply -> edits.validate ->
 * (dry_run: delete | commit: commit, then read back from a new edit).
 *
 * Every step before commit deletes the edit on failure. A commit Google rejected
 * leaves the edit valid (ERROR_IF_IN_REVIEW "won't invalidate the edit"), so it is
 * deleted too; a commit that got no answer is ambiguous and is left alone.
 */
export async function pushStoreListings(
  client: GooglePlayClient,
  request: {
    packageName: string;
    mode: StoreListingMode;
    listings: PlayListing[];
    deleteUnlistedLanguages: boolean;
    changesNotSentForReview: boolean;
  },
): Promise<StoreListingPushResult> {
  const { packageName } = request;
  const editId = await client.createEdit(packageName);
  let changes: StoreListingChange[] = [];
  let defaultLanguage: string | null = null;
  let committed = false;
  try {
    defaultLanguage = await client.getDefaultLanguage(packageName, editId);
    const current = await client.listListings(packageName, editId);
    changes = planStoreListings(current, request.listings, {
      deleteUnlistedLanguages: request.deleteUnlistedLanguages,
      defaultLanguage,
    });
    const effective = changes.filter((change) => change.action !== "unchanged");
    if (effective.length === 0) {
      await client.deleteEdit(packageName, editId);
      return result("no_changes");
    }
    await applyStoreListingChanges(client, packageName, editId, effective);
    await client.validateEdit(packageName, editId);
    if (request.mode === "dry_run") {
      await client.deleteEdit(packageName, editId);
      return result("validated");
    }
    try {
      await client.commitEdit(packageName, editId, { changesNotSentForReview: request.changesNotSentForReview });
      committed = true;
    } catch (error) {
      // No HTTP answer: Google may or may not have committed. Do not touch the edit.
      if (error instanceof PlayAdapterError && error.code === "play_api_unavailable") {
        committed = true;
        throw new PlayAdapterError(502, "play_commit_ambiguous", "Google Play did not answer the commit; check Play Console before pushing again", { stage: "commit_edit" });
      }
      throw commitRejection(error);
    }
  } catch (error) {
    if (committed) throw error;
    await client.cleanupOrThrow(packageName, editId, error);
  }
  // Read back from a fresh edit: the committed listing is what a new edit sees.
  const after = await readStoreListings(client, packageName);
  const live = new Map(after.listings.map((listing) => [listing.language, listing]));
  for (const change of changes) {
    const seen = live.get(change.language) ?? null;
    const mismatch = change.action === "delete" ? seen !== null : changedFields(change.after, seen).length > 0;
    if (mismatch) {
      throw new PlayAdapterError(502, "play_listing_readback_mismatch", `Google Play readback for ${change.language} did not match the committed listing`, { stage: "readback" });
    }
  }
  return result("committed");

  function result(outcome: StoreListingPushResult["outcome"]): StoreListingPushResult {
    return {
      edit_id: editId,
      package_name: packageName,
      mode: request.mode,
      outcome,
      default_language: defaultLanguage,
      changes,
      changes_not_sent_for_review: request.changesNotSentForReview,
    };
  }
}
