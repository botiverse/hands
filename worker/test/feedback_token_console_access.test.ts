/**
 * A role-free deploy token carrying `feedback:read` / `feedback:comment` can use
 * the console feedback endpoints, so an integration can pull tickets and answer
 * users without holding `publisher` (which also publishes releases).
 *
 * The load-bearing property is the negative one. Those same two permissions are
 * what reporter-integration tokens carry, and such a token is confined by the
 * reporter API to the tickets it proxies. Scope comes from the **binding**, not
 * from the permission name — so a bound token must not reach these routes, or it
 * would gain the whole app's feedback.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { requireAppRoleOrFeedbackPermission } from "../src/lib/permissions";
import { generateDeployToken, hashDeployToken } from "../src/lib/deploy_tokens";
import { handleAddFeedbackComment, handleListFeedback } from "../src/routes/feedback";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const INTEGRATION = "33333333-3333-4333-8333-333333333333";
const TICKET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type BoundStatement = {
  _execute: () => { results: unknown[]; success: true; meta: { changes: number } };
  run: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  first: <T>() => Promise<T | null>;
};

/** Mirrors the D1 shim used by the other route tests, including ?N placeholders. */
function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_match, index) => {
      indexes.push(Number(index));
      return "?";
    });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]): BoundStatement => {
      const params = (indexes.length > 0 ? indexes.map((index) => input[index - 1]) : input)
        .map((value) => value === undefined ? null : value);
      const execute = () => {
        if (statement.reader) {
          return { results: statement.all(...params), success: true as const, meta: { changes: 0 } };
        }
        const info = statement.run(...params);
        return { results: [], success: true as const, meta: { changes: info.changes } };
      };
      return {
        _execute: execute,
        run: async () => execute(),
        all: async () => execute(),
        first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: <T>() => bind().first<T>() };
  };
  return {
    prepare,
    batch: async (statements: BoundStatement[]) =>
      db.transaction(() => statements.map((statement) => statement._execute()))(),
  };
}

function environment() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  sqlite.prepare(
    `INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
     VALUES ('org', 'org', 'Org', 'raft', 'server', 1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
     VALUES ('app-a', 'org', 'app-a', 'App A', 'electron', 'client-key', 1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at)
     VALUES (?, 'app-a', 'inbox', 1, 1)`,
  ).run(INTEGRATION);
  sqlite.prepare(
    `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
     VALUES (?, 'app-a', 'feedback', 'open', 'ticket', '{}', ?, ?, 1, 1)`,
  ).run(TICKET, "r".repeat(32), INTEGRATION);

  const env = {
    DB: d1(sqlite),
    ENVIRONMENT: "production",
    DASHBOARD_ORIGIN: "https://dashboard.example",
    FEEDBACK_AUDIT_HMAC_KEY: "console-access-test-audit-key-with-enough-entropy",
    FEEDBACK_AUDIT_KEY_VERSION: "test-v1",
  } as unknown as Env;
  return { sqlite, env };
}

async function issueToken(
  sqlite: Database.Database,
  opts: { name: string; role: string | null; scopes: string | null; boundTo?: string | null },
) {
  const token = generateDeployToken();
  sqlite.prepare(
    `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at, reporter_integration_id)
     VALUES (?, 'app-a', ?, ?, ?, ?, ?, 'test', 1, ?)`,
  ).run(
    opts.name, opts.name, token.token_prefix, await hashDeployToken(token.token),
    opts.role, opts.scopes, opts.boundTo ?? null,
  );
  return token.token;
}

function app() {
  const mini = new Hono<any>();
  mini.use("*", authMiddleware);
  mini.get(
    "/api/apps/:appId/feedback",
    requireAppRoleOrFeedbackPermission("viewer", "feedback:read"),
    handleListFeedback,
  );
  mini.post(
    "/api/apps/:appId/feedback/:ticketId/comments",
    requireAppRoleOrFeedbackPermission("publisher", "feedback:comment"),
    handleAddFeedbackComment,
  );
  return mini;
}

const list = (mini: ReturnType<typeof app>, token: string, env: Env) => mini.request(
  "https://hands.test/api/apps/app-a/feedback",
  { headers: { authorization: `Bearer ${token}` } },
  env,
);

const comment = (mini: ReturnType<typeof app>, token: string, env: Env, body: unknown) => mini.request(
  `https://hands.test/api/apps/app-a/feedback/${TICKET}/comments`,
  {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  },
  env,
);

describe("the tested wiring is the shipped wiring", () => {
  // These tests build their own mini-app, so they can pass while index.ts is
  // wired differently. That is not hypothetical: the attachment route was left
  // on requireAppRole("viewer") in the first pass and nothing here noticed,
  // because nothing here reads the real registrations.
  //
  // Route strings are matched with their quotes, so a prefix such as
  // "/api/apps/:appId/feedback/crash-groups" cannot satisfy the bare list route.
  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  // The window must END AT THE NEXT REGISTRATION, not after N characters. With a
  // fixed width it can spill into the neighbouring route, and since adjacent
  // feedback routes carry the *same* permission string, the neighbour then
  // satisfies the assertion for a route that does not have it. The earlier
  // 300-char version only reddened under mutation by 7 characters of margin —
  // reflowing a nearby registration would have turned it green while the route
  // was wired wrong. A guard whose failure mode is "reports green" is worse than
  // no guard, because it stops the next person looking.
  const registrationFor = (route: string) => {
    const at = indexSource.indexOf('"' + route + '"');
    expect(at).toBeGreaterThan(-1);
    const next = indexSource.indexOf("admin.", at);
    return indexSource.slice(at, next === -1 ? indexSource.length : next);
  };

  it.each([
    ["/api/apps/:appId/feedback", "feedback:read"],
    ["/api/apps/:appId/feedback/material-delta", "feedback:read"],
    ["/api/apps/:appId/feedback/:ticketId", "feedback:read"],
    ["/api/apps/:appId/feedback/:ticketId/attachments/:attachmentId", "feedback:read"],
    ["/api/apps/:appId/feedback/:ticketId/comments", "feedback:comment"],
  ])("registers %s so a feedback token can use it (%s)", (route, permission) => {
    expect(registrationFor(route)).toContain('"' + permission + '"');
  });
});

describe("console feedback access for role-free tokens", () => {
  it("admits an unbound token holding feedback:read", async () => {
    const { sqlite, env } = environment();
    const token = await issueToken(sqlite, {
      name: "support", role: null, scopes: '["feedback:read","feedback:comment"]',
    });
    expect((await list(app(), token, env)).status).toBe(200);
  });

  it("rejects the SAME permission when the token is bound to a reporter integration", async () => {
    // The whole point of the guard. A bound token holds feedback:read to read
    // the tickets it proxies; letting it through here would hand it every
    // ticket in the app.
    const { sqlite, env } = environment();
    const token = await issueToken(sqlite, {
      name: "reporter", role: null, scopes: '["feedback:read"]', boundTo: INTEGRATION,
    });
    expect((await list(app(), token, env)).status).toBe(403);
  });

  it("keeps rejecting a bound token after its integration is archived", async () => {
    // Archiving is a downgrade, and it must not become an upgrade.
    //
    // `reporter_integration_active` is NULL for a non-reporter token and 0 for a
    // bound token whose integration was archived, so a falsy test (`!active`)
    // reads both as "unbound" and would promote an archived reporter token from
    // its own tickets to the app's entire feedback. The binding itself
    // (`reporter_integration_id`) is the only criterion that survives archiving.
    //
    // Asserted as the consequence: archiving widens nothing. Rewriting the guard
    // in any equivalent-looking way that reintroduces the conflation reddens here.
    const { sqlite, env } = environment();
    const token = await issueToken(sqlite, {
      name: "reporter", role: null, scopes: '["feedback:read"]', boundTo: INTEGRATION,
    });
    sqlite.prepare(
      "UPDATE app_reporter_integrations SET archived_at = 2 WHERE id = ?",
    ).run(INTEGRATION);
    expect((await list(app(), token, env)).status).toBe(403);
  });

  it("still admits an ordinary viewer-role token", async () => {
    const { sqlite, env } = environment();
    const token = await issueToken(sqlite, { name: "viewer", role: "viewer", scopes: null });
    expect((await list(app(), token, env)).status).toBe(200);
  });

  it("grants no release rights along with feedback access", async () => {
    // The reason this key exists: replying to users must not require publisher.
    const { sqlite, env } = environment();
    const token = await issueToken(sqlite, {
      name: "support", role: null, scopes: '["feedback:read","feedback:comment"]',
    });
    const mini = new Hono<any>();
    mini.use("*", authMiddleware);
    mini.get(
      "/api/apps/:appId/releases",
      requireAppRoleOrFeedbackPermission("publisher", "app:publish"),
      (c) => c.json({ ok: true }),
    );
    const response = await mini.request(
      "https://hands.test/api/apps/app-a/releases",
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(response.status).toBe(403);
  });
});

describe("feedback:read alone carries no write capability", () => {
  // Asked for directly by a consumer building a read-only patrol agent. Stated
  // as what the grant CANNOT do, so it stays true as routes are added: a new
  // write route that forgets its guard fails here rather than shipping.
  const readOnly = (sqlite: Database.Database) => issueToken(sqlite, {
    name: "readonly", role: null, scopes: '["feedback:read"]',
  });

  it("cannot reply to the reporter", async () => {
    const { sqlite, env } = environment();
    const token = await readOnly(sqlite);
    expect((await comment(app(), token, env, { body: "hi" })).status).toBe(403);
  });

  it("cannot write an internal note", async () => {
    const { sqlite, env } = environment();
    const token = await readOnly(sqlite);
    expect((await comment(app(), token, env, { body: "note", internal: true })).status).toBe(403);
  });

  it("writes nothing to the database on any attempt", async () => {
    const { sqlite, env } = environment();
    const token = await readOnly(sqlite);
    await comment(app(), token, env, { body: "hi" });
    await comment(app(), token, env, { body: "note", internal: true });
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS n FROM feedback_comments",
    ).get()).toMatchObject({ n: 0 });
  });
});

describe("public reply versus internal note", () => {
  const support = (sqlite: Database.Database) => issueToken(sqlite, {
    name: "support", role: null, scopes: '["feedback:read","feedback:comment"]',
  });

  it("lets a feedback token reply to the reporter", async () => {
    const { sqlite, env } = environment();
    const token = await support(sqlite);
    const response = await comment(app(), token, env, { body: "we are on it" });
    expect(response.status).toBe(201);
    expect(sqlite.prepare(
      "SELECT internal FROM feedback_comments WHERE ticket_id = ?",
    ).get(TICKET)).toMatchObject({ internal: 0 });
  });

  it("refuses to let a feedback token write an internal note", async () => {
    const { sqlite, env } = environment();
    const token = await support(sqlite);
    const response = await comment(app(), token, env, { body: "staff only", internal: true });
    expect(response.status).toBe(403);
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS n FROM feedback_comments WHERE ticket_id = ?",
    ).get(TICKET)).toMatchObject({ n: 0 });
  });

  it("rejects a non-boolean internal instead of guessing what it meant", async () => {
    const { sqlite, env } = environment();
    const token = await support(sqlite);
    for (const value of ["true", "false", 1, 0, {}, []]) {
      const response = await comment(app(), token, env, { body: "text", internal: value });
      expect(response.status).toBe(400);
    }
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS n FROM feedback_comments WHERE ticket_id = ?",
    ).get(TICKET)).toMatchObject({ n: 0 });
  });

  it("never lets a truthy non-boolean become a reply the user receives", async () => {
    // The invariant, not the mechanism. Coercing instead of rejecting would send
    // `internal:"true"` — the ordinary way a client mis-serialises a boolean —
    // to the customer as a public reply. Asserting the consequence means that
    // relaxing the 400 into a default cannot go green quietly: someone would
    // have to state that `internal:"true"` now reaches the user.
    const { sqlite, env } = environment();
    const token = await support(sqlite);
    for (const value of ["true", 1, "1", "yes", {}, []]) {
      await comment(app(), token, env, { body: "meant to be internal", internal: value });
    }
    const delivered = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM feedback_comments WHERE ticket_id = ? AND internal = 0",
    ).get(TICKET) as { n: number };
    expect(delivered.n).toBe(0);
  });

  it("keeps the stored row and the audit record in agreement", async () => {
    // These once disagreed: the row used a truthy test, the audit `=== true`, so
    // internal:"false" stored an internal note and audited a public reply.
    const { sqlite, env } = environment();
    const publisher = await issueToken(sqlite, { name: "pub", role: "publisher", scopes: null });
    await comment(app(), publisher, env, { body: "internal", internal: true });
    const row = sqlite.prepare(
      "SELECT internal FROM feedback_comments WHERE ticket_id = ?",
    ).get(TICKET) as { internal: number };
    const audit = sqlite.prepare(
      "SELECT payload FROM audit_logs WHERE action = 'feedback.comment' ORDER BY created_at DESC",
    ).get() as { payload: string } | undefined;
    expect(row.internal).toBe(1);
    expect(JSON.parse(audit!.payload).internal).toBe(true);
  });
});
