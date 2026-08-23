import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

// The overview handler does its own DB work via this helper; stub it so the test can
// focus on the audit write.
vi.mock("../src/observability_rpc", () => ({
  getCachedHandsObservabilityOverview: vi.fn(async () => ({ summary: {}, storage: {} })),
}));

import { handleHandsAdminOverview } from "../src/routes/hands_admin";

// Minimal D1 shim over better-sqlite3 (same `?N`-normalization as routes.test.ts) so the
// handler's real INSERT executes against a real SQLite table and we can read the row back.
function makeDb() {
  const sqlite = new Database(":memory:");
  // Real 0063 shape (FK to raft_accounts omitted — not under test; the CHECKs are kept).
  sqlite.exec(`
    CREATE TABLE hands_admin_access_audit (
      id                TEXT PRIMARY KEY,
      actor_account_id  TEXT,
      actor_type        TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
      server_id         TEXT NOT NULL,
      action            TEXT NOT NULL CHECK (action = 'overview.view'),
      created_at        INTEGER NOT NULL
    );
  `);
  const d1 = {
    prepare(sql: string) {
      const seq: number[] = [];
      const norm = sql.replace(/\?(\d+)/g, (_m, n) => {
        seq.push(Number(n));
        return "?";
      });
      const stmt = sqlite.prepare(norm);
      const bind = (...p: unknown[]) => {
        const ex = seq.length ? seq.map((n) => p[n - 1]) : p;
        return {
          run: async () => ({ success: true, meta: { changes: stmt.run(...ex).changes } }),
          all: async () => ({ results: stmt.all(...ex), success: true }),
          first: async () => (stmt.all(...ex)[0] ?? null),
        };
      };
      return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
    },
  };
  return { d1, sqlite };
}

// The audit must record the identity the authorization decision actually used —
// authenticated_account (the session identity) — NOT admin_account, which is the
// org-switchable (x-hands-org-id) view. This sets the two DIFFERENT, runs the real INSERT,
// and reads the row back. Mutating the handler to admin_account records the switched
// id/server and fails this (verified: the CHANGES-requested tooth).
describe("handleHandsAdminOverview audit (D1 readback)", () => {
  it("writes exactly one audit row recording authenticated_account, not the org-switched admin_account", async () => {
    const { d1, sqlite } = makeDb();
    const authed = { id: "authed-1", principal_type: "agent", server_id: "server-authed" };
    const switched = { id: "switched-2", principal_type: "human", server_id: "server-switched" };
    const c = {
      get: (k: string) =>
        k === "authenticated_account" ? authed : k === "admin_account" ? switched : undefined,
      env: { DB: d1 },
      json: (x: unknown) => x,
    } as unknown as Parameters<typeof handleHandsAdminOverview>[0];

    await handleHandsAdminOverview(c);

    const rows = sqlite
      .prepare("SELECT actor_account_id, actor_type, server_id, action FROM hands_admin_access_audit")
      .all() as Array<{ actor_account_id: string; actor_type: string; server_id: string; action: string }>;
    expect(rows).toHaveLength(1); // "actually wrote" coverage
    const row = rows[0];
    if (!row) throw new Error("expected exactly one audit row");
    expect(row.actor_account_id).toBe("authed-1"); // authenticated identity, NOT switched-2
    expect(row.actor_type).toBe("agent");
    expect(row.server_id).toBe("server-authed"); // authenticated server, NOT server-switched
    expect(row.action).toBe("overview.view");
    // Explicit anti-regression: the org-switched view must NOT be what's recorded.
    expect(row.actor_account_id).not.toBe("switched-2");
    expect(row.server_id).not.toBe("server-switched");
  });
});
