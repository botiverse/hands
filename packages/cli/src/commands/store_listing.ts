import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { apiRequest, QuiverApiError } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

/** androidpublisher v3 `Listing` fields, verbatim. */
export const LISTING_FIELDS = ["title", "shortDescription", "fullDescription", "video"] as const;
type ListingField = typeof LISTING_FIELDS[number];
export type PlayListing = { language: string } & Partial<Record<ListingField, string>>;

type AppRow = { id: string; slug: string };

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
    .description("Write listing text in one Play edit. Dry run by default (edits.validate, then the edit is deleted); --commit publishes.")
    .requiredOption("--listing <file>", "listing.json: { \"<play-language>\": { title, shortDescription, fullDescription, video } }")
    .option("--dry-run", "Validate only (the default).", false)
    .option("--commit", "Commit the edit (edits.commit, ERROR_IF_IN_REVIEW).", false)
    .option("--locales <list>", "Only push these languages from the file, comma-separated (e.g. en-US,ja-JP).")
    .option("--delete-unlisted-languages", "Also delete Play languages that are not in the file (never the default language).", false)
    .option("--changes-not-sent-for-review", "Commit with changesNotSentForReview=true; then send the change for review in Play Console.", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: {
      listing: string; dryRun?: boolean; commit?: boolean; locales?: string;
      deleteUnlistedLanguages?: boolean; changesNotSentForReview?: boolean; json?: boolean;
    }) => {
      if (opts.commit && opts.dryRun) throw new Error("--commit and --dry-run are mutually exclusive");
      if (opts.locales && opts.deleteUnlistedLanguages) {
        throw new Error("--delete-unlisted-languages with --locales would delete every other language; push the full file instead");
      }
      if (opts.changesNotSentForReview && !opts.commit) {
        throw new Error("--changes-not-sent-for-review only applies with --commit");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(opts.listing, "utf8"));
      } catch (error) {
        throw new Error(`cannot read ${opts.listing}: ${(error as Error).message}`);
      }
      const listings = selectLocales(parseListingFile(raw), opts.locales);
      const appId = await resolveAppId(appIdOrSlug);
      const result = await call<StoreListingPushResponse>(`/api/apps/${appId}/distributions/play/store-listing`, {
        method: "POST",
        body: {
          mode: opts.commit ? "commit" : "dry_run",
          listings,
          ...(opts.deleteUnlistedLanguages ? { delete_unlisted_languages: true } : {}),
          ...(opts.changesNotSentForReview ? { changes_not_sent_for_review: true } : {}),
        },
      });
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
