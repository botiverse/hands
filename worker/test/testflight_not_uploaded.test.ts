import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Only the credential store is stubbed: it needs real encrypted material at
// rest, which is not what these tests are about. The handler, the ASC HTTP
// calls and the upload-log query all run for real.
vi.mock("../src/lib/asc_credentials", () => ({
  getAscCredentials: vi.fn(async () => ({
    issuerId: "issuer-1",
    keyId: "key-1",
    privateKey: {} as CryptoKey,
  })),
}));
vi.mock("../src/lib/asc_api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/asc_api")>();
  return {
    ...actual,
    // The ASC app exists; the BUILD does not. That single "no build" reading is
    // exactly the ambiguity under test.
    resolveAscAppId: vi.fn(async () => "asc-app-1"),
    resolveAscBuild: vi.fn(async () => null),
  };
});

import { handleTestflightPublishStatus } from "../src/routes/testflight";

afterEach(() => {
  vi.unstubAllGlobals();
});

// App Store Connect returning NO build record covers two opposite situations:
// nobody ever uploaded, and the upload succeeded but Apple has not surfaced it.
// They need opposite actions (upload vs wait), so the status must not collapse
// them into one `waiting_for_processing`. These tests drive both arms through
// the real handler and differ ONLY in whether a succeeded upload operation row
// exists — nothing else in the fixture changes.
function makeDb(opts: { uploadSucceeded: boolean }) {
  let uploadLookups = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all() {
          if (sql.includes("FROM builds")) {
            return {
              results: [
                {
                  id: "build-1",
                  product_type: "ios-ipa",
                  version_name: "1.0.0",
                  version_code: 1000021,
                  build_metadata_json: JSON.stringify({ bundle_id: "build.raft.app" }),
                },
              ],
            };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes("kind = 'testflight-upload'")) {
            uploadLookups += 1;
            return opts.uploadSucceeded ? { id: "op-1" } : null;
          }
          return null;
        },
        async run() {
          return { success: true };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, uploads: () => uploadLookups };
}

async function statusFor(uploadSucceeded: boolean) {
  const { db, uploads } = makeDb({ uploadSucceeded });
  const app = new Hono();
  app.get("/api/apps/:appId/builds/:buildId/testflight-status", async (c) => {
    (c as any).env = { DB: db, ASC_CRED_ENC_KEY: "test-enc-key" };
    return handleTestflightPublishStatus(c as any);
  });
  const res = await app.request("/api/apps/app-1/builds/build-1/testflight-status");
  return { res, body: (await res.json()) as any, uploads: uploads() };
}

describe("TestFlight status when App Store Connect has no build record", () => {
  it("reports not_uploaded when no upload ever succeeded — waiting cannot fix it", async () => {
    const { body, uploads } = await statusFor(false);
    expect(uploads).toBeGreaterThan(0); // the decision consulted the upload log
    expect(body.state).toBe("not_uploaded");
    expect(body.state).not.toBe("waiting_for_processing");
    expect(String(body.detail)).toMatch(/never been uploaded/i);
  });

  it("reports waiting_for_processing only when an upload actually succeeded", async () => {
    const { body } = await statusFor(true);
    expect(body.state).toBe("waiting_for_processing");
  });
});
