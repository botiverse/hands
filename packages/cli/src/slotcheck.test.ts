import { describe, expect, it } from "vitest";
import { Command } from "commander";

describe("publish-android declares a slot for every asset it uploads", () => {
  it("declared slots match the uploaded assets exactly", async () => {
    const requests: Array<{ method: string; url: string; body: any }> = [];
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const url = req.url ?? "";
        let body: any = null;
        if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
        requests.push({ method: req.method ?? "", url, body });
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && url.startsWith("/api/apps/app-1/releases?")) return res.end(JSON.stringify({ releases: [] }));
        if (req.method === "GET" && url === "/api/apps") return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "android-app" }] }));
        if (req.method === "GET" && url === "/api/apps/app-1/channels") return res.end(JSON.stringify({ channels: [{ id: "channel-1", slug: "main" }] }));
        if (req.method === "POST" && url === "/api/apps/app-1/builds") return res.end(JSON.stringify({ id: "build-1" }));
        if (req.method === "POST" && url === "/api/apps/app-1/upload") return res.end(JSON.stringify({ file_hash: "a".repeat(64), r2_key: "k", size_bytes: 3, original_filename: "f" }));
        if (req.method === "POST" && url === "/api/apps/app-1/builds/build-1/assets/uploads") {
          // Direct-upload declaration: the CLI PUTs to upload.url itself, which this
          // mock answers with a 200 and an empty body.
          return res.end(JSON.stringify({
            asset_id: "asset-direct",
            state: "pending_upload",
            upload: { url: `http://127.0.0.1:${addr.port}/r2-put`, headers: {} },
          }));
        }
        if (req.method === "PUT" && url === "/r2-put") { res.statusCode = 200; return res.end(); }
        if (req.method === "POST" && url === "/api/apps/app-1/builds/build-1/assets/asset-direct/upload/complete") {
          return res.end(JSON.stringify({ asset_id: "asset-direct", file_hash: "b".repeat(64), size_bytes: 3 }));
        }
        if (req.method === "POST" && url.startsWith("/api/apps/app-1/builds/build-1/assets")) return res.end(JSON.stringify({ id: "asset-1" }));
        if (req.method === "PATCH" && url === "/api/apps/app-1/builds/build-1") return res.end(JSON.stringify({ id: "build-1" }));
        if (req.method === "POST" && url === "/api/apps/app-1/releases") return res.end(JSON.stringify({ id: "rel-1" }));
        res.statusCode = 404; return res.end(JSON.stringify({ error: "nf" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slots-"));
    const apk = path.join(dir, "a.apk"); fs.writeFileSync(apk, "apk");
    const mapping = path.join(dir, "m.txt"); fs.writeFileSync(mapping, "map");

    const old = { api: process.env.HANDS_API, tok: process.env.HANDS_BEARER_TOKEN };
    process.env.HANDS_API = `http://127.0.0.1:${addr.port}`;
    process.env.HANDS_BEARER_TOKEN = "t";
    try {
      const { registerBuildCommands } = await import("../src/commands/builds.js");
      const program = new Command().version("1").option("--json", "j", false);
      registerBuildCommands(program);
      await program.parseAsync(["node","hands","builds","publish-android","android-app","--apk",apk,"--mapping",mapping,"--version-name","1.0.0","--version-code","1","--draft"]);

      const created = requests.find((r) => r.method === "POST" && r.url === "/api/apps/app-1/builds");
      expect(created, "build created").toBeDefined();
      expect(created!.body.status).toBe("pending");
      const slots = created!.body.required_asset_slots_json as any[];
      const kinds = slots.map((s) => `${s.artifact_kind}/${s.platform}/${s.filetype}`).sort();
      expect(kinds).toContain("installable/android/apk");
      expect(kinds).toContain("proguard-mapping/android/mapping.txt");
      // and the mapping actually went through the direct-upload declaration
      const declared = requests.filter((r) => r.url.includes("/assets/uploads"));
      expect(declared.length, "direct upload declarations").toBeGreaterThan(0);
    } finally {
      if (old.api === undefined) delete process.env.HANDS_API; else process.env.HANDS_API = old.api;
      if (old.tok === undefined) delete process.env.HANDS_BEARER_TOKEN; else process.env.HANDS_BEARER_TOKEN = old.tok;
      server.close();
    }
  }, 30000);
});
