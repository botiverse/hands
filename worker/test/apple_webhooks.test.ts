import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { requireAppRole } from "../src/lib/permissions";
import { describe, expect, it } from "vitest";
import {
  handleAppleWebhook,
  handleCreateAppleWebhook,
  handleGetAppleWebhook,
  handleDeleteAppleWebhook,
  verifyAppleSignature,
} from "../src/routes/apple_webhooks";
import { encryptP8 } from "../src/lib/asc_credentials";

const secret = "This is my secret";
const encKey = "test-encryption-key";
const fixture = (id = "event-1") => ({
  data: {
    id,
    type: "appStoreVersionAppVersionStateUpdated",
    version: 1,
    attributes: {
      newValue: "IN_REVIEW",
      oldValue: "WAITING_FOR_REVIEW",
      timestamp: "2026-10-02T14:00:00Z",
    },
    relationships: {
      instance: { data: { type: "appStoreVersions", id: "version-1" } },
    },
  },
});
async function signature(body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return (
    "hmacsha256=" +
    [
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
      ),
    ]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("")
  );
}
async function setup() {
  const sql = new Database(":memory:");
  sql.pragma("foreign_keys = ON");
  sql.exec(`CREATE TABLE apps(id TEXT PRIMARY KEY,org_id TEXT,slug TEXT,name TEXT,archived_at INTEGER,platform TEXT);
 INSERT INTO apps VALUES('app','org','raft-ios','Raft iOS',NULL,'ios');
 CREATE TABLE webhooks(id TEXT PRIMARY KEY,org_id TEXT,app_id TEXT,enabled INTEGER,archived_at INTEGER,events_json TEXT,secret TEXT);
 INSERT INTO webhooks VALUES('matching','org','app',1,NULL,'["app_store:version_state_changed"]','receiver-key');
 INSERT INTO webhooks VALUES('org-wide','org',NULL,1,NULL,'[]','receiver-key');
 INSERT INTO webhooks VALUES('other-app','org','other',1,NULL,'[]','receiver-key');
 INSERT INTO webhooks VALUES('other-org','other-org',NULL,1,NULL,'[]','receiver-key');
 INSERT INTO webhooks VALUES('disabled','org',NULL,0,NULL,'[]','receiver-key');
 CREATE TABLE webhook_deliveries(id TEXT PRIMARY KEY,webhook_id TEXT,event_type TEXT,event_id TEXT,payload_json TEXT,signing_secret TEXT,status TEXT,attempts INTEGER,max_attempts INTEGER,next_attempt_at INTEGER,created_at INTEGER,updated_at INTEGER);`);
  sql.exec(
    readFileSync(
      new URL("../../migrations/sql/0080_apple_webhooks.sql", import.meta.url),
      "utf8",
    ),
  );
  const encrypted = await encryptP8(secret, encKey);
  sql
    .prepare(
      `INSERT INTO apple_webhook_configs VALUES('config','app','123',?,?,1,0,0)`,
    )
    .run(encrypted.ciphertext_b64, encrypted.iv_b64);
  function prepare(query: string) {
    const indexes: number[] = [];
    const stmt = sql.prepare(
      query.replace(/\?(\d+)/g, (_, n) => {
        indexes.push(Number(n));
        return "?";
      }),
    );
    function bind(...args: unknown[]) {
      const values = indexes.map((n) => args[n - 1]);
      return {
        execute() {
          const r = stmt.run(...values);
          return { meta: { changes: r.changes }, success: true };
        },
        run: async function () {
          return this.execute();
        },
        first: async () => stmt.get(...values) ?? null,
        all: async () => ({ results: stmt.all(...values) }),
      };
    }
    return { bind };
  }
  const db = {
    prepare,
    batch: async (stmts: Array<{ execute: () => unknown }>) =>
      sql.transaction(() => stmts.map((s) => s.execute()))(),
  };
  const app = new Hono<{ Bindings: Env }>();
  app.post("/api/apple/webhooks/:configId", handleAppleWebhook);
  app.post("/api/apps/:appId/apple-webhook", handleCreateAppleWebhook as any);
  app.get("/api/apps/:appId/apple-webhook", handleGetAppleWebhook as any);
  app.delete("/api/apps/:appId/apple-webhook", handleDeleteAppleWebhook as any);
  const env = { DB: db, ASC_CRED_ENC_KEY: encKey } as unknown as Env;
  const send = async (payload: unknown, header?: string) => {
    const body =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    return app.request(
      "/api/apple/webhooks/config",
      {
        method: "POST",
        body,
        headers: { "x-apple-signature": header ?? (await signature(body)) },
      },
      env,
    );
  };
  return { sql, send, app, env };
}
describe("Apple ingress", () => {
  it("denies publisher deploy tokens and absent principals before managing webhook secrets", async () => {
    const { env } = await setup();
    const id = "00000000-0000-4000-8000-000000000001";
    const guarded = new Hono<any>();
    guarded.use("*", async (c, next) => {
      if (c.req.header("x-test-publisher"))
        c.set("admin_deploy_token", {
          app_id: id,
          app_role: "publisher",
          scopes: null,
        });
      await next();
    });
    guarded.post(
      "/api/apps/:appId/apple-webhook",
      requireAppRole("admin"),
      handleCreateAppleWebhook as any,
    );
    const options = {
      method: "POST",
      body: JSON.stringify({ apple_app_id: "123" }),
    };
    expect(
      (
        await guarded.request(
          "/api/apps/" + id + "/apple-webhook",
          options,
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await guarded.request(
          "/api/apps/" + id + "/apple-webhook",
          { ...options, headers: { "x-test-publisher": "yes" } },
          env,
        )
      ).status,
    ).toBe(403);
  });

  it("creates a unique encrypted per-app secret once, excludes it from reads, and invalidates rotation URLs", async () => {
    const { sql, app, env } = await setup();
    sql.exec("DELETE FROM apple_webhook_configs");
    const response = await app.request(
      "/api/apps/app/apple-webhook",
      { method: "POST", body: JSON.stringify({ apple_app_id: "123" }) },
      { ...env, BUSINESS_ORIGIN: "https://hands.build" },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const config = (await response.json()) as any;
    expect(config.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(config.payload_url).toBe(
      "https://hands.build/api/apple/webhooks/" + config.id,
    );
    const stored = sql
      .prepare("SELECT * FROM apple_webhook_configs")
      .get() as any;
    expect(JSON.stringify(stored)).not.toContain(config.secret);
    const read = await app.request("/api/apps/app/apple-webhook", {}, env);
    expect(JSON.stringify(await read.json())).not.toContain(config.secret);
    expect(
      (
        await app.request(
          "/api/apps/app/apple-webhook",
          { method: "POST", body: JSON.stringify({ apple_app_id: "456" }) },
          env,
        )
      ).status,
    ).toBe(409);
    await app.request("/api/apps/app/apple-webhook", { method: "DELETE" }, env);
    expect(
      (
        await app.request(
          "/api/apple/webhooks/" + config.id,
          { method: "POST", body: "{}" },
          env,
        )
      ).status,
    ).toBe(404);
  });

  it("matches Apple official HMAC vector and rejects altered bytes/header", async () => {
    const b = new TextEncoder().encode("Hello, World!");
    const h =
      "hmacsha256=7f062172b01cb00b53ca068614674a3d982a34062a0f5d37687d5e3377e54657";
    expect(await verifyAppleSignature(secret, b, h)).toBe(true);
    expect(
      await verifyAppleSignature(
        secret,
        new TextEncoder().encode("Hello, World!\n"),
        h,
      ),
    ).toBe(false);
    expect(await verifyAppleSignature(secret, b, "sha256=" + h.slice(11))).toBe(
      false,
    );
  });
  it("atomically records exactly one fanout across concurrent redelivery, scoped to app and org", async () => {
    const { sql, send } = await setup();
    const replies = await Promise.all([
      send(fixture()),
      send(fixture()),
      send(fixture()),
    ]);
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(
      sql.prepare("SELECT COUNT(*) n FROM apple_webhook_events").get(),
    ).toEqual({ n: 1 });
    const rows = sql
      .prepare(
        "SELECT webhook_id,payload_json,event_id,signing_secret FROM webhook_deliveries ORDER BY webhook_id",
      )
      .all() as any[];
    expect(rows.map((r) => r.webhook_id)).toEqual(["matching", "org-wide"]);
    expect(rows[0].event_id).toBe("apple:app:event-1");
    expect(rows[0].signing_secret).toBe("receiver-key");
    expect(JSON.parse(rows[0].payload_json).payload).toMatchObject({
      state: "IN_REVIEW",
      previous_state: "WAITING_FOR_REVIEW",
      apple_app_id: "123",
      resource: { id: "version-1" },
    });
  });
  it("rolls back receipt if fanout fails, allowing a successful replay", async () => {
    const { sql, send } = await setup();
    sql.exec(
      "CREATE TRIGGER fail BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    expect((await send(fixture())).status).toBe(500);
    expect(
      sql.prepare("SELECT COUNT(*) n FROM apple_webhook_events").get(),
    ).toEqual({ n: 0 });
    sql.exec("DROP TRIGGER fail");
    expect((await send(fixture())).status).toBe(200);
    expect(
      sql.prepare("SELECT COUNT(*) n FROM webhook_deliveries").get(),
    ).toEqual({ n: 2 });
  });
  it("rejects bad signatures and malformed states without receipt or delivery", async () => {
    const { sql, send } = await setup();
    expect((await send(fixture(), "hmacsha256=" + "0".repeat(64))).status).toBe(
      401,
    );
    const broken = fixture();
    (broken.data.attributes as any).newValue = ["bad"];
    expect((await send(broken)).status).toBe(400);
    expect((await send("{invalid")).status).toBe(400);
    expect(
      sql.prepare("SELECT COUNT(*) n FROM apple_webhook_events").get(),
    ).toEqual({ n: 0 });
  });
  it("rejects changed body for the same event id; preserves the original", async () => {
    const { sql, send } = await setup();
    await send(fixture());
    const changed = fixture();
    changed.data.attributes.newValue = "REJECTED";
    expect((await send(changed)).status).toBe(409);
    expect(
      sql.prepare("SELECT COUNT(*) n FROM webhook_deliveries").get(),
    ).toEqual({ n: 2 });
  });
  it("accepts build payload without timestamp or old state and beta state payload", async () => {
    const { sql, send } = await setup();
    expect(
      (
        await send({
          data: {
            id: "build-event",
            type: "buildUploadStateUpdated",
            version: 1,
            attributes: { newState: "COMPLETE" },
            relationships: {
              instance: { data: { type: "buildUploads", id: "upload-1" } },
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send({
          data: {
            id: "beta-event",
            type: "buildBetaDetailExternalBuildStateUpdated",
            version: 1,
            attributes: {
              newExternalBuildState: "BETA_APPROVED",
              oldExternalBuildState: "IN_BETA_REVIEW",
            },
            relationships: {
              instance: { data: { type: "buildBetaDetails", id: "beta-1" } },
            },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      sql.prepare("SELECT COUNT(*) n FROM apple_webhook_events").get(),
    ).toEqual({ n: 2 });
  });
  it("acknowledges unknown signed events without a misleading notification and invalidates disabled configs", async () => {
    const { sql, send } = await setup();
    expect((await send({ data: { id: "ping", type: "unknown" } })).status).toBe(
      200,
    );
    expect(
      sql.prepare("SELECT COUNT(*) n FROM webhook_deliveries").get(),
    ).toEqual({ n: 0 });
    sql.exec("UPDATE apple_webhook_configs SET enabled=0");
    expect((await send(fixture())).status).toBe(404);
  });
  it("bounds streamed bytes before signing or parsing", async () => {
    const { sql, send } = await setup();
    expect((await send("x".repeat(65537))).status).toBe(413);
    expect(
      sql.prepare("SELECT COUNT(*) n FROM apple_webhook_events").get(),
    ).toEqual({ n: 0 });
  });
});
