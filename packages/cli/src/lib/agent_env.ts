/**
 * Agent runtime admission + credential-store path (RFC 057 agent login, CP3).
 *
 * Admission is TRI-STATE (Volta): no markers → normal human/CI; any agent marker but
 * incomplete/invalid/no-executable-wrapper → FAIL CLOSED (never fall back to human
 * credentials); complete + valid → agent mode, pinned to the exact `raft` wrapper
 * inside $SLOCK_CLI_TRANSPORT_DIR (never the PATH `raft`).
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// Compiled-fixed exact installed Raft client key. NOT environment-overridable: it is
// both the invoke target AND part of the on-disk store path, so an override would be a
// cross-service / path-injection vector. Tests inject a service via function params.
export const HANDS_SERVICE = "hands-4cc7a2";

// RFC 057 service slug.
const SERVICE_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
// Daemon-issued agent id: a conservative safe token (no separators/traversal).
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface AgentEnv {
  transportDir: string;
  slockHome: string;
  agentId: string;
  raftBin: string; // the exact wrapper inside transportDir (never PATH `raft`)
}

export type Admission =
  | { kind: "human" }
  | { kind: "agent"; env: AgentEnv }
  | { kind: "fail_closed"; reason: string };

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide human vs agent vs fail-closed. Once ANY agent marker is present we never
 * return `human` — a partial/invalid environment fails closed rather than silently
 * using ambient human credentials.
 */
export function admitAgent(env: NodeJS.ProcessEnv = process.env): Admission {
  const transportDir = env.SLOCK_CLI_TRANSPORT_DIR;
  const slockHome = env.SLOCK_HOME;
  const agentId = env.SLOCK_AGENT_ID;
  if (!transportDir && !slockHome && !agentId) return { kind: "human" };
  if (!transportDir || !slockHome || !agentId) {
    return { kind: "fail_closed", reason: "incomplete agent markers" };
  }
  if (!AGENT_ID_RE.test(agentId)) {
    return { kind: "fail_closed", reason: "invalid SLOCK_AGENT_ID" };
  }
  const raftBin = join(transportDir, "raft");
  if (!isExecutableFile(raftBin)) {
    return { kind: "fail_closed", reason: "raft wrapper missing or not executable in transport dir" };
  }
  return { kind: "agent", env: { transportDir, slockHome, agentId, raftBin } };
}

/** Canonical per-agent store path, with slug validation + root containment. */
export function agentAuthPath(a: AgentEnv, service: string = HANDS_SERVICE): string {
  if (!SERVICE_SLUG_RE.test(service)) throw new Error("invalid service slug");
  if (!AGENT_ID_RE.test(a.agentId)) throw new Error("invalid agent id");
  const root = resolve(a.slockHome, "agents", a.agentId, "integrations");
  const path = resolve(root, service, "auth.json");
  // Belt-and-suspenders containment (agentId/service are already regex-validated).
  if (path !== join(root, service, "auth.json") || !path.startsWith(root + sep)) {
    throw new Error("resolved store path escapes the integrations root");
  }
  return path;
}

/**
 * Read the stored Hands access token for this agent, or null if absent/unreadable.
 * Dependency-free (fs + path only) so `config.ts` can call it without an import cycle
 * through the api client. Auto-refresh-on-expiry lands in CP3 checkpoint-2.
 */
export function readAgentAccessToken(a: AgentEnv, service: string = HANDS_SERVICE): string | null {
  let path: string;
  try {
    path = agentAuthPath(a, service);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { access_token?: unknown };
    return typeof parsed?.access_token === "string" && parsed.access_token.length > 0
      ? parsed.access_token
      : null;
  } catch {
    return null;
  }
}

/** Read the api base recorded in the agent store (so the resolver never reads the
 *  human config in agent mode), or null. */
export function readAgentApiBase(a: AgentEnv, service: string = HANDS_SERVICE): string | null {
  let path: string;
  try {
    path = agentAuthPath(a, service);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { api_base?: unknown };
    return typeof parsed?.api_base === "string" && parsed.api_base.length > 0 ? parsed.api_base : null;
  } catch {
    return null;
  }
}
