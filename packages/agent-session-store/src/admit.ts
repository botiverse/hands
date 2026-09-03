/**
 * Agent runtime admission. Tri-state (Volta): no markers → human/CI; any agent
 * marker but incomplete/invalid/no-executable-wrapper → FAIL CLOSED (never fall
 * back to human credentials); complete + valid → agent mode, pinned to the exact
 * `raft` wrapper inside $SLOCK_CLI_TRANSPORT_DIR (never the PATH `raft`).
 */
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface AgentEnv {
  transportDir: string;
  slockHome: string;
  agentId: string;
  raftBin: string;
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
