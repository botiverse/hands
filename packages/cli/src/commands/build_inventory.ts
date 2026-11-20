/**
 * `hands builds inventory` and `hands builds diff` — what a build's APK or
 * IPA contains, and what changed since another build.
 *
 * Wires GET/POST /api/apps/:appId/builds/:buildId/inventory and
 * GET /api/apps/:appId/builds/:buildId/inventory/diff.
 */

import type { Command } from "commander";
import { apiRequest, QuiverApiError } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

interface Category { key: string; label: string; bytes: number; compressed_bytes: number; files: number }
interface Library {
  name: string; kind: string; bytes: number; compressed_bytes?: number; version?: string | null; sdk?: string | null;
  classes?: number; estimated?: boolean; abis?: string[];
}
interface Sdk { name: string; bytes: number; compressed_bytes: number; kinds: string[] }
interface FileRow { path: string; bytes: number; compressed_bytes: number; category: string }

export interface Inventory {
  schema: 1;
  platform: "android" | "ios";
  total_bytes: number;
  uncompressed_bytes: number;
  file_count: number;
  app: Record<string, string | number | null>;
  categories: Category[];
  largest_files: FileRow[];
  components: Record<string, string[]>;
  libraries: Library[];
  sdks: Sdk[];
  notes: string[];
}

interface BuildRef { build_id: string; version_name: string; version_code: number }

export interface InventoryResponse { build: BuildRef; computed_at: number; inventory: Inventory }

export interface DiffResponse {
  base: BuildRef;
  head: BuildRef;
  diff: {
    total: { before: number; after: number; delta: number };
    categories: Array<{ key: string; label: string; compressed_before: number; compressed_after: number; compressed_delta: number }>;
    components: Record<string, { added: string[]; removed: string[] }>;
    libraries: {
      added: Library[];
      removed: Library[];
      changed: Array<{ name: string; kind: string; delta: number; compressed_delta: number; version_before: string | null; version_after: string | null }>;
    };
    sdks: { added: Sdk[]; removed: Sdk[]; changed: Array<{ name: string; before: number; after: number; delta: number }> };
    files: { grown: Array<{ path: string; delta: number }>; added: Array<{ path: string; delta: number }> };
    notes: string[];
  };
}

export function formatBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = abs / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${n < 0 ? "-" : ""}${v.toFixed(1)} ${units[i]}`;
}

export function formatDelta(n: number): string {
  return n === 0 ? "±0" : `${n > 0 ? "+" : "-"}${formatBytes(Math.abs(n))}`;
}

const pad = (s: string, w: number) => (s.length >= w ? s : s + " ".repeat(w - s.length));

export function renderInventory(res: InventoryResponse, opts: { libraries?: number } = {}): string {
  const inv = res.inventory;
  const lines: string[] = [];
  lines.push(`${res.build.version_name} (${res.build.version_code})  ${inv.platform}  ${formatBytes(inv.total_bytes)} package, ${formatBytes(inv.uncompressed_bytes)} uncompressed, ${inv.file_count} files`);
  lines.push("");
  lines.push("Size by category (in the package):");
  const total = inv.categories.reduce((s, c) => s + c.compressed_bytes, 0) || 1;
  for (const c of inv.categories) {
    const pct = Math.round((c.compressed_bytes / total) * 100);
    lines.push(`  ${pad(c.label, 38)} ${pad(formatBytes(c.compressed_bytes), 10)} ${String(pct).padStart(3)}%`);
  }
  if (inv.sdks.length) {
    lines.push("");
    lines.push("Known SDKs:");
    for (const s of inv.sdks) lines.push(`  ${pad(s.name, 30)} ${formatBytes(s.compressed_bytes)}  (${s.kinds.join(", ")})`);
  }
  const libs = [...inv.libraries].sort((a, b) => (b.compressed_bytes ?? b.bytes) - (a.compressed_bytes ?? a.bytes));
  const limit = opts.libraries ?? 20;
  if (libs.length) {
    lines.push("");
    lines.push(`Libraries (${libs.length}${libs.length > limit ? `, largest ${limit}` : ""}):`);
    for (const l of libs.slice(0, limit)) {
      const extra = [l.version ? `v${l.version}` : null, l.abis?.join(","), l.sdk].filter(Boolean).join("  ");
      lines.push(`  ${pad(l.name, 40)} ${pad(l.kind, 12)} ${pad(`${l.estimated ? "~" : ""}${formatBytes(l.compressed_bytes ?? l.bytes)}`, 11)} ${extra}`.trimEnd());
    }
    if (inv.platform === "android") lines.push("  (~ dex package sizes are estimates: each dex file split by its packages' share of code)");
  }
  for (const [key, values] of Object.entries(inv.components)) {
    if (!values.length) continue;
    lines.push("");
    lines.push(`${key} (${values.length}):`);
    for (const v of values) lines.push(`  ${v}`);
  }
  if (inv.notes.length) {
    lines.push("");
    for (const n of inv.notes) lines.push(`note: ${n}`);
  }
  return lines.join("\n");
}

export function renderDiff(res: DiffResponse): string {
  const { base, head, diff } = res;
  const lines: string[] = [];
  lines.push(`${base.version_name} (${base.version_code}) -> ${head.version_name} (${head.version_code})`);
  lines.push(`Package: ${formatBytes(diff.total.before)} -> ${formatBytes(diff.total.after)} (${formatDelta(diff.total.delta)})`);
  const cats = diff.categories.filter((c) => c.compressed_delta !== 0);
  if (cats.length) {
    lines.push("");
    lines.push("By category:");
    for (const c of cats) lines.push(`  ${pad(c.label, 38)} ${pad(formatDelta(c.compressed_delta), 11)} (${formatBytes(c.compressed_before)} -> ${formatBytes(c.compressed_after)})`);
  }
  const { added, removed, changed } = diff.sdks;
  if (added.length + removed.length + changed.length) {
    lines.push("");
    lines.push("SDKs:");
    for (const s of added) lines.push(`  + ${pad(s.name, 30)} ${formatDelta(s.compressed_bytes)}`);
    for (const s of removed) lines.push(`  - ${pad(s.name, 30)} ${formatDelta(-s.compressed_bytes)}`);
    for (const s of changed) lines.push(`  ~ ${pad(s.name, 30)} ${formatDelta(s.delta)}`);
  }
  const libRows = [
    ...diff.libraries.added.map((l) => ({ mark: "+", name: l.name, kind: l.kind, delta: l.compressed_bytes ?? l.bytes, note: l.version ? `v${l.version}` : "" })),
    ...diff.libraries.removed.map((l) => ({ mark: "-", name: l.name, kind: l.kind, delta: -(l.compressed_bytes ?? l.bytes), note: "" })),
    ...diff.libraries.changed.map((l) => ({
      mark: "~", name: l.name, kind: l.kind, delta: l.compressed_delta,
      note: l.version_before !== l.version_after ? `v${l.version_before ?? "?"} -> v${l.version_after ?? "?"}` : "",
    })),
  ].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (libRows.length) {
    lines.push("");
    lines.push("Libraries (by size impact):");
    for (const r of libRows.slice(0, 30)) lines.push(`  ${r.mark} ${pad(r.name, 40)} ${pad(r.kind, 12)} ${pad(formatDelta(r.delta), 11)} ${r.note}`.trimEnd());
    if (libRows.length > 30) lines.push(`  ... ${libRows.length - 30} more (use --json)`);
  }
  for (const [key, c] of Object.entries(diff.components)) {
    lines.push("");
    lines.push(`${key}:`);
    for (const v of c.added) lines.push(`  + ${v}`);
    for (const v of c.removed) lines.push(`  - ${v}`);
  }
  const files = [...diff.files.added, ...diff.files.grown].sort((a, b) => b.delta - a.delta).slice(0, 10);
  if (files.length) {
    lines.push("");
    lines.push("Files that grew most (uncompressed):");
    for (const f of files) lines.push(`  ${pad(formatDelta(f.delta), 11)} ${f.path}`);
  }
  if (diff.notes.length) {
    lines.push("");
    for (const n of diff.notes) lines.push(`note: ${n}`);
  }
  return lines.join("\n");
}

function missingHint(err: unknown, appIdOrSlug: string): Error | unknown {
  if (err instanceof QuiverApiError && err.status === 404) {
    const body = err.body as { code?: string; build_id?: string } | null;
    if (body?.code === "INVENTORY_MISSING" && body.build_id) {
      return new Error(
        `Build ${body.build_id} has no content inventory yet. Compute it with: hands builds inventory ${appIdOrSlug} ${body.build_id} --refresh`,
      );
    }
  }
  return err;
}

export function registerBuildInventoryCommands(
  builds: Command,
  program: Command,
  resolveAppId: (slugOrId: string) => Promise<string>,
): void {
  builds
    .command("inventory <appIdOrSlug> <buildId>")
    .description("Show what a build's APK or IPA contains: size by category, SDKs, libraries, permissions and components.")
    .option("--refresh", "Recompute the inventory from the stored package first (backfills older builds).", false)
    .option("--libraries <n>", "Libraries to list (default 20).", "20")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, buildId: string, opts: { refresh?: boolean; libraries?: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const path = `/api/apps/${appId}/builds/${buildId}/inventory`;
      let res: InventoryResponse;
      try {
        res = await apiRequest<InventoryResponse>(path, opts.refresh ? { method: "POST" } : {});
      } catch (err) {
        throw missingHint(err, appIdOrSlug);
      }
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(renderInventory(res, { libraries: Number(opts.libraries) || 20 }));
    });

  builds
    .command("diff <appIdOrSlug> <buildId>")
    .description("Compare a build's contents with another build: size changes, added or removed SDKs, libraries, permissions and components.")
    .option("--against <build>", "Build id to compare with, or 'previous' (same product type, next lower version code).", "previous")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, buildId: string, opts: { against?: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      let res: DiffResponse;
      try {
        res = await apiRequest<DiffResponse>(`/api/apps/${appId}/builds/${buildId}/inventory/diff`, {
          query: { against: opts.against ?? "previous" },
        });
      } catch (err) {
        throw missingHint(err, appIdOrSlug);
      }
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(renderDiff(res));
    });
}
