/**
 * Agent CLI login flow (RFC 057, CP3): the non-interactive `hands login` used inside
 * a managed Raft agent. No browser, no paste.
 *
 *   1. Generate a PKCE code_verifier locally; send only its S256 challenge to Raft.
 *   2. Run the EXACT wrapper `$SLOCK_CLI_TRANSPORT_DIR/raft integration invoke
 *      --action agent-login --json` (never PATH `raft`); require exit 0; STRICTLY
 *      validate the result (outer success + exact service/action/status + closed grant
 *      result schema + RFC3339/future expiry within a bounded client sanity window). The
 *      server issues a 300s TTL (RFC 057) and enforces the real expiry; the client accepts
 *      up to 300s + clock-skew headroom so a boundary grant is not rejected under skew.
 *      Errors carry only stable reasons
 *      — never the raw stdout/stderr/body (which could contain grant/action payload).
 *   3. Exchange { grant, code_verifier } at the Hands PUBLIC endpoint for a
 *      raft-cli-agent-session.v1; strictly validate it (closed keys + RFC3339 expiries).
 *   4. Atomically persist under $SLOCK_HOME (O_EXCL temp + fsync + rename; 0600 file /
 *      verified-0700 dirs), recording the api base so the resolver never needs config.
 *
 * The verifier never reaches Raft, logs, or the store. Only the Hands token is stored.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { getApiBase } from "./api.js";
import { HANDS_SERVICE, type AgentEnv } from "./agent_env.js";
import {
  writeAgentSession,
  type AgentSession,
} from "@botiverse/agent-session-store";

export { writeAgentSession, type AgentSession, type StoredAgentAuth } from "@botiverse/agent-session-store";

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

// Client-side sanity ceiling on the grant lifetime: the server issues expiry =
// server_now + 300s (RFC 057). We allow generous clock-skew headroom above that so a
// legitimate grant is never rejected at the exact boundary; the server enforces the
// real, shorter expiry, so this bound only rejects an absurdly long-lived grant.
const AGENT_GRANT_TTL_CEILING_MS = 300_000 + 120_000; // 300s + 120s skew

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
  // Check success first: a failed invoke may legitimately carry a different shape
  // (e.g. {ok:false, error}); only the success wrapper is the closed {ok, data}.
  if (outer.ok !== true) throw new Error("agent-login: invoke did not succeed");
  // Closed envelope: an unexpected extra field means the wire drifted from the
  // checkpoint contract; fail rather than ignore.
  if (!hasExactKeys(outer, ["ok", "data"])) throw new Error("agent-login: invoke envelope has unexpected fields");
  const data = outer.data;
  if (!data || typeof data !== "object") throw new Error("agent-login: invoke result is missing data");
  if (!hasExactKeys(data, ["service", "action", "status", "result"])) {
    throw new Error("agent-login: invoke data has unexpected fields");
  }
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
  // The server issues expiry = server_now + 300s (RFC 057). The client parses it later and
  // its clock may differ, so a zero-tolerance ceiling flakes at the exact boundary. This is
  // a sanity bound (the server enforces the real expiry), so allow clock-skew headroom.
  if (exp > now + AGENT_GRANT_TTL_CEILING_MS) throw new Error("agent-login: grant expiry exceeds the ceiling");
  return { grant: result.grant, expires_at: result.expires_at };
}

/**
 * Strictly validate the exchange/refresh success body (closed keys + RFC3339).
 * `now` is injected so validation is deterministic: a freshly issued session MUST
 * have a strictly-future access expiry (and refresh expiry, when present) — otherwise
 * we would persist an already-dead session that the very next request must refresh.
 */
export function parseAgentSession(body: any, now: number): AgentSession {
  if (!body || typeof body !== "object") throw new Error("agent-login: exchange response is not an object");
  if (!hasExactKeys(body, ["schema", "token_type", "access_token", "access_expires_at", "refresh_token", "refresh_expires_at"])) {
    throw new Error("agent-login: session has unexpected fields");
  }
  if (body.schema !== "raft-cli-agent-session.v1") throw new Error("agent-login: unexpected session schema");
  if (body.token_type !== "Bearer") throw new Error("agent-login: unexpected token_type");
  for (const k of ["access_token", "refresh_token"] as const) {
    if (typeof body[k] !== "string" || body[k].length === 0) throw new Error(`agent-login: session missing ${k}`);
  }
  const accessExp = parseRfc3339(body.access_expires_at);
  if (accessExp === null) throw new Error("agent-login: session access_expires_at is not RFC3339");
  if (accessExp <= now) throw new Error("agent-login: session access token is already expired");
  if (body.refresh_expires_at !== null) {
    const refreshExp = parseRfc3339(body.refresh_expires_at);
    if (refreshExp === null) throw new Error("agent-login: session refresh_expires_at must be RFC3339 or null");
    if (refreshExp <= now) throw new Error("agent-login: session refresh token is already expired");
  }
  return body as AgentSession;
}

// Token responses are small JSON; cap the read so a hostile/broken endpoint cannot
// stream an unbounded body. Shared by the exchange and refresh token requests.
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

/**
 * Read a response body with a hard byte cap. If an AbortController is supplied it is
 * aborted when the cap is exceeded (so a still-open connection is torn down, and — in
 * `rotate` — the same controller's deadline keeps covering this read). Falls back to
 * `.text()` for response doubles that expose no stream (still cap-checked).
 */
export async function readBoundedText(res: Response, controller?: AbortController): Promise<string> {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_TOKEN_RESPONSE_BYTES) {
    controller?.abort();
    throw new Error("agent-login: token response exceeds the size limit");
  }
  const reader = (res.body as ReadableStream<Uint8Array> | null | undefined)?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (t.length > MAX_TOKEN_RESPONSE_BYTES) throw new Error("agent-login: token response exceeds the size limit");
    return t;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        controller?.abort();
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error("agent-login: token response exceeds the size limit");
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(out);
}

export interface AgentLoginOptions {
  service?: string; // default HANDS_SERVICE (compiled-fixed exact client key)
  now?: number; // injectable clock (ms) for tests
  /** Injectable invoke runner for tests; defaults to spawning the pinned wrapper. */
  invoke?: (args: string[]) => { status: number | null; stdout: string; stderr: string };
  /** Injectable fetch for the exchange; defaults to global fetch. */
  fetchImpl?: typeof fetch;
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

  // Independent token request: NO stored Bearer, NO auto-refresh. `hands login` is the
  // recovery path when the stored refresh has reached a terminal state
  // (expired/reused/revoked); routing this exchange through the api client would first
  // try to refresh that dead token and throw before the fresh grant is ever spent.
  const apiBase = getApiBase();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const exchangeRes = await fetchImpl(new URL("/api/auth/agent/exchange", apiBase).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ schema: "raft-cli-agent-login-exchange.v1", grant, code_verifier: verifier }),
    // Never follow a redirect: a 307/308 would forward the grant + code_verifier body
    // to the redirect target. `manual` leaves a 3xx as a non-ok status we reject below.
    redirect: "manual",
  });
  if (!exchangeRes.ok) {
    // Stable reason only; never echo the response body (may carry token material).
    throw new Error(`agent-login: grant exchange failed (HTTP ${exchangeRes.status})`);
  }
  const exchangeText = await readBoundedText(exchangeRes);
  let exchangeBody: unknown;
  try {
    exchangeBody = JSON.parse(exchangeText);
  } catch {
    throw new Error("agent-login: exchange response was not JSON");
  }
  const session = parseAgentSession(exchangeBody, now);
  writeAgentSession(a, service, session, apiBase);
  return session;
}
