import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { generateDeployToken, hashDeployToken } from "../src/lib/deploy_tokens";
import { mintReporterSession } from "../src/lib/reporter_sessions";
import { openApiDocument } from "../src/openapi";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getRandom: async () => ({ fetch: async () => Response.json({ stack_text: "" }) }),
}));
import worker from "../src/index";

const MIGRATIONS = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const REPORTER = "reporter_aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_REPORTER = "reporter_bbbbbbbbbbbbbbbbbbbbbbbb";
const ROUTE = `rfr_v1_${"a".repeat(30)}`;
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const T2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const T3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const T4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const T5 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const PUB1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const PUB2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const INTERNAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";

type Bound = { execute: () => { results: unknown[]; success: true; meta: { changes: number } } };
function d1(sqlite: Database.Database) {
  return {
    prepare(sql: string) {
      const indexes: number[] = [];
      const normalized = sql.replace(/\?(\d+)/g, (_match, index) => {
        indexes.push(Number(index));
        return "?";
      });
      const statement = sqlite.prepare(normalized);
      const bind = (...input: unknown[]) => {
        const params = (indexes.length ? indexes.map((i) => input[i - 1]) : input)
          .map((value) => value === undefined ? null : value);
        const execute = () => statement.reader
          ? { results: statement.all(...params), success: true as const, meta: { changes: 0 } }
          : { results: [], success: true as const, meta: { changes: statement.run(...params).changes } };
        return {
          execute,
          all: async () => execute(),
          run: async () => execute(),
          first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
        };
      };
      return { bind, all: () => bind().all(), run: () => bind().run(), first: <T>() => bind().first<T>() };
    },
    batch: async (statements: Bound[]) => sqlite.transaction(() => statements.map((s) => s.execute()))(),
  };
}

async function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATIONS}${name}`, "utf8"));
  }
  sqlite.exec(`
    INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
      VALUES ('org', 'org', 'Org', 'raft', 'server', 1);
    INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
      VALUES ('app-a', 'org', 'app-a', 'A', 'web', 'client-a', 1),
             ('app-b', 'org', 'app-b', 'B', 'web', 'client-b', 1);
  `);
  const integration = sqlite.prepare(`INSERT INTO app_reporter_integrations
    (id, app_id, name, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`);
  integration.run(A, "app-a", "a");
  integration.run(B, "app-a", "b");
  integration.run(C, "app-b", "c");
  const route = sqlite.prepare(`INSERT INTO app_reporter_routes
    (app_id, reporter_integration_id, reporter_id, route_subject, subject_version, created_at)
    VALUES (?, ?, ?, ?, 'v1', 1)`);
  route.run("app-a", A, REPORTER, ROUTE);
  route.run("app-a", B, REPORTER, `rfr_v1_${"b".repeat(30)}`);
  route.run("app-b", C, REPORTER, `rfr_v1_${"c".repeat(30)}`);
  const ticket = (id: string, app: string, integrationId: string, reporter = REPORTER) => sqlite.prepare(`
    INSERT INTO feedback_tickets
    (id, app_id, kind, status, message, contact, metadata_json, reporter_id,
     reporter_integration_id, created_at, updated_at)
    VALUES (?, ?, 'feedback', 'open', 'private original body', 'private contact', '{}', ?, ?, 1, 1)`)
    .run(id, app, reporter, integrationId);
  const comment = (id: string, ticketId: string, internal: boolean, body: string) => sqlite.prepare(`
    INSERT INTO feedback_comments (id, ticket_id, author_actor, author_type, body, internal, created_at)
    VALUES (?, ?, 'staff:secret', 'staff', ?, ?, 2)`)
    .run(id, ticketId, body, internal ? 1 : 0);
  async function token(name: string, app: string, integrationId: string | null, scopes: string[], role: string | null = null) {
    const generated = generateDeployToken();
    sqlite.prepare(`INSERT INTO app_deploy_tokens
      (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at, reporter_integration_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'test', 1, ?)`)
      .run(name, app, name, generated.token_prefix, await hashDeployToken(generated.token), role, JSON.stringify(scopes), integrationId);
    return generated.token;
  }
  const env = {
    DB: d1(sqlite),
    ENVIRONMENT: "production",
    DASHBOARD_ORIGIN: "https://dashboard.example",
    FEEDBACK_AUDIT_HMAC_KEY: "reporter-changes-test-audit-key-long-enough",
    FEEDBACK_AUDIT_KEY_VERSION: "test-v1",
  } as unknown as Env;
  const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const request = async (path: string, bearer?: string, reporter?: string) => worker.fetch(
    new Request(`https://hands.test${path}`, { headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(reporter ? { "X-Hands-Reporter-Id": reporter } : {}),
    } }), env, context,
  );
  return { sqlite, env, ticket, comment, token, request };
}
const changesPath = "/api/apps/app-a/reporter-feedback/changes";
const withCursor = (cursor: string, extra = "") => `${changesPath}?cursor=${encodeURIComponent(cursor)}${extra}`;

describe("integration reporter changes", () => {
  it("uses the real static route and starts at the current high-water, never replaying history", async () => {
    const f = await fixture();
    const auth = await f.token("good", "app-a", A, ["feedback:read"]);
    f.ticket(T1, "app-a", A);
    f.comment(PUB1, T1, false, "historical public content");
    const res = await f.request(changesPath, auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json() as any;
    expect(body).toEqual({ changes: [], next_cursor: expect.stringMatching(/^rc1\./), has_more: false });
    const next = await f.request(withCursor(body.next_cursor), auth);
    expect(await next.json()).toMatchObject({ changes: [], has_more: false });
    expect(openApiDocument.paths?.["/api/apps/{appId}/reporter-feedback/changes"]?.get).toBeDefined();
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM feedback_reporter_ticket_reads").get()).toEqual({ n: 0 });
  });

  it("rejects wrong app, other grants, archived, revoked, expired and per-reporter sessions", async () => {
    const f = await fixture();
    const good = await f.token("good", "app-a", A, ["feedback:read"]);
    const other = await f.token("other", "app-b", C, ["feedback:read"]);
    const unbound = await f.token("unbound", "app-a", null, ["feedback:read"]);
    const noRead = await f.token("write-only", "app-a", A, ["feedback:write"]);
    const broader = await f.token("broader", "app-a", A, ["feedback:read", "build:read"]);
    const viewer = await f.token("viewer", "app-a", null, ["feedback:read"], "viewer");
    const revoked = await f.token("revoked", "app-a", A, ["feedback:read"]);
    const expired = await f.token("expired", "app-a", A, ["feedback:read"]);
    f.sqlite.prepare("UPDATE app_deploy_tokens SET revoked_at=1 WHERE id='revoked'").run();
    f.sqlite.prepare("UPDATE app_deploy_tokens SET expires_at=1 WHERE id='expired'").run();
    expect((await f.request(changesPath)).status).toBe(401);
    expect((await f.request(changesPath, "wrong")).status).toBe(401);
    expect((await f.request(changesPath, good)).status).toBe(200);
    for (const bad of [other, unbound, noRead, broader, viewer]) {
      expect((await f.request(changesPath, bad)).status).toBe(403);
    }
    for (const bad of [revoked, expired]) expect((await f.request(changesPath, bad)).status).toBe(401);
    const sessionEnv = {
      ...f.env, FEEDBACK_REPORTER_SESSION_ENABLED: "true",
      FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION: "n",
      FEEDBACK_REPORTER_SESSION_KEYS: JSON.stringify({ n: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") }),
    } as Env;
    const session = await mintReporterSession(sessionEnv, {
      appId: A, integrationId: A, reporterId: REPORTER, tokenId: B, scopes: ["feedback:read"],
    });
    expect(session).not.toBeNull();
    expect((await f.request(changesPath, session!.token, REPORTER)).status).toBe(401);
    // The original staff feed is still forbidden to integration-bound tokens.
    expect((await f.request("/api/apps/app-a/feedback/material-delta", good)).status).toBe(403);
    f.sqlite.prepare("UPDATE app_reporter_integrations SET archived_at=2 WHERE id=?").run(A);
    expect((await f.request(changesPath, good)).status).toBe(403);
  });

  it("isolates apps and integrations, coalesces mixed changes, and never returns private contents", async () => {
    const f = await fixture();
    const auth = await f.token("good", "app-a", A, ["feedback:read"]);
    f.ticket(T1, "app-a", A);
    f.ticket(T2, "app-a", B);
    f.ticket(T3, "app-b", C);
    const start = await (await f.request(changesPath, auth)).json() as any;
    f.comment(PUB1, T1, false, "public reply secret body");
    f.comment(INTERNAL, T1, true, "internal secret body");
    f.comment(PUB2, T2, false, "other integration secret");
    f.sqlite.prepare("UPDATE feedback_tickets SET assignee='sensitive assignee' WHERE id=?").run(T3);
    const res = await f.request(withCursor(start.next_cursor), auth);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.changes).toEqual([{ ticket_id: T1, route_subject: ROUTE, reporter_id: REPORTER, comment_id: PUB1 }]);
    expect(body.has_more).toBe(false);
    const serialized = JSON.stringify(body);
    for (const forbidden of ["secret", "private", "staff:", "contact", "assignee", "internal", T2, T3, INTERNAL, OTHER_REPORTER]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM feedback_reporter_ticket_reads").get()).toEqual({ n: 0 });
    const detail = await f.request(`/api/apps/app-a/reporter-feedback/${T1}?mark_read=false`, auth, REPORTER);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as any;
    expect(detailBody.comments.map((c: any) => c.id)).toEqual([PUB1]);
    expect(JSON.stringify(detailBody)).not.toContain("internal secret body");
    expect(detailBody.ticket.unread_count).toBe(1);
  });

  it("returns unbound legacy tickets explicitly rather than dropping them", async () => {
    const f = await fixture();
    const auth = await f.token("good", "app-a", A, ["feedback:read"]);
    const start = await (await f.request(changesPath, auth)).json() as any;
    f.ticket(T1, "app-a", A, OTHER_REPORTER);
    const res = await f.request(withCursor(start.next_cursor), auth);
    expect((await res.json() as any).changes).toEqual([{ ticket_id: T1, route_subject: null, reporter_id: OTHER_REPORTER, comment_id: null }]);
  });

  it("pages safely when a not-yet-read ticket changes concurrently, and retry is idempotent", async () => {
    const f = await fixture();
    const auth = await f.token("good", "app-a", A, ["feedback:read"]);
    f.ticket(T1, "app-a", A);
    f.ticket(T2, "app-a", A);
    f.ticket(T3, "app-a", A);
    const start = await (await f.request(changesPath, auth)).json() as any;
    for (const ticket of [T1, T2, T3]) f.sqlite.prepare("UPDATE feedback_tickets SET status='resolved' WHERE id=?").run(ticket);
    const page1 = await (await f.request(withCursor(start.next_cursor, "&limit=1"), auth)).json() as any;
    expect(page1.changes.map((c: any) => c.ticket_id)).toEqual([T1]);
    expect(page1.has_more).toBe(true);
    f.comment(PUB1, T2, false, "after page one");
    const page2 = await (await f.request(withCursor(page1.next_cursor, "&limit=1"), auth)).json() as any;
    expect(page2.changes.map((c: any) => c.ticket_id)).toEqual([T3]);
    expect(page2.has_more).toBe(true);
    const page3 = await (await f.request(withCursor(page2.next_cursor, "&limit=1"), auth)).json() as any;
    expect(page3.changes).toEqual([{ ticket_id: T2, route_subject: ROUTE, reporter_id: REPORTER, comment_id: PUB1 }]);
    expect(page3.has_more).toBe(false);
    const replay = await (await f.request(withCursor(page2.next_cursor, "&limit=1"), auth)).json() as any;
    expect(replay.changes).toEqual(page3.changes);
    expect((await (await f.request(withCursor(page3.next_cursor), auth)).json() as any).changes).toEqual([]);
    // A ticket already emitted on an earlier page can change again: it must be
    // returned again for another idempotent public-detail reconciliation.
    f.comment(PUB2, T1, false, "after the first page was processed");
    const after = await (await f.request(withCursor(page3.next_cursor), auth)).json() as any;
    expect(after.changes).toEqual([{ ticket_id: T1, route_subject: ROUTE, reporter_id: REPORTER, comment_id: PUB2 }]);
  });

  it("keeps app-wide sequence length and unrelated integration activity out of cursors", async () => {
    const f = await fixture();
    const a = await f.token("a", "app-a", A, ["feedback:read"]);
    f.ticket(T1, "app-a", B);
    const first = await (await f.request(changesPath, a)).json() as any;
    for (let n = 0; n < 100; n++) {
      f.sqlite.prepare("UPDATE feedback_tickets SET assignee=? WHERE id=?").run(`assignee-${n}`, T1);
    }
    const second = await (await f.request(withCursor(first.next_cursor), a)).json() as any;
    expect(second.changes).toEqual([]);
    expect(second.next_cursor).toHaveLength(first.next_cursor.length);
    expect(second.next_cursor).not.toBe(first.next_cursor);
  });

  it("protects cursors from forgery and cross-integration or cross-app reuse", async () => {
    const f = await fixture();
    const a = await f.token("a", "app-a", A, ["feedback:read"]);
    const b = await f.token("b", "app-a", B, ["feedback:read"]);
    const c = await f.token("c", "app-b", C, ["feedback:read"]);
    const initial = await (await f.request(changesPath, a)).json() as any;
    const cursor: string = initial.next_cursor;
    expect((await f.request(withCursor(cursor), b)).status).toBe(400);
    expect((await f.request(`/api/apps/app-b/reporter-feedback/changes?cursor=${cursor}`, c)).status).toBe(400);
    const mutated = cursor.slice(0, 4) + (cursor[4] === "A" ? "B" : "A") + cursor.slice(5);
    expect((await f.request(withCursor(mutated), a)).status).toBe(400);
    expect((await f.request(`${changesPath}?cursor=`, a)).status).toBe(400);
    for (const value of ["0", "-1", "201", "NaN", "1.5"]) {
      expect((await f.request(`${changesPath}?limit=${value}`, a)).status).toBe(400);
    }
    f.env.FEEDBACK_AUDIT_HMAC_KEY = "rotated-reporter-audit-key-long-enough";
    expect((await f.request(withCursor(cursor), a)).status).toBe(400);
  });

  it("limits integration-wide polling and fails closed without audit configuration", async () => {
    const f = await fixture();
    const auth = await f.token("good", "app-a", A, ["feedback:read"]);
    f.env.FEEDBACK_AUDIT_HMAC_KEY = "short";
    expect((await f.request(changesPath, auth)).status).toBe(503);
    f.env.FEEDBACK_AUDIT_HMAC_KEY = "reporter-changes-test-audit-key-long-enough";
    for (let i = 0; i < 60; i++) expect((await f.request(changesPath, auth)).status).toBe(200);
    const limited = await f.request(changesPath, auth);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("reporter detail read receipts", () => {
  it("mark_read=false preserves unread and default still marks returned public replies read", async () => {
    const f = await fixture();
    const auth = await f.token("good", "app-a", A, ["feedback:read"]);
    f.ticket(T1, "app-a", A);
    f.comment(PUB1, T1, false, "one");
    f.comment(PUB2, T1, false, "two");
    f.comment(INTERNAL, T1, true, "private note");
    const detail = `/api/apps/app-a/reporter-feedback/${T1}`;
    const background = await f.request(`${detail}?mark_read=false&comment_limit=1`, auth, REPORTER);
    expect(background.status).toBe(200);
    const body = await background.json() as any;
    expect(body.ticket.unread_count).toBe(2);
    expect(body.unread_total).toBe(1);
    expect(body.comments.map((c: any) => c.id)).toEqual([PUB1]);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM feedback_reporter_ticket_reads").get()).toEqual({ n: 0 });
    const background2 = await f.request(`${detail}?mark_read=false&comment_cursor=${body.next_comment_cursor}`, auth, REPORTER);
    expect((await background2.json() as any).ticket.unread_count).toBe(2);
    const interactive = await f.request(`${detail}?comment_limit=1`, auth, REPORTER);
    const read = await interactive.json() as any;
    expect(read.ticket.unread_count).toBe(1);
    expect(read.unread_total).toBe(1);
    expect(f.sqlite.prepare("SELECT read_through_comment_id FROM feedback_reporter_ticket_reads").get())
      .toEqual({ read_through_comment_id: PUB1 });
    const invalid = await f.request(`${detail}?mark_read=perhaps`, auth, REPORTER);
    expect(invalid.status).toBe(400);
    const second = await f.request(`${detail}?comment_cursor=${read.next_comment_cursor}`, auth, REPORTER);
    const done = await second.json() as any;
    expect(done.ticket.unread_count).toBe(0);
    expect(done.unread_total).toBe(0);
  });
});
