import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../migrations/sql/0051_feedback_conversations.sql", import.meta.url),
);
const routeMigrationPath = fileURLToPath(
  new URL("../../migrations/sql/0052_feedback_route_subjects.sql", import.meta.url),
);

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE raft_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE app_deploy_tokens (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      app_role TEXT CHECK (app_role IN ('publisher', 'viewer')),
      scopes_json TEXT,
      created_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
      created_by_actor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER,
      CHECK (app_role IS NOT NULL OR scopes_json IS NOT NULL)
    );
    CREATE TABLE feedback_tickets (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      submission_id TEXT,
      submission_fingerprint TEXT,
      reporter_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_feedback_tickets_submission
      ON feedback_tickets(app_id, submission_id)
      WHERE submission_id IS NOT NULL;
    CREATE INDEX idx_feedback_tickets_reporter
      ON feedback_tickets(app_id, reporter_id, created_at)
      WHERE reporter_id IS NOT NULL;
    CREATE TABLE feedback_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
      author_actor TEXT NOT NULL,
      body TEXT NOT NULL,
      internal INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_feedback_comments_ticket
      ON feedback_comments(ticket_id, created_at);
    CREATE TABLE feedback_attachments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
      r2_key TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_feedback_attachments_ticket
      ON feedback_attachments(ticket_id);
    CREATE TABLE webhooks (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
      secret TEXT NOT NULL DEFAULT 'test-secret',
      events_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe("feedback conversations migration", () => {
  it("backfills one stable integration and isolates trusted submission ids", () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO apps (id, created_at) VALUES ('app-1', 1), ('app-2', 1);
      INSERT INTO app_deploy_tokens
        (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
         created_by_actor, created_at)
      VALUES
        ('token-1', 'app-1', 'feedback', 'qvdt_a', 'hash-a', NULL,
         '["feedback:write"]', 'tester', 2),
        ('token-2', 'app-2', 'publisher', 'qvdt_b', 'hash-b', 'publisher',
         NULL, 'tester', 2);
      INSERT INTO feedback_tickets
        (id, app_id, message, submission_id, submission_fingerprint,
         reporter_id, created_at, updated_at)
      VALUES
        ('ticket-1', 'app-1', 'hello', 'sub-1', 'fp-1', 'reporter-a', 3, 3),
        ('ticket-2', 'app-2', 'direct', 'sub-2', 'fp-2', NULL, 3, 3);
      INSERT INTO feedback_comments
        (id, ticket_id, author_actor, body, internal, created_at)
      VALUES ('comment-1', 'ticket-1', 'staff', 'reply', 0, 4);
      INSERT INTO feedback_attachments
        (id, ticket_id, r2_key, filename, content_type, size_bytes, created_at)
      VALUES ('attachment-1', 'ticket-1', 'r2/key', 'a.png', 'image/png', 10, 4);
    `);

    db.exec(readFileSync(migrationPath, "utf8"));

    expect(db.prepare(
      "SELECT id, app_id, archived_at FROM app_reporter_integrations",
    ).all()).toEqual([
      { id: "legacy-feedback:app-1", app_id: "app-1", archived_at: null },
    ]);
    expect(db.prepare(
      "SELECT reporter_integration_id FROM feedback_tickets WHERE id = 'ticket-1'",
    ).get()).toEqual({ reporter_integration_id: "legacy-feedback:app-1" });
    expect(db.prepare(
      "SELECT reporter_integration_id FROM app_deploy_tokens WHERE id = 'token-1'",
    ).get()).toEqual({ reporter_integration_id: "legacy-feedback:app-1" });
    expect(db.prepare(
      "SELECT reporter_integration_id FROM app_deploy_tokens WHERE id = 'token-2'",
    ).get()).toEqual({ reporter_integration_id: null });

    db.prepare(`
      INSERT INTO app_reporter_integrations
        (id, app_id, name, created_at, updated_at)
      VALUES ('integration-2', 'app-1', 'Second', 5, 5)
    `).run();
    const trusted = db.prepare(`
      INSERT INTO feedback_tickets
        (id, app_id, message, submission_id, submission_fingerprint,
         reporter_id, reporter_integration_id, created_at, updated_at)
      VALUES (?, 'app-1', ?, 'same-submission', ?, 'same-reporter', ?, ?, ?)
    `);
    trusted.run("trusted-a", "a", "fp-a", "legacy-feedback:app-1", 6, 6);
    expect(() => trusted.run("trusted-b", "b", "fp-b", "integration-2", 6, 6)).not.toThrow();
    expect(() => trusted.run("trusted-a-duplicate", "dup", "fp-c", "legacy-feedback:app-1", 7, 7)).toThrow();

    const direct = db.prepare(`
      INSERT INTO feedback_tickets
        (id, app_id, message, submission_id, submission_fingerprint,
         reporter_id, reporter_integration_id, created_at, updated_at)
      VALUES (?, 'app-2', ?, 'direct-submission', ?, NULL, NULL, ?, ?)
    `);
    direct.run("direct-a", "a", "fp-a", 6, 6);
    expect(() => direct.run("direct-b", "b", "fp-b", 7, 7)).toThrow();
  });

  it("enforces comment authorship, attachment visibility, and webhook event dedupe", () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO apps (id, created_at) VALUES ('app-1', 1);
      INSERT INTO feedback_tickets
        (id, app_id, message, reporter_id, created_at, updated_at)
      VALUES ('ticket-1', 'app-1', 'hello', 'reporter-a', 2, 2);
      INSERT INTO feedback_comments
        (id, ticket_id, author_actor, body, internal, created_at)
      VALUES ('legacy-comment', 'ticket-1', 'staff', 'reply', 1, 3);
      INSERT INTO feedback_attachments
        (id, ticket_id, r2_key, filename, size_bytes, created_at)
      VALUES ('legacy-attachment', 'ticket-1', 'r2/key', 'a.txt', 3, 3);
      INSERT INTO webhooks
        (id, org_id, app_id, events_json, enabled)
      VALUES ('webhook-1', 'org-1', 'app-1', '["feedback:comment_created"]', 1);
    `);
    db.exec(readFileSync(migrationPath, "utf8"));

    expect(db.prepare(
      "SELECT author_type, reporter_id, internal FROM feedback_comments WHERE id = 'legacy-comment'",
    ).get()).toEqual({ author_type: "staff", reporter_id: null, internal: 1 });
    expect(db.prepare(
      "SELECT origin, visibility FROM feedback_attachments WHERE id = 'legacy-attachment'",
    ).get()).toEqual({ origin: "submission", visibility: "reporter" });

    expect(() => db.prepare(`
      INSERT INTO feedback_comments
        (id, ticket_id, author_actor, author_type, body, internal, created_at)
      VALUES ('bad-reporter', 'ticket-1', 'reporter', 'reporter', 'x', 0, 4)
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO feedback_comments
        (id, ticket_id, author_actor, author_type, body, internal,
         reporter_integration_id, reporter_id, submission_id,
         submission_fingerprint, created_at)
      VALUES ('bad-staff', 'ticket-1', 'staff', 'staff', 'x', 0,
              'legacy-feedback:app-1', 'reporter-a', NULL, NULL, 4)
    `).run()).toThrow();

    db.prepare(`
      INSERT INTO feedback_events
        (id, event_type, app_id, ticket_id, reporter_integration_id, reporter_id,
         payload_json, created_at)
      VALUES ('event-1', 'feedback:comment_created', 'app-1', 'ticket-1',
              'legacy-feedback:app-1', 'reporter-a', '{}', 5)
    `).run();
    const delivery = db.prepare(`
      INSERT INTO webhook_deliveries
        (id, webhook_id, event_type, event_id, payload_json, status,
         attempts, max_attempts, created_at, updated_at)
      VALUES (?, 'webhook-1', 'feedback:comment_created', 'event-1', '{}',
              'pending', 0, 3, 5, 5)
    `);
    delivery.run("delivery-1");
    expect(() => delivery.run("delivery-2")).toThrow();
    expect(() => db.prepare(
      "UPDATE feedback_events SET payload_json = '{\"changed\":true}' WHERE id = 'event-1'",
    ).run()).toThrow(/immutable/);
    db.prepare(
      `INSERT INTO apps (id, created_at) VALUES ('app-2', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO app_reporter_integrations
       (id, app_id, name, created_at, updated_at)
       VALUES ('integration-app-2', 'app-2', 'Second app', 6, 6)`,
    ).run();
    expect(() => db.prepare(
      `INSERT INTO app_deploy_tokens
       (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
        created_by_actor, created_at, reporter_integration_id)
       VALUES ('cross-app-token', 'app-1', 'bad', 'qvdt_bad', 'hash-bad', NULL,
               '["feedback:read"]', 'tester', 6, 'integration-app-2')`,
    ).run()).toThrow(/app mismatch/);
    expect(() => db.prepare("DELETE FROM apps WHERE id = 'app-1'").run()).not.toThrow();
    expect(db.prepare("SELECT id FROM feedback_events WHERE id = 'event-1'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM webhook_deliveries WHERE id = 'delivery-1'").get()).toBeUndefined();
  });

  it("freezes v1 route ownership, dedicated subscribers, and event snapshots", () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO apps (id, org_id, created_at) VALUES ('app-1', 'org-1', 1), ('app-2', 'org-2', 1);
      INSERT INTO feedback_tickets
        (id, app_id, message, reporter_id, created_at, updated_at)
      VALUES ('ticket-1', 'app-1', 'hello', 'reporter_12345678', 2, 2);
      INSERT INTO webhooks
        (id, org_id, app_id, events_json, enabled)
      VALUES
        ('generic', 'org-1', 'app-1', '["feedback:comment_created"]', 1),
        ('dedicated', 'org-1', 'app-1', '["feedback:comment_created"]', 1),
        ('wrong-app', 'org-2', 'app-2', '["feedback:comment_created"]', 1);
    `);
    db.exec(readFileSync(migrationPath, "utf8"));
    db.exec(readFileSync(routeMigrationPath, "utf8"));

    const subject = `rfr_v1_${"A".repeat(64)}`;
    db.prepare(`
      INSERT INTO app_reporter_routes
        (app_id, reporter_integration_id, reporter_id, route_subject, subject_version, created_at)
      VALUES ('app-1', 'legacy-feedback:app-1', 'reporter_12345678', ?, 'v1', 3)
    `).run(subject);
    expect(() => db.prepare(
      "UPDATE app_reporter_routes SET route_subject = ? WHERE app_id = 'app-1'",
    ).run(`rfr_v1_${"B".repeat(64)}`)).toThrow(/immutable/);
    expect(() => db.prepare(
      "DELETE FROM app_reporter_routes WHERE app_id = 'app-1'",
    ).run()).toThrow(/immutable/);

    db.prepare("UPDATE apps SET archived = 1 WHERE id = 'app-1'").run();
    expect(() => db.prepare(`
      INSERT INTO app_reporter_routes
        (app_id, reporter_integration_id, reporter_id, route_subject, subject_version, created_at)
      VALUES ('app-1', 'legacy-feedback:app-1', 'other_reporter_1234', ?, 'v1', 3)
    `).run(`rfr_v1_${"C".repeat(64)}`)).toThrow(/mismatch/);
    expect(() => db.prepare(`
      INSERT INTO app_reporter_webhook_subscriptions
        (app_id, reporter_integration_id, webhook_id, created_at)
      VALUES ('app-1', 'legacy-feedback:app-1', 'dedicated', 4)
    `).run()).toThrow(/mismatch/);
    db.prepare("UPDATE apps SET archived = 0 WHERE id = 'app-1'").run();

    db.prepare(`
      INSERT INTO app_reporter_webhook_subscriptions
        (app_id, reporter_integration_id, webhook_id, created_at)
      VALUES ('app-1', 'legacy-feedback:app-1', 'dedicated', 4)
    `).run();
    expect(() => db.prepare(`
      INSERT INTO app_reporter_webhook_subscriptions
        (app_id, reporter_integration_id, webhook_id, created_at)
      VALUES ('app-1', 'legacy-feedback:app-1', 'wrong-app', 4)
    `).run()).toThrow(/mismatch/);

    db.prepare(`
      INSERT INTO feedback_events
        (id, event_type, app_id, ticket_id, reporter_integration_id, reporter_id,
         payload_json, route_outcome, route_subject, created_at)
      VALUES ('bound-event', 'feedback:comment_created', 'app-1', 'ticket-1',
              'legacy-feedback:app-1', 'reporter_12345678', '{}',
              'route_bound', ?, 5)
    `).run(subject);
    expect(() => db.prepare(`
      INSERT INTO feedback_events
        (id, event_type, app_id, ticket_id, reporter_integration_id, reporter_id,
         payload_json, route_outcome, route_subject, created_at)
      VALUES ('bad-event', 'feedback:comment_created', 'app-1', 'ticket-1',
              'legacy-feedback:app-1', 'reporter_12345678', '{}',
              'route_unbound', ?, 5)
    `).run(subject)).toThrow(/snapshot mismatch/);

    db.prepare("UPDATE apps SET archived = 1 WHERE id = 'app-1'").run();
    expect(() => db.prepare("DELETE FROM apps WHERE id = 'app-1'").run()).not.toThrow();
    expect(db.prepare("SELECT 1 FROM app_reporter_routes WHERE app_id = 'app-1'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM app_reporter_webhook_subscriptions WHERE app_id = 'app-1'").get()).toBeUndefined();
  });
});
