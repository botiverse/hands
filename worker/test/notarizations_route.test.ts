import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSubmission: vi.fn(),
  uploadArtifact: vi.fn(),
  getSubmission: vi.fn(),
  getLog: vi.fn(),
  getCredentials: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("../src/lib/notary_api", () => {
  class NotaryApiError extends Error {
    status: number;
    detail: string | null;

    constructor(status: number, message: string, detail: string | null = null) {
      super(message);
      this.status = status;
      this.detail = detail;
    }
  }
  return {
    NotaryApiError,
    createNotarySubmission: mocks.createSubmission,
    uploadNotaryArtifact: mocks.uploadArtifact,
    getNotarySubmission: mocks.getSubmission,
    getNotarySubmissionLog: mocks.getLog,
    isTerminalNotaryStatus: (status: string) =>
      ["Accepted", "Invalid", "Rejected"].includes(status),
    verifyNotaryArtifactBinding: (
      log: Record<string, unknown> | null,
      expected: string,
    ) => {
      const actual = typeof log?.sha256 === "string" ? log.sha256 : null;
      return actual === expected
        ? { verified: true, appleSha256: actual, error: null }
        : {
            verified: false,
            appleSha256: actual,
            error: log
              ? "Apple notarized SHA-256 does not match the submitted artifact"
              : "Apple developer log is not available yet",
          };
    },
  };
});

vi.mock("../src/lib/asc_credentials", () => ({
  getAscCredentials: mocks.getCredentials,
}));

vi.mock("../src/lib/permissions", () => ({
  insertAuditLog: mocks.insertAuditLog,
}));

import {
  handleCreateNotarization,
  handleGetNotarization,
} from "../src/routes/notarizations";

class D1StatementAdapter {
  private values: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  private parameters(): unknown[] | Record<string, unknown> {
    if (/\?\d+/.test(this.sql)) {
      return Object.fromEntries(
        this.values.map((value, index) => [String(index + 1), value]),
      );
    }
    return this.values;
  }

  async run() {
    const result = this.db.prepare(this.sql).run(this.parameters() as never);
    return { success: true, meta: { changes: result.changes } };
  }

  async first<T>() {
    return (this.db.prepare(this.sql).get(this.parameters() as never) as T) ?? null;
  }
}

function makeDb(): D1Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE apps (id TEXT PRIMARY KEY);
    CREATE TABLE operation_logs (
      id TEXT PRIMARY KEY, app_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
      parent_op_id TEXT, step_number INTEGER, actor TEXT NOT NULL,
      input TEXT NOT NULL, output TEXT NOT NULL, error TEXT, progress REAL NOT NULL,
      retry_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, completed_at INTEGER
    );
    INSERT INTO apps (id) VALUES ('app-1'), ('app-2');
  `);
  sqlite.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../migrations/sql/0045_app_notarizations.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  );
  return {
    prepare: (sql: string) => new D1StatementAdapter(sqlite, sql),
  } as unknown as D1Database;
}

function makeContext(args: {
  env: { DB: D1Database; APK_BUCKET: R2Bucket; ASC_CRED_ENC_KEY: string };
  appId: string;
  body?: Record<string, unknown>;
  notarizationId?: string;
}) {
  return {
    env: args.env,
    req: {
      param: (name: string) => {
        if (name === "appId") return args.appId;
        if (name === "notarizationId") return args.notarizationId ?? "";
        return "";
      },
      json: async () => args.body ?? {},
    },
    get: (name: string) => (name === "admin_actor" ? "deploy-token:ci" : null),
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as never;
}

describe("app-scoped notarization routes", () => {
  const sha256 = "a".repeat(64);
  const source = {
    r2_key: `apps/app-1/pending/${sha256}.dmg`,
    sha256,
    size_bytes: 3,
    submission_name: "Raft.dmg",
    idempotency_key: "hands-cli:stable",
  };
  let env: {
    DB: D1Database;
    APK_BUCKET: R2Bucket;
    ASC_CRED_ENC_KEY: string;
  };
  let pendingExists: boolean;

  beforeEach(() => {
    mocks.createSubmission.mockReset().mockResolvedValue({
      id: "apple-1",
      type: "submissions",
      attributes: {
        awsAccessKeyId: "temporary-access",
        awsSecretAccessKey: "temporary-secret",
        awsSessionToken: "temporary-session",
        bucket: "bucket",
        object: "object",
      },
    });
    mocks.uploadArtifact.mockReset().mockResolvedValue(undefined);
    mocks.getSubmission.mockReset().mockResolvedValue({
      id: "apple-1",
      type: "submissions",
      attributes: {
        name: "Raft.dmg",
        status: "Accepted",
        createdDate: "2026-07-16T00:00:00Z",
      },
    });
    mocks.getLog.mockReset().mockResolvedValue({
      status: "Accepted",
      sha256,
      issues: [],
    });
    mocks.getCredentials.mockReset().mockResolvedValue({
      key_id: "key",
      issuer_id: "issuer",
      p8: "private-key",
    });
    mocks.insertAuditLog.mockReset().mockResolvedValue(undefined);
    pendingExists = true;
    env = {
      DB: makeDb(),
      ASC_CRED_ENC_KEY: "encryption-key",
      APK_BUCKET: {
        get: vi.fn(async (key: string) =>
          pendingExists && key === source.r2_key
            ? {
                size: 3,
                body: new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.close();
                  },
                }),
              }
            : null,
        ),
        delete: vi.fn(async () => {
          pendingExists = false;
        }),
      } as unknown as R2Bucket,
    };
  });

  it("replays by idempotency key without re-creating Apple credentials or submissions", async () => {
    const first = await handleCreateNotarization(
      makeContext({ env, appId: "app-1", body: source }),
    );
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody).toMatchObject({
      submission_id: "apple-1",
      source_sha256: sha256,
      source_size_bytes: 3,
      replayed: false,
    });
    expect(JSON.stringify(firstBody)).not.toContain("temporary-");
    expect(JSON.stringify(firstBody)).not.toContain("private-key");

    const replay = await handleCreateNotarization(
      makeContext({ env, appId: "app-1", body: source }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      notarization_id: firstBody.notarization_id,
      submission_id: "apple-1",
      replayed: true,
    });
    expect(mocks.createSubmission).toHaveBeenCalledTimes(1);
    expect(mocks.uploadArtifact).toHaveBeenCalledTimes(1);
  });

  it("checks app ownership before polling Apple and requires log digest binding", async () => {
    const created = await handleCreateNotarization(
      makeContext({ env, appId: "app-1", body: source }),
    );
    const createdBody = (await created.json()) as { notarization_id: string };

    const crossApp = await handleGetNotarization(
      makeContext({
        env,
        appId: "app-2",
        notarizationId: createdBody.notarization_id,
      }),
    );
    expect(crossApp.status).toBe(404);
    expect(mocks.getSubmission).not.toHaveBeenCalled();

    const accepted = await handleGetNotarization(
      makeContext({
        env,
        appId: "app-1",
        notarizationId: createdBody.notarization_id,
      }),
    );
    expect(await accepted.json()).toMatchObject({
      status: "Accepted",
      source_sha256: sha256,
      source_size_bytes: 3,
      apple_sha256: sha256,
      binding_verified: true,
      ready_for_staple: true,
    });
  });
});
