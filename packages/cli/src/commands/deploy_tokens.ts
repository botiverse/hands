/**
 * `quiver deploy-tokens` — mint / list / revoke app-scoped deploy tokens.
 *
 * Wires GET/POST/DELETE /api/apps/:appId/deploy-tokens. Requires app admin
 * (otherwise the API returns an admin-native error telling you who can grant
 * the role). A created token is printed once — the server stores only a hash —
 * so capture it immediately (e.g. into a CI secret). Deploy tokens authenticate
 * against the Quiver API as `Authorization: Bearer <token>`, which the CLI also
 * reads from the QUIVER_BEARER_TOKEN env var.
 */

import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";

interface AppRow {
  id: string;
  slug: string;
}

interface DeployToken {
  id: string;
  name: string;
  token_prefix: string;
  app_role: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

async function resolveAppId(appIdOrSlug: string): Promise<string> {
  const isUuid =
    appIdOrSlug.length === 36 && appIdOrSlug.split("-").length === 5;
  if (isUuid) return appIdOrSlug;
  const res = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const match = res.apps.find((a) => a.slug === appIdOrSlug);
  if (!match) {
    console.error(`No app with slug '${appIdOrSlug}'.`);
    process.exit(1);
  }
  return match.id;
}

export function registerDeployTokenCommands(program: Command): void {
  const dt = program
    .command("deploy-tokens")
    .description(
      "Mint, list, and revoke app-scoped deploy tokens (requires app admin).",
    );

  dt.command("list <appIdOrSlug>")
    .alias("ls")
    .description("List an app's deploy tokens (metadata only, no secret values).")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{ deploy_tokens: DeployToken[] }>(
        `/api/apps/${appId}/deploy-tokens`,
      );
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.deploy_tokens.length === 0) {
        console.log("No deploy tokens.");
        return;
      }
      console.log(["NAME", "ROLE", "PREFIX", "EXPIRES", "REVOKED", "ID"].join("\t"));
      for (const t of res.deploy_tokens) {
        console.log(
          [
            t.name,
            t.app_role,
            t.token_prefix,
            t.expires_at ? new Date(t.expires_at).toISOString() : "never",
            t.revoked_at ? "yes" : "no",
            t.id.slice(0, 8),
          ].join("\t"),
        );
      }
    });

  dt.command("create <appIdOrSlug>")
    .description("Mint a new deploy token. The token is printed once — capture it now.")
    .requiredOption("--name <name>", "Human label for the token (e.g. github-ci).")
    .option("--role <role>", "publisher | viewer", "publisher")
    .option(
      "--expires-in-days <days>",
      "Expiry in days from now (default: never expires).",
    )
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          name: string;
          role?: string;
          expiresInDays?: string;
          json?: boolean;
        },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        let expiresAt: number | null = null;
        if (opts.expiresInDays != null) {
          const days = Number(opts.expiresInDays);
          if (!Number.isFinite(days) || days <= 0) {
            console.error("--expires-in-days must be a positive number.");
            process.exit(1);
          }
          expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
        }
        const res = await apiRequest<{ token: string; deploy_token: DeployToken }>(
          `/api/apps/${appId}/deploy-tokens`,
          {
            method: "POST",
            body: { name: opts.name, app_role: opts.role, expires_at: expiresAt },
          },
        );
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        const t = res.deploy_token;
        console.log(`Deploy token '${t.name}' (${t.app_role}) created.`);
        console.log(`  id: ${t.id}`);
        console.log(
          `  expires: ${t.expires_at ? new Date(t.expires_at).toISOString() : "never"}`,
        );
        console.log("");
        console.log("  token (shown once — store it now, e.g. as a CI secret):");
        console.log(`  ${res.token}`);
      },
    );

  dt.command("revoke <appIdOrSlug> <tokenId>")
    .description("Revoke a deploy token by id.")
    .action(async (appIdOrSlug: string, tokenId: string) => {
      const appId = await resolveAppId(appIdOrSlug);
      await apiRequest(`/api/apps/${appId}/deploy-tokens/${tokenId}`, {
        method: "DELETE",
      });
      console.log(`Revoked deploy token ${tokenId}.`);
    });
}
