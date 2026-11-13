import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../migrations/sql/0091_system_kill_importance_regroup.sql", import.meta.url)),
  "utf8",
);

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE feedback_tickets (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, closure_reason TEXT,
    signature TEXT, metadata_json TEXT
  );`);
  return db;
}

const kill = (extra: Record<string, unknown>) =>
  JSON.stringify({ crash_type: "system_kill", crash_exception_class: "SystemKill", crash_top_frame: "other", ...extra });

describe("0091 system kill importance regroup", () => {
  it("regroups only stored background kills whose exit importance is below 400, leaving status alone", () => {
    const db = freshDb();
    const insert = db.prepare("INSERT INTO feedback_tickets VALUES (?, ?, ?, ?, ?, ?)");
    // The shape of ticket 560fe7ac: importance 100, stale background trim, reopened by a person.
    insert.run("fg-100", "crash", "in_progress", null, "SystemKill@background", kill({ crash_exit_importance: 100, crash_trim: "background" }));
    insert.run("fg-300-closed", "crash", "closed", "not_planned", "SystemKill@background", kill({ crash_exit_importance: 300 }));
    insert.run("bg-400", "crash", "closed", "not_planned", "SystemKill@background", kill({ crash_exit_importance: 400, crash_foreground: true }));
    insert.run("no-imp", "crash", "closed", "not_planned", "SystemKill@background", kill({ crash_trim: "ui_hidden" }));
    insert.run("str-imp", "crash", "closed", "not_planned", "SystemKill@background", kill({ crash_exit_importance: "100" }));
    insert.run("no-frame", "crash", "closed", "not_planned", "SystemKill@background", JSON.stringify({ crash_type: "system_kill", crash_exception_class: "SystemKill", crash_exit_importance: 100 }));
    insert.run("paren-frame", "crash", "closed", "not_planned", "SystemKill@background", kill({ crash_exit_importance: 100, crash_top_frame: "a.B.c(B.kt:1)" }));
    insert.run("other-sig", "crash", "open", null, "Boom@x", kill({ crash_exit_importance: 100 }));
    insert.run("feedback", "feedback", "open", null, "SystemKill@background", kill({ crash_exit_importance: 100 }));
    insert.run("bad-json", "crash", "open", null, "SystemKill@background", "{not json");

    db.exec(migration);
    const rows = Object.fromEntries(
      (db.prepare("SELECT id, status, closure_reason, signature FROM feedback_tickets").all() as any[]).map((r) => [r.id, r]),
    );
    expect(rows["fg-100"]).toEqual({ id: "fg-100", status: "in_progress", closure_reason: null, signature: "SystemKill@other" });
    expect(rows["fg-300-closed"]).toEqual({ id: "fg-300-closed", status: "closed", closure_reason: "not_planned", signature: "SystemKill@other" });
    for (const id of ["bg-400", "no-imp", "str-imp", "no-frame", "paren-frame", "feedback", "bad-json"]) {
      expect([id, rows[id].signature]).toEqual([id, "SystemKill@background"]);
    }
    expect(rows["other-sig"].signature).toBe("Boom@x");

    // Re-running changes nothing.
    db.exec(migration);
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_tickets WHERE signature = 'SystemKill@other'").get() as any).n).toBe(2);
  });
});
