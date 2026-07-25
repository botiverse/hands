import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { reapWebhookDeliveries } from "../src/routes/webhooks";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      archived_at INTEGER
    );
    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_id TEXT,
      feedback_submission_event_id TEXT,
      payload_json TEXT NOT NULL,
      signing_secret TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_attempt_at INTEGER,
      next_attempt_at INTEGER,
      last_response_status INTEGER,
      last_response_body TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);

  return {
    prepare(sql: string) {
      const indexes: number[] = [];
      const normalized = sql.replace(/\?(\d+)/g, (_match, index) => {
        indexes.push(Number(index));
        return "?";
      });
      const statement = sqlite.prepare(normalized);
      const bind = (...params: unknown[]) => {
        const expanded = indexes.length > 0
          ? indexes.map((index) => params[index - 1])
          : params;
        if (expanded.some((value) => value === undefined)) {
          throw new TypeError("D1 bind rejects undefined; use explicit null");
        }
        return {
          run: async () => {
            const result = statement.run(...expanded);
            return { success: true, meta: { changes: result.changes } };
          },
          all: async <T>() => ({
            results: statement.all(...expanded) as T[],
            success: true,
          }),
          first: async <T>() => (statement.get(...expanded) as T | undefined) ?? null,
        };
      };
      return {
        bind,
        run: () => bind().run(),
        all: <T>() => bind().all<T>(),
        first: <T>() => bind().first<T>(),
      };
    },
  };
}

async function insertWebhook(
  db: ReturnType<typeof makeDb>,
  id: string,
  options: { enabled?: number; archivedAt?: number | null } = {},
) {
  await db.prepare(
    `INSERT INTO webhooks (id, url, secret, enabled, archived_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(
    id,
    `https://receiver.example/${id}`,
    `secret-${id}`,
    options.enabled ?? 1,
    options.archivedAt ?? null,
  ).run();
}

async function insertDelivery(
  db: ReturnType<typeof makeDb>,
  id: string,
  webhookId: string,
  createdAt: number,
) {
  await db.prepare(
    `INSERT INTO webhook_deliveries
     (id, webhook_id, event_type, event_id, payload_json, signing_secret,
      status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
     VALUES (?1, ?2, 'feedback:status_changed', ?3, ?4, ?5,
             'pending', 0, 3, 0, ?6, ?6)`,
  ).bind(
    id,
    webhookId,
    `event-${id}`,
    JSON.stringify({ event: "feedback:status_changed", marker: `body-${id}` }),
    `frozen-${webhookId}`,
    createdAt,
  ).run();
}

async function deliveryLedger(db: ReturnType<typeof makeDb>, id: string) {
  return db.prepare(
    `SELECT status, attempts, next_attempt_at, last_response_body,
            last_error, completed_at
     FROM webhook_deliveries WHERE id = ?1`,
  ).bind(id).first<{
    status: string;
    attempts: number;
    next_attempt_at: number | null;
    last_response_body: string | null;
    last_error: string | null;
    completed_at: number | null;
  }>();
}

describe("webhook delivery reaper progress guarantee", () => {
  it("times out a hung oldest endpoint without blocking a healthy later row", async () => {
    const db = makeDb();
    await insertWebhook(db, "hung");
    await insertWebhook(db, "healthy");
    await insertDelivery(db, "delivery-hung", "hung", 1);
    await insertDelivery(db, "delivery-healthy", "healthy", 2);

    const fetchImpl = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith("/hung")) {
        return new Promise<Response>(() => {});
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    const summary = await reapWebhookDeliveries(
      { DB: db as unknown as D1Database },
      {
        now: 1_000,
        scheduledTime: 900,
        fetchImpl,
        deliveryTimeoutMs: 20,
        concurrency: 2,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      scheduledTime: 900,
      selected: 2,
      succeeded: 1,
      retried: 1,
      terminalized: 0,
      errorCodes: { delivery_timeout: 1 },
    });
    expect(await deliveryLedger(db, "delivery-hung")).toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: 301_000,
      last_error: "delivery_timeout",
    });
    expect(await deliveryLedger(db, "delivery-healthy")).toMatchObject({
      status: "succeeded",
      attempts: 1,
      next_attempt_at: null,
      last_error: null,
      completed_at: 1_000,
    });

    const redactedSummary = JSON.stringify(summary);
    expect(redactedSummary).not.toContain("receiver.example");
    expect(redactedSummary).not.toContain("frozen-hung");
    expect(redactedSummary).not.toContain("body-delivery-hung");
    expect(redactedSummary).not.toContain("event-delivery-hung");
    expect(redactedSummary).not.toContain("delivery-hung");
  });

  it("terminalizes 50 missing-webhook rows so the next cron reaches row 51", async () => {
    const db = makeDb();
    for (let index = 1; index <= 50; index++) {
      await insertDelivery(db, `missing-${index.toString().padStart(2, "0")}`, `gone-${index}`, index);
    }
    await insertWebhook(db, "healthy-51");
    await insertDelivery(db, "healthy-row-51", "healthy-51", 51);
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      new Response(null, { status: 204 }));
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const first = await reapWebhookDeliveries(
      { DB: db as unknown as D1Database },
      { now: 1_000, fetchImpl },
    );
    expect(first).toMatchObject({
      selected: 50,
      succeeded: 0,
      retried: 0,
      terminalized: 50,
      errorCodes: { webhook_missing: 50 },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM webhook_deliveries WHERE status = 'failed' AND last_error = 'webhook_missing'",
    ).first<{ count: number }>()).toEqual({ count: 50 });

    const second = await reapWebhookDeliveries(
      { DB: db as unknown as D1Database },
      { now: 2_000, fetchImpl },
    );
    expect(second).toMatchObject({
      selected: 1,
      succeeded: 1,
      retried: 0,
      terminalized: 0,
      errorCodes: {},
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await deliveryLedger(db, "healthy-row-51")).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
  });

  it("terminalizes disabled and archived routes without posting to them", async () => {
    const db = makeDb();
    await insertWebhook(db, "disabled", { enabled: 0 });
    await insertWebhook(db, "archived", { archivedAt: 500 });
    await insertWebhook(db, "healthy");
    await insertDelivery(db, "delivery-disabled", "disabled", 1);
    await insertDelivery(db, "delivery-archived", "archived", 2);
    await insertDelivery(db, "delivery-healthy", "healthy", 3);
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      new Response(null, { status: 204 }));
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const summary = await reapWebhookDeliveries(
      { DB: db as unknown as D1Database },
      { now: 1_000, fetchImpl },
    );

    expect(summary).toMatchObject({
      selected: 3,
      succeeded: 1,
      retried: 0,
      terminalized: 2,
      errorCodes: { webhook_disabled: 1, webhook_archived: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://receiver.example/healthy");
    expect(await deliveryLedger(db, "delivery-disabled")).toMatchObject({
      status: "failed",
      attempts: 0,
      last_error: "webhook_disabled",
      completed_at: 1_000,
    });
    expect(await deliveryLedger(db, "delivery-archived")).toMatchObject({
      status: "failed",
      attempts: 0,
      last_error: "webhook_archived",
      completed_at: 1_000,
    });
  });

  it("caps the batch at five concurrent delivery attempts", async () => {
    const db = makeDb();
    for (let index = 1; index <= 12; index++) {
      await insertWebhook(db, `bounded-${index}`);
      await insertDelivery(db, `delivery-bounded-${index}`, `bounded-${index}`, index);
    }
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const summary = await reapWebhookDeliveries(
      { DB: db as unknown as D1Database },
      { now: 1_000, fetchImpl },
    );

    expect(summary).toMatchObject({
      selected: 12,
      succeeded: 12,
      retried: 0,
      terminalized: 0,
      errorCodes: {},
    });
    expect(maxActive).toBe(5);
  });

  it("bounds oversized and continuous response bodies without blocking later rows", async () => {
    const db = makeDb();
    await insertWebhook(db, "oversized");
    await insertWebhook(db, "continuous");
    await insertWebhook(db, "healthy-after-bodies");
    await insertDelivery(db, "delivery-oversized", "oversized", 1);
    await insertDelivery(db, "delivery-continuous", "continuous", 2);
    await insertDelivery(db, "delivery-healthy-after-bodies", "healthy-after-bodies", 3);

    let continuousPulls = 0;
    let continuousCancelled = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oversized")) {
        return new Response(new Uint8Array(100_000).fill(65), { status: 500 });
      }
      if (url.endsWith("/continuous")) {
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            continuousPulls++;
            controller.enqueue(new Uint8Array(256).fill(66));
          },
          cancel() {
            continuousCancelled = true;
            return new Promise<void>(() => {});
          },
        }), { status: 500 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const startedAt = performance.now();
    const summary = await reapWebhookDeliveries(
      { DB: db as unknown as D1Database },
      { now: 1_000, fetchImpl, concurrency: 3, deliveryTimeoutMs: 1_000 },
    );
    const durationMs = performance.now() - startedAt;

    expect(summary).toMatchObject({
      selected: 3,
      succeeded: 1,
      retried: 2,
      terminalized: 0,
      errorCodes: { webhook_http_error: 2 },
    });
    expect(await deliveryLedger(db, "delivery-oversized")).toMatchObject({
      status: "pending",
      attempts: 1,
      last_response_body: "A".repeat(500),
      last_error: "webhook_http_error",
    });
    expect(await deliveryLedger(db, "delivery-continuous")).toMatchObject({
      status: "pending",
      attempts: 1,
      last_response_body: "B".repeat(500),
      last_error: "webhook_http_error",
    });
    expect(await deliveryLedger(db, "delivery-healthy-after-bodies")).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(continuousCancelled).toBe(true);
    expect(continuousPulls).toBeLessThanOrEqual(3);
    expect(durationMs).toBeLessThan(500);
  });

  it("isolates per-row fetch and D1 failures so a healthy row still completes", async () => {
    const db = makeDb();
    await insertWebhook(db, "fetch-error");
    await insertWebhook(db, "d1-error");
    await insertWebhook(db, "healthy");
    await insertDelivery(db, "delivery-fetch-error", "fetch-error", 1);
    await insertDelivery(db, "delivery-d1-error", "d1-error", 2);
    await insertDelivery(db, "delivery-healthy", "healthy", 3);

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/fetch-error")) throw new Error("synthetic network failure");
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const faultingDb = {
      prepare(sql: string) {
        const prepared = db.prepare(sql);
        if (!sql.includes("SET status = 'succeeded'")) return prepared;
        return {
          ...prepared,
          bind(...params: unknown[]) {
            const bound = prepared.bind(...params);
            return {
              ...bound,
              run: async () => {
                if (params[4] === "delivery-d1-error") {
                  throw new Error("synthetic D1 failure");
                }
                return bound.run();
              },
            };
          },
        };
      },
    };

    const summary = await reapWebhookDeliveries(
      { DB: faultingDb as unknown as D1Database },
      { now: 1_000, fetchImpl, concurrency: 3 },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      selected: 3,
      succeeded: 1,
      retried: 2,
      terminalized: 0,
      errorCodes: {
        webhook_fetch_error: 1,
        delivery_processing_error: 1,
      },
    });
    expect(await deliveryLedger(db, "delivery-fetch-error")).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "webhook_fetch_error",
    });
    expect(await deliveryLedger(db, "delivery-d1-error")).toMatchObject({
      status: "pending",
      attempts: 0,
      last_error: null,
    });
    expect(await deliveryLedger(db, "delivery-healthy")).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
  });
});
