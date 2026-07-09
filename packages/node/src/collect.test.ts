import { generateKeyPairSync, sign } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CollectionBudgetManager,
  CollectPolicyError,
  collectLogs,
  verifyCollectPolicy,
} from "./collect.js";
import {
  HANDS_LOG_SCHEMA_VERSION,
  HANDS_LOG_SIGNATURE_ALGORITHM,
  canonicalize,
  validateCollectPolicy,
  validateLogBundle,
  validateRedactionContract,
  type CollectPolicyPayload,
  type SignedCollectPolicy,
} from "./logs/schema.js";
import { DEFAULT_REDACTION_CONTRACT } from "./redaction.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "hands-node-collect-"));
  cleanup.push(path);
  return path;
}

function fixture(
  overrides: Partial<CollectPolicyPayload> = {},
): { policy: SignedCollectPolicy; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload: CollectPolicyPayload = {
    schema_version: HANDS_LOG_SCHEMA_VERSION,
    policy_id: "policy-1",
    revision: 2,
    key_id: "test-key",
    issued_at: "2026-07-10T00:00:00.000Z",
    expires_at: "2026-07-11T00:00:00.000Z",
    budgets: {
      max_collection_bytes: 64 * 1024,
      max_daily_bytes: 128 * 1024,
      max_concurrency: 1,
      weak_network_backoff_ms: 10_000,
    },
    ...overrides,
  };
  const signature = sign(null, Buffer.from(canonicalize(payload)), privateKey).toString("base64url");
  return {
    policy: {
      signature_algorithm: HANDS_LOG_SIGNATURE_ALGORITHM,
      signature,
      payload,
    },
    publicKey,
  };
}

describe("logs/schema", () => {
  it("validates policy and redaction contracts", () => {
    const { policy } = fixture();
    expect(validateCollectPolicy(policy)).toEqual({ valid: true, errors: [] });
    expect(validateRedactionContract(DEFAULT_REDACTION_CONTRACT)).toEqual({
      valid: true,
      errors: [],
    });
  });
});

describe("signed collect policy", () => {
  it("accepts a valid Ed25519 policy", () => {
    const { policy, publicKey } = fixture();
    expect(
      verifyCollectPolicy(policy, {
        publicKeys: { "test-key": publicKey },
        now: new Date("2026-07-10T01:00:00.000Z"),
      }).revision,
    ).toBe(2);
  });

  it("fails closed for expired and bad-signature policies", () => {
    const expired = fixture({
      issued_at: "2026-07-08T00:00:00.000Z",
      expires_at: "2026-07-09T00:00:00.000Z",
    });
    expect(() =>
      verifyCollectPolicy(expired.policy, {
        publicKeys: { "test-key": expired.publicKey },
        now: new Date("2026-07-10T01:00:00.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_EXPIRED" }));

    const bad = fixture();
    bad.policy.signature = Buffer.from("not-the-signature").toString("base64url");
    expect(() =>
      verifyCollectPolicy(bad.policy, {
        publicKeys: { "test-key": bad.publicKey },
        now: new Date("2026-07-10T01:00:00.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "POLICY_SIGNATURE_INVALID" }));
  });

  it("rejects policy downgrades and enforces concurrency/network budgets", () => {
    const dir = temporaryDirectory();
    const manager = new CollectionBudgetManager(join(dir, "state.json"), () =>
      new Date("2026-07-10T01:00:00.000Z"),
    );
    const current = fixture().policy.payload;
    manager.acceptRevision(current);
    expect(() => manager.acceptRevision({ ...current, revision: 1 })).toThrowError(
      expect.objectContaining({ code: "POLICY_DOWNGRADE_REJECTED" }),
    );
    const lease = manager.acquire(current, "strong");
    expect(() => manager.acquire(current, "strong")).toThrowError(
      expect.objectContaining({ code: "COLLECTION_CONCURRENCY_EXCEEDED" }),
    );
    lease.release();
    expect(() => manager.acquire(current, "weak")).toThrowError(
      expect.objectContaining({ code: "WEAK_NETWORK_BACKOFF" }),
    );
  });

  it("enforces the persistent daily byte budget", () => {
    const dir = temporaryDirectory();
    const manager = new CollectionBudgetManager(join(dir, "state.json"), () =>
      new Date("2026-07-10T01:00:00.000Z"),
    );
    const payload = fixture({
      budgets: {
        max_collection_bytes: 100,
        max_daily_bytes: 100,
        max_concurrency: 1,
        weak_network_backoff_ms: 0,
      },
    }).policy.payload;
    manager.acceptRevision(payload);
    const first = manager.acquire(payload, "strong");
    first.commit(90);
    first.release();
    const second = manager.acquire(payload, "strong");
    expect(() => second.commit(20)).toThrowError(
      expect.objectContaining({ code: "DAILY_BUDGET_EXCEEDED" }),
    );
    second.release();
  });
});

describe("collectLogs", () => {
  it("re-redacts secrets, validates the bundle, and writes gzip output", () => {
    const dir = temporaryDirectory();
    const log = join(dir, "hands-cli.jsonl");
    writeFileSync(
      log,
      `${JSON.stringify({
        ts: "2026-07-10T01:00:00.000Z",
        level: "info",
        event: "request",
        tag: "http",
        message: "Bearer raw-access-token",
        fields: { cookie: "session-secret", safe: "kept" },
        seq: 1,
        dropped: 0,
        truncated: false,
      })}\n`,
    );
    const output = join(dir, "bundle.json.gz");
    const signed = fixture();
    const result = collectLogs({
      policy: signed.policy,
      publicKeys: { "test-key": signed.publicKey },
      files: [log],
      outputFile: output,
      stateFile: join(dir, "state.json"),
      source: "hands-cli",
      now: new Date("2026-07-10T01:30:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(validateLogBundle(result.bundle)).toEqual({ valid: true, errors: [] });
    const unpacked = JSON.parse(gunzipSync(readFileSync(output)).toString("utf8")) as {
      files: Array<{ content_base64: string }>;
    };
    const collectedLog = Buffer.from(unpacked.files[0]!.content_base64, "base64").toString("utf8");
    expect(collectedLog).not.toContain("raw-access-token");
    expect(collectedLog).not.toContain("session-secret");
    expect(collectedLog).toContain("[REDACTED]");
    expect(collectedLog).toContain("kept");
  });

  it("returns a failure and audit event instead of throwing", () => {
    const dir = temporaryDirectory();
    const signed = fixture({
      issued_at: "2026-07-08T00:00:00.000Z",
      expires_at: "2026-07-09T00:00:00.000Z",
    });
    const audit: string[] = [];
    const invoke = () =>
      collectLogs({
        policy: signed.policy,
        publicKeys: { "test-key": signed.publicKey },
        files: [],
        outputFile: join(dir, "bundle.json.gz"),
        stateFile: join(dir, "state.json"),
        now: new Date("2026-07-10T01:30:00.000Z"),
        audit: (event) => audit.push(event.code),
      });

    expect(invoke).not.toThrow();
    expect(invoke()).toEqual(
      expect.objectContaining({ ok: false, code: "POLICY_EXPIRED" }),
    );
    expect(audit).toContain("POLICY_EXPIRED");
  });

  it("enforces the per-collection byte budget without throwing", () => {
    const dir = temporaryDirectory();
    const log = join(dir, "large.jsonl");
    writeFileSync(
      log,
      `${JSON.stringify({
        ts: "2026-07-10T01:00:00.000Z",
        level: "info",
        event: "large",
        tag: "test",
        message: "x".repeat(512),
      })}\n`,
    );
    const signed = fixture({
      budgets: {
        max_collection_bytes: 100,
        max_daily_bytes: 1000,
        max_concurrency: 1,
        weak_network_backoff_ms: 0,
      },
    });
    const result = collectLogs({
      policy: signed.policy,
      publicKeys: { "test-key": signed.publicKey },
      files: [log],
      outputFile: join(dir, "bundle.json.gz"),
      stateFile: join(dir, "state.json"),
      now: new Date("2026-07-10T01:30:00.000Z"),
    });
    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "COLLECTION_BUDGET_EXCEEDED" }),
    );
  });
});

describe("CollectPolicyError", () => {
  it("carries a stable machine code", () => {
    expect(new CollectPolicyError("TEST", "message")).toEqual(
      expect.objectContaining({ name: "CollectPolicyError", code: "TEST" }),
    );
  });
});
