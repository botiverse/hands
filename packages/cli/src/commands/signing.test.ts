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
    if (path.endsWith("/signing-identities")) return { signing_identity: { id: "si-1", name: "Deck iOS", metadata: { subject: "CN=Apple Distribution" } } };
    state.polls += 1;
    return { job: { id: "job-1", status: "succeeded", output_sha256: state.outputSha, download_url: "https://r2.example/download" } };
  },
}));

import { Command } from "commander";
import { registerSigningCommands, signFile } from "./signing.js";

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

describe("hands signing identities upload-apple-ios", () => {
  it("sends the certificate with an API key copied from an app, or with uploaded profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hands-ios-id-"));
    const p12 = join(dir, "dist.p12");
    const profile = join(dir, "Deck.mobileprovision");
    writeFileSync(p12, "P12");
    writeFileSync(profile, "PROFILE");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const run = async (...args: string[]) => {
      const program = new Command();
      program.exitOverride();
      registerSigningCommands(program);
      await program.parseAsync(["node", "hands", "signing", "identities", "upload-apple-ios", "Deck iOS", p12, "--org", "org", ...args]);
    };
    await run("--asc-from-app", APP_ID);
    expect(state.calls.at(-1)).toMatchObject({
      path: "/api/orgs/org/signing-identities",
      body: { kind: "apple_ios_distribution", p12_b64: Buffer.from("P12").toString("base64"), asc: { from_app: APP_ID }, provisioning_profiles_b64: [] },
    });
    await run("--profile", profile);
    expect(state.calls.at(-1)!.body).toMatchObject({ asc: null, provisioning_profiles_b64: [Buffer.from("PROFILE").toString("base64")] });
    await expect(run("--asc-from-app", APP_ID, "--asc-key-id", "K")).rejects.toThrow(/not both/);
  });
});

describe("describeAppId", () => {
  it("states the plan, then what was done, with manual steps and unmapped keys", async () => {
    const { describeAppId } = await import("./signing.js");
    const plan = {
      bundle_id: "build.raft.deck",
      create_app_id: true,
      enable: [{ capability: "ASSOCIATED_DOMAINS", entitlements: ["com.apple.developer.associated-domains"] }],
      already_enabled: [],
      manual: [{ capability: "APP_GROUPS", entitlement: "com.apple.security.application-groups", values: ["group.build.raft.deck"], step: "assign them on the Apple Developer site" }],
      unknown_entitlements: ["com.example.private"],
    };
    expect(describeAppId({ plan, applied: null })).toEqual([
      "Would register App ID build.raft.deck; turn on ASSOCIATED_DOMAINS (com.apple.developer.associated-domains). Run again with --apply.",
      "Manual step for APP_GROUPS: assign them on the Apple Developer site: group.build.raft.deck.",
      "Not mapped to a capability (turn on by hand if signing refuses them): com.example.private.",
    ]);
    expect(describeAppId({ plan, applied: { created_app_id: true, enabled: ["ASSOCIATED_DOMAINS"], profiles_removed: [] } }).slice(0, 2)).toEqual([
      "Registered App ID build.raft.deck.",
      "Turned on: ASSOCIATED_DOMAINS.",
    ]);
  });
});
