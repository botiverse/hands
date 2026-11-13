/**
 * Hands-facing wrappers around @botiverse/agent-session-store.
 * The compiled-fixed service slug lives here so the shared package has no Hands default.
 */
import {
  agentAuthPath as sessionAuthPath,
  readAgentAccessToken as readSessionAccessToken,
  readAgentApiBase as readSessionApiBase,
  type AgentEnv,
} from "@botiverse/agent-session-store";

export { admitAgent, type AgentEnv, type Admission } from "@botiverse/agent-session-store";

/**
 * Local session key: the directory the agent session is stored under. It stays
 * fixed across the Raft app id rename so existing logins keep working.
 */
export const HANDS_SERVICE = "hands-4cc7a2";

/**
 * Raft app ids for Hands, tried in order for `raft integration invoke`. The app
 * was renamed from `hands-4cc7a2` to `hands`; Raft keeps the old id as an alias,
 * but older Raft CLIs cannot resolve a former id, and before the rename `hands`
 * does not exist yet. Both name the same app.
 */
export const HANDS_RAFT_SERVICE_IDS: readonly string[] = ["hands", "hands-4cc7a2"];

export function agentAuthPath(a: AgentEnv, service: string = HANDS_SERVICE): string {
  return sessionAuthPath(a, service);
}

export function readAgentAccessToken(a: AgentEnv, service: string = HANDS_SERVICE): string | null {
  return readSessionAccessToken(a, service);
}

export function readAgentApiBase(a: AgentEnv, service: string = HANDS_SERVICE): string | null {
  return readSessionApiBase(a, service);
}
