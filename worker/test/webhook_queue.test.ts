import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueDueDeliveries,
  handleWebhookQueue,
  processDeliveryById,
} from "../src/routes/webhooks";

// Same minimal schema as webhook_reaper.test.ts (D1-stub over better-sqlite3).
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
      const normalized = sql.replace(/\?(\d+)/g, (_m, i) => {
        indexes.push(Number(i));
        return "?";
      });
      const statement = sqlite.prepare(normalized);
      const bind = (...params: unknown[]) => {
        const expanded = indexes.length > 0
          ? indexes.map((index) => params[index - 1])
          : params;
        return {
          run: async () => {
            const r = statement.run(...expanded);
            return { success: true, meta: { changes: r.changes } };
          },
          all: async <T>() => ({ results: statement.all(...expanded) as T[], success: true }),
          first: async <T>() => (statement.get(...expanded) as T | undefined) ?? null,
        };
      };
      return { bind, run: () => bind().run(), all: <T>() => bind().all<T>(), first: <T>() => bind().first<T>() };
    },
  };
}

type Db = ReturnType<typeof makeDb>;
const env = (db: Db, queue?: { sent: string[] }) => ({
  DB: db as unknown as D1Database,
  ...(queue ? { WEBHOOK_QUEUE: { sendBatch: async (msgs: { body: { delivery_id: string } }[]) => { for (const m of msgs) queue.sent.push(m.body.delivery_id); return { success: true }; } } } : {}),
});

async function insertWebhook(db: Db, id: string) {
  await db.prepare(
    `INSERT INTO webhooks (id, url, secret, enabled, archived_at) VALUES (?1,?2,?3,1,NULL)`,
  ).bind(id, `https://receiver.example/${id}`, `secret-${id}`).run();
}
async function insertDelivery(db: Db, id: string, webhookId: string, createdAt: number, opts: { status?: string; nextAttemptAt?: number | null } = {}) {
  await db.prepare(
    `INSERT INTO webhook_deliveries
     (id, webhook_id, event_type, event_id, payload_json, signing_secret, status,
      attempts, max_attempts, next_attempt_at, created_at, updated_at)
     VALUES (?1,?2,'feedback:status_changed',?3,?4,?5,?6,0,3,?7,?8,?8)`,
  ).bind(
    id, webhookId, `event-${id}`,
    JSON.stringify({ event: "feedback:status_changed", marker: `body-${id}` }),
    `frozen-${webhookId}`,
    opts.status ?? "pending",
    opts.nextAttemptAt ?? null,
    createdAt,
  ).run();
}
const ledger = (db: Db, id: string) => db.prepare(
  `SELECT status, attempts, last_error, completed_at FROM webhook_deliveries WHERE id=?1`,
).bind(id).first<{ status: string; attempts: number; last_error: string | null; completed_at: number | null }>();

const okFetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

function batchOf(ids: (string | null)[]): MessageBatch<{ delivery_id?: string }> {
  return {
    queue: "hands-webhook-deliveries",
    messages: ids.map((id, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      body: id === null ? {} : { delivery_id: id },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    })),
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<{ delivery_id?: string }>;
}

describe("webhook queue — real-time first attempt", () => {
  it("enqueues only the pending deliveries created at that `now`", async () => {
    const db = makeDb();
    await insertWebhook(db, "w1");
    await insertDelivery(db, "d-new", "w1", 5000);
    await insertDelivery(db, "d-old", "w1", 1000);
    const sent: string[] = [];
    const n = await enqueueDueDeliveries(env(db, { sent }), 5000);
    expect(n).toBe(1);
    expect(sent).toEqual(["d-new"]);
  });

  it("processDeliveryById posts immediately and marks succeeded", async () => {
    const db = makeDb();
    await insertWebhook(db, "w1");
    await insertDelivery(db, "d1", "w1", 1);
    const outcome = await processDeliveryById(env(db), "d1", { fetchImpl: okFetch });
    expect(outcome).toBe("succeeded");
    expect(await ledger(db, "d1")).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("queue consumer resolves ids, delivers, and acks every message", async () => {
    const db = makeDb();
    await insertWebhook(db, "w1");
    await insertDelivery(db, "d1", "w1", 1);
    await insertDelivery(db, "d2", "w1", 1);
    const batch = batchOf(["d1", "d2", "ghost", null]);
    // Inject the fetch the consumer's postOnce will use via a module seam is
    // unavailable; handleWebhookQueue uses global fetch — stub it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = okFetch;
    try {
      await handleWebhookQueue(batch, env(db));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(await ledger(db, "d1")).toMatchObject({ status: "succeeded" });
    expect(await ledger(db, "d2")).toMatchObject({ status: "succeeded" });
    for (const m of batch.messages) expect(m.ack).toHaveBeenCalled();
  });

  it("a non-pending delivery id is a no-op (duplicate queue message)", async () => {
    const db = makeDb();
    await insertWebhook(db, "w1");
    await insertDelivery(db, "d1", "w1", 1, { status: "succeeded" });
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      const outcome = await processDeliveryById(env(db), "d1", { fetchImpl: fetchSpy });
      expect(outcome).toBe("already_terminal");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect((fetchSpy as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
