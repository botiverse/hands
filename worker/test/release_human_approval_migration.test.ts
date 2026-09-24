/**
 * Migration 0076 — per-app "release must be approved by a human" gate (task #239).
 *
 * Loads the REAL migration files in order (same harness as 0074). The state
 * machine on release_approval_requests is enforced in the schema; this file makes
 * that enforcement permanent so a regression goes red in CI instead of silently
 * legalising a bad row. It also pins the per-app toggle default (off) and the
 * "at most one pending request per release" partial unique index.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  return db;
}

function seedAppAndRelease(db: Database.Database): { appId: string; releaseId: string } {
  const appId = "app-1";
  db.prepare(
    `INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, 'a', 'A', 'android', 1)`,
  ).run(appId);
  db.prepare(
    `INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('ch', ?, 'production', 'P', 1)`,
  ).run(appId);
  // releases requires build_id + channel_id; satisfy the FKs with a minimal build.
  db.prepare(
    `INSERT INTO builds (id, app_id, version_name, version_code, created_at, updated_at)
     VALUES ('b', ?, '1.0.0', 1, 1, 1)`,
  ).run(appId);
  const releaseId = "rel-1";
  db.prepare(
    `INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, created_by, status, created_at, updated_at)
     VALUES (?, ?, 'b', 'ch', 'android-apk', 'stable', 'tester', 'draft', 1, 1)`,
  ).run(releaseId, appId);
  return { appId, releaseId };
}

type Row = {
  status: string;
  decidedBy: string | null;
  decidedAt: number | null;
};

function insertRequest(db: Database.Database, releaseId: string, r: Row, id = "req-1"): boolean {
  try {
    db.prepare(
      `INSERT INTO release_approval_requests
         (id, app_id, release_id, requested_by_actor, expected_revision, expected_scopes,
          status, decided_by, decided_at, created_at)
       VALUES (?, 'app-1', ?, 'agent:tok', 3, '[]', ?, ?, ?, 1)`,
    ).run(id, releaseId, r.status, r.decidedBy, r.decidedAt);
    return true;
  } catch {
    return false;
  }
}

describe("migration 0076: release_requires_human_approval", () => {
  it("adds the per-app toggle defaulting to off (0)", () => {
    const db = database();
    db.prepare(
      `INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('x', 'x', 'X', 'ios', 1)`,
    ).run();
    const row = db
      .prepare(`SELECT release_requires_human_approval AS v FROM apps WHERE id = 'x'`)
      .get() as { v: number } | undefined;
    expect(row?.v).toBe(0);
  });

  it("accepts exactly the legal request states", () => {
    const db = database();
    const { releaseId } = seedAppAndRelease(db);
    expect(insertRequest(db, releaseId, { status: "pending", decidedBy: null, decidedAt: null })).toBe(true);
    expect(insertRequest(db, releaseId, { status: "approved", decidedBy: "human@x", decidedAt: 5 }, "req-2")).toBe(true);
    expect(insertRequest(db, releaseId, { status: "rejected", decidedBy: "human@x", decidedAt: 6 }, "req-3")).toBe(true);
  });

  it("rejects every inconsistent state on INSERT", () => {
    const db = database();
    const { releaseId } = seedAppAndRelease(db);
    const illegal: Row[] = [
      { status: "pending", decidedBy: "human@x", decidedAt: null },
      { status: "pending", decidedBy: null, decidedAt: 5 },
      { status: "pending", decidedBy: "human@x", decidedAt: 5 },
      { status: "approved", decidedBy: null, decidedAt: 5 },
      { status: "approved", decidedBy: "human@x", decidedAt: null },
      { status: "approved", decidedBy: "human@x", decidedAt: 0 },
      { status: "rejected", decidedBy: null, decidedAt: null },
      { status: "weird", decidedBy: null, decidedAt: null },
    ];
    illegal.forEach((r, i) => {
      expect(insertRequest(db, releaseId, r, `bad-${i}`), JSON.stringify(r)).toBe(false);
    });
  });

  it("rejects a state change into an inconsistent row on UPDATE", () => {
    const db = database();
    const { releaseId } = seedAppAndRelease(db);
    expect(insertRequest(db, releaseId, { status: "pending", decidedBy: null, decidedAt: null })).toBe(true);
    // Approving without recording a decider must fail.
    expect(() =>
      db.prepare(`UPDATE release_approval_requests SET status = 'approved' WHERE id = 'req-1'`).run(),
    ).toThrow();
    // A full, consistent decision succeeds.
    db.prepare(
      `UPDATE release_approval_requests SET status = 'approved', decided_by = 'human@x', decided_at = 9 WHERE id = 'req-1'`,
    ).run();
    const row = db.prepare(`SELECT status FROM release_approval_requests WHERE id = 'req-1'`).get() as { status: string } | undefined;
    expect(row?.status).toBe("approved");
  });

  it("allows at most one pending request per release", () => {
    const db = database();
    const { releaseId } = seedAppAndRelease(db);
    expect(insertRequest(db, releaseId, { status: "pending", decidedBy: null, decidedAt: null })).toBe(true);
    expect(insertRequest(db, releaseId, { status: "pending", decidedBy: null, decidedAt: null }, "req-dup")).toBe(false);
    // Once the first is decided, a new pending request for the same release is allowed.
    db.prepare(
      `UPDATE release_approval_requests SET status = 'rejected', decided_by = 'h', decided_at = 2 WHERE id = 'req-1'`,
    ).run();
    expect(insertRequest(db, releaseId, { status: "pending", decidedBy: null, decidedAt: null }, "req-again")).toBe(true);
  });

  it("cascades when the release is deleted", () => {
    const db = database();
    const { releaseId } = seedAppAndRelease(db);
    insertRequest(db, releaseId, { status: "pending", decidedBy: null, decidedAt: null });
    db.prepare(`DELETE FROM releases WHERE id = ?`).run(releaseId);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM release_approval_requests`).get() as { n: number } | undefined;
    expect(left?.n).toBe(0);
  });

  it("cascades when the app is deleted", () => {
    const db = database();
    const { appId, releaseId } = seedAppAndRelease(db);
    insertRequest(db, releaseId, { status: "pending", decidedBy: null, decidedAt: null });
    db.prepare(`DELETE FROM apps WHERE id = ?`).run(appId);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM release_approval_requests`).get() as { n: number } | undefined;
    expect(left?.n).toBe(0);
  });
});
