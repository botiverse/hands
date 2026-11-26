import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

// The readback handlers run for real against the migration chain; only the
// credential store and the App Store Connect reads are stubbed, with the
// external state each test needs.
const asc = vi.hoisted(() => ({
  externalBuildState: "IN_BETA_TESTING" as string,
  expired: false,
}));
vi.mock("../src/lib/asc_credentials", () => ({
  getAscCredentials: vi.fn(async () => ({ key_id: "k", issuer_id: "i", p8: "unused" })),
}));
vi.mock("../src/lib/asc_api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/asc_api")>();
  return {
    ...actual,
    resolveAscAppId: vi.fn(async () => "asc-app-1"),
    resolveAscBuild: vi.fn(async () => ({
      id: "asc-build-1",
      attributes: {
        version: "13000003",
        uploadedDate: "2026-11-01T00:00:00Z",
        expirationDate: "2027-01-30T00:00:00Z",
        expired: asc.expired,
        processingState: "VALID",
        buildAudienceType: "APP_STORE_ELIGIBLE",
      },
    })),
    listBetaGroups: vi.fn(async () => [
      { id: "external-1", attributes: { name: "External", isInternalGroup: false, hasAccessToAllBuilds: false } },
    ]),
    upsertBetaBuildLocalizations: vi.fn(async () => undefined),
    addBuildToBetaGroups: vi.fn(async () => undefined),
    getAssignedBetaGroupIds: vi.fn(async () => []),
    getBetaBuildLocalizations: vi.fn(async () => []),
    getBetaAppReviewSubmission: vi.fn(async () => null),
    getBuildBetaDetail: vi.fn(async () => ({
      id: "detail-1",
      attributes: {
        autoNotifyEnabled: true,
        internalBuildState: "IN_BETA_TESTING",
        externalBuildState: asc.externalBuildState,
      },
    })),
  };
});

import { handleTestflightPublish, handleTestflightPublishStatus } from "../src/routes/testflight";

function setup() {
  const sql = new Database(":memory:");
  const directory = new URL("../../migrations/sql/", import.meta.url);
  for (const file of readdirSync(directory).sort())
    if (file.endsWith(".sql")) sql.exec(readFileSync(new URL(file, directory), "utf8"));
  sql.exec(`INSERT INTO apps(id,slug,name,platform,created_at) VALUES('app','raft-ios','Raft iOS','ios',0);
    INSERT INTO builds(id,app_id,version_name,version_code,product_type,build_metadata_json,created_at,updated_at)
      VALUES('build-1','app','1.31.0',13000003,'ios-ipa','{"bundle_id":"build.raft.app"}',0,0);`);
  const prepare = (query: string) => {
    const indexes: number[] = [];
    let highest = 0;
    const stmt = sql.prepare(query.replace(/\?(\d*)/g, (_, n: string) => {
      const index = n ? Number(n) : highest + 1;
      highest = Math.max(highest, index);
      indexes.push(index);
      return "?";
    }));
    const bind = (...args: unknown[]) => {
      const values = indexes.map((n) => args[n - 1]);
      return {
        execute: () => ({ meta: { changes: stmt.run(...values).changes }, success: true }),
        run: async () => ({ meta: { changes: stmt.run(...values).changes }, success: true }),
        first: async () => (stmt.reader ? stmt.get(...values) ?? null : null),
        all: async () => ({ results: stmt.all(...values) }),
      };
    };
    return { bind, ...bind() };
  };
  const db = {
    prepare,
    batch: async (stmts: Array<{ execute: () => unknown }>) => sql.transaction(() => stmts.map((st) => st.execute()))(),
  } as unknown as D1Database;
  const app = new Hono<any>();
  app.get("/api/apps/:appId/builds/:buildId/testflight-publish", handleTestflightPublishStatus as any);
  app.post("/api/apps/:appId/builds/:buildId/testflight-publish", handleTestflightPublish as any);
  const publish = async () => {
    const res = await app.request(
      "/api/apps/app/builds/build-1/testflight-publish",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          distribution: "external",
          group_ids: ["external-1"],
          what_to_test: { "en-US": "Check the update prompt." },
        }),
      },
      { DB: db, ASC_CRED_ENC_KEY: "k" } as any,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const status = async () => {
    const res = await app.request(
      "/api/apps/app/builds/build-1/testflight-publish?distribution=external",
      {},
      { DB: db, ASC_CRED_ENC_KEY: "k" } as any,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const stored = () => sql.prepare("SELECT * FROM testflight_latest_builds WHERE app_id='app'").get() as any;
  return { sql, status, publish, stored };
}

afterEach(() => {
  asc.externalBuildState = "IN_BETA_TESTING";
  asc.expired = false;
});

describe("testflight-publish status readback feeds the latest external build", () => {
  it("records a build read back as IN_BETA_TESTING", async () => {
    const { status, stored } = setup();
    const { status: code, body } = await status();
    expect(code).toBe(200);
    expect(body.beta_detail.external_build_state).toBe("IN_BETA_TESTING");
    expect(stored()).toMatchObject({
      version_name: "1.31.0",
      version_code: 13000003,
      asc_build_id: "asc-build-1",
      external_build_state: "IN_BETA_TESTING",
    });
  });

  it("clears the stored build when the same build reads back in another state", async () => {
    const { status, stored } = setup();
    await status();
    asc.externalBuildState = "BETA_APPROVED";
    await status();
    expect(stored()).toBeUndefined();
  });

  it("clears the stored build when the same build reads back expired", async () => {
    const { status, stored } = setup();
    await status();
    asc.expired = true;
    const { body } = await status();
    expect(body.expired).toBe(true);
    expect(stored()).toBeUndefined();
  });

  it("still answers the status when the record cannot be written", async () => {
    const { sql, status } = setup();
    sql.exec("DROP TABLE testflight_latest_builds");
    const { status: code, body } = await status();
    expect(code).toBe(200);
    expect(body.state).toBe("testing");
  });
});

describe("testflight-publish result feeds the latest external build", () => {
  it("records the build when the publish readback says IN_BETA_TESTING", async () => {
    const { publish, stored } = setup();
    const { status: code, body } = await publish();
    expect(code).toBe(200);
    expect(body.beta_detail.external_build_state).toBe("IN_BETA_TESTING");
    expect(stored()).toMatchObject({ asc_build_id: "asc-build-1", version_code: 13000003 });
  });

  it("clears the stored build when the publish readback says it is no longer in testing", async () => {
    const { publish, stored } = setup();
    await publish();
    expect(stored()).toBeDefined();
    asc.externalBuildState = "BETA_APPROVED";
    const { status: code } = await publish();
    expect(code).toBe(200);
    expect(stored()).toBeUndefined();
  });
});
