/**
 * Agent token auto-refresh + cross-process single-flight (RFC 057, CP3 checkpoint-2).
 *
 * The agent access token is short-lived; a long-lived rotating refresh token in the
 * store renews it. This module:
 *   - refreshes PROACTIVELY when the access token is within a skew window of expiry,
 *     and REACTIVELY once after a 401 (driven by api.ts);
 *   - serializes refresh across concurrent `hands` processes sharing one $SLOCK_HOME
 *     via an O_EXCL lock. A concurrent loser re-reads the store and uses the strictly
 *     newer persisted session; it NEVER rotates in parallel or overwrites a newer
 *     session with an older result (a double-rotate would trip the server's
 *     refresh-reuse detection and chain-revoke the family — locking the agent out).
 *
 * It does its own fetch (not the api client) to avoid an import cycle, and never
 * echoes response bodies in errors.
 */
import {
  openSync, closeSync, readFileSync, existsSync, statSync, unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  agentAuthPath, HANDS_SERVICE, type AgentEnv,
} from "./agent_env.js";
import {
  parseAgentSession, writeAgentSession, type AgentSession, type StoredAgentAuth,
} from "./agent_auth.js";

// Refresh when the access token expires within this window (or is already expired).
export const REFRESH_SKEW_MS = 60_000;
const LOCK_STALE_MS = 30_000; // break a lock held longer than this (crashed holder)
const LOCK_WAIT_MS = 5_000; // how long a loser waits for the winner's new session
const LOCK_POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function readStore(a: AgentEnv, service: string): StoredAgentAuth | null {
  let path: string;
  try {
    path = agentAuthPath(a, service);
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredAgentAuth;
  } catch {
    return null;
  }
}

function accessExpiresWithinSkew(store: StoredAgentAuth, now: number): boolean {
  const exp = Date.parse(store.access_expires_at);
  return !Number.isFinite(exp) || exp - now <= REFRESH_SKEW_MS;
}

function lockPath(a: AgentEnv, service: string): string {
  return join(dirname(agentAuthPath(a, service)), ".auth.refresh.lock");
}

/** POST the refresh token, validate the session, atomically persist it. Own fetch. */
async function rotate(
  a: AgentEnv,
  service: string,
  store: StoredAgentAuth,
  now: number,
  fetchImpl: typeof fetch,
): Promise<AgentSession> {
  const res = await fetchImpl(new URL("/api/auth/agent/refresh", store.api_base).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ schema: "raft-cli-agent-refresh.v1", refresh_token: store.refresh_token }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Stable reason only; never echo the response body.
    throw new Error(`agent-login: token refresh failed (HTTP ${res.status})`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("agent-login: refresh response was not JSON");
  }
  const session = parseAgentSession(body);
  writeAgentSession(a, service, session, store.api_base, () => new Date(now).toISOString());
  return session;
}

export interface RefreshOptions {
  service?: string;
  now?: number;
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests (defaults to real setTimeout). */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Return a valid access token, refreshing (single-flight) if it is within the skew
 * window. Returns null if there is no stored session (caller must `hands login`).
 */
export async function getFreshAgentAccessToken(a: AgentEnv, opts: RefreshOptions = {}): Promise<string | null> {
  const service = opts.service ?? HANDS_SERVICE;
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? sleep;

  const store = readStore(a, service);
  if (!store) return null;
  if (!accessExpiresWithinSkew(store, now)) return store.access_token; // still fresh

  return singleFlightRefresh(a, service, now, fetchImpl, sleepImpl);
}

/**
 * Force one refresh (used on a 401 even if the token looked unexpired), single-flight.
 * Returns null if there is no stored session.
 */
export async function forceRefreshAgentToken(a: AgentEnv, opts: RefreshOptions = {}): Promise<string | null> {
  const service = opts.service ?? HANDS_SERVICE;
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? sleep;
  if (!readStore(a, service)) return null;
  return singleFlightRefresh(a, service, now, fetchImpl, sleepImpl, /*force*/ true);
}

async function singleFlightRefresh(
  a: AgentEnv,
  service: string,
  now: number,
  fetchImpl: typeof fetch,
  sleepImpl: (ms: number) => Promise<void>,
  force = false,
): Promise<string | null> {
  const lock = lockPath(a, service);

  // Try to acquire the exclusive lock (breaking a stale one from a crashed holder).
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx"); // O_CREAT | O_EXCL | O_WRONLY
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      let broke = false;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lock);
          broke = true;
        }
      } catch {
        broke = true; // lock vanished under us; retry acquire
      }
      if (broke) continue;
      // Another live process holds it: wait for its strictly-newer session (loser path).
      return waitForNewerSession(a, service, now, sleepImpl);
    }
    // Winner: re-read (a prior holder may have just refreshed while we blocked), then
    // refresh only if still needed.
    try {
      const fresh = readStore(a, service);
      if (!fresh) return null;
      if (!force && !accessExpiresWithinSkew(fresh, now)) return fresh.access_token;
      const session = await rotate(a, service, fresh, now, fetchImpl);
      return session.access_token;
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(lock); } catch { /* ignore */ }
    }
  }
}

/**
 * Loser path: poll the store for a strictly-newer (fresh) session written by the
 * winner. Never rotates here (that would double-use the refresh token). On timeout,
 * return the current access token as-is (a subsequent 401 is handled by the caller);
 * we never overwrite the store with an older result.
 */
async function waitForNewerSession(
  a: AgentEnv,
  service: string,
  now: number,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<string | null> {
  const started = Date.now();
  for (;;) {
    await sleepImpl(LOCK_POLL_MS);
    const cur = readStore(a, service);
    if (cur && !accessExpiresWithinSkew(cur, now)) return cur.access_token; // winner wrote a fresh one
    if (Date.now() - started >= LOCK_WAIT_MS) {
      return cur?.access_token ?? null; // give up waiting; do NOT rotate/overwrite
    }
  }
}
