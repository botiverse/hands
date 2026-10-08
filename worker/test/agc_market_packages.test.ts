import { afterEach, describe, expect, it, vi } from "vitest";
import { addAgcMarketPackage, addAgcTestPackage } from "../src/lib/agc_api";
import { handleGetAgcMarketPackage, handleUploadAgcMarketPackage } from "../src/routes/agc_market_packages";
vi.mock("../src/routes/agc_testing", () => ({ resolveAgcAuth: vi.fn(async () => ({ accessToken: "test" })) }));
afterEach(() => vi.unstubAllGlobals());

describe("formal package provider contract", () => {
  it("uses market mode 2 while invitations stay mode 1; neither submits review", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ret: { code: 0 }, pkgVersion: ["package-1"] })));
    await addAgcMarketPackage({ accessToken: "test" }, "app", "signed.app", "obj", fetcher);
    await addAgcTestPackage({ accessToken: "test" }, "app", "signed.app", "obj", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [index, mode] of [2, 1].entries()) {
      const [url, init] = fetcher.mock.calls[index] as unknown as [string, RequestInit];
      expect(url).toBe("https://connect-api.cloud.huawei.com/api/publish/v2/test/version/pkg?appId=app");
      expect(JSON.parse(init.body as string)).toEqual({ distributeMode: mode, file: { fileName: "signed.app", objectId: "obj" } });
    }
  });
});

function harness(row: Record<string, unknown> | null, asset = true) {
  const mutations: string[] = [];
  const db = { async batch(stmts: Array<{run(): Promise<unknown>}>) { return Promise.all(stmts.map(s => s.run())); }, prepare(sql: string) {
    let args: unknown[] = [];
    return { bind(...v: unknown[]) { args = v; return this; },
      async first() { return sql.includes("FROM agc_market_packages") ? row : asset ? { r2_key: "a", file_hash: "hash", size_bytes: 4 } : null; },
      async run() { mutations.push(sql);
        if (sql.includes("INSERT OR IGNORE")) row = { id: args[0], app_id: args[1], build_id: args[2], package_name: args[3], state: "uploading", updated_at: args[4] };
        if (row && sql.includes("SET external_app_id")) row.external_app_id = args[0];
        if (row && sql.includes("SET state='processing'")) { row.state = "processing"; row.external_package_id = args[0]; }
        if (row && sql.includes("SET state='failed'")) row.state = "failed"; if (row && sql.includes("SET state=?1")) { row.state = args[0]; row.error_message = args[1]; row.updated_at=args[2]; if(args[3]) row.external_package_id=args[3]; } return { meta: { changes: 1 } }; }
    };
  }};
  const c = { req: { param: (k: string) => k === "appId" ? "app" : "build", json: async () => ({ package_name: "build.raft.mobile" }) },
    env: { DB: db, APK_BUCKET: { get: async () => ({ size: 4, body: new Response("test").body }) } }, json: (data: unknown, status = 200) => ({ data, status }) };
  return { c: c as unknown as Parameters<typeof handleGetAgcMarketPackage>[0], mutations };
}

describe("formal package isolation and status", () => {
  it("reuses even a failed attempt rather than silently reuploading ambiguous provider writes", async () => {
    const row = { state: "failed", package_name: "build.raft.mobile" };
    const h = harness(row);
    expect(await handleUploadAgcMarketPackage(h.c)).toEqual({ data: { package: row }, status: 200 });
    expect(h.mutations).toEqual([]);
  });
  it("rejects a package identity change on the same build", async () => {
    const h = harness({ state: "ready", package_name: "other.app" });
    expect((await handleUploadAgcMarketPackage(h.c) as unknown as { status: number }).status).toBe(409);
  });
  it("rejects missing or cross-app signed assets before provider calls", async () => {
    const h = harness(null, false);
    expect((await handleUploadAgcMarketPackage(h.c) as unknown as { status: number }).status).toBe(404);
  });
  for (const [code, expected] of [[0, "ready"], [2, "failed"], [1, "processing"], [null, "processing"]]) {
    it(`compile ${code} maps to ${expected}, with no binding or review calls`, async () => {
      const row = { id: "p", state: "processing", external_app_id: "ha", external_package_id: "hp" };
      const h = harness(row);
      const f = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ret: { code: 0 }, pkgStateList: [{ successStatus: code }] })));
      vi.stubGlobal("fetch", f);
      await handleGetAgcMarketPackage(h.c);
      expect(row.state).toBe(expected);
      expect(f).toHaveBeenCalledTimes(1);
      expect(String(f.mock.calls[0]?.[0])).toContain("/package/compile/status?");
    });
  }
});


describe("formal package upload", () => {
  it("streams the stored asset then registers a market package, never a test version or review", async () => {
    vi.stubGlobal("FixedLengthStream", class extends TransformStream { constructor() { super(); } });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(url);
      const ok = (data: object) => new Response(JSON.stringify({ ret: { code: 0 }, ...data }));
      if (url.includes("appid-list")) return ok({ appids: [{ key: "build.raft.mobile", value: "ha" }] });
      if (url.includes("upload-url")) return ok({ urlInfo: { url: "https://obs.example/upload", objectId: "obj" } });
      if (url === "https://obs.example/upload") {
        expect(await new Response(init?.body).text()).toBe("test");
        return new Response();
      }
      expect(url).toContain("/test/version/pkg?");
      expect(JSON.parse(init?.body as string).distributeMode).toBe(2);
      return ok({ pkgVersion: ["hp"] });
    });
    const h = harness(null);
    // Audit reads actor fields through the Hono context.
    (h.c as any).get = () => null;
    const response = await handleUploadAgcMarketPackage(h.c) as any;
    expect(response.status).toBe(202);
    expect(response.data.package).toMatchObject({ state: "processing", external_package_id: "hp" });
    expect(calls).toHaveLength(4);
    await handleUploadAgcMarketPackage(h.c);
    expect(calls).toHaveLength(4);
  });
});
