import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Command } from "commander";
import { agentAwareFetch, apiRequest, getApiBase, QuiverApiError } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

/** androidpublisher v3 `Listing` fields, verbatim. */
export const LISTING_FIELDS = ["title", "shortDescription", "fullDescription", "video"] as const;
type ListingField = typeof LISTING_FIELDS[number];
export type PlayListing = { language: string } & Partial<Record<ListingField, string>>;

type AppRow = { id: string; slug: string };

/** Google's full edits.images imageType enum; the server says which ones are supported yet. */
export const PLAY_IMAGE_TYPES = [
  "appImageTypeUnspecified", "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots",
  "tvScreenshots", "wearScreenshots", "icon", "featureGraphic", "tvBanner",
] as const;
export const PLAY_AI_GENERATED_STATES = [
  "aiGeneratedStateUnspecified", "aiGeneratedStateNotAiGenerated", "aiGeneratedStateAiGeneratedDeveloperAttested",
] as const;

/** Device folder names (designer export layout) -> Play imageType. */
export const DEVICE_FOLDERS: Record<string, string> = {
  phone: "phoneScreenshots",
  "tablet-7": "sevenInchScreenshots",
  "tablet-10": "tenInchScreenshots",
  tv: "tvScreenshots",
  wear: "wearScreenshots",
  icon: "icon",
  "feature-graphic": "featureGraphic",
  "tv-banner": "tvBanner",
};

/**
 * Explicit image language folder -> Play tag table. A folder already named with a
 * Play tag (en-US, zh-CN, ...) passes through; nothing else is guessed. The server
 * rejects anything that is not a Play store listing language.
 */
export const FOLDER_LANGUAGES: Record<string, string> = {
  en: "en-US",
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
  ja: "ja-JP",
  ko: "ko-KR",
};

const DEFAULT_FOLDER = "default";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
/** Must match the server's per-push image bound. */
export const MAX_IMAGE_PUSH_BYTES = 24 * 1024 * 1024;

export interface ImageSetPlan {
  language: string;
  imageType: string;
  files: string[];
  /** Where the set came from: a language folder or default/. */
  source: "language" | "default";
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
}

async function imageFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => entry.name);
  for (const name of files) {
    if (!IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) throw new Error(`${join(dir, name)}: only .png, .jpg and .jpeg images are uploaded`);
  }
  // Play shows images in upload order: filename order, numeric-aware (01-, 02-, ... 10-).
  return files.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((name) => join(dir, name));
}

function folderLanguage(folder: string): string {
  return FOLDER_LANGUAGES[folder] ?? folder;
}

function folderImageType(folder: string): string | null {
  if (DEVICE_FOLDERS[folder]) return DEVICE_FOLDERS[folder]!;
  return (PLAY_IMAGE_TYPES as readonly string[]).includes(folder) ? folder : null;
}

/**
 * Read an images directory in either layout:
 *   <dir>/<language>/<imageType>/NN-name.png         (language first; imageType = Google enum name)
 *   <dir>/<device>/<language>/NN-name.png            (device first, the designer export: phone,
 *                                                     tablet-7, tablet-10, feature-graphic, ...)
 * A `default` language folder applies to every target language that has no folder
 * of its own for that imageType. Targets: listing-file languages, image language
 * folders, and --locales.
 */
export async function collectImageSets(dir: string, options: { languages?: string[]; locales?: string[] } = {}): Promise<ImageSetPlan[]> {
  const top = await subdirs(dir);
  if (top.length === 0) throw new Error(`${dir} has no image folders`);
  const typeFirst = top.every((name) => folderImageType(name) !== null);
  const raw: Array<{ language: string; imageType: string; files: string[] }> = [];
  if (typeFirst) {
    for (const device of top) {
      for (const languageFolder of await subdirs(join(dir, device))) {
        raw.push({ language: languageFolder === DEFAULT_FOLDER ? DEFAULT_FOLDER : folderLanguage(languageFolder), imageType: folderImageType(device)!, files: await imageFiles(join(dir, device, languageFolder)) });
      }
    }
  } else {
    for (const languageFolder of top) {
      for (const typeFolder of await subdirs(join(dir, languageFolder))) {
        const imageType = folderImageType(typeFolder);
        if (!imageType) throw new Error(`${join(dir, languageFolder, typeFolder)}: unknown imageType folder (use ${Object.keys(DEVICE_FOLDERS).join(", ")} or a Play imageType)`);
        raw.push({ language: languageFolder === DEFAULT_FOLDER ? DEFAULT_FOLDER : folderLanguage(languageFolder), imageType, files: await imageFiles(join(dir, languageFolder, typeFolder)) });
      }
    }
  }
  const sets: ImageSetPlan[] = [];
  const seen = new Set<string>();
  for (const set of raw.filter((item) => item.language !== DEFAULT_FOLDER)) {
    const key = `${set.language}/${set.imageType}`;
    if (seen.has(key)) throw new Error(`${key} comes from two folders (e.g. "en" and "en-US"); keep one`);
    seen.add(key);
    if (set.files.length > 0) sets.push({ ...set, source: "language" });
  }
  const defaults = raw.filter((item) => item.language === DEFAULT_FOLDER && item.files.length > 0);
  if (defaults.length > 0) {
    const targets = [...new Set([...(options.languages ?? []), ...sets.map((set) => set.language), ...(options.locales ?? [])])];
    if (targets.length === 0) throw new Error("default/ images need target languages: pass --listing or --locales, or add language folders");
    for (const set of defaults) {
      for (const language of targets) {
        if (!seen.has(`${language}/${set.imageType}`)) sets.push({ language, imageType: set.imageType, files: set.files, source: "default" });
      }
    }
  }
  const filtered = options.locales ? sets.filter((set) => options.locales!.includes(set.language)) : sets;
  return filtered.sort((a, b) => a.language.localeCompare(b.language) || PLAY_IMAGE_TYPES.indexOf(a.imageType as never) - PLAY_IMAGE_TYPES.indexOf(b.imageType as never));
}

type ImageDeclaration = { part: string; sha256: string; aiGeneratedState?: string };

/**
 * Multipart push: a `request` JSON part plus one file part per declared image. The
 * server consumes each part exactly once, so a default/ file used by several
 * languages is sent once per use (the per-push byte bound counts every copy).
 */
async function buildImagePush(sets: ImageSetPlan[], aiGeneratedState: string | undefined) {
  const parts: Array<{ name: string; path: string; bytes: Buffer }> = [];
  const declared: Array<{ language: string; imageType: string; images: ImageDeclaration[] }> = [];
  let total = 0;
  for (const set of sets) {
    const images: ImageDeclaration[] = [];
    for (const path of set.files) {
      const bytes = await readFile(path);
      const name = `img${parts.length + 1}`;
      parts.push({ name, path, bytes });
      total += bytes.byteLength;
      images.push({ part: name, sha256: createHash("sha256").update(bytes).digest("hex"), ...(aiGeneratedState ? { aiGeneratedState } : {}) });
    }
    declared.push({ language: set.language, imageType: set.imageType, images });
  }
  if (total > MAX_IMAGE_PUSH_BYTES) {
    throw new Error(`images total ${total} bytes; Hands accepts ${MAX_IMAGE_PUSH_BYTES} per push. Push fewer languages at a time with --locales.`);
  }
  return { declared, parts, total };
}

export interface StoreListingChange {
  language: string;
  action: "create" | "update" | "delete" | "unchanged";
  changed_fields: ListingField[];
  before: PlayListing | null;
  after: PlayListing | null;
}

export interface StoreListingPushResponse {
  receipt_id: string;
  operation_id: string;
  package_name: string;
  edit_id: string;
  mode: "dry_run" | "commit";
  outcome: "validated" | "committed" | "no_changes";
  default_language: string | null;
  changes_not_sent_for_review: boolean;
  changes: StoreListingChange[];
  image_changes?: Array<{
    language: string;
    imageType: string;
    action: "replace" | "unchanged";
    before: Array<{ id: string; sha256: string }>;
    after: Array<{ id: string; sha256: string; size_bytes: number }>;
  }>;
  image_warnings?: Array<{ code: string; language: string; imageType: string; index: number }>;
}

/**
 * listing.json is either the language-keyed map `hands store-listing pull` writes:
 *   { "en-US": { "title": "...", "shortDescription": "...", "fullDescription": "..." }, ... }
 * or Google's own list shape: { "listings": [ { "language": "en-US", "title": ... } ] }.
 * Keys are passed through untouched; the server validates languages and limits.
 */
export function parseListingFile(raw: unknown): PlayListing[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("listing file must be a JSON object");
  }
  const object = raw as Record<string, unknown>;
  if (Array.isArray(object.listings) && Object.keys(object).length === 1) {
    return object.listings.map((item, index) => {
      if (!item || typeof item !== "object" || typeof (item as PlayListing).language !== "string") {
        throw new Error(`listings[${index}] needs a language`);
      }
      return { ...(item as PlayListing) };
    });
  }
  return Object.entries(object).map(([language, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${language}: expected an object of Listing fields (${LISTING_FIELDS.join(", ")})`);
    }
    if ("language" in value && (value as { language: unknown }).language !== language) {
      throw new Error(`${language}: inner language does not match its key`);
    }
    return { ...(value as Record<string, string>), language };
  });
}

/** The pull format: language -> fields, languages sorted, no inner `language`. */
export function toListingFile(listings: PlayListing[]): Record<string, Partial<Record<ListingField, string>>> {
  const out: Record<string, Partial<Record<ListingField, string>>> = {};
  for (const listing of [...listings].sort((a, b) => a.language.localeCompare(b.language))) {
    const fields: Partial<Record<ListingField, string>> = {};
    for (const field of LISTING_FIELDS) if (listing[field] !== undefined) fields[field] = listing[field];
    out[listing.language] = fields;
  }
  return out;
}

export function selectLocales(listings: PlayListing[], locales: string | undefined): PlayListing[] {
  if (!locales) return listings;
  const wanted = locales.split(",").map((value) => value.trim()).filter(Boolean);
  const missing = wanted.filter((language) => !listings.some((listing) => listing.language === language));
  if (missing.length > 0) throw new Error(`--locales names languages not in the listing file: ${missing.join(", ")}`);
  return listings.filter((listing) => wanted.includes(listing.language));
}

function preview(value: string | undefined): string {
  if (value === undefined) return "(unset)";
  const flat = value.replace(/\s+/g, " ");
  const chars = [...flat];
  return JSON.stringify(chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : flat) + ` [${[...value].length}]`;
}

export function formatPlan(result: StoreListingPushResponse): string {
  const header = result.outcome === "validated"
    ? `Dry run: Google Play validated edit ${result.edit_id} for ${result.package_name}; the edit was deleted, nothing changed.`
    : result.outcome === "committed"
      ? `Committed edit ${result.edit_id} for ${result.package_name}${result.changes_not_sent_for_review ? " (changesNotSentForReview: send it for review in Play Console)" : ""}.`
      : `No changes: ${result.package_name} already has this listing.`;
  const lines = [header];
  for (const change of result.changes) {
    lines.push(`  ${change.action.padEnd(9)} ${change.language}${change.language === result.default_language ? " (default)" : ""}`);
    for (const field of change.changed_fields) {
      lines.push(`      ${field}: ${preview(change.before?.[field])} -> ${preview(change.after?.[field])}`);
    }
  }
  for (const change of result.image_changes ?? []) {
    lines.push(`  ${(change.action === "replace" ? "images" : "unchanged").padEnd(9)} ${change.language} ${change.imageType}: ${change.before.length} -> ${change.action === "replace" ? change.after.length : change.before.length}`);
  }
  for (const warning of result.image_warnings ?? []) {
    lines.push(`  warning   ${warning.language} ${warning.imageType} #${warning.index + 1}: ${warning.code} (Google reported a different sha256; recorded, not a failure)`);
  }
  lines.push(`Receipt: ${result.receipt_id}`);
  if (result.outcome === "validated") lines.push("Run again with --commit to publish this change.");
  return lines.join("\n");
}

/** Hands Play routes nest the error; surface its message and stable code to index.ts. */
async function call<T>(path: string, opts: Parameters<typeof apiRequest>[1]): Promise<T> {
  try {
    return await apiRequest<T>(path, opts);
  } catch (error) {
    const body = error instanceof QuiverApiError ? (error.body as { error?: Record<string, unknown> } | null) : null;
    const nested = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error : null;
    if (error instanceof QuiverApiError && nested) {
      const code = typeof nested.failure_code === "string" ? nested.failure_code : nested.code;
      const receipt = typeof nested.receipt_id === "string" ? ` (receipt ${nested.receipt_id})` : "";
      throw new QuiverApiError(error.status, { ...nested, code }, `${String(nested.message ?? error.message)}${receipt}`);
    }
    throw error;
  }
}

async function postMultipart<T>(path: string, request: unknown, parts: Array<{ name: string; path: string; bytes: Buffer }>): Promise<T> {
  const url = new URL(path, getApiBase());
  const res = await agentAwareFetch((bearer) => {
    const form = new FormData();
    form.append("request", JSON.stringify(request));
    for (const part of parts) {
      const type = extname(part.path).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
      form.append(part.name, new Blob([new Uint8Array(part.bytes)], { type }), part.path.split(/[\\/]/).pop());
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return fetch(url.toString(), { method: "POST", headers, body: form });
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    const nested = data && typeof data === "object" ? (data as { error?: Record<string, unknown> }).error : null;
    if (nested && typeof nested === "object") {
      const code = typeof nested.failure_code === "string" ? nested.failure_code : nested.code;
      const receipt = typeof nested.receipt_id === "string" ? ` (receipt ${nested.receipt_id})` : "";
      throw new QuiverApiError(res.status, { ...nested, code }, `${String(nested.message ?? res.statusText)}${receipt}`);
    }
    throw new QuiverApiError(res.status, data, `${res.status} ${res.statusText}`);
  }
  return data as T;
}

async function resolveAppId(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input)) return input;
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const app = apps.find((item) => item.slug === input);
  if (!app) throw new Error(`App not found: ${input}`);
  return app.id;
}

/**
 * `hands store-listing` -- Google Play store listing text (edits.listings) through
 * Hands. Hands holds the Google credential; the CLI never sees it.
 */
export function registerStoreListingCommands(program: Command): void {
  const group = program.command("store-listing").description("Google Play store listing text (title, short/full description, video) through Hands.");

  group
    .command("pull <appIdOrSlug>")
    .description("Read the live Google Play listing; writes the same language-keyed JSON that push accepts.")
    .option("--out <file>", "Write listing JSON to this file instead of stdout.")
    .option("--json", "Output the raw API response.", false)
    .action(async (appIdOrSlug: string, opts: { out?: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await call<{ package_name: string; default_language: string | null; listings: PlayListing[] }>(
        `/api/apps/${appId}/distributions/play/store-listing`, {},
      );
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const file = `${JSON.stringify(toListingFile(result.listings), null, 2)}\n`;
      if (opts.out) {
        await writeFile(opts.out, file);
        console.error(`Wrote ${result.listings.length} language(s) for ${result.package_name} to ${opts.out} (default language: ${result.default_language ?? "unknown"}).`);
      } else {
        process.stdout.write(file);
      }
    });

  group
    .command("push <appIdOrSlug>")
    .description("Write listing text and/or images in one Play edit. Dry run by default (edits.validate, then the edit is deleted); --commit publishes.")
    .option("--listing <file>", "listing.json: { \"<play-language>\": { title, shortDescription, fullDescription, video } }")
    .option("--images <dir>", "Images: <dir>/<language>/<imageType>/NN.png or <dir>/<device>/<language>/NN.png (phone, tablet-7, tablet-10, feature-graphic, icon, tv, wear, tv-banner); default/ applies to every language.")
    .option("--ai-generated-state <state>", `edits.images.upload aiGeneratedState for every image (${PLAY_AI_GENERATED_STATES.join(", ")}).`)
    .option("--dry-run", "Validate only (the default).", false)
    .option("--commit", "Commit the edit (edits.commit, ERROR_IF_IN_REVIEW).", false)
    .option("--locales <list>", "Only push these languages from the file, comma-separated (e.g. en-US,ja-JP).")
    .option("--delete-unlisted-languages", "Also delete Play languages that are not in the file (never the default language).", false)
    .option("--changes-not-sent-for-review", "Commit with changesNotSentForReview=true; then send the change for review in Play Console.", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: {
      listing?: string; images?: string; aiGeneratedState?: string; dryRun?: boolean; commit?: boolean; locales?: string;
      deleteUnlistedLanguages?: boolean; changesNotSentForReview?: boolean; json?: boolean;
    }) => {
      if (!opts.listing && !opts.images) throw new Error("pass --listing, --images, or both");
      if (opts.aiGeneratedState && !(PLAY_AI_GENERATED_STATES as readonly string[]).includes(opts.aiGeneratedState)) {
        throw new Error(`--ai-generated-state must be one of ${PLAY_AI_GENERATED_STATES.join(", ")}`);
      }
      if (opts.commit && opts.dryRun) throw new Error("--commit and --dry-run are mutually exclusive");
      if (opts.locales && opts.deleteUnlistedLanguages) {
        throw new Error("--delete-unlisted-languages with --locales would delete every other language; push the full file instead");
      }
      if (opts.changesNotSentForReview && !opts.commit) {
        throw new Error("--changes-not-sent-for-review only applies with --commit");
      }
      let listings: PlayListing[] = [];
      let fileLanguages: string[] = [];
      if (opts.listing) {
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(opts.listing, "utf8"));
        } catch (error) {
          throw new Error(`cannot read ${opts.listing}: ${(error as Error).message}`);
        }
        const all = parseListingFile(raw);
        fileLanguages = all.map((listing) => listing.language);
        listings = selectLocales(all, opts.locales);
      }
      const locales = opts.locales?.split(",").map((value) => value.trim()).filter(Boolean);
      let imagePush: Awaited<ReturnType<typeof buildImagePush>> | null = null;
      if (opts.images) {
        if (!(await stat(opts.images).catch(() => null))?.isDirectory()) throw new Error(`${opts.images} is not a directory`);
        const sets = await collectImageSets(opts.images, { languages: locales ?? fileLanguages, ...(locales ? { locales } : {}) });
        if (sets.length === 0) throw new Error(`${opts.images} has no images for the selected languages`);
        imagePush = await buildImagePush(sets, opts.aiGeneratedState);
      }
      const request = {
        mode: opts.commit ? "commit" : "dry_run",
        listings,
        ...(opts.deleteUnlistedLanguages ? { delete_unlisted_languages: true } : {}),
        ...(opts.changesNotSentForReview ? { changes_not_sent_for_review: true } : {}),
        ...(imagePush ? { images: imagePush.declared } : {}),
      };
      const appId = await resolveAppId(appIdOrSlug);
      const path = `/api/apps/${appId}/distributions/play/store-listing`;
      const result = imagePush
        ? await postMultipart<StoreListingPushResponse>(path, request, imagePush.parts)
        : await call<StoreListingPushResponse>(path, { method: "POST", body: request });
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatPlan(result));
    });

  group
    .command("receipts <appIdOrSlug>")
    .description("List store listing push receipts (newest first).")
    .option("--limit <n>", "Max receipts (1-100).", "20")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { limit: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await call<{ receipts: Array<{ id: string; mode: string; verdict: string; play_edit_id: string | null; languages: string[]; created_by: string; created_at: number }> }>(
        `/api/apps/${appId}/distributions/play/store-listing/receipts`, { query: { limit: opts.limit } },
      );
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.receipts.length === 0) {
        console.log("No store listing receipts.");
        return;
      }
      for (const receipt of result.receipts) {
        console.log([new Date(receipt.created_at).toISOString(), receipt.mode, receipt.verdict, receipt.play_edit_id ?? "-", (receipt.languages ?? []).join(",") || "-", receipt.created_by, receipt.id].join("\t"));
      }
    });
}
