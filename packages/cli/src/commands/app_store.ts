import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Command } from "commander";
import { agentAwareFetch, apiRequest, getApiBase, QuiverApiError } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

/**
 * `hands app-store` -- App Store release through Hands (which holds the App Store
 * Connect key). Every command that changes something at Apple is a dry run unless
 * --commit is passed: prepare, release and the metadata pushes print Hands' plan,
 * submit and withdraw print what they would act on.
 */

type AppRow = { id: string; slug: string };

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
/** Must match the server's per-push bound. */
export const MAX_SCREENSHOT_PUSH_BYTES = 24 * 1024 * 1024;

async function resolveAppId(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input)) return input;
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const app = apps.find((item) => item.slug === input);
  if (!app) throw new Error(`App not found: ${input}`);
  return app.id;
}

interface StatusResponse {
  version_id: string;
  version_string: string | null;
  state: string | null;
  build_attached: boolean;
  pending_submission: { id: string; state: string | null } | null;
}

/** Pending-submission text; a rejected one needs a fix and a resubmit, not waiting. */
export function describePendingSubmission(pending: StatusResponse["pending_submission"]): string {
  if (!pending) return "none";
  if (pending.state === "UNRESOLVED_ISSUES") return `${pending.id} (UNRESOLVED_ISSUES — Apple rejected; fix then submit again)`;
  return `${pending.id} (${pending.state})`;
}

async function status(appId: string, versionString: string, platform?: string): Promise<StatusResponse> {
  return apiRequest<StatusResponse>(`/api/apps/${appId}/app-store/status`, {
    query: { version_string: versionString, ...(platform ? { platform } : {}) },
  });
}

/** --version-id wins; otherwise --version-name is resolved through the status endpoint. */
async function resolveVersionId(appId: string, opts: { versionName?: string; versionId?: string; platform?: string }): Promise<string> {
  if (opts.versionId && opts.versionName) throw new Error("pass --version-name or --version-id, not both");
  if (opts.versionId) return opts.versionId;
  if (!opts.versionName) throw new Error("pass --version-name <marketing version> or --version-id <ASC version id>");
  return (await status(appId, opts.versionName, opts.platform)).version_id;
}

export interface ScreenshotSetPlan {
  locale: string;
  display_type: string;
  files: string[];
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
}

/**
 * Read `<dir>/<locale>/<display_type>/NN-name.png`. Locale and display type are
 * passed through as written (en-US, APP_IPHONE_67); the server validates both.
 * Files are ordered by name, numeric-aware, which is the App Store display order.
 */
export async function collectScreenshotSets(dir: string, locales?: string[]): Promise<ScreenshotSetPlan[]> {
  const sets: ScreenshotSetPlan[] = [];
  for (const locale of await subdirs(dir)) {
    if (locales && !locales.includes(locale)) continue;
    for (const displayType of await subdirs(join(dir, locale))) {
      const folder = join(dir, locale, displayType);
      const entries = await readdir(folder, { withFileTypes: true });
      const names = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
      for (const name of names) {
        if (!IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) throw new Error(`${join(folder, name)}: only .png, .jpg and .jpeg are uploaded`);
      }
      const files = names.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).map((name) => join(folder, name));
      if (files.length > 0) sets.push({ locale, display_type: displayType, files });
    }
  }
  if (locales) {
    const missing = locales.filter((l) => !sets.some((s) => s.locale === l));
    if (missing.length) throw new Error(`--locales names locales with no screenshots in ${dir}: ${missing.join(", ")}`);
  }
  return sets;
}

async function buildScreenshotRequest(sets: ScreenshotSetPlan[], mode: "dry_run" | "commit") {
  const parts: Array<{ name: string; path: string; bytes: Buffer }> = [];
  let total = 0;
  const declared = [];
  for (const set of sets) {
    const images = [];
    for (const path of set.files) {
      const bytes = await readFile(path);
      const name = `img${parts.length + 1}`;
      parts.push({ name, path, bytes });
      total += bytes.byteLength;
      images.push({ part: name, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    declared.push({ locale: set.locale, display_type: set.display_type, images });
  }
  if (total > MAX_SCREENSHOT_PUSH_BYTES) {
    throw new Error(`screenshots total ${total} bytes; Hands accepts ${MAX_SCREENSHOT_PUSH_BYTES} per push. Push fewer locales at a time with --locales.`);
  }
  return { request: { mode, sets: declared }, parts };
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
    const message = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText}`;
    throw new QuiverApiError(res.status, data, message);
  }
  return data as T;
}

/**
 * A refused or failed push still carries the plan / per-item detail. Print it (or
 * the whole body under --json) before the top-level handler prints the error.
 */
async function withDetail<T>(json: boolean, format: (body: any) => string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof QuiverApiError && error.body && typeof error.body === "object") {
      const body = error.body as Record<string, unknown>;
      if (json) console.log(JSON.stringify(body, null, 2));
      else if (body.sets || body.localizations || body.results || body.versions) console.error(format(body));
    }
    throw error;
  }
}

export function formatScreenshotResult(body: any): string {
  const lines: string[] = [];
  const v = body.version;
  if (v) lines.push(`Version ${v.version_string} (${v.id}, ${v.state})`);
  for (const set of body.sets ?? []) {
    const head = `  ${set.locale} ${set.display_type}: ${set.blocker ? `BLOCKED (${set.blocker})` : set.action}${set.status ? ` -> ${set.status}` : ""}`;
    lines.push(head);
    if (set.existing && set.desired && !set.status) lines.push(`      ${set.existing.length} on Apple -> ${set.desired.length} requested`);
    for (const image of set.images ?? []) {
      lines.push(`      #${image.index + 1} ${image.screenshot_id ?? "-"} ${image.state}${image.error ? ` (${image.error})` : ""}${image.errors?.length ? ` ${image.errors.map((e: any) => e.code).join(",")}` : ""}`);
    }
  }
  // Failed and pending sets are listed apart: pending is not a rejection, but not done either.
  // What to do next comes from the server's next_action (printed with the error code).
  if (body.failed_sets?.length) lines.push(`Failed: ${body.failed_sets.join(", ")}`);
  if (body.pending_sets?.length) lines.push(`Uploaded, still processing at Apple: ${body.pending_sets.join(", ")}`);
  if (body.outcome === "planned") lines.push("Dry run: nothing was written. Run again with --commit to apply.");
  else if (body.outcome === "no_changes") lines.push("No changes: Apple already has these screenshots in this order.");
  else if (body.outcome === "committed") lines.push("Committed and read back from Apple.");
  return lines.join("\n");
}

/**
 * Worker answers 202 SCREENSHOTS_PENDING (ok: false) when Apple accepted the uploads but
 * is still processing them. That is not success: turn it into an error so the command
 * exits non-zero with its own code (SCREENSHOTS_FAILED, a 502, already throws).
 */
export function assertScreenshotsConfirmed<T>(body: T): T {
  const b = body as { ok?: unknown; error?: unknown; code?: unknown } | null;
  if (b && typeof b === "object" && b.ok === false) {
    throw new QuiverApiError(202, body, String(b.error ?? b.code ?? "screenshot push not confirmed"));
  }
  return body;
}

function preview(value: string | null | undefined): string {
  if (value === undefined) return "(not sent)";
  if (value === null) return "(unset)";
  const flat = value.replace(/\s+/g, " ");
  const chars = [...flat];
  return JSON.stringify(chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : flat) + ` [${[...value].length}]`;
}

export function formatLocalizationResult(body: any): string {
  const lines: string[] = [];
  const v = body.version;
  if (v) lines.push(`Version ${v.version_string} (${v.id}, ${v.state})`);
  for (const plan of body.localizations ?? []) {
    const missing = plan.blocker === "missing_required_fields" && plan.missing_fields?.length ? `: ${plan.missing_fields.join(", ")}` : "";
    lines.push(`  ${plan.blocker ? `BLOCKED (${plan.blocker}${missing})` : plan.action.padEnd(9)} ${plan.locale}`);
    for (const field of plan.changed_fields ?? []) {
      lines.push(`      ${field}: ${preview(plan.before?.[field])} -> ${preview(plan.after?.[field])}`);
    }
  }
  for (const result of body.results ?? []) {
    if (!body.localizations) lines.push(`  ${result.status.padEnd(13)} ${result.locale}`);
  }
  for (const mismatch of body.mismatches ?? []) lines.push(`  read-back mismatch: ${mismatch.locale} ${mismatch.field}`);
  if (body.outcome === "planned") lines.push("Dry run: nothing was written. Run again with --commit to apply.");
  else if (body.outcome === "committed") lines.push("Committed and read back from Apple.");
  else if (body.outcome === "no_changes") lines.push("No changes.");
  return lines.join("\n");
}

/**
 * localizations file: { "<locale>": { description, keywords, promotionalText,
 * marketingUrl, supportUrl, whatsNew } }. Passed through; the server validates.
 */
export function parseLocalizationsFile(raw: unknown): Record<string, Record<string, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("localizations file must be a JSON object keyed by locale");
  for (const [locale, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${locale}: expected an object of fields`);
  }
  return raw as Record<string, Record<string, string>>;
}

export function registerAppStoreCommands(program: Command): void {
  const group = program.command("app-store").description("App Store release through Hands: prepare, listing text, screenshots, submit, withdraw, release, status. Writes need --commit.");

  group
    .command("status <appIdOrSlug>")
    .description("Review state of one version: state, build attached, pending submission. Read-only.")
    .requiredOption("--version-name <version>", "Marketing version, e.g. 1.17.0.")
    .option("--platform <platform>", "IOS (default) or MAC_OS.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { versionName: string; platform?: string; json?: boolean }) => {
      const result = await status(await resolveAppId(appIdOrSlug), opts.versionName, opts.platform);
      if (jsonRequested(program, opts.json)) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`${result.version_string} ${result.version_id}: ${result.state}; build ${result.build_attached ? "attached" : "not attached"}; pending submission: ${describePendingSubmission(result.pending_submission)}`);
    });

  group
    .command("prepare <appIdOrSlug>")
    .description("Create, reuse, or rename the App Store version and attach a build. Dry run by default; --commit writes.")
    .requiredOption("--version-name <version>", "Marketing version, e.g. 1.17.0.")
    .option("--build <ascBuildId>", "App Store Connect build id to attach.")
    .option("--platform <platform>", "IOS (default) or MAC_OS.")
    .option("--release-type <type>", "MANUAL | AFTER_APPROVAL. Applied to a created, reused or renamed version; omitted keeps Apple's value (MANUAL on create).")
    .option("--commit", "Apply the plan.", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { versionName: string; build?: string; platform?: string; releaseType?: string; commit?: boolean; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const json = jsonRequested(program, opts.json);
      const result = await withDetail(json, (b) => JSON.stringify(b.versions ?? b, null, 2), () =>
        apiRequest<any>(`/api/apps/${appId}/app-store/versions`, {
          method: "POST",
          body: {
            version_string: opts.versionName,
            mode: opts.commit ? "commit" : "dry_run",
            ...(opts.build ? { asc_build_id: opts.build } : {}),
            ...(opts.platform ? { platform: opts.platform } : {}),
            ...(opts.releaseType ? { release_type: opts.releaseType } : {}),
          },
        }));
      if (json) { console.log(JSON.stringify(result, null, 2)); return; }
      const what = result.action === "renamed"
        ? `rename ${result.previous_version_string} (${result.version_id}, ${result.state}) to ${result.version_string}`
        : result.action === "reused" ? `reuse ${result.version_string} (${result.version_id}, ${result.state})` : `create ${result.version_string}`;
      const rt = result.changes?.release_type;
      if (result.mode === "dry_run") {
        console.log(`Dry run: would ${what}${opts.build ? ` and attach build ${opts.build}` : ""}${rt ? `; release type ${rt.from ?? "(new)"} -> ${rt.to}` : ""}. Nothing was written. Run again with --commit to apply.`);
      } else {
        console.log(`Done: ${result.action} ${result.version_string} (${result.version_id}, ${result.state}); build ${result.build_attached === null ? "unknown" : result.build_attached ? result.build_id : "not attached"}; release type ${result.release_type}. Read back from Apple.`);
      }
    });

  const screenshots = group.command("screenshots").description("App Store screenshot sets.");
  screenshots
    .command("push <appIdOrSlug>")
    .description("Replace screenshot sets from <dir>/<locale>/<display_type>/NN.png. Identical sets are skipped. Dry run by default; --commit writes (deletes and re-uploads changed sets).")
    .requiredOption("--dir <dir>", "Screenshots directory, e.g. shots/en-US/APP_IPHONE_67/01.png.")
    .option("--version-name <version>", "Marketing version (resolved to its ASC id).")
    .option("--version-id <id>", "ASC appStoreVersions id.")
    .option("--platform <platform>", "Platform for --version-name lookup.")
    .option("--locales <list>", "Only these locales, comma-separated.")
    .option("--commit", "Apply the plan.", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { dir: string; versionName?: string; versionId?: string; platform?: string; locales?: string; commit?: boolean; json?: boolean }) => {
      if (!(await stat(opts.dir).catch(() => null))?.isDirectory()) throw new Error(`${opts.dir} is not a directory`);
      const locales = opts.locales?.split(",").map((l) => l.trim()).filter(Boolean);
      const sets = await collectScreenshotSets(opts.dir, locales);
      if (sets.length === 0) throw new Error(`${opts.dir} has no <locale>/<display_type>/ image folders`);
      const appId = await resolveAppId(appIdOrSlug);
      const versionId = await resolveVersionId(appId, opts);
      const { request, parts } = await buildScreenshotRequest(sets, opts.commit ? "commit" : "dry_run");
      const json = jsonRequested(program, opts.json);
      const result = await withDetail(json, formatScreenshotResult, async () => assertScreenshotsConfirmed(
        await postMultipart<any>(`/api/apps/${appId}/app-store/versions/${encodeURIComponent(versionId)}/screenshots`, request, parts)));
      console.log(json ? JSON.stringify(result, null, 2) : formatScreenshotResult(result));
    });

  const localizations = group.command("localizations").description("App Store listing text (appStoreVersionLocalizations).");
  localizations
    .command("push <appIdOrSlug>")
    .description("Write listing text from a JSON file keyed by locale. Dry run by default; --commit writes.")
    .requiredOption("--file <json>", '{"en-US":{"description":"...","keywords":"...","promotionalText":"...","whatsNew":"...","supportUrl":"...","marketingUrl":"..."}}')
    .option("--version-name <version>", "Marketing version (resolved to its ASC id).")
    .option("--version-id <id>", "ASC appStoreVersions id.")
    .option("--platform <platform>", "Platform for --version-name lookup.")
    .option("--commit", "Apply the plan.", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { file: string; versionName?: string; versionId?: string; platform?: string; commit?: boolean; json?: boolean }) => {
      let raw: unknown;
      try { raw = JSON.parse(await readFile(opts.file, "utf8")); } catch (error) { throw new Error(`cannot read ${opts.file}: ${(error as Error).message}`); }
      const body = { mode: opts.commit ? "commit" : "dry_run", localizations: parseLocalizationsFile(raw) };
      const appId = await resolveAppId(appIdOrSlug);
      const versionId = await resolveVersionId(appId, opts);
      const json = jsonRequested(program, opts.json);
      const result = await withDetail(json, formatLocalizationResult, () =>
        apiRequest<any>(`/api/apps/${appId}/app-store/versions/${encodeURIComponent(versionId)}/localizations`, { method: "POST", body }));
      console.log(json ? JSON.stringify(result, null, 2) : formatLocalizationResult(result));
    });

  group
    .command("submit <appIdOrSlug>")
    .description("Submit a prepared version for App Store review. Without --commit, only shows what would be submitted.")
    .requiredOption("--version-name <version>", "Marketing version to submit.")
    .option("--platform <platform>", "IOS (default) or MAC_OS.")
    .option("--commit", "Really submit for review.", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { versionName: string; platform?: string; commit?: boolean; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const current = await status(appId, opts.versionName, opts.platform);
      const json = jsonRequested(program, opts.json);
      if (!opts.commit) {
        if (json) { console.log(JSON.stringify({ mode: "dry_run", would_submit: current }, null, 2)); return; }
        console.log(`Dry run: would submit ${current.version_string} (${current.version_id}, ${current.state}; build ${current.build_attached ? "attached" : "NOT attached"}). Pending submission: ${describePendingSubmission(current.pending_submission)}.`);
        console.log("Run again with --commit to submit for review.");
        return;
      }
      const result = await apiRequest<any>(`/api/apps/${appId}/app-store/versions/${encodeURIComponent(current.version_id)}/submit`, { method: "POST" });
      console.log(json ? JSON.stringify(result, null, 2) : result.resubmitted
        ? `Resubmitted ${current.version_string} (${current.version_id}) in its rejected review submission ${result.submission_id}.`
        : `Submitted ${current.version_string} (${current.version_id}); review submission ${result.submission_id}.`);
    });

  group
    .command("release <appIdOrSlug> <versionId>")
    .description("Release an approved version (PENDING_DEVELOPER_RELEASE) to the App Store. IRREVERSIBLE. Dry run by default; --commit releases. --version (and --build) must match what Apple holds.")
    .requiredOption("--version-name <version>", "Exact marketing version the version must have, e.g. 1.17.0.")
    .option("--build <ascBuildId>", "Exact App Store Connect build id that must be attached.")
    .option("--commit", "Really release (cannot be undone).", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, versionId: string, opts: { versionName: string; build?: string; commit?: boolean; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const json = jsonRequested(program, opts.json);
      const result = await withDetail(json, (b) => JSON.stringify(b, null, 2), () =>
        apiRequest<any>(`/api/apps/${appId}/app-store/versions/${encodeURIComponent(versionId)}/release`, {
          method: "POST",
          body: {
            mode: opts.commit ? "commit" : "dry_run",
            version_string: opts.versionName,
            ...(opts.build ? { asc_build_id: opts.build } : {}),
          },
        }));
      if (json) { console.log(JSON.stringify(result, null, 2)); return; }
      if (result.outcome === "planned") {
        const v = result.version ?? {};
        console.log(`Dry run: would release ${v.version_string} (${v.version_id}, ${v.state}; build ${v.build_id ?? "unknown"}). Nothing was sent.`);
        console.log("Run again with --commit to release. This cannot be undone.");
      } else if (result.outcome === "released") {
        console.log(`Released ${result.version_string} (${result.version_id}): Apple shows ${result.observed_state}.`);
      } else {
        console.log(`Release requested for ${result.version_string ?? result.version?.version_string} (${result.version_id ?? result.version?.version_id}); Apple shows ${result.observed_state ?? "unknown"} and releases asynchronously.${result.prior_operation_id ? ` Already requested earlier (operation ${result.prior_operation_id}); nothing new was sent.` : ""}`);
        console.log("Check with `hands app-store status` until READY_FOR_SALE. Do not release again.");
      }
    });

  group
    .command("withdraw <appIdOrSlug>")
    .description("Withdraw the pending review of a version (cancels its review submission). Without --commit, only shows what would be withdrawn.")
    .requiredOption("--version-name <version>", "Marketing version whose review to withdraw.")
    .option("--platform <platform>", "IOS (default) or MAC_OS.")
    .option("--commit", "Really withdraw.", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { versionName: string; platform?: string; commit?: boolean; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const current = await status(appId, opts.versionName, opts.platform);
      const json = jsonRequested(program, opts.json);
      if (!opts.commit) {
        if (json) { console.log(JSON.stringify({ mode: "dry_run", would_withdraw: current }, null, 2)); return; }
        console.log(`Dry run: would withdraw the pending review of ${current.version_string} (${current.version_id}, ${current.state}).`);
        console.log("Run again with --commit to withdraw.");
        return;
      }
      const result = await apiRequest<any>(`/api/apps/${appId}/app-store/withdraw`, { method: "POST", body: { version_id: current.version_id } });
      console.log(json ? JSON.stringify(result, null, 2) : `Withdrew review submission ${result.submission_id} for ${current.version_string}.`);
    });
}
