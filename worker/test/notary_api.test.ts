import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({
  createAscJwt: vi.fn(),
  awsOptions: null as Record<string, unknown> | null,
  sign: vi.fn(),
}));

vi.mock("../src/lib/asc_api", () => ({
  createAscJwt: mocks.createAscJwt,
}));

vi.mock("aws4fetch", () => ({
  AwsClient: class {
    constructor(options: Record<string, unknown>) {
      mocks.awsOptions = options;
    }

    sign(url: URL, init: RequestInit & { aws?: { signQuery?: boolean } }) {
      return mocks.sign(url, init);
    }
  },
}));

import {
  createNotarySubmission,
  uploadNotaryArtifact,
  verifyNotaryArtifactBinding,
} from "../src/lib/notary_api";
import { parseCreateNotarizationInput } from "../src/routes/notarizations";

const credentials = {
  key_id: "key-id",
  issuer_id: "issuer-id",
  p8: "private-key-never-leaves-the-worker",
};

describe("Apple Notary API client", () => {
  beforeEach(() => {
    mocks.createAscJwt.mockReset().mockResolvedValue("jwt-value");
    mocks.sign.mockReset();
    mocks.awsOptions = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a submission with only name and SHA-256 in the Apple request", async () => {
    const response = {
      data: {
        id: "apple-submission",
        type: "submissions",
        attributes: {
          awsAccessKeyId: "temporary-access",
          awsSecretAccessKey: "temporary-secret",
          awsSessionToken: "temporary-session",
          bucket: "apple-bucket",
          object: "path/to/object",
        },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createNotarySubmission(credentials, {
      submissionName: "Raft.dmg",
      sha256: "a".repeat(64),
    });

    expect(result.id).toBe("apple-submission");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://appstoreconnect.apple.com/notary/v2/submissions",
    );
    expect(init.headers.authorization).toBe("Bearer jwt-value");
    expect(JSON.parse(init.body)).toEqual({
      submissionName: "Raft.dmg",
      sha256: "a".repeat(64),
    });
    expect(JSON.stringify(init)).not.toContain(credentials.p8);
  });

  it("query-signs and streams the exact object with temporary session credentials", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    mocks.sign.mockResolvedValue(
      new Request("https://signed-upload.example/object", { method: "PUT" }),
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadNotaryArtifact(
      {
        id: "apple-submission",
        type: "submissions",
        attributes: {
          awsAccessKeyId: "temporary-access",
          awsSecretAccessKey: "temporary-secret",
          awsSessionToken: "temporary-session",
          bucket: "apple-bucket",
          object: "path/to/object",
        },
      },
      { body, size: 3 },
    );

    expect(mocks.awsOptions).toMatchObject({
      accessKeyId: "temporary-access",
      secretAccessKey: "temporary-secret",
      sessionToken: "temporary-session",
      service: "s3",
      region: "us-west-2",
    });
    const [url, init] = mocks.sign.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://apple-bucket.s3-accelerate.amazonaws.com/path/to/object?X-Amz-Expires=3600",
    );
    expect(init.aws).toEqual({ signQuery: true });
    expect(init.headers).toEqual({ "content-length": "3" });
    expect(init.body).toBe(body);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://signed-upload.example/object" }),
    );
  });
});

describe("notarization artifact binding", () => {
  const sha256 = "a".repeat(64);

  it("requires Apple's terminal developer-log digest to match", () => {
    expect(verifyNotaryArtifactBinding({ sha256 }, sha256)).toEqual({
      verified: true,
      appleSha256: sha256,
      error: null,
    });
    expect(
      verifyNotaryArtifactBinding({ sha256: "b".repeat(64) }, sha256),
    ).toMatchObject({ verified: false, appleSha256: "b".repeat(64) });
    expect(verifyNotaryArtifactBinding(null, sha256)).toMatchObject({
      verified: false,
      appleSha256: null,
    });
  });

  it("accepts only an app-scoped hash-addressed pending object", () => {
    const valid = parseCreateNotarizationInput("app-1", {
      r2_key: `apps/app-1/pending/${sha256}.dmg`,
      sha256,
      size_bytes: 123,
      submission_name: "Raft.dmg",
      idempotency_key: "hands-cli:abc123",
    });
    expect(valid.error).toBeNull();
    expect(valid.input?.sizeBytes).toBe(123);

    const crossApp = parseCreateNotarizationInput("app-2", {
      r2_key: `apps/app-1/pending/${sha256}.dmg`,
      sha256,
      size_bytes: 123,
      submission_name: "Raft.dmg",
      idempotency_key: "hands-cli:abc123",
    });
    expect(crossApp.input).toBeNull();
    expect(crossApp.error).toContain("for this app");
  });
});

describe("app_notarizations migration", () => {
  it("enforces app-scoped idempotency and unique Apple submission ownership", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY);
      CREATE TABLE operation_logs (id TEXT PRIMARY KEY);
    `);
    const migrationPath = fileURLToPath(
      new URL("../../migrations/sql/0045_app_notarizations.sql", import.meta.url),
    );
    db.exec(readFileSync(migrationPath, "utf8"));
    db.prepare("INSERT INTO apps (id) VALUES (?), (?)").run("app-1", "app-2");
    const insert = db.prepare(
      `INSERT INTO app_notarizations
       (id, app_id, idempotency_key, apple_submission_id, submission_name,
        source_r2_key, source_sha256, source_size_bytes, status,
        created_by_actor, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Raft.dmg', ?, ?, 123, 'In Progress', 'ci', 1, 1)`,
    );
    const sha256 = "a".repeat(64);
    insert.run(
      "notary-1",
      "app-1",
      "retry-key",
      "apple-1",
      `apps/app-1/pending/${sha256}.dmg`,
      sha256,
    );

    expect(() =>
      insert.run(
        "notary-2",
        "app-1",
        "retry-key",
        "apple-2",
        `apps/app-1/pending/${sha256}.dmg`,
        sha256,
      ),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insert.run(
        "notary-3",
        "app-2",
        "other-key",
        "apple-1",
        `apps/app-2/pending/${sha256}.dmg`,
        sha256,
      ),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insert.run(
        "notary-4",
        "app-2",
        "retry-key",
        "apple-4",
        `apps/app-2/pending/${sha256}.dmg`,
        sha256,
      ),
    ).not.toThrow();
    db.close();
  });
});
