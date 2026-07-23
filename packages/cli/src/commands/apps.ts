/**
 * `hands apps` — create / list / inspect apps in the caller's org.
 *
 * Wires POST/GET /api/apps, GET /api/apps/:appId, and the explicit
 * app-admin-only client-key read endpoint.
 */

import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";

interface AppRow {
  id: string;
  slug: string;
  name: string;
  platform: string;
  archived: number;
  default_channel_slug: string | null;
  created_at: number;
}

interface CreatedApp {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  platform: string;
}

interface ClientKeyResponse {
  app_id: string;
  client_key: string | null;
}

export function registerAppCommands(program: Command): void {
  const apps = program.command("apps").description("Manage apps in your org.");

  apps
    .command("create")
    .description("Create an app in the current Hands organization.")
    .requiredOption("--slug <slug>", "Stable app slug.")
    .requiredOption("--name <name>", "Display name.")
    .requiredOption(
      "--platform <platform>",
      "App platform, for example web, android, ios, ohos, node, or electron.",
    )
    .option("--description <text>", "Optional app description.")
    .option("--json", "Output JSON.", false)
    .action(async (opts: {
      slug: string;
      name: string;
      platform: string;
      description?: string;
      json?: boolean;
    }) => {
      const app = await apiRequest<CreatedApp>("/api/apps", {
        method: "POST",
        body: {
          slug: opts.slug,
          name: opts.name,
          platform: opts.platform,
          ...(opts.description !== undefined
            ? { description: opts.description }
            : {}),
        },
      });
      if (opts.json) {
        console.log(JSON.stringify(app, null, 2));
        return;
      }
      console.log(`Created app ${app.slug} (${app.platform}).`);
      console.log(`  id: ${app.id}`);
      console.log(`  org: ${app.org_id}`);
    });

  apps
    .command("list")
    .alias("ls")
    .description("List apps in the current org.")
    .option("--include-archived", "Include archived (soft-deleted) apps.", false)
    .option("--json", "Output JSON.", false)
    .action(async (opts: { includeArchived?: boolean; json?: boolean }) => {
      const res = await apiRequest<{ apps: AppRow[] }>("/api/apps", {
        query: { include_archived: opts.includeArchived ? "1" : "0" },
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.apps.length === 0) {
        console.log(
          "No apps. Create one with `hands apps create --slug <slug> --name <name> --platform <platform>`.",
        );
        return;
      }
      console.log(
        ["SLUG", "PLATFORM", "ARCHIVED", "DEFAULT_CHANNEL", "ID"].join("\t"),
      );
      for (const a of res.apps) {
        console.log(
          [
            a.slug,
            a.platform,
            a.archived ? "yes" : "no",
            a.default_channel_slug ?? "—",
            a.id.slice(0, 8),
          ].join("\t"),
        );
      }
    });

  apps
    .command("get <appIdOrSlug>")
    .description("Show details for a single app.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const id = await resolveAppId(appIdOrSlug);
      const app = await apiRequest<AppRow>(`/api/apps/${id}`);
      if (opts.json) {
        console.log(JSON.stringify(app, null, 2));
        return;
      }
      console.log(`${app.name}  (${app.platform})`);
      console.log(`  id: ${app.id}`);
      console.log(`  slug: ${app.slug}`);
      console.log(`  archived: ${app.archived ? "yes" : "no"}`);
      console.log(
        `  default_channel: ${app.default_channel_slug ?? "(none)"}`,
      );
    });

  apps
    .command("client-key <appIdOrSlug>")
    .description("Read an app's public SDK client key. Requires app admin.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<ClientKeyResponse>(
        `/api/apps/${appId}/client-key`,
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.client_key) {
        console.log(`App ${appIdOrSlug} has no client key.`);
        return;
      }
      // The key is intentionally printed only for this explicit read command.
      // apiRequest's verbose diagnostics log only method/URL/status, never
      // response bodies, so the value does not leak into debug logs.
      console.log(result.client_key);
    });
}

async function resolveAppId(input: string): Promise<string> {
  if (input.length === 36 && appIdOrUuidDash(input)) return input;
  const res = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const match = res.apps.find((app) => app.slug === input);
  if (!match) throw new Error(`No app with slug '${input}'.`);
  return match.id;
}

function appIdOrUuidDash(s: string): boolean {
  return s.split("-").length === 5;
}
