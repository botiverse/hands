/**
 * `hands trusted-publishers` — configure which GitHub Actions workflows may
 * publish an app without a stored token, and `hands github-oidc-login`, which a
 * workflow runs to exchange its GitHub OIDC token for a short-lived Hands token.
 */

import { appendFileSync } from "node:fs";
import type { Command } from "commander";
import { apiRequest, getApiBase } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";
import { resolveAppId } from "./deploy_tokens.js";

interface TrustedPublisher {
  id: string;
  repository: string;
  repository_id: string | null;
  workflow_path: string;
  ref_patterns: string[];
  environment: string | null;
  app_role: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface ExchangeResponse {
  token: string;
  token_prefix: string;
  expires_at: number;
  app_id: string;
  app_slug: string;
  app_role: string;
}

/** Ask the GitHub Actions runtime for an OIDC token with this audience. */
export async function requestGithubOidcToken(audience: string, env = process.env): Promise<string> {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      "No GitHub OIDC token available. Run inside GitHub Actions with `permissions: id-token: write` on the job.",
    );
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, { headers: { authorization: `bearer ${requestToken}`, accept: "application/json" } });
  if (!response.ok) throw new Error(`GitHub refused the OIDC token request (${response.status}).`);
  const body = await response.json() as { value?: unknown };
  if (typeof body.value !== "string" || !body.value) throw new Error("GitHub returned no OIDC token.");
  return body.value;
}

/** Exchange a GitHub OIDC token for a Hands deploy token on one app. */
export async function exchangeGithubOidcToken(app: string, githubToken: string, apiBase = getApiBase()): Promise<ExchangeResponse> {
  const response = await fetch(new URL("/public/v2/oidc/github/token", apiBase), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ app, token: githubToken }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    // keep empty
  }
  if (!response.ok) {
    const detail = [body.error ?? `${response.status}`];
    if (body.code) detail.push(`(${String(body.code)})`);
    if (Array.isArray(body.mismatch)) detail.push(`mismatch: ${body.mismatch.join(", ")}`);
    if (body.workflow_ref) detail.push(`workflow_ref: ${String(body.workflow_ref)}`);
    throw new Error(`Hands refused the exchange: ${detail.join(" ")}`);
  }
  return body as unknown as ExchangeResponse;
}

export function registerTrustedPublisherCommands(program: Command): void {
  const tp = program
    .command("trusted-publishers")
    .description("Let a GitHub Actions workflow publish an app without a stored token (requires app admin).");

  tp.command("list <appIdOrSlug>")
    .alias("ls")
    .description("List an app's trusted publishers.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{ trusted_publishers: TrustedPublisher[] }>(`/api/apps/${appId}/trusted-publishers`);
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.trusted_publishers.length === 0) {
        console.log("No trusted publishers.");
        return;
      }
      console.log(["REPOSITORY", "WORKFLOW", "REFS", "ENVIRONMENT", "ROLE", "LAST USED", "ID"].join("\t"));
      for (const p of res.trusted_publishers) {
        console.log([
          p.repository,
          p.workflow_path,
          p.ref_patterns.join(","),
          p.environment ?? "-",
          p.app_role,
          p.last_used_at ? new Date(p.last_used_at).toISOString() : "never",
          p.id,
        ].join("\t"));
      }
    });

  tp.command("add <appIdOrSlug>")
    .description("Trust a GitHub workflow to publish this app.")
    .requiredOption("--repository <owner/repo>", "GitHub repository, e.g. botiverse/raft-deck.")
    .requiredOption("--workflow <path>", "Workflow file, e.g. .github/workflows/desktop.yml.")
    .option("--ref <pattern...>", "Allowed refs: refs/heads/<branch> or refs/tags/<pattern>; `*` matches within one segment.", ["refs/heads/main"])
    .option("--environment <name>", "Require this GitHub environment.")
    .option("--role <role>", "publisher | viewer", "publisher")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { repository: string; workflow: string; ref: string[]; environment?: string; role: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{ trusted_publisher: TrustedPublisher }>(`/api/apps/${appId}/trusted-publishers`, {
        method: "POST",
        body: {
          repository: opts.repository,
          workflow_path: opts.workflow,
          ref_patterns: opts.ref,
          ...(opts.environment ? { environment: opts.environment } : {}),
          app_role: opts.role,
        },
      });
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      const p = res.trusted_publisher;
      console.log(`Trusted ${p.repository} ${p.workflow_path} on ${p.ref_patterns.join(", ")} as ${p.app_role} (id ${p.id}).`);
      console.log("In the workflow: grant `permissions: id-token: write`, then run `hands github-oidc-login --app <app>`.");
    });

  tp.command("remove <appIdOrSlug> <publisherId>")
    .alias("rm")
    .description("Stop trusting a workflow; tokens it minted stop working.")
    .action(async (appIdOrSlug: string, publisherId: string) => {
      const appId = await resolveAppId(appIdOrSlug);
      await apiRequest(`/api/apps/${appId}/trusted-publishers/${publisherId}`, { method: "DELETE" });
      console.log(`Removed trusted publisher ${publisherId}.`);
    });

  program
    .command("github-oidc-login")
    .description(
      "In GitHub Actions: exchange the job's OIDC token for a 1-hour Hands token on one app. " +
      "By default the token is masked and exported as HANDS_BEARER_TOKEN for later steps.",
    )
    .requiredOption("--app <appIdOrSlug>", "App to publish to.")
    .option("--print", "Print the token to stdout instead of exporting it.", false)
    .option("--json", "Output JSON (includes the token).", false)
    .action(async (opts: { app: string; print?: boolean; json?: boolean }) => {
      const audience = new URL(getApiBase()).origin;
      const githubToken = await requestGithubOidcToken(audience);
      const res = await exchangeGithubOidcToken(opts.app, githubToken);
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (opts.print) {
        process.stdout.write(`${res.token}\n`);
        return;
      }
      const githubEnv = process.env.GITHUB_ENV;
      if (!githubEnv) {
        console.error("GITHUB_ENV is not set; use --print to capture the token yourself.");
        process.exit(1);
      }
      console.log(`::add-mask::${res.token}`);
      appendFileSync(githubEnv, `HANDS_BEARER_TOKEN=${res.token}\n`);
      console.log(
        `Hands token for ${res.app_slug} (${res.app_role}, ${res.token_prefix}…) exported as HANDS_BEARER_TOKEN; ` +
        `expires ${new Date(res.expires_at).toISOString()}.`,
      );
    });
}
