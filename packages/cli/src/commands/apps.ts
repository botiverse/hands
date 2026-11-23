/**
 * `hands apps` — create / list / inspect apps in the caller's org.
 *
 * Wires POST/GET /api/apps, GET /api/apps/:appId, and the explicit
 * app-admin-only client-key read endpoint.
 */

import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

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
      "App platform, for example web, android, ios, ohos, node, electron, or desktop.",
    )
    .option(
      "--runtime <runtime>",
      "What a desktop app is built with: jvm, electron, native, tauri, or other. Descriptive only.",
    )
    .option("--description <text>", "Optional app description.")
    .option("--json", "Output JSON.", false)
    .action(async (opts: {
      slug: string;
      name: string;
      platform: string;
      runtime?: string;
      description?: string;
      json?: boolean;
    }) => {
      const app = await apiRequest<CreatedApp>("/api/apps", {
        method: "POST",
        body: {
          slug: opts.slug,
          name: opts.name,
          platform: opts.platform,
          ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
          ...(opts.description !== undefined
            ? { description: opts.description }
            : {}),
        },
      });
      if (jsonRequested(program, opts.json)) {
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
      if (jsonRequested(program, opts.json)) {
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
            a.id,
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
      if (jsonRequested(program, opts.json)) {
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
      if (jsonRequested(program, opts.json)) {
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

  apps
    .command("asc-key <appIdOrSlug>")
    .description(
      "Set the app's App Store Connect API key (TestFlight upload, App Store, iOS profiles). " +
      "--from-app reuses the key another app of the organization holds (admin of both apps); " +
      "or pass --key-id, --issuer-id and --p8 <AuthKey_XXXX.p8>. Requires app admin. Without options, shows the current key id.",
    )
    .option("--from-app <appIdOrSlug>", "Copy the key of this app in the same organization.")
    .option("--key-id <id>", "API key id.")
    .option("--issuer-id <id>", "Issuer id.")
    .option("--p8 <path>", "The downloaded AuthKey_XXXX.p8 file.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { fromApp?: string; keyId?: string; issuerId?: string; p8?: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      type Meta = { asc_credentials: { key_id: string; issuer_id: string; updated_at?: number } | null };
      let result: Meta;
      if (opts.fromApp) {
        if (opts.keyId || opts.issuerId || opts.p8) throw new Error("Pass --from-app or --key-id/--issuer-id/--p8, not both.");
        result = await apiRequest<Meta>(`/api/apps/${appId}/asc-credentials`, { method: "PUT", body: { from_app: opts.fromApp } });
      } else if (opts.keyId || opts.issuerId || opts.p8) {
        if (!opts.keyId || !opts.issuerId || !opts.p8) throw new Error("--key-id, --issuer-id and --p8 go together.");
        const { readFile } = await import("node:fs/promises");
        result = await apiRequest<Meta>(`/api/apps/${appId}/asc-credentials`, {
          method: "PUT",
          body: { key_id: opts.keyId, issuer_id: opts.issuerId, p8: await readFile(opts.p8, "utf8") },
        });
      } else {
        result = await apiRequest<Meta>(`/api/apps/${appId}/asc-credentials`);
      }
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const meta = result.asc_credentials;
      console.log(meta ? `${appIdOrSlug}: App Store Connect key ${meta.key_id} (issuer ${meta.issuer_id}).` : `${appIdOrSlug} has no App Store Connect key.`);
    });

  apps
    .command("add-member <appIdOrSlug> <accountId> <role>")
    .description(
      "Grant a Hands account a direct role on one app (admin, publisher or viewer). " +
        "The account id comes from that principal's `whoami`.",
    )
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, accountId: string, role: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<Record<string, unknown>>(`/api/apps/${appId}/members`, {
        method: "POST",
        body: { account_id: accountId, app_role: role },
      });
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Granted ${role} on app ${appId} to account ${accountId}.`);
    });

  apps
    .command("update-member <appIdOrSlug> <accountId> <role>")
    .description("Change a Hands account's direct role on one app (admin, publisher or viewer).")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, accountId: string, role: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<Record<string, unknown>>(
        `/api/apps/${appId}/members/${accountId}`,
        { method: "PATCH", body: { app_role: role } },
      );
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Changed account ${accountId} to ${role} on app ${appId}.`);
    });

  apps
    .command("remove-member <appIdOrSlug> <accountId>")
    .description("Revoke a Hands account's direct role on one app.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, accountId: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const result = await apiRequest<Record<string, unknown>>(
        `/api/apps/${appId}/members/${accountId}`,
        { method: "DELETE" },
      );
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Removed account ${accountId} from app ${appId}.`);
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
