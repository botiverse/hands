import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// Use the runtime and bundler pinned by this package's Wrangler dependency.
const require = createRequire(import.meta.url);
const wrangler = require.resolve("wrangler");
const { Miniflare } = require(require.resolve("miniflare", { paths: [wrangler] }));
const { build } = require(require.resolve("esbuild", { paths: [wrangler] }));

it("uses native Workers fetch for OAuth, edit creation, track listing and cleanup", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/native-fetch-worker.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  });
  const calls: string[] = [];
  const mf = new Miniflare({
    modules: true,
    // The pinned local workerd predates the production September compatibility date.
    compatibilityDate: "2026-06-25",
    script: bundle.outputFiles[0].text,
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.hostname === "oauth2.googleapis.com" && request.method === "POST") {
        return Response.json({ access_token: "fake-access-token", token_type: "Bearer" });
      }
      expect(url.hostname).toBe("androidpublisher.googleapis.com");
      expect(request.headers.get("authorization")).toBe("Bearer fake-access-token");
      if (request.method === "POST") return Response.json({ id: "test-edit" });
      if (request.method === "GET") return Response.json({ tracks: [{ track: "internal" }, { track: "production" }] });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("Unexpected outbound request");
    },
  });
  try {
    const response = await mf.dispatchFetch("https://test.invalid/");
    expect(await response.json()).toEqual({ ok: true, value: {
      client_email: "test@example.invalid", package_name: "build.test.app", tracks: ["internal", "production"],
    } });
    expect(calls).toEqual([
      "POST /token", "POST /androidpublisher/v3/applications/build.test.app/edits",
      "GET /androidpublisher/v3/applications/build.test.app/edits/test-edit/tracks",
      "DELETE /androidpublisher/v3/applications/build.test.app/edits/test-edit",
    ]);
  } finally { await mf.dispose(); }
}, 20_000);
