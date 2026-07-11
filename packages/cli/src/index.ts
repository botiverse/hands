#!/usr/bin/env node
/**
 * quiver CLI — entry point.
 *
 * Subcommands are registered via the registry module. This file only
 * handles top-level commander setup + global flags (--api, --json, --verbose).
 *
 * Auth model: the CLI stores the same signed Hands JWT as the admin SPA.
 * Two ways to "log in":
 *   - `quiver login` — prints a URL to visit in any browser; the user
 *     completes Raft OAuth there, then copies the JWT from the callback page.
 *   - `hands login --token <jwt>` — paste an existing Hands JWT.
 *
 * For CI: set `HANDS_AUTH_TOKEN` or use an app-scoped deploy token.
 *
 * Token storage: ~/.config/quiver/auth.json (or $XDG_CONFIG_HOME/quiver/auth.json).
 */

import { Command } from "commander";
import { registerAppCommands } from "./commands/apps.js";
import { registerBuildCommands } from "./commands/builds.js";
import { registerLoginCommands } from "./commands/login.js";
import { registerReleaseCommands } from "./commands/releases.js";
import { registerFeedbackCommands } from "./commands/feedback.js";
import { registerDeployTokenCommands } from "./commands/deploy_tokens.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerLogsCommands } from "./commands/logs.js";
import { getConfig } from "./lib/config.js";
import { readEnv } from "./lib/env.js";
import { setApiBase } from "./lib/api.js";
import { recordCliEvent } from "./lib/logging.js";

const program = new Command();

program
  .name("hands")
  .description("Hands CLI — manage apps, builds, releases from the terminal.")
  .version("0.5.6")
  .option(
    "--api <url>",
    "Hands business API URL (default: https://hands.build or $HANDS_API)",
  )
  .option("--json", "Output machine-readable JSON (suppresses human output)", false)
  .option("--verbose", "Print HTTP request details for debugging", false)
  .addHelpText(
    "after",
    `
Common recipes:
  hands whoami                                        Who am I / is my auth valid?
  hands apps list                                     Apps I can access
  hands feedback list <app> --kind crash              Newest crash tickets
  hands feedback show <app> <ticketId>                One ticket: device context + attachments
  hands feedback download-attachment <app> <t> <a>    Pull a crash log / screenshot
  hands releases list <app>                           Release history
  hands logs collect                                  Bundle local CLI logs for a bug report

Every command supports --json for scripts/agents. Full docs:
  https://hands.build/docs/cli-reference
  https://hands.build/docs/agent-cli-feedback   (crash/feedback triage guide)`,
  );

// Re-read global options after parse to wire into the API client.
program.hook("preAction", (_rootCommand, actionCommand) => {
  const opts = program.opts<{ api?: string; json?: boolean; verbose?: boolean }>();
  const cfg = getConfig();
  const apiBase = opts.api ?? readEnv("API") ?? cfg.apiBase;
  if (apiBase) setApiBase(apiBase);
  if (opts.verbose) process.env.HANDS_VERBOSE = "1";
  recordCliEvent("info", "command_start", "CLI command started", {
    command: actionCommand.name(),
  });
});

program.hook("postAction", (_rootCommand, actionCommand) => {
  recordCliEvent("info", "command_success", "CLI command completed", {
    command: actionCommand.name(),
  });
});

// --- Subcommand groups ---
registerLoginCommands(program);
registerWhoamiCommand(program);
registerAppCommands(program);
registerBuildCommands(program);
registerReleaseCommands(program);
registerFeedbackCommands(program);
registerDeployTokenCommands(program);
registerLogsCommands(program);

program
  .command("version")
  .description("Print Hands CLI version")
  .action(() => {
    console.log(program.version());
  });

program.parseAsync(process.argv).catch((err) => {
  recordCliEvent("error", "command_error", "CLI command failed", {
    command: program.args[0] ?? "unknown",
    error_name: err instanceof Error ? err.name : "unknown",
  });
  if (err instanceof Error && err.name === "QuiverApiError") {
    // Admin-native, actionable error print (mirrors the Raft CLI discipline):
    // surface the server's stable Code and Next action so an agent knows what
    // to do — request a role, or have an admin act — not just "forbidden".
    const body = (err as { body?: unknown }).body;
    const info =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    console.error(`Error: ${err.message}`);
    if (typeof info.code === "string") console.error(`Code: ${info.code}`);
    if (typeof info.next_action === "string") {
      console.error(`Next action: ${info.next_action}`);
    } else if (typeof info.manage_url === "string") {
      console.error(`Next action: see ${info.manage_url}`);
    }
    if (readEnv("VERBOSE") === "1" && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
