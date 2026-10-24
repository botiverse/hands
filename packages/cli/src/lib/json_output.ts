import type { Command } from "commander";

/**
 * Whether the caller asked for machine-readable output.
 *
 * `--json` is registered twice on every command: once on the program
 * (`src/index.ts`) and once on each subcommand. Commander fills the
 * subcommand's own options object and leaves the program's copy at its
 * default, so reading `opts.json` inside a handler always yields `false` when
 * the flag was passed — the command silently prints human text while exiting
 * 0, which is the worst failure shape for a caller that pipes the result into
 * a JSON parser.
 *
 * `optsWithGlobals()` merges the subcommand's options over the program's, so
 * either registration is honoured. Use this in every handler rather than
 * reading `opts.json` directly; three separate ad-hoc copies of this predicate
 * existed before, and only some of them consulted the globals.
 */
export function jsonRequested(command: Command, localJson?: boolean): boolean {
  if (localJson) return true;
  return Boolean(command.optsWithGlobals<{ json?: boolean }>().json);
}
