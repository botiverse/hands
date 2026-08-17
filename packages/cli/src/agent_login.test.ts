/**
 * CP3 checkpoint-1: agent-login flow (env detection, strict invoke-result validation
 * = Volta's acceptance tooth, session validation, PKCE, atomic store, full flow).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import {
  detectAgentEnv,
  agentAuthPath,
  readAgentAccessToken,
  HANDS_SERVICE,
} from "./lib/agent_env.js";
import {
  generatePkce,
  parseAgentLoginInvoke,
  parseAgentSession,
  writeAgentSession,
  runAgentLogin,
  type AgentSession,
} from "./lib/agent_auth.js";

const AGENT = { transportDir: "/t", slockHome: "/home/x/.slock", agentId: "agent-7" };

function invokeEnvelope(over: Record<string, unknown> = {}, resultOver: Record<string, unknown> = {}) {
  return JSON.stringify({
    ok: true,
    data: {
      service: HANDS_SERVICE,
      action: "agent-login",
      status: 200,
      result: {
        schema: "raft-cli-agent-login-grant.v1",
        service: HANDS_SERVICE,
        grant: "opaque-grant",
        expires_at: "2026-08-17T09:00:00.000Z",
        ...resultOver,
      },
      ...over,
    },
  });
}

const SESSION: AgentSession = {
  schema: "raft-cli-agent-session.v1",
  token_type: "Bearer",
  access_token: "acc-123",
  access_expires_at: "2026-08-17T10:00:00.000Z",
  refresh_token: "ref-456",
  refresh_expires_at: "2026-09-16T09:00:00.000Z",
};

describe("agent env detection", () => {
  it("returns the env only when all three daemon vars are present", () => {
    const full = { SLOCK_CLI_TRANSPORT_DIR: "/t", SLOCK_HOME: "/h", SLOCK_AGENT_ID: "a" };
    expect(detectAgentEnv(full as any)).toEqual({ transportDir: "/t", slockHome: "/h", agentId: "a" });
    expect(detectAgentEnv({ SLOCK_HOME: "/h", SLOCK_AGENT_ID: "a" } as any)).toBeNull();
    expect(detectAgentEnv({ SLOCK_CLI_TRANSPORT_DIR: "/t", SLOCK_AGENT_ID: "a" } as any)).toBeNull();
    expect(detectAgentEnv({ SLOCK_CLI_TRANSPORT_DIR: "/t", SLOCK_HOME: "/h" } as any)).toBeNull();
    expect(detectAgentEnv({} as any)).toBeNull();
  });

  it("builds the canonical per-agent store path", () => {
    expect(agentAuthPath(AGENT)).toBe(
      `/home/x/.slock/agents/agent-7/integrations/${HANDS_SERVICE}/auth.json`,
    );
  });
});

describe("PKCE", () => {
  it("verifier is RFC 7636 valid and challenge = base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("parseAgentLoginInvoke (strict invoke-result validation — acceptance tooth)", () => {
  it("accepts a well-formed envelope", () => {
    expect(parseAgentLoginInvoke(invokeEnvelope(), HANDS_SERVICE)).toEqual({
      grant: "opaque-grant",
      expires_at: "2026-08-17T09:00:00.000Z",
    });
  });
  it("rejects non-JSON", () => {
    expect(() => parseAgentLoginInvoke("not json", HANDS_SERVICE)).toThrow(/did not return JSON/);
  });
  it("rejects outer ok=false", () => {
    expect(() => parseAgentLoginInvoke(JSON.stringify({ ok: false, error: "nope" }), HANDS_SERVICE)).toThrow(/did not succeed/);
  });
  it("rejects a service mismatch (outer)", () => {
    expect(() => parseAgentLoginInvoke(invokeEnvelope({ service: "hands-other" }), HANDS_SERVICE)).toThrow(/service mismatch/);
  });
  it("rejects an action mismatch", () => {
    expect(() => parseAgentLoginInvoke(invokeEnvelope({ action: "whoami" }), HANDS_SERVICE)).toThrow(/action mismatch/);
  });
  it("rejects a non-200 action status", () => {
    expect(() => parseAgentLoginInvoke(invokeEnvelope({ status: 403 }), HANDS_SERVICE)).toThrow(/HTTP 403/);
  });
  it("rejects a wrong grant result schema", () => {
    expect(() => parseAgentLoginInvoke(invokeEnvelope({}, { schema: "something.v9" }), HANDS_SERVICE)).toThrow(/grant result schema/);
  });
  it("rejects a grant-result service mismatch", () => {
    expect(() => parseAgentLoginInvoke(invokeEnvelope({}, { service: "hands-other" }), HANDS_SERVICE)).toThrow(/grant service mismatch/);
  });
  it("rejects a missing grant", () => {
    expect(() => parseAgentLoginInvoke(invokeEnvelope({}, { grant: "" }), HANDS_SERVICE)).toThrow(/grant missing/);
  });
});

describe("parseAgentSession (session.v1 validation)", () => {
  it("accepts a well-formed session and null refresh_expires_at", () => {
    expect(parseAgentSession(SESSION)).toEqual(SESSION);
    expect(parseAgentSession({ ...SESSION, refresh_expires_at: null }).refresh_expires_at).toBeNull();
  });
  it("rejects bad schema / token_type / missing fields / bad refresh expiry", () => {
    expect(() => parseAgentSession({ ...SESSION, schema: "x" })).toThrow(/session schema/);
    expect(() => parseAgentSession({ ...SESSION, token_type: "Basic" })).toThrow(/token_type/);
    expect(() => parseAgentSession({ ...SESSION, access_token: "" })).toThrow(/access_token/);
    expect(() => parseAgentSession({ ...SESSION, refresh_expires_at: 123 })).toThrow(/refresh_expires_at/);
  });
});

describe("atomic store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agent-auth-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes 0600 file under 0700 dirs, and reads the access token back", () => {
    const a = { transportDir: "/t", slockHome: dir, agentId: "agent-9" };
    const path = writeAgentSession(a, HANDS_SERVICE, SESSION, () => "2026-08-17T00:00:00.000Z");
    expect(path).toBe(agentAuthPath(a));
    const rec = JSON.parse(readFileSync(path, "utf8"));
    expect(rec).toMatchObject({ ...SESSION, service: HANDS_SERVICE, updated_at: "2026-08-17T00:00:00.000Z" });
    // No group/other permissions on the credential file or its dir.
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "agents", "agent-9", "integrations", HANDS_SERVICE)).mode & 0o077).toBe(0);
    expect(readAgentAccessToken(a)).toBe("acc-123");
  });

  it("readAgentAccessToken returns null when absent", () => {
    expect(readAgentAccessToken({ transportDir: "/t", slockHome: dir, agentId: "missing" })).toBeNull();
  });
});

describe("runAgentLogin (full flow: invoke → exchange → store)", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let exchangeBody: any;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "agent-flow-"));
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        exchangeBody = JSON.parse(raw || "{}");
        if (req.url === "/api/auth/agent/exchange" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(SESSION));
        } else {
          res.writeHead(404); res.end("{}");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    process.env.HANDS_API = base;
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HANDS_API;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("invokes agent-login, exchanges the grant, and stores the session", async () => {
    const a = { transportDir: "/t", slockHome: dir, agentId: "agent-flow" };
    let invokedArgs: string[] = [];
    const session = await runAgentLogin(a, {
      invoke: (args) => { invokedArgs = args; return { status: 0, stdout: invokeEnvelope(), stderr: "" }; },
    });
    // invoke was called with the right service/action + a request-schema body.
    expect(invokedArgs).toContain("agent-login");
    expect(invokedArgs).toContain(HANDS_SERVICE);
    // exchange sent the exchange schema + grant + a verifier (never the challenge).
    expect(exchangeBody.schema).toBe("raft-cli-agent-login-exchange.v1");
    expect(exchangeBody.grant).toBe("opaque-grant");
    expect(exchangeBody.code_verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    // stored + returned.
    expect(session).toEqual(SESSION);
    expect(readAgentAccessToken(a)).toBe("acc-123");
  });

  it("fails (and stores nothing) when invoke returns a bad envelope", async () => {
    const a = { transportDir: "/t", slockHome: dir, agentId: "agent-bad" };
    await expect(
      runAgentLogin(a, { invoke: () => ({ status: 0, stdout: JSON.stringify({ ok: false, error: "denied" }), stderr: "" }) }),
    ).rejects.toThrow(/did not succeed/);
    expect(readAgentAccessToken(a)).toBeNull();
  });
});
