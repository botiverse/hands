import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKGROUND_SYSTEM_KILL_SQL, crashSignature, isBackgroundSystemKill } from "../src/routes/feedback";

const DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = readFileSync(DIR + "0091_system_kill_importance_regroup.sql", "utf8");

/** The full chain up to 0090, so 0091 runs against the real feedback_tickets shape. */
function chainBefore0091(): Database.Database {
  const db = new Database(":memory:");
  for (const name of readdirSync(DIR).sort()) {
    if (!name.endsWith(".sql") || name >= "0091") continue;
    db.exec(readFileSync(DIR + name, "utf8"));
  }
  // Tickets only; the app row they reference is irrelevant to this migration.
  db.pragma("foreign_keys = OFF");
  return db;
}

const kill = (extra: Record<string, unknown>) => ({
  crash_type: "system_kill", crash_exception_class: "SystemKill", crash_top_frame: "other", crash_exit_reason_code: 13, ...extra,
});

// Each shape is stored as the old ingest stored it: under SystemKill@background.
const SHAPES: Record<string, Record<string, unknown>> = {
  "imp100-trim-bg (560fe7ac)": kill({ crash_exit_importance: 100, crash_foreground: true, crash_trim: "background" }),
  "imp400-fg-true (f5a3d589)": kill({ crash_exit_importance: 400, crash_foreground: true, crash_trim: "ui_hidden" }),
  "imp300": kill({ crash_exit_importance: 300, crash_trim: "complete" }),
  "imp-str-100": kill({ crash_exit_importance: "100", crash_trim: "ui_hidden" }),
  "imp-str-ws-100": kill({ crash_exit_importance: " 100\t", crash_trim: "ui_hidden" }),
  "imp-str-400": kill({ crash_exit_importance: "400" }),
  "imp-real-399.9": kill({ crash_exit_importance: 399.9, crash_trim: "ui_hidden" }),
  "imp-garbage-trim-bg": kill({ crash_exit_importance: "abc", crash_trim: "background" }),
  "no-imp-fg-true-trim-bg": kill({ crash_foreground: true, crash_trim: "background" }),
  "no-imp-fg-false": kill({ crash_foreground: false }),
  "no-imp-trim-bg": kill({ crash_trim: "ui_hidden" }),
  "no-imp-trim-none": kill({ crash_trim: "none" }),
  "paren-frame": kill({ crash_exit_importance: 100, crash_top_frame: "a.B.c(B.kt:1)" }),
  "paren-frame-no-close": kill({ crash_exit_importance: 100, crash_top_frame: "a.B.c(B.kt" }),
  "paren-frame-twice": kill({ crash_exit_importance: 100, crash_top_frame: " a.B.c(B.kt:1).d(x) " }),
  "fallback-keys": { crash_type: "system_kill", exception_class: "Legacy", top_frame: "f(x)", crash_exit_importance: 200 },
  "null-class-uses-fallback": kill({ crash_exception_class: null, exception_class: "Legacy", crash_exit_importance: 100 }),
  "no-class": { crash_type: "system_kill", crash_top_frame: "other", crash_exit_importance: 100 },
  "no-class-no-frame": { crash_type: "system_kill", crash_exit_importance: 100 },
  "long": kill({ crash_exit_importance: 100, crash_top_frame: "x".repeat(400) }),
};

describe("0091 system kill importance regroup", () => {
  it("leaves the read-side rule agreeing with ingest, with the signature ingest computes, and keeps status", () => {
    const db = chainBefore0091();
    const insert = db.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, closure_reason, message, metadata_json, signature, created_at, updated_at)
       VALUES (?, 'a', 'crash', ?, ?, 'kill', ?, 'SystemKill@background', 0, 0)`,
    );
    for (const [id, meta] of Object.entries(SHAPES)) {
      if (id.startsWith("imp100")) insert.run(id, "in_progress", null, JSON.stringify(meta));
      else insert.run(id, "closed", "not_planned", JSON.stringify(meta));
    }
    insert.run("bad-json", "closed", "not_planned", "{not json");
    db.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, signature, created_at, updated_at)
       VALUES ('feedback-kind', 'a', 'feedback', 'open', 'x', ?, 'SystemKill@background', 0, 0)`,
    ).run(JSON.stringify(kill({ crash_exit_importance: 100 })));

    db.exec(MIGRATION);

    const verdict = db.prepare(
      `SELECT t.id, t.status, t.closure_reason, t.signature, (${BACKGROUND_SYSTEM_KILL_SQL}) AS bg FROM feedback_tickets t
       WHERE json_valid(t.metadata_json)`,
    );
    const rows = Object.fromEntries((verdict.all() as any[]).map((r) => [r.id, r]));
    for (const [id, meta] of Object.entries(SHAPES)) {
      const background = isBackgroundSystemKill(meta);
      expect([id, rows[id].bg === 1]).toEqual([id, background]);
      expect([id, rows[id].signature]).toEqual([id, background ? "SystemKill@background" : crashSignature(meta)]);
    }
    expect(rows["imp100-trim-bg (560fe7ac)"]).toMatchObject({ status: "in_progress", closure_reason: null, signature: "SystemKill@other" });
    expect(rows["imp300"]).toMatchObject({ status: "closed", closure_reason: "not_planned" });
    // The read-side SQL, old and new alike, cannot evaluate invalid JSON; ingest
    // never stores it. The migration must still leave such a row alone.
    expect(db.prepare("SELECT signature FROM feedback_tickets WHERE id = 'bad-json'").get()).toEqual({ signature: "SystemKill@background" });
    expect(rows["feedback-kind"].signature).toBe("SystemKill@background");

    const before = JSON.stringify(verdict.all());
    db.exec(MIGRATION);
    expect(JSON.stringify(verdict.all())).toBe(before);
  });
});
