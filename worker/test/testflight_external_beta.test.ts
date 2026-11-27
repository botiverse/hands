/**
 * Public external TestFlight preparation: app-level beta groups, Beta App Review
 * Detail, and the extra betaAppLocalizations fields. A stateful fake App Store
 * Connect answers every ASC call; audits land in a real SQLite copy of the schema.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { exportPKCS8, generateKeyPair } from "jose";
import { storeAscCredentials } from "../src/lib/asc_credentials";
import { generateDeployToken, hashDeployToken } from "../src/lib/deploy_tokens";
import { requireAppRole } from "../src/lib/permissions";
import { installAscFake, type AscCall } from "./asc_fake";
import {
  handleCreateBetaGroup,
  handleListBetaGroups,
  handleUpdateBetaGroup,
} from "../src/routes/testflight_beta_groups";
import {
  handleGetBetaReviewDetail,
  handleUpdateBetaReviewDetail,
} from "../src/routes/testflight_beta_review_detail";
import {
  handleGetBetaAppDescription,
  handleUpdateBetaAppDescription,
} from "../src/routes/testflight_beta_app_description";

vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: async () => ({ fetch: async () => new Response() }) }));

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const APP = "11111111-2222-4333-8444-555555555555";
const SECRET = "s3cret-Demo-Pa55";

let p8: string;
beforeAll(async () => {
  p8 = await exportPKCS8((await generateKeyPair("ES256", { extractable: true })).privateKey);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_m, index) => { indexes.push(Number(index)); return "?"; }));
    const bind = (...parameters: unknown[]) => {
      const expanded = (indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters).map((v) => v === undefined ? null : v);
      const exec = () => statement.reader
        ? { success: true, results: statement.all(...expanded), meta: { changes: 0 } }
        : { success: true, results: [], meta: { changes: statement.run(...expanded).changes } };
      return { _execute: exec, run: async () => exec(), all: async () => exec(), first: async () => statement.get(...expanded) ?? null };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  return { prepare, batch: async (items: Array<{ _execute: () => unknown }>) => sqlite.transaction(() => items.map((item) => item._execute()))() } as unknown as D1Database;
}

type GroupAttrs = Record<string, unknown> & { name: string; isInternalGroup: boolean };

/** Stateful fake ASC. `ignore` lists attributes a PATCH/POST silently drops (to provoke readback mismatches). */
function fakeAsc(opts: { ignore?: string[]; storePassword?: boolean | "other" } = {}) {
  const groups = new Map<string, { app: string; attributes: GroupAttrs }>([
    ["grp-internal", { app: "asc-app-1", attributes: { name: "Team", isInternalGroup: true, hasAccessToAllBuilds: true, publicLinkEnabled: false, publicLink: null, feedbackEnabled: true } }],
    ["grp-ext", { app: "asc-app-1", attributes: { name: "Friends", isInternalGroup: false, hasAccessToAllBuilds: false, publicLinkEnabled: false, publicLink: null, publicLinkLimit: null, publicLinkLimitEnabled: false, feedbackEnabled: false } }],
    ["grp-foreign", { app: "asc-app-2", attributes: { name: "Elsewhere", isInternalGroup: false, publicLinkEnabled: false, publicLink: null } }],
  ]);
  const review: Record<string, unknown> = {
    contactFirstName: "Ada", contactLastName: "Lovelace", contactPhone: "+1 555 0100", contactEmail: "ada@example.com",
    demoAccountName: "demo", demoAccountPassword: "old-password", demoAccountRequired: true, notes: "Old notes",
  };
  const locs = new Map<string, { id: string; attributes: Record<string, unknown> }>([
    ["en-US", { id: "loc-1", attributes: { locale: "en-US", description: "Old", feedbackEmail: null, marketingUrl: null, privacyPolicyUrl: null } }],
  ]);
  let nextGroup = 1;
  const apply = (target: Record<string, unknown>, attributes: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (!(opts.ignore ?? []).includes(key)) target[key] = value;
    }
  };
  const groupJson = (id: string) => ({ type: "betaGroups", id, attributes: groups.get(id)!.attributes });
  const asc = installAscFake((call: AscCall) => {
    const { method, path } = call;
    if (method === "GET" && path.startsWith("/v1/apps?filter[bundleId]=build.raft.app")) return { json: { data: [{ id: "asc-app-1" }] } };
    const listMatch = path.match(/^\/v1\/apps\/([^/]+)\/betaGroups\?limit=200$/);
    if (method === "GET" && listMatch) {
      return { json: { data: [...groups.keys()].filter((id) => groups.get(id)!.app === listMatch[1]!).map(groupJson) } };
    }
    const groupMatch = path.match(/^\/v1\/betaGroups\/([^/?]+)$/);
    if (method === "GET" && groupMatch) return groups.has(groupMatch[1]!) ? { json: { data: groupJson(groupMatch[1]!) } } : { status: 404, json: { errors: [{ title: "NOT_FOUND" }] } };
    if (method === "POST" && path === "/v1/betaGroups") {
      const id = `grp-new-${nextGroup++}`;
      const attributes = { name: "", isInternalGroup: false, publicLink: null } as GroupAttrs;
      apply(attributes, call.body.data.attributes);
      groups.set(id, { app: call.body.data.relationships.app.data.id, attributes });
      // Like Apple, the create response itself may not carry the public link yet.
      const created = { type: "betaGroups", id, attributes: { ...attributes, publicLink: null } };
      if (attributes.publicLinkEnabled) attributes.publicLink = `https://testflight.apple.com/join/NEW${id.slice(-1)}`;
      return { status: 201, json: { data: created } };
    }
    if (method === "PATCH" && groupMatch) {
      const group = groups.get(groupMatch[1]!)!;
      apply(group.attributes, call.body.data.attributes);
      if (group.attributes.publicLinkEnabled && !group.attributes.publicLink) group.attributes.publicLink = "https://testflight.apple.com/join/EXT1";
      return { json: { data: groupJson(groupMatch[1]!) } };
    }
    if (method === "GET" && path === "/v1/apps/asc-app-1/betaAppReviewDetail") {
      return { json: { data: { type: "betaAppReviewDetails", id: "rd-1", attributes: { ...review } } } };
    }
    if (method === "PATCH" && path === "/v1/betaAppReviewDetails/rd-1") {
      const { demoAccountPassword, ...rest } = call.body.data.attributes;
      apply(review, rest);
      if (demoAccountPassword !== undefined) review.demoAccountPassword = opts.storePassword === false ? null : opts.storePassword === "other" ? "someone-else" : demoAccountPassword;
      return { json: { data: { type: "betaAppReviewDetails", id: "rd-1", attributes: { ...review } } } };
    }
    if (method === "GET" && path === "/v1/apps/asc-app-1/betaAppLocalizations?limit=200") {
      return { json: { data: [...locs.values()].map((l) => ({ type: "betaAppLocalizations", ...l })) } };
    }
    if (method === "POST" && path === "/v1/betaAppLocalizations") {
      const attributes = { feedbackEmail: null, marketingUrl: null, privacyPolicyUrl: null } as Record<string, unknown>;
      apply(attributes, call.body.data.attributes);
      const loc = { id: `loc-${locs.size + 1}`, attributes };
      locs.set(String(attributes.locale), loc);
      return { status: 201, json: { data: { type: "betaAppLocalizations", ...loc } } };
    }
    const locMatch = path.match(/^\/v1\/betaAppLocalizations\/([^/]+)$/);
    if (method === "PATCH" && locMatch) {
      const loc = [...locs.values()].find((l) => l.id === locMatch[1])!;
      apply(loc.attributes, call.body.data.attributes);
      return { json: { data: { type: "betaAppLocalizations", ...loc } } };
    }
    return undefined;
  });
  return { asc, groups, review, locs };
}

async function harness(role: "admin" | "publisher" | "viewer" = "admin") {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  const now = Date.now();
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, 'raft-ios', 'Raft iOS', 'ios', ?)").run(APP, now);
  sqlite.prepare("INSERT INTO channels (id, app_id, slug, name, bundle_id, created_at) VALUES ('ch', ?, 'main', 'Main', 'build.raft.app', ?)").run(APP, now);
  sqlite.prepare(`INSERT INTO raft_accounts (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
      username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
      VALUES ('acct', 'raft', 'acct', 'server', 'test', 'human', 'member', 'acct', 'Acct', NULL, '{}', ?, ?, ?)`).run(now, now, now);
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('m', ?, 'acct', ?, ?)").run(APP, role, now);
  const env = { DB: d1(sqlite), ENVIRONMENT: "development", ASC_CRED_ENC_KEY: "test-key" } as unknown as Env;
  await storeAscCredentials(env.DB, "test-key", { app_id: APP, key_id: "KEY123", issuer_id: "issuer", p8, actor: "raft:acct@test" });
  const app = new Hono<{ Bindings: Env; Variables: { admin_account: any; admin_actor: string } }>();
  app.use("*", async (c, next) => {
    c.set("admin_account", { id: "acct", provider: "raft", provider_subject: "acct", server_id: "server", server_slug: "test",
      principal_type: "human", server_role: "member", username: "acct", display_name: "Acct", avatar_url: null, raw_profile: "{}",
      created_at: 1, updated_at: 1, last_login_at: 1 });
    c.set("admin_actor", "raft:acct@test");
    await next();
  });
  // Same roles as worker/src/index.ts (asserted against the real router below).
  app.get("/api/apps/:appId/testflight-beta-groups", requireAppRole("viewer"), handleListBetaGroups as any);
  app.post("/api/apps/:appId/testflight-beta-groups", requireAppRole("admin"), handleCreateBetaGroup as any);
  app.patch("/api/apps/:appId/testflight-beta-groups/:groupId", requireAppRole("admin"), handleUpdateBetaGroup as any);
  app.get("/api/apps/:appId/testflight-beta-review-detail", requireAppRole("viewer"), handleGetBetaReviewDetail as any);
  app.put("/api/apps/:appId/testflight-beta-review-detail", requireAppRole("admin"), handleUpdateBetaReviewDetail as any);
  app.get("/api/apps/:appId/testflight-beta-app-description", requireAppRole("viewer"), handleGetBetaAppDescription as any);
  app.put("/api/apps/:appId/testflight-beta-app-description", requireAppRole("publisher"), handleUpdateBetaAppDescription as any);
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(new Request(`https://hands.test/api/apps/${APP}${path}`, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    }), env, ctx);
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  const audits = () => (sqlite.prepare("SELECT action, payload FROM audit_logs ORDER BY rowid").all() as Array<{ action: string; payload: string }>);
  return { sqlite, env, call, audits };
}

describe("beta groups", () => {
  it("lists every group of the ASC app with public link fields", async () => {
    const h = await harness("viewer");
    const fake = fakeAsc();
    fake.groups.get("grp-ext")!.attributes = { ...fake.groups.get("grp-ext")!.attributes, publicLinkEnabled: true, publicLink: "https://testflight.apple.com/join/EXT1", publicLinkLimit: 500, publicLinkLimitEnabled: true, feedbackEnabled: true };
    const out = await h.call("GET", "/testflight-beta-groups");
    expect(out.status).toBe(200);
    expect(out.json.asc_app_id).toBe("asc-app-1");
    expect(out.json.groups.map((g: any) => g.id)).toEqual(["grp-ext", "grp-internal"]);
    expect(out.json.groups[0]).toMatchObject({
      id: "grp-ext", name: "Friends", is_internal: false, public_link_enabled: true,
      public_link: "https://testflight.apple.com/join/EXT1", public_link_limit: 500, public_link_limit_enabled: true, feedback_enabled: true,
    });
    expect(fake.asc.writes()).toEqual([]);
  });

  it("creates an external group, re-reads it for the public link, and audits the request", async () => {
    const h = await harness();
    const fake = fakeAsc();
    const out = await h.call("POST", "/testflight-beta-groups", { name: "Public Beta", public_link_enabled: true, public_link_limit: 1000, feedback_enabled: true });
    expect(out.status).toBe(201);
    expect(out.json).toMatchObject({
      ok: true, readback_exact: true,
      group: { name: "Public Beta", is_internal: false, public_link_enabled: true, public_link: "https://testflight.apple.com/join/NEW1", public_link_limit: 1000, public_link_limit_enabled: true, feedback_enabled: true },
    });
    const post = fake.asc.writes()[0]!;
    expect(post.path).toBe("/v1/betaGroups");
    expect(post.body.data).toEqual({
      type: "betaGroups",
      attributes: { name: "Public Beta", publicLinkEnabled: true, publicLinkLimit: 1000, publicLinkLimitEnabled: true, feedbackEnabled: true, isInternalGroup: false },
      relationships: { app: { data: { type: "apps", id: "asc-app-1" } } },
    });
    const postIndex = fake.asc.calls.indexOf(post);
    expect(fake.asc.calls.slice(postIndex + 1).some((c) => c.method === "GET" && c.path === "/v1/betaGroups/grp-new-1")).toBe(true);
    expect(h.audits().map((a) => a.action)).toEqual(["testflight.beta_group.create_requested", "testflight.beta_group.create_verified"]);
  });

  it("refuses a duplicate name (case-insensitive) with 409 and never writes", async () => {
    const h = await harness();
    const fake = fakeAsc();
    const out = await h.call("POST", "/testflight-beta-groups", { name: "friends" });
    expect(out.status).toBe(409);
    expect(out.json).toMatchObject({ code: "DUPLICATE_GROUP_NAME", group: { id: "grp-ext" } });
    expect(fake.asc.writes()).toEqual([]);
    expect(h.audits()).toEqual([]);
  });

  it("validates input before calling Apple", async () => {
    const h = await harness();
    const fake = fakeAsc();
    for (const body of [
      { name: "X", public_link_limit: 0 },
      { name: "X", public_link_limit: 10_001 },
      { name: "X", public_link_limit: 1.5 },
      { name: "X", public_link_limit: "5" },
      { name: "   " },
      { public_link_enabled: true },
      { name: "X", is_internal_group: true },
      { name: "X", feedback_enabled: "yes" },
    ]) {
      const out = await h.call("POST", "/testflight-beta-groups", body);
      expect(out.status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.call("PATCH", "/testflight-beta-groups/grp-ext", {})).status).toBe(400);
    expect((await h.call("PATCH", "/testflight-beta-groups/grp-ext", { public_link_limit: 20_000 })).json.code).toBe("INVALID_PUBLIC_LINK_LIMIT");
    expect(fake.asc.calls).toEqual([]);
  });

  it("updates an external group and verifies the readback", async () => {
    const h = await harness();
    const fake = fakeAsc();
    const out = await h.call("PATCH", "/testflight-beta-groups/grp-ext", { public_link_enabled: true, public_link_limit: 200, feedback_enabled: true });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({
      readback_exact: true,
      updated_fields: ["public_link_enabled", "public_link_limit", "public_link_limit_enabled", "feedback_enabled"],
      group: { id: "grp-ext", public_link: "https://testflight.apple.com/join/EXT1", public_link_limit: 200, public_link_limit_enabled: true },
    });
    expect(fake.asc.writes().map((c) => [c.method, c.path])).toEqual([["PATCH", "/v1/betaGroups/grp-ext"]]);
    expect(fake.asc.writes()[0]!.body.data).toEqual({
      type: "betaGroups", id: "grp-ext",
      attributes: { publicLinkEnabled: true, publicLinkLimit: 200, publicLinkLimitEnabled: true, feedbackEnabled: true },
    });
    expect(h.audits().map((a) => a.action)).toEqual(["testflight.beta_group.update_requested", "testflight.beta_group.update_verified"]);
  });

  it("refuses public link changes on an internal group but allows a rename", async () => {
    const h = await harness();
    const fake = fakeAsc();
    const out = await h.call("PATCH", "/testflight-beta-groups/grp-internal", { public_link_enabled: true });
    expect(out.status).toBe(400);
    expect(out.json).toMatchObject({ code: "INTERNAL_GROUP_PUBLIC_LINK", fields: ["public_link_enabled"] });
    expect(fake.asc.writes()).toEqual([]);
    expect((await h.call("PATCH", "/testflight-beta-groups/grp-internal", { name: "Core Team" })).status).toBe(200);
  });

  it("refuses a group of another ASC app and a rename onto an existing name", async () => {
    const h = await harness();
    const fake = fakeAsc();
    const foreign = await h.call("PATCH", "/testflight-beta-groups/grp-foreign", { feedback_enabled: true });
    expect(foreign.status).toBe(404);
    expect(foreign.json.code).toBe("GROUP_NOT_FOUND");
    const clash = await h.call("PATCH", "/testflight-beta-groups/grp-ext", { name: "Team" });
    expect(clash.status).toBe(409);
    expect(fake.asc.writes()).toEqual([]);
  });

  it("fails with READBACK_MISMATCH when Apple does not keep a setting", async () => {
    const h = await harness();
    fakeAsc({ ignore: ["feedbackEnabled"] });
    const out = await h.call("PATCH", "/testflight-beta-groups/grp-ext", { feedback_enabled: true });
    expect(out.status).toBe(409);
    expect(out.json).toMatchObject({ code: "READBACK_MISMATCH", mismatched_fields: ["feedback_enabled"] });
    expect(h.audits().map((a) => a.action)).toEqual(["testflight.beta_group.update_requested", "testflight.beta_group.update_mismatch"]);
  });
});

describe("Beta App Review Detail", () => {
  it("returns the detail without the password", async () => {
    const h = await harness("viewer");
    fakeAsc();
    const out = await h.call("GET", "/testflight-beta-review-detail");
    expect(out.status).toBe(200);
    expect(out.json.review_detail).toEqual({
      id: "rd-1", contact_first_name: "Ada", contact_last_name: "Lovelace", contact_phone: "+1 555 0100",
      contact_email: "ada@example.com", demo_account_name: "demo", demo_account_password_set: true,
      demo_account_required: true, notes: "Old notes",
    });
    expect(out.text).not.toContain("old-password");
    expect(out.text).not.toMatch(/demoAccountPassword|"demo_account_password"/);
  });

  it("patches only supplied fields, verifies readback, and keeps the password out of response, audit and logs", async () => {
    const h = await harness();
    const fake = fakeAsc();
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    }
    const out = await h.call("PUT", "/testflight-beta-review-detail", {
      contact_email: "beta@example.com", demo_account_password: SECRET, notes: "Sign in with the demo account.",
    });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({
      readback_exact: true,
      updated_fields: ["contact_email", "demo_account_password", "notes"],
      review_detail: { contact_email: "beta@example.com", demo_account_password_set: true, notes: "Sign in with the demo account.", contact_first_name: "Ada" },
    });
    expect(out.text).not.toContain(SECRET);
    const patch = fake.asc.writes();
    expect(patch).toHaveLength(1);
    expect(patch[0]!.body.data).toEqual({
      type: "betaAppReviewDetails", id: "rd-1",
      attributes: { contactEmail: "beta@example.com", demoAccountPassword: SECRET, notes: "Sign in with the demo account." },
    });
    const audits = h.audits();
    expect(audits.map((a) => a.action)).toEqual(["testflight.beta_review_detail.update_requested", "testflight.beta_review_detail.update_verified"]);
    for (const audit of audits) {
      expect(audit.payload).not.toContain(SECRET);
      expect(audit.payload).not.toContain("beta@example.com");
    }
    expect(JSON.parse(audits[0]!.payload).fields).toEqual(["contact_email", "demo_account_password", "notes"]);
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("fails when Apple's readback differs, without echoing the password", async () => {
    const h = await harness();
    fakeAsc({ ignore: ["notes"] });
    const out = await h.call("PUT", "/testflight-beta-review-detail", { notes: "New notes", demo_account_password: SECRET });
    expect(out.status).toBe(409);
    expect(out.json).toMatchObject({ code: "READBACK_MISMATCH", mismatched_fields: ["notes"] });
    expect(out.text).not.toContain(SECRET);
    expect(h.audits().map((a) => a.action)).toContain("testflight.beta_review_detail.update_mismatch");
    expect(h.audits().every((a) => !a.payload.includes(SECRET))).toBe(true);
  });

  it("fails when Apple returns a different password than the one sent", async () => {
    const h = await harness();
    fakeAsc({ storePassword: "other" });
    const out = await h.call("PUT", "/testflight-beta-review-detail", { demo_account_password: SECRET });
    expect(out.status).toBe(409);
    expect(out.json.mismatched_fields).toEqual(["demo_account_password"]);
    expect(out.text).not.toContain(SECRET);
  });

  it("accepts a password write when Apple does not return the password", async () => {
    const h = await harness();
    fakeAsc({ storePassword: false });
    const out = await h.call("PUT", "/testflight-beta-review-detail", { demo_account_password: SECRET });
    expect(out.status).toBe(200);
    expect(out.text).not.toContain(SECRET);
  });

  it("validates input before calling Apple and never echoes values", async () => {
    const h = await harness();
    const fake = fakeAsc();
    for (const body of [
      {},
      { contact_email: "not-an-email" },
      { contact_first_name: "  " },
      { notes: "x".repeat(4_001) },
      { demo_account_required: "yes" },
      { demo_account_password: "" },
      { demoAccountPassword: SECRET },
    ]) {
      const out = await h.call("PUT", "/testflight-beta-review-detail", body);
      expect(out.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(out.text).not.toContain(SECRET);
    }
    expect(fake.asc.calls).toEqual([]);
  });
});

describe("Beta App localization extra fields", () => {
  it("writes feedback email and URLs next to descriptions, verifies them, and returns them on GET", async () => {
    const h = await harness("publisher");
    const fake = fakeAsc();
    const out = await h.call("PUT", "/testflight-beta-app-description", {
      descriptions: { "en-US": "New", ja: "新しい" },
      localizations: {
        "en-US": { feedback_email: "beta@example.com", marketing_url: "https://example.com", privacy_policy_url: "https://example.com/privacy" },
        ja: { privacy_policy_url: "https://example.com/ja/privacy" },
      },
    });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ readback_exact: true, updated_locales: ["en-US", "ja"] });
    const writes = fake.asc.writes();
    expect(writes.find((c) => c.method === "PATCH")!.body.data.attributes).toEqual({
      description: "New", feedbackEmail: "beta@example.com", marketingUrl: "https://example.com", privacyPolicyUrl: "https://example.com/privacy",
    });
    expect(writes.find((c) => c.method === "POST")!.body.data.attributes).toEqual({
      locale: "ja", description: "新しい", privacyPolicyUrl: "https://example.com/ja/privacy",
    });
    const get = await h.call("GET", "/testflight-beta-app-description");
    expect(get.json.localizations).toEqual([
      { id: "loc-1", locale: "en-US", description: "New", feedback_email: "beta@example.com", marketing_url: "https://example.com", privacy_policy_url: "https://example.com/privacy" },
      { id: "loc-2", locale: "ja", description: "新しい", feedback_email: null, marketing_url: null, privacy_policy_url: "https://example.com/ja/privacy" },
    ]);
    const requested = JSON.parse(h.audits()[0]!.payload);
    expect(requested.fields).toEqual({ "en-US": ["description", "feedbackEmail", "marketingUrl", "privacyPolicyUrl"], ja: ["description", "privacyPolicyUrl"] });
  });

  it("updates only the new fields of an existing locale without touching the description", async () => {
    const h = await harness("publisher");
    const fake = fakeAsc();
    const out = await h.call("PUT", "/testflight-beta-app-description", { localizations: { "en-US": { marketing_url: "https://example.com/beta" } } });
    expect(out.status).toBe(200);
    expect(fake.asc.writes().map((c) => c.body.data.attributes)).toEqual([{ marketingUrl: "https://example.com/beta" }]);
    expect(fake.locs.get("en-US")!.attributes.description).toBe("Old");
  });

  it("refuses to create a locale without a description, before any write", async () => {
    const h = await harness("publisher");
    const fake = fakeAsc();
    const out = await h.call("PUT", "/testflight-beta-app-description", {
      descriptions: { "en-US": "New" },
      localizations: { fr: { feedback_email: "beta@example.com" } },
    });
    expect(out.status).toBe(400);
    expect(out.json).toMatchObject({ code: "LOCALE_REQUIRES_DESCRIPTION", locales: ["fr"] });
    expect(fake.asc.writes()).toEqual([]);
  });

  it("validates emails, https URLs and field names", async () => {
    const h = await harness("publisher");
    const fake = fakeAsc();
    for (const fields of [
      { feedback_email: "nope" },
      { marketing_url: "http://example.com" },
      { privacy_policy_url: "javascript:alert(1)" },
      { description: "put me in descriptions" },
      { tv_os_privacy_policy: "x" },
      {},
    ]) {
      const out = await h.call("PUT", "/testflight-beta-app-description", { localizations: { "en-US": fields } });
      expect(out.status, JSON.stringify(fields)).toBe(400);
    }
    expect(fake.asc.calls).toEqual([]);
  });

  it("fails when Apple's readback of a new field differs", async () => {
    const h = await harness("publisher");
    fakeAsc({ ignore: ["marketingUrl"] });
    const out = await h.call("PUT", "/testflight-beta-app-description", { localizations: { "en-US": { marketing_url: "https://example.com" } } });
    expect(out.status).toBe(409);
    expect(out.json).toMatchObject({ code: "READBACK_MISMATCH", mismatched_locales: ["en-US"] });
  });
});

describe("registered routes (worker/src/index.ts)", () => {
  it("lets a viewer read but requires app admin for group and review-detail writes", async () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    for (const name of readdirSync(migrationDir).sort()) if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
    sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, 'raft-ios', 'Raft iOS', 'ios', 1)").run(APP);
    sqlite.prepare("INSERT INTO channels (id, app_id, slug, name, bundle_id, created_at) VALUES ('ch', ?, 'main', 'Main', 'build.raft.app', 1)").run(APP);
    const env = { DB: d1(sqlite), ENVIRONMENT: "production", DASHBOARD_ORIGIN: "https://dashboard.example", ASC_CRED_ENC_KEY: "test-key" } as unknown as Env;
    await storeAscCredentials(env.DB, "test-key", { app_id: APP, key_id: "KEY123", issuer_id: "issuer", p8, actor: "test" });
    const token = async (role: "publisher" | "viewer") => {
      const t = generateDeployToken();
      sqlite.prepare(`INSERT INTO app_deploy_tokens (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 'test', 1)`).run(role, APP, role, t.token_prefix, await hashDeployToken(t.token), role);
      return t.token;
    };
    const viewer = await token("viewer");
    const publisher = await token("publisher");
    const fake = fakeAsc();
    const { admin } = await import("../src/index");
    const send = (bearer: string, method: string, path: string, body?: unknown) => admin.fetch(new Request(`https://hands.test/api/apps/${APP}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), env, { waitUntil() {} } as unknown as ExecutionContext);

    expect((await send(viewer, "GET", "/testflight-beta-groups")).status).toBe(200);
    const detail = await send(viewer, "GET", "/testflight-beta-review-detail");
    expect(detail.status).toBe(200);
    expect(await detail.text()).not.toContain("old-password");
    for (const bearer of [viewer, publisher]) {
      expect((await send(bearer, "POST", "/testflight-beta-groups", { name: "Public" })).status).toBe(403);
      expect((await send(bearer, "PATCH", "/testflight-beta-groups/grp-ext", { feedback_enabled: true })).status).toBe(403);
      expect((await send(bearer, "PUT", "/testflight-beta-review-detail", { notes: "x" })).status).toBe(403);
    }
    expect(fake.asc.writes()).toEqual([]);
  });
});
