/**
 * CP3 checkpoint-2: agent token auto-refresh + cross-process single-flight.
 * Deterministic via injected fetch/sleep/now (true multi-process races aren't unit-
 * testable, but winner/loser/stale-break/no-overwrite paths are).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { agentAuthPath, HANDS_SERVICE, readAgentAccessToken, type AgentEnv } from "./lib/agent_env.js";
import { writeAgentSession, type AgentSession } from "./lib/agent_auth.js";
import { createServer, type Server } from "node:http";
import { getFreshAgentAccessToken, forceRefreshAgentToken, releaseOwnLock, breakIfDeadOwner } from "./lib/agent_refresh.js";

const DEAD_PID = 2_147_483_646; // beyond any real pid_max ⇒ process.kill(pid,0) → ESRCH

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    schema: "raft-cli-agent-session.v1",
    token_type: "Bearer",
    access_token: "acc-old",
    access_expires_at: new Date(T0 + 10 * 60 * 1000).toISOString(),
    refresh_token: "ref-old",
    refresh_expires_at: new Date(T0 + 30 * DAY).toISOString(),
    ...over,
  };
}
const NEW_SESSION: AgentSession = {
  schema: "raft-cli-agent-session.v1",
  token_type: "Bearer",
  access_token: "acc-new",
  access_expires_at: new Date(T0 + 20 * 60 * 1000).toISOString(),
  refresh_token: "ref-new",
  refresh_expires_at: new Date(T0 + 30 * DAY).toISOString(),
};

function mockFetch(body: unknown, status = 200, calls?: { n: number }) {
  return (async () => {
    if (calls) calls.n++;
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  }) as unknown as typeof fetch;
}
const noSleep = async () => {};

function env(dir: string): AgentEnv {
  return { transportDir: "/t", slockHome: dir, agentId: "agent-1", raftBin: "/t/raft" };
}
function store(a: AgentEnv, s: AgentSession) {
  writeAgentSession(a, HANDS_SERVICE, s, "https://api.example", () => new Date(T0).toISOString());
}

describe("auto-refresh", () => {
  let dir: string;
  let a: AgentEnv;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "refresh-")); a = env(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("no store → null", async () => {
    expect(await getFreshAgentAccessToken(a, { now: T0, sleepImpl: noSleep })).toBeNull();
  });

  it("token comfortably unexpired → returns it, no refresh call", async () => {
    store(a, session());
    const calls = { n: 0 };
    const tok = await getFreshAgentAccessToken(a, { now: T0, fetchImpl: mockFetch(NEW_SESSION, 200, calls), sleepImpl: noSleep });
    expect(tok).toBe("acc-old");
    expect(calls.n).toBe(0);
  });

  it("near-expiry → rotates, persists, returns the new access token", async () => {
    store(a, session({ access_expires_at: new Date(T0 + 30 * 1000).toISOString() })); // within 60s skew
    const calls = { n: 0 };
    const tok = await getFreshAgentAccessToken(a, { now: T0, fetchImpl: mockFetch(NEW_SESSION, 200, calls), sleepImpl: noSleep });
    expect(tok).toBe("acc-new");
    expect(calls.n).toBe(1);
    expect(readAgentAccessToken(a)).toBe("acc-new");
  });

  it("refresh HTTP failure → throws without echoing the body, keeps the old store", async () => {
    store(a, session({ access_expires_at: new Date(T0 - 1000).toISOString() }));
    const secret = "SECRET-refresh-token-in-body";
    await expect(
      getFreshAgentAccessToken(a, { now: T0, fetchImpl: mockFetch(secret, 401), sleepImpl: noSleep }),
    ).rejects.toThrow(/HTTP 401/);
    let err = "";
    try {
      await getFreshAgentAccessToken(a, { now: T0, fetchImpl: mockFetch(secret, 401), sleepImpl: noSleep });
    } catch (e) { err = (e as Error).message; }
    expect(err).not.toContain(secret);
    expect(readAgentAccessToken(a)).toBe("acc-old"); // unchanged
  });

  it("forceRefresh rotates even when the token is unexpired", async () => {
    store(a, session());
    const calls = { n: 0 };
    const tok = await forceRefreshAgentToken(a, { now: T0, fetchImpl: mockFetch(NEW_SESSION, 200, calls), sleepImpl: noSleep });
    expect(tok).toBe("acc-new");
    expect(calls.n).toBe(1);
  });
});

describe("single-flight", () => {
  let dir: string;
  let a: AgentEnv;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sf-")); a = env(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loser (lock held by a live holder) waits, uses the winner's newer session, never rotates", async () => {
    store(a, session({ access_expires_at: new Date(T0 - 1000).toISOString() })); // stale
    const lock = join(dirname(agentAuthPath(a)), ".auth.refresh.lock");
    writeFileSync(lock, "held"); // fresh mtime ⇒ live holder, not stale
    const calls = { n: 0 };
    let polls = 0;
    const sleepImpl = async () => {
      polls++;
      if (polls === 2) store(a, NEW_SESSION); // the winner writes the fresh session mid-wait
    };
    const tok = await getFreshAgentAccessToken(a, { now: T0, fetchImpl: mockFetch(NEW_SESSION, 200, calls), sleepImpl });
    expect(tok).toBe("acc-new"); // used the winner's session
    expect(calls.n).toBe(0); // never rotated itself
  });

  it("breaks a lock whose owner process is dead, then acquires and refreshes", async () => {
    store(a, session({ access_expires_at: new Date(T0 - 1000).toISOString() }));
    const lock = join(dirname(agentAuthPath(a)), ".auth.refresh.lock");
    writeFileSync(lock, `${DEAD_PID}:abandoned`); // owner process is dead ⇒ safe to break
    const calls = { n: 0 };
    const tok = await getFreshAgentAccessToken(a, { now: T0, fetchImpl: mockFetch(NEW_SESSION, 200, calls), sleepImpl: noSleep });
    expect(tok).toBe("acc-new");
    expect(calls.n).toBe(1); // broke the dead-owner lock and refreshed
    expect(existsSync(lock)).toBe(false); // released after
  });

  // Finding #2: a fresh (unexpired) token that the server 401'd must NOT be re-handed by
  // a concurrent loser — it would just 401 again. The loser waits for the winner's
  // strictly-newer session (changed refresh token), and never rotates itself.
  it("forced loser with a fresh-but-401 token waits for the winner's newer session (live holder, lock intact)", async () => {
    store(a, session()); // acc-old is comfortably unexpired (T0+10min), ref-old
    const lock = join(dirname(agentAuthPath(a)), ".auth.refresh.lock");
    writeFileSync(lock, `${process.pid}:live`); // owner pid is alive ⇒ never broken
    const calls = { n: 0 };
    let polls = 0;
    const sleepImpl = async () => { polls++; if (polls === 2) store(a, NEW_SESSION); };
    const tok = await forceRefreshAgentToken(a, { now: T0, fetchImpl: mockFetch(NEW_SESSION, 200, calls), sleepImpl });
    expect(tok).toBe("acc-new"); // the winner's rotated session, not the 401'd token
    expect(calls.n).toBe(0); // loser never rotated
    expect(existsSync(lock)).toBe(true); // never broke the live holder's lock
  });

  it("forced loser fails (never re-hands the old 401'd token) when no newer session arrives", async () => {
    store(a, session()); // fresh token, but forced (post-401)
    const lock = join(dirname(agentAuthPath(a)), ".auth.refresh.lock");
    writeFileSync(lock, `${process.pid}:live`);
    await expect(
      forceRefreshAgentToken(a, { now: T0, fetchImpl: mockFetch(NEW_SESSION, 200), sleepImpl: noSleep }),
    ).rejects.toThrow(/timed out/);
  });

  // Finding #3 (round 2): a live owner (incl. suspended/stalled — pid still exists) is
  // NEVER broken; only a provably-dead owner is; a replacement owner is not TOCTOU-deleted.
  it("breakIfDeadOwner: live owner (real pid) is never broken", () => {
    const lock = join(dir, ".auth.refresh.lock");
    writeFileSync(lock, `${process.pid}:live`);
    expect(breakIfDeadOwner(lock)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });
  it("breakIfDeadOwner: unparseable owner fails closed (not broken)", () => {
    const lock = join(dir, ".auth.refresh.lock");
    writeFileSync(lock, "no-pid-here");
    expect(breakIfDeadOwner(lock)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });
  it("breakIfDeadOwner: dead owner is broken", () => {
    const lock = join(dir, ".auth.refresh.lock");
    writeFileSync(lock, `${DEAD_PID}:abandoned`);
    expect(breakIfDeadOwner(lock)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
  it("breakIfDeadOwner: dead owner replaced between reads is NOT deleted (TOCTOU guard)", () => {
    const lock = join(dir, ".auth.refresh.lock");
    writeFileSync(lock, `${process.pid}:replacement`); // the file now holds a LIVE new owner
    // Injected reader: first read = the dead owner we saw, second read = the replacement.
    let n = 0;
    const readOwner = () => { n += 1; return n === 1 ? `${DEAD_PID}:gone` : `${process.pid}:replacement`; };
    expect(breakIfDeadOwner(lock, readOwner)).toBe(false); // replaced under us ⇒ leave it
    expect(existsSync(lock)).toBe(true);
  });

  // Finding #3: release must never delete a lock that a foreign holder now owns.
  it("releaseOwnLock deletes only our own lock, never a foreign holder's", () => {
    const lock = join(dir, ".auth.refresh.lock");
    writeFileSync(lock, "owner-A");
    releaseOwnLock(lock, "owner-B"); // foreign id ⇒ leave it
    expect(existsSync(lock)).toBe(true);
    releaseOwnLock(lock, "owner-A"); // our id ⇒ delete it
    expect(existsSync(lock)).toBe(false);
  });
});

// Round 2: secret-bearing token endpoints must refuse redirects and bound the body.
describe("refresh token endpoint hardening (real server)", () => {
  let dir: string;
  let a: AgentEnv;
  let primary: Server;
  let secondary: Server;
  let base: string;
  let secondHits: number;
  let mode: "redirect" | "huge";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "sf-net-"));
    a = env(dir);
    secondHits = 0;
    mode = "redirect";
    secondary = createServer((_req, res) => {
      secondHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(NEW_SESSION));
    });
    await new Promise<void>((r) => secondary.listen(0, r));
    const secondBase = `http://127.0.0.1:${(secondary.address() as any).port}`;
    primary = createServer((req, res) => {
      if (req.url === "/api/auth/agent/refresh") {
        if (mode === "redirect") { res.writeHead(307, { location: `${secondBase}/api/auth/agent/refresh` }); res.end(); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end("x".repeat(70 * 1024)); return; // "huge"
      }
      res.writeHead(404); res.end("{}");
    });
    await new Promise<void>((r) => primary.listen(0, r));
    base = `http://127.0.0.1:${(primary.address() as any).port}`;
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((r) => primary.close(() => r()));
    await new Promise<void>((r) => secondary.close(() => r()));
  });

  function storeAt(apiBase: string) {
    writeAgentSession(
      a, HANDS_SERVICE,
      session({ access_expires_at: new Date(T0 - 1000).toISOString() }),
      apiBase, () => new Date(T0).toISOString(),
    );
  }

  it("refuses to follow a 307 (never forwards the refresh_token to the redirect target)", async () => {
    mode = "redirect";
    storeAt(base);
    await expect(forceRefreshAgentToken(a, { now: T0, sleepImpl: noSleep })).rejects.toThrow(/HTTP 307/);
    expect(secondHits).toBe(0); // the redirect target was never contacted
  });

  it("rejects an oversized refresh response body", async () => {
    mode = "huge";
    storeAt(base);
    await expect(forceRefreshAgentToken(a, { now: T0, sleepImpl: noSleep })).rejects.toThrow(/size limit/);
  });
});
