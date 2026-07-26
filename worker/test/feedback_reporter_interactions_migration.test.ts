import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../migrations/sql/0054_feedback_reporter_interactions.sql", import.meta.url),
);

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE apps (id TEXT PRIMARY KEY);
    CREATE TABLE app_reporter_integrations (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE TABLE feedback_tickets (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
      reporter_id TEXT NOT NULL
    );
    CREATE TABLE feedback_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL,
      internal INTEGER NOT NULL
    );
    CREATE TABLE feedback_attachments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
      r2_key TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT,
      size_bytes INTEGER NOT NULL,
      origin TEXT NOT NULL DEFAULT 'submission'
        CHECK (origin IN ('submission', 'staff', 'system')),
      visibility TEXT NOT NULL DEFAULT 'reporter'
        CHECK (visibility IN ('reporter', 'internal')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_feedback_attachments_ticket
      ON feedback_attachments(ticket_id, visibility, origin, created_at, id);

    INSERT INTO apps (id) VALUES ('app-a'), ('app-b');
    INSERT INTO app_reporter_integrations (id, app_id)
      VALUES ('integration-a', 'app-a'), ('integration-b', 'app-b');
    INSERT INTO feedback_tickets (id, app_id, reporter_integration_id, reporter_id)
      VALUES
        ('ticket-a', 'app-a', 'integration-a', 'reporter-a'),
        ('ticket-b', 'app-b', 'integration-b', 'reporter-b');
    INSERT INTO feedback_comments (id, ticket_id, author_type, internal)
      VALUES
        ('comment-a', 'ticket-a', 'reporter', 0),
        ('comment-staff', 'ticket-a', 'staff', 0),
        ('comment-b', 'ticket-b', 'reporter', 0);
    INSERT INTO feedback_attachments
      (id, ticket_id, r2_key, filename, content_type, size_bytes,
       origin, visibility, created_at)
      VALUES ('legacy', 'ticket-a', 'legacy/key', 'legacy.png', 'image/png', 4,
              'submission', 'reporter', 1);
  `);
  db.exec(readFileSync(migrationPath, "utf8"));
  return db;
}

describe("feedback reporter interactions migration", () => {
  it("preserves attachments and enforces exact reporter read ownership", () => {
    const db = makeDb();
    expect(db.prepare(
      "SELECT id, comment_id, origin, visibility FROM feedback_attachments WHERE id = 'legacy'",
    ).get()).toEqual({
      id: "legacy",
      comment_id: null,
      origin: "submission",
      visibility: "reporter",
    });

    const insertRead = db.prepare(`
      INSERT INTO feedback_reporter_ticket_reads
        (app_id, reporter_integration_id, reporter_id, ticket_id,
         read_through_created_at, read_through_comment_id, updated_at)
      VALUES (?, ?, ?, ?, 10, 'comment-a', 10)
    `);
    expect(() => insertRead.run(
      "app-a", "integration-a", "reporter-a", "ticket-a",
    )).not.toThrow();
    expect(() => insertRead.run(
      "app-a", "integration-a", "reporter-a", "ticket-b",
    )).toThrow("feedback reporter read owner mismatch");
    expect(() => db.prepare(`
      UPDATE feedback_reporter_ticket_reads SET reporter_id = 'reporter-b'
      WHERE ticket_id = 'ticket-a'
    `).run()).toThrow("feedback reporter read owner mismatch");
  });

  it("requires reporter attachments to belong to a visible reporter comment on the same ticket", () => {
    const db = makeDb();
    const insertAttachment = db.prepare(`
      INSERT INTO feedback_attachments
        (id, ticket_id, comment_id, r2_key, filename, content_type, size_bytes,
         origin, visibility, created_at)
      VALUES (?, ?, ?, ?, 'reply.png', 'image/png', 4, 'reporter', 'reporter', 2)
    `);
    expect(() => insertAttachment.run(
      "reply-a", "ticket-a", "comment-a", "reply/a",
    )).not.toThrow();
    expect(() => insertAttachment.run(
      "wrong-ticket", "ticket-a", "comment-b", "reply/b",
    )).toThrow("feedback reporter attachment owner mismatch");
    expect(() => insertAttachment.run(
      "staff-comment", "ticket-a", "comment-staff", "reply/c",
    )).toThrow("feedback reporter attachment owner mismatch");
    expect(() => db.prepare(`
      INSERT INTO feedback_attachments
        (id, ticket_id, comment_id, r2_key, filename, content_type, size_bytes,
         origin, visibility, created_at)
      VALUES ('internal', 'ticket-a', 'comment-a', 'reply/internal', 'reply.png',
              'image/png', 4, 'reporter', 'internal', 2)
    `).run()).toThrow();
  });
});
