import {
  openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync,
  mkdirSync, statSync, chmodSync, existsSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentEnv } from "./admit.js";
import { agentAuthPath } from "./path.js";

export interface AgentSession {
  schema: "raft-cli-agent-session.v1";
  token_type: "Bearer";
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string | null;
}

export interface StoredAgentAuth extends AgentSession {
  service: string;
  api_base: string;
  updated_at: string;
}

function ensureSecureDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error("agent-session-store: store path component is not a directory");
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * Atomic store write: O_EXCL unique temp in the same dir, 0600, write + fsync +
 * close, atomic rename. Each dir component under $SLOCK_HOME is ensured AND
 * verified 0700. $SLOCK_HOME itself is not chmod'd. On any failure the temp is
 * removed and the previous file is left intact.
 */
export function writeAgentSession(
  a: AgentEnv,
  service: string,
  session: AgentSession,
  apiBase: string,
  now: () => string = () => new Date().toISOString(),
): string {
  const path = agentAuthPath(a, service);
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
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  return path;
}

/**
 * The whole stored record, or null when there is no readable, well-formed session.
 * Consumers that refresh need `refresh_token`, `access_expires_at` and `api_base`
 * together; without this both adopter CLIs re-read the JSON file themselves.
 * Same fail-soft contract as the narrow readers: any error → null, never throws.
 */
export function readAgentSession(a: AgentEnv, service: string): StoredAgentAuth | null {
  let path: string;
  try {
    path = agentAuthPath(a, service);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAgentAuth>;
    if (
      parsed?.schema !== "raft-cli-agent-session.v1" || parsed.token_type !== "Bearer" ||
      typeof parsed.access_token !== "string" || parsed.access_token.length === 0 ||
      typeof parsed.refresh_token !== "string" || parsed.refresh_token.length === 0 ||
      typeof parsed.access_expires_at !== "string" ||
      !(typeof parsed.refresh_expires_at === "string" || parsed.refresh_expires_at === null) ||
      typeof parsed.service !== "string" || typeof parsed.api_base !== "string" || typeof parsed.updated_at !== "string"
    ) {
      return null;
    }
    return parsed as StoredAgentAuth;
  } catch {
    return null;
  }
}

export function readAgentAccessToken(a: AgentEnv, service: string): string | null {
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

export function readAgentApiBase(a: AgentEnv, service: string): string | null {
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
