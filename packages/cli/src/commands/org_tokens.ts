/**
 * `hands org-tokens` — mint / list / revoke org-level fine-grained access tokens.
 *
 * Wires GET/POST/DELETE /api/orgs/:orgId/access-tokens. Requires org admin and a
 * signed-in session (a deploy token or org token cannot manage these). A token
 * covers either selected apps (--app, repeatable) or every app in the org
 * (--all-apps), with read-only scopes (app:read, feedback:read). The token is
 * printed once — the server stores only a hash.
 *
 * The org defaults to the signed-in account's org (as `hands whoami` shows);
 * pass --org to choose explicitly. App slugs are resolved against the apps the
 * current session can list; pass app ids for apps outside that view.
 */

import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";
import { resolveAppId } from "./deploy_tokens.js";

interface OrgAccessToken {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  all_apps: boolean;
  apps: Array<{ id: string; slug: string; name: string }>;
  created_by_actor: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

async function resolveOrgId(org: string | undefined): Promise<string> {
  if (org) return org;
  const me = await apiRequest<{ account?: { org_id: string | null } }>("/api/auth/me");
  const orgId = me.account?.org_id;
  if (!orgId) {
    console.error("No current org for this session; pass --org <orgId>.");
    process.exit(1);
  }
  return orgId;
}

function coverage(t: OrgAccessToken): string {
  return t.all_apps ? "all apps" : t.apps.map((a) => a.slug).join(",");
}

export function registerOrgTokenCommands(program: Command): void {
  const ot = program
    .command("org-tokens")
    .description(
      "Mint, list, and revoke org-level read-only access tokens over selected apps (requires org admin).",
    );

  ot.command("list")
    .alias("ls")
    .description("List the org's access tokens (metadata only, no secret values).")
    .option("--org <orgId>", "Organization id (default: your current org).")
    .option("--include-revoked", "Include revoked tokens.", false)
    .option("--json", "Output JSON.", false)
    .action(async (opts: { org?: string; includeRevoked?: boolean; json?: boolean }) => {
      const orgId = await resolveOrgId(opts.org);
      const res = await apiRequest<{ access_tokens: OrgAccessToken[] }>(
        `/api/orgs/${encodeURIComponent(orgId)}/access-tokens`,
        { query: opts.includeRevoked ? { include_revoked: "1" } : {} },
      );
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.access_tokens.length === 0) {
        console.log("No org access tokens.");
        return;
      }
      console.log(["NAME", "SCOPES", "APPS", "PREFIX", "EXPIRES", "REVOKED", "ID"].join("\t"));
      for (const t of res.access_tokens) {
        console.log(
          [
            t.name,
            t.scopes.join(","),
            coverage(t),
            t.token_prefix,
            t.expires_at ? new Date(t.expires_at).toISOString() : "never",
            t.revoked_at ? "yes" : "no",
            t.id,
          ].join("\t"),
        );
      }
    });

  ot.command("create")
    .description("Mint a new org access token. The token is printed once — capture it now.")
    .option("--org <orgId>", "Organization id (default: your current org).")
    .requiredOption("--name <name>", "Human label for the token (e.g. feedback-sync).")
    .requiredOption("--scope <scope...>", "Permission(s): app:read, feedback:read.")
    .option("--app <idOrSlug...>", "App id(s) or slug(s) the token may read.")
    .option("--all-apps", "Cover every app in the org, including apps created later.", false)
    .option("--expires-in-days <days>", "Expiry in days from now (default: never expires).")
    .option("--json", "Output JSON.", false)
    .action(
      async (opts: {
        org?: string;
        name: string;
        scope: string[];
        app?: string[];
        allApps?: boolean;
        expiresInDays?: string;
        json?: boolean;
      }) => {
        const hasApps = (opts.app?.length ?? 0) > 0;
        if (hasApps === Boolean(opts.allApps)) {
          console.error("Pass exactly one of --app <idOrSlug...> or --all-apps.");
          process.exit(1);
        }
        const body: Record<string, unknown> = { name: opts.name, scopes: opts.scope };
        if (opts.expiresInDays != null) {
          const days = Number(opts.expiresInDays);
          if (!Number.isFinite(days) || days <= 0 || days > 3650) {
            console.error("--expires-in-days must be a number of days between 0 and 3650.");
            process.exit(1);
          }
          body.expires_in_days = days;
        }
        const orgId = await resolveOrgId(opts.org);
        if (opts.allApps) {
          body.all_apps = true;
        } else {
          const ids: string[] = [];
          for (const app of opts.app ?? []) ids.push(await resolveAppId(app));
          body.app_ids = ids;
        }
        const res = await apiRequest<{ token: string; access_token: OrgAccessToken }>(
          `/api/orgs/${encodeURIComponent(orgId)}/access-tokens`,
          { method: "POST", body },
        );
        if (jsonRequested(program, opts.json)) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        const t = res.access_token;
        console.log(`Org access token '${t.name}' created.`);
        console.log(`  id: ${t.id}`);
        console.log(`  scopes: ${t.scopes.join(", ")}`);
        console.log(`  apps: ${coverage(t)}`);
        console.log(
          `  expires: ${t.expires_at ? new Date(t.expires_at).toISOString() : "never"}`,
        );
        console.log("");
        console.log("  WARNING: this token is shown once and cannot be retrieved again. Store it now (e.g. in a secret manager):");
        console.log(`  ${res.token}`);
      },
    );

  ot.command("revoke <tokenId>")
    .description("Revoke an org access token by id.")
    .option("--org <orgId>", "Organization id (default: your current org).")
    .action(async (tokenId: string, opts: { org?: string }) => {
      const orgId = await resolveOrgId(opts.org);
      await apiRequest(
        `/api/orgs/${encodeURIComponent(orgId)}/access-tokens/${encodeURIComponent(tokenId)}`,
        { method: "DELETE" },
      );
      console.log(`Revoked org access token ${tokenId}.`);
    });
}
