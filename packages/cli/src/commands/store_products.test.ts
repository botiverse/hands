import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Call = { method: string; path: string; body?: any };
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return { ...actual, apiRequest: async (path: string, opts: any = {}) => {
    const state = globalThis as any, call = { method: opts.method ?? "GET", path, body: opts.body };
    state.__calls.push(call); return state.__reply(call);
  } };
});
const google = { google: { products: [
  { productId: "example.basic", listings: [{ languageCode: "en-US", title: "Basic" }], basePlans: [{ basePlanId: "monthly", billingPeriodDuration: "P1M" }] },
  { productId: "example.pro", listings: [{ languageCode: "en-US", title: "Pro" }], basePlans: [{ basePlanId: "monthly", billingPeriodDuration: "P1M" }] },
] } };
async function run(config: unknown, args: string[], reply?: (call: Call) => unknown) {
  const dir = await mkdtemp(join(tmpdir(), "hands-products-")), file = join(dir, "products.json");
  await writeFile(file, JSON.stringify(config));
  const calls: Call[] = [], output: string[] = [];
  (globalThis as any).__calls = calls;
  (globalThis as any).__reply = reply ?? ((call: Call) => call.path === "/api/apps" ? { apps: [{ id: "app1", slug: "android", platform: "android" }] }
    : { product_id: call.body.product.productId, mode: call.body.mode, outcome: call.body.mode === "commit" ? "committed" : "planned", changes: [] });
  vi.spyOn(console, "log").mockImplementation(x => output.push(String(x)));
  const { registerStoreProductsCommands } = await import("./store_products.js");
  const program = new Command(); program.exitOverride(); program.option("--json", "", false); registerStoreProductsCommands(program);
  await program.parseAsync(["node", "hands", "store-products", "apply", "android", "--file", file, ...args]);
  return { calls, output };
}
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });
describe("store-products CLI", () => {
  it("defaults to preview for every product", async () => {
    const { calls } = await run(google, []);
    expect(calls.map(c => c.method)).toEqual(["GET", "POST", "POST"]);
    expect(calls.slice(1).map(c => c.body.mode)).toEqual(["dry_run", "dry_run"]);
  });
  it("previews all products before committing any", async () => {
    const { calls } = await run(google, ["--commit"]);
    expect(calls.slice(1).map(c => [c.body.product.productId, c.body.mode])).toEqual([
      ["example.basic", "dry_run"], ["example.pro", "dry_run"], ["example.basic", "commit"], ["example.pro", "commit"]]);
  });
  it("stops before any commit if preview fails", async () => {
    const { QuiverApiError } = await import("../lib/api.js");
    const { calls, output } = await run(google, ["--commit", "--json"], c => {
      if (c.path === "/api/apps") return { apps: [{ id: "app1", slug: "android", platform: "android" }] };
      if (c.body.product.productId === "example.pro") throw new QuiverApiError(409, { code: "mismatch" }, "mismatch");
      return { product_id: "example.basic", mode: "dry_run", outcome: "planned", changes: [] };
    });
    expect(calls.slice(1).every(c => c.body.mode === "dry_run")).toBe(true);
    expect(JSON.parse(output.join("\n"))).toMatchObject({ stopped: true }); expect(process.exitCode).toBe(1);
  });
  it("shows every unverified preview but sends no commit requests", async () => {
    const { calls, output } = await run(google, ["--commit", "--json"], c => c.path === "/api/apps" ? { apps: [{ id: "app1", slug: "android", platform: "android" }] }
      : { product_id: c.body.product.productId, mode: c.body.mode, outcome: "pending", changes: [{ resource: "catalog", action: "deferred", after: "assumed_empty_unverified" }] });
    expect(calls.slice(1).map(c => c.body.mode)).toEqual(["dry_run", "dry_run"]);
    expect(JSON.parse(output.join("\n"))).toMatchObject({ stopped: true, pending: true, preview: [{ outcome: "pending" }, { outcome: "pending" }] });
    expect(process.exitCode).toBe(1);
  });
  it("marks an unverified dry-run pending without suggesting commit", async () => {
    const { output } = await run(google, [], c => c.path === "/api/apps" ? { apps: [{ id: "app1", slug: "android", platform: "android" }] }
      : { product_id: c.body.product.productId, mode: c.body.mode, outcome: "pending", changes: [{ resource: "catalog", action: "deferred", after: "assumed_empty_unverified" }] });
    expect(output.join("\n")).toContain("assumed_empty_unverified");
    expect(output.join("\n")).toContain("Preview is incomplete");
    expect(output.join("\n")).not.toContain("Pass --commit");
    expect(process.exitCode).toBe(1);
  });
  it("stops after a partial failure and reports completed steps", async () => {
    const { QuiverApiError } = await import("../lib/api.js");
    const { calls, output } = await run(google, ["--commit", "--json"], c => {
      if (c.path === "/api/apps") return { apps: [{ id: "app1", slug: "android", platform: "android" }] };
      if (c.body.mode === "commit") throw new QuiverApiError(502, { outcome: "failed", completed: ["create"], operation_id: "op1", recovery_required: true }, "failed");
      return { product_id: c.body.product.productId, mode: c.body.mode, outcome: "planned", changes: [] };
    });
    expect(calls.filter(c => c.body?.mode === "commit")).toHaveLength(1);
    expect(JSON.parse(output.join("\n")).results[0]).toMatchObject({ outcome: "failed", completed: ["create"], recovery_required: true });
    expect(process.exitCode).toBe(1);
  });
  it("reports pending as non-success", async () => {
    const { output } = await run(google, ["--commit", "--json"], c => c.path === "/api/apps" ? { apps: [{ id: "app1", slug: "android", platform: "android" }] }
      : { product_id: c.body.product.productId, mode: c.body.mode, outcome: c.body.mode === "commit" ? "pending" : "planned", changes: [] });
    expect(JSON.parse(output.join("\n"))).toMatchObject({ pending: true }); expect(process.exitCode).toBe(1);
  });
  it("chunks Apple prices without dropping the subscription data", async () => {
    const { buildProductRequests } = await import("./store_products.js");
    const items = await buildProductRequests({ apple: { group: { referenceName: "Example", localizations: [] }, products: [{ productId: "example.pro.monthly", name: "Example", prices: Array.from({ length: 12 }, (_, i) => ({ territory: `X${i}`, customerPrice: "1" })) }] } }, "ios", ".");
    expect(items.map(x => (x.product.prices as unknown[]).length)).toEqual([5,5,2]);
    expect(items.every(x => (x.product.group as any).referenceName === "Example")).toBe(true);
    await expect(buildProductRequests({ apple: { group: {}, products: [{ productId: "p", prices: Array.from({ length: 6 }, () => ({ territory: "USA" })) }] } }, "ios", ".")).rejects.toThrow(/unique territory/);
  });
});
