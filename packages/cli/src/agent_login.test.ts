/**
 * CP3 agent-login: hardened flow + isolation. Covers Volta's 5 findings —
 * V1 admission tri-state, V3 fixed-service + validation + path containment,
 * V4 strict non-leaking parse, V5 hardened atomic store — plus the full flow.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import {
  admitAgent,
  agentAuthPath,
  readAgentAccessToken,
  readAgentApiBase,
  HANDS_SERVICE,
  type AgentEnv,
} from "./lib/agent_env.js";
import {
  generatePkce,
  parseAgentLoginInvoke,
  parseAgentSession,
  writeAgentSession,
  runAgentLogin,
  type AgentSession,
} from "./lib/agent_auth.js";

const T0 = 1_700_000_000_000; // fixed clock (ms)
const GRANT_EXPIRES = new Date(T0 + 200_000).toISOString(); // <=300s future

function agentEnvAt(slockHome: string, transportDir: string): AgentEnv {
  return { transportDir, slockHome, agentId: "agent-7", raftBin: join(transportDir, "raft") };
}

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
        expires_at: GRANT_EXPIRES,
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

describe("V1 admission tri-state", () => {
  let dir: string;
  let transport: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "admit-"));
    transport = join(dir, "transport");
    mkdirSync(transport, { recursive: true });
    writeFileSync(join(transport, "raft"), "#!/bin/sh\n", { mode: 0o755 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("no markers → human", () => {
    expect(admitAgent({} as any).kind).toBe("human");
  });
  it("complete + executable wrapper → agent pinned to the transport-dir wrapper", () => {
    const a = admitAgent({ SLOCK_CLI_TRANSPORT_DIR: transport, SLOCK_HOME: dir, SLOCK_AGENT_ID: "agent-7" } as any);
    expect(a.kind).toBe("agent");
    if (a.kind === "agent") expect(a.env.raftBin).toBe(join(transport, "raft"));
  });
  it("partial markers → fail_closed (never human)", () => {
    expect(admitAgent({ SLOCK_HOME: dir, SLOCK_AGENT_ID: "a" } as any).kind).toBe("fail_closed");
  });
  it("invalid agent id → fail_closed", () => {
    const a = admitAgent({ SLOCK_CLI_TRANSPORT_DIR: transport, SLOCK_HOME: dir, SLOCK_AGENT_ID: "../evil" } as any);
    expect(a.kind).toBe("fail_closed");
  });
  it("missing wrapper → fail_closed", () => {
    const a = admitAgent({ SLOCK_CLI_TRANSPORT_DIR: join(dir, "nope"), SLOCK_HOME: dir, SLOCK_AGENT_ID: "agent-7" } as any);
    expect(a.kind).toBe("fail_closed");
  });
  // Root bypasses the X_OK permission bit, so this assertion is only meaningful as a
  // non-root user.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(asRoot)("non-executable wrapper → fail_closed", () => {
    chmodSync(join(transport, "raft"), 0o644);
    const a = admitAgent({ SLOCK_CLI_TRANSPORT_DIR: transport, SLOCK_HOME: dir, SLOCK_AGENT_ID: "agent-7" } as any);
    expect(a.kind).toBe("fail_closed");
  });
});

describe("V3 path containment + fixed service", () => {
  it("builds the canonical path for the compiled service", () => {
    const a = agentEnvAt("/home/x/.slock", "/t");
    expect(agentAuthPath(a)).toBe(`/home/x/.slock/agents/agent-7/integrations/${HANDS_SERVICE}/auth.json`);
  });
  it("rejects a service slug with traversal / bad chars", () => {
    const a = agentEnvAt("/home/x/.slock", "/t");
    expect(() => agentAuthPath(a, "../escape")).toThrow(/service slug/);
    expect(() => agentAuthPath(a, "UPPER")).toThrow(/service slug/);
  });
});

describe("PKCE", () => {
  it("verifier is RFC 7636 valid; challenge = base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });
});

describe("V4 strict, non-leaking invoke parse", () => {
  it("accepts a well-formed envelope", () => {
    expect(parseAgentLoginInvoke(invokeEnvelope(), HANDS_SERVICE, T0)).toEqual({ grant: "opaque-grant", expires_at: GRANT_EXPIRES });
  });
  it("requires ok=true / service / action / status=200", () => {
    expect(() => parseAgentLoginInvoke(JSON.stringify({ ok: false }), HANDS_SERVICE, T0)).toThrow(/did not succeed/);
    expect(() => parseAgentLoginInvoke(invokeEnvelope({ service: "hands-other" }), HANDS_SERVICE, T0)).toThrow(/service/);
    expect(() => parseAgentLoginInvoke(invokeEnvelope({ action: "whoami" }), HANDS_SERVICE, T0)).toThrow(/action/);
    expect(() => parseAgentLoginInvoke(invokeEnvelope({ status: 500 }), HANDS_SERVICE, T0)).toThrow(/HTTP 200/);
  });
  it("closed-key: rejects extension fields in the grant result", () => {
    expect(() => parseAgentLoginInvoke(invokeEnvelope({}, { extra: "x" }), HANDS_SERVICE, T0)).toThrow(/unexpected fields/);
  });
  it("validates expires_at: RFC3339, strictly future, <=300s", () => {
    expect(() => parseAgentLoginInvoke(invokeEnvelope({}, { expires_at: "nope" }), HANDS_SERVICE, T0)).toThrow(/RFC3339/);
    expect(() => parseAgentLoginInvoke(invokeEnvelope({}, { expires_at: new Date(T0 - 1000).toISOString() }), HANDS_SERVICE, T0)).toThrow(/already expired/);
    expect(() => parseAgentLoginInvoke(invokeEnvelope({}, { expires_at: new Date(T0 + 400_000).toISOString() }), HANDS_SERVICE, T0)).toThrow(/300s/);
  });
  it("NEVER echoes raw stdout in error messages (no credential leak)", () => {
    const secret = "SECRET-grant-payload-should-not-appear";
    try {
      parseAgentLoginInvoke(JSON.stringify({ ok: false, error: secret, data: { result: { grant: secret } } }), HANDS_SERVICE, T0);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});

describe("V4 strict session parse", () => {
  it("accepts a valid session and null refresh expiry", () => {
    expect(parseAgentSession(SESSION)).toEqual(SESSION);
    expect(parseAgentSession({ ...SESSION, refresh_expires_at: null }).refresh_expires_at).toBeNull();
  });
  it("rejects extension fields, bad schema/token_type/expiry", () => {
    expect(() => parseAgentSession({ ...SESSION, extra: 1 })).toThrow(/unexpected fields/);
    expect(() => parseAgentSession({ ...SESSION, token_type: "Basic" })).toThrow(/token_type/);
    expect(() => parseAgentSession({ ...SESSION, access_expires_at: "nope" })).toThrow(/RFC3339/);
  });
});

describe("V5 hardened atomic store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "store-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes 0600 file under verified-0700 dirs, records api_base, reads back", () => {
    const a = agentEnvAt(dir, "/t");
    const path = writeAgentSession(a, HANDS_SERVICE, SESSION, "https://api.example", () => "2026-08-17T00:00:00.000Z");
    const rec = JSON.parse(readFileSync(path, "utf8"));
    expect(rec).toMatchObject({ ...SESSION, service: HANDS_SERVICE, api_base: "https://api.example", updated_at: "2026-08-17T00:00:00.000Z" });
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "agents", "agent-7", "integrations", HANDS_SERVICE)).mode & 0o077).toBe(0);
    expect(readAgentAccessToken(a)).toBe("acc-123");
    expect(readAgentApiBase(a)).toBe("https://api.example");
  });

  it("repairs a pre-existing wide integrations dir to 0700", () => {
    const a = agentEnvAt(dir, "/t");
    const wide = join(dir, "agents", "agent-7", "integrations");
    mkdirSync(wide, { recursive: true, mode: 0o777 });
    chmodSync(wide, 0o777);
    writeAgentSession(a, HANDS_SERVICE, SESSION, "https://api.example");
    expect(statSync(wide).mode & 0o077).toBe(0);
  });
});

describe("runAgentLogin (full flow via pinned wrapper)", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let exchangeBody: any;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "flow-"));
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        exchangeBody = JSON.parse(raw || "{}");
        if (req.url === "/api/auth/agent/exchange" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(SESSION));
        } else { res.writeHead(404); res.end("{}"); }
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

  it("invokes → exchanges → stores; sends a verifier not the challenge", async () => {
    const a = agentEnvAt(dir, "/t");
    let invoked: string[] = [];
    const session = await runAgentLogin(a, {
      now: T0,
      invoke: (args) => { invoked = args; return { status: 0, stdout: invokeEnvelope(), stderr: "" }; },
    });
    expect(invoked).toContain("agent-login");
    expect(exchangeBody.schema).toBe("raft-cli-agent-login-exchange.v1");
    expect(exchangeBody.grant).toBe("opaque-grant");
    expect(exchangeBody.code_verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(session).toEqual(SESSION);
    expect(readAgentAccessToken(a)).toBe("acc-123");
    expect(readAgentApiBase(a)).toBe(base);
  });

  it("rejects a non-zero invoke exit and stores nothing", async () => {
    const a = agentEnvAt(dir, "/t");
    await expect(runAgentLogin(a, { now: T0, invoke: () => ({ status: 1, stdout: invokeEnvelope(), stderr: "boom" }) }))
      .rejects.toThrow(/non-zero status/);
    expect(existsSync(agentAuthPath(a))).toBe(false);
  });
});

const ENV_KEYS = ["SLOCK_CLI_TRANSPORT_DIR", "SLOCK_HOME", "SLOCK_AGENT_ID", "HANDS_AUTH_TOKEN", "XDG_CONFIG_HOME"] as const;
function saveEnv() {
  const s: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return () => { for (const k of ENV_KEYS) { if (s[k] === undefined) delete process.env[k]; else process.env[k] = s[k]!; } };
}
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("V2 per-agent credential isolation (config.resolveAuthToken)", () => {
  let dir: string;
  let transport: string;
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv();
    dir = mkdtempSync(join(tmpdir(), "iso-"));
    transport = join(dir, "transport");
    mkdirSync(transport, { recursive: true });
    writeFileSync(join(transport, "raft"), "#!/bin/sh\n", { mode: 0o755 });
    process.env.SLOCK_CLI_TRANSPORT_DIR = transport;
    process.env.SLOCK_HOME = dir;
    process.env.SLOCK_AGENT_ID = "agent-7";
    process.env.HANDS_AUTH_TOKEN = "ambient-human-token"; // must be IGNORED in agent mode
    process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  });
  afterEach(() => { restore(); rmSync(dir, { recursive: true, force: true }); });

  it("agent mode with a store → the agent token, never the ambient HANDS_AUTH_TOKEN", async () => {
    const { resolveAuthToken } = await import("./lib/config.js");
    writeAgentSession(agentEnvAt(dir, transport), HANDS_SERVICE, SESSION, "https://api.example");
    expect(resolveAuthToken()).toBe("acc-123");
  });
  it("agent mode with no store → undefined (require login; no ambient fallback)", async () => {
    const { resolveAuthToken } = await import("./lib/config.js");
    expect(resolveAuthToken()).toBeUndefined();
  });
});

describe("B quiver→hands config migration (human path)", () => {
  let dir: string;
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv();
    dir = mkdtempSync(join(tmpdir(), "mig-"));
    for (const k of ["SLOCK_CLI_TRANSPORT_DIR", "SLOCK_HOME", "SLOCK_AGENT_ID", "HANDS_AUTH_TOKEN"] as const) delete process.env[k];
    process.env.XDG_CONFIG_HOME = dir;
  });
  afterEach(() => { try { chmodSync(dir, 0o700); } catch { /* ignore */ } restore(); rmSync(dir, { recursive: true, force: true }); });

  it("migrates legacy ~/.config/quiver/auth.json to the hands path on first read", async () => {
    mkdirSync(join(dir, "quiver"), { recursive: true });
    writeFileSync(join(dir, "quiver", "auth.json"), JSON.stringify({ authToken: "legacy", apiBase: "https://legacy" }));
    const { getConfig, configPath } = await import("./lib/config.js");
    expect(getConfig().authToken).toBe("legacy");
    expect(existsSync(configPath())).toBe(true);
    expect(JSON.parse(readFileSync(configPath(), "utf8")).authToken).toBe("legacy");
  });

  it.skipIf(isRoot)("keeps legacy credentials when the migration write fails", async () => {
    mkdirSync(join(dir, "quiver"), { recursive: true });
    writeFileSync(join(dir, "quiver", "auth.json"), JSON.stringify({ authToken: "legacy" }));
    chmodSync(dir, 0o500); // read-only: creating the hands/ dir fails
    const { getConfig } = await import("./lib/config.js");
    expect(getConfig().authToken).toBe("legacy"); // old credentials still usable
  });
});
