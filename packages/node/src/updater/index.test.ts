import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_ATTESTATION_ALGORITHM,
  UPDATE_ATTESTATION_DOMAIN,
  UPDATE_ATTESTATION_SCHEMA_VERSION,
  canonicalizeUpdateAttestationPayload,
  updateAttestationKeyId,
  type UpdateArtifactAttestationPayload,
} from "./attestation.js";
import { HandsUpdateError, createHandsUpdater } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixture(bytes = Buffer.from("verified computer binary")) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const keyId = updateAttestationKeyId(spki);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const payload: UpdateArtifactAttestationPayload = {
    algorithm: UPDATE_ATTESTATION_ALGORITHM,
    appId: "app_1",
    artifact: { arch: "x64", id: "target_1", kind: "external_build_target", platform: "linux", sha256, sizeBytes: bytes.length, type: "sea" },
    buildId: "build_1",
    channelId: "channel_1",
    domain: UPDATE_ATTESTATION_DOMAIN,
    issuedAt: 1_787_460_000_000,
    keyId,
    productType: "cli-binary",
    releaseId: "release_1",
    releaseType: "stable",
    schemaVersion: UPDATE_ATTESTATION_SCHEMA_VERSION,
    sourceCommit: null,
    version: "1.0.19",
    versionCode: 1_000_019,
  };
  const canonical = Buffer.from(canonicalizeUpdateAttestationPayload(payload));
  const envelope = { algorithm: UPDATE_ATTESTATION_ALGORITHM, key_id: keyId, payload: canonical.toString("base64url"), schema_version: 1, signature: sign(null, canonical, privateKey).toString("base64url") };
  const response = {
    update_available: true,
    app: { id: payload.appId, slug: "raft-computer" },
    release: { id: payload.releaseId, revision: 7, channel: "main", channel_id: payload.channelId, version: payload.version, version_code: payload.versionCode, version_relation: "upgrade", published_at: 1_787_460_000_000 },
    artifact: { id: payload.artifact.id, platform: "linux", arch: "x64", size_bytes: bytes.length, sha256, download_url: "https://downloads.example/computer", attestation: envelope },
  };
  return { bytes, response, trustRoot: { [keyId]: spki.toString("base64url") } };
}

describe("Hands updater", () => {
  it("checks, verifies, and atomically stages an attested candidate", async () => {
    const { bytes, response, trustRoot } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      return url.startsWith("https://hands.example/")
        ? Response.json(response)
        : new Response(bytes, { status: 200 });
    });
    const updater = createHandsUpdater({ appSlug: "raft-computer", apiOrigin: "https://hands.example", trustRoot, fetch });
    const check = await updater.checkUpdate({ currentVersion: "1.0.18", channel: "alpha", target: { platform: "linux", arch: "x64" } });
    expect(check.kind).toBe("update");
    if (check.kind !== "update") return;
    const directory = await mkdtemp(join(tmpdir(), "hands-updater-")); directories.push(directory);
    const prepared = await updater.prepareUpdate({ candidate: check.candidate, stagingDir: directory });
    expect(await readFile(prepared.stagedBinaryPath)).toEqual(bytes);
    expect(prepared.stagedBinaryPath.endsWith(".ready")).toBe(true);
    expect(prepared.receipt.signature.verified).toBe(true);
    expect(await readdir(directory)).toEqual([expect.stringMatching(/\.ready$/u)]);
  });

  it("never forwards Hands authorization to the artifact origin", async () => {
    const { bytes, response, trustRoot } = fixture();
    const artifactHeaders: Headers[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).startsWith("https://hands.example/")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        return Response.json(response);
      }
      artifactHeaders.push(new Headers(init?.headers));
      return new Response(bytes);
    });
    const updater = createHandsUpdater({ appSlug: "raft-computer", apiOrigin: "https://hands.example", trustRoot, fetch, credentialProvider: () => "secret" });
    const check = await updater.checkUpdate({ currentVersion: "1.0.18", channel: "main", target: { platform: "linux", arch: "x64" } });
    if (check.kind !== "update") throw new Error("expected update");
    const directory = await mkdtemp(join(tmpdir(), "hands-updater-")); directories.push(directory);
    await updater.prepareUpdate({ candidate: check.candidate, stagingDir: directory });
    expect(artifactHeaders).toHaveLength(1);
    expect(artifactHeaders[0]?.has("authorization")).toBe(false);
  });

  it("fails closed and leaves no ready/partial file on hash mismatch", async () => {
    const { response, trustRoot } = fixture();
    const altered = Buffer.from(fixture().bytes); altered[0] ^= 1;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).startsWith("https://hands.example/") ? Response.json(response) : new Response(altered));
    const updater = createHandsUpdater({ appSlug: "raft-computer", apiOrigin: "https://hands.example", trustRoot, fetch });
    const check = await updater.checkUpdate({ currentVersion: "1.0.18", channel: "main", target: { platform: "linux", arch: "x64" } });
    if (check.kind !== "update") throw new Error("expected update");
    const directory = await mkdtemp(join(tmpdir(), "hands-updater-")); directories.push(directory);
    await expect(updater.prepareUpdate({ candidate: check.candidate, stagingDir: directory })).rejects.toEqual(expect.objectContaining<Partial<HandsUpdateError>>({ code: "UPDATE_SHA256_MISMATCH" }));
    expect(await readdir(directory)).toEqual([]);
  });
});
