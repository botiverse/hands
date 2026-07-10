/**
 * `quiver feedback` — agent-friendly ticket triage from the terminal.
 * Works with app-scoped deploy tokens (viewer for list/show, publisher for
 * update/comment).
 */
import type { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { apiRequest } from "../lib/api.js";

interface TicketRow {
  id: string;
  kind: string;
  status: string;
  assignee: string | null;
  message: string;
  version_name: string | null;
  version_code: number | null;
  device_model: string | null;
  created_at: number;
  attachment_count: number;
  comment_count: number;
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

export function registerFeedbackCommands(program: Command): void {
  const feedback = program
    .command("feedback")
    .description("Triage feedback/crash tickets.");

  feedback
    .command("list <appIdOrSlug>")
    .description("List tickets, newest first.")
    .option("--status <status>", "Filter: open | in_progress | resolved | closed.")
    .option("--kind <kind>", "Filter: feedback | bug | crash.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { status?: string; kind?: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      if (opts.kind) params.set("kind", opts.kind);
      const qs = params.toString();
      const res = await apiRequest<{ tickets: TicketRow[] }>(
        `/api/apps/${appId}/feedback${qs ? `?${qs}` : ""}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.tickets.length === 0) {
        console.log("No tickets.");
        return;
      }
      for (const t of res.tickets) {
        const preview = t.message.replace(/\s+/g, " ").slice(0, 60);
        console.log(
          `${t.id}  ${t.status.padEnd(11)} ${t.kind.padEnd(8)} ` +
            `${(t.assignee ?? "-").padEnd(16)} v${t.version_name ?? "?"} ` +
            `[${t.attachment_count}📎 ${t.comment_count}💬]  ${preview}`,
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
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const t = res.ticket as Record<string, unknown>;
      console.log(`Ticket ${String(t["id"])} (${t["kind"]}, ${t["status"]})`);
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
    .description("Change status and/or assignee.")
    .option("--status <status>", "open | in_progress | resolved | closed.")
    .option("--assignee <name>", "Assign to a person/agent; use 'none' to unassign.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        ticketId: string,
        opts: { status?: string; assignee?: string; json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const body: { status?: string; assignee?: string | null } = {};
        if (opts.status) body.status = opts.status;
        if (opts.assignee !== undefined) {
          body.assignee = opts.assignee === "none" ? null : opts.assignee;
        }
        if (body.status === undefined && body.assignee === undefined) {
          throw new Error("nothing to update: pass --status and/or --assignee");
        }
        const res = await apiRequest<Record<string, unknown>>(
          `/api/apps/${appId}/feedback/${ticketId}`,
          { method: "PATCH", body },
        );
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(`Updated ticket ${ticketId.slice(0, 8)}.`);
      },
    );

  feedback
    .command("comment <appIdOrSlug> <ticketId> <text>")
    .description("Add a comment to a ticket.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, ticketId: string, text: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<Record<string, unknown>>(
        `/api/apps/${appId}/feedback/${ticketId}/comments`,
        { method: "POST", body: { body: text } },
      );
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`Commented on ${ticketId.slice(0, 8)}.`);
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
