/**
 * A signed-in person's current role on a Raft server, read live from Raft
 * (RFC 079 §8.2: roles and membership come from Raft, cached at most 60 s,
 * never from login claims).
 *
 * A Hands session lasts 14 days and the organizations it can switch into
 * were joined at earlier logins. Without this read, someone removed from a
 * Raft server (or made a guest there) keeps that server's Hands organization
 * until the session ends, and in account-mode login, where one login covers
 * every server, indefinitely through the organization switcher.
 *
 * The read uses Hands' own installation on that server (client credentials ->
 * installation lookup -> installation token with the `server` group ->
 * GET /api/app-installation/members/{sub}/role), so it does not depend on the
 * person's one-hour Raft token.
 */

export type LiveRole = "owner" | "admin" | "member" | "guest" | null;

export type LiveRoleResult =
  | { ok: true; role: LiveRole }
  /** `revoked`: Raft says Hands has no installation (or a disabled one) on that server, which ends
   *  access like a removed member (RFC 079 §5.6); otherwise the read failed and says nothing. */
  | { ok: false; reason: string; revoked: boolean };

/**
 * Failures that mean Hands is no longer installed (or enabled) on the server, as
 * opposed to a network error, a 5xx or a missing installation group: the
 * installation lookup's not-found, and a 401 or 404 for the installation token
 * or (after minting again) for the role read.
 */
export function isRevokedReason(reason: string): boolean {
  return /^(lookup_404|installation-token_(401|404)|role_(401|404))$/.test(reason);
}

/** How the check acts: "off" skips it, "shadow" reads and logs without
 * refusing anyone, "on" refuses ended memberships. */
export type LiveRoleMode = "off" | "shadow" | "on";

/** Shadow until the production read is proven (installations carry the
 * `server` group); then switch to "on". RAFT_LIVE_ROLE_MODE overrides. */
export const DEFAULT_LIVE_ROLE_MODE: LiveRoleMode = "shadow";

export function liveRoleMode(env: { RAFT_LIVE_ROLE_MODE?: string }): LiveRoleMode {
  const value = env.RAFT_LIVE_ROLE_MODE;
  return value === "off" || value === "shadow" || value === "on" ? value : DEFAULT_LIVE_ROLE_MODE;
}

export const ROLE_CACHE_MS = 60_000;
const INSTALLATION_CACHE_MS = 10 * 60_000;
const CACHE_MAX = 5_000;
// A slow Raft must not hold every Hands request.
const FETCH_TIMEOUT_MS = 3_000;

type Cached<T> = { value: T; expiresAt: number };
const roleCache = new Map<string, Cached<LiveRole>>();
const installationCache = new Map<string, Cached<string>>();
const tokenCache = new Map<string, Cached<string>>();
// A failed read is remembered per server for a short while, so a Raft outage
// or a missing installation group does not turn every Hands request into
// Raft calls (they share Hands' per-client budget with notifications).
const FAILURE_CACHE_MS = 30_000;
const failureCache = new Map<string, Cached<string>>();

function cacheGet<T>(cache: Map<string, Cached<T>>, key: string, now: number): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet<T>(cache: Map<string, Cached<T>>, key: string, value: T, expiresAt: number) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt });
}

/** Forget a cached role (after a departure is acted on) and, for tests, everything. */
export function resetLiveRoleCache(key?: { serverId: string; sub: string }) {
  if (key) {
    roleCache.delete(`${key.serverId}:${key.sub}`);
    return;
  }
  roleCache.clear();
  failureCache.clear();
  installationCache.clear();
  tokenCache.clear();
}

type RaftEnv = {
  RAFT_API_ORIGIN?: string;
  RAFT_ORIGIN?: string;
  RAFT_CLIENT_ID?: string;
  RAFT_CLIENT_SECRET?: string;
};

function apiOrigin(env: RaftEnv): string {
  return (env.RAFT_API_ORIGIN ?? env.RAFT_ORIGIN ?? "https://api.raft.build").replace(/\/+$/, "");
}

class RoleReadError extends Error {
  constructor(readonly reason: string, readonly status?: number) {
    super(reason);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = text ? JSON.parse(text) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function clientPost(env: RaftEnv, path: string, body: Record<string, unknown>) {
  if (!env.RAFT_CLIENT_ID || !env.RAFT_CLIENT_SECRET) throw new RoleReadError("client_credentials_missing");
  let response: Response;
  try {
    response = await fetch(`${apiOrigin(env)}${path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${env.RAFT_CLIENT_ID}:${env.RAFT_CLIENT_SECRET}`)}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new RoleReadError("raft_unreachable");
  }
  if (!response.ok) throw new RoleReadError(`${path.split("/").pop()}_${response.status}`, response.status);
  return readJson(response);
}

async function installationId(env: RaftEnv, serverId: string, now: number): Promise<string> {
  const cached = cacheGet(installationCache, serverId, now);
  if (cached) return cached;
  const body = await clientPost(env, "/api/oauth/installations/lookup", { server_id: serverId });
  const id = body.installation_id ?? body.installationId;
  if (typeof id !== "string" || !id) throw new RoleReadError("installation_id_missing");
  cacheSet(installationCache, serverId, id, now + INSTALLATION_CACHE_MS);
  return id;
}

async function installationToken(env: RaftEnv, installation: string, now: number, fresh = false): Promise<string> {
  const cached = fresh ? undefined : cacheGet(tokenCache, installation, now);
  if (cached) return cached;
  const body = await clientPost(env, "/api/oauth/installation-token", { installation_id: installation, groups: ["server"] });
  const token = body.access_token ?? body.token;
  if (typeof token !== "string" || !token) throw new RoleReadError("installation_token_missing");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 300;
  // Kept until 30 s before it expires, at most 10 minutes.
  const ttl = Math.min(Math.max(expiresIn - 30, 0) * 1000, INSTALLATION_CACHE_MS);
  if (ttl > 0) cacheSet(tokenCache, installation, token, now + ttl);
  return token;
}

async function memberRole(env: RaftEnv, token: string, sub: string): Promise<LiveRole> {
  let response: Response;
  try {
    response = await fetch(`${apiOrigin(env)}/api/app-installation/members/${encodeURIComponent(sub)}/role`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new RoleReadError("raft_unreachable");
  }
  if (!response.ok) throw new RoleReadError(`role_${response.status}`, response.status);
  const body = await readJson(response);
  const role = body.role;
  if (role === null) return null;
  if (role === "owner" || role === "admin" || role === "member" || role === "guest") return role;
  // A role Raft adds later counts as below guest.
  return "guest";
}

/**
 * The person's current role on the server, or why it could not be read.
 * A read error is never a claim about the role.
 */
export async function readLiveRaftRole(
  env: RaftEnv,
  serverId: string,
  sub: string,
  now = Date.now(),
): Promise<LiveRoleResult> {
  const key = `${serverId}:${sub}`;
  const cached = roleCache.get(key);
  if (cached && cached.expiresAt > now) return { ok: true, role: cached.value };
  const failed = cacheGet(failureCache, serverId, now);
  if (failed) return { ok: false, reason: failed, revoked: isRevokedReason(failed) };
  try {
    const installation = await installationId(env, serverId, now);
    let role: LiveRole;
    try {
      role = await memberRole(env, await installationToken(env, installation, now), sub);
    } catch (error) {
      // A stale cached installation token: mint once more.
      if (!(error instanceof RoleReadError) || error.status !== 401) throw error;
      tokenCache.delete(installation);
      role = await memberRole(env, await installationToken(env, installation, now, true), sub);
    }
    cacheSet(roleCache, key, role, now + ROLE_CACHE_MS);
    // One line per fresh read (at most one per person and server a minute),
    // so production shows the read working before the mode turns on.
    console.log(JSON.stringify({ event: "raft_live_role_read", server_id: serverId, role }));
    return { ok: true, role };
  } catch (error) {
    if (error instanceof RoleReadError) {
      // The installation is gone from that server: forget it so the next read looks again.
      if (error.status === 404) installationCache.delete(serverId);
      cacheSet(failureCache, serverId, error.reason, now + FAILURE_CACHE_MS);
      return { ok: false, reason: error.reason, revoked: isRevokedReason(error.reason) };
    }
    cacheSet(failureCache, serverId, "role_read_failed", now + FAILURE_CACHE_MS);
    return { ok: false, reason: "role_read_failed", revoked: false };
  }
}

/** Roles that may use Hands on a server. */
export function roleAllowsAccess(role: LiveRole): boolean {
  return role === "owner" || role === "admin" || role === "member";
}
