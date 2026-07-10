/**
 * `quiver login` — authenticate the CLI.
 *
 * v1 flow (browser-required):
 *   1. CLI prints a URL: https://quiver-worker.../api/auth/login?return_to=...
 *   2. User opens the URL in any browser, signs in with Raft OAuth.
 *   3. After login the Worker redirects to /login/raft/callback which is the
 *      admin SPA — at this point the user has a HttpOnly `quiver_session`
 *      cookie in their browser for the Worker's origin.
 *   4. User opens DevTools → Application → Cookies → copies the cookie value.
 *   5. User runs `quiver login --token <cookie>` (or pastes when prompted).
 *
 * CI mode: `QUIVER_SESSION_COOKIE=... quiver whoami` — env var is read
 * directly, no file storage.
 *
 * Why not OAuth Device Flow or PKCE? Raft OAuth today only supports the
 * browser redirect flow with HttpOnly cookies; the CLI can't intercept
 * the callback. Headless flow is a v2 (TBD: Raft Device Flow support or
 * dev-token bypass for service users).
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Command } from "commander";
import { apiRequest, getApiBase, QuiverApiError } from "../lib/api.js";
import { saveConfig, getConfig } from "../lib/config.js";

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
      "--token <cookie>",
      "Paste the quiver_session cookie value (from your browser's DevTools).",
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
        console.log(`  2. Sign in with Raft. You'll land on the admin UI.`);
        console.log(`  3. Open DevTools → Application → Cookies → copy the value of "quiver_session".`);
        console.log(`  4. Paste it below.`);
        console.log("");

        let token = opts.token;
        if (!token) {
          token = await promptSecret(
            "quiver_session cookie value (input is hidden): ",
          );
          if (token.length < 8) {
            console.error("Token looks too short (min 8 chars).");
            process.exit(1);
          }
        }

        // Persist the token + apiBase to config file.
        saveConfig({ apiBase, sessionCookie: token });
        console.log(`✔ Saved to ${configDisplayPath()}`);
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
    .description("Clear the saved session cookie.")
    .action(() => {
      const cfg = getConfig();
      if (!cfg.sessionCookie) {
        console.log("Not logged in (no saved session cookie).");
        return;
      }
      delete (cfg as { sessionCookie?: string }).sessionCookie;
      saveConfig(cfg);
      console.log(`✔ Logged out (token cleared from ${configDisplayPath()}).`);
    });
}

function configDisplayPath(): string {
  // Mirror getConfig's path resolution for display only.
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = xdg && xdg.length > 0 ? xdg : `${process.env.HOME ?? "~"}/.config`;
  return `${dir}/quiver/auth.json`;
}

// silence "unused import" if user has no cookie in env
