import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body: any }>, polls: 0, outputSha: "" }));
vi.mock("../lib/api.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api.js")>(),
  apiRequest: async (path: string, opts: { method?: string; body?: unknown } = {}) => {
    state.calls.push({ path, method: opts.method ?? "GET", body: opts.body });
    if (path.endsWith("/signing/jobs")) {
      return { job: { id: "job-1", status: "awaiting_upload" }, upload_url: "https://r2.example/upload", upload_headers: { "content-type": "application/octet-stream" } };
    }
    if (path.endsWith("/sign")) return { job: { id: "job-1", status: "signing" } };
    state.polls += 1;
    return { job: { id: "job-1", status: "succeeded", output_sha256: state.outputSha, download_url: "https://r2.example/download" } };
  },
}));

import { signFile } from "./signing.js";

afterEach(() => { vi.unstubAllGlobals(); state.calls.length = 0; state.polls = 0; });

const APP_ID = "11111111-2222-3333-4444-555555555555";

describe("hands sign", () => {
  it("uploads the file, waits for the job and replaces it only with a verified signed file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hands-sign-test-"));
    const apk = join(dir, "app.apk");
    writeFileSync(apk, "unsigned-bytes");
    const signed = Buffer.from("signed-bytes");
    state.outputSha = createHash("sha256").update(signed).digest("hex");
    const uploads: Buffer[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        uploads.push(Buffer.concat(chunks));
        return new Response("", { status: 200 });
      }
      return new Response(signed);
    }));
    await signFile({ app: APP_ID, file: apk, timeoutMs: 60_000, log: () => {} });
    expect(uploads[0]!.toString()).toBe("unsigned-bytes");
    expect(state.calls[0]).toMatchObject({ method: "POST", body: { artifact_type: "apk", filename: "app.apk", size: 14, sha256: createHash("sha256").update("unsigned-bytes").digest("hex") } });
    expect(readFileSync(apk, "utf8")).toBe("signed-bytes");

    // A download that does not match the job's SHA-256 never replaces the file.
    writeFileSync(apk, "unsigned-bytes");
    state.outputSha = "0".repeat(64);
    await expect(signFile({ app: APP_ID, file: apk, timeoutMs: 60_000, log: () => {} })).rejects.toThrow(/SHA-256/);
    expect(readFileSync(apk, "utf8")).toBe("unsigned-bytes");
  }, 30_000);

  it("refuses files it cannot classify", async () => {
    await expect(signFile({ app: APP_ID, file: "/tmp/x.bin", timeoutMs: 1000, log: () => {} })).rejects.toThrow(/--type/);
  });
});
