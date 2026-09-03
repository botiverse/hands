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

export const HANDS_SERVICE = "hands-4cc7a2";

export function agentAuthPath(a: AgentEnv, service: string = HANDS_SERVICE): string {
  return sessionAuthPath(a, service);
}

export function readAgentAccessToken(a: AgentEnv, service: string = HANDS_SERVICE): string | null {
  return readSessionAccessToken(a, service);
}

export function readAgentApiBase(a: AgentEnv, service: string = HANDS_SERVICE): string | null {
  return readSessionApiBase(a, service);
}
