/**
 * Config + auth storage for the quiver CLI.
 *
 * Resolution order for any setting (first wins):
 *   1. CLI flag (--api, --token, ...)
 *   2. Environment variable (QUIVER_API, QUIVER_SESSION_COOKIE, ...)
 *   3. File at $XDG_CONFIG_HOME/quiver/auth.json (default ~/.config/quiver/auth.json)
 *
 * The config file holds:
 *   - apiBase: the Quiver Worker URL the CLI talks to
 *   - sessionCookie: the HttpOnly `quiver_session` cookie value the
 *     Worker set after `quiver login` (or copied from the browser DevTools)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface CliConfig {
  apiBase?: string;
  sessionCookie?: string;
}

const DEFAULT_API_BASE = "https://quiver.oranix.io";

function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const dir = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(dir, "quiver", "auth.json");
}

export function getConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as CliConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<CliConfig>): CliConfig {
  const current = getConfig();
  const next: CliConfig = { ...current, ...patch };
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  // 0600 — session cookie is sensitive.
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export function clearConfig(): void {
  const current = getConfig();
  const next: CliConfig = { ...current };
  delete next.sessionCookie;
  saveConfig(next);
}

export function resolveApiBase(): string {
  const cliFlag = process.env.QUIVER_CLI_API;
  if (cliFlag) return cliFlag;
  const env = process.env.QUIVER_API;
  if (env) return env;
  const cfg = getConfig();
  if (cfg.apiBase) return cfg.apiBase;
  return DEFAULT_API_BASE;
}

export function resolveSessionCookie(): string | undefined {
  // CI mode wins over file config (env vars are explicit).
  const env = process.env.QUIVER_SESSION_COOKIE;
  if (env) return env;
  return getConfig().sessionCookie;
}
