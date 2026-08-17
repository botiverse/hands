/**
 * Agent CLI login flow (RFC 057, CP3): the non-interactive `hands login` used inside
 * a managed Raft agent. No browser, no paste.
 *
 *   1. Generate a PKCE code_verifier locally; send only its S256 challenge to Raft.
 *   2. Run the EXACT wrapper `$SLOCK_CLI_TRANSPORT_DIR/raft integration invoke
 *      --action agent-login --json` (never PATH `raft`); require exit 0; STRICTLY
 *      validate the result (outer success + exact service/action/status + closed grant
 *      result schema + RFC3339/future/<=300s expiry). Errors carry only stable reasons
 *      — never the raw stdout/stderr/body (which could contain grant/action payload).
 *   3. Exchange { grant, code_verifier } at the Hands PUBLIC endpoint for a
 *      raft-cli-agent-session.v1; strictly validate it (closed keys + RFC3339 expiries).
 *   4. Atomically persist under $SLOCK_HOME (O_EXCL temp + fsync + rename; 0600 file /
 *      verified-0700 dirs), recording the api base so the resolver never needs config.
 *
 * The verifier never reaches Raft, logs, or the store. Only the Hands token is stored.
 */
import { spawnSync } from "node:child_process";
import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync,
  mkdirSync, statSync, chmodSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { apiRequest, getApiBase } from "./api.js";
import { agentAuthPath, HANDS_SERVICE, type AgentEnv } from "./agent_env.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE S256: 64-byte verifier → 86 unreserved base64url chars (within RFC 7636's
 *  43–128), challenge = unpadded base64url SHA-256. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(o, key));
}

/** Parse an RFC3339 date-time to epoch ms, or null. Rejects bare dates / bad offsets. */
function parseRfc3339(s: unknown): number | null {
  if (typeof s !== "string") return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Strictly validate a `raft integration invoke --action agent-login --json` result.
 * Real envelope (verified against the live daemon):
 *   { ok:true, data:{ service, action, status, result:{schema,service,grant,expires_at} } }
 * The Hands-owned `result` is closed-key validated; the Raft envelope (outer/data) is
 * validated by exact required values. NO part of stdout is ever echoed in an error.
 */
export function parseAgentLoginInvoke(
  stdout: string,
  service: string,
  now: number,
): { grant: string; expires_at: string } {
  let outer: any;
  try {
    outer = JSON.parse(stdout);
  } catch {
    throw new Error("agent-login: `raft integration invoke` did not return JSON");
  }
  if (!outer || typeof outer !== "object") throw new Error("agent-login: invoke output is not an object");
  if (outer.ok !== true) throw new Error("agent-login: invoke did not succeed");
  const data = outer.data;
  if (!data || typeof data !== "object") throw new Error("agent-login: invoke result is missing data");
  if (data.service !== service) throw new Error("agent-login: invoke service does not match the requested service");
  if (data.action !== "agent-login") throw new Error("agent-login: invoke action is not agent-login");
  if (data.status !== 200) throw new Error("agent-login: agent-login action did not return HTTP 200");
  const result = data.result;
  if (!result || typeof result !== "object") throw new Error("agent-login: invoke result is missing the grant body");
  if (!hasExactKeys(result, ["schema", "service", "grant", "expires_at"])) {
    throw new Error("agent-login: grant result has unexpected fields");
  }
  if (result.schema !== "raft-cli-agent-login-grant.v1") throw new Error("agent-login: unexpected grant result schema");
  if (result.service !== service) throw new Error("agent-login: grant result service mismatch");
  if (typeof result.grant !== "string" || result.grant.length === 0) throw new Error("agent-login: grant is missing");
  const exp = parseRfc3339(result.expires_at);
  if (exp === null) throw new Error("agent-login: grant expires_at is not an RFC3339 timestamp");
  if (exp <= now) throw new Error("agent-login: grant is already expired");
  if (exp > now + 300_000) throw new Error("agent-login: grant expiry exceeds the 300s ceiling");
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

/** Strictly validate the exchange/refresh success body (closed keys + RFC3339). */
export function parseAgentSession(body: any): AgentSession {
  if (!body || typeof body !== "object") throw new Error("agent-login: exchange response is not an object");
  if (!hasExactKeys(body, ["schema", "token_type", "access_token", "access_expires_at", "refresh_token", "refresh_expires_at"])) {
    throw new Error("agent-login: session has unexpected fields");
  }
  if (body.schema !== "raft-cli-agent-session.v1") throw new Error("agent-login: unexpected session schema");
  if (body.token_type !== "Bearer") throw new Error("agent-login: unexpected token_type");
  for (const k of ["access_token", "refresh_token"] as const) {
    if (typeof body[k] !== "string" || body[k].length === 0) throw new Error(`agent-login: session missing ${k}`);
  }
  if (parseRfc3339(body.access_expires_at) === null) throw new Error("agent-login: session access_expires_at is not RFC3339");
  if (body.refresh_expires_at !== null && parseRfc3339(body.refresh_expires_at) === null) {
    throw new Error("agent-login: session refresh_expires_at must be RFC3339 or null");
  }
  return body as AgentSession;
}

export interface StoredAgentAuth extends AgentSession {
  service: string;
  api_base: string;
  updated_at: string;
}

/** mkdir (if needed) + verify/repair 0700 (no group/other) on one path component. */
function ensureSecureDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error("agent-login: store path component is not a directory");
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700); // repair a pre-existing wide dir
}

/**
 * Atomic, hardened store write: O_EXCL unique temp in the same dir, 0600, write +
 * fsync + close, atomic rename. Each dir component under $SLOCK_HOME is ensured AND
 * verified 0700 (repairing a pre-existing wide dir). $SLOCK_HOME itself is not chmod'd.
 * On any failure the temp is removed and the previous file is left intact.
 */
export function writeAgentSession(
  a: AgentEnv,
  service: string,
  session: AgentSession,
  apiBase: string,
  now: () => string = () => new Date().toISOString(),
): string {
  const path = agentAuthPath(a, service); // validates slug + agent id + containment
  let dir = a.slockHome;
  for (const seg of ["agents", a.agentId, "integrations", service]) {
    dir = join(dir, seg);
    ensureSecureDir(dir);
  }
  const record: StoredAgentAuth = { ...session, service, api_base: apiBase, updated_at: now() };
  const payload = JSON.stringify(record, null, 2) + "\n";
  const tmp = join(dir, `.auth.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600); // 'wx' = O_CREAT|O_EXCL|O_WRONLY
    writeSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e; // previous auth.json (if any) is left intact
  }
  return path;
}

export interface AgentLoginOptions {
  service?: string; // default HANDS_SERVICE (compiled-fixed exact client key)
  now?: number; // injectable clock (ms) for tests
  /** Injectable invoke runner for tests; defaults to spawning the pinned wrapper. */
  invoke?: (args: string[]) => { status: number | null; stdout: string; stderr: string };
}

function defaultInvoke(raftBin: string, args: string[]) {
  const res = spawnSync(raftBin, args, { encoding: "utf8" });
  return {
    status: res.error ? null : res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/**
 * Full agent-login flow: invoke the pinned wrapper → strict-validate grant → exchange
 * → strict-validate session → atomic store. Returns the stored session on success.
 */
export async function runAgentLogin(a: AgentEnv, opts: AgentLoginOptions = {}): Promise<AgentSession> {
  const service = opts.service ?? HANDS_SERVICE;
  const now = opts.now ?? Date.now();
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
  const runner = opts.invoke ?? ((a2: string[]) => defaultInvoke(a.raftBin, a2));
  const res = runner(args);
  if (res.status !== 0) {
    // Require a clean exit; never echo stdout/stderr (may carry grant/action payload).
    throw new Error(`agent-login: raft invoke exited with a non-zero status (${res.status ?? "spawn error"})`);
  }
  const { grant } = parseAgentLoginInvoke(res.stdout, service, now);

  const apiBase = getApiBase();
  const body = await apiRequest("/api/auth/agent/exchange", {
    method: "POST",
    body: { schema: "raft-cli-agent-login-exchange.v1", grant, code_verifier: verifier },
  });
  const session = parseAgentSession(body);
  writeAgentSession(a, service, session, apiBase);
  return session;
}
