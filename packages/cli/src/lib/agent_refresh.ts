/**
 * Agent token auto-refresh + cross-process single-flight (RFC 057, CP3 checkpoint-2).
 *
 * The agent access token is short-lived; a long-lived rotating refresh token in the
 * store renews it. This module:
 *   - refreshes PROACTIVELY when the access token is within a skew window of expiry,
 *     and REACTIVELY once after a 401 (driven by api.ts);
 *   - serializes refresh across concurrent `hands` processes sharing one $SLOCK_HOME
 *     via an O_EXCL lock. A concurrent loser re-reads the store and returns ONLY the
 *     strictly-newer session the winner persisted (detected by a changed refresh
 *     token vs the token it started with); it NEVER rotates in parallel and never
 *     hands back the same token it came in with (a double-rotate would trip the
 *     server's refresh-reuse detection and chain-revoke the family — locking the
 *     agent out; re-handing the just-401'd token would simply 401 again).
 *
 * Lock safety without a heartbeat: the refresh fetch is hard-aborted at a deadline
 * strictly smaller than the stale-lock lease, so a live holder always releases before
 * its lock can be considered stale. Breaking a lock older than the lease is therefore
 * provably safe, and release only ever deletes a lock that still carries our own owner
 * id (never a foreign holder's).
 *
 * It does its own fetch (not the api client) to avoid an import cycle, and never
 * echoes response bodies in errors.
 */
import {
  openSync, closeSync, writeSync, readFileSync, existsSync, unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  agentAuthPath, HANDS_SERVICE, type AgentEnv,
} from "./agent_env.js";
import {
  parseAgentSession, writeAgentSession, readBoundedText,
  type AgentSession, type StoredAgentAuth,
} from "./agent_auth.js";

// Refresh when the access token expires within this window (or is already expired).
export const REFRESH_SKEW_MS = 60_000;
// The whole refresh op (fetch + bounded body read + parse + persist) is aborted at this
// deadline, so a live holder cannot hold the lock indefinitely. Breaking a lock is NOT
// time-based, though: a lock is broken only when its owner process is provably dead.
const REFRESH_DEADLINE_MS = 20_000;
const LOCK_WAIT_MS = 25_000; // how long a loser waits for the winner's strictly-newer session
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

function accessExpired(store: StoredAgentAuth, now: number): boolean {
  const exp = Date.parse(store.access_expires_at);
  return !Number.isFinite(exp) || exp <= now;
}

function lockPath(a: AgentEnv, service: string): string {
  return join(dirname(agentAuthPath(a, service)), ".auth.refresh.lock");
}

/**
 * POST the refresh token, validate the session, atomically persist it. Own fetch,
 * hard-aborted at REFRESH_DEADLINE_MS so the holder always releases before its lock
 * can be seen as stale. Never echoes the response body.
 */
async function rotate(
  a: AgentEnv,
  service: string,
  store: StoredAgentAuth,
  now: number,
  fetchImpl: typeof fetch,
): Promise<AgentSession> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_DEADLINE_MS);
  try {
    const res = await fetchImpl(new URL("/api/auth/agent/refresh", store.api_base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ schema: "raft-cli-agent-refresh.v1", refresh_token: store.refresh_token }),
      signal: controller.signal,
      // Never follow a redirect: a 307/308 would forward the refresh_token body to the target.
      redirect: "manual",
    });
    if (!res.ok) {
      // Stable reason only; never echo the body. `manual` leaves a 3xx as a non-ok status.
      throw new Error(`agent-login: token refresh failed (HTTP ${res.status})`);
    }
    const text = await readBoundedText(res, controller);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("agent-login: refresh response was not JSON");
    }
    const session = parseAgentSession(body, now);
    writeAgentSession(a, service, session, store.api_base, () => new Date(now).toISOString());
    return session;
  } finally {
    // Deadline stays armed across fetch + bounded read + parse + persist.
    clearTimeout(timer);
  }
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

  return singleFlightRefresh(a, service, store, now, fetchImpl, sleepImpl, /*force*/ false);
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
  const store = readStore(a, service);
  if (!store) return null;
  return singleFlightRefresh(a, service, store, now, fetchImpl, sleepImpl, /*force*/ true);
}

async function singleFlightRefresh(
  a: AgentEnv,
  service: string,
  baseline: StoredAgentAuth,
  now: number,
  fetchImpl: typeof fetch,
  sleepImpl: (ms: number) => Promise<void>,
  force: boolean,
): Promise<string | null> {
  const lock = lockPath(a, service);
  const ownerId = `${process.pid}:${randomBytes(12).toString("hex")}`;

  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, "wx"); // O_CREAT | O_EXCL | O_WRONLY
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      // Break the lock ONLY if its owner process is provably dead (never on elapsed time
      // alone: a suspended / stalled live holder keeps its pid). Uncertain → fail closed.
      if (breakIfDeadOwner(lock)) continue;
      // A live process holds it: wait for its strictly-newer session (loser path).
      return waitForNewerSession(a, service, baseline, now, force, sleepImpl);
    }
    // Winner: stamp ownership so release can prove the lock is still ours, then refresh.
    try {
      writeSync(fd, ownerId);
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try {
      const fresh = readStore(a, service);
      if (!fresh) return null;
      // A prior holder may have refreshed while we blocked; only rotate if still needed.
      if (!force && !accessExpiresWithinSkew(fresh, now)) return fresh.access_token;
      const session = await rotate(a, service, fresh, now, fetchImpl);
      return session.access_token;
    } finally {
      releaseOwnLock(lock, ownerId);
    }
  }
}

/** Delete the lock only if it still carries OUR owner id (never a foreign holder's). */
export function releaseOwnLock(lock: string, ownerId: string): void {
  try {
    if (readFileSync(lock, "utf8") === ownerId) unlinkSync(lock);
  } catch {
    // already gone, unreadable, or replaced by another owner — leave it be.
  }
}

/**
 * Break the lock ONLY if its owner process is provably dead, with a stable-owner compare
 * to avoid a TOCTOU delete of a replacement owner. A LIVE owner — including one that is
 * suspended / stalled (its pid still exists) — is NEVER broken. An unparseable owner or
 * any uncertainty fails closed (do not break; the caller waits as a loser). Returns true
 * iff the lock was broken (or had vanished) and the caller should retry acquiring it.
 * `readOwner` is injectable for tests.
 */
export function breakIfDeadOwner(
  lock: string,
  readOwner: () => string = () => readFileSync(lock, "utf8"),
): boolean {
  let owner: string;
  try {
    owner = readOwner();
  } catch {
    return true; // vanished between EEXIST and read → retry acquire
  }
  const pid = ownerPid(owner);
  if (pid === null || ownerAlive(pid)) return false; // uncertain or live → never steal
  // Dead owner: confirm it has not been replaced under us before unlinking (TOCTOU guard).
  let current: string;
  try {
    current = readOwner();
  } catch {
    return true; // vanished → retry acquire
  }
  if (current !== owner) return false; // replaced by a new owner → let it run
  try {
    unlinkSync(lock);
  } catch { /* already gone/replaced — fine */ }
  return true;
}

function ownerPid(owner: string): number | null {
  const m = /^(\d+):/.exec(owner);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: liveness probe, delivers nothing
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ESRCH") return false; // no such process → dead
    return true; // EPERM (exists) or anything unexpected → fail closed = treat as alive
  }
}

/**
 * Loser path: poll the store for the winner's strictly-newer session, identified by a
 * refresh token that differs from the one we started with (`baseline`). Never rotates
 * here (that would double-use the refresh token). On timeout it FAILS rather than hand
 * back the token we came in with; a proactive caller may still use a genuinely-unexpired
 * current token, but a forced (post-401) caller always fails — re-handing a 401'd token
 * would just 401 again.
 */
async function waitForNewerSession(
  a: AgentEnv,
  service: string,
  baseline: StoredAgentAuth,
  now: number,
  force: boolean,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<string | null> {
  // Bound the wait by poll count (not wall-clock) so it is deterministic under an
  // injected sleep in tests, while keeping the same real-time budget in production.
  const maxPolls = Math.ceil(LOCK_WAIT_MS / LOCK_POLL_MS);
  for (let i = 0; i < maxPolls; i += 1) {
    await sleepImpl(LOCK_POLL_MS);
    const cur = readStore(a, service);
    if (cur && cur.refresh_token !== baseline.refresh_token) {
      return cur.access_token; // the winner rotated: a strictly-newer session is persisted
    }
  }
  const cur = readStore(a, service);
  if (!force && cur && !accessExpired(cur, now)) return cur.access_token;
  throw new Error("agent-login: timed out waiting for a concurrent token refresh");
}
