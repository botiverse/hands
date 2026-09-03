import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitAgent,
  agentAuthPath,
  writeAgentSession,
  readAgentAccessToken,
  readAgentApiBase,
  type AgentEnv,
  type AgentSession,
} from "./index.js";

const SERVICE = "example-service";

const SESSION: AgentSession = {
  schema: "raft-cli-agent-session.v1",
  token_type: "Bearer",
  access_token: "acc-123",
  access_expires_at: "2026-08-17T10:00:00.000Z",
  refresh_token: "ref-456",
  refresh_expires_at: "2026-09-16T09:00:00.000Z",
};

function agentEnvAt(slockHome: string, transportDir: string): AgentEnv {
  return { transportDir, slockHome, agentId: "agent-7", raftBin: join(transportDir, "raft") };
}

describe("admission tri-state", () => {
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
    expect(admitAgent({} as NodeJS.ProcessEnv).kind).toBe("human");
  });
  it("complete + executable wrapper → agent pinned to the transport-dir wrapper", () => {
    const a = admitAgent({
      SLOCK_CLI_TRANSPORT_DIR: transport,
      SLOCK_HOME: dir,
      SLOCK_AGENT_ID: "agent-7",
    } as NodeJS.ProcessEnv);
    expect(a.kind).toBe("agent");
    if (a.kind === "agent") expect(a.env.raftBin).toBe(join(transport, "raft"));
  });
  it("partial markers → fail_closed (never human)", () => {
    expect(admitAgent({ SLOCK_HOME: dir, SLOCK_AGENT_ID: "a" } as NodeJS.ProcessEnv).kind).toBe("fail_closed");
  });
  it("invalid agent id → fail_closed", () => {
    const a = admitAgent({
      SLOCK_CLI_TRANSPORT_DIR: transport,
      SLOCK_HOME: dir,
      SLOCK_AGENT_ID: "../evil",
    } as NodeJS.ProcessEnv);
    expect(a.kind).toBe("fail_closed");
  });
  it("missing wrapper → fail_closed", () => {
    const a = admitAgent({
      SLOCK_CLI_TRANSPORT_DIR: join(dir, "nope"),
      SLOCK_HOME: dir,
      SLOCK_AGENT_ID: "agent-7",
    } as NodeJS.ProcessEnv);
    expect(a.kind).toBe("fail_closed");
  });
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(asRoot)("non-executable wrapper → fail_closed", () => {
    chmodSync(join(transport, "raft"), 0o644);
    const a = admitAgent({
      SLOCK_CLI_TRANSPORT_DIR: transport,
      SLOCK_HOME: dir,
      SLOCK_AGENT_ID: "agent-7",
    } as NodeJS.ProcessEnv);
    expect(a.kind).toBe("fail_closed");
  });
});

describe("path containment", () => {
  it("builds the canonical path for the caller-supplied service", () => {
    const a = agentEnvAt("/home/x/.slock", "/t");
    expect(agentAuthPath(a, SERVICE)).toBe(
      `/home/x/.slock/agents/agent-7/integrations/${SERVICE}/auth.json`,
    );
  });
  it("rejects a service slug with traversal / bad chars", () => {
    const a = agentEnvAt("/home/x/.slock", "/t");
    expect(() => agentAuthPath(a, "../escape")).toThrow(/service slug/);
    expect(() => agentAuthPath(a, "UPPER")).toThrow(/service slug/);
  });
  it("requires a service slug — no Hands default", () => {
    const a = agentEnvAt("/home/x/.slock", "/t");
    expect(() => agentAuthPath(a, undefined as unknown as string)).toThrow(/service slug/);
  });
});

describe("atomic store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "store-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes 0600 file under verified-0700 dirs, records api_base, reads back", () => {
    const a = agentEnvAt(dir, "/t");
    const path = writeAgentSession(a, SERVICE, SESSION, "https://api.example", () => "2026-08-17T00:00:00.000Z");
    const rec = JSON.parse(readFileSync(path, "utf8"));
    expect(rec).toMatchObject({
      ...SESSION,
      service: SERVICE,
      api_base: "https://api.example",
      updated_at: "2026-08-17T00:00:00.000Z",
    });
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "agents", "agent-7", "integrations", SERVICE)).mode & 0o077).toBe(0);
    expect(readAgentAccessToken(a, SERVICE)).toBe("acc-123");
    expect(readAgentApiBase(a, SERVICE)).toBe("https://api.example");
  });

  it("repairs a pre-existing wide integrations dir to 0700", () => {
    const a = agentEnvAt(dir, "/t");
    const wide = join(dir, "agents", "agent-7", "integrations");
    mkdirSync(wide, { recursive: true, mode: 0o777 });
    chmodSync(wide, 0o777);
    writeAgentSession(a, SERVICE, SESSION, "https://api.example");
    expect(statSync(wide).mode & 0o077).toBe(0);
  });

  it("does not read another service's token", () => {
    const a = agentEnvAt(dir, "/t");
    writeAgentSession(a, SERVICE, SESSION, "https://api.example");
    expect(readAgentAccessToken(a, "other-service")).toBeNull();
  });
});
