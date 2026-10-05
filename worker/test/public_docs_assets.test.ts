import { describe, expect, it, vi } from "vitest";
import { publicDocStaticAssetPath } from "../src/lib/public_docs";
vi.mock("@cloudflare/containers", () => ({ Container: class {} }));
const { default: worker } = await import("../src/index");
const assets = new Map([
  ["/docs/assets/style.C7IDUjqQ.css", ["text/css", "body{color:red}"]],
  ["/docs/vp-icons.css", ["text/css", ".icon{}"]],
  ["/docs/assets/app.Bx-03Icx.js", ["application/javascript", "export default 1"]],
  ["/docs/assets/chunks/@localSearchIndex.en.js", ["application/javascript", "export default {}"]],
  ["/docs/assets/inter.woff2", ["font/woff2", "font bytes"]],
  ["/docs/hashmap.json", ["application/json", '{"guide":"hash"}']],
  ["/docs/guide.md", ["text/markdown", "# Guide"]],
  ["/docs/guide/", ["text/html", "<h1>Guide</h1>"]],
]);
function request(path: string) {
  const fetch = vi.fn(async (request: Request) => {
    const entry = assets.get(new URL(request.url).pathname);
    return new Response(entry?.[1] ?? "<html>admin SPA</html>", {
      headers: { "content-type": entry?.[0] ?? "text/html" },
    });
  });
  return { fetch, response: worker.fetch(new Request("https://hands.test" + path),
    { ASSETS: { fetch } } as unknown as Env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext) };
}
describe("public docs generated static assets through the real Worker", () => {
  it.each([...assets.entries()].slice(0, 6))("serves %s without article normalization or a Markdown probe", async (path, entry) => {
    const { fetch, response } = request(path);
    const result = await response;
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe(entry[0]);
    expect(await result.text()).toBe(entry[1]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(fetch.mock.calls[0]![0].url).pathname).toBe(path);
  });
  it.each(["/docs/assets/missing.css", "/docs/missing/", "/docs/missing.md"])("keeps missing %s as 404 instead of returning the SPA", async (path) => {
    expect((await request(path).response).status).toBe(404);
  });
  it("keeps article twin validation and HTML serving", async () => {
    const { fetch, response } = request("/docs/guide/");
    expect((await response).status).toBe(200);
    expect(fetch.mock.calls.map(([req]) => new URL(req.url).pathname)).toEqual(["/docs/guide.md", "/docs/guide/"]);
  });
  it.each(["/docs/assets/", "/docs/assets//file.css", "/docs/assets/../secret", "/docs/assets/./file.js", "/assets/file.css", "/docs/private.json"])("does not allow a static namespace escape: %s", (path) => {
    expect(publicDocStaticAssetPath(path)).toBeNull();
  });
});
