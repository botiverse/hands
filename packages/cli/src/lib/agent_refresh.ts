/**
 * Agent token auto-refresh + cross-process single-flight (RFC 057, CP3 checkpoint-2).
 *
 * The agent access token is short-lived; a long-lived rotating refresh token in the
 * store renews it. This module:
 *   - refreshes PROACTIVELY when the access token is within a skew window of expiry,
 *     and REACTIVELY once after a 401 (driven by api.ts);
 *   - serializes refresh across concurrent `hands` processes sharing one $SLOCK_HOME
 *     via an O_EXCL lock. A concurrent loser re-reads the store and returns ONLY the
 *     strictly-newer session the winner persisted (a changed refresh token vs the one
 *     it started with); it NEVER rotates in parallel and never re-hands the token it
 *     came in with (a double-rotate trips the server's refresh-reuse detection and
 *     chain-revokes the family; re-handing a just-401'd token would 401 again).
 *
 * Lock safety:
 *   - the refresh op (fetch + bounded body read + parse + persist) is hard-aborted at a
 *     deadline, so a live holder cannot hold the lock forever;
 *   - a lock is broken ONLY when its owner process is provably DEAD (`process.kill(pid,0)`
 *     → ESRCH) — never on elapsed time, so a suspended / stalled but live holder is never
 *     stolen;
 *   - dead-lock recovery is serialized by an exclusive reaper fence and the main lock is
 *     re-acquired WHILE the fence is held, so two concurrent recoverers can never both
 *     reap-and-rebuild (→ never double-rotate);
 *   - any uncertainty (unparseable owner, non-ENOENT read error, contended/live fence)
 *     fails closed: the caller becomes a loser rather than risk an unsafe break.
 *
 * It does its own fetch (not the api client) to avoid an import cycle, and never echoes
 * response bodies in errors.
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
// The whole refresh op (fetch + bounded read + parse + persist) is aborted at this
// deadline. Breaking a lock is NOT time-based, though — only a provably-dead owner is.
const REFRESH_DEADLINE_MS = 20_000;
const LOCK_WAIT_MS = 25_000; // how long a loser waits for the winner's strictly-newer session
const LOCK_POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function newOwnerId(): string {
  return `${process.pid}:${randomBytes(12).toString("hex")}`;
}

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
 * hard-aborted at `deadlineMs` across the WHOLE operation (fetch + bounded body read +
 * parse + persist), never following a redirect (a 307/308 would forward the refresh
 * token), and never echoing the body.
 */
async function rotate(
  a: AgentEnv,
  service: string,
  store: StoredAgentAuth,
  now: number,
  fetchImpl: typeof fetch,
  deadlineMs: number,
): Promise<AgentSession> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const res = await fetchImpl(new URL("/api/auth/agent/refresh", store.api_base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ schema: "raft-cli-agent-refresh.v1", refresh_token: store.refresh_token }),
      signal: controller.signal,
      redirect: "manual",
    });
    if (!res.ok) {
      // `manual` leaves a 3xx as a non-ok status. Stable reason only; never echo the body.
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
  /** Injectable refresh deadline for tests (defaults to REFRESH_DEADLINE_MS). */
  deadlineMs?: number;
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
  const deadlineMs = opts.deadlineMs ?? REFRESH_DEADLINE_MS;

  const store = readStore(a, service);
  if (!store) return null;
  if (!accessExpiresWithinSkew(store, now)) return store.access_token; // still fresh

  return singleFlightRefresh(a, service, store, now, fetchImpl, sleepImpl, /*force*/ false, deadlineMs);
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
  const deadlineMs = opts.deadlineMs ?? REFRESH_DEADLINE_MS;
  const store = readStore(a, service);
  if (!store) return null;
  return singleFlightRefresh(a, service, store, now, fetchImpl, sleepImpl, /*force*/ true, deadlineMs);
}

async function singleFlightRefresh(
  a: AgentEnv,
  service: string,
  baseline: StoredAgentAuth,
  now: number,
  fetchImpl: typeof fetch,
  sleepImpl: (ms: number) => Promise<void>,
  force: boolean,
  deadlineMs: number,
): Promise<string | null> {
  const lock = lockPath(a, service);
  const ownerId = newOwnerId();

  let acquired: boolean;
  try {
    const fd = openSync(lock, "wx"); // fast path: no lock present
    try { writeSync(fd, ownerId); } finally { try { closeSync(fd); } catch { /* ignore */ } }
    acquired = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    // A lock exists: recover it only if its owner is provably dead, under an exclusive
    // fence, re-acquiring the main lock while the fence is held. Anything else → loser.
    acquired = acquireIfDeadOwner(lock, ownerId);
    if (!acquired) return waitForNewerSession(a, service, baseline, now, force, sleepImpl);
  }

  // Winner: we hold `lock` carrying ownerId.
  try {
    const fresh = readStore(a, service);
    if (!fresh) return null;
    // A prior holder may have refreshed while we blocked; only rotate if still needed.
    if (!force && !accessExpiresWithinSkew(fresh, now)) return fresh.access_token;
    const session = await rotate(a, service, fresh, now, fetchImpl, deadlineMs);
    return session.access_token;
  } finally {
    releaseOwnLock(lock, ownerId);
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
 * Recover a lock whose owner process is provably dead and acquire it, serialized by an
 * exclusive reaper fence. Judge-dead → unlink → re-acquire all happen WHILE the fence is
 * held, so at most one recoverer reaps-and-rebuilds — two concurrent recoverers can never
 * both re-acquire (→ never double-rotate). A LIVE owner (incl. suspended/stalled — pid
 * still exists) is never touched. Any uncertainty fails closed. Returns true iff WE now
 * hold the main lock carrying `ownerId`; false → the caller is a loser.
 */
export function acquireIfDeadOwner(lock: string, ownerId: string): boolean {
  const ffd = acquireReaperFence(`${lock}.reap`);
  if (ffd === null) return false; // live/contended/uncertain fence → loser
  try {
    let owner = "";
    try {
      owner = readFileSync(lock, "utf8");
    } catch (e) {
      // Only "already gone" is safe to proceed on; any other error is uncertain → loser.
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
    }
    if (owner) {
      const pid = ownerPid(owner);
      if (pid === null || ownerAlive(pid)) return false; // live / uncertain owner → loser
      try { unlinkSync(lock); } catch { /* vanished / already handled */ }
    }
    // Re-acquire the main lock while STILL holding the fence, so no other recoverer can
    // rebuild it underneath us.
    let fd: number;
    try {
      fd = openSync(lock, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false; // lost the race → loser
      throw e;
    }
    try { writeSync(fd, ownerId); } finally { try { closeSync(fd); } catch { /* ignore */ } }
    return true;
  } finally {
    try { closeSync(ffd); } catch { /* ignore */ }
    try { unlinkSync(`${lock}.reap`); } catch { /* ignore */ }
  }
}

/**
 * Acquire the exclusive reaper fence via a single O_EXCL create. On EEXIST — a reaper is
 * active, OR one crashed and left the fence — we ALWAYS fail closed (return null → loser).
 * We deliberately do NOT auto-recover a leftover fence: reading its pid and unlinking it
 * would recurse the very reap race the fence exists to prevent (two recoverers both unlink
 * + recreate, then each deletes the other's live fence). A crashed reaper — the fence is
 * held only across synchronous fs calls, never I/O — leaves a diagnosable fence for manual
 * cleanup, the agreed "prefer fail-closed on reaper residue" over a second grabbable lock.
 * Kernel O_EXCL is the sole mutual exclusion; nothing here reads-pid-then-unlinks.
 */
function acquireReaperFence(fence: string): number | null {
  try {
    const fd = openSync(fence, "wx");
    try { writeSync(fd, newOwnerId()); } catch { /* diagnostic marker only; ignore */ }
    return fd;
  } catch {
    return null; // EEXIST or any error → fail closed (loser); never recover a leftover fence
  }
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
 * here. On timeout it FAILS rather than hand back the token we came in with; a proactive
 * caller may still use a genuinely-unexpired current token, but a forced (post-401)
 * caller always fails — re-handing a 401'd token would just 401 again.
 */
async function waitForNewerSession(
  a: AgentEnv,
  service: string,
  baseline: StoredAgentAuth,
  now: number,
  force: boolean,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<string | null> {
  // Bound by poll count (not wall-clock) so it is deterministic under an injected sleep in
  // tests, while keeping the same real-time budget in production.
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
