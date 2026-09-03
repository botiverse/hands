import { join, resolve, sep } from "node:path";
import { AGENT_ID_RE, type AgentEnv } from "./admit.js";

const SERVICE_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/** Canonical per-agent store path, with slug validation + root containment. */
export function agentAuthPath(a: AgentEnv, service: string): string {
  if (typeof service !== "string" || !SERVICE_SLUG_RE.test(service)) throw new Error("invalid service slug");
  if (!AGENT_ID_RE.test(a.agentId)) throw new Error("invalid agent id");
  const root = resolve(a.slockHome, "agents", a.agentId, "integrations");
  const path = resolve(root, service, "auth.json");
  if (path !== join(root, service, "auth.json") || !path.startsWith(root + sep)) {
    throw new Error("resolved store path escapes the integrations root");
  }
  return path;
}
