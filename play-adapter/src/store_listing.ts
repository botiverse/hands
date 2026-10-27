import { PlayAdapterError } from "./errors";
import { editStatePatternsTried } from "./provider_errors";
import type { GooglePlayClient } from "./google_play";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { PLAY_AI_GENERATED_STATES, PLAY_IMAGE_TYPES, PLAY_LISTING_FIELDS } from "./types";
import type {
  PlayImageRef,
  PlayImageType,
  UploadedImageRecord,
  StoreListingImageChange,
  StoreListingImageSetInput,
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

/** edits.images.upload mediaUpload.maxSize (discovery revision 20261027). */
export const MAX_IMAGE_BYTES = 15_728_640;
/** Hands' per-push binary bound: stays well inside the Workers RPC message size. */
export const MAX_IMAGE_PUSH_BYTES = 24 * 1024 * 1024;
/** Image types Hands implements; the rest of Google's enum is "not supported yet". */
export const SUPPORTED_IMAGE_TYPES: ReadonlySet<PlayImageType> = new Set([
  "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots", "tvScreenshots", "wearScreenshots",
  "icon", "featureGraphic", "tvBanner",
]);
const SINGLE_IMAGE_TYPES: ReadonlySet<PlayImageType> = new Set(["icon", "featureGraphic", "tvBanner"]);
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Image sets at the adapter boundary. Hands has already checked format, pixel
 * size and per-type counts before opening any edit; the adapter re-checks what it
 * can without decoding: Google's enum, the declared sha256 against the bytes, the
 * upload size bound and the count bound.
 */
export function storeListingImagesInput(value: unknown): StoreListingImageSetInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new PlayAdapterError(400, "image_request_invalid", "Image sets must be a list");
  }
  const seen = new Set<string>();
  let total = 0;
  return value.map((item: unknown) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const language = typeof row?.language === "string" ? row.language : "";
    const imageType = row?.imageType;
    if (!row || !PLAY_LANGUAGE.test(language)) {
      throw new PlayAdapterError(400, "image_request_invalid", "Each image set needs a Play language tag");
    }
    if (typeof imageType !== "string" || !(PLAY_IMAGE_TYPES as readonly string[]).includes(imageType)) {
      throw new PlayAdapterError(400, "image_type_invalid", "imageType is not a Google Play imageType");
    }
    if (!SUPPORTED_IMAGE_TYPES.has(imageType as PlayImageType)) {
      throw new PlayAdapterError(400, "image_type_not_supported", `imageType ${imageType} is not supported yet`);
    }
    const key = `${language.toLowerCase()}/${imageType}`;
    if (seen.has(key)) throw new PlayAdapterError(400, "image_request_invalid", `${language} ${imageType} appears more than once`);
    seen.add(key);
    const images = row.images;
    const max = SINGLE_IMAGE_TYPES.has(imageType as PlayImageType) ? 1 : 8;
    if (!Array.isArray(images) || images.length < 1 || images.length > max) {
      throw new PlayAdapterError(400, "image_count_invalid", `${language} ${imageType} takes 1-${max} images`);
    }
    return {
      language,
      imageType: imageType as PlayImageType,
      images: images.map((image: unknown) => {
        const entry = image && typeof image === "object" ? image as Record<string, unknown> : null;
        const bytes = entry?.bytes;
        const sha = typeof entry?.sha256 === "string" ? entry.sha256 : "";
        const contentType = entry?.contentType;
        const ai = entry?.aiGeneratedState;
        if (!(bytes instanceof Uint8Array) || !SHA256.test(sha) || (contentType !== "image/png" && contentType !== "image/jpeg")
          || (ai !== undefined && !(PLAY_AI_GENERATED_STATES as readonly unknown[]).includes(ai))) {
          throw new PlayAdapterError(400, "image_request_invalid", `${language} ${imageType}: malformed image declaration`);
        }
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
          throw new PlayAdapterError(413, "image_too_large", `${language} ${imageType}: image exceeds ${MAX_IMAGE_BYTES} bytes`);
        }
        total += bytes.byteLength;
        if (total > MAX_IMAGE_PUSH_BYTES) {
          throw new PlayAdapterError(413, "images_request_too_large", `Images in one push exceed ${MAX_IMAGE_PUSH_BYTES} bytes`);
        }
        if (bytesToHex(sha256(bytes)) !== sha) {
          throw new PlayAdapterError(409, "image_integrity_mismatch", `${language} ${imageType}: bytes do not match the declared sha256`);
        }
        const out: StoreListingImageSetInput["images"][number] = { bytes, sha256: sha, contentType };
        if (ai !== undefined) out.aiGeneratedState = ai as NonNullable<typeof out.aiGeneratedState>;
        return out;
      }),
    };
  });
}

/**
 * Read the current sets and decide replace vs unchanged: unchanged only when Google
 * reports exactly our sha256 sequence. If Google's sha256 ever stops being a digest
 * of the uploaded bytes, sets are simply always replaced -- never wrongly skipped.
 */
async function planImages(
  client: GooglePlayClient,
  packageName: string,
  editId: string,
  sets: StoreListingImageSetInput[],
  languages: ReadonlySet<string>,
): Promise<StoreListingImageChange[]> {
  const changes: StoreListingImageChange[] = [];
  for (const set of sets) {
    // Google: "There must be a store listing for the specified language."
    if (!languages.has(set.language)) {
      throw new PlayAdapterError(400, "image_language_has_no_listing", `${set.language} has no store listing; add its text in the same push first`);
    }
    const before = await client.listImages(packageName, editId, set.language, set.imageType);
    const same = before.length === set.images.length && before.every((image, index) => image.sha256 === set.images[index]!.sha256);
    changes.push({
      language: set.language,
      imageType: set.imageType,
      action: same ? "unchanged" : "replace",
      before,
      after: same
        ? before.map((image, index) => record(image, set.images[index]!))
        : [],
    });
  }
  return changes;
}

function record(uploaded: PlayImageRef, image: StoreListingImageSetInput["images"][number]): UploadedImageRecord {
  return {
    id: uploaded.id,
    sha256: image.sha256,
    provider_sha256: uploaded.sha256,
    sha256_match: uploaded.sha256 === null ? null : uploaded.sha256 === image.sha256,
    size_bytes: image.bytes.byteLength,
    aiGeneratedState: image.aiGeneratedState ?? null,
  };
}

/** deleteall + ordered uploads for every replace; fills in Google's image ids. */
async function applyImages(
  client: GooglePlayClient,
  packageName: string,
  editId: string,
  sets: StoreListingImageSetInput[],
  changes: StoreListingImageChange[],
): Promise<void> {
  for (const [index, change] of changes.entries()) {
    if (change.action !== "replace") continue;
    const set = sets[index]!;
    await client.deleteAllImages(packageName, editId, set.language, set.imageType);
    for (const image of set.images) {
      const uploaded = await client.uploadImage(packageName, editId, set.language, set.imageType, image);
      change.after.push(record(uploaded, image));
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

async function readImages(client: GooglePlayClient, packageName: string, language: string, imageType: PlayImageType) {
  const editId = await client.createEdit(packageName);
  let images: Awaited<ReturnType<GooglePlayClient["listImages"]>>;
  try {
    images = await client.listImages(packageName, editId, language, imageType);
  } catch (error) {
    await client.cleanupOrThrow(packageName, editId, error);
  }
  await client.deleteEdit(packageName, editId);
  return images!;
}

/**
 * Translate a validate/commit rejection Google answered into a specific code.
 *
 * In-review and not-sent-for-review are recognised only by matching Google's
 * message (provider_errors classifies it into a constant; Google's text never
 * reaches here), and that text can change or be localised. So a rejection whose
 * message matches none of the known patterns is never passed on as a generic
 * failure that could be misread: it becomes `play_edit_state_unknown`, which tells
 * the caller to check Play Console. Recognised non-review causes keep
 * `play_api_rejected` with their classified cause.
 */
function editStateRejection(error: unknown, stage: "validate_edit" | "commit_edit"): unknown {
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
  if (!cause || cause === "OTHER") return editStateUnknown(stage, "OTHER", error.cause_detail);
  return error;
}

/**
 * Google's answer cannot be classified: report failure, never success. Carries the
 * patterns tried and, when Google sent a message, its sha256 + length for
 * correlation with the operator log -- never the text.
 */
function editStateUnknown(
  stage: "validate_edit" | "commit_edit",
  providerCause: string,
  detail?: { message_sha256?: string; message_length?: number },
): PlayAdapterError {
  return new PlayAdapterError(502, "play_edit_state_unknown",
    `Google Play answered ${stage === "commit_edit" ? "the commit" : "validation"} in a way Hands does not recognise; the store listing is not reported as ${stage === "commit_edit" ? "committed" : "validated"}. Check the app in Play Console before pushing again.`,
    {
      stage,
      provider_cause: providerCause,
      tried: editStatePatternsTried(),
      ...(detail?.message_sha256 ? { message_sha256: detail.message_sha256, message_length: detail.message_length } : {}),
    });
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
    images?: StoreListingImageSetInput[];
  },
): Promise<StoreListingPushResult> {
  const imageSets = request.images ?? [];
  const { packageName } = request;
  const editId = await client.createEdit(packageName);
  let changes: StoreListingChange[] = [];
  let imageChanges: StoreListingImageChange[] = [];
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
    const languagesAfter = new Set(current.map((listing) => listing.language));
    for (const change of changes) {
      if (change.action === "delete") languagesAfter.delete(change.language);
      else languagesAfter.add(change.language);
    }
    imageChanges = await planImages(client, packageName, editId, imageSets, languagesAfter);
    if (effective.length === 0 && imageChanges.every((change) => change.action === "unchanged")) {
      await client.deleteEdit(packageName, editId);
      return result("no_changes");
    }
    // Text first: a language created in this push must exist before its images.
    await applyStoreListingChanges(client, packageName, editId, effective);
    await applyImages(client, packageName, editId, imageSets, imageChanges);
    try {
      await client.validateEdit(packageName, editId);
    } catch (error) {
      throw editStateRejection(error, "validate_edit");
    }
    if (request.mode === "dry_run") {
      await client.deleteEdit(packageName, editId);
      return result("validated");
    }
    let committedId: string | null;
    try {
      committedId = await client.commitEdit(packageName, editId, { changesNotSentForReview: request.changesNotSentForReview });
    } catch (error) {
      // No HTTP answer: Google may or may not have committed. Do not touch the edit.
      if (error instanceof PlayAdapterError && error.code === "play_api_unavailable") {
        committed = true;
        throw new PlayAdapterError(502, "play_commit_ambiguous", "Google Play did not answer the commit; check Play Console before pushing again", { stage: "commit_edit" });
      }
      // A 2xx whose body is not an AppEdit: Google may have committed. Not success,
      // and the edit is left alone.
      if (error instanceof PlayAdapterError && error.code === "play_api_malformed") {
        committed = true;
        throw editStateUnknown("commit_edit", "MALFORMED_RESPONSE");
      }
      throw editStateRejection(error, "commit_edit");
    }
    committed = true;
    // edits.commit returns the AppEdit; anything but this edit's id is not a commit we can vouch for.
    if (committedId !== editId) throw editStateUnknown("commit_edit", "MALFORMED_RESPONSE");
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
  for (const change of imageChanges) {
    if (change.action !== "replace") continue;
    const live = await readImages(client, packageName, change.language, change.imageType);
    // Count is the fail-closed check; Google's sha256 is recorded, not trusted.
    if (live.length !== change.after.length) {
      throw new PlayAdapterError(502, "play_image_readback_mismatch", `Google Play readback for ${change.language} ${change.imageType} lists ${live.length} images, not ${change.after.length}`, { stage: "readback" });
    }
    change.readback = {
      count: live.length,
      sha256_match: live.some((image) => image.sha256 === null)
        ? null
        : live.every((image, index) => image.sha256 === change.after[index]!.sha256),
    };
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
      image_changes: imageChanges,
      changes_not_sent_for_review: request.changesNotSentForReview,
    };
  }
}
