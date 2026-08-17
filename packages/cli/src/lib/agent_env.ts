/**
 * Agent runtime detection + credential-store path (RFC 057 agent login, CP3).
 *
 * A managed Raft agent CLI is identified by the daemon-injected environment:
 * SLOCK_CLI_TRANSPORT_DIR + SLOCK_HOME + SLOCK_AGENT_ID (a `raft` wrapper is on PATH).
 * When present, `hands login` uses the non-interactive agent-login flow (no browser
 * paste) and stores the exchanged Hands token under $SLOCK_HOME — per-agent, isolated
 * from the human config file at ~/.config/quiver/auth.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The exact installed Raft client key this CLI is built for (Argus live probe:
// `hands-4cc7a2`; the CLI selects the service by this exact key). Overridable via
// HANDS_AGENT_SERVICE for non-prod builds / tests — never the brand "hands".
export const HANDS_SERVICE = process.env.HANDS_AGENT_SERVICE ?? "hands-4cc7a2";

export interface AgentEnv {
  transportDir: string;
  slockHome: string;
  agentId: string;
}

/**
 * Return the agent env iff ALL required daemon-injected vars are present, else null.
 * All three are required together — a partial set is not a managed-agent environment.
 */
export function detectAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv | null {
  const transportDir = env.SLOCK_CLI_TRANSPORT_DIR;
  const slockHome = env.SLOCK_HOME;
  const agentId = env.SLOCK_AGENT_ID;
  if (!transportDir || !slockHome || !agentId) return null;
  return { transportDir, slockHome, agentId };
}

/** Canonical per-agent auth store path (RFC 057 local credential store). */
export function agentAuthPath(a: AgentEnv, service: string = HANDS_SERVICE): string {
  return join(a.slockHome, "agents", a.agentId, "integrations", service, "auth.json");
}

/**
 * Read the stored Hands access token for this agent, or null if absent/unreadable.
 * Kept dependency-free (fs + path only) so `config.ts` can call it without an import
 * cycle through the api client. Auto-refresh-on-expiry lands in CP3 checkpoint-2.
 */
export function readAgentAccessToken(a: AgentEnv, service: string = HANDS_SERVICE): string | null {
  const path = agentAuthPath(a, service);
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
