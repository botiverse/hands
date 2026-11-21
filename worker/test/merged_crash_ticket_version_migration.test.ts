import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { metadataVersion } from "../src/routes/feedback";

const DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = readFileSync(DIR + "0103_merged_crash_ticket_version.sql", "utf8");

/** The full chain up to 0102, so 0103 runs against the real feedback_tickets shape. */
function chainBefore0103(): Database.Database {
  const db = new Database(":memory:");
  for (const name of readdirSync(DIR).sort()) {
    if (!name.endsWith(".sql") || name >= "0103") continue;
    db.exec(readFileSync(DIR + name, "utf8"));
  }
  db.pragma("foreign_keys = OFF");
  return db;
}

const merged = (extra: Record<string, unknown>) => ({
  crash_reason: "native_signal", crash_merge: [{ precedence: "existing_native", conflicts: {} }], ...extra,
});

// [metadata, kind, stored version_name, stored version_code]
const ROWS: Record<string, [Record<string, unknown> | string, string, string | null, number | null]> = {
  "native-first (2952e1a0)": [merged({ version_name: "1.0.0-alpha+53e35e9f28", version_code: 10000243 }), "crash", null, null],
  "string-code": [merged({ version_name: "1.2", version_code: " 120 " }), "crash", null, null],
  "fallback-keys": [merged({ fallback_version_name: "2.0", fallback_version_code: "200" }), "crash", null, null],
  "empty-name-uses-fallback": [merged({ version_name: "", fallback_version_name: "3.0" }), "crash", null, null],
  "garbage-code": [merged({ version_name: "4.0", version_code: "4a" }), "crash", null, null],
  "long-name": [merged({ version_name: "x".repeat(250) }), "crash", null, null],
  "has-build": [merged({ version_name: "9.9.9", version_code: 99 }), "crash", "1.0.0", 10],
  "has-name-only": [merged({ version_name: "9.9.9", version_code: 99 }), "crash", "1.0.0", null],
  "not-merged": [{ crash_reason: "native_signal", version_name: "5.0", version_code: 5 }, "crash", null, null],
  "bug-kind": [merged({ version_name: "6.0", version_code: 6 }), "bug", null, null],
  "no-version": [merged({}), "crash", null, null],
  "invalid-json": ["{not json", "crash", null, null],
};

describe("0103 merged crash ticket version", () => {
  it("fills only empty builds of merged crash tickets, as a merge now does, and is idempotent", () => {
    const db = chainBefore0103();
    const insert = db.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json, version_name, version_code, created_at, updated_at)
       VALUES (?, 'a', ?, 'open', 'm', ?, ?, ?, 0, 0)`,
    );
    for (const [id, [meta, kind, name, code]] of Object.entries(ROWS)) {
      insert.run(id, kind, typeof meta === "string" ? meta : JSON.stringify(meta), name, code);
    }
    db.exec(MIGRATION);
    const read = () => Object.fromEntries(
      (db.prepare("SELECT id, version_name, version_code FROM feedback_tickets").all() as any[])
        .map((r) => [r.id, { versionName: r.version_name, versionCode: r.version_code }]),
    );
    const after = read();
    for (const [id, [meta, kind, name, code]] of Object.entries(ROWS)) {
      const eligible = typeof meta !== "string" && Array.isArray((meta as any).crash_merge) && kind === "crash";
      const derived = eligible ? metadataVersion(meta as Record<string, unknown>) : { versionName: null, versionCode: null };
      expect(after[id], id).toEqual({ versionName: name ?? derived.versionName, versionCode: code ?? derived.versionCode });
    }
    expect(after["native-first (2952e1a0)"]).toEqual({ versionName: "1.0.0-alpha+53e35e9f28", versionCode: 10000243 });
    expect(after["has-build"]).toEqual({ versionName: "1.0.0", versionCode: 10 });
    expect(after["has-name-only"]).toEqual({ versionName: "1.0.0", versionCode: 99 });
    db.exec(MIGRATION);
    expect(read()).toEqual(after);
  });
});
