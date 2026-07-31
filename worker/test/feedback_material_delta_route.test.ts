import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { openApiDocument } from "../src/openapi";
import { authMiddleware } from "../src/middleware/auth";
import { requireAppRole } from "../src/lib/permissions";
import { generateDeployToken, hashDeployToken } from "../src/lib/deploy_tokens";
import { handleAgentManifest } from "../src/routes/auth";
import { handlePurgeApp } from "../src/routes/apps";
import {
  handleAddFeedbackComment,
  handleListFeedbackMaterialDelta,
  handlePublicFeedbackSubmit,
  handlePublicMinidumpSubmit,
  handleUpdateFeedback,
} from "../src/routes/feedback";
import {
  handleAddReporterComment,
  handleListReporterFeedback,
} from "../src/routes/reporter_feedback";

vi.mock("@cloudflare/containers", () => ({
  getRandom: async () => ({
    fetch: async () => Response.json({ stack_text: "" }),
  }),
}));

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

type BoundStatement = {
  _execute: () => { results: unknown[]; success: true; meta: { changes: number } };
  run: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  first: <T>() => Promise<T | null>;
};

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
    return {
      bind,
      run: () => bind().run(),
      all: () => bind().all(),
      first: <T>() => bind().first<T>(),
    };
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
  const DB = d1(sqlite);
  sqlite.prepare(
    `INSERT INTO organizations
     (id, slug, name, external_provider, external_id, created_at)
     VALUES ('org', 'org', 'Org', 'raft', 'server', 1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
     VALUES ('app-a', 'org', 'app-a', 'App A', 'electron', 'client-key', 1),
            ('app-b', 'org', 'app-b', 'App B', 'electron', 'client-key-b', 1)`,
  ).run();
  const objects = new Map<string, Uint8Array>();
  const pending: Promise<unknown>[] = [];
  const env = {
    DB,
    APK_BUCKET: {
      put: async (key: string, value: ArrayBuffer) => objects.set(key, new Uint8Array(value)),
      delete: async (key: string | string[]) => {
        for (const item of Array.isArray(key) ? key : [key]) objects.delete(item);
      },
      list: async () => ({ objects: [], truncated: false }),
      head: async (key: string) => objects.has(key) ? { size: objects.get(key)!.byteLength } : null,
      get: async (key: string) => {
        const value = objects.get(key);
        return value ? { arrayBuffer: async () => value.buffer, text: async () => new TextDecoder().decode(value) } : null;
      },
    },
    ENVIRONMENT: "production",
    DASHBOARD_ORIGIN: "https://dashboard.example",
    RAFT_CLIENT_ID: "hands-test",
    FEEDBACK_AUDIT_HMAC_KEY: "material-delta-test-audit-key-with-enough-entropy",
    FEEDBACK_AUDIT_KEY_VERSION: "test-v1",
  } as unknown as Env;
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { sqlite, env, executionCtx, pending };
}

function jsonContext(
  env: Env,
  params: Record<string, string>,
  body: unknown = {},
  queries: Record<string, string> = {},
) {
  const headers = new Headers();
  return {
    env,
    req: {
      url: `https://hands.test/api/apps/${params.appId ?? ""}/feedback`,
      method: "GET",
      param: (name: string) => params[name],
      query: (name: string) => queries[name],
      json: async () => body,
    },
    get: (name: string) => name === "admin_actor" ? "staff:test" : undefined,
    header: (name: string, value: string) => headers.set(name, value),
    json: (data: unknown, status = 200) => Response.json(data, { status, headers }),
  } as any;
}

function material(sqlite: Database.Database, ticketId: string) {
  return (sqlite.prepare(
    "SELECT material_sequence AS sequence FROM feedback_tickets WHERE id = ?",
  ).get(ticketId) as { sequence: number }).sequence;
}

function cursor(value: unknown) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("feedback material delta production routes", () => {
  it("advances through every current production writer exactly once", async () => {
    const { sqlite, env, executionCtx, pending } = environment();

    const feedbackForm = new FormData();
    feedbackForm.set("message", "ordinary feedback");
    const feedbackResponse = await handlePublicFeedbackSubmit({
      env,
      executionCtx,
      req: {
        url: "https://hands.test/public/v2/apps/app-a/feedback",
        raw: { cf: { clientIp: "192.0.2.1" } },
        param: (name: string) => name === "slug" ? "app-a" : undefined,
        header: (name: string) => name === "X-Hands-Client-Key" ? "client-key" : undefined,
        query: () => undefined,
        formData: async () => feedbackForm,
      },
      header: () => undefined,
      json: (data: unknown, status = 200) => Response.json(data, { status }),
    } as any);
    expect(feedbackResponse.status).toBe(201);
    const ticketId = String((await feedbackResponse.json() as { id: string }).id);
    expect(material(sqlite, ticketId)).toBe(1);

    const minidumpForm = new FormData();
    minidumpForm.set("version", "1.0.0");
    minidumpForm.append(
      "upload_file_minidump",
      new File([new Uint8Array([1, 2, 3])], "minidump.dmp", { type: "application/x-minidump" }),
    );
    const minidumpResponse = await handlePublicMinidumpSubmit({
      env,
      executionCtx,
      req: {
        raw: { cf: { clientIp: "192.0.2.2" } },
        param: (name: string) => name === "slug" ? "app-a" : undefined,
        header: (name: string) => name === "X-Hands-Client-Key" ? "client-key" : undefined,
        query: () => undefined,
        formData: async () => minidumpForm,
      },
      json: (data: unknown, status = 200) => Response.json(data, { status }),
    } as any);
    expect(minidumpResponse.status).toBe(201);
    const minidumpId = String((await minidumpResponse.json() as { id: string }).id);
    expect(material(sqlite, minidumpId)).toBe(2);
    await Promise.allSettled(pending);
    expect(material(sqlite, minidumpId)).toBe(2);

    const updateContext = (body: unknown) => jsonContext(env, { appId: "app-a", ticketId }, body);
    expect((await handleUpdateFeedback(updateContext({ status: "in_progress", assignee: "owner" }))).status)
      .toBe(200);
    expect(material(sqlite, ticketId)).toBe(3);
    const noop = await handleUpdateFeedback(updateContext({ status: "in_progress", assignee: "owner" }));
    expect(await noop.json()).toMatchObject({ changed: false });
    expect(material(sqlite, ticketId)).toBe(3);

    expect((await handleAddFeedbackComment(jsonContext(
      env,
      { appId: "app-a", ticketId },
      { body: "external", internal: false },
    ))).status).toBe(201);
    expect(material(sqlite, ticketId)).toBe(4);
    expect((await handleAddFeedbackComment(jsonContext(
      env,
      { appId: "app-a", ticketId },
      { body: "internal", internal: true },
    ))).status).toBe(201);
    expect(material(sqlite, ticketId)).toBe(5);

    const integrationId = "11111111-1111-4111-8111-111111111111";
    const reporterId = "r".repeat(32);
    const credential = generateDeployToken();
    sqlite.prepare(
      `INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at)
       VALUES (?, 'app-a', 'inbox', 1, 1)`,
    ).run(integrationId);
    sqlite.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at, reporter_integration_id)
       VALUES ('reporter-token', 'app-a', 'reporter', ?, ?, NULL,
               '["feedback:read","feedback:comment"]', 'test', 1, ?)`,
    ).run(credential.token_prefix, await hashDeployToken(credential.token), integrationId);
    sqlite.prepare(
      "UPDATE feedback_tickets SET reporter_id = ?, reporter_integration_id = ? WHERE id = ?",
    ).run(reporterId, integrationId, ticketId);
    const reporterHeaders = new Headers();
    const reporterResponse = await handleAddReporterComment({
      env,
      req: {
        param: (name: string) => name === "appId" ? "app-a" : name === "ticketId" ? ticketId : undefined,
        header: (name: string) => name.toLowerCase() === "authorization"
          ? `Bearer ${credential.token}`
          : name === "X-Hands-Reporter-Id"
            ? reporterId
            : undefined,
        json: async () => ({
          body: "reporter follow-up",
          submission_id: "22222222-2222-4222-8222-222222222222",
        }),
      },
      header: (name: string, value: string) => reporterHeaders.set(name, value),
      json: (data: unknown, status = 200) => Response.json(data, { status, headers: reporterHeaders }),
    } as any);
    expect(reporterResponse.status).toBe(201);
    expect(material(sqlite, ticketId)).toBe(6);
    expect(sqlite.prepare(
      "SELECT high_water FROM feedback_material_sequence_state WHERE app_id = 'app-a'",
    ).get()).toEqual({ high_water: 6 });

    const reporterList = await handleListReporterFeedback({
      env,
      req: {
        param: (name: string) => name === "appId" ? "app-a" : undefined,
        header: (name: string) => name.toLowerCase() === "authorization"
          ? `Bearer ${credential.token}`
          : name === "X-Hands-Reporter-Id"
            ? reporterId
            : undefined,
        query: () => undefined,
      },
      header: () => undefined,
      json: (data: unknown, status = 200) => Response.json(data, { status }),
    } as any);
    expect(reporterList.status).toBe(200);
    expect(JSON.stringify(await reporterList.json())).not.toMatch(/material_sequence|material-v1/);
    const eventPayloads = sqlite.prepare(
      "SELECT payload_json FROM feedback_events WHERE ticket_id = ?",
    ).all(ticketId);
    expect(JSON.stringify(eventPayloads)).not.toMatch(/material_sequence|material-v1/);
  });

  it("pages snapshot deltas without omission and rejects every foreign cursor family", async () => {
    const { sqlite, env } = environment();
    const insert = sqlite.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES (?, 'app-a', 'feedback', 'open', ?, '{}', ?, ?)`,
    );
    for (const [index, id] of [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ].entries()) insert.run(id, `ticket-${index}`, index + 1, index + 1);

    const firstResponse = await handleListFeedbackMaterialDelta(jsonContext(
      env,
      { appId: "app-a" },
      {},
      { limit: "2" },
    ));
    const first = await firstResponse.json() as any;
    expect(first.tickets.map((ticket: any) => ticket.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
    expect(first.has_more).toBe(true);
    expect(JSON.stringify(first)).not.toContain("material_sequence");
    expect(JSON.parse(atob(first.next_cursor))).toEqual(["material-v1", "app-a", 2]);

    sqlite.prepare(
      "UPDATE feedback_tickets SET status = 'resolved' WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
    ).run();
    const second = await (await handleListFeedbackMaterialDelta(jsonContext(
      env,
      { appId: "app-a" },
      {},
      { limit: "2", cursor: first.next_cursor },
    ))).json() as any;
    expect(second.tickets.map((ticket: any) => ticket.id)).toEqual([
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
    expect(second.has_more).toBe(false);

    const empty = await (await handleListFeedbackMaterialDelta(jsonContext(
      env,
      { appId: "app-a" },
      {},
      { cursor: second.next_cursor },
    ))).json() as any;
    expect(empty).toMatchObject({ tickets: [], next_cursor: second.next_cursor, has_more: false });

    for (const invalid of [
      cursor(["material-v1", "app-b", 0]),
      cursor(["sequence-v1", 0, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]),
      cursor(["sequence-v2", "app-a", 0]),
      cursor([0, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]),
      cursor(["material-v1", "app-a", Number.MAX_SAFE_INTEGER + 1]),
      "",
      "not-base64",
    ]) {
      expect((await handleListFeedbackMaterialDelta(jsonContext(
        env,
        { appId: "app-a" },
        {},
        { cursor: invalid },
      ))).status).toBe(400);
    }
  });

  it("wires the literal admin route and rejects a feedback:read reporter token", async () => {
    const { sqlite, env } = environment();
    const integrationId = "33333333-3333-4333-8333-333333333333";
    sqlite.prepare(
      `INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at)
       VALUES (?, 'app-a', 'inbox', 1, 1)`,
    ).run(integrationId);
    const reporter = generateDeployToken();
    const viewer = generateDeployToken();
    const insertToken = sqlite.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at, reporter_integration_id)
       VALUES (?, 'app-a', ?, ?, ?, ?, ?, 'test', 1, ?)`,
    );
    insertToken.run(
      "reporter", "reporter", reporter.token_prefix, await hashDeployToken(reporter.token),
      null, '["feedback:read"]', integrationId,
    );
    insertToken.run(
      "viewer", "viewer", viewer.token_prefix, await hashDeployToken(viewer.token),
      "viewer", null, null,
    );

    const path = "https://hands.test/api/apps/app-a/feedback/material-delta";
    const mini = new Hono<any>();
    mini.use("*", authMiddleware);
    mini.get(
      "/api/apps/:appId/feedback/material-delta",
      requireAppRole("viewer"),
      handleListFeedbackMaterialDelta,
    );
    const reporterResponse = await mini.request(
      path,
      { headers: { authorization: `Bearer ${reporter.token}` } },
      env,
    );
    expect(reporterResponse.status).toBe(403);
    expect(await reporterResponse.json()).toMatchObject({
      error: "insufficient_app_role",
      required_role: "viewer",
      current_role: null,
    });
    expect((await mini.request(
      path,
      { headers: { authorization: `Bearer ${viewer.token}` } },
      env,
    )).status).toBe(200);

    const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const materialRoute = indexSource.indexOf(
      'admin.get(\n  "/api/apps/:appId/feedback/material-delta",\n  requireAppRole("viewer"),\n  handleListFeedbackMaterialDelta,\n);',
    );
    const ticketRoute = indexSource.indexOf(
      'admin.get("/api/apps/:appId/feedback/:ticketId", requireAppRole("viewer"), handleGetFeedback);',
    );
    expect(materialRoute).toBeGreaterThan(-1);
    expect(ticketRoute).toBeGreaterThan(materialRoute);
  });

  it("keeps the production app-purge entrypoint compatible with 0059 comments and 0060 guards", async () => {
    const { sqlite, env } = environment();
    const integrationId = "44444444-4444-4444-8444-444444444444";
    const ticketId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    sqlite.prepare(
      `INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at)
       VALUES (?, 'app-a', 'inbox', 1, 1)`,
    ).run(integrationId);
    sqlite.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
       VALUES (?, 'app-a', 'feedback', 'open', 'ticket', '{}', ?, ?, 1, 1)`,
    ).run(ticketId, "r".repeat(32), integrationId);
    sqlite.prepare(
      `INSERT INTO feedback_comments
       (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES ('visible', ?, 'staff:test', 'staff', 'visible', 0, 2),
              ('internal', ?, 'staff:test', 'staff', 'internal', 1, 3)`,
    ).run(ticketId, ticketId);
    expect(sqlite.prepare(
      "SELECT id, reporter_sequence FROM feedback_comments ORDER BY id DESC",
    ).all()).toEqual([
      { id: "visible", reporter_sequence: 1 },
      { id: "internal", reporter_sequence: null },
    ]);
    sqlite.prepare("UPDATE apps SET archived = 1 WHERE id = 'app-a'").run();

    const response = await handlePurgeApp(jsonContext(
      env,
      { appId: "app-a" },
      { confirm_slug: "app-a" },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, purged_app_id: "app-a" });
    expect(sqlite.prepare(
      `SELECT
         (SELECT COUNT(*) FROM apps WHERE id='app-a') AS apps,
         (SELECT COUNT(*) FROM feedback_tickets WHERE app_id='app-a') AS tickets,
         (SELECT COUNT(*) FROM feedback_comments WHERE ticket_id=?) AS comments,
         (SELECT COUNT(*) FROM app_reporter_integrations WHERE app_id='app-a') AS integrations,
         (SELECT COUNT(*) FROM feedback_material_sequence_state WHERE app_id='app-a') AS state`,
    ).get(ticketId)).toEqual({ apps: 0, tickets: 0, comments: 0, integrations: 0, state: 0 });
  });

  it("publishes the admin route in OpenAPI and the agent action manifest", async () => {
    expect(openApiDocument.paths?.["/api/apps/{appId}/feedback/material-delta"]?.get).toBeDefined();
    const response = await handleAgentManifest({
      env: { RAFT_CLIENT_ID: "hands-test" },
      req: { url: "https://hands.test/.well-known/raft-agent-manifest.json" },
      header: () => undefined,
      json: (data: unknown, status = 200) => Response.json(data, { status }),
    } as any);
    const manifest = await response.json() as any;
    expect(manifest.actions.find((action: any) => action.name === "list-feedback-material-delta"))
      .toMatchObject({
        endpoint: { method: "GET", path: "/api/apps/{app_id}/feedback/material-delta" },
      });
  });
});
