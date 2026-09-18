import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../migrations/sql/0075_app_creator_becomes_admin.sql", import.meta.url)),
  "utf8",
);

/**
 * Minimal shape for this migration: `apps`, `audit_logs`, `raft_accounts`, `app_members`.
 * The app_members UNIQUE(app_id, account_id) from migration 0016 is load-bearing here
 * (the backfill's NOT EXISTS relies on it being the identity of a membership), so it is
 * reproduced rather than dropped.
 */
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE apps (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_id TEXT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE raft_accounts (
      id TEXT PRIMARY KEY,
      username TEXT,
      server_slug TEXT,
      server_id TEXT NOT NULL
    );
    CREATE TABLE app_members (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      app_role TEXT NOT NULL,
      invited_by TEXT,
      joined_at INTEGER NOT NULL,
      UNIQUE (app_id, account_id)
    );
  `);
  return db;
}

const T_APP = 1_700_000_000_000;

function addAccount(db: Database.Database, id: string, username: string, server: string) {
  db.prepare("INSERT INTO raft_accounts (id, username, server_slug, server_id) VALUES (?,?,?,?)").run(
    id,
    username,
    server,
    `srv-${server}`,
  );
}

/** Records the app.create audit row with an explicit actor handle, matching production
 *  shape: 'raft:<username>@<server_slug>'. The actor is NOT derived from the slug - the
 *  two are independent in production, and deriving one from the other would let a mapping
 *  bug pass. actor_id is NULL, as it is in practice for this action. */
function addApp(db: Database.Database, id: string, actor: string) {
  db.prepare("INSERT INTO apps (id, slug, created_at) VALUES (?,?,?)").run(id, id, T_APP);
  db.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, actor_id, payload, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(`al-${id}`, id, "app.create", actor, null, "{}", T_APP);
}

describe("0074 app creator becomes admin", () => {
  it("inserts an admin row for the creator, using the app's own creation time", () => {
    const db = freshDb();
    addAccount(db, "acct-1", "raft-owner", "botiverse");
    addApp(db, "app-1", "raft:raft-owner@botiverse");

    db.exec(migration);

    const row = db
      .prepare("SELECT account_id, app_role, invited_by, joined_at FROM app_members WHERE app_id='app-1'")
      .get() as { account_id: string; app_role: string; invited_by: string | null; joined_at: number };
    expect(row.account_id).toBe("acct-1");
    expect(row.app_role).toBe("admin");
    // Not invited by anyone: the creator is the app's first admin, not a granted member.
    expect(row.invited_by).toBeNull();
    // The grant has been true since the app existed; stamping it "now" would make it
    // look like a permission granted on deploy day.
    expect(row.joined_at).toBe(T_APP);
  });

  it("maps on username AND server, so a same-named account on another server is not used", () => {
    const db = freshDb();
    // The reported shape: the same handle exists on two servers.
    addAccount(db, "acct-slock", "artin", "slock-android");
    addAccount(db, "acct-boti", "artin", "botiverse");
    addApp(db, "app-1", "raft:artin@botiverse");

    db.exec(migration);

    const rows = db
      .prepare("SELECT account_id FROM app_members WHERE app_id='app-1'")
      .all() as Array<{ account_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_id).toBe("acct-boti");
  });

  it("leaves an app whose actor is not a raft: handle alone, rather than guessing", () => {
    const db = freshDb();
    db.prepare("INSERT INTO apps (id, slug, created_at) VALUES ('app-x','myapp-android',?)").run(T_APP);
    db.prepare(
      "INSERT INTO audit_logs (id, app_id, action, actor, actor_id, payload, created_at) VALUES ('al-x','app-x','app.create','admin',NULL,'{}',?)",
    ).run(T_APP);
    addAccount(db, "acct-1", "admin", "botiverse"); // an account that WOULD match a naive guess

    db.exec(migration);

    const n = db.prepare("SELECT COUNT(*) AS n FROM app_members").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("never overwrites an existing membership", () => {
    const db = freshDb();
    addAccount(db, "acct-1", "raft-owner", "botiverse");
    addApp(db, "app-1", "raft:raft-owner@botiverse");
    // The creator is already a member, with a DIFFERENT role that must survive.
    db.prepare(
      "INSERT INTO app_members (id, app_id, account_id, app_role, invited_by, joined_at) VALUES ('m1','app-1','acct-1','publisher','inviter-1', 123)",
    ).run();

    db.exec(migration);

    const row = db.prepare("SELECT app_role, invited_by, joined_at FROM app_members WHERE id='m1'").get() as {
      app_role: string;
      invited_by: string | null;
      joined_at: number;
    };
    expect(row.app_role).toBe("publisher");
    expect(row.invited_by).toBe("inviter-1");
    expect(row.joined_at).toBe(123);
  });

  it("is idempotent: applying it twice changes nothing", () => {
    const db = freshDb();
    addAccount(db, "acct-1", "raft-owner", "botiverse");
    addAccount(db, "acct-2", "other-owner", "botiverse");
    addApp(db, "app-1", "raft:raft-owner@botiverse");
    addApp(db, "app-2", "raft:other-owner@botiverse");

    db.exec(migration);
    const after1 = db.prepare("SELECT COUNT(*) AS n FROM app_members").get() as { n: number };
    db.exec(migration);
    const after2 = db.prepare("SELECT COUNT(*) AS n FROM app_members").get() as { n: number };

    expect(after1.n).toBe(2);
    expect(after2.n).toBe(2);
  });

  it("RED CHECK: removing the insert makes the guard fire, not silently pass", () => {
    const db = freshDb();
    addAccount(db, "acct-1", "raft-owner", "botiverse");
    addApp(db, "app-1", "raft:raft-owner@botiverse");

    // Defeat the insert: keep the headers and the guards, drop the backfill itself.
    const startOfInsert = migration.indexOf("INSERT INTO app_members (id, app_id, account_id");
    const startOfGuards = migration.indexOf("-- Guard: the backfill must not leave");
    expect(startOfInsert).toBeGreaterThan(-1);
    expect(startOfGuards).toBeGreaterThan(startOfInsert);
    const crippled = migration.slice(0, startOfInsert) + migration.slice(startOfGuards);
    expect(() => db.exec(crippled)).toThrow(/CHECK constraint failed/);
  });
});
