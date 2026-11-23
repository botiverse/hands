import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { readLiveRaftRole, resetLiveRoleCache, ROLE_CACHE_MS } from "../src/lib/raft_live_role";
import { liveMembershipRefusal, type AdminAccount } from "../src/middleware/auth";

const env = {
  RAFT_API_ORIGIN: "https://raft.test",
  RAFT_CLIENT_ID: "hands",
  RAFT_CLIENT_SECRET: "secret",
};

type Call = { url: string; method: string; auth: string | null; body: unknown };
let calls: Call[];
let role: unknown;
let roleStatus: number;
let lookupStatus: number;
let tokenSerial: number;

beforeEach(() => {
  resetLiveRoleCache();
  calls = [];
  role = "member";
  roleStatus = 200;
  lookupStatus = 200;
  tokenSerial = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", auth: headers.get("authorization"), body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/api/oauth/installations/lookup")) {
      return lookupStatus === 200
        ? Response.json({ installation_id: "inst-1", server_id: "srv-1" })
        : Response.json({ error: "not_found" }, { status: lookupStatus });
    }
    if (url.endsWith("/api/oauth/installation-token")) {
      tokenSerial += 1;
      return Response.json({ access_token: `itok-${tokenSerial}`, expires_in: 600 });
    }
    if (url.includes("/api/app-installation/members/")) {
      if (roleStatus !== 200) return Response.json({ error: "x" }, { status: roleStatus });
      return Response.json({ role });
    }
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("readLiveRaftRole", () => {
  it("reads the role through Hands' installation with the server group", async () => {
    const result = await readLiveRaftRole(env, "srv-1", "sub-1", 1_000);
    expect(result).toEqual({ ok: true, role: "member" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://raft.test/api/oauth/installations/lookup",
      "https://raft.test/api/oauth/installation-token",
      "https://raft.test/api/app-installation/members/sub-1/role",
    ]);
    expect(calls[0]!.auth).toBe(`Basic ${btoa("hands:secret")}`);
    expect(calls[0]!.body).toEqual({ server_id: "srv-1" });
    expect(calls[1]!.body).toEqual({ installation_id: "inst-1", groups: ["server"] });
    expect(calls[2]!.auth).toBe("Bearer itok-1");
  });

  it("caches a role for at most 60 seconds", async () => {
    await readLiveRaftRole(env, "srv-1", "sub-1", 1_000);
    role = null;
    expect(await readLiveRaftRole(env, "srv-1", "sub-1", 1_000 + ROLE_CACHE_MS - 1)).toEqual({ ok: true, role: "member" });
    expect(await readLiveRaftRole(env, "srv-1", "sub-1", 1_000 + ROLE_CACHE_MS)).toEqual({ ok: true, role: null });
  });

  it("treats an unknown role as below guest", async () => {
    role = "superuser";
    expect(await readLiveRaftRole(env, "srv-1", "sub-1")).toEqual({ ok: true, role: "guest" });
  });

  it("mints the installation token once more after a 401 and reports other errors without a role", async () => {
    await readLiveRaftRole(env, "srv-1", "sub-1", 1_000);
    roleStatus = 401;
    const failed = await readLiveRaftRole(env, "srv-1", "sub-2", 1_000);
    expect(failed).toEqual({ ok: false, reason: "role_401", revoked: true });
    expect(tokenSerial).toBe(2);
    resetLiveRoleCache();
    roleStatus = 503;
    expect(await readLiveRaftRole(env, "srv-1", "sub-3", 1_000)).toEqual({ ok: false, reason: "role_503", revoked: false });
    lookupStatus = 404;
    resetLiveRoleCache();
    expect(await readLiveRaftRole(env, "srv-1", "sub-1", 1_000)).toEqual({ ok: false, reason: "lookup_404", revoked: true });
  });

  it("remembers a failed read per server for 30 seconds", async () => {
    roleStatus = 503;
    await readLiveRaftRole(env, "srv-1", "sub-1", 1_000);
    const made = calls.length;
    roleStatus = 200;
    expect(await readLiveRaftRole(env, "srv-1", "sub-2", 1_000 + 29_999)).toEqual({ ok: false, reason: "role_503", revoked: false });
    expect(calls.length).toBe(made);
    expect(await readLiveRaftRole(env, "srv-1", "sub-2", 1_000 + 30_000)).toEqual({ ok: true, role: "member" });
  });

  it("does nothing without client credentials", async () => {
    expect(await readLiveRaftRole({}, "srv-1", "sub-1")).toEqual({ ok: false, reason: "client_credentials_missing", revoked: false });
    expect(calls).toHaveLength(0);
  });
});

const account = (over: Partial<AdminAccount> = {}): AdminAccount => ({
  id: "acct-1", provider: "raft", provider_subject: "sub-1", server_id: "srv-1", server_slug: "s",
  principal_type: "human", server_role: "member", username: "p", display_name: "P", avatar_url: null,
  raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1, org_id: "raft_srv-1", org_role: "member",
  ...over,
});

async function gate(mode: string, acct: AdminAccount, method = "GET") {
  const writes: { sql: string; args: unknown[] }[] = [];
  const DB = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ run: async () => { writes.push({ sql, args }); return {}; } }) }) };
  const app = new Hono<any>();
  app.all("*", async (c) => (await liveMembershipRefusal(c, acct)) ?? c.json({ ok: true }));
  const res = await app.request("https://app.hands.build/api/x", { method }, { ...env, RAFT_LIVE_ROLE_MODE: mode, DB } as unknown as Env);
  return { res, writes };
}

describe("liveMembershipRefusal", () => {
  it("on: refuses a removed member and drops that organization", async () => {
    role = null;
    const { res, writes } = await gate("on", account());
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe("RAFT_MEMBERSHIP_ENDED");
    expect(writes).toEqual([{ sql: "DELETE FROM org_members WHERE org_id = ?1 AND account_id = ?2", args: ["raft_srv-1", "acct-1"] }]);
  });

  it("on: refuses a guest", async () => {
    role = "guest";
    expect((await gate("on", account())).res.status).toBe(403);
  });

  it("on: keeps a member in and stores a changed role", async () => {
    role = "admin";
    const { res, writes } = await gate("on", account());
    expect(res.status).toBe(200);
    expect(writes[0]).toEqual({ sql: "UPDATE raft_accounts SET server_role = ?1 WHERE id = ?2", args: ["admin", "acct-1"] });
    // The Raft-created membership follows the Raft admin role.
    expect(writes[1]?.sql).toMatch(/^UPDATE org_members SET org_role = \?1/);
    expect(writes[1]?.args).toEqual(["admin", "raft_srv-1", "acct-1"]);
  });

  it("on: Hands no longer installed on the server ends reads too", async () => {
    lookupStatus = 404;
    const read = await gate("on", account(), "GET");
    expect(read.res.status).toBe(403);
    expect((await read.res.json() as { code: string }).code).toBe("RAFT_INSTALLATION_GONE");
  });

  it("maps live Raft roles to the organization role of a Raft-created membership", async () => {
    const { raftOrgRoleFor } = await import("../src/middleware/auth");
    expect(raftOrgRoleFor("owner", "member")).toBe("owner");
    expect(raftOrgRoleFor("admin", "owner")).toBe("admin");
    expect(raftOrgRoleFor("member", "admin")).toBe("member");
    expect(raftOrgRoleFor("member", "owner")).toBe("member");
    expect(raftOrgRoleFor("member", "viewer")).toBeNull();
    expect(raftOrgRoleFor("member", "member")).toBeNull();
  });

  it("on: a read error refuses writes but not reads", async () => {
    roleStatus = 503;
    expect((await gate("on", account(), "GET")).res.status).toBe(200);
    const write = await gate("on", account(), "POST");
    expect(write.res.status).toBe(503);
    expect((await write.res.json() as { code: string }).code).toBe("RAFT_ROLE_UNAVAILABLE");
  });

  it("shadow: reads but refuses nobody and writes nothing", async () => {
    role = null;
    const { res, writes } = await gate("shadow", account());
    expect(res.status).toBe(200);
    expect(writes).toHaveLength(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("skips agents, other organizations and off", async () => {
    role = null;
    expect((await gate("on", account({ principal_type: "agent" }))).res.status).toBe(200);
    expect((await gate("on", account({ org_id: "org-hands-native" }))).res.status).toBe(200);
    expect((await gate("off", account())).res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
