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

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Command } from "commander";
import { rmSync } from "node:fs";
import { apiRequest, getApiBase, setApiBase, QuiverApiError } from "../lib/api.js";
import { clearConfig, saveConfig, getConfig, configPath } from "../lib/config.js";
import { admitAgent, agentAuthPath, HANDS_SERVICE } from "../lib/agent_env.js";
import { runAgentLogin } from "../lib/agent_auth.js";

async function promptSecret(message: string): Promise<string> {
  // Use a raw-mode readline so we can mask input with '*'.
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  process.stdout.write(message);
  return new Promise((resolve, reject) => {
    let input = "";
    const onData = (chunk: string | Buffer) => {
      const ch = chunk.toString();
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        rl.close();
        resolve(input);
      } else if (ch === "\u0003") {
        // Ctrl+C
        process.stdout.write("\n");
        rl.close();
        reject(new Error("cancelled"));
      } else if (ch === "\u007f" || ch === "\b") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else {
        input += ch;
        process.stdout.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
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

        let token = opts.token;
        if (!token) {
          token = await promptSecret(
            "Hands JWT (input is hidden): ",
          );
          if (token.length < 8) {
            console.error("Token looks too short (min 8 chars).");
            process.exit(1);
          }
        }

        // Persist the token + apiBase to config file.
        clearConfig();
        saveConfig({ apiBase, authToken: token });
        console.log(`✔ Saved to ${configPath()}`);
        console.log(`  API base: ${apiBase}`);

        // Verify the token works by calling /api/auth/me.
        try {
          await apiRequest("/api/auth/me");
          console.log(`✔ Token verified — you're logged in.`);
          console.log("");
          console.log("Next steps:");
          console.log("  hands whoami                            confirm who you are");
          console.log("  hands apps list                         see your apps");
          console.log("  hands feedback list <app> --kind crash  newest crash tickets");
          console.log("  hands --help                            all commands + recipes");
          console.log("");
          console.log("Docs: https://hands.build/docs/cli-reference");
        } catch (e) {
          if (e instanceof QuiverApiError && e.status === 401) {
            console.error(
              `✘ Token rejected (401). Run \`hands logout\` and try again.`,
            );
            process.exit(1);
          }
          throw e;
        }
      },
    );

  program
    .command("logout")
    .description("Clear the saved Hands token (agent store in an agent, else human config).")
    .action(() => {
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
      clearConfig();
      console.log(`✔ Logged out (token cleared from ${configPath()}).`);
    });
}

// Keep the command module side-effect free when imported by tests.
