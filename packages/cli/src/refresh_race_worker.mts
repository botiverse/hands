/**
 * Test-only worker (run via tsx in a child process) for the two-process dead-lock
 * recovery race. It reads a pre-seeded agent store from $SLOCK_HOME, waits on a file
 * barrier so sibling workers are released together, then calls forceRefreshAgentToken
 * and prints the resulting access token (or "ERR:...") to stdout. NOT a test file.
 */
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { forceRefreshAgentToken } from "./lib/agent_refresh.js";
import type { AgentEnv } from "./lib/agent_env.js";

const [slockHome, transportDir, agentId, readyFile, goFile, now] = process.argv.slice(2);
const a: AgentEnv = { transportDir, slockHome, agentId, raftBin: `${transportDir}/raft` };

writeFileSync(readyFile, "ready");
while (!existsSync(goFile)) await delay(2); // barrier: released together with the sibling

try {
  const tok = await forceRefreshAgentToken(a, { now: Number(now) });
  process.stdout.write(String(tok ?? "null"));
} catch (e) {
  process.stdout.write("ERR:" + (e instanceof Error ? e.message : String(e)));
}
