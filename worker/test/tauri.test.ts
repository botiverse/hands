import { describe, expect, it } from "vitest";
import { compareSemver, handleTauriArtifact, handleTauriUpdate } from "../src/routes/tauri";

const release = { build_id: "build", version_name: "1.2.3", changelog: "Changes", created_at: 1_700_000_000_000 };
type TestAsset = {
  platform: string; arch: string; variant: string; filetype: string;
  r2_key: string; size_bytes: number; signature: string | null; metadata_json: string;
};

const asset: TestAsset = {
  platform: "darwin", arch: "aarch64", variant: "App.app.tar.gz", filetype: "tar.gz",
  r2_key: "apps/app/App.app.tar.gz", size_bytes: 7, signature: "signed-value",
  metadata_json: JSON.stringify({ filename: "App.app.tar.gz" }),
};

function env(options: { release?: typeof release | null; asset?: TestAsset | null } = {}) {
  const selectedRelease = options.release === undefined ? release : options.release;
  const selectedAsset = options.asset === undefined ? asset : options.asset;
  return {
    DB: {
      prepare(sql: string) {
        let bindings: unknown[] = [];
        return {
          bind(...values: unknown[]) { bindings = values; return this; },
          async first() {
            if (sql.includes("SELECT b.id AS build_id")) return selectedRelease;
            if (sql.includes("artifact_kind = 'tauri-updater'")) {
              return bindings[1] === selectedAsset?.platform && bindings[2] === selectedAsset?.arch ? selectedAsset : null;
            }
            return null;
          },
          async all() { return { results: selectedAsset ? [selectedAsset] : [] }; },
        };
      },
    },
    APK_BUCKET: {
      async get(key: string) {
        if (key !== selectedAsset?.r2_key) return null;
        return {
          body: new Blob(["payload"]).stream(), httpEtag: '"etag"',
          writeHttpMetadata(headers: Headers) { headers.set("x-test", "1"); },
        };
      },
    },
  };
}

function context(params: Record<string, string>, bindings = env()) {
  return {
    env: bindings,
    req: { param: (name: string) => params[name], url: "https://hands.build/request" },
    json(body: unknown, status = 200, headers?: HeadersInit) {
      return Response.json(body, headers ? { status, headers } : { status });
    },
  } as any;
}

describe("Tauri updater", () => {
  it("returns a signed dynamic update response for a newer compatible release", async () => {
    const response = await handleTauriUpdate(context({ slug: "app", channel: "main", target: "darwin", arch: "aarch64", currentVersion: "1.2.2" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: "1.2.3", signature: "signed-value",
      url: "https://hands.build/tauri/app/main/artifacts/darwin/aarch64/App.app.tar.gz",
    });
  });

  it.each(["1.2.3", "1.3.0"])("returns 204 when current version %s is not older", async (currentVersion) => {
    const response = await handleTauriUpdate(context({ slug: "app", channel: "main", target: "darwin", arch: "aarch64", currentVersion }));
    expect(response.status).toBe(204);
  });

  it("rejects an invalid current semantic version", async () => {
    const response = await handleTauriUpdate(context({ slug: "app", channel: "main", target: "darwin", arch: "aarch64", currentVersion: "latest" }));
    expect(response.status).toBe(400);
  });

  it("fails closed when the target artifact has no signature", async () => {
    const response = await handleTauriUpdate(context(
      { slug: "app", channel: "main", target: "darwin", arch: "aarch64", currentVersion: "1.0.0" },
      env({ asset: { ...asset, signature: null } }),
    ));
    expect(response.status).toBe(404);
  });

  it("serves only an artifact attached to the active Tauri release", async () => {
    const response = await handleTauriArtifact(context({ slug: "app", channel: "main", target: "darwin", arch: "aarch64", file: "App.app.tar.gz" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe("payload");
  });

  it("implements SemVer prerelease precedence", () => {
    expect(compareSemver("1.2.3", "1.2.3-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3-rc.2", "1.2.3-rc.10")).toBeLessThan(0);
  });
});
