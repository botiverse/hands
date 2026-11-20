/**
 * Crash alerts are decided after symbolication, not on a timer.
 *
 * Regression: a Raft Android 1.26.0 crash whose retrace took 21.6 s was
 * announced as a new group under its obfuscated signature, although the
 * retraced stack belonged to an existing group. Here retrace is held open for
 * as long as the test likes; no alert may go out until it settles.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

let releaseRetrace: () => void = () => {};
let retraceGate: Promise<void> = Promise.resolve();
let retraceCalls = 0;
const RETRACED = "Stack trace:\njava.lang.IllegalStateException: LayoutNode should be attached to an owner\n\tat androidx.compose.ui.node.LayoutNodeKt.requireOwner(LayoutNode.kt:1)\n\tat build.raft.app.Feed.scroll(Feed.kt:9)\n";

vi.mock("@cloudflare/containers", () => ({
  getRandom: async () => ({
    fetch: async () => {
      retraceCalls += 1;
      await retraceGate;
      return Response.json({ retraced: RETRACED });
    },
  }),
}));

const { handlePublicFeedbackSubmit, sweepPendingCrashAlerts, decideCrashAlert } = await import("../src/routes/feedback");

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


const RETRACED_SIGNATURE = "java.lang.IllegalStateException@androidx.compose.ui.node.LayoutNodeKt.requireOwner";

function environment() {
  const sqlite = new Database(":memory:");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  sqlite.prepare(
    `INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
     VALUES ('org', 'org', 'Org', 'raft', 'server', 1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO raft_accounts (id, provider_subject, server_id, principal_type, display_name, raw_profile,
       created_at, updated_at, last_login_at)
     VALUES ('account', 'account', 'server', 'agent', 'Account', '{}', 1, 1, 1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
     VALUES ('app', 'org', 'raft-android', 'Raft Android', 'android', 'client-key', 1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO builds (id, app_id, version_name, version_code, created_at, updated_at)
     VALUES ('build', 'app', '1.26.0', 12600001, 1, 1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO build_assets (id, build_id, platform, filetype, r2_key, file_hash, size_bytes, created_at, artifact_kind)
     VALUES ('mapping', 'build', 'android', 'txt', 'mappings/build.txt', 'h', 1, 1, 'proguard-mapping')`,
  ).run();
  sqlite.prepare(
    `INSERT INTO webhooks (id, org_id, app_id, url, secret, events_json, enabled, created_by, created_at, updated_at)
     VALUES ('wh', 'org', 'app', 'https://hooks.test/crash', 'secret', '["crash:new_group","crash:spike"]', 1, 'account', 1, 1)`,
  ).run();
  const objects = new Map<string, Uint8Array>();
  const pending: Promise<unknown>[] = [];
  const env = {
    DB: d1(sqlite),
    APK_BUCKET: {
      put: async (key: string, value: ArrayBuffer) => objects.set(key, new Uint8Array(value)),
      delete: async () => {},
      head: async () => null,
      get: async (key: string) => {
        const value = objects.get(key);
        return value ? { text: async () => new TextDecoder().decode(value), arrayBuffer: async () => value.buffer } : null;
      },
    },
    R2_S3_ENDPOINT: "https://r2.test",
    R2_BUCKET_NAME: "bucket",
    R2_S3_ACCESS_KEY_ID: "id",
    R2_S3_SECRET_ACCESS_KEY: "secret",
    ENVIRONMENT: "production",
    DASHBOARD_ORIGIN: "https://dashboard.test",
    FEEDBACK_AUDIT_HMAC_KEY: "crash-alert-test-audit-key-with-enough-entropy",
    FEEDBACK_AUDIT_KEY_VERSION: "test-v1",
  } as unknown as Env;
  const executionCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined };
  return { sqlite, env, executionCtx, pending };
}

async function submitObfuscatedCrash(h: ReturnType<typeof environment>, ip: string) {
  const form = new FormData();
  form.set("kind", "crash");
  form.set("message", "Crash: java.lang.IllegalStateException: LayoutNode should be attached to an owner\nat x26.c(r8-map-id-abc:3)");
  form.set("metadata", JSON.stringify({ version_name: "1.26.0", version_code: 12600001, crash_exception_class: "java.lang.IllegalStateException", crash_top_frame: "x26.c(r8-map-id-abc:3)" }));
  form.append("attachments", new File(["Stack trace:\njava.lang.IllegalStateException: LayoutNode should be attached to an owner\n\tat x26.c(r8-map-id-abc:3)\n"], "crash.txt", { type: "text/plain" }));
  const res = await handlePublicFeedbackSubmit({
    env: h.env,
    executionCtx: h.executionCtx,
    req: {
      url: "https://hands.test/public/v2/apps/raft-android/feedback",
      raw: { cf: { clientIp: ip } },
      param: (name: string) => (name === "slug" ? "raft-android" : undefined),
      header: (name: string) => (name === "X-Hands-Client-Key" ? "client-key" : undefined),
      query: () => undefined,
      formData: async () => form,
    },
    header: () => undefined,
    json: (data: unknown, status = 200) => Response.json(data, { status }),
  } as any);
  expect(res.status).toBe(201);
  return String((await res.json() as { id: string }).id);
}

const alerts = (sqlite: Database.Database) =>
  sqlite.prepare("SELECT event_type, payload_json FROM webhook_deliveries WHERE webhook_id = 'wh' ORDER BY created_at").all() as Array<{ event_type: string; payload_json: string }>;
const ticket = (sqlite: Database.Database, id: string) =>
  sqlite.prepare("SELECT signature, symbolication_status, crash_alert_pending_since FROM feedback_tickets WHERE id = ?").get(id) as Record<string, unknown>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("crash alerts wait for symbolication", () => {
  it("announces nothing while retrace runs, then nothing for an existing group", async () => {
    const h = environment();
    h.sqlite.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, message, signature, created_at, updated_at)
       VALUES ('old', 'app', 'crash', 'old crash', ?, 1, 1)`,
    ).run(RETRACED_SIGNATURE);
    retraceGate = new Promise((resolve) => { releaseRetrace = resolve; });

    const id = await submitObfuscatedCrash(h, "192.0.2.1");
    for (let i = 0; i < 5; i += 1) await tick();
    expect(retraceCalls).toBeGreaterThan(0);
    expect(alerts(h.sqlite)).toEqual([]);
    expect(ticket(h.sqlite, id).crash_alert_pending_since).not.toBeNull();

    releaseRetrace();
    await Promise.all(h.pending);
    expect(ticket(h.sqlite, id)).toMatchObject({ signature: RETRACED_SIGNATURE, symbolication_status: "symbolicated", crash_alert_pending_since: null });
    expect(alerts(h.sqlite)).toEqual([]);
  });

  it("announces a genuinely new group under its retraced signature and stack", async () => {
    const h = environment();
    retraceGate = Promise.resolve();
    const id = await submitObfuscatedCrash(h, "192.0.2.2");
    await Promise.all(h.pending);
    const sent = alerts(h.sqlite);
    expect(sent.map((a) => a.event_type)).toEqual(["crash:new_group"]);
    const payload = JSON.parse(sent[0]!.payload_json).payload;
    expect(payload).toMatchObject({ ticket_id: id, signature: RETRACED_SIGNATURE });
    expect(payload.top_frames[0]).toContain("androidx.compose.ui.node.LayoutNodeKt.requireOwner");
  });

  it("the cron sweep finishes a run that was cut short", async () => {
    const h = environment();
    retraceGate = new Promise(() => {}); // the in-request run never finishes
    const id = await submitObfuscatedCrash(h, "192.0.2.3");
    await tick();
    expect(alerts(h.sqlite)).toEqual([]);
    const createdAt = (h.sqlite.prepare("SELECT created_at FROM feedback_tickets WHERE id = ?").get(id) as { created_at: number }).created_at;

    // Too young: left alone.
    expect(await sweepPendingCrashAlerts(h.env, createdAt + 60_000)).toBe(0);
    retraceGate = Promise.resolve();
    expect(await sweepPendingCrashAlerts(h.env, createdAt + 4 * 60_000)).toBe(1);
    expect(ticket(h.sqlite, id)).toMatchObject({ signature: RETRACED_SIGNATURE, symbolication_status: "symbolicated", crash_alert_pending_since: null });
    expect(alerts(h.sqlite).map((a) => a.event_type)).toEqual(["crash:new_group"]);
    // Decided once: a later sweep finds nothing.
    expect(await sweepPendingCrashAlerts(h.env, createdAt + 10 * 60_000)).toBe(0);
    expect(alerts(h.sqlite)).toHaveLength(1);
  });

  it("raises a spike for one device crash-looping and says how many devices", async () => {
    const h = environment();
    const signature = "org.intellij.markdown.MarkdownParsingException@org.intellij.markdown.parser.TreeBuilder.buildTree";
    const base = Date.now() - 30 * 60_000;
    for (let n = 1; n <= 11; n += 1) {
      const id = `t${n}`;
      h.sqlite.prepare(
        `INSERT INTO feedback_tickets (id, app_id, kind, message, signature, device_id, created_at, updated_at, crash_alert_pending_since)
         VALUES (?, 'app', 'crash', 'Crash: MarkdownParsingException', ?, 'device-a', ?, ?, ?)`,
      ).run(id, signature, base + n * 1000, base + n * 1000, base + n * 1000);
      await decideCrashAlert(h.env, id);
    }
    const sent = alerts(h.sqlite);
    expect(sent.map((a) => a.event_type)).toEqual(["crash:new_group", "crash:spike"]);
    expect(JSON.parse(sent[1]!.payload_json).payload).toMatchObject({ count_last_hour: 10, devices_last_hour: 1 });
  });
});
