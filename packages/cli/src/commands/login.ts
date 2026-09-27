/**
 * `quiver login` — authenticate the CLI.
 *
 * v1 flow (browser-required):
 *   1. CLI prints a URL: https://quiver-worker.../api/auth/login?return_to=...
 *   2. User opens the URL in any browser, signs in with Raft OAuth.
 *   3. Hands redirects to the dashboard's CLI callback page with a signed JWT.
 *   4. User copies the JWT shown by that page and pastes it into the CLI.
 *
 * CI mode: `HANDS_AUTH_TOKEN=... hands whoami` — env var is read directly,
 * with no file storage.
 *
 * Raft OAuth still uses a browser redirect, while Hands turns the successful
 * login into a copyable signed JWT for the CLI.
 */

import type { Command } from "commander";
import { rmSync } from "node:fs";
import { getApiBase, setApiBase } from "../lib/api.js";
import { clearConfig, saveConfig, getConfig, configPath } from "../lib/config.js";
import { admitAgent, agentAuthPath, HANDS_SERVICE } from "../lib/agent_env.js";
import { runAgentLogin } from "../lib/agent_auth.js";
import { normalizeToken, promptSecret } from "../lib/secret_input.js";

/** POST /api/auth/logout with the given bearer; true when the server confirmed. */
async function revokeSession(apiBase: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/auth/logout", apiBase), {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function registerLoginCommands(program: Command): void {
  const cmd = program
    .command("login")
    .description("Authenticate the CLI against Hands.")
    .option(
      "--token <jwt>",
      "Paste the Hands JWT shown by the browser login callback.",
    )
    .option(
      "--api <url>",
      "Override the Hands business API URL for this login only.",
    )
    .option("--print-url", "Just print the login URL; don't prompt for a token.", false)
    .action(
      async (opts: {
        token?: string;
        api?: string;
        printUrl?: boolean;
      }) => {
        const apiBase = opts.api ?? getApiBase();
        const admission = admitAgent();

        // Managed-agent path (RFC 057): no browser, no paste. Runs agent-login →
        // exchange → store under $SLOCK_HOME. Isolated from the human config.
        if (admission.kind === "agent") {
          if (opts.token) {
            // Never let --token write the human config from inside an agent.
            console.error("✘ In a managed agent environment, run `hands login` without --token (agent-login is used instead).");
            process.exit(1);
          }
          if (opts.printUrl) {
            console.log("(agent environment) `hands login` runs the non-interactive agent-login flow — no URL to open.");
            return;
          }
          setApiBase(apiBase); // exchange must target this API base
          try {
            const session = await runAgentLogin(admission.env);
            console.log(`✔ Agent login complete (service ${HANDS_SERVICE}).`);
            console.log(`  Stored under $SLOCK_HOME/agents/$SLOCK_AGENT_ID/integrations/${HANDS_SERVICE}/auth.json`);
            console.log(`  access token expires ${session.access_expires_at}; refresh rotates automatically.`);
            console.log("  Subsequent `hands` commands use the stored Hands token directly.");
          } catch (e) {
            console.error(`✘ Agent login failed: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
          }
          return;
        }
        if (admission.kind === "fail_closed") {
          // Partial/invalid agent markers must never silently use human credentials.
          console.error(`✘ Agent environment is incomplete or invalid (${admission.reason}); refusing to fall back to human login. Fix the agent environment and retry.`);
          process.exit(1);
        }

        const loginUrl = `${apiBase}/api/auth/login?return_to=${encodeURIComponent("/cli/callback")}`;

        if (opts.printUrl) {
          console.log(loginUrl);
          return;
        }

        console.log("To authenticate the Hands CLI:");
        console.log("");
        console.log(`  1. Open this URL in any browser:`);
        console.log(`     ${loginUrl}`);
        console.log("");
        console.log(`  2. Sign in with Raft. You'll land on the Hands CLI callback page.`);
        console.log(`  3. Copy the JWT shown there and paste it below.`);
        console.log("");

        let raw = opts.token;
        if (!raw) {
          try {
            raw = await promptSecret("Hands JWT (input is hidden): ");
          } catch {
            console.error("Cancelled.");
            process.exit(130);
          }
        }
        const normalized = normalizeToken(raw);
        if ("error" in normalized) {
          console.error(`✘ ${normalized.error}`);
          process.exit(1);
        }
        const token = normalized.token;

        // Verify BEFORE persisting: a rejected or unreachable token must not
        // replace a working saved login.
        setApiBase(apiBase);
        try {
          const res = await fetch(new URL("/api/auth/me", apiBase), {
            headers: { accept: "application/json", authorization: `Bearer ${token}` },
          });
          if (res.status === 401) {
            console.error("✘ Token rejected (401): expired or not a Hands login token. Nothing was saved.");
            process.exit(1);
          }
          if (!res.ok) {
            console.error(`✘ Could not verify the token (HTTP ${res.status}). Nothing was saved; try again.`);
            process.exit(1);
          }
        } catch (e) {
          const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
          console.error(`✘ Could not reach ${apiBase} to verify the token${cause}. Nothing was saved.`);
          process.exit(1);
        }

        // Replacing an older human login: revoke it (best-effort) so re-login
        // actually retires the previous session instead of leaving it live.
        const previous = getConfig();
        const previousToken = previous.authToken ?? previous.sessionCookie;
        if (previousToken && previousToken !== token) {
          await revokeSession(previous.apiBase ?? apiBase, previousToken);
        }
        clearConfig();
        saveConfig({ apiBase, authToken: token });
        console.log(`✔ Token verified — you're logged in. Saved to ${configPath()}`);
        console.log(`  API base: ${apiBase}`);
        console.log("");
        console.log("Next steps:");
        console.log("  hands whoami                            confirm who you are");
        console.log("  hands apps list                         see your apps");
        console.log("  hands feedback list <app> --kind crash  newest crash tickets");
        console.log("  hands --help                            all commands + recipes");
        console.log("");
        console.log("Docs: https://hands.build/docs/cli-reference");
      },
    );

  program
    .command("logout")
    .description("Clear the saved Hands token (agent store in an agent, else human config).")
    .action(async () => {
      const admission = admitAgent();
      if (admission.kind === "agent") {
        // Clear the per-agent store only; never touch the human config.
        const path = agentAuthPath(admission.env);
        try {
          rmSync(path, { force: true });
          console.log(`✔ Agent Hands token cleared (${path}).`);
        } catch (e) {
          console.error(`✘ Failed to clear agent token: ${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
        return;
      }
      if (admission.kind === "fail_closed") {
        console.error(`✘ Agent environment is incomplete or invalid (${admission.reason}).`);
        process.exit(1);
      }
      const cfg = getConfig();
      if (!cfg.authToken && !cfg.sessionCookie) {
        console.log("Not logged in (no saved Hands token).");
        return;
      }
      // Revoke server-side first so a copied/leaked token stops working too;
      // clearing only the local file would leave the session alive for 14 days.
      const saved = cfg.authToken ?? cfg.sessionCookie!;
      const revoked = await revokeSession(cfg.apiBase ?? getApiBase(), saved);
      clearConfig();
      console.log(`✔ Logged out (token cleared from ${configPath()}).`);
      if (revoked) {
        console.log("  Session revoked on the server.");
      } else {
        console.error(
          "  ⚠ Could not revoke the session on the server (offline?). The token stays valid until it expires;" +
            " revoke it with: curl -X POST <api>/api/auth/logout -H \"Authorization: Bearer <token>\"",
        );
      }
    });
}

// Keep the command module side-effect free when imported by tests.
