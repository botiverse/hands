/**
 * `hands quota <app>`: how much of each rationed upstream call Hands has spent
 * for the app in the current window, and what is left for each kind of caller.
 * Today that is Google Play's tracks.releases.list (about 12 calls per package
 * per hour, resetting around minute :10), shared by the hourly poll,
 * review-status, the stats page, the promote gate and send-for-review; and
 * App Store Connect's per-API-key hourly quota as Apple last reported it.
 */

import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";
import { resolveAppId } from "./deploy_tokens.js";

export type QuotaTier = "gate" | "interactive" | "background";
export interface AppQuota {
  key: string;
  service: string;
  operation: string;
  scope: string;
  scope_key?: string;
  limit: number;
  used: number;
  remaining: Record<QuotaTier, number>;
  reset_at: number;
  exhausted_until: number | null;
  source: string;
}
/** A quota the upstream reports itself (App Store Connect's X-Rate-Limit). */
export interface ObservedQuota {
  key: string;
  service: string;
  operation: string;
  scope: string;
  scope_key?: string;
  window: "rolling_hour";
  limit: number | null;
  remaining: number | null;
  observed_at: number | null;
  exhausted_until: number | null;
  source: string;
}
export interface AppQuotaResponse {
  quotas: Array<AppQuota | ObservedQuota>;
}

const isObserved = (q: AppQuota | ObservedQuota): q is ObservedQuota => (q as ObservedQuota).window === "rolling_hour";

const iso = (ms: number) => new Date(ms).toISOString();

export function formatQuota(res: AppQuotaResponse): string {
  if (res.quotas.length === 0) {
    return "No rationed upstream calls apply to this app (Google Play needs an Android app with a verified binding; App Store Connect needs an ASC key).";
  }
  const out: string[] = [];
  const ledger = res.quotas.filter((q): q is AppQuota => !isObserved(q));
  const observed = res.quotas.filter(isObserved);
  if (ledger.length > 0) {
    const header = ["QUOTA", "SCOPE", "USED", "GATE", "INTERACTIVE", "BACKGROUND", "RESETS"];
    const rows = ledger.map((q) => [
      `${q.service} ${q.operation}`,
      q.scope_key ?? q.scope,
      `${q.used}/${q.limit}`,
      String(q.remaining.gate),
      String(q.remaining.interactive),
      String(q.remaining.background),
      iso(q.reset_at),
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
    const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
    out.push(line(header), ...rows.map(line));
    for (const q of ledger) {
      if (q.exhausted_until) {
        out.push(`${q.service} ${q.operation}: Google said the quota is used up; Hands makes no calls until ${iso(q.exhausted_until)}.`);
      }
    }
    out.push("Remaining is per caller: gate (a write waiting on the read), interactive (a person or agent asked), background (the hourly poll).");
  }
  for (const q of observed) {
    const what = `${q.service} API key ${q.scope_key ?? ""}`.trimEnd();
    if (q.remaining === null || q.limit === null) {
      out.push(`${what}: no report from Apple in the last hour` + (q.observed_at ? ` (last ${iso(q.observed_at)})` : "") + ".");
    } else {
      out.push(`${what}: ${q.remaining}/${q.limit} requests left in Apple's rolling hour (reported ${iso(q.observed_at!)}).`);
    }
    if (q.exhausted_until) {
      out.push(`${what}: Apple refused for quota (429); only writes call it until ${iso(q.exhausted_until)}.`);
    }
  }
  out.push(`Limit source: ${[...new Set(res.quotas.map((q) => q.source))].join("; ")}.`);
  return out.join("\n");
}

export function registerQuotaCommands(program: Command): void {
  program
    .command("quota <appIdOrSlug>")
    .description(
      "Show how much of each rationed upstream call (Google Play tracks.releases.list: about 12 per app per hour) " +
        "Hands has spent for the app this window, what is left for the promote gate, interactive reads and the " +
        "background poll, and when it resets.",
    )
    .option("--json", "Print JSON output.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<AppQuotaResponse>(`/api/apps/${encodeURIComponent(appId)}/quota`);
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(formatQuota(res));
    });
}
