import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { handleTestflightUpload } from "../src/routes/testflight";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TestFlight upload route", () => {
  it("rejects a body bundle id that disagrees with immutable build metadata", async () => {
    let operationWrites = 0;
    const db = {
      prepare(sql: string) {
        if (sql.includes("INSERT INTO operation_logs")) operationWrites += 1;
        return {
          bind() {
            return this;
          },
          async all() {
            if (sql.includes("FROM builds")) {
              return {
                results: [
                  { id: "build-1", version_name: "1.0.0", version_code: 1000005 },
                ],
              };
            }
            return { results: [] };
          },
          async first() {
            if (
              sql.includes("artifact_kind = 'installable'") &&
              sql.includes("filetype = 'ipa'")
            ) {
              return {
                r2_key: "apps/app-1/builds/build-1/Raft.ipa",
                size_bytes: 48_256_623,
                file_hash: "a".repeat(64),
              };
            }
            if (sql.includes("artifact_kind = 'metadata-file'")) {
              return { r2_key: "apps/app-1/builds/build-1/build-metadata.json" };
            }
            return null;
          },
          async run() {
            return { success: true };
          },
        };
      },
    };
    const bucket = {
      async get(key: string) {
        if (key.endsWith("build-metadata.json")) {
          return {
            async json() {
              return { bundle_id: "build.raft.app" };
            },
          };
        }
        return null;
      },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const app = new Hono();
    app.post(
      "/api/apps/:appId/builds/:buildId/testflight-upload",
      handleTestflightUpload as any,
    );
    const response = await app.request(
      "/api/apps/app-1/builds/build-1/testflight-upload",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle_id: "other.example.app" }),
      },
      { DB: db, APK_BUCKET: bucket } as any,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "BUNDLE_ID_MISMATCH",
      metadata_bundle_id: "build.raft.app",
    });
    expect(operationWrites).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
