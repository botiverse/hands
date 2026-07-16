import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("../src/lib/asc_credentials", () => ({
  getAscCredentials: mocks.getCredentials,
}));

vi.mock("../src/lib/permissions", () => ({
  insertAuditLog: mocks.insertAuditLog,
}));

import {
  handleExportNotarizationCredentials,
  parseNotarizationCredentialExportInput,
} from "../src/routes/notarizations";

function makeContext(args: {
  appId?: string;
  body?: Record<string, unknown>;
  encKey?: string;
}) {
  return {
    env: {
      DB: {} as D1Database,
      ASC_CRED_ENC_KEY: args.encKey ?? "encryption-key",
    },
    req: {
      param: (name: string) => (name === "appId" ? args.appId ?? "app-1" : ""),
      json: async () => args.body ?? {},
    },
    get: (name: string) =>
      name === "admin_actor" ? "deploy-token:release-ci" : null,
    json: (body: unknown, status = 200, headers?: Record<string, string>) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  } as never;
}

describe("app-scoped notarization credential export", () => {
  const sha256 = "a".repeat(64);
  const input = {
    submission_name: "Raft-1.2.3-arm64.dmg",
    sha256,
    size_bytes: 1234,
  };

  beforeEach(() => {
    mocks.getCredentials.mockReset().mockResolvedValue({
      id: "credential-1",
      app_id: "app-1",
      key_id: "KEY123",
      issuer_id: "issuer-123",
      p8: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      created_by_actor: "admin",
      created_at: 1,
      updated_at: 2,
    });
    mocks.insertAuditLog.mockReset().mockResolvedValue(undefined);
  });

  it("validates the artifact tuple without accepting paths or malformed digests", () => {
    expect(parseNotarizationCredentialExportInput(input).input).toEqual({
      submissionName: input.submission_name,
      sha256,
      sizeBytes: input.size_bytes,
    });
    expect(
      parseNotarizationCredentialExportInput({
        ...input,
        submission_name: "../Raft.dmg",
      }).error,
    ).toMatch(/basename/);
    expect(
      parseNotarizationCredentialExportInput({ ...input, sha256: "nope" })
        .error,
    ).toMatch(/64 hexadecimal/);
    expect(
      parseNotarizationCredentialExportInput({ ...input, size_bytes: 0 }).error,
    ).toMatch(/positive safe integer/);
  });

  it("audits non-secret metadata before returning a non-cacheable key export", async () => {
    const response = await handleExportNotarizationCredentials(
      makeContext({ body: input }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      app_id: "app-1",
      submission_name: input.submission_name,
      source_sha256: sha256,
      source_size_bytes: 1234,
      credential_updated_at: 2,
      credentials: {
        kind: "app_store_connect_api_key",
        key_id: "KEY123",
        issuer_id: "issuer-123",
        p8: expect.stringContaining("BEGIN PRIVATE KEY"),
      },
    });
    expect(body.export_id).toEqual(expect.any(String));

    expect(mocks.insertAuditLog).toHaveBeenCalledTimes(1);
    const audit = mocks.insertAuditLog.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(audit).toMatchObject({
      app_id: "app-1",
      action: "notarization.credentials_export",
      payload: expect.objectContaining({
        credential_id: "credential-1",
        submission_name: input.submission_name,
        source_sha256: sha256,
        source_size_bytes: 1234,
      }),
    });
    expect(JSON.stringify(audit)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(audit)).not.toContain("secret");
  });

  it("fails closed before export when audit persistence fails", async () => {
    mocks.insertAuditLog.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(
      handleExportNotarizationCredentials(makeContext({ body: input })),
    ).rejects.toThrow("audit unavailable");
  });

  it("does not export when the app has no configured credential", async () => {
    mocks.getCredentials.mockResolvedValueOnce(null);
    const response = await handleExportNotarizationCredentials(
      makeContext({ body: input }),
    );
    expect(response.status).toBe(404);
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });
});
