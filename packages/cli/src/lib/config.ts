/**
 * Config + auth storage for the hands CLI.
 *
 * Resolution order for any setting (first wins):
 *   1. CLI flag (--api, --token, ...)
 *   2. Environment variable (HANDS_API, HANDS_AUTH_TOKEN, ...)
 *   3. Human config file at $XDG_CONFIG_HOME/hands/auth.json (default ~/.config/hands/auth.json)
 *
 * Agent mode (managed Raft agent) is ISOLATED: it uses ONLY the per-agent Hands token
 * under $SLOCK_HOME and never reads/writes the human config or ambient env token. A
 * broken (partial/invalid) agent environment fails closed rather than falling back.
 *
 * The human config file holds:
 *   - apiBase: the Hands Worker URL the CLI talks to
 *   - authToken: the signed Hands JWT returned after `hands login`
 * A legacy ~/.config/quiver/auth.json is migrated to the hands path on first use.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { readEnv } from "./env.js";
import {
  admitAgent,
  readAgentAccessToken,
  readAgentApiBase,
} from "./agent_env.js";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface CliConfig {
  apiBase?: string;
  authToken?: string;
  /** Legacy field read during migration from cookie-backed sessions. */
  sessionCookie?: string;
}

const DEFAULT_API_BASE = "https://hands.build";

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
}

/** Canonical human config path (post-rename). */
export function configPath(): string {
  return join(configDir(), "hands", "auth.json");
}

/** Legacy path from before the quiver→hands rename; read once, then migrated. */
function legacyConfigPath(): string {
  return join(configDir(), "quiver", "auth.json");
}

function readConfigFile(path: string): CliConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CliConfig;
    return parsed ?? {};
  } catch {
    return null;
  }
}

export function getConfig(): CliConfig {
  const path = configPath();
  const current = readConfigFile(path);
  if (current) return current;
  // One-time migration from the legacy quiver path. On ANY failure keep the old file
  // and old credentials (return the legacy config; do not delete or corrupt it).
  const legacy = readConfigFile(legacyConfigPath());
  if (!legacy) return {};
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(legacy, null, 2) + "\n", { mode: 0o600 });
  } catch {
    return legacy; // migration failed → keep using the legacy credentials
  }
  return legacy;
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
  const admission = admitAgent();
  if (admission.kind === "agent") {
    // Agent mode: the api base comes from the agent store (recorded at login), never
    // the human config file.
    return readAgentApiBase(admission.env) ?? DEFAULT_API_BASE;
  }
  if (admission.kind === "fail_closed") {
    return DEFAULT_API_BASE; // broken agent env: no human config fallback
  }
  const cfg = getConfig();
  if (cfg.apiBase) return cfg.apiBase;
  return DEFAULT_API_BASE;
}

export function resolveAuthToken(): string | undefined {
  const admission = admitAgent();
  if (admission.kind === "agent") {
    // Isolated: ONLY the per-agent store. Missing/bad → require `hands login`; never
    // fall back to HANDS_AUTH_TOKEN or the human config.
    return readAgentAccessToken(admission.env) ?? undefined;
  }
  if (admission.kind === "fail_closed") {
    return undefined; // broken agent env → no ambient credentials
  }
  // Human / CI (no agent markers): env token wins, then the (migrated) human config.
  const env = readEnv("AUTH_TOKEN") ?? readEnv("BEARER_TOKEN") ?? readEnv("SESSION_COOKIE");
  if (env) return env;
  const config = getConfig();
  return config.authToken ?? config.sessionCookie;
}
