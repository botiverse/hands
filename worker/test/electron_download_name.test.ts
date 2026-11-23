import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { downloadFileName, handleElectronGenericAsset } from "../src/routes/electron";

const BYTES = Uint8Array.from({ length: 64 }, (_, i) => i);

function makeApp(asset: { artifact_kind: string; filetype: string; r2_key: string }, extraEnv: Record<string, string> = {}) {
  const app = new Hono<{ Bindings: any }>();
  app.get("/electron/:slug/:channel/:file", handleElectronGenericAsset as any);
  const env = {
    DB: { prepare: (sql: string) => ({ bind: () => ({
      first: async () => (sql.includes("FROM apps") ? { id: "app-1" } : sql.includes("JOIN releases") ? { build_id: "build-1" } : null),
      all: async () => ({ results: [{ id: "a1", platform: "darwin", arch: "universal", variant: null, size_bytes: BYTES.length, metadata_json: "{}", ...asset }] }),
    }) }) },
    APK_BUCKET: { get: async () => ({ body: BYTES, httpEtag: '"etag-1"', writeHttpMetadata: () => undefined }) },
    ...extraEnv,
  };
  return (path: string) => app.request(path, {}, env as any);
}

describe("installer download file name", () => {
  it("puts a valid token before the extension and leaves everything else alone", () => {
    expect(downloadFileName("Raft-Desktop-1.36.0-universal.dmg", "k3x9a2pq")).toBe("Raft-Desktop-1.36.0-universal-k3x9a2pq.dmg");
    expect(downloadFileName("Raft-1.0.0.tar.gz", "abcd1234")).toBe("Raft-1.0.0-abcd1234.tar.gz");
    expect(downloadFileName("Raft.AppImage", "abcd1234")).toBe("Raft-abcd1234.AppImage");
    expect(downloadFileName("installer", "abcd1234")).toBe("installer-abcd1234");
    for (const bad of [undefined, "", "K3X9A2PQ", "k3x9a2p", "k3x9a2pq1", "k3x9-2pq", "../../x1", "k3x9a2pq\n"]) {
      expect(downloadFileName("Raft.dmg", bad)).toBe("Raft.dmg");
    }
  });

  it("names the dmg with the token on the real route, with the same bytes and etag", async () => {
    const get = makeApp({ artifact_kind: "installable", filetype: "dmg", r2_key: "electron/build/Raft-Desktop-1.36.0-universal.dmg" });
    const plain = await get("/electron/raft-desktop/main/Raft-Desktop-1.36.0-universal.dmg");
    const named = await get("/electron/raft-desktop/main/Raft-Desktop-1.36.0-universal.dmg?name=k3x9a2pq");
    const invalid = await get("/electron/raft-desktop/main/Raft-Desktop-1.36.0-universal.dmg?name=K3X9A2PQ");
    expect(plain.headers.get("content-disposition")).toBe(`attachment; filename="Raft-Desktop-1.36.0-universal.dmg"; filename*=UTF-8''Raft-Desktop-1.36.0-universal.dmg`);
    expect(named.headers.get("content-disposition")).toBe(`attachment; filename="Raft-Desktop-1.36.0-universal-k3x9a2pq.dmg"; filename*=UTF-8''Raft-Desktop-1.36.0-universal-k3x9a2pq.dmg`);
    expect(invalid.headers.get("content-disposition")).toBe(plain.headers.get("content-disposition"));
    for (const h of ["etag", "content-length", "content-type", "cache-control"]) expect(named.headers.get(h)).toBe(plain.headers.get(h));
    expect(new Uint8Array(await named.arrayBuffer())).toEqual(new Uint8Array(await plain.arrayBuffer()));
  });

  it("never renames update metadata, which electron-updater looks up by name", async () => {
    const get = makeApp({ artifact_kind: "electron-metadata", filetype: "yml", r2_key: "electron/build/latest-mac.yml" });
    const res = await get("/electron/raft-desktop/main/latest-mac.yml?name=k3x9a2pq");
    expect(res.headers.get("content-disposition")).toContain('filename="latest-mac.yml"');
  });

  const R2 = { R2_ACCOUNT_ID: "acct", R2_BUCKET_NAME: "hands-artifacts", R2_S3_ACCESS_KEY_ID: "AKIDEXAMPLE", R2_S3_SECRET_ACCESS_KEY: "secret-example" };

  it("sends installer downloads straight to R2 with the same file name, token included", async () => {
    const get = makeApp({ artifact_kind: "installable", filetype: "dmg", r2_key: "electron/build/Raft-Desktop-1.36.0-universal.dmg" }, R2);
    const res = await get("/electron/raft-desktop/main/Raft-Desktop-1.36.0-universal.dmg?name=k3x9a2pq");
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = new URL(res.headers.get("location")!);
    expect(location.host).toBe("acct.r2.cloudflarestorage.com");
    expect(location.pathname).toBe("/hands-artifacts/electron/build/Raft-Desktop-1.36.0-universal.dmg");
    expect(location.searchParams.get("response-content-disposition"))
      .toBe(`attachment; filename="Raft-Desktop-1.36.0-universal-k3x9a2pq.dmg"; filename*=UTF-8''Raft-Desktop-1.36.0-universal-k3x9a2pq.dmg`);
    expect(location.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps serving update metadata itself, and streams when R2 signing is not configured", async () => {
    const yml = await makeApp({ artifact_kind: "electron-metadata", filetype: "yml", r2_key: "electron/build/latest-mac.yml" }, R2)("/electron/raft-desktop/main/latest-mac.yml");
    expect(yml.status).toBe(200);
    const unsigned = await makeApp({ artifact_kind: "installable", filetype: "dmg", r2_key: "electron/build/Raft.dmg" })("/electron/raft-desktop/main/Raft.dmg");
    expect(unsigned.status).toBe(200);
  });
});
