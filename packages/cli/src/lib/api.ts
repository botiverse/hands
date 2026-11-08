/**
 * HTTP client for the Quiver Worker API.
 *
 * Mirrors the shape of admin/src/lib/api.ts and sends the saved Hands JWT as
 * Authorization: Bearer.
 *
 * Endpoints called by the CLI use `requireAppRole("viewer")` or
 * `requireOrgRole("member")` after the user has logged in via `hands login`.
 */

import { resolveApiBase, resolveAuthToken } from "./config.js";
import { admitAgent } from "./agent_env.js";
import { getFreshAgentAccessToken, forceRefreshAgentToken } from "./agent_refresh.js";
import { readEnv } from "./env.js";
import { Blob } from "node:buffer";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Resolve the bearer for a request. In a managed agent this proactively refreshes the
 * stored Hands token when it is near expiry (single-flight); a broken agent env yields
 * no token (fail closed). Human/CI use the ordinary resolver.
 */
async function resolveBearer(): Promise<string | undefined> {
  const admission = admitAgent();
  if (admission.kind === "agent") {
    return (await getFreshAgentAccessToken(admission.env)) ?? undefined;
  }
  if (admission.kind === "fail_closed") {
    // Fail closed - do NOT fall back to human credentials - but fail LOUDLY. Returning
    // undefined here made the request go out unauthenticated and surface as a bare 401.
    throw new AgentEnvironmentError(admission.reason);
  }
  return resolveAuthToken();
}

/**
 * Run a bearer-parameterized request with agent-aware auth, shared by every CLI HTTP
 * path (`apiRequest`, `apiUploadFile`, and `hands api`): resolve the bearer (proactive
 * refresh in agent mode). Unless opted out, a 401 in agent mode forces ONE refresh
 * and retry. `doFetch` MUST build a fresh request each call — a request body stream
 * cannot be reused across attempts. Callers can disable the reactive 401 retry for
 * non-idempotent requests or reads with side effects; proactive refresh remains.
 */
export async function agentAwareFetch(
  doFetch: (bearer: string | undefined) => Promise<Response>,
  opts: { retryOnUnauthorized?: boolean } = {},
): Promise<Response> {
  let res = await doFetch(await resolveBearer());
  // A mutation without a provider idempotency key must be able to opt out: an
  // intermediary's 401 does not prove that the first request did not reach the server.
  // The proactive refresh in resolveBearer still happens before that first request.
  if (opts.retryOnUnauthorized !== false && res.status === 401) {
    const admission = admitAgent();
    if (admission.kind === "agent") {
      const refreshed = await forceRefreshAgentToken(admission.env);
      if (refreshed) res = await doFetch(refreshed);
    }
  }
  return res;
}

export class QuiverApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "QuiverApiError";
    this.status = status;
    this.body = body;
  }
}

/** A 401 can come from an intermediary after the request reached the server. */
export function warnNo401Retry(status: number): void {
  if (status === 401) {
    console.error("No automatic 401 retry was attempted. The outcome may be unknown; inspect current state before retrying.");
  }
}

/**
 * Raised when the process looks like a managed agent (some agent markers present) but
 * the agent environment is incomplete or invalid, so there is no credential to send.
 *
 * Without this, admission failure degraded into an unauthenticated request and the user
 * saw a bare 401 - indistinguishable from an expired or revoked token, which sent people
 * looking at token lifetimes instead of the environment. Carry the reason and say what to
 * do, so the failure names its own cause.
 */
export class AgentEnvironmentError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(
      `Not usable as an agent request: the agent environment is incomplete or invalid (${reason}). ` +
        "No credential was sent, so this is not an expired token. Either fix the agent " +
        "environment, or run `raft integration invoke` from the managed session.",
    );
    this.name = "AgentEnvironmentError";
    this.reason = reason;
  }
}

let currentApiBase: string | null = null;

export function setApiBase(url: string): void {
  currentApiBase = url;
}

export function getApiBase(): string {
  return currentApiBase ?? resolveApiBase();
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  raw?: boolean; // when true, return Response instead of parsed JSON
  signal?: AbortSignal;
  /** Set false when a 401 cannot safely be retried, including reads with side effects. */
  retryOnUnauthorized?: boolean;
}

export async function apiRequest<T = unknown>(
  path: string,
  opts: ApiRequestOptions = {},
): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, getApiBase());
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === null || v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const baseHeaders: Record<string, string> = {
    accept: "application/json",
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    baseHeaders["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const doFetch = (bearer: string | undefined) => {
    const headers = { ...baseHeaders };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  };
  const res = await agentAwareFetch(doFetch, opts.retryOnUnauthorized === undefined ? {} : { retryOnUnauthorized: opts.retryOnUnauthorized });
  if (readEnv("VERBOSE") === "1") {
    console.error(`> ${opts.method ?? "GET"} ${url}`);
    console.error(`< ${res.status}`);
  }
  if (opts.retryOnUnauthorized === false) warnNo401Retry(res.status);
  if (opts.raw) return (res as unknown) as T;
  const text = await res.text();
  let data: unknown = text;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      // keep as text
    }
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new QuiverApiError(res.status, data, msg);
  }
  return data as T;
}

export async function apiUploadFile<T = unknown>(
  path: string,
  filePath: string,
  fieldName = "apk",
): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, getApiBase());
  const bytes = await readFile(filePath);
  const name = basename(filePath);
  // Upload is a primary product path, so it uses the SAME agent-aware request + one-401
  // as every other call. The multipart body is rebuilt per attempt: a body stream can't
  // be reused, and agent mode may retry once after a 401.
  const res = await agentAwareFetch((bearer) => {
    const form = new FormData();
    form.append(fieldName, new Blob([bytes]), name);
    const headers: Record<string, string> = { accept: "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return fetch(url.toString(), { method: "POST", headers, body: form });
  });
  if (readEnv("VERBOSE") === "1") {
    console.error(`> POST ${url}`);
    console.error(`< ${res.status}`);
  }
  const text = await res.text();
  let data: unknown = text;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      // keep as text
    }
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new QuiverApiError(res.status, data, msg);
  }
  return data as T;
}
