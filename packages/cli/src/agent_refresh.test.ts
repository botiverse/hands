/**
 * CP3 checkpoint-2: agent token auto-refresh + cross-process single-flight.
 * Deterministic via injected fetch/sleep/now (true multi-process races aren't unit-
 * testable, but winner/loser/stale-break/no-overwrite paths are).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { agentAuthPath, HANDS_SERVICE, readAgentAccessToken, type AgentEnv } from "./lib/agent_env.js";
import { writeAgentSession, type AgentSession } from "./lib/agent_auth.js";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getFreshAgentAccessToken, forceRefreshAgentToken, releaseOwnLock, acquireIfDeadOwner } from "./lib/agent_refresh.js";

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

  // Finding #3: a live owner (incl. suspended/stalled — pid still exists) is NEVER stolen;
  // only a provably-dead owner is reaped (and then the main lock is re-acquired under fence).
  it("acquireIfDeadOwner: live owner (real pid) is never stolen", () => {
    const lock = join(dir, ".auth.refresh.lock");
    writeFileSync(lock, `${process.pid}:live`);
    expect(acquireIfDeadOwner(lock, "me:1")).toBe(false); // loser
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}:live`); // untouched
    expect(existsSync(`${lock}.reap`)).toBe(false); // fence released
  });
  it("acquireIfDeadOwner: unparseable owner fails closed (loser)", () => {
    const lock = join(dir, ".auth.refresh.lock");
    writeFileSync(lock, "no-pid-here");
    expect(acquireIfDeadOwner(lock, "me:1")).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("no-pid-here");
  });
  it("acquireIfDeadOwner: dead owner is reaped and re-acquired under the fence", () => {
    const lock = join(dir, ".auth.refresh.lock");
    writeFileSync(lock, `${DEAD_PID}:abandoned`);
    expect(acquireIfDeadOwner(lock, "me:winner")).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe("me:winner"); // we now hold it
    expect(existsSync(`${lock}.reap`)).toBe(false); // fence released
  });
  it("acquireIfDeadOwner: ANY existing reaper fence blocks a second recoverer (no auto-recovery)", () => {
    const lock = join(dir, ".auth.refresh.lock");
    writeFileSync(lock, `${DEAD_PID}:abandoned`);
    // A live reaper's fence blocks, as expected.
    writeFileSync(`${lock}.reap`, `${process.pid}:live-reaper`);
    expect(acquireIfDeadOwner(lock, "me:1")).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe(`${DEAD_PID}:abandoned`);
    // A LEFTOVER fence whose reaper pid is DEAD also blocks — we never auto-recover it
    // (that would recurse the reap race). Fail closed; leave it for manual cleanup.
    writeFileSync(`${lock}.reap`, `${DEAD_PID}:crashed-reaper`);
    expect(acquireIfDeadOwner(lock, "me:1")).toBe(false);
    expect(existsSync(`${lock}.reap`)).toBe(true); // NOT auto-removed
    expect(readFileSync(lock, "utf8")).toBe(`${DEAD_PID}:abandoned`);
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

  // Finding #3 (round 3): TWO REAL PROCESSES recovering the SAME dead lock must produce
  // exactly ONE refresh. Single-event-loop Promise.all cannot exercise this (acquireIfDeadOwner
  // is all-synchronous, so the first finishes before the second starts) — so we fork two tsx
  // workers, park both at a file barrier, release together, and count server-side refreshes.
  it("two REAL concurrent processes recovering a dead lock produce exactly one refresh", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(NEW_SESSION));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    writeAgentSession(
      a, HANDS_SERVICE,
      session({ access_expires_at: new Date(T0 - 1000).toISOString() }),
      base, () => new Date(T0).toISOString(),
    );
    const lock = join(dirname(agentAuthPath(a)), ".auth.refresh.lock");
    writeFileSync(lock, `${DEAD_PID}:abandoned`);

    const tsxBin = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const worker = fileURLToPath(new URL("./refresh_race_worker.mts", import.meta.url));
    const goFile = join(dir, "go");
    const spawnWorker = (i: number) => {
      const ready = join(dir, `ready-${i}`);
      const p = spawn(tsxBin, [worker, dir, "/t", "agent-1", ready, goFile, String(T0)], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => { out += String(d); });
      const done = new Promise<string>((res) => p.on("close", () => res(out)));
      return { ready, done };
    };
    const w1 = spawnWorker(1);
    const w2 = spawnWorker(2);

    const started = Date.now();
    while (!(existsSync(w1.ready) && existsSync(w2.ready))) {
      if (Date.now() - started > 20_000) throw new Error("race workers never became ready");
      await new Promise((r) => setTimeout(r, 20));
    }
    writeFileSync(goFile, "go"); // release both together
    const [o1, o2] = await Promise.all([w1.done, w2.done]);
    await new Promise<void>((r) => server.close(() => r()));

    expect(hits).toBe(1); // exactly one refresh across the two real processes
    expect([o1, o2]).toEqual(["acc-new", "acc-new"]); // both end up with the winner's rotated token
    expect(existsSync(`${lock}.reap`)).toBe(false); // fence released
  }, 30_000);
});

// Round 2: secret-bearing token endpoints must refuse redirects and bound the body.
describe("refresh token endpoint hardening (real server)", () => {
  let dir: string;
  let a: AgentEnv;
  let primary: Server;
  let secondary: Server;
  let base: string;
  let secondHits: number;
  let mode: "redirect" | "huge" | "hang";

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
        if (mode === "hang") { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); return; } // headers flushed, body never ends
        res.writeHead(200, { "content-type": "application/json" }); res.end("x".repeat(70 * 1024)); return; // "huge"
      }
      res.writeHead(404); res.end("{}");
    });
    await new Promise<void>((r) => primary.listen(0, r));
    base = `http://127.0.0.1:${(primary.address() as any).port}`;
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    primary.closeAllConnections?.(); // drop any hanging (slow-body) connection
    secondary.closeAllConnections?.();
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

  // Finding #3 (round 3): headers flush fast but the body never completes — the deadline
  // must cover the body read, aborting it AND releasing the lock (not just headers).
  it("aborts a fast-headers/never-ending body at the deadline and releases the lock", async () => {
    mode = "hang";
    storeAt(base);
    await expect(
      forceRefreshAgentToken(a, { now: T0, sleepImpl: noSleep, deadlineMs: 50 }),
    ).rejects.toThrow();
    const lock = join(dirname(agentAuthPath(a)), ".auth.refresh.lock");
    expect(existsSync(lock)).toBe(false); // lock released after the aborted refresh
  });
});
