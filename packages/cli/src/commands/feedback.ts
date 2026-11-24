/**
 * `quiver feedback` — agent-friendly ticket triage from the terminal.
 * Works with app-scoped deploy tokens (viewer for list/show, publisher for
 * update/comment).
 */
import type { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { apiRequest } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

interface TicketRow {
  id: string;
  kind: string;
  status: string;
  closure_reason?: string | null;
  duplicate_of_ticket_id?: string | null;
  assignee: string | null;
  message: string;
  version_name: string | null;
  version_code: number | null;
  device_model: string | null;
  created_at: number;
  attachment_count: number;
  comment_count: number;
  build_origin?: "configured" | "external" | "unknown" | null;
  crash_type?: "anr" | "system_kill" | "native" | "exception" | "webview_renderer_gone" | null;
  background_system_kill?: number;
}

async function resolveAppId(slugOrId: string): Promise<string> {
  if (slugOrId.length === 36 && slugOrId.split("-").length === 5) return slugOrId;
  const res = await apiRequest<{ apps: Array<{ id: string; slug: string }> }>("/api/apps");
  const match = res.apps.find((a) => a.slug === slugOrId);
  if (!match) {
    console.error(`No app with slug '${slugOrId}'.`);
    process.exit(1);
  }
  return match.id;
}

export function testflightHint(appIdOrSlug: string): string {
  return [
    "This lists in-app (SDK) tickets only. For iOS TestFlight submissions:",
    `  crashes:             hands testflight crashes ${appIdOrSlug} [--build N] [--download DIR]`,
    `  screenshot feedback: hands testflight feedback ${appIdOrSlug} [--build N] [--download DIR]`,
  ].join("\n");
}

export function registerFeedbackCommands(program: Command): void {
  const feedback = program
    .command("feedback")
    .description("Triage feedback/crash tickets.");

  registerFeedbackRuleCommands(program, feedback);

  feedback
    .command("list <appIdOrSlug>")
    .description("List tickets, newest first.")
    .option("--status <status>", "Filter: open | in_progress | resolved | closed.")
    .option("--kind <kind>", "Filter: feedback | bug | crash | error.")
    .option("--crash-type <type>", "Filter crashes by type: exception | native | anr | system_kill | webview_renderer_gone.")
    .option("--signature <signature>", "Filter crashes by signature (e.g. SystemKill@background).")
    .option("--device-id <deviceId>", "Filter tickets by device_id.")
    .option("--version-code <code>", "Filter tickets by version_code.")
    .option("--build-scope <scope>", "Filter by origin: standard | external | all.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { status?: string; kind?: string; crashType?: string; signature?: string; deviceId?: string; versionCode?: string; buildScope?: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      if (opts.kind) params.set("kind", opts.kind);
      if (opts.crashType) params.set("crash_type", opts.crashType);
      if (opts.signature) params.set("signature", opts.signature);
      if (opts.deviceId) params.set("device_id", opts.deviceId);
      if (opts.versionCode) params.set("version_code", opts.versionCode);
      if (opts.buildScope) params.set("build_scope", opts.buildScope);
      const qs = params.toString();
      const res = await apiRequest<{ tickets: TicketRow[] }>(
        `/api/apps/${appId}/feedback${qs ? `?${qs}` : ""}`,
      );
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.tickets.length === 0) {
        console.log("No tickets.");
        // In-app SDK tickets only. TestFlight submissions live in Apple's API and
        // have their own commands; point at them so an empty list is not a dead end.
        console.log(testflightHint(appIdOrSlug));
        return;
      }
      for (const t of res.tickets) {
        const preview = t.message.replace(/\s+/g, " ").slice(0, 60);
        const crashTag = t.background_system_kill
          ? "[background_system_kill] "
          : t.crash_type && t.crash_type !== "exception"
            ? `[${t.crash_type}] `
            : "";
        console.log(
          `${t.id}  ${t.status.padEnd(11)} ${t.kind.padEnd(8)} ` +
            `${(t.assignee ?? "-").padEnd(16)} v${t.version_name ?? "?"} ` +
            `[${t.attachment_count}📎 ${t.comment_count}💬] ` +
            `${crashTag}` +
            `${t.build_origin === "external" || t.build_origin === "unknown" ? `[${t.build_origin}] ` : ""} ${preview}`,
        );
      }
    });

  feedback
    .command("show <appIdOrSlug> <ticketId>")
    .description("Show a ticket with device context, attachments, and comments.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, ticketId: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{
        ticket: Record<string, unknown>;
        attachments: Array<{ id: string; filename: string; size_bytes: number }>;
        comments: Array<{ author_actor: string; body: string; created_at: number }>;
      }>(`/api/apps/${appId}/feedback/${ticketId}`);
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const t = res.ticket as Record<string, unknown>;
      console.log(`Ticket ${String(t["id"])} (${t["kind"]}, ${t["status"]})`);
      if (t["closure_reason"]) {
        const dup = t["duplicate_of_ticket_id"] ? ` (${t["duplicate_of_ticket_id"]})` : "";
        console.log(`  closure:  ${t["closure_reason"]}${dup}`);
      }
      if (t["build_origin"]) console.log(`  origin:   ${t["build_origin"]}`);
      console.log(`  assignee: ${t["assignee"] ?? "-"}`);
      console.log(`  version:  ${t["version_name"] ?? "?"} (${t["version_code"] ?? "?"}) · ${t["channel"] ?? "?"}`);
      console.log(`  device:   ${t["device_model"] ?? "?"} · Android ${t["os_version"] ?? "?"} · ${t["arch"] ?? "?"} · ${t["locale"] ?? "?"}`);
      console.log(`  device_id: ${t["device_id"] ?? "-"}`);
      console.log(`  contact:  ${t["contact"] ?? "-"}`);
      console.log(`  message:`);
      console.log(String(t["message"] ?? "").split("\n").map((l) => "    " + l).join("\n"));
      if (res.attachments.length) {
        console.log(`  attachments:`);
        for (const a of res.attachments) {
          console.log(`    ${a.id}  ${a.filename} (${(a.size_bytes / 1024).toFixed(1)} KB)`);
        }
      }
      if (res.comments.length) {
        console.log(`  comments:`);
        for (const cm of res.comments) {
          console.log(`    [${new Date(cm.created_at).toISOString()}] ${cm.author_actor}: ${cm.body}`);
        }
      }
    });

  feedback
    .command("update <appIdOrSlug> <ticketId>")
    .description("Change status, closure reason, and/or assignee.")
    .option("--status <status>", "open | in_progress | resolved | closed.")
    .option(
      "--closure-reason <reason>",
      "Reason when closing a ticket: completed | not_planned | cannot_reproduce | duplicate.",
    )
    .option(
      "--duplicate-of <ticketId>",
      "Canonical ticket ID (or unique prefix) when closing with --closure-reason duplicate.",
    )
    .option("--assignee <name>", "Assign to a person/agent; use 'none' to unassign.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        ticketId: string,
        opts: {
          status?: string;
          closureReason?: string;
          duplicateOf?: string;
          assignee?: string;
          json?: boolean;
        },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const body: {
          status?: string;
          closure_reason?: string;
          duplicate_of_ticket_id?: string;
          assignee?: string | null;
        } = {};
        if (opts.status) body.status = opts.status;
        if (opts.closureReason) {
          body.closure_reason = opts.closureReason;
          if (!body.status) body.status = "closed";
        }
        if (opts.duplicateOf) {
          body.duplicate_of_ticket_id = opts.duplicateOf;
          if (!body.closure_reason) body.closure_reason = "duplicate";
          if (!body.status) body.status = "closed";
        }
        if (opts.assignee !== undefined) {
          body.assignee = opts.assignee === "none" ? null : opts.assignee;
        }
        if (body.status === undefined && body.assignee === undefined) {
          throw new Error("nothing to update: pass --status, --closure-reason, --duplicate-of, and/or --assignee");
        }
        const res = await apiRequest<Record<string, unknown>>(
          `/api/apps/${appId}/feedback/${ticketId}`,
          { method: "PATCH", body },
        );
        if (jsonRequested(program, opts.json)) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(`Updated ticket ${ticketId.slice(0, 8)}.`);
      },
    );

  feedback
    .command("comment <appIdOrSlug> <ticketId> <text>")
    .description("Add a comment to a ticket (visible to the reporter by default; --internal for a staff-only note).")
    .option("--json", "Output JSON.", false)
    .option("--internal", "Post as a staff-only internal note (requires feedback:triage or publisher role).", false)
    .action(async (appIdOrSlug: string, ticketId: string, text: string, opts: { json?: boolean; internal?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<Record<string, unknown>>(
        `/api/apps/${appId}/feedback/${ticketId}/comments`,
        { method: "POST", body: { body: text, internal: opts.internal === true } },
      );
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`${opts.internal ? "Internal note" : "Commented"} on ${ticketId.slice(0, 8)}.`);
      const note = reporterEventNote(res.reporter_event);
      if (note) console.log(note);
    });

  feedback
    .command("make-internal <appIdOrSlug> <ticketId> <commentId>")
    .description("Make a reply posted publicly by mistake a staff-only internal note. One way: an internal note cannot be made public.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, ticketId: string, commentId: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{ comment: { id: string }; changed: boolean }>(
        `/api/apps/${appId}/feedback/${encodeURIComponent(ticketId)}/comments/${encodeURIComponent(commentId)}`,
        { method: "PATCH", body: { internal: true } },
      );
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(res.changed
        ? `Comment ${res.comment.id.slice(0, 8)} is now internal. A reporter app that already fetched it keeps its copy.`
        : `Comment ${res.comment.id.slice(0, 8)} was already internal.`);
    });

  feedback
    .command("download-attachment <appIdOrSlug> <ticketId> <attachmentId>")
    .alias("download")
    .description(
      "Download a feedback attachment to a file. Saves the raw bytes as-is — " +
        "Hands does not unzip or interpret the contents (the producing app owns the format).",
    )
    .option("-o, --output <path>", "Output file path. Defaults to the server filename in the cwd.")
    .action(
      async (
        appIdOrSlug: string,
        ticketId: string,
        attachmentId: string,
        opts: { output?: string },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const res = await apiRequest<Response>(
          `/api/apps/${appId}/feedback/${ticketId}/attachments/${attachmentId}`,
          { raw: true },
        );
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          console.error(`Download failed: ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
          process.exit(1);
        }
        const disposition = res.headers.get("content-disposition") ?? "";
        const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
        const serverName = match?.[1] ? decodeURIComponent(match[1]) : attachmentId;
        const outPath = opts.output ?? serverName;
        const bytes = Buffer.from(await res.arrayBuffer());
        await writeFile(outPath, bytes);
        console.log(`Saved ${bytes.length} bytes to ${outPath}`);
      },
    );
}

/** What happens to the reporter after a reply (the comment answer's `reporter_event`). */
export function reporterEventNote(event: unknown): string | null {
  if (event === "queued") return "The reporter's app is notified of this reply.";
  if (event === "no_reporter_channel") {
    return "Note: this ticket has no channel back to the reporter (it was not filed from an app with a reporter integration), so nobody is notified. Reply to them where they reported it.";
  }
  if (event === "reporter_inactive") {
    return "Note: the reporter's integration is inactive, so their app is not notified of this reply.";
  }
  return null;
}

type FeedbackRule = {
  id: string; name: string; enabled: boolean; action: "close" | "mute"; match: Record<string, unknown>;
  protect_high_risk: boolean; hits: number; last_hit_at: number | null;
};
type RulePreview = {
  days: number; scanned: number; scan_limit_reached: boolean; matched: number; matched_open: number;
  by_signature: Array<{ signature: string; count: number }>;
  sample: Array<{ id: string; status: string; signature: string | null; version_name: string | null; device_model: string | null }>;
};

async function readMatch(value: string): Promise<unknown> {
  const text = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
  try { return JSON.parse(text); } catch { throw new Error("--match must be JSON, or @file with JSON"); }
}

export function formatRulePreview(p: RulePreview): string {
  const lines = [`Would match ${p.matched} of ${p.scanned} crash/error tickets in the last ${p.days} days (${p.matched_open} still open).`];
  if (p.scan_limit_reached) lines.push("Only the newest 5000 tickets were checked.");
  for (const s of p.by_signature) lines.push(`  ${String(s.count).padStart(5)}  ${s.signature}`);
  if (p.sample.length) {
    lines.push("Examples:");
    for (const t of p.sample.slice(0, 10)) lines.push(`  ${t.id.slice(0, 8)}  ${t.status.padEnd(11)} ${t.version_name ?? "-"}  ${t.device_model ?? "-"}  ${t.signature ?? "-"}`);
  }
  return lines.join("\n");
}

export function formatRules(rules: FeedbackRule[]): string {
  if (rules.length === 0) return "No rules.";
  return rules.map((r) => [
    `${r.id.slice(0, 8)}  ${r.enabled ? "on " : "off"}  ${r.action.padEnd(5)}  ${r.name}`,
    `          match ${JSON.stringify(r.match)}${r.protect_high_risk ? "" : "  (high-risk exits NOT protected)"}`,
    `          hits ${r.hits}${r.last_hit_at ? `, last ${new Date(r.last_hit_at).toISOString()}` : ""}`,
  ].join("\n")).join("\n");
}

function registerFeedbackRuleCommands(program: Command, feedback: Command): void {
  const rules = feedback
    .command("rules")
    .description(
      "Per-app rules that close crash/error reports as noise (not_planned) or keep them out of alerts. " +
        "Reports are always stored; native crashes, ANRs and Java exceptions are protected unless --no-protect.",
    );
  const resolve = async (app: string, id: string) => {
    const appId = await resolveAppId(app);
    if (id.length === 36) return { appId, ruleId: id };
    const { rules: list } = await apiRequest<{ rules: FeedbackRule[] }>(`/api/apps/${appId}/feedback/rules`);
    const found = list.filter((r) => r.id.startsWith(id));
    if (found.length !== 1) throw new Error(found.length ? `rule id ${id} is ambiguous` : `no rule ${id}`);
    return { appId, ruleId: found[0]!.id };
  };

  rules.command("list <appIdOrSlug>").description("List the app's rules.").option("--json", "Output JSON.", false)
    .action(async (app: string, opts: { json?: boolean }) => {
      const res = await apiRequest<{ rules: FeedbackRule[] }>(`/api/apps/${await resolveAppId(app)}/feedback/rules`);
      console.log(jsonRequested(program, opts.json) ? JSON.stringify(res, null, 2) : formatRules(res.rules));
    });

  rules.command("preview <appIdOrSlug>")
    .description("Show what a rule would match among past tickets, changing nothing.")
    .option("--match <json|@file>", "Conditions, e.g. '{\"exit_reason_codes\":[2],\"exit_importance_min\":200,\"foreground\":false}'.")
    .option("--rule <id>", "Preview a saved rule instead.")
    .option("--days <n>", "Look back this many days (1-90).", "14")
    .option("--no-protect", "Let the rule match native crashes, ANRs and Java exceptions.")
    .option("--json", "Output JSON.", false)
    .action(async (app: string, opts: { match?: string; rule?: string; days: string; protect: boolean; json?: boolean }) => {
      if (!opts.match && !opts.rule) throw new Error("pass --match or --rule");
      const appId = await resolveAppId(app);
      const body = opts.rule
        ? { rule_id: (await resolve(app, opts.rule)).ruleId, days: Number(opts.days) }
        : { match: await readMatch(opts.match!), protect_high_risk: opts.protect, days: Number(opts.days) };
      const res = await apiRequest<RulePreview>(`/api/apps/${appId}/feedback/rules/preview`, { method: "POST", body });
      console.log(jsonRequested(program, opts.json) ? JSON.stringify(res, null, 2) : formatRulePreview(res));
    });

  rules.command("add <appIdOrSlug>")
    .description("Add a rule (disabled until --enable or 'rules enable').")
    .requiredOption("--name <name>", "What the rule is for.")
    .requiredOption("--action <action>", "close (as not_planned) | mute (stay open, no alerts).")
    .requiredOption("--match <json|@file>", "Conditions (see 'rules preview').")
    .option("--no-protect", "Let the rule match native crashes, ANRs and Java exceptions.")
    .option("--enable", "Enable it right away.", false)
    .option("--json", "Output JSON.", false)
    .action(async (app: string, opts: { name: string; action: string; match: string; protect: boolean; enable?: boolean; json?: boolean }) => {
      const appId = await resolveAppId(app);
      const res = await apiRequest<{ rule: FeedbackRule }>(`/api/apps/${appId}/feedback/rules`, { method: "POST",
        body: { name: opts.name, action: opts.action, match: await readMatch(opts.match), protect_high_risk: opts.protect, enabled: opts.enable === true } });
      console.log(jsonRequested(program, opts.json) ? JSON.stringify(res, null, 2) : formatRules([res.rule]));
    });

  for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
    rules.command(`${name} <appIdOrSlug> <ruleId>`).description(`${name === "enable" ? "Enable" : "Disable"} a rule.`)
      .action(async (app: string, id: string) => {
        const { appId, ruleId } = await resolve(app, id);
        const res = await apiRequest<{ rule: FeedbackRule }>(`/api/apps/${appId}/feedback/rules/${ruleId}`, { method: "PATCH", body: { enabled } });
        console.log(formatRules([res.rule]));
      });
  }

  rules.command("delete <appIdOrSlug> <ruleId>").description("Delete a rule. Tickets it already closed stay closed.")
    .action(async (app: string, id: string) => {
      const { appId, ruleId } = await resolve(app, id);
      await apiRequest(`/api/apps/${appId}/feedback/rules/${ruleId}`, { method: "DELETE" });
      console.log(`Deleted rule ${ruleId.slice(0, 8)}.`);
    });
}
