import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function chain() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(DIR).sort()) {
    if (name.endsWith(".sql")) db.exec(readFileSync(DIR + name, "utf8"));
  }
  db.prepare(`INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org','org','Org','raft','s',1)`).run();
  db.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES ('app-1','org','a','A','android','ck',1)`).run();
  db.prepare(`INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES ('a1','app-1','release.publish','tester','{"x":1}',10)`).run();
  db.prepare(`INSERT INTO audit_logs (id, app_id, action, actor, actor_type, payload, created_at) VALUES ('a2','app-1','signing_job.sign','ci','system','{}',20)`).run();
  return db;
}

describe("0095 audit log retention", () => {
  it("keeps an app's audit history when the app is deleted", () => {
    const db = chain();
    db.prepare("DELETE FROM apps WHERE id = 'app-1'").run();
    expect(db.prepare("SELECT COUNT(*) FROM audit_logs").pluck().get()).toBe(0);
    const archived = db.prepare("SELECT id, app_id, action, actor, actor_type, payload, created_at FROM audit_logs_archive ORDER BY id").all();
    expect(archived).toEqual([
      { id: "a1", app_id: "app-1", action: "release.publish", actor: "tester", actor_type: null, payload: '{"x":1}', created_at: 10 },
      { id: "a2", app_id: "app-1", action: "signing_job.sign", actor: "ci", actor_type: "system", payload: "{}", created_at: 20 },
    ]);
    expect(db.prepare("SELECT archived_at FROM audit_logs_archive WHERE id = 'a1'").pluck().get()).toBeGreaterThan(1_700_000_000_000);
  });

  it("archives a direct delete too, and refuses edits", () => {
    const db = chain();
    db.prepare("DELETE FROM audit_logs WHERE id = 'a1'").run();
    expect(db.prepare("SELECT COUNT(*) FROM audit_logs_archive WHERE id = 'a1'").pluck().get()).toBe(1);
    expect(() => db.prepare("UPDATE audit_logs SET payload = '{}' WHERE id = 'a2'").run()).toThrow(/append-only/);
    expect(db.prepare("SELECT payload FROM audit_logs WHERE id = 'a2'").pluck().get()).toBe("{}");
  });
});
