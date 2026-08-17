/**
 * Agent CLI login flow (RFC 057, CP3): the non-interactive `hands login` used inside
 * a managed Raft agent. No browser, no paste.
 *
 *   1. Generate a PKCE code_verifier locally; send only its S256 challenge to Raft.
 *   2. `raft integration invoke --service <key> --action agent-login --json` → a
 *      one-time grant, STRICTLY validated (the CP3 acceptance tooth: outer success +
 *      exact service/action + grant result schema — never trust a loose envelope).
 *   3. Exchange { grant, code_verifier } at the Hands PUBLIC exchange endpoint for a
 *      raft-cli-agent-session.v1 (short access token + rotating refresh).
 *   4. Atomically persist the session under $SLOCK_HOME (0600 file / 0700 dirs).
 *
 * The verifier never reaches Raft, logs, or the store. Only the Hands token is stored.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { apiRequest } from "./api.js";
import { agentAuthPath, HANDS_SERVICE, type AgentEnv } from "./agent_env.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE S256: a 64-byte verifier → 86 unreserved base64url chars (within RFC 7636's
 *  43–128), and its SHA-256 challenge as unpadded base64url. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Strictly validate a `raft integration invoke --action agent-login --json` result.
 * Real envelope (verified against the live daemon):
 *   { ok:true, data:{ service, action, status, result:{ schema, service, grant, expires_at } } }
 * Anything not matching exactly is rejected — the CLI never relies on the manifest for
 * output enforcement (Volta's CP3 acceptance tooth).
 */
export function parseAgentLoginInvoke(
  stdout: string,
  service: string,
): { grant: string; expires_at: string } {
  let outer: any;
  try {
    outer = JSON.parse(stdout);
  } catch {
    throw new Error("agent-login: `raft integration invoke` did not return JSON");
  }
  if (!outer || outer.ok !== true) {
    const err = outer && typeof outer.error === "string" ? outer.error : stdout.slice(0, 200);
    throw new Error(`agent-login: invoke did not succeed: ${err}`);
  }
  const data = outer.data;
  if (!data || data.service !== service) {
    throw new Error(`agent-login: service mismatch (got ${data?.service}, want ${service})`);
  }
  if (data.action !== "agent-login") {
    throw new Error(`agent-login: action mismatch (got ${data?.action})`);
  }
  if (data.status !== 200) {
    throw new Error(`agent-login: action returned HTTP ${data?.status}`);
  }
  const result = data.result;
  if (!result || result.schema !== "raft-cli-agent-login-grant.v1") {
    throw new Error("agent-login: unexpected grant result schema");
  }
  if (result.service !== service) {
    throw new Error(`agent-login: grant service mismatch (got ${result.service}, want ${service})`);
  }
  if (typeof result.grant !== "string" || result.grant.length === 0) {
    throw new Error("agent-login: grant missing from result");
  }
  if (typeof result.expires_at !== "string" || result.expires_at.length === 0) {
    throw new Error("agent-login: grant expires_at missing from result");
  }
  return { grant: result.grant, expires_at: result.expires_at };
}

export interface AgentSession {
  schema: "raft-cli-agent-session.v1";
  token_type: "Bearer";
  access_token: string;
  access_expires_at: string; // RFC3339
  refresh_token: string;
  refresh_expires_at: string | null; // RFC3339 | null
}

/** Strictly validate the exchange/refresh success body (raft-cli-agent-session.v1). */
export function parseAgentSession(body: any): AgentSession {
  if (!body || body.schema !== "raft-cli-agent-session.v1") {
    throw new Error("agent-login: unexpected session schema from exchange");
  }
  if (body.token_type !== "Bearer") {
    throw new Error("agent-login: unexpected token_type from exchange");
  }
  for (const k of ["access_token", "access_expires_at", "refresh_token"] as const) {
    if (typeof body[k] !== "string" || body[k].length === 0) {
      throw new Error(`agent-login: session missing ${k}`);
    }
  }
  if (body.refresh_expires_at !== null && typeof body.refresh_expires_at !== "string") {
    throw new Error("agent-login: session refresh_expires_at must be a string or null");
  }
  return body as AgentSession;
}

/** Stored record = the session.v1 fields + service slug + updated_at (no Raft creds). */
export interface StoredAgentAuth extends AgentSession {
  service: string;
  updated_at: string;
}

/** Atomic write (temp file + rename); 0600 file, 0700 dirs — per RFC 057 store rules. */
export function writeAgentSession(
  a: AgentEnv,
  service: string,
  session: AgentSession,
  now: () => string = () => new Date().toISOString(),
): string {
  const path = agentAuthPath(a, service);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record: StoredAgentAuth = { ...session, service, updated_at: now() };
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  return path;
}

export interface AgentLoginOptions {
  raftBin?: string; // default "raft" (the daemon-injected wrapper on PATH)
  service?: string; // default HANDS_SERVICE (exact installed client key)
  /** Injectable invoke runner for tests (defaults to spawning `raft`). */
  invoke?: (args: string[]) => { status: number | null; stdout: string; stderr: string };
}

function defaultInvoke(raftBin: string, args: string[]) {
  const res = spawnSync(raftBin, args, { encoding: "utf8" });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
  };
}

/**
 * Full agent-login flow: invoke → strict-validate grant → exchange → strict-validate
 * session → atomic store. Returns the stored session on success.
 */
export async function runAgentLogin(a: AgentEnv, opts: AgentLoginOptions = {}): Promise<AgentSession> {
  const service = opts.service ?? HANDS_SERVICE;
  const { verifier, challenge } = generatePkce();
  const args = [
    "integration", "invoke",
    "--service", service,
    "--action", "agent-login",
    "--json",
    "--data-json", JSON.stringify({
      schema: "raft-cli-agent-login-request.v1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  ];
  const runner = opts.invoke ?? ((a2: string[]) => defaultInvoke(opts.raftBin ?? "raft", a2));
  const res = runner(args);
  if (!res.stdout) {
    throw new Error(`agent-login: raft invoke produced no output (${res.stderr || `exit ${res.status}`})`);
  }
  const { grant } = parseAgentLoginInvoke(res.stdout, service);

  // Exchange at the Hands PUBLIC endpoint (no prior Hands session required).
  const body = await apiRequest("/api/auth/agent/exchange", {
    method: "POST",
    body: { schema: "raft-cli-agent-login-exchange.v1", grant, code_verifier: verifier },
  });
  const session = parseAgentSession(body);
  writeAgentSession(a, service, session);
  return session;
}
