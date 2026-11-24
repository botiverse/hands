import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleSetAgcCredentials } from "../src/routes/agc_credentials";
import { getAgcCredentials, storeAgcCredentials } from "../src/lib/agc_credentials";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const OHOS = "11111111-1111-4111-8111-111111111111";
const DECK = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";

function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = db.prepare(sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; }));
    const bind = (...input: unknown[]) => {
      const params = (indexes.length ? indexes.map((i) => input[i - 1]) : input).map((v) => v === undefined ? null : v);
      const execute = () => statement.reader
        ? { results: statement.all(...params), success: true as const, meta: { changes: 0 } }
        : { results: [], success: true as const, meta: { changes: statement.run(...params).changes } };
      return { _execute: execute, run: async () => execute(), all: async () => execute(), first: async <T>() => (statement.get(...params) as T | undefined) ?? null };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: <T>() => bind().first<T>() };
  };
  return { prepare, batch: async (sts: { _execute: () => unknown }[]) => db.transaction(() => sts.map((s) => s._execute()))() };
}

const account = (id: string) => ({ id, provider: "raft", provider_subject: id, server_id: "s1", server_slug: "s", principal_type: "human",
  server_role: "member", username: id, display_name: id, avatar_url: null, raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1 });

async function env() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const n of readdirSync(MIGRATION_DIR).sort()) if (n.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${n}`, "utf8"));
  sqlite.prepare("INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org','org','Org','raft','s1',1)").run();
  sqlite.prepare("INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org2','org2','Org2','raft','s2',1)").run();
  for (const [id, org, slug] of [[OHOS, "org", "raft-ohos"], [DECK, "org", "raft-deck-ohos"], [OTHER_ORG, "org2", "other-ohos"]]) {
    sqlite.prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, 'ohos', 1)").run(id, org, slug, slug);
  }
  for (const id of ["both", "deck-only"]) {
    const a = account(id);
    sqlite.prepare(`INSERT INTO raft_accounts (id, provider, provider_subject, server_id, server_slug, principal_type, server_role, username, display_name, raw_profile, created_at, updated_at, last_login_at)
      VALUES (?, 'raft', ?, 's1', 's', 'human', 'member', ?, ?, '{}', 1, 1, 1)`).run(a.id, a.id, a.id, a.id);
  }
  const member = (app: string, acc: string) => sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES (?, ?, ?, 'admin', 1)").run(`${app}-${acc}`, app, acc);
  member(OHOS, "both"); member(DECK, "both"); member(DECK, "deck-only"); member(OTHER_ORG, "both");
  const e = { DB: d1(sqlite), AGC_CRED_ENC_KEY: "agc-key" } as unknown as Env;
  await storeAgcCredentials(e.DB, "agc-key", { app_id: OHOS, actor: "t", credential: {
    credential_kind: "service_account", key_id: "kid", private_key: "-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n", sub_account: "sub", token_uri: "https://oauth-login.cloud.huawei.com/oauth2/v3/token" } as never });
  return { sqlite, env: e };
}

async function put(e: Env, acc: string, appId: string, body: unknown) {
  const c = {
    env: e, req: { param: (n: string) => (n === "appId" ? appId : ""), json: async () => body, query: () => undefined, header: () => undefined },
    json: (data: unknown, s = 200) => new Response(JSON.stringify(data), { status: s }),
    get: (k: string) => (k === "admin_account" || k === "authenticated_account" ? account(acc) : k === "admin_actor" ? `raft:${acc}` : undefined),
  } as any;
  const res = await handleSetAgcCredentials(c);
  return { status: res.status, body: await res.json() as any };
}

describe("copying AGC credentials from another ohos app", () => {
  it("copies the same service account when the caller administers both apps of one organization", async () => {
    const { env: e } = await env();
    expect((await put(e, "deck-only", DECK, { from_app: "raft-ohos" })).status).toBe(403);
    expect((await put(e, "both", DECK, { from_app: "other-ohos" })).status).toBe(400);
    expect((await put(e, "both", DECK, { from_app: "raft-deck-ohos" })).status).toBe(400);
    const copied = await put(e, "both", DECK, { from_app: "raft-ohos" });
    expect(copied.status, JSON.stringify(copied.body)).toBe(200);
    expect(copied.body.agc_credentials).toMatchObject({ credential_kind: "service_account", key_id: "kid", sub_account: "sub" });
    expect(await getAgcCredentials(e.DB, "agc-key", DECK)).toEqual(await getAgcCredentials(e.DB, "agc-key", OHOS));
  });
});
