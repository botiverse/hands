// Account-mode Login with Raft (RFC 079): a login that carries no server
// stands for the person on every server /api/oauth/servers lists.
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { raftLoginIdentities, signInRaftIdentities, type RaftUserinfo } from "../src/routes/auth";
import { requireHandsAdmin } from "../src/middleware/hands_admin";
import type { AdminAccount, AdminEnv } from "../src/middleware/auth";

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(
      sql.replace(/\?(\d+)/g, (_m, index) => {
        indexes.push(Number(index));
        return "?";
      }),
    );
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      const runSync = () => ({ success: true, meta: { changes: statement.run(...expanded).changes } });
      return {
        _batchSync: () => (statement.reader ? { success: true, results: statement.all(...expanded) } : runSync()),
        run: async () => runSync(),
        all: async () => ({ success: true, results: statement.all(...expanded) }),
        first: async (column?: string) => {
          const row = statement.get(...expanded) as Record<string, unknown> | undefined;
          return column ? row?.[column] ?? null : row ?? null;
        },
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  return {
    prepare,
    batch: async (statements: Array<{ _batchSync: () => unknown }>) =>
      sqlite.transaction(() => statements.map((statement) => statement._batchSync()))(),
  } as unknown as D1Database;
}

function openDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  }
  return { sqlite, db: d1(sqlite) };
}

const API = "https://api.raft.example";

const accountUserinfo: RaftUserinfo = {
  sub: "user-1",
  type: "human",
  scope: "openid profile",
  client_id: "hands",
  client_name: "Hands",
  preferred_username: "artin",
  name: "Artin",
};

function mockServers(servers: unknown[], status = 200) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url === `${API}/api/oauth/servers`) return Response.json({ servers }, { status });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("raftLoginIdentities", () => {
  it("keeps a server-mode login to its own server without asking for servers", async () => {
    const fetchMock = mockServers([]);
    const identities = await raftLoginIdentities({} as Env, API, "tok", {
      ...accountUserinfo, server_id: "srv-a", server_slug: "alpha", server_role: "owner",
    });
    expect(identities).toEqual([
      { identity: expect.objectContaining({ server_id: "srv-a", server_slug: "alpha", server_role: "owner" }), serverName: null, accountMode: false },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists one identity per server for an account-mode login, with that server's role", async () => {
    const fetchMock = mockServers([
      { id: "srv-a", slug: "alpha", name: "Alpha Co", role: "owner" },
      { id: "srv-b", slug: "beta", name: "Beta Co", role: "member" },
    ]);
    const identities = await raftLoginIdentities({} as Env, API, "tok", accountUserinfo);
    expect(identities.map(({ identity, serverName }) => [identity.server_id, identity.server_slug, identity.server_role, serverName]))
      .toEqual([["srv-a", "alpha", "owner", "Alpha Co"], ["srv-b", "beta", "member", "Beta Co"]]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${API}/api/oauth/servers`);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("drops servers outside the allow list", async () => {
    mockServers([
      { id: "srv-a", slug: "alpha", name: "Alpha Co", role: "owner" },
      { id: "srv-b", slug: "beta", name: "Beta Co", role: "member" },
    ]);
    const identities = await raftLoginIdentities({ RAFT_ALLOWED_SERVER_SLUGS: "beta" } as Env, API, "tok", accountUserinfo);
    expect(identities.map(({ identity }) => identity.server_id)).toEqual(["srv-b"]);
  });

  it("fails the login when Raft refuses the servers list", async () => {
    mockServers([], 401);
    await expect(raftLoginIdentities({} as Env, API, "tok", accountUserinfo)).rejects.toThrow(/Raft servers failed \(401\)/);
  });
});

describe("signInRaftIdentities", () => {
  const identities = [
    { identity: { ...accountUserinfo, server_id: "srv-a", server_slug: "alpha", server_role: "member" }, serverName: "Alpha Co", accountMode: true },
    { identity: { ...accountUserinfo, server_id: "srv-b", server_slug: "beta", server_role: "admin" }, serverName: "Beta Co", accountMode: true },
  ];

  it("creates an account and organization membership on every server, named after the server", async () => {
    const { sqlite, db } = openDb();
    const account = await signInRaftIdentities(db, identities);
    expect(account?.server_id).toBe("srv-a");
    const rows = sqlite.prepare(
      `SELECT a.server_id, a.server_role, o.id AS org_id, o.name, o.raft_name, om.org_role
       FROM raft_accounts a
       JOIN org_members om ON om.account_id = a.id
       JOIN organizations o ON o.id = om.org_id
       WHERE a.provider_subject = 'user-1' ORDER BY a.server_id`,
    ).all();
    expect(rows).toEqual([
      // A Raft member stays a member even as the first person Hands sees on the
      // server: an account-mode login picked no server.
      { server_id: "srv-a", server_role: "member", org_id: "raft_srv-a", name: "Alpha Co", raft_name: "Alpha Co", org_role: "member" },
      { server_id: "srv-b", server_role: "admin", org_id: "raft_srv-b", name: "Beta Co", raft_name: "Beta Co", org_role: "admin" },
    ]);
  });

  it("starts the session in the organization signed in to most recently", async () => {
    const { db } = openDb();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await signInRaftIdentities(db, [identities[0]!]);
    vi.setSystemTime(2_000_000);
    await signInRaftIdentities(db, [identities[1]!]);
    vi.setSystemTime(3_000_000);
    const account = await signInRaftIdentities(db, identities);
    expect(account?.server_id).toBe("srv-b");
    expect(account?.org_id).toBe("raft_srv-b");
  });

  it("keeps the first-sign-in owner rule for a server-mode login", async () => {
    const { sqlite, db } = openDb();
    await signInRaftIdentities(db, [{ ...identities[0]!, accountMode: false }]);
    expect(sqlite.prepare("SELECT org_role FROM org_members WHERE org_id = 'raft_srv-a'").get()).toEqual({ org_role: "owner" });
  });

  it("keeps a name set in Hands", async () => {
    const { sqlite, db } = openDb();
    await signInRaftIdentities(db, identities);
    sqlite.prepare("UPDATE organizations SET name = 'Ours', name_customized = 1 WHERE id = 'raft_srv-a'").run();
    await signInRaftIdentities(db, [{ ...identities[0]!, serverName: "Alpha Renamed" }]);
    expect(sqlite.prepare("SELECT name, raft_name FROM organizations WHERE id = 'raft_srv-a'").get())
      .toEqual({ name: "Ours", raft_name: "Alpha Renamed" });
  });

  it("returns no account when the login reaches no allowed server", async () => {
    const { db } = openDb();
    expect(await signInRaftIdentities(db, [])).toBeNull();
  });
});

describe("Hands admin after an account-mode login", () => {
  function adminApp(db: D1Database, account: () => AdminAccount) {
    const app = new Hono<AdminEnv & { Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("authenticated_account", account());
      await next();
    });
    app.get("/admin", requireHandsAdmin, (c) => c.text("ok"));
    const env = { DB: db, HANDS_ADMIN_ALLOWED_SERVER_IDS: "srv-b" } as unknown as Env;
    return (path = "/admin") => app.request(path, {}, env);
  }

  it("admits a person whose session started on another server of the same login", async () => {
    const { db } = openDb();
    const sessionAccount = await signInRaftIdentities(db, [
      { identity: { ...accountUserinfo, server_id: "srv-a", server_slug: "alpha", server_role: "member" }, serverName: null, accountMode: true },
      { identity: { ...accountUserinfo, server_id: "srv-b", server_slug: "beta", server_role: "owner" }, serverName: null, accountMode: true },
    ]);
    expect(sessionAccount?.server_id).toBe("srv-a");
    const res = await adminApp(db, () => sessionAccount!)();
    expect(res.status).toBe(200);
  });

  it("does not count an owner role from an older, separate login", async () => {
    const { db } = openDb();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await signInRaftIdentities(db, [
      { identity: { ...accountUserinfo, server_id: "srv-b", server_slug: "beta", server_role: "owner" }, serverName: null, accountMode: true },
    ]);
    vi.setSystemTime(10_000_000);
    const sessionAccount = await signInRaftIdentities(db, [
      { identity: { ...accountUserinfo, server_id: "srv-a", server_slug: "alpha", server_role: "member" }, serverName: null, accountMode: true },
    ]);
    const res = await adminApp(db, () => sessionAccount!)();
    expect(res.status).toBe(403);
  });

  it("does not count a member role on the admin server", async () => {
    const { db } = openDb();
    const sessionAccount = await signInRaftIdentities(db, [
      { identity: { ...accountUserinfo, server_id: "srv-a", server_slug: "alpha", server_role: "owner" }, serverName: null, accountMode: true },
      { identity: { ...accountUserinfo, server_id: "srv-b", server_slug: "beta", server_role: "member" }, serverName: null, accountMode: true },
    ]);
    const res = await adminApp(db, () => sessionAccount!)();
    expect(res.status).toBe(403);
  });
});
