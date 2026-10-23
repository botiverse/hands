import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { requireAppRole } from "../src/lib/permissions";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAppleWebhook,
  handleCreateAppleWebhook,
  handleGetAppleWebhook,
  handleDeleteAppleWebhook,
  verifyAppleSignature,
} from "../src/routes/apple_webhooks";
import {
  handleCreateAppWebhook,
  handleUpdateAppWebhook,
  processDeliveryById,
} from "../src/routes/webhooks";
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
  // Apply the full production migration chain so existing foreign keys and
  // later schema constraints participate in every ingress regression.
  const directory = new URL("../../migrations/sql/", import.meta.url);
  for (const file of readdirSync(directory).sort())
    if (file.endsWith(".sql"))
      sql.exec(readFileSync(new URL(file, directory), "utf8"));
  sql.exec(`INSERT INTO organizations(id,slug,name,external_id,created_at) VALUES('org','org','Org','org',0),('other-org','other-org','Other','other',0);
 INSERT INTO raft_accounts(id,provider_subject,server_id,principal_type,display_name,raw_profile,created_at,updated_at,last_login_at) VALUES('actor','actor','server','human','Actor','{}',0,0,0);
 INSERT INTO apps(id,slug,name,platform,created_at,org_id) VALUES('app','raft-ios','Raft iOS','ios',0,'org'),('other','other','Other','ios',0,'org');`);
  for (const [id, org, app, enabled, events] of [
    ["matching", "org", "app", 1, '["app_store:version_state_changed"]'],
    ["org-wide", "org", null, 1, "[]"],
    ["other-app", "org", "other", 1, "[]"],
    ["other-org", "other-org", null, 1, "[]"],
    ["disabled", "org", null, 0, "[]"],
  ])
    sql
      .prepare(
        `INSERT INTO webhooks(id,org_id,app_id,url,enabled,events_json,secret,created_by,created_at,updated_at)
 VALUES(?,?,?,'https://receiver.example',?,?, 'receiver-key','actor',0,0)`,
      )
      .run(id, org, app, enabled, events);
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
      const values = indexes.length ? indexes.map((n) => args[n - 1]) : args;
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
  const app = new Hono<any>();
  app.use("/api/apps/*", async (c, next) => {
    c.set("admin_account", {
      id: "actor",
      principal_type: "human",
      display_name: "Actor",
      server_id: "server",
    });
    await next();
  });
  app.post("/api/apple/webhooks/:configId", handleAppleWebhook);
  app.post("/api/apps/:appId/webhooks", handleCreateAppWebhook as any);
  app.patch(
    "/api/apps/:appId/webhooks/:webhookId",
    handleUpdateAppWebhook as any,
  );
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
  it("allows Apple subscriptions through actual app-scoped create and update handlers", async () => {
    const { app, env } = await setup();
    const events = [
      "app_store:version_state_changed",
      "testflight:external_state_changed",
      "app_store:build_upload_state_changed",
    ];
    const created = await app.request(
      "/api/apps/app/webhooks",
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://receiver.example",
          secret: "receiver-key",
          events,
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const row = (await created.json()) as any;
    expect(row.events).toEqual(events);
    expect(
      (
        await app.request(
          "/api/apps/app/webhooks/" + row.id,
          { method: "PATCH", body: JSON.stringify({ events }) },
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          "/api/apps/app/webhooks/" + row.id,
          {
            method: "PATCH",
            body: JSON.stringify({ events: ["unknown:event"] }),
          },
          env,
        )
      ).status,
    ).toBe(400);
  });
  it("preserves feedback foreign keys and delivers Apple external IDs through the existing consumer", async () => {
    const { sql, send, env } = await setup();
    expect(() =>
      sql
        .prepare(
          "INSERT INTO webhook_deliveries(id,webhook_id,event_type,event_id,payload_json,created_at,updated_at) VALUES('bad','matching','x','non-feedback','{}',0,0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect((await send(fixture())).status).toBe(200);
    const row = sql
      .prepare(
        "SELECT id,event_id,external_event_id FROM webhook_deliveries WHERE webhook_id=?",
      )
      .get("matching") as any;
    expect(row.event_id).toBeNull();
    expect(row.external_event_id).toBe("apple:app:event-1");
    let header: string | null = null;
    expect(
      await processDeliveryById(env, row.id, {
        fetchImpl: async (_url, opts) => {
          header = new Headers(opts?.headers).get("X-Hands-Event-Id");
          return new Response(null, { status: 204 });
        },
      }),
    ).toBe("succeeded");
    expect(header).toBe("apple:app:event-1");
  });

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
        "SELECT webhook_id,payload_json,external_event_id AS event_id,signing_secret FROM webhook_deliveries ORDER BY webhook_id",
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

/**
 * Apple's webhook envelope carries no version identity, so a
 * buildBetaDetailExternalBuildStateUpdated notification cannot name the build
 * unless the Worker follows `buildBetaDetails/{id}/build` itself.
 *
 * These tests pin both halves of that contract:
 *   1. a successful lookup adds `payload.build` (and nothing else changes), and
 *   2. EVERY failure mode degrades to `build: null` without dropping the
 *      delivery — a version lookup must never cost a real state-change event.
 */
describe("Apple ingress — build identity enrichment", () => {
  /**
   * Generate a throwaway P-256 key at test time. Committing a PEM blob would
   * trip the repository's secret scanner (and would be a bad habit even for a
   * key that signs nothing).
   */
  async function ephemeralPkcs8Pem(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey(
      "pkcs8",
      pair.privateKey,
    )) as ArrayBuffer;
    const b64 = Buffer.from(new Uint8Array(pkcs8)).toString("base64");
    const header = ["-----", "BEGIN", " PRIVATE", " KEY", "-----"].join("");
    const footer = ["-----", "END", " PRIVATE", " KEY", "-----"].join("");
    return `${header}\n${(b64.match(/.{1,64}/g) ?? []).join("\n")}\n${footer}\n`;
  }

  const betaEvent = (id = "beta-event") => ({
    data: {
      id,
      type: "buildBetaDetailExternalBuildStateUpdated",
      version: 1,
      attributes: {
        newExternalBuildState: "READY_FOR_BETA_TESTING",
        oldExternalBuildState: "IN_BETA_REVIEW",
        timestamp: "2026-10-17T21:19:06Z",
      },
      relationships: {
        instance: { data: { type: "buildBetaDetails", id: "beta-1" } },
      },
    },
  });

  /** Insert ASC credentials so the enrichment path has something to sign with. */
  async function withAscCredentials(sql: Database.Database) {
    const encrypted = await encryptP8(await ephemeralPkcs8Pem(), encKey);
    sql
      .prepare(
        `INSERT INTO app_asc_credentials
         (id,app_id,key_id,issuer_id,p8_ciphertext_b64,p8_iv_b64,created_by_actor,created_at,updated_at)
         VALUES('cred','app','KEY123','issuer-1',?,?,'actor',0,0)`,
      )
      .run(encrypted.ciphertext_b64, encrypted.iv_b64);
  }

  /** The delivered payload for the most recent external-state delivery. */
  function latestPayload(sql: Database.Database) {
    const row = sql
      .prepare(
        `SELECT payload_json FROM webhook_deliveries
         WHERE event_type='testflight:external_state_changed'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) : null;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the beta groups an external-state build is assigned to", async () => {
    // artin asked why external groups were missing. The field was never emitted on
    // this path; it now joins build->betaGroups (ids only) with the app-level group
    // list (names) so the notification can print names rather than ids.
    const { sql, send } = await setup();
    await withAscCredentials(sql);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
        if (url.includes("/v1/buildBetaDetails/")) {
          return json({
            data: {
              type: "builds", id: "asc-build-1",
              attributes: { version: "11503001" },
              relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "pre-1" } } },
            },
            included: [{ type: "preReleaseVersions", id: "pre-1", attributes: { version: "1.15.3" } }],
          });
        }
        if (url.includes("include=betaGroups")) {
          return json({
            data: { type: "builds", id: "asc-build-1", relationships: { betaGroups: { data: [{ type: "betaGroups", id: "g-ext" }] } } },
            included: [{ type: "betaGroups", id: "g-ext" }],
          });
        }
        if (url.includes("/betaGroups")) {
          return json({ data: [
            { id: "g-ext", attributes: { name: "External QA", isInternalGroup: false } },
            { id: "g-int", attributes: { name: "Botiverse", isInternalGroup: true } },
          ] });
        }
        return json({ data: {} });
      }),
    );

    expect((await send(betaEvent())).status).toBe(200);
    const payload = latestPayload(sql);
    // Assigned group only, labelled external so the line is not confused with the
    // internal-beta notification's "测试组" line.
    expect(payload.payload.groups_display).toBe("组：External QA（外部）");
    expect(payload.payload.build).toMatchObject({ version: "1.15.3", version_code: "11503001" });
  });

  it("omits groups_display when the build has no assigned groups", async () => {
    // Absent, not empty: an empty string would assert "assigned to nothing", which is
    // a claim the adapter has not established.
    const { sql, send } = await setup();
    await withAscCredentials(sql);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/v1/buildBetaDetails/")) {
        return json({ data: { type: "builds", id: "b1", attributes: { version: "11503001" }, relationships: {} } });
      }
      return json({ data: [], included: [] });
    }));
    expect((await send(betaEvent())).status).toBe(200);
    expect(latestPayload(sql).payload.groups_display).toBeUndefined();
  });

  it("names the build for a buildUploads event from the resource's own attributes", async () => {
    // buildUploads carries cfBundleShortVersionString / cfBundleVersion directly, so
    // no relationship is followed. Before this, that event type was absent from
    // BUILD_LOOKUP and the resolver also refused any resource that was not
    // buildBetaDetails -- two gates, and opening only one would have changed nothing.
    const { sql, send } = await setup();
    await withAscCredentials(sql);

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(
          JSON.stringify({
            data: {
              type: "buildUploads",
              id: "upload-1",
              attributes: {
                cfBundleShortVersionString: "1.15.3",
                cfBundleVersion: "11503001",
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const res = await send({
      data: {
        id: "upload-event",
        type: "buildUploadStateUpdated",
        version: 1,
        attributes: { newState: "COMPLETE" },
        relationships: { instance: { data: { type: "buildUploads", id: "upload-1" } } },
      },
    });
    expect(res.status).toBe(200);

    const row = sql
      .prepare(
        `SELECT payload_json FROM webhook_deliveries
         WHERE event_type='app_store:build_upload_state_changed' ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { payload_json: string } | undefined;
    expect(JSON.parse(row!.payload_json).payload.build).toEqual({
      version: "1.15.3",
      version_code: "11503001",
    });
    // The include is only meaningful for buildBetaDetails; asking for it here could
    // be rejected by Apple.
    expect(calls.some((u) => u.includes("include=preReleaseVersion"))).toBe(false);
  });

  it("leaves build null when an upload event has no version yet", async () => {
    // Upload events can fire before Apple populates these fields. Naming a version
    // that is not established yet would be worse than leaving the notification blank.
    const { sql, send } = await setup();
    await withAscCredentials(sql);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { type: "buildUploads", id: "upload-1", attributes: {} } }), {
          status: 200, headers: { "content-type": "application/json" },
        })),
    );
    const res = await send({
      data: {
        id: "upload-empty",
        type: "buildUploadStateUpdated",
        version: 1,
        attributes: { newState: "PROCESSING" },
        relationships: { instance: { data: { type: "buildUploads", id: "upload-1" } } },
      },
    });
    expect(res.status).toBe(200);
    const row = sql
      .prepare(
        `SELECT payload_json FROM webhook_deliveries
         WHERE event_type='app_store:build_upload_state_changed' ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as { payload_json: string } | undefined;
    expect(JSON.parse(row!.payload_json).payload.build).toBeNull();
  });

  it("names the build by following buildBetaDetails->build and keeps the envelope intact", async () => {
    const { sql, send } = await setup();
    await withAscCredentials(sql);

    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        // Beta group lookups are a separate, additive concern; answer them empty so
        // this test keeps asserting only the identity lookup it was written for.
        if (url.includes("/betaGroups")) {
          return new Response(JSON.stringify({ data: [], included: [] }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        // ASC returns the BUILD here: `builds.version` is the BUILD NUMBER.
        // The marketing version only exists on the included preReleaseVersion.
        return new Response(
          JSON.stringify({
            data: {
              type: "builds",
              id: "asc-build-1",
              attributes: { version: "11400009" },
              relationships: {
                preReleaseVersion: {
                  data: { type: "preReleaseVersions", id: "pre-1" },
                },
              },
            },
            included: [
              {
                type: "preReleaseVersions",
                id: "pre-1",
                attributes: { version: "1.14.0" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    expect((await send(betaEvent())).status).toBe(200);

    // The identity lookup hits the documented relationship endpoint. Group
    // resolution adds its own call(s) after it, so assert on the first rather than
    // the total; the group case has its own test.
    expect(calls[0]).toContain("/v1/buildBetaDetails/beta-1/build");
    expect(calls[0]).toContain("include=preReleaseVersion");

    const payload = latestPayload(sql);
    expect(payload.payload.build).toEqual({
      version: "1.14.0",
      version_code: "11400009",
    });
    // The pre-existing envelope must not shift.
    expect(payload.payload.state).toBe("READY_FOR_BETA_TESTING");
    expect(payload.payload.resource).toEqual({
      type: "buildBetaDetails",
      id: "beta-1",
    });
    expect(payload.event).toBe("testflight:external_state_changed");
  });

  it("still delivers the notification when the ASC lookup fails", async () => {
    const { sql, send } = await setup();
    await withAscCredentials(sql);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    expect((await send(betaEvent())).status).toBe(200);

    const payload = latestPayload(sql);
    expect(payload).not.toBeNull();
    // Degraded, not dropped.
    expect(payload.payload.build).toBeNull();
    expect(payload.payload.state).toBe("READY_FOR_BETA_TESTING");
    expect(
      sql
        .prepare(
          "SELECT COUNT(*) n FROM webhook_deliveries WHERE event_type='testflight:external_state_changed'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("always emits the build key, so null is distinguishable from absent", async () => {
    const { sql, send } = await setup();
    await withAscCredentials(sql);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    expect((await send(betaEvent())).status).toBe(200);

    // A consumer that checks for the key's presence rather than its value
    // would otherwise read "unresolved" as "old payload shape".
    expect("build" in latestPayload(sql).payload).toBe(true);
    expect(latestPayload(sql).payload.build).toBeNull();
  });

  it("delivers with build=null when the app has no ASC credentials", async () => {
    const { sql, send } = await setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect((await send(betaEvent())).status).toBe(200);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(latestPayload(sql).payload.build).toBeNull();
  });

  it("does not call ASC for events whose resource is not a build", async () => {
    const { sql, send } = await setup();
    await withAscCredentials(sql);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect((await send(fixture("version-event"))).status).toBe(200);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = sql
      .prepare(
        "SELECT payload_json FROM webhook_deliveries WHERE event_type='app_store:version_state_changed'",
      )
      .get() as { payload_json: string };
    expect(JSON.parse(row.payload_json).payload.build).toBeNull();
  });
});
