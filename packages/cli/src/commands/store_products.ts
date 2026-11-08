import { readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Command } from "commander";
import { apiRequest, QuiverApiError } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

type Obj = Record<string, unknown>;
type Request = { store: "apple" | "google"; product: Obj; regionsVersion?: string; screenshot?: { fileName: string; base64: string } };
type ProductResult = { code?: string; message?: string; recovery_required?: boolean; outcome_uncertain?: boolean; operation_id?: string | null; product_id: string; mode: string; outcome: string; changes?: Array<{resource: string; action: string; before?: unknown; after?: unknown}>; completed?: string[]; error?: unknown };
const object = (x: unknown, name: string): Obj => {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error(`${name} must be an object`);
  return x as Obj;
};

/** Parse the entire file and load all images before the first provider request. */
export async function buildProductRequests(raw: unknown, platform: string, directory: string): Promise<Request[]> {
  const input = object(raw, "file");
  if (Object.keys(input).some(x => !["apple", "google"].includes(x))) throw new Error("file has unsupported top-level fields");
  const store = platform === "ios" ? "apple" : platform === "android" ? "google" : null;
  if (!store) throw new Error("store-products supports iOS and Android apps");
  const config = object(input[store], store);
  const allowed = store === "apple" ? ["group", "products"] : ["regionsVersion", "products"];
  if (Object.keys(config).some(x => !allowed.includes(x))) throw new Error(`${store} has unsupported fields`);
  if (!Array.isArray(config.products) || !config.products.length || config.products.length > 100) throw new Error(`${store}.products must contain 1 to 100 entries`);
  const group = store === "apple" ? object(config.group, "apple.group") : undefined;
  if (store === "google" && config.regionsVersion !== undefined && (typeof config.regionsVersion !== "string" || !/^\d{4}\/\d{2}$/.test(config.regionsVersion))) throw new Error("google.regionsVersion must be YYYY/MM");
  const seen = new Set<string>(); const out: Request[] = []; let imageBytes = 0;
  for (const item of config.products) {
    const row = object(item, "product");
    if (typeof row.productId !== "string" || !row.productId || seen.has(row.productId)) throw new Error("every product needs a unique productId");
    seen.add(row.productId);
    if (store === "google") {
      out.push({ store, product: row, ...(typeof config.regionsVersion === "string" ? { regionsVersion: config.regionsVersion } : {}) });
      continue;
    }
    const { reviewScreenshot, ...data } = row;
    if ("group" in data) throw new Error("use apple.group once, not inside a product");
    let image: Request["screenshot"];
    if (reviewScreenshot !== undefined) {
      if (typeof reviewScreenshot !== "string" || !reviewScreenshot) throw new Error("reviewScreenshot must be a file path");
      const path = resolve(directory, reviewScreenshot);
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > 5 * 1024 * 1024) throw new Error(`${path} must be an image of at most 5 MiB`);
      imageBytes += info.size;
      if (imageBytes > 32 * 1024 * 1024) throw new Error("review screenshots exceed 32 MiB in total; split the file into smaller batches");
      image = { fileName: basename(path), base64: (await readFile(path)).toString("base64") };
    }
    const rawPrices = data.prices;
    if (rawPrices !== undefined && !Array.isArray(rawPrices)) throw new Error(`prices for ${row.productId} must be an array`);
    const prices = rawPrices as unknown[] | undefined;
    const territories = new Set<string>();
    for (const value of prices ?? []) {
      const entry = object(value, "price");
      if (typeof entry.territory !== "string" || territories.has(entry.territory)) throw new Error(`prices for ${row.productId} need unique territory codes`);
      territories.add(entry.territory);
    }
    const chunks = prices && prices.length > 5 ? Array.from({ length: Math.ceil(prices.length / 5) }, (_, i) => prices.slice(i * 5, (i + 1) * 5)) : [prices];
    for (let i = 0; i < chunks.length; i++) out.push({ store, product: { ...data, group, ...(chunks[i] ? { prices: chunks[i] } : {}) }, ...(i === 0 && image ? { screenshot: image } : {}) });
  }
  return out;
}

async function applyRequests(appId: string, requests: Request[], mode: "dry_run" | "commit") {
  const results: Array<ProductResult | Obj> = [];
  for (const item of requests) {
    try {
      const result = await apiRequest<ProductResult>(`/api/apps/${encodeURIComponent(appId)}/store-products`, { method: "POST", body: { ...item, mode }, retryOnUnauthorized: mode !== "commit" });
      results.push(result);
      if (result.outcome === "failed") return { results, stopped: true };
    } catch (error) {
      const info = error instanceof QuiverApiError && error.body && typeof error.body === "object" ? error.body as Obj : { code: "request_failed", message: "Hands request failed; inspect current state before retrying" };
      // An intermediary's 401 cannot establish whether a commit reached the
      // provider. Keep this warning in JSON output as well as text output.
      const uncertain401 = mode === "commit" && error instanceof QuiverApiError && error.status === 401
        ? { outcome_uncertain: true, message: "Commit outcome may be unknown; inspect the provider before retrying" }
        : {};
      results.push({ ...info, ...uncertain401, product_id: item.product.productId, outcome: "failed" });
      return { results, stopped: true };
    }
  }
  return { results, stopped: false };
}

export function registerStoreProductsCommands(program: Command) {
  program.command("store-products").description("Manage Apple and Google subscription products through Hands.")
    .command("apply <app>")
    .description("Preview a product file, or apply it with --commit. Prices and activations can affect customers.")
    .requiredOption("--file <path>", "Product configuration JSON")
    .option("--dry-run", "Read the store and preview changes (default).", false)
    .option("--commit", "Apply the previewed changes to the store.", false)
    .option("--json", "Output JSON.", false)
    .action(async (app: string, opts: { file: string; dryRun?: boolean; commit?: boolean; json?: boolean }) => {
      if (opts.dryRun && opts.commit) throw new Error("--dry-run and --commit are mutually exclusive");
      const path = resolve(opts.file); let raw: unknown;
      try {
        if ((await stat(path)).size > 1024 * 1024) throw new Error("too large");
        raw = JSON.parse(await readFile(path, "utf8"));
      } catch { throw new Error(`cannot read valid JSON (at most 1 MiB) from ${path}`); }
      const { apps } = await apiRequest<{apps: Array<{id: string; slug: string; platform: string}>}>("/api/apps");
      const matches = apps.filter(a => a.id === app || a.slug === app);
      if (matches.length !== 1) throw new Error(`app not found or ambiguous: ${app}`);
      const selected = matches[0]!; const requests = await buildProductRequests(raw, selected.platform, dirname(path));
      const preview = await applyRequests(selected.id, requests, "dry_run");
      const previewPending = preview.results.some(r => r.outcome === "pending");
      const applied = opts.commit && !preview.stopped && !previewPending ? await applyRequests(selected.id, requests, "commit") : null;
      const pending = previewPending || (applied?.results.some(r => r.outcome === "pending") ?? false);
      const stopped = preview.stopped || (!!opts.commit && previewPending) || (applied?.stopped ?? false);
      const output = { app: selected.slug, mode: opts.commit ? "commit" : "dry_run", preview: preview.results, ...(applied ? { results: applied.results } : {}), stopped, pending };
      if (jsonRequested(program, opts.json)) console.log(JSON.stringify(output, null, 2));
      else {
        for (const [label, result] of [["Preview", preview], ...(applied ? [["Apply", applied] as const] : [])] as const) {
          console.log(`${label}:`);
          for (const row of result.results) {
            console.log(`  ${row.product_id}: ${row.outcome}`);
            if (Array.isArray(row.changes)) for (const change of row.changes) console.log(`    ${change.resource}: ${change.action} ${JSON.stringify(change.before ?? null)} -> ${JSON.stringify(change.after ?? null)}`);
            if (row.error) console.log(`    error: ${JSON.stringify(row.error)}`);
            if (row.code) console.log(`    ${row.code}: ${row.message ?? "request failed"}`);
            else if (row.outcome_uncertain && row.message) console.log(`    ${row.message}`);
            if (Array.isArray(row.completed) && row.completed.length) console.log(`    completed: ${row.completed.join(", ")}`);
            if (row.recovery_required) console.log("    recovery required before another commit");
            if (row.operation_id) console.log(`    operation: ${row.operation_id}`);
          }
        }
        if (!opts.commit && !previewPending) console.log("Preview only. Pass --commit to apply after reviewing the changes.");
        if (previewPending) console.log("Preview is incomplete; check pending results before applying changes.");
        else if (pending) console.log("At least one screenshot is processing or a base plan is awaiting prices; check the results and re-run.");
        if (stopped) console.log("Stopped; inspect completed steps and provider state before retrying.");
      }
      if (stopped || pending) process.exitCode = 1;
    });
}
