import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptP8 } from "../src/lib/asc_credentials";
import { buildFeedbackCommentEvent, buildFeedbackStatusEvent } from "../src/lib/feedback_events";
import { formatRaftNotificationMessage } from "../src/lib/raft_notification_content";
import { notificationObjectKey } from "../src/lib/raft_notification_identity";
import {
  handleConnectRaftBot,
  handleGetRaftNotifications,
  handleListRaftNotificationFailures,
  handleRaftNotificationWebhook,
  handleRetryRaftNotificationFailure,
  handleTestRaftNotification,
  handleUpdateRaftNotification,
} from "../src/routes/raft_notifications";
import { handleDeleteAppWebhook, handleUpdateAppWebhook, hmacSha256Hex, reapWebhookDeliveries, WEBHOOK_EVENT_TYPES } from "../src/routes/webhooks";

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => {
      indexes.push(Number(index));
      return "?";
    }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      return {
        _run: () => {
          const result = statement.run(...expanded);
          return { success: true, meta: { changes: result.changes } };
        },
        run: async () => {
          const result = statement.run(...expanded);
          return { success: true, meta: { changes: result.changes } };
        },
        all: async <T>() => ({ success: true, results: statement.all(...expanded) as T[] }),
        first: async <T>() => (statement.get(...expanded) as T | undefined) ?? null,
      };
    };
    return { bind, run: () => bind().run(), all: <T>() => bind().all<T>(), first: <T>() => bind().first<T>() };
  };
  const batch = async (statements: Array<{ _run: () => unknown }>) =>
    sqlite.transaction(() => statements.map((statement) => statement._run()))();
  return { prepare, batch } as unknown as D1Database;
}

const APP_ID = "abad63e9-e760-42e9-92df-f418735f32ea";
const SUBSCRIPTION_ID = "sub-1";
const SECRET = "webhook-secret";
const BOT_KEY = "sk_agent_test-key";

async function harness() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL);
    CREATE TABLE apps (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, slug TEXT, name TEXT, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE webhooks (
      id TEXT PRIMARY KEY, org_id TEXT, app_id TEXT, url TEXT, secret TEXT NOT NULL,
      events_json TEXT, enabled INTEGER NOT NULL, archived_at INTEGER,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE raft_notification_subscriptions (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, server_id TEXT NOT NULL,
      channel_target TEXT NOT NULL, events_json TEXT NOT NULL, enabled INTEGER NOT NULL,
      bot_installation_id TEXT NOT NULL, webhook_id TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, archived_at INTEGER
    );
    CREATE TABLE raft_bot_installations (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL,
      installation_id TEXT NOT NULL, credential_id TEXT NOT NULL, agent_id TEXT,
      handle TEXT, key_ciphertext_b64 TEXT NOT NULL, key_iv_b64 TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(server_id), UNIQUE(installation_id)
    );
    CREATE TABLE raft_notification_threads (
      subscription_id TEXT NOT NULL, object_key TEXT NOT NULL,
      parent_message_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(subscription_id, object_key)
    );
    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL,
      signing_secret TEXT, external_event_id TEXT, event_id TEXT, feedback_submission_event_id TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      last_attempt_at INTEGER, next_attempt_at INTEGER, last_response_status INTEGER, last_response_body TEXT,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
      actor_id TEXT, actor_type TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  sqlite.exec(readFileSync(new URL("../../migrations/sql/0087_raft_notification_cards.sql", import.meta.url), "utf8"));
  sqlite.prepare("INSERT INTO organizations (id, external_provider, external_id) VALUES ('org-1', 'raft', 'server-1')").run();
  sqlite.prepare("INSERT INTO apps (id, org_id, slug, name, archived) VALUES (?, 'org-1', 'sample-app', 'Sample App', 0)").run(APP_ID);
  sqlite.prepare(
    "INSERT INTO webhooks (id, org_id, app_id, url, secret, events_json, enabled, archived_at, created_at, updated_at) VALUES ('webhook-1', 'org-1', ?, 'https://hands.test/api/internal/raft-notifications/sub-1', ?, '[]', 1, NULL, 1, 1)",
  ).run(APP_ID, SECRET);
  const encrypted = await encryptP8(BOT_KEY, "enc-secret");
  sqlite.prepare(
    `INSERT INTO raft_bot_installations
       (id, server_id, installation_id, credential_id, agent_id, handle,
        key_ciphertext_b64, key_iv_b64, state, created_at, updated_at)
     VALUES ('bot-1', 'server-1', 'installation-1', 'credential-1', 'agent-1', 'hands-bot', ?, ?, 'active', 1, 1)`,
  ).run(encrypted.ciphertext_b64, encrypted.iv_b64);
  sqlite.prepare(
    `INSERT INTO raft_notification_subscriptions
       (id, app_id, server_id, channel_target, events_json, enabled, bot_installation_id, webhook_id, created_at, updated_at)
     VALUES (?, ?, 'server-1', '#releases', '["app_store:version_state_changed"]', 1, 'bot-1', 'webhook-1', 1, 1)`,
  ).run(SUBSCRIPTION_ID, APP_ID);
  const env = {
    DB: d1(sqlite),
    RAFT_API_ORIGIN: "https://api.raft.test",
    DASHBOARD_ORIGIN: "https://hands.test",
    RAFT_CLIENT_ID: "hands-client",
    RAFT_CLIENT_SECRET: "client-secret",
    RAFT_BOT_ENC_KEY: "enc-secret",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.patch("/api/apps/:appId/webhooks/:webhookId", handleUpdateAppWebhook);
  app.delete("/api/apps/:appId/webhooks/:webhookId", handleDeleteAppWebhook);
  app.post("/api/apps/:appId/raft-notifications/connect", handleConnectRaftBot);
  app.get("/api/apps/:appId/raft-notifications", handleGetRaftNotifications);
  app.patch("/api/apps/:appId/raft-notifications/:subscriptionId", handleUpdateRaftNotification);
  app.post("/api/apps/:appId/raft-notifications/:subscriptionId/test", handleTestRaftNotification);
  app.get("/api/apps/:appId/raft-notifications/:subscriptionId/failures", handleListRaftNotificationFailures);
  app.post("/api/apps/:appId/raft-notifications/:subscriptionId/failures/:deliveryId/retry", handleRetryRaftNotificationFailure);
  app.post("/api/internal/raft-notifications/:subscriptionId", handleRaftNotificationWebhook);
  const request = async (body: Record<string, unknown>, deliveryId: string, signature = SECRET) => {
    const raw = JSON.stringify(body);
    return app.fetch(new Request(`https://hands.test/api/internal/raft-notifications/${SUBSCRIPTION_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Hands-Signature": `sha256=${await hmacSha256Hex(signature, raw)}`,
        "X-Hands-Delivery-Id": deliveryId,
      },
      body: raw,
    }), env);
  };
  const getConfig = () => app.fetch(new Request(`https://hands.test/api/apps/${APP_ID}/raft-notifications`), env);
  const updateConfig = (values: Record<string, unknown>) => app.fetch(new Request(`https://hands.test/api/apps/${APP_ID}/raft-notifications/${SUBSCRIPTION_ID}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values),
  }), env);
  const testDestination = () => app.fetch(new Request(`https://hands.test/api/apps/${APP_ID}/raft-notifications/${SUBSCRIPTION_ID}/test`, { method: "POST" }), env);
  const failures = (appId = APP_ID) => app.fetch(new Request(`https://hands.test/api/apps/${appId}/raft-notifications/${SUBSCRIPTION_ID}/failures`), env);
  const retryFailure = (id: string, appId = APP_ID) => app.fetch(new Request(`https://hands.test/api/apps/${appId}/raft-notifications/${SUBSCRIPTION_ID}/failures/${id}/retry`, { method: "POST" }), env);
  const connect = (appId = APP_ID, rotate = false) => app.fetch(new Request(`https://hands.test/api/apps/${appId}/raft-notifications/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rotate }),
  }), env);
  const mutateHiddenWebhook = () => app.fetch(new Request(`https://hands.test/api/apps/${APP_ID}/webhooks/webhook-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: ["build:failed"] }),
  }), env);
  return { sqlite, env, app, request, getConfig, updateConfig, testDestination, failures, retryFailure, connect, mutateHiddenWebhook };
}

const body = (state: string) => ({
  event: "app_store:version_state_changed",
  delivered_at: 100,
  payload: {
    app: { slug: "raft-ios", name: "Raft App" },
    resource: { id: "version-1" },
    previous_state: "IN_REVIEW",
    state,
    version_string: "1.17.0",
    app_store_connect_url: "https://appstoreconnect.apple.com/apps/6789091965",
    review_message: "provider prose must never be forwarded",
  },
});
const stateBody = (state: string, occurredAt: string) => ({
  ...body(state), payload: { ...body(state).payload, occurred_at: occurredAt },
});

const TICKET_ID = "38d49b32-9499-40d2-ad45-3a23dd8c37f7";
const feedbackBody = (event: string, extra: Record<string, unknown> = {}) => ({
  event,
  app_id: "abad63e9-e760-42e9-92df-f418735f32ea",
  delivered_at: 100,
  payload: { ticket_id: TICKET_ID, ...extra },
});

afterEach(() => vi.restoreAllMocks());

function mockRaftFetch(implementation: typeof fetch) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "GET" && url.endsWith("/resolve")) {
      const messageId = decodeURIComponent(url.slice(url.lastIndexOf("/messages/") + "/messages/".length, -"/resolve".length));
      return Response.json({ message: { message_id: messageId, message_card: { revision: 1 } } });
    }
    return implementation(input, init);
  });
}

describe("Hands-managed Raft notifications", () => {
  it("renders a safe review card and omits provider prose", () => {
    const message = formatRaftNotificationMessage(body("REJECTED"));
    expect(message).toContain("App Store · Review rejected");
    expect(message).toContain("1.17.0");
    expect(message).toContain("App Store Connect");
    expect(message).not.toContain("provider prose must never be forwarded");
  });

  it("uses a stable object key for later state changes", async () => {
    expect(await notificationObjectKey(body("IN_REVIEW"))).toBe(
      await notificationObjectKey(body("REJECTED")),
    );
  });

  it("adds clear icons to feedback events and the details command", () => {
    for (const [event, heading] of [
      ["feedback:new", "📮 **New feedback report · sample-app**"],
      ["feedback:comment_created", "💬 **New comment · sample-app**"],
      ["feedback:status_changed", "🔄 **Feedback status changed · sample-app**"],
    ] as const) {
      const message = formatRaftNotificationMessage(feedbackBody(event, { app_slug: "sample-app" }));
      expect(message.startsWith(heading)).toBe(true);
      expect(message).toContain(`📖 View more: \`hands feedback show sample-app ${TICKET_ID}\``);
    }
    expect(formatRaftNotificationMessage(body("REJECTED")).startsWith("🍎 **Raft App · App Store · Review rejected**")).toBe(true);
  });

  it("keeps release context and identifies a first Play observation", () => {
    const message = formatRaftNotificationMessage({
      event: "google_play:release_state_changed", app_id: "abad63e9-e760-42e9-92df-f418735f32ea",
      payload: {
        package_name: "build.example.app", track: "alpha", version_code: 11800003,
        state: "RELEASE_LIFECYCLE_STATE_PUBLISHED", state_label: "Track available", observation: "initial_snapshot",
        rollout_percent: 20,
      },
    });
    expect(message).toContain("Google Play · Available on track (may be partially rolled out or paused)");
    expect(message).toContain("First observation; this may not be a recent change.");
    expect(message).toContain("track: alpha");
    expect(message).toContain("Reported rollout: 20%");
    const release = formatRaftNotificationMessage({
      event: "release:published", payload: { rollout: 100, version_transition: "1.0 → 1.1", version_code_transition: "1 → 2" },
    });
    expect(release).toContain("🚀 **Release published**");
    expect(release).toContain("Version change: 1.0 → 1.1");
    expect(release).toContain("Build change: 1 → 2");
    expect(release).toContain("Rollout: 100%");
  });

  it("distinguishes Play promotion, saved edits, review requests and symbol uploads", () => {
    const make = (event: string, extra: Record<string, unknown> = {}) => formatRaftNotificationMessage({
      event, payload: { app: { name: "Raft Android" }, version: "1.19.0", version_code: 11900002, ...extra },
    });
    const submitted = make("google_play:submission_succeeded", { track: "production", rollout_percent: 20 });
    expect(submitted).toContain("Google Play · Release submitted");
    expect(submitted).toContain("Review status is not yet confirmed");
    expect(submitted).toContain("1.19.0 · version code 11900002 · track: production");
    expect(submitted).toContain("Requested rollout: 20%");
    const distinct = make("google_play:submission_succeeded", { build_number: "ci-12", version_code: 11900002 });
    expect(distinct).toContain("version code 11900002");
    expect(distinct).toContain("Build: ci-12");
    const saved = make("google_play:submission_succeeded", { action: "promote", review_requested: false });
    expect(saved).toContain("Release saved; not sent for review");
    expect(saved).not.toContain("Review status is not yet confirmed");
    const request = make("google_play:submission_succeeded", { action: "send-for-review", review_requested: true });
    expect(request).toContain("Review request sent");
    expect(request).toContain("Review status is not yet confirmed");
    const symbols = make("google_play:submission_succeeded", { action: "upload-symbols" });
    expect(symbols).toContain("Symbols uploaded");
    expect(symbols).not.toContain("Release submitted");
    expect(symbols).not.toContain("Review status is not yet confirmed");
    const failedSymbols = make("google_play:submission_failed", { action: "upload-symbols", reason: "play_api_rejected" });
    expect(failedSymbols).toContain("Symbols upload failed or was blocked");
    expect(failedSymbols).toContain("Reason code: play\\_api\\_rejected");
    expect(failedSymbols).not.toContain("Release submission failed");
  });

  it("renders known review states without overstating Play availability or TestFlight invitations", () => {
    const play = formatRaftNotificationMessage({ event: "google_play:release_state_changed", payload: {
      app: { name: "Raft Android" }, state: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
      previous_state: "RELEASE_LIFECYCLE_STATE_IN_REVIEW", observation: "transition", track: "production",
    } });
    expect(play).toContain("Available on track (may be partially rolled out or paused)");
    expect(play).toContain("Previously: In review");
    expect(play).not.toContain("First observation");
    const notSent = formatRaftNotificationMessage({ event: "google_play:release_state_changed", payload: {
      state: "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW",
    } });
    expect(notSent).toContain("Google Play · Not sent for review");
    expect(notSent).not.toContain("Ready to submit");
    const testflight = formatRaftNotificationMessage({ event: "testflight:external_state_changed", payload: {
      app: { name: "Raft App" }, state: "READY_FOR_BETA_TESTING", build: { version: "1.19.1", version_code: "11901002" },
      groups_display: "测试组：Botiverse（内部）、Insiders（外部）",
    } });
    expect(testflight).toContain("TestFlight · Ready for beta testing");
    expect(testflight).toContain("1.19.1 · build 11901002");
    expect(testflight).toContain("Test groups: Botiverse（内部）、Insiders（外部）");
    expect(testflight).not.toContain("invited");
    const unknown = formatRaftNotificationMessage({ event: "testflight:external_state_changed", payload: { state: "A_NEW_APPLE_STATE" } });
    expect(unknown).toContain("TestFlight · Status changed");
    expect(unknown).toContain("Status: A\\_NEW\\_APPLE\\_STATE");
  });

  it("distinguishes an AppGallery market package from invitation-test review", () => {
    const market = formatRaftNotificationMessage({ event: "appgallery:package_state_changed", payload: {
      state: "ready", previous_state: "processing", observation_display: "定时查询观测（不是正式上架审核结果）",
    } });
    expect(market).toContain("Market package processed");
    expect(market).not.toContain("not submitted for review");
    expect(market).toContain("Observed by polling; this is not an app-store review result.");
    const withdrawn = formatRaftNotificationMessage({ event: "appgallery:invitation_state_changed", payload: {
      state: "ready", previous_state: "testing_review", state_label: "开发者撤回邀请测试审核",
    } });
    expect(withdrawn).toContain("Invitation test review withdrawn by developer");
    expect(withdrawn).not.toContain("Ready to submit for invitation testing");
  });

  it("does not imply a canary replaced a release and names the restored version on rollback", () => {
    const base = { app: { name: "Desktop" }, channel: "main", version: "2.0", version_code: 200, rollout: 20 };
    const canary = formatRaftNotificationMessage({ event: "release:published", payload: { ...base, previous_version: null } });
    expect(canary).toContain("Desktop · Release published");
    expect(canary).toContain("2.0 (200) · channel: main");
    expect(canary).toContain("Rollout: 20%");
    expect(canary).not.toContain("Replaced:");
    const rollback = formatRaftNotificationMessage({ event: "release:rolled_back", payload: {
      ...base, version: "1.9", version_code: 190, previous_version: "2.0", previous_version_code: 200, rollout: 100,
    } });
    expect(rollback).toContain("Restored: 1.9 (190) · channel: main");
    expect(rollback).toContain("Replaced: 2.0 (200)");
    const empty = formatRaftNotificationMessage({ event: "release:channel_emptied", payload: base });
    expect(empty).toContain("no active release");
    expect(empty).toContain("Cancelled: 2.0 (200) · channel: main");
  });

  it("uses common safe fields for events without a custom presentation", () => {
    const message = formatRaftNotificationMessage({
      event: "release:future_event",
      payload: { version: "1.2.3", rollout: 25, state: "draft", message: "private text" },
    });
    expect(message.startsWith("**Hands · release:future_event**")).toBe(true);
    expect(message).toContain("version: 1.2.3");
    expect(message).toContain("rollout: 25%");
    expect(message).not.toContain("private text");
    expect(formatRaftNotificationMessage({ event: "release", payload: { rollout: 25 } })).not.toContain("rollout:");
  });

  it("shows bounded, safe TestFlight notes and group context only for TestFlight", () => {
    const payload = {
      groups_display: "测试组：Botiverse",
      what_to_test: { "zh-Hans": `Check @admin #release https://example.test/private ${"x".repeat(1200)}` },
      source: "hands_operation_receipt",
      source_commit: "a1b2c3d4",
    };
    const message = formatRaftNotificationMessage({ event: "testflight:internal_distribution_ready", payload });
    expect(message.startsWith("✈️ **TestFlight · Ready for internal testing**")).toBe(true);
    expect(message).toContain("Test groups: Botiverse");
    expect(message).toContain("What to test:\n```text\n  Check @\u200badmin #\u200brelease [link]");
    expect(message).toContain("Commit: a1b2c3d4");
    expect(message).not.toContain("hands_operation_receipt");
    expect(payload.source).toBe("hands_operation_receipt");
    expect(message).toContain("…");
    expect(message).not.toContain("https://example.test");
    expect(formatRaftNotificationMessage({ event: "release:published", payload })).not.toContain("Test notes");
  });

  it("renders a descriptive heading for every supported webhook event", () => {
    for (const event of WEBHOOK_EVENT_TYPES) {
      const message = formatRaftNotificationMessage({ event, payload: { kind: "feedback" } });
      expect(message.split("\n")[0], event).not.toContain(event);
      expect(message.split("\n")[0], event).toMatch(/\*\*.+\*\*/);
    }
  });

  it("combines state transitions and avoids repeating identical build values", () => {
    const message = formatRaftNotificationMessage({
      event: "app_store:build_upload_state_changed", app_id: "app-id",
      payload: { app: { name: "Raft App" }, state: "COMPLETE", previous_state: "PROCESSING",
        version: "1.19.2", version_name: "1.19.2", build_number: "11902002", version_code: 11902002 },
    });
    expect(message).toContain("📦 **Raft App · App Store · Upload processed**\n1.19.2 · build 11902002\nPreviously: Processing upload");
    expect(message).not.toContain("app-id");
    expect(message).not.toContain("previous state:");
    expect(message).not.toContain("version name:");
    expect(message).not.toContain("version code:");
    const distinct = formatRaftNotificationMessage({ event: "build:succeeded", payload: {
      version: "1.0", version_name: "1.0-beta", build_number: "12", version_code: 13,
    } });
    expect(distinct).toContain("1.0 (12)");
    expect(distinct).toContain("Version name: 1.0-beta");
    expect(distinct).toContain("Version code: 13");
  });

  it("makes crash spikes actionable without including crash content", () => {
    const message = formatRaftNotificationMessage({
      event: "crash:spike", app_id: "abad63e9-e760-42e9-92df-f418735f32ea",
      payload: { app_slug: "sample-app", ticket_id: TICKET_ID, count_last_hour: 50,
        version_name: "1.19.2", message: "PRIVATE STACK", signature: "PRIVATE SIGNATURE" },
    });
    expect(message).toContain("📈 **sample-app · Crash spike**");
    expect(message).toContain("50 reports in the last hour");
    expect(message).toContain(`hands feedback show sample-app ${TICKET_ID}`);
    expect(message.match(new RegExp(TICKET_ID, "g"))).toHaveLength(1);
    expect(message).not.toContain("PRIVATE STACK");
    expect(message).not.toContain("PRIVATE SIGNATURE");
  });

  it("does not show internal event source metadata in release notifications", () => {
    for (const [event, source] of [
      ["testflight:upload_processing", "hands_operation_receipt"],
      ["google_play:release_state_changed", "google_play_release_lifecycle"],
      ["appgallery:package_state_changed", "hands_appgallery_market_package"],
    ] as const) {
      const payload = { source, state: "READY", version: "1.19.2", build: { source: "build-source" } };
      const message = formatRaftNotificationMessage({ event, payload });
      expect(message).toContain("Status: READY");
      expect(message).toContain("1.19.2");
      expect(message).not.toContain("\nsource:");
      expect(message).not.toContain(source);
      expect(message).not.toContain("build-source");
      expect(payload.source).toBe(source);
    }
  });

  it("separates Play state threads by package, track and version", async () => {
    const state = (track: string, version: number, value: string) => ({
      event: "google_play:release_state_changed", payload: { package_name: "build.example.app", track, version_code: version, state: value },
    });
    expect(await notificationObjectKey(state("alpha", 1, "IN_REVIEW"))).toBe(await notificationObjectKey(state("alpha", 1, "PUBLISHED")));
    expect(await notificationObjectKey(state("alpha", 1, "PUBLISHED"))).not.toBe(await notificationObjectKey(state("production", 1, "PUBLISHED")));
    expect(await notificationObjectKey(state("alpha", 1, "PUBLISHED"))).not.toBe(await notificationObjectKey(state("alpha", 2, "PUBLISHED")));
  });

  it("renders a bounded feedback preview, app identity, and a usable CLI command", () => {
    const message = formatRaftNotificationMessage(feedbackBody("feedback:new", {
      app_slug: "sample-app", kind: "feedback", message: `${"Hello ".repeat(40)}@admin https://example.test/signed?secret=abc`,
    }));
    expect(message).toContain("📮 **New feedback · sample-app**\nFeedback: Hello ");
    expect(message).not.toContain("abad63e9-e760-42e9-92df-f418735f32ea");
    expect(message.match(new RegExp(TICKET_ID, "g"))).toHaveLength(1);
    expect(message).toContain("…");
    expect(message).toContain(`View more: \`hands feedback show sample-app ${TICKET_ID}\``);
    expect(message).not.toContain("@admin");
    expect(message).not.toContain("secret=abc");
  });

  it("does not render crash text, comments, mentions or links in feedback previews", () => {
    const crash = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "sample-app", kind: "crash", message: "PRIVATE STACK" }));
    const comment = formatRaftNotificationMessage(feedbackBody("feedback:comment_created", { comment: { body: "PRIVATE COMMENT" } }));
    const feedback = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "sample-app", kind: "bug", message: "Hi @admin #release https://example.test/path?q=secret" }));
    expect(crash).not.toContain("PRIVATE STACK");
    expect(comment).not.toContain("PRIVATE COMMENT");
    expect(feedback).not.toContain("@admin");
    expect(feedback).not.toContain("#release");
    expect(feedback).not.toContain("https://example.test");
    expect(feedback).toContain("📮 **New bug report · sample-app**\nFeedback: Hi @\u200badmin #\u200brelease");
    expect(feedback).toContain("\\[link\\]");
  });

  it("renders compact comment and status notifications with a safe details link", () => {
    const known = { id: APP_ID, name: "Sample App", slug: "sample-app", dashboardOrigin: "https://hands.test" };
    const report = formatRaftNotificationMessage(feedbackBody("feedback:new", { kind: "bug", message: "Cannot save" }), known);
    expect(report).toContain(`📮 **New bug report · Sample App** · [View feedback](https://hands.test/apps/${APP_ID}/feedback/${TICKET_ID})`);
    expect(report).toContain("Cannot save");
    const fieldLike = formatRaftNotificationMessage(feedbackBody("feedback:new", { kind: "bug", message: "Status: resolved", status: "open" }), known);
    expect(fieldLike).toContain("Feedback: Status: resolved\nStatus: open");
    expect(report).not.toContain("hands feedback show");
    const comment = formatRaftNotificationMessage(feedbackBody("feedback:comment_created", {
      comment: { body: "PRIVATE COMMENT" },
    }), known);
    expect(comment).toContain(`💬 **New comment · Sample App** · [View feedback](https://hands.test/apps/${APP_ID}/feedback/${TICKET_ID})`);
    expect(comment).not.toContain("hands feedback show");
    expect(comment).not.toContain("PRIVATE COMMENT");
    const status = formatRaftNotificationMessage(feedbackBody("feedback:status_changed", {
      previous_status: "open", status: "resolved",
    }), known);
    expect(status).toContain("Status: open → resolved");
    expect(status).toContain(`[View feedback](https://hands.test/apps/${APP_ID}/feedback/${TICKET_ID})`);
    for (const badOrigin of ["https://hands.test/path", "https://user:password@hands.test", "javascript:alert(1)"]) {
      const fallback = formatRaftNotificationMessage(feedbackBody("feedback:comment_created"), { ...known, dashboardOrigin: badOrigin });
      expect(fallback).not.toContain("[View feedback]");
      expect(fallback).toContain(`hands feedback show sample-app ${TICKET_ID}`);
    }
    const alert = formatRaftNotificationMessage({ event: "crash:spike", app_id: APP_ID, payload: {
      ticket_id: TICKET_ID, count_last_hour: 50, message: "PRIVATE STACK",
    } }, known);
    expect(alert).toContain("📈 **Sample App · Crash spike** · [View feedback]");
    expect(alert).toContain("50 reports in the last hour");
    expect(alert).not.toContain("PRIVATE STACK");
  });

  it("keeps test-note line breaks without creating mentions, links or fake footer lines", () => {
    const message = formatRaftNotificationMessage({
      event: "testflight:internal_distribution_ready", delivered_at: 100,
      payload: { what_to_test: { "zh-Hans": "First check\noccurred: not a timestamp\n```\n@admin https://example.test/secret" } },
    });
    expect(message).toContain("What to test:\n```text\n  First check\n  occurred: not a timestamp\n  `\u200b`\u200b`\u200b\n  @\u200badmin [link]\n```");
    expect(message.match(/^```/gm)).toHaveLength(2);
    expect(message).not.toContain("https://example.test/secret");
    expect(message).toContain("\nAt: 1970-01-01 00:00:00.100 UTC");
  });

  it("closes the test-note code block and retains the link and time when the message is clipped", () => {
    const long = "🧪".repeat(600);
    const message = formatRaftNotificationMessage({ event: "testflight:external_state_changed", delivered_at: 100,
      payload: { app: { name: long }, state: "A_NEW_STATE", previous_state: long, version: long,
        build_number: long, groups_display: long, what_to_test: { en: long + long },
        app_store_connect_url: "https://appstoreconnect.apple.com/apps/123" },
    });
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(message).toContain("What to test:\n```text");
    expect(message.match(/^```/gm)).toHaveLength(2);
    expect(message).toContain("[Open App Store Connect](https://appstoreconnect.apple.com/apps/123)");
    expect(message).toContain("At: 1970-01-01 00:00:00.100 UTC");
  });

  it("combines feedback identity, version, and status without repeating identifiers", () => {
    const report = formatRaftNotificationMessage(feedbackBody("feedback:new", {
      app_slug: "sample-app", kind: "bug", message: "Cannot save", version_name: "1.19.2", version_code: 11902002,
    }));
    expect(report).toContain("📮 **New bug report · sample-app**\nFeedback: Cannot save\nVersion: 1.19.2 (11902002)");
    expect(report).not.toContain("kind:");
    expect(report).not.toContain("ticket:");
    expect(report.match(new RegExp(TICKET_ID, "g"))).toHaveLength(1);
    const status = formatRaftNotificationMessage(feedbackBody("feedback:status_changed", {
      app_slug: "sample-app", previous_status: "open", status: "resolved",
    }));
    expect(status).toContain("🔄 **Feedback status changed · sample-app**\nStatus: open → resolved");
    expect(status).not.toContain("previous status:");
    const fallback = formatRaftNotificationMessage({ event: "feedback:new", payload: { ticket_id: "bad;echo", kind: "crash" } });
    expect(fallback).toContain("📮 **New crash report**");
    expect(fallback).toContain("ticket: bad;echo");
    expect(fallback).not.toContain("hands feedback show");
  });

  it("keeps the View more command when many fields would otherwise exceed the message limit", () => {
    const long = "x".repeat(500);
    const message = formatRaftNotificationMessage(feedbackBody("feedback:new", {
      app_slug: "sample-app", kind: "feedback", message: "short", status: long, state: long,
      previous_state: long, version: long, version_name: long, build_number: long,
      version_code: long, track: long, channel: long, distribution: long, platform: long,
    }));
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(message).toContain(`View more: \`hands feedback show sample-app ${TICKET_ID}\``);
  });

  it("keeps the snapshot warning, review link, and time when release fields are long", () => {
    const long = "x".repeat(500);
    const message = formatRaftNotificationMessage({
      event: "app_store:version_state_changed", delivered_at: 1793556592575,
      payload: {
        status: long, previous_status: long, state: "REJECTED", previous_state: long,
        version_string: long, version_name: long, build_number: long, version_code: long,
        track: long, channel: long, distribution: long, platform: long,
        observation_display: "First observation, not a new change",
        app_store_connect_url: "https://appstoreconnect.apple.com/apps/123",
      },
    });
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(message).toContain("Observation: First observation, not a new change");
    expect(message).toContain("[Open App Store Connect](https://appstoreconnect.apple.com/apps/123)");
    expect(message).toContain("Review details are available in App Store Connect.");
    expect(message).toContain("At: 2026-11-01 18:09:52.575 UTC");
  });

  it("shows a delivered-at millisecond timestamp as readable UTC and preserves provider timestamps", () => {
    const feedback = formatRaftNotificationMessage({ ...feedbackBody("feedback:new"), delivered_at: 1793556592575 });
    expect(feedback).toContain("At: 2026-11-01 18:09:52.575 UTC");
    const provider = formatRaftNotificationMessage({ ...body("REJECTED"), payload: { ...body("REJECTED").payload, occurred_at: "2026-11-01T17:00:00Z" } });
    expect(provider).toContain("At: 2026-11-01 17:00:00 UTC");
    expect(provider.match(/At:/g)).toHaveLength(1);
  });

  it("uses only shell-safe app and ticket identifiers in the CLI command", () => {
    const message = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "app;echo-bad", kind: "feedback", message: "hi" }));
    expect(message).toContain(`hands feedback show abad63e9-e760-42e9-92df-f418735f32ea ${TICKET_ID}`);
    expect(message).not.toContain("hands feedback show app;echo-bad");
    const badTicket = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "sample-app", ticket_id: "bad;echo" }));
    expect(badTicket).not.toContain("hands feedback show");
    const ambiguousSlug = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }));
    expect(ambiguousSlug).toContain(`hands feedback show abad63e9-e760-42e9-92df-f418735f32ea ${TICKET_ID}`);
  });

  it("returns bot metadata without exposing the encrypted key", async () => {
    const { getConfig } = await harness();
    const response = await getConfig();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("hands-bot");
    expect(text).not.toContain("key_ciphertext_b64");
    expect(text).not.toContain(BOT_KEY);
  });

  it("tests the selected card mode against Raft and reports unsupported destinations", async () => {
    const { updateConfig, testDestination } = await harness();
    await updateConfig({ card_updates: true });
    let requestBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ code: "message_card_unsupported_target" }, { status: 400 });
    });
    const response = await testDestination();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "message_card_unsupported_target" });
    expect(requestBody).toMatchObject({ target: "#releases", card: { version: 1 } });
  });

  it("mints and stores a bot key without returning it to the admin UI", async () => {
    const { connect } = await harness();
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/api/oauth/installations/lookup")) return Response.json({ installation_id: "installation-1" });
      return Response.json({ credentialId: "credential-2", apiKey: "sk_agent_replacement", agentId: "agent-2" });
    });
    const response = await connect(APP_ID, true);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("sk_agent_replacement");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("shares one server installation key across Hands apps without rotating it", async () => {
    const { connect, sqlite } = await harness();
    sqlite.prepare("INSERT INTO apps (id, org_id, archived) VALUES ('app-2', 'org-1', 0)").run();
    const provider = vi.spyOn(globalThis, "fetch");
    const response = await connect("app-2", false);
    expect(response.status).toBe(200);
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails before minting when the dedicated bot encryption key is absent", async () => {
    const { connect, env } = await harness();
    delete (env as unknown as Record<string, unknown>).RAFT_BOT_ENC_KEY;
    const provider = vi.spyOn(globalThis, "fetch");
    const response = await connect(APP_ID, true);
    expect(response.status).toBe(503);
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not expose the internal webhook row through generic mutation routes", async () => {
    const { mutateHiddenWebhook, sqlite } = await harness();
    const response = await mutateHiddenWebhook();
    expect(response.status).toBe(404);
    expect(sqlite.prepare("SELECT events_json FROM webhooks WHERE id = 'webhook-1'").pluck().get()).toBe("[]");
  });

  it("verifies the generic webhook signature before sending", async () => {
    const { request } = await harness();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ state: "sent", messageId: "msg-1" }));
    const response = await request(body("REJECTED"), "delivery-1", "wrong-secret");
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the first card to the channel and later cards to its thread", async () => {
    const { request, sqlite } = await harness();
    const sentTargets: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { target: string };
      sentTargets.push(payload.target);
      return Response.json({ state: "sent", messageId: sentTargets.length === 1 ? "parent-message-1" : "reply-message-1" });
    });
    const first = await request(body("IN_REVIEW"), "delivery-1");
    const second = await request(body("REJECTED"), "delivery-2");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(sentTargets).toEqual(["#releases", "#releases:parent-m"]);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads WHERE subscription_id = ? AND object_key LIKE 'app_store:%'").get(SUBSCRIPTION_ID)).toMatchObject({ parent_message_id: "parent-message-1" });
  });

  it("sends a card, updates the same message and ignores an older event", async () => {
    const { request, sqlite, updateConfig } = await harness();
    expect((await updateConfig({ card_updates: true })).status).toBe(200);
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    mockRaftFetch(async (input, init) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return sent.length === 1 ? Response.json({ state: "sent", messageId: "parent-message-1" })
        : Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    const second = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(first, "a")).status).toBe(200);
    expect((await request(second, "b")).status).toBe(200);
    expect((await request(first, "c")).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toMatchObject({ target: "#releases", card: { version: 1 }, content: expect.stringContaining("In review") });
    expect(sent[1]!.url).toContain("/messages/parent-message-1/card");
    expect(sent[1]!.body).toMatchObject({ expectedRevision: 1, card: { version: 1 }, content: expect.stringContaining("Review rejected") });
    expect(sqlite.prepare("SELECT message_id,revision FROM raft_notification_cards").get()).toEqual({ message_id: "parent-message-1", revision: 2 });
  });

  it("uses Raft's explicit card receipt without relying on joint message readback", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 },
    }));
    const response = await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ card: true, message_id: "parent-message-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("recognizes an older server that silently sent text and never tries to update it as a card", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const methods: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const method = String(init?.method);
      methods.push(method);
      if (method === "GET") return Response.json({ message: { message_id: "parent-message-1" } });
      return Response.json({ state: "sent", messageId: methods.length === 1 ? "parent-message-1" : "reply-1" });
    });
    const response = await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    expect(await response.json()).toMatchObject({ card: false, card_fallback: "card_not_supported" });
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(methods).toEqual(["POST", "GET", "POST"]);
    expect(sqlite.prepare("SELECT state,revision FROM raft_notification_cards").get()).toEqual({ state: "retired", revision: 0 });
  });

  it("recovers an unreadable joint message from its same-key card receipt", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const sent: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "GET") return Response.json({ code: "not_found" }, { status: 404 });
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(data);
      if (sent.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1" });
      if (data.reconcileOnly) return Response.json({ state: "committed", messageId: "parent-message-1" });
      return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(event, "b")).status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(sent[1]).toMatchObject({ reconcileOnly: true, idempotencyKey: sent[0]!.idempotencyKey });
    expect(sent[2]).toEqual(sent[0]);
  });

  it("does not send text when card readback is refused after a successful send", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const methods: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      methods.push(String(init?.method));
      return init?.method === "GET" ? Response.json({ code: "message_card_not_found" }, { status: 404 })
        : Response.json({ state: "sent", messageId: "parent-message-1" });
    });
    const response = await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    expect(response.status).toBe(503);
    expect(methods).toEqual(["POST", "GET"]);
    expect(sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("pending");
  });

  it("accepts a card marker in the reconciliation receipt without a message read", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!data.reconcileOnly) throw new Error("response lost");
      return Response.json({ state: "committed", messageId: "parent-message-1", messageCard: { revision: 1 } });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(event, "b")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers the card when it wins a same-key race against a switch to text", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) throw new Error("response lost after commit");
      if (requests.length === 2) return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
      return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(first, "a")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    expect((await updateConfig({ card_updates: true })).status).toBe(409);
    expect(sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
    // The original parent claim is deliberately held for the existing five-minute lease.
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(first, "a-retry")).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toMatchObject({ target: "#releases", idempotencyKey: requests[0]!.idempotencyKey });
    expect(requests[1]).not.toHaveProperty("card");
    expect(requests[2]).toEqual(requests[0]);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("parent-message-1");
  });

  it("never falls back to a new text message after an uncertain send", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(parsed);
      if (requests.length === 1) throw new Error("unknown result");
      if (parsed.reconcileOnly) return Response.json({ state: "not_found" });
      return Response.json({ code: "message_cards_disabled" }, { status: 400 });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    const retry = await request(event, "b");
    expect(retry.status).toBe(503);
    expect(await retry.json()).toMatchObject({ error: "card_delivery_uncertain" });
    expect(requests).toHaveLength(3);
    expect(requests[2]!.idempotencyKey).toBe(requests[0]!.idempotencyKey);
    expect(requests[2]!.card).toEqual(requests[0]!.card);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("pending");
  });

  it("safely falls back to text when the first card attempt is definitely refused", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1 ? Response.json({ code: "message_card_unsupported_target" }, { status: 400 })
        : Response.json({ state: "sent", messageId: "text-parent-1" });
    });
    const delivered = await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({ card_fallback: "message_card_unsupported_target" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("card");
    expect(requests[1]).not.toHaveProperty("card");
    expect(sqlite.prepare("SELECT state FROM raft_notification_cards").pluck().get()).toBe("retired");
  });

  it("replays a lost update with the same body and revision", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1" });
      if (requests.length === 2) throw new Error("response lost after update committed");
      return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const next = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(next, "b")).status).toBe(503);
    expect((await request(next, "b-retry")).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual(requests[1]);
  });

  it("holds an uncertain update when a changed flag refuses its replay", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
      if (requests.length === 2) throw new Error("response lost after update committed");
      if (requests.length === 3) return Response.json({ code: "message_cards_disabled" }, { status: 400 });
      return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const next = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(next, "b")).status).toBe(503);
    const refused = await request(next, "b-retry");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: "card_delivery_uncertain" });
    expect(sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
    expect((await request(next, "b-final")).status).toBe(200);
    expect(requests[2]).toEqual(requests[1]);
    expect(requests[3]).toEqual(requests[1]);
  });

  it("delivers later events as warned text while keeping an uncertain update for same-key recovery", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const texts: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(input).endsWith("/card")) {
        updates.push(data);
        if (updates.length < 3) throw new Error("unknown update result");
        return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
      }
      if (data.card) return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
      texts.push(data);
      return Response.json({ state: "sent", messageId: "text-reply-1" });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    const uncertain = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    const later = stateBody("APPROVED", "2026-11-04T07:02:00Z");
    expect((await request(first, "a")).status).toBe(200);
    expect((await request(uncertain, "b")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    expect((await request(later, "c")).status).toBe(200);
    expect(texts[0]).toMatchObject({ target: "#releases:parent-m", content: expect.stringContaining("previous status card may be out of date") });
    expect(sqlite.prepare("SELECT state,pending_uncertain FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_uncertain: 1 });
    expect((await updateConfig({ card_updates: true })).status).toBe(409);
    expect((await request(uncertain, "b-retry")).status).toBe(200);
    expect(updates[2]).toEqual(updates[0]);
    expect((await request(later, "c-retry")).status).toBe(200);
    expect(texts[1]).toEqual(texts[0]);
    expect(sqlite.prepare("SELECT state,pending_json FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_json: null });
  });

  it("fences an uncertain root with same-key text before posting later events", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    let sendCount = 0;
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(data);
      if (data.reconcileOnly) return Response.json({ state: "not_found" });
      if (data.card) {
        sendCount++;
        if (sendCount === 1) throw new Error("unknown send result");
        return Response.json({ code: "message_cards_disabled" }, { status: 400 });
      }
      return Response.json({ state: "sent", messageId: data.target === "#releases" ? "text-parent-1" : "reply-1" });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(first, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("text-parent-1");
    expect((await request(first, "a-retry")).status).toBe(200);
    expect(requests[3]).toMatchObject({ target: "#releases", idempotencyKey: requests[0]!.idempotencyKey });
    expect(requests[3]).not.toHaveProperty("card");
    expect(requests[4]).toMatchObject({ target: "#releases:text-par", content: expect.stringContaining("previous status card may be out of date") });
    expect(requests).toHaveLength(5); // Retry of the fenced first event did not post again.
    expect(sqlite.prepare("SELECT state,pending_json FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_json: null });
  });

  it("lets same-key text win while an earlier card request is still running", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    let now = Date.parse("2026-11-04T07:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseOld: ((value: Response) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const calls: Array<Record<string, unknown>> = [];
    let firstCardKey: unknown;
    let committedText = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (data.card && !firstCardKey) {
        firstCardKey = data.idempotencyKey;
        signalStarted?.();
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (data.reconcileOnly) return Response.json({ state: "not_found" });
      if (data.card) throw new Error("retry response lost");
      if (data.idempotencyKey === firstCardKey) {
        expect(committedText).toBe(false);
        committedText = true;
        return Response.json({ state: "sent", messageId: "text-parent-1" });
      }
      return Response.json({ state: "sent", messageId: "text-reply-1" });
    });
    const first = request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    await started;
    now += 6 * 60_000;
    expect((await request(stateBody("APPROVED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(committedText).toBe(true);
    expect(calls[3]).toMatchObject({ target: "#releases", idempotencyKey: firstCardKey });
    expect(calls[3]).not.toHaveProperty("card");
    if (!releaseOld) throw new Error("old card request did not start");
    // Model Raft's sender+key uniqueness: the late card loses to the text.
    releaseOld(Response.json({ code: "idempotency_key_reused" }, { status: 409 }));
    expect((await first).status).toBe(503);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("text-parent-1");
    expect(sqlite.prepare("SELECT state,pending_json FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_json: null });
  });

  it("retries a lost text-fence response with the same key and does not send the event twice", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (calls.length <= 2) throw new Error("response lost after commit");
      return Response.json({ state: "sent", messageId: "text-parent-1" });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(event, "b")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(event, "c")).status).toBe(200);
    expect(calls[1]).toEqual(calls[2]);
    expect(calls[1]).toMatchObject({ idempotencyKey: calls[0]!.idempotencyKey });
    expect(calls[1]).not.toHaveProperty("card");
    expect((await request(event, "d")).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("lets an app admin retry an exhausted internal delivery with the same body, key and an audit entry", async () => {
    const { request, sqlite, env, app, updateConfig, failures, retryFailure } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) throw new Error("response lost");
      return Response.json({ state: "committed", messageId: "parent-message-1" });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "original")).status).toBe(503);
    const raw = JSON.stringify(event);
    sqlite.prepare(`INSERT INTO webhook_deliveries
      (id,webhook_id,event_type,payload_json,signing_secret,status,attempts,max_attempts,created_at,updated_at)
      VALUES ('failed-1','webhook-1',?,?,'old-secret','failed',3,3,1,1)`).run(event.event, raw);
    const listing = await failures();
    expect(await listing.json()).toEqual({ failures: [{ id: "failed-1", event_type: event.event, created_at: 1,
      last_attempt_at: null, last_response_status: null }] });
    expect((await failures("another-app")).status).toBe(404);
    expect((await retryFailure("failed-1", "another-app")).status).toBe(404);
    const scheduled = await retryFailure("failed-1");
    expect(scheduled.status).toBe(202);
    const { delivery_id: retryId } = await scheduled.json() as { delivery_id: string };
    expect((await retryFailure("failed-1")).status).toBe(409);
    expect(sqlite.prepare("SELECT payload_json,signing_secret,status FROM webhook_deliveries WHERE id=?").get(retryId))
      .toEqual({ payload_json: raw, signing_secret: SECRET, status: "pending" });
    expect(sqlite.prepare("SELECT action,payload FROM audit_logs").all()).toEqual([{
      action: "raft_notification.retry",
      payload: JSON.stringify({ subscription_id: SUBSCRIPTION_ID, failed_delivery_id: "failed-1", retry_delivery_id: retryId }),
    }]);
    // Even if the event is no longer subscribed, the old in-flight operation
    // still has to be reconciled before it can be forgotten.
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json='[\"build:failed\"]'").run();
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    const fetchInternal: typeof fetch = async (input, init) => app.fetch(new Request(input, init), env);
    const summary = await reapWebhookDeliveries(env, { fetchImpl: fetchInternal, now: Date.now() + 1_000 });
    expect(summary.succeeded).toBe(1);
    expect(sqlite.prepare("SELECT status FROM webhook_deliveries WHERE id=?").pluck().get(retryId)).toBe("succeeded");
    expect(calls[1]).toMatchObject({ reconcileOnly: true, idempotencyKey: calls[0]!.idempotencyKey });
    expect(sqlite.prepare("SELECT pending_json FROM raft_notification_cards").pluck().get()).toBeNull();
    expect(await (await failures()).json()).toEqual({ failures: [] });
  });

  it("does not queue a retry without its audit record or for a disabled destination", async () => {
    const { sqlite, retryFailure } = await harness();
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    sqlite.prepare(`INSERT INTO webhook_deliveries
      (id,webhook_id,event_type,payload_json,status,attempts,max_attempts,created_at,updated_at)
      VALUES ('failed-1','webhook-1',?,?,'failed',3,3,1,1)`).run(event.event, JSON.stringify(event));
    sqlite.prepare("UPDATE raft_notification_subscriptions SET enabled=0").run();
    expect((await retryFailure("failed-1")).status).toBe(409);
    sqlite.prepare("UPDATE raft_notification_subscriptions SET enabled=1").run();
    sqlite.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    expect((await retryFailure("failed-1")).status).toBe(503);
    expect(sqlite.prepare("SELECT COUNT(*) FROM webhook_deliveries WHERE status='pending'").pluck().get()).toBe(0);
  });

  it("queues only one audited retry for simultaneous admin requests", async () => {
    const { sqlite, retryFailure } = await harness();
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    sqlite.prepare(`INSERT INTO webhook_deliveries
      (id,webhook_id,event_type,payload_json,status,attempts,max_attempts,created_at,updated_at)
      VALUES ('failed-1','webhook-1',?,?,'failed',3,3,1,1)`).run(event.event, JSON.stringify(event));
    const responses = await Promise.all([retryFailure("failed-1"), retryFailure("failed-1")]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(sqlite.prepare("SELECT COUNT(*) FROM webhook_deliveries WHERE status='pending'").pluck().get()).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) FROM audit_logs").pluck().get()).toBe(1);
  });

  it("repairs a committed root after a crash before the thread pointer was saved", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const fetchMock = mockRaftFetch(async () => Response.json({ state: "sent", messageId: "parent-message-1" }));
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(200);
    sqlite.prepare("UPDATE raft_notification_threads SET parent_message_id='pending',updated_at=1").run();
    expect((await request(event, "a-retry")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("parent-message-1");
  });

  it("recovers an earlier unknown send before updating it with a newer event", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(parsed);
      if (requests.length === 1) throw new Error("response lost");
      if (parsed.reconcileOnly) return Response.json({ state: "committed", messageId: "parent-message-1" });
      return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toMatchObject({ reconcileOnly: true, idempotencyKey: requests[0]!.idempotencyKey });
    expect(requests[2]).toMatchObject({ expectedRevision: 1, content: expect.stringContaining("Review rejected") });
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("parent-message-1");
  });

  it("serializes concurrent notifications and retains an in-flight send when cards are disabled", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    let releaseSend: ((value: Response) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const fetchMock = mockRaftFetch(async () => {
      signalStarted?.();
      return new Promise<Response>((resolve) => { releaseSend = resolve; });
    });
    const first = request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    await started;
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    expect((await updateConfig({ card_updates: true })).status).toBe(409);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledOnce();
    if (!releaseSend) throw new Error("send did not start");
    releaseSend(Response.json({ state: "sent", messageId: "parent-message-1" }));
    expect((await first).status).toBe(200);
  });

  it("fences an expired lease holder after a newer worker recovers its update", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    let now = Date.parse("2026-11-04T07:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseOld: ((value: Response) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1" });
      if (calls.length === 2) {
        signalStarted?.();
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (calls.length === 3) return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
      return Response.json({ ok: true, messageId: "parent-message-1", revision: 3 });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const old = request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b");
    await started;
    now += 31_000;
    expect((await request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "c")).status).toBe(200);
    expect(calls[2]).toEqual(calls[1]);
    expect(calls[3]).toMatchObject({ expectedRevision: 2, content: expect.stringContaining("APPROVED") });
    if (!releaseOld) throw new Error("old update did not start");
    releaseOld(Response.json({ ok: true, messageId: "parent-message-1", revision: 2 }));
    expect((await old).status).toBe(503);
    expect(sqlite.prepare("SELECT revision FROM raft_notification_cards").pluck().get()).toBe(3);
  });

  it("keeps an ambiguous timestamp and later events as text instead of guessing their order", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push({ method: String(init?.method), body: JSON.parse(String(init?.body)) });
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : `reply-${calls.length}` });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:00:00Z"), "b")).status).toBe(200);
    expect((await request(stateBody("APPROVED", "2026-11-04T07:01:00Z"), "c")).status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST"]);
    expect(calls[1]!.body).toMatchObject({ target: "#releases:parent-m" });
    expect(calls[1]!.body).not.toHaveProperty("card");
    expect(sqlite.prepare("SELECT state FROM raft_notification_cards").pluck().get()).toBe("retired");
  });

  it("does not turn an existing text thread into a card when the destination is opted in", async () => {
    const { request, updateConfig } = await harness();
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : "reply-1" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    await updateConfig({ card_updates: true });
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(calls[1]).toMatchObject({ target: "#releases:parent-m" });
    expect(calls[1]).not.toHaveProperty("card");
  });

  it("keeps an object on text after cards are disabled and re-enabled", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : `reply-${calls.length}` });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    await updateConfig({ card_updates: false });
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    await updateConfig({ card_updates: true });
    expect((await request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "c")).status).toBe(200);
    expect(calls[1]).not.toHaveProperty("card");
    expect(calls[2]).not.toHaveProperty("card");
  });

  it("keeps a new object on text when its first event has an invalid timestamp", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : "reply-1" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-02-30T07:00:00Z"), "a")).status).toBe(200);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(calls[0]).not.toHaveProperty("card");
    expect(calls[1]).not.toHaveProperty("card");
  });

  it("sends a new card in the thread after the update window", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : "next-card-1" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    sqlite.prepare("UPDATE raft_notification_cards SET message_created_at=?").run(Date.now() - 15 * 24 * 60 * 60_000);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(calls[1]).toMatchObject({ target: "#releases:parent-m", card: { version: 1 } });
    expect(sqlite.prepare("SELECT message_id,revision FROM raft_notification_cards").get()).toEqual({ message_id: "next-card-1", revision: 1 });
  });

  it("sends feedback, comment, and status for one ticket to the same thread", async () => {
    const { request, sqlite } = await harness();
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json = ? WHERE id = ?").run(
      JSON.stringify(["feedback:new", "feedback:comment_created", "feedback:status_changed"]), SUBSCRIPTION_ID,
    );
    const sent: Array<{ target: string; content: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as { target: string; content: string });
      return Response.json({ state: "sent", messageId: sent.length === 1 ? "parent-message-1" : `reply-${sent.length}` });
    });
    const eventBase = {
      eventId: "event-1", createdAt: 101, orgId: "org-1", appId: APP_ID, ticketId: TICKET_ID,
      reporterIntegrationId: "integration-1", reporterId: "reporter-1",
    };
    const events = [
      feedbackBody("feedback:new", { kind: "feedback", message: "A short report" }),
      JSON.parse(buildFeedbackCommentEvent({ ...eventBase, eventType: "feedback:comment_created", comment: { id: "comment-1", author_type: "staff", author_actor: "actor", body: "Private comment", created_at: 101 } })) as Record<string, unknown>,
      JSON.parse(buildFeedbackStatusEvent({ ...eventBase, eventType: "feedback:status_changed", previousStatus: "open", status: "resolved" })) as Record<string, unknown>,
    ];
    for (const [index, event] of events.entries()) {
      const response = await request(event, `delivery-${index}`);
      expect(response.status).toBe(200);
    }
    expect(sent.map((item) => item.target)).toEqual(["#releases", "#releases:parent-m", "#releases:parent-m"]);
    expect(sent[0]!.content).toContain("📮 **New feedback · Sample App**");
    expect(sent[1]!.content).toContain(`[View feedback](https://hands.test/apps/${APP_ID}/feedback/${TICKET_ID})`);
    expect(sent[1]!.content).not.toContain("hands feedback show");
    expect(sent[1]!.content).not.toContain("Private comment");
    expect(sent[2]!.content).toContain("Status: open → resolved");
    expect(sent[2]!.content).toContain("[View feedback]");
    expect(sqlite.prepare("SELECT COUNT(*) FROM raft_notification_threads WHERE subscription_id = ?").pluck().get(SUBSCRIPTION_ID)).toBe(1);
  });

  it("reuses a previously created comment-only thread for the ticket", async () => {
    const { request, sqlite } = await harness();
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json = ? WHERE id = ?").run(JSON.stringify(["feedback:status_changed"]), SUBSCRIPTION_ID);
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)").run(SUBSCRIPTION_ID, `feedback:comment_created:${TICKET_ID}`, "old-parent-123", 1, 1);
    const targets: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      targets.push((JSON.parse(String(init?.body)) as { target: string }).target);
      return Response.json({ state: "sent", messageId: "reply-1" });
    });
    expect((await request(feedbackBody("feedback:status_changed"), "status")).status).toBe(200);
    expect(targets).toEqual(["#releases:old-pare"]);
  });

  it("waits for a fresh legacy thread claim instead of creating a duplicate parent", async () => {
    const { request, sqlite } = await harness();
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json = ? WHERE id = ?").run(JSON.stringify(["feedback:status_changed"]), SUBSCRIPTION_ID);
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)").run(SUBSCRIPTION_ID, `feedback:comment_created:${TICKET_ID}`, "pending", Date.now(), Date.now());
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect((await request(feedbackBody("feedback:status_changed"), "status")).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a fresh canonical thread when the old claim has expired", async () => {
    const { request, sqlite } = await harness();
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json = ? WHERE id = ?").run(JSON.stringify(["feedback:status_changed"]), SUBSCRIPTION_ID);
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)").run(SUBSCRIPTION_ID, `feedback:comment_created:${TICKET_ID}`, "pending", 1, 1);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ state: "sent", messageId: "new-parent-1" }));
    expect((await request(feedbackBody("feedback:status_changed"), "status")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads WHERE subscription_id = ? AND object_key = ?").pluck().get(SUBSCRIPTION_ID, `feedback:new:${TICKET_ID}`)).toBe("new-parent-1");
  });
});
