import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandsUpdateError, createHandsUpdater } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixture(bytes = Buffer.from("verified computer binary")) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    response: {
      update_available: true,
      app: { id: "app_1", slug: "raft-computer" },
      release: { id: "release_1", revision: 7, channel: "main", channel_id: "channel_1", version: "1.0.19", version_code: 1_000_019, version_relation: "upgrade", published_at: 1_787_460_000_000 },
      artifact: { id: "target_1", platform: "linux", arch: "x64", size_bytes: bytes.length, sha256, download_url: "https://downloads.example/computer" },
    },
  };
}

describe("Hands updater", () => {
  it.each(["main", "alpha", "pinned:1.0.19"] as const)(
    "sends the exact device id for %s selection without changing channel semantics",
    async (channel) => {
      const { response } = fixture();
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const url = new URL(String(input));
        expect(new Headers(init?.headers).get("X-Hands-Device-Id")).toBe("machine-stable-1");
        expect(url.searchParams.get("channel")).toBe(channel.startsWith("pinned:") ? "main" : channel);
        expect(url.searchParams.get("version")).toBe(channel.startsWith("pinned:") ? "1.0.19" : null);
        return Response.json(response);
      });
      const updater = createHandsUpdater({ appSlug: "raft-computer", apiOrigin: "https://hands.example", fetch });
      await updater.checkUpdate({
        currentVersion: "1.0.18",
        channel,
        target: { platform: "linux", arch: "x64" },
        deviceId: "machine-stable-1",
      });
    },
  );

  it("omits the device header when deviceId is absent and rejects malformed ids before network", async () => {
    const { response } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).has("X-Hands-Device-Id")).toBe(false);
      return Response.json(response);
    });
    const updater = createHandsUpdater({ appSlug: "raft-computer", apiOrigin: "https://hands.example", fetch });
    const input = { currentVersion: "1.0.18", channel: "main" as const, target: { platform: "linux" as const, arch: "x64" } };
    await updater.checkUpdate(input);
    for (const deviceId of ["", " ", "contains space", "x".repeat(257)]) {
      await expect(updater.checkUpdate({ ...input, deviceId }))
        .rejects.toEqual(expect.objectContaining<Partial<HandsUpdateError>>({ code: "UPDATE_RESPONSE_INVALID" }));
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("checks and atomically stages a size/SHA-256 verified candidate", async () => {
    const { bytes, response } = fixture();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).startsWith("https://hands.example/") ? Response.json(response) : new Response(bytes));
    const updater = createHandsUpdater({ appSlug: "raft-computer", apiOrigin: "https://hands.example", fetch });
    const check = await updater.checkUpdate({ currentVersion: "1.0.18", channel: "main", target: { platform: "linux", arch: "x64" } });
    if (check.kind !== "update") throw new Error("expected update");
    const directory = await mkdtemp(join(tmpdir(), "hands-updater-")); directories.push(directory);
    const prepared = await updater.prepareUpdate({ candidate: check.candidate, stagingDir: directory });
    expect(await readFile(prepared.stagedBinaryPath)).toEqual(bytes);
    expect(prepared.stagedBinaryPath.endsWith(".ready")).toBe(true);
    expect(prepared.receipt.expectedSha256).toBe(prepared.receipt.actualSha256);
    expect(await readdir(directory)).toEqual([expect.stringMatching(/\.ready$/u)]);
  });

  it("never forwards Hands authorization to the artifact origin", async () => {
    const { bytes, response } = fixture();
    const artifactHeaders: Headers[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).startsWith("https://hands.example/")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        return Response.json(response);
      }
      artifactHeaders.push(new Headers(init?.headers));
      return new Response(bytes);
    });
    const updater = createHandsUpdater({ appSlug: "raft-computer", apiOrigin: "https://hands.example", fetch, credentialProvider: () => "secret" });
    const check = await updater.checkUpdate({ currentVersion: "1.0.18", channel: "main", target: { platform: "linux", arch: "x64" } });
    if (check.kind !== "update") throw new Error("expected update");
    const directory = await mkdtemp(join(tmpdir(), "hands-updater-")); directories.push(directory);
    await updater.prepareUpdate({ candidate: check.candidate, stagingDir: directory });
    expect(artifactHeaders).toHaveLength(1);
    expect(artifactHeaders[0]?.has("authorization")).toBe(false);
  });

  it("fails closed and leaves no file on size mismatch", async () => {
    const { response } = fixture();
    const altered = Buffer.from("altered computer binary");
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).startsWith("https://hands.example/") ? Response.json(response) : new Response(altered));
    const updater = createHandsUpdater({ appSlug: "raft-computer", apiOrigin: "https://hands.example", fetch });
    const check = await updater.checkUpdate({ currentVersion: "1.0.18", channel: "main", target: { platform: "linux", arch: "x64" } });
    if (check.kind !== "update") throw new Error("expected update");
    const directory = await mkdtemp(join(tmpdir(), "hands-updater-")); directories.push(directory);
    await expect(updater.prepareUpdate({ candidate: check.candidate, stagingDir: directory }))
      .rejects.toEqual(expect.objectContaining<Partial<HandsUpdateError>>({ code: "UPDATE_SIZE_MISMATCH" }));
    expect(await readdir(directory)).toEqual([]);
  });

  it("fails closed and leaves no file on SHA-256 mismatch", async () => {
    const { bytes, response } = fixture();
    const altered = Buffer.from(bytes);
    altered[0] ^= 1;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).startsWith("https://hands.example/") ? Response.json(response) : new Response(altered));
    const updater = createHandsUpdater({ appSlug: "raft-computer", apiOrigin: "https://hands.example", fetch });
    const check = await updater.checkUpdate({ currentVersion: "1.0.18", channel: "main", target: { platform: "linux", arch: "x64" } });
    if (check.kind !== "update") throw new Error("expected update");
    const directory = await mkdtemp(join(tmpdir(), "hands-updater-")); directories.push(directory);
    await expect(updater.prepareUpdate({ candidate: check.candidate, stagingDir: directory }))
      .rejects.toEqual(expect.objectContaining<Partial<HandsUpdateError>>({ code: "UPDATE_SHA256_MISMATCH" }));
    expect(await readdir(directory)).toEqual([]);
  });
});
