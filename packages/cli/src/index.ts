#!/usr/bin/env node
/**
 * quiver CLI — entry point.
 *
 * Subcommands are registered via the registry module. This file only
 * handles top-level commander setup + global flags (--api, --json, --verbose).
 *
 * Auth model: the CLI doesn't store long-lived tokens. It uses the same
 * browser-cookie session as the admin SPA. Two ways to "log in":
 *   - `quiver login` — prints a URL to visit in any browser; the user
 *     completes Raft OAuth there, the Worker sets the quiver_session
 *     cookie, the user copies the cookie value back into the CLI.
 *   - `quiver login --token <cookie>` — paste an existing session cookie.
 *
 * For CI: `quiver login --token "$QUIVER_SESSION_COOKIE"`.
 *
 * Token storage: ~/.config/quiver/auth.json (or $XDG_CONFIG_HOME/quiver/auth.json).
 */

import { Command } from "commander";
import { registerAppCommands } from "./commands/apps.js";
import { registerBuildCommands } from "./commands/builds.js";
import { registerLoginCommands } from "./commands/login.js";
import { registerReleaseCommands } from "./commands/releases.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { getConfig } from "./lib/config.js";
import { setApiBase } from "./lib/api.js";

const program = new Command();

program
  .name("quiver")
  .description("Quiver CLI — manage apps, builds, releases from the terminal.")
  .version("0.1.1")
  .option(
    "--api <url>",
    "Quiver Worker base URL (default: https://quiver.oranix.io or $QUIVER_API)",
  )
  .option("--json", "Output machine-readable JSON (suppresses human output)", false)
  .option("--verbose", "Print HTTP request details for debugging", false);

// Re-read global options after parse to wire into the API client.
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts<{ api?: string; json?: boolean; verbose?: boolean }>();
  const cfg = getConfig();
  const apiBase = opts.api ?? process.env.QUIVER_API ?? cfg.apiBase;
  if (apiBase) setApiBase(apiBase);
  if (opts.verbose) process.env.QUIVER_VERBOSE = "1";
});

// --- Subcommand groups ---
registerLoginCommands(program);
registerWhoamiCommand(program);
registerAppCommands(program);
registerBuildCommands(program);
registerReleaseCommands(program);

program
  .command("version")
  .description("Print quiver CLI version")
  .action(() => {
    console.log(program.version());
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof Error && err.name === "QuiverApiError") {
    console.error(`error: ${err.message}`);
    if (process.env.QUIVER_VERBOSE === "1" && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
