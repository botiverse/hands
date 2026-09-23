/**
 * Task #239 — per-app "release must be approved by a human" gate, route level.
 *
 * Exercises the real authMiddleware + requireAppRole over the D1 shim (mirrors
 * agent_login_routes.test.ts) to prove:
 *   - an agent (deploy token) publish on a gated app is held as a pending
 *     approval request (202) and does NOT activate the release;
 *   - a human (admin session) publish on the same gated app publishes directly;
 *   - an agent publish on an ungated app publishes directly;
 *   - a human approving a pending request re-executes the publish (release
 *     activates, request -> approved);
 *   - an agent cannot approve (role guard) and a human can reject.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { requireAppRole } from "../src/lib/permissions";
import { sha256Hex } from "../src/lib/agent_login";
import {
  handlePublishRelease,
  handleCreateRelease,
  handleListReleaseApprovals,
  handleApproveReleaseApproval,
  handleRejectReleaseApproval,
} from "../src/routes/releases";
import { handleListApps } from "../src/routes/apps";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

/** D1 shim over better-sqlite3 with batch() (mirrors agent_login_routes.test.ts). */
function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]) => {
      const params = (indexes.length ? indexes.map((i) => input[i - 1]) : input)
        .map((v) => (v === undefined ? null : v));
      const execute = () => statement.reader
        ? { results: statement.all(...params), success: true as const, meta: { changes: 0 } }
        : { results: [], success: true as const, meta: { changes: statement.run(...params).changes } };
      return {
        _execute: execute,
        run: async () => execute(),
        all: async () => execute(),
        first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: <T>() => bind().first<T>() };
  };
  return {
    prepare,
    batch: async (sts: { _execute: () => unknown }[]) =>
      db.transaction(() => sts.map((s) => s._execute()))(),
  };
}

function environment() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  const env = { DB: d1(sqlite), ENVIRONMENT: "production", DASHBOARD_ORIGIN: "https://dashboard.example" } as unknown as Env;
  return { sqlite, env };
}

function seedBase(sqlite: Database.Database, opts: { gated: boolean }) {
  sqlite.exec(`INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
    VALUES ('org1','org1','Org','raft','srvH',1)`);
  sqlite.exec(`INSERT INTO raft_accounts
    (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
     username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
    VALUES ('humanAcct','raft','humanSubj','srvH','srvH','human',NULL,'human','Human',NULL,'{}',1,1,1)`);
  sqlite.exec(`INSERT INTO org_members (org_id, account_id, org_role, joined_at) VALUES ('org1','humanAcct','admin',1)`);
  sqlite.exec(`INSERT INTO apps (id, org_id, slug, name, platform, release_requires_human_approval, created_at)
    VALUES ('app1','org1','app1','App','android',${opts.gated ? 1 : 0},1)`);
  sqlite.exec(`INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('ch1','app1','production','P',1)`);
}

function seedDraftRelease(sqlite: Database.Database, releaseId: string) {
  sqlite.exec(`INSERT INTO builds (id, app_id, channel_id, version_name, version_code, created_at, updated_at)
    VALUES ('b-${releaseId}','app1','ch1','1.0.0',1,1,1)`);
  sqlite.exec(`INSERT INTO releases
    (id, app_id, build_id, channel_id, product_type, release_type, created_by, status, revision, created_at, updated_at)
    VALUES ('${releaseId}','app1','b-${releaseId}','ch1','android-apk','stable','agent','draft',0,1,1)`);
  sqlite.exec(`INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
    VALUES ('s-${releaseId}','${releaseId}','full','all',1)`);
}

// A real external (artifact_mode='external', product_type='cli-binary') draft
// release with two declared build targets. required_external_targets is
// meaningful only here — the gate validates it against the declared set and
// freezes it at publish. Internal builds reject any required_external_targets.
function seedExternalDraftRelease(sqlite: Database.Database, releaseId: string) {
  const buildId = `b-${releaseId}`;
  sqlite.exec(`INSERT INTO builds
    (id, app_id, channel_id, product_type, release_type, version_name, version_code, source, status, artifact_mode, created_at, updated_at)
    VALUES ('${buildId}','app1','ch1','cli-binary','stable','2.0.0',2000000,'external','succeeded','external',1,1)`);
  for (const target of ["darwin-arm64", "linux-x64"]) {
    sqlite.exec(`INSERT INTO external_build_targets
      (id, app_id, build_id, version_name, target, source_url, raw_sha256, raw_size_bytes, created_at, updated_at)
      VALUES ('t-${releaseId}-${target}','app1','${buildId}','2.0.0','${target}','https://cdn.test/2.0.0/${target}','${"a".repeat(64)}',100,1,1)`);
  }
  sqlite.exec(`INSERT INTO releases
    (id, app_id, build_id, channel_id, product_type, release_type, created_by, status, revision, created_at, updated_at)
    VALUES ('${releaseId}','app1','${buildId}','ch1','cli-binary','stable','agent','draft',0,1,1)`);
  sqlite.exec(`INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
    VALUES ('s-${releaseId}','${releaseId}','full','all',1)`);
}

async function seedHumanSession(sqlite: Database.Database, token: string) {
  const hash = await sha256Hex(token);
  sqlite.exec(`INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES ('sess-human','humanAcct','${hash}',1,9999999999999,1)`);
}

async function seedAgentToken(sqlite: Database.Database, token: string) {
  const hash = await sha256Hex(token);
  sqlite.exec(`INSERT INTO app_deploy_tokens
    (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
    VALUES ('tok1','app1','ci','qvdt','${hash}','publisher',NULL,'creator',1)`);
}

function app() {
  const a = new Hono();
  const auth = authMiddleware as any;
  a.get("/api/apps", auth, handleListApps as any);
  a.post("/api/apps/:appId/releases", auth, requireAppRole("publisher") as any, handleCreateRelease as any);
  a.post("/api/apps/:appId/releases/:releaseId/publish", auth, requireAppRole("publisher") as any, handlePublishRelease as any);
  a.get("/api/apps/:appId/release-approvals", auth, requireAppRole("admin") as any, handleListReleaseApprovals as any);
  a.post("/api/apps/:appId/release-approvals/:requestId/approve", auth, requireAppRole("admin") as any, handleApproveReleaseApproval as any);
  a.post("/api/apps/:appId/release-approvals/:requestId/reject", auth, requireAppRole("admin") as any, handleRejectReleaseApproval as any);
  return a;
}

const HUMAN = "human-session-token";
const AGENT = "qvdt_agentsecret";
const AGENT_SESSION = "agent-session-token";
// Hono's app.request throws when a handler touches c.executionCtx without one
// being supplied; the publish path uses waitUntil for webhook/delta side effects.
const EXEC = { waitUntil: () => undefined } as unknown as ExecutionContext;

function releaseStatus(sqlite: Database.Database, releaseId: string): string {
  return (sqlite.prepare("SELECT status FROM releases WHERE id = ?").get(releaseId) as { status: string }).status;
}

// A Raft *agent-principal* account that is an org admin, authenticated via a
// session (not a deploy token). This is the bypass the review caught: it has an
// admin role but is NOT a human, so it must still be gated / barred from deciding.
async function seedAgentAdminSession(sqlite: Database.Database, token: string) {
  sqlite.exec(`INSERT INTO raft_accounts
    (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
     username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
    VALUES ('agentAcct','raft','agentSubj','srvH','srvH','agent',NULL,'agentbot','AgentBot',NULL,'{}',1,1,1)`);
  sqlite.exec(`INSERT INTO org_members (org_id, account_id, org_role, joined_at) VALUES ('org1','agentAcct','admin',1)`);
  const hash = await sha256Hex(token);
  sqlite.exec(`INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES ('sess-agent','agentAcct','${hash}',1,9999999999999,1)`);
}

describe("release human-approval gate (task #239)", () => {
  it("agent publish on a gated app is held pending and does not activate", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relA");
    await seedAgentToken(sqlite, AGENT);

    const res = await app().request(
      "/api/apps/app1/releases/relA/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.status).toBe("pending_approval");
    expect(typeof body.approval_request_id).toBe("string");
    // Release must remain draft — nothing published.
    expect(releaseStatus(sqlite, "relA")).toBe("draft");
    const pending = sqlite.prepare(
      "SELECT COUNT(*) n FROM release_approval_requests WHERE release_id='relA' AND status='pending'",
    ).get() as { n: number };
    expect(pending.n).toBe(1);
  });

  it("human publish on a gated app publishes directly (no approval)", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relH");
    await seedHumanSession(sqlite, HUMAN);

    const res = await app().request(
      "/api/apps/app1/releases/relH/publish",
      { method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(res.status).toBe(200);
    expect(releaseStatus(sqlite, "relH")).toBe("active");
    const pending = sqlite.prepare("SELECT COUNT(*) n FROM release_approval_requests").get() as { n: number };
    expect(pending.n).toBe(0);
  });

  it("agent publish on an ungated app publishes directly", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: false });
    seedDraftRelease(sqlite, "relU");
    await seedAgentToken(sqlite, AGENT);

    const res = await app().request(
      "/api/apps/app1/releases/relU/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(res.status).toBe(200);
    expect(releaseStatus(sqlite, "relU")).toBe("active");
  });

  it("human approve re-executes the publish and marks the request approved", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relP");
    await seedAgentToken(sqlite, AGENT);
    await seedHumanSession(sqlite, HUMAN);
    const a = app();

    const held = await a.request(
      "/api/apps/app1/releases/relP/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(held.status).toBe(202);
    const { approval_request_id: reqId } = (await held.json()) as any;
    expect(releaseStatus(sqlite, "relP")).toBe("draft");

    const approved = await a.request(
      `/api/apps/app1/release-approvals/${reqId}/approve`,
      { method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(approved.status).toBe(200);
    expect(releaseStatus(sqlite, "relP")).toBe("active");
    const row = sqlite.prepare("SELECT status, decided_by FROM release_approval_requests WHERE id = ?").get(reqId) as any;
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBeTruthy();
  });

  it("an agent cannot approve (role guard)", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relG");
    await seedAgentToken(sqlite, AGENT);
    const a = app();

    const held = await a.request(
      "/api/apps/app1/releases/relG/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    const { approval_request_id: reqId } = (await held.json()) as any;

    const res = await a.request(
      `/api/apps/app1/release-approvals/${reqId}/approve`,
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(res.status).toBe(403);
    // Still pending, still draft.
    expect(releaseStatus(sqlite, "relG")).toBe("draft");
  });

  it("human reject marks the request rejected with a note", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relR");
    await seedAgentToken(sqlite, AGENT);
    await seedHumanSession(sqlite, HUMAN);
    const a = app();

    const held = await a.request(
      "/api/apps/app1/releases/relR/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    const { approval_request_id: reqId } = (await held.json()) as any;

    const res = await a.request(
      `/api/apps/app1/release-approvals/${reqId}/reject`,
      { method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: JSON.stringify({ note: "not ready" }) },
      env,
      EXEC,
    );
    expect(res.status).toBe(200);
    const row = sqlite.prepare("SELECT status, decision_note FROM release_approval_requests WHERE id = ?").get(reqId) as any;
    expect(row.status).toBe("rejected");
    expect(row.decision_note).toBe("not ready");
    expect(releaseStatus(sqlite, "relR")).toBe("draft");
  });

  it("list returns pending approvals with version/changelog context", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relL");
    await seedAgentToken(sqlite, AGENT);
    await seedHumanSession(sqlite, HUMAN);
    const a = app();

    await a.request(
      "/api/apps/app1/releases/relL/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    const res = await a.request(
      "/api/apps/app1/release-approvals?status=pending",
      { method: "GET", headers: { authorization: `Bearer ${HUMAN}` } },
      env,
      EXEC,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.approvals.length).toBe(1);
    expect(body.approvals[0]).toMatchObject({
      release_id: "relL",
      release_status: "draft",
      version_name: "1.0.0",
      version_code: 1,
      channel_slug: "production",
    });
    // Artifact identity is surfaced for the approver (task #239 review item 5).
    expect(Array.isArray(body.approvals[0].assets)).toBe(true);
  });

  it("listApps returns release_requires_human_approval so the toggle/queue can read it", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    await seedHumanSession(sqlite, HUMAN);
    const res = await app().request("/api/apps", { method: "GET", headers: { authorization: `Bearer ${HUMAN}` } }, env, EXEC);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const app1 = body.apps.find((a: any) => a.id === "app1");
    expect(app1.release_requires_human_approval).toBe(1);
  });

  it("an agent-principal session (org admin) is still gated on publish", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relAS");
    await seedAgentAdminSession(sqlite, AGENT_SESSION);

    const res = await app().request(
      "/api/apps/app1/releases/relAS/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT_SESSION}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    // Not a human => held for approval, NOT published directly.
    expect(res.status).toBe(202);
    expect(releaseStatus(sqlite, "relAS")).toBe("draft");
  });

  it("an agent-principal session cannot approve or reject", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relAD");
    await seedAgentToken(sqlite, AGENT);
    await seedAgentAdminSession(sqlite, AGENT_SESSION);
    const a = app();

    const held = await a.request(
      "/api/apps/app1/releases/relAD/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    const { approval_request_id: reqId } = (await held.json()) as any;

    const approve = await a.request(
      `/api/apps/app1/release-approvals/${reqId}/approve`,
      { method: "POST", headers: { authorization: `Bearer ${AGENT_SESSION}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(approve.status).toBe(403);
    const reject = await a.request(
      `/api/apps/app1/release-approvals/${reqId}/reject`,
      { method: "POST", headers: { authorization: `Bearer ${AGENT_SESSION}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(reject.status).toBe(403);
    // Untouched: still pending, still draft.
    const row = sqlite.prepare("SELECT status FROM release_approval_requests WHERE id = ?").get(reqId) as any;
    expect(row.status).toBe("pending");
    expect(releaseStatus(sqlite, "relAD")).toBe("draft");
  });

  it("a deploy token cannot create an already-active release (gate bypass)", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    await seedAgentToken(sqlite, AGENT);

    const res = await app().request(
      "/api/apps/app1/releases",
      {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
        body: JSON.stringify({ build_id: "b-x", channel_id: "ch1", status: "active" }),
      },
      env,
      EXEC,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.code).toBe("AGENT_ACTIVE_RELEASE_FORBIDDEN");
    const count = sqlite.prepare("SELECT COUNT(*) n FROM releases").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("approve after the request was already rejected loses the claim (409, no publish)", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relC");
    await seedAgentToken(sqlite, AGENT);
    await seedHumanSession(sqlite, HUMAN);
    const a = app();

    const held = await a.request(
      "/api/apps/app1/releases/relC/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    const { approval_request_id: reqId } = (await held.json()) as any;
    await a.request(
      `/api/apps/app1/release-approvals/${reqId}/reject`,
      { method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    const approve = await a.request(
      `/api/apps/app1/release-approvals/${reqId}/approve`,
      { method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(approve.status).toBe(409);
    expect(releaseStatus(sqlite, "relC")).toBe("draft");
    const row = sqlite.prepare("SELECT status FROM release_approval_requests WHERE id = ?").get(reqId) as any;
    expect(row.status).toBe("rejected");
  });

  it("approve reverts to pending when the publish precondition no longer holds", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relV");
    await seedAgentToken(sqlite, AGENT);
    await seedHumanSession(sqlite, HUMAN);
    const a = app();

    const held = await a.request(
      "/api/apps/app1/releases/relV/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    const { approval_request_id: reqId } = (await held.json()) as any;
    // The release's revision moves after the request was captured, so the stored
    // expected_revision no longer matches at approve time.
    sqlite.exec(`UPDATE releases SET revision = 1 WHERE id = 'relV'`);

    const approve = await a.request(
      `/api/apps/app1/release-approvals/${reqId}/approve`,
      { method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(approve.status).toBe(409); // revision conflict surfaced to the approver
    expect(releaseStatus(sqlite, "relV")).toBe("draft"); // nothing activated
    const row = sqlite.prepare("SELECT status, decided_by FROM release_approval_requests WHERE id = ?").get(reqId) as any;
    expect(row.status).toBe("pending");
    expect(row.decided_by).toBeNull();
  });

  it("approve-then-reject is mutually exclusive: only {active+approved} or {draft+rejected}", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relM");
    await seedAgentToken(sqlite, AGENT);
    await seedHumanSession(sqlite, HUMAN);
    const a = app();

    const held = await a.request(
      "/api/apps/app1/releases/relM/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    const { approval_request_id: reqId } = (await held.json()) as any;

    // Approve wins first: {active + approved}.
    const approve = await a.request(
      `/api/apps/app1/release-approvals/${reqId}/approve`,
      { method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(approve.status).toBe(200);
    expect(releaseStatus(sqlite, "relM")).toBe("active");
    // A late reject cannot undo an approved+published decision.
    const reject = await a.request(
      `/api/apps/app1/release-approvals/${reqId}/reject`,
      { method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: "{}" },
      env,
      EXEC,
    );
    expect(reject.status).toBe(409);
    const row = sqlite.prepare("SELECT status FROM release_approval_requests WHERE id = ?").get(reqId) as any;
    expect(row.status).toBe("approved");
    expect(releaseStatus(sqlite, "relM")).toBe("active");
  });

  it("re-requesting the same external-target intent is idempotent (order-insensitive, same id)", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedExternalDraftRelease(sqlite, "relI");
    await seedAgentToken(sqlite, AGENT);
    const a = app();

    const first = await a.request(
      "/api/apps/app1/releases/relI/publish",
      {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
        body: JSON.stringify({ required_external_targets: ["darwin-arm64", "linux-x64"] }),
      },
      env,
      EXEC,
    );
    expect(first.status).toBe(202);
    const { approval_request_id: reqId } = (await first.json()) as any;

    // Same target set, different order → identical intent → reuse the request.
    const reorder = await a.request(
      "/api/apps/app1/releases/relI/publish",
      {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
        body: JSON.stringify({ required_external_targets: ["linux-x64", "darwin-arm64"] }),
      },
      env,
      EXEC,
    );
    expect(reorder.status).toBe(202);
    const second = (await reorder.json()) as any;
    expect(second.approval_request_id).toBe(reqId);
    expect(second.already_pending).toBe(true);
    const pending = sqlite.prepare(
      "SELECT COUNT(*) n FROM release_approval_requests WHERE release_id='relI' AND status='pending'",
    ).get() as { n: number };
    expect(pending.n).toBe(1);
  });

  it("a valid re-request under a drifted target contract conflicts and leaves the old pending untouched", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedExternalDraftRelease(sqlite, "relD");
    await seedAgentToken(sqlite, AGENT);
    const a = app();

    // First request persists the canonical 2-target set as its intent.
    const first = await a.request(
      "/api/apps/app1/releases/relD/publish",
      {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
        body: JSON.stringify({ required_external_targets: ["darwin-arm64", "linux-x64"] }),
      },
      env,
      EXEC,
    );
    expect(first.status).toBe(202);
    const { approval_request_id: reqId } = (await first.json()) as any;
    const before = sqlite
      .prepare("SELECT status, required_external_targets FROM release_approval_requests WHERE id = ?")
      .get(reqId) as any;

    // The declared contract drifts (a third target appears). A new request that
    // now matches the *new* contract is itself valid, but its intent differs from
    // the stored pending → 409, not a silent reuse of the stale request.
    sqlite.exec(`INSERT INTO external_build_targets
      (id, app_id, build_id, version_name, target, source_url, raw_sha256, raw_size_bytes, created_at, updated_at)
      VALUES ('t-relD-win','app1','b-relD','2.0.0','win32-x64','https://cdn.test/2.0.0/win32-x64','${"c".repeat(64)}',100,1,1)`);
    const conflict = await a.request(
      "/api/apps/app1/releases/relD/publish",
      {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
        body: JSON.stringify({ required_external_targets: ["darwin-arm64", "linux-x64", "win32-x64"] }),
      },
      env,
      EXEC,
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as any).code).toBe("PENDING_WITH_DIFFERENT_CONDITIONS");

    const after = sqlite
      .prepare("SELECT status, required_external_targets FROM release_approval_requests WHERE id = ?")
      .get(reqId) as any;
    expect(after.status).toBe("pending");
    expect(after.required_external_targets).toBe(before.required_external_targets);
    expect(releaseStatus(sqlite, "relD")).toBe("draft");
  });

  it("re-requesting identical conditions on an external build returns the existing pending request", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedExternalDraftRelease(sqlite, "relS");
    await seedAgentToken(sqlite, AGENT);
    const a = app();
    const body = JSON.stringify({ required_external_targets: ["darwin-arm64", "linux-x64"] });

    const first = (await (await a.request(
      "/api/apps/app1/releases/relS/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body },
      env,
      EXEC,
    )).json()) as any;
    const second = (await (await a.request(
      "/api/apps/app1/releases/relS/publish",
      { method: "POST", headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" }, body },
      env,
      EXEC,
    )).json()) as any;
    expect(second.approval_request_id).toBe(first.approval_request_id);
    expect(second.already_pending).toBe(true);
  });

  it("a non-external release carrying required_external_targets returns the original 400 and writes no pending", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedDraftRelease(sqlite, "relN"); // internal (android-apk), not external
    await seedAgentToken(sqlite, AGENT);
    const a = app();

    const res = await a.request(
      "/api/apps/app1/releases/relN/publish",
      {
        method: "POST",
        headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
        body: JSON.stringify({ required_external_targets: ["darwin-arm64"] }),
      },
      env,
      EXEC,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("required_external_targets only applies to external builds");
    const pending = sqlite.prepare(
      "SELECT COUNT(*) n FROM release_approval_requests WHERE release_id='relN'",
    ).get() as { n: number };
    expect(pending.n).toBe(0);
    expect(releaseStatus(sqlite, "relN")).toBe("draft");
  });

  it("a malformed required_external_targets shape returns the original 400 and writes no pending", async () => {
    const { sqlite, env } = environment();
    seedBase(sqlite, { gated: true });
    seedExternalDraftRelease(sqlite, "relB");
    await seedAgentToken(sqlite, AGENT);
    const a = app();

    for (const bad of [{ length: 1 }, "darwin-arm64", ["not a target"], [123]]) {
      const res = await a.request(
        "/api/apps/app1/releases/relB/publish",
        {
          method: "POST",
          headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
          body: JSON.stringify({ required_external_targets: bad }),
        },
        env,
        EXEC,
      );
      expect(res.status).toBe(400);
    }
    const pending = sqlite.prepare(
      "SELECT COUNT(*) n FROM release_approval_requests WHERE release_id='relB'",
    ).get() as { n: number };
    expect(pending.n).toBe(0);
    expect(releaseStatus(sqlite, "relB")).toBe("draft");
  });
});
