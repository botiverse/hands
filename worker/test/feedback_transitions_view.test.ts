import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const VALIDATION_SQL = readFileSync(
  new URL("../../migrations/validation/0061_feedback_transitions_view.sql", import.meta.url),
  "utf8",
);

function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  return db;
}

function app(db: Database.Database, id: string) {
  db.prepare(
    "INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?,?,?,'android',1)",
  ).run(id, id, id);
}

function audit(
  db: Database.Database,
  id: string,
  appId: string,
  action: string,
  payload: unknown,
  createdAt: number,
) {
  db.prepare(
    `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
     VALUES (?, ?, ?, 'private-actor', ?, ?)`,
  ).run(id, appId, action, typeof payload === "string" ? payload : JSON.stringify(payload), createdAt);
}

describe("migration 0061 — minimized feedback transition view", () => {
  it("derives stable dense app-local sequences from the append-only audit SSOT", () => {
    const db = database();
    app(db, "app-a");
    app(db, "app-b");
    audit(db, "a-status", "app-a", "feedback.update", {
      ticket_id: "ticket-a",
      previous_status: "open",
      status: "in_progress",
      previous_assignee: null,
      assignee: null,
    }, 10);
    audit(db, "b-comment", "app-b", "feedback.comment", {
      ticket_id: "ticket-b",
      comment_id: "private-comment-id",
      internal: false,
      arbitrary_secret: "never-project",
    }, 11);
    audit(db, "a-combined", "app-a", "feedback.update", {
      ticket_id: "ticket-a",
      previous_status: "in_progress",
      status: "resolved",
      previous_assignee: null,
      assignee: "owner",
    }, 12);

    expect(db.prepare(
      `SELECT app_id, sequence, ticket_id, transition_type,
              previous_value, value, occurred_at
       FROM feedback_transitions ORDER BY app_id, sequence`,
    ).all()).toEqual([
      {
        app_id: "app-a",
        sequence: 1,
        ticket_id: "ticket-a",
        transition_type: "status_changed",
        previous_value: "open",
        value: "in_progress",
        occurred_at: 10,
      },
      {
        app_id: "app-a",
        sequence: 2,
        ticket_id: "ticket-a",
        transition_type: "status_changed",
        previous_value: "in_progress",
        value: "resolved",
        occurred_at: 12,
      },
      {
        app_id: "app-a",
        sequence: 3,
        ticket_id: "ticket-a",
        transition_type: "assignee_changed",
        previous_value: null,
        value: "owner",
        occurred_at: 12,
      },
      {
        app_id: "app-b",
        sequence: 1,
        ticket_id: "ticket-b",
        transition_type: "comment_visibility",
        previous_value: null,
        value: "reporter",
        occurred_at: 11,
      },
    ]);
    expect(db.prepare("PRAGMA table_info(feedback_transitions)").all()
      .map((row: any) => row.name)).toEqual([
      "app_id",
      "sequence",
      "ticket_id",
      "transition_type",
      "previous_value",
      "value",
      "occurred_at",
    ]);
    expect(JSON.stringify(db.prepare("SELECT * FROM feedback_transitions").all()))
      .not.toContain("never-project");
  });

  it("suppresses every no-op and preserves both nullable assignee directions", () => {
    const db = database();
    app(db, "app-a");
    audit(db, "noop", "app-a", "feedback.update", {
      ticket_id: "ticket",
      previous_status: "open",
      status: "open",
      previous_assignee: null,
      assignee: null,
    }, 1);
    audit(db, "assign", "app-a", "feedback.update", {
      ticket_id: "ticket",
      previous_status: "open",
      status: "open",
      previous_assignee: null,
      assignee: "owner",
    }, 2);
    audit(db, "unassign", "app-a", "feedback.update", {
      ticket_id: "ticket",
      previous_status: "open",
      status: "open",
      previous_assignee: "owner",
      assignee: null,
    }, 3);
    expect(db.prepare(
      "SELECT sequence, previous_value, value FROM feedback_transitions ORDER BY sequence",
    ).all()).toEqual([
      { sequence: 1, previous_value: null, value: "owner" },
      { sequence: 2, previous_value: "owner", value: null },
    ]);
  });

  it("projects staff/reporter comment visibility without identities or arbitrary payload", () => {
    const db = database();
    app(db, "app-a");
    audit(db, "visible", "app-a", "feedback.comment", {
      ticket_id: "ticket",
      comment_id: "visible-id",
      internal: false,
    }, 1);
    audit(db, "internal", "app-a", "feedback.comment", {
      ticket_id: "ticket",
      comment_id: "internal-id",
      internal: true,
    }, 2);
    audit(db, "reporter", "app-a", "feedback.reporter_comment", {
      ticket_id: "ticket",
      comment_id: "reporter-id",
      reporter_hash: "private-reporter-hash",
      audit_key_version: "private-key-version",
    }, 3);
    const rows = db.prepare(
      "SELECT transition_type, value FROM feedback_transitions ORDER BY sequence",
    ).all();
    expect(rows).toEqual([
      { transition_type: "comment_visibility", value: "reporter" },
      { transition_type: "comment_visibility", value: "internal" },
      { transition_type: "comment_visibility", value: "reporter" },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/private|hash|key.version|comment.*id/);
  });

  it("makes the dynamic sequence source immutable while preserving app purge", () => {
    const db = database();
    app(db, "app-a");
    audit(db, "event", "app-a", "feedback.comment", {
      ticket_id: "ticket",
      comment_id: "comment",
      internal: false,
    }, 1);
    expect(() => db.prepare("UPDATE audit_logs SET created_at=2 WHERE id='event'").run())
      .toThrow(/audit logs are immutable/);
    expect(() => db.prepare("DELETE FROM audit_logs WHERE id='event'").run())
      .toThrow(/audit logs are durable/);
    db.prepare("DELETE FROM apps WHERE id='app-a'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get()).toEqual({ n: 0 });
  });

  it("uses app/action-bounded sources for paging and action/time coverage", () => {
    const db = database();
    const pagePlan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT sequence, ticket_id FROM feedback_transitions
       WHERE app_id='app-a' AND sequence>0 ORDER BY sequence LIMIT 101`,
    ).all() as Array<{ detail: string }>;
    expect(pagePlan.filter((row) => row.detail.includes("SEARCH audit_logs")))
      .toHaveLength(4);
    expect(pagePlan.filter((row) => row.detail.includes("idx_audit_app_action")))
      .toHaveLength(4);
    const coveragePlan = db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT MIN(created_at) FROM audit_logs WHERE action='feedback.update'`,
    ).all() as Array<{ detail: string }>;
    expect(coveragePlan.some((row) => row.detail.includes("idx_audit_action_created")))
      .toBe(true);
  });

  it("fails validation on malformed relevant source rows instead of silently claiming coverage", () => {
    const db = database();
    app(db, "app-a");
    audit(db, "malformed", "app-a", "feedback.comment", "not-json", 1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_transitions").get()).toEqual({ n: 0 });
    expect(db.prepare(VALIDATION_SQL).all()).toEqual([
      { app_id: "app-a", violation: "malformed_feedback.comment" },
    ]);
  });
});
