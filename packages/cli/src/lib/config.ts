/**
 * Config + auth storage for the quiver CLI.
 *
 * Resolution order for any setting (first wins):
 *   1. CLI flag (--api, --token, ...)
 *   2. Environment variable (HANDS_API, HANDS_AUTH_TOKEN, ...)
 *   3. File at $XDG_CONFIG_HOME/quiver/auth.json (default ~/.config/quiver/auth.json)
 *
 * The config file holds:
 *   - apiBase: the Quiver Worker URL the CLI talks to
 *   - authToken: the signed Hands JWT returned after `hands login`
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { readEnv } from "./env.js";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface CliConfig {
  apiBase?: string;
  authToken?: string;
  /** Legacy field read during migration from cookie-backed sessions. */
  sessionCookie?: string;
}

const DEFAULT_API_BASE = "https://hands.build";

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
  // 0600 — the JWT is a sensitive bearer credential.
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

export function clearConfig(): void {
  const current = getConfig();
  const next: CliConfig = { ...current };
  delete next.authToken;
  delete next.sessionCookie;
  saveConfig(next);
}

export function resolveApiBase(): string {
  const cliFlag = readEnv("CLI_API");
  if (cliFlag) return cliFlag;
  const env = readEnv("API");
  if (env) return env;
  const cfg = getConfig();
  if (cfg.apiBase) return cfg.apiBase;
  return DEFAULT_API_BASE;
}

export function resolveAuthToken(): string | undefined {
  // CI mode wins over file config (env vars are explicit).
  const env = readEnv("AUTH_TOKEN") ?? readEnv("BEARER_TOKEN") ?? readEnv("SESSION_COOKIE");
  if (env) return env;
  const config = getConfig();
  return config.authToken ?? config.sessionCookie;
}
