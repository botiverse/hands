import { afterEach, expect, it, vi } from "vitest";
import { installAscFake, makeContext, realCreds, type AscCall } from "./asc_fake";

let credentials: Awaited<ReturnType<typeof realCreds>> | null = null;
vi.mock("../src/lib/asc_credentials", () => ({ getAscCredentials: async () => (credentials ??= await realCreds()) }));
vi.mock("../src/lib/asc_api", async (original) => ({ ...(await original<typeof import("../src/lib/asc_api")>()), resolveAscAppId: async () => "asc-app-1" }));
const { handleApplyStoreProduct } = await import("../src/routes/store_products");

afterEach(() => vi.unstubAllGlobals());

it("reconciles an Apple product through the actual route and signed provider client", async () => {
  type Resource = { type: string; id: string; attributes: Record<string, unknown>; relationships?: Record<string, unknown> };
  const groups: Resource[] = [], products: Resource[] = [], groupLocales: Resource[] = [], locales: Resource[] = [];
  let next = 1;
  const asc = installAscFake((call: AscCall) => {
    const path = call.path.split("?")[0];
    if (call.method === "GET" && path === "/v1/apps/asc-app-1/subscriptionGroups") return { json: { data: groups } };
    if (call.method === "GET" && path?.startsWith("/v1/subscriptionGroups/") && path.endsWith("/subscriptions")) return { json: { data: products } };
    if (call.method === "GET" && path?.endsWith("/subscriptionGroupLocalizations")) return { json: { data: groupLocales } };
    if (call.method === "GET" && path?.endsWith("/subscriptionLocalizations")) return { json: { data: locales } };
    if (call.method === "POST") {
      const resource = { ...call.body.data, id: String(next++) } as Resource;
      const table = ({ subscriptionGroups: groups, subscriptions: products, subscriptionGroupLocalizations: groupLocales, subscriptionLocalizations: locales } as Record<string, Resource[]>)[resource.type];
      if (!table) return undefined;
      table.push(resource); return { status: 201, json: { data: resource } };
    }
    return undefined;
  });
  const product = { group: { referenceName: "Example Group", localizations: [{ locale: "en-US", name: "Example" }] }, productId: "example.pro.monthly", name: "Example Monthly", subscriptionPeriod: "ONE_MONTH", groupLevel: 1, localizations: [{ locale: "en-US", name: "Example Pro", description: "Example description" }] };
  async function run(mode: "dry_run" | "commit") {
    const { c, audits } = makeContext({ body: { store: "apple", mode, product }, first: sql => sql.includes("SELECT platform") ? { platform: "ios" } : null });
    const response = await handleApplyStoreProduct(c);
    return { response, body: await response.json() as any, audits };
  }
  const preview = await run("dry_run");
  expect(preview.response.status).toBe(200); expect(preview.body.outcome).toBe("planned"); expect(asc.writes()).toHaveLength(0);
  const committed = await run("commit");
  expect(committed.response.status).toBe(200); expect(committed.body.outcome).toBe("committed");
  expect(asc.writes().map(call => call.path)).toEqual(["/v1/subscriptionGroups", "/v1/subscriptionGroupLocalizations", "/v1/subscriptions", "/v1/subscriptionLocalizations"]);
  expect(asc.writes()[2]!.body.data.relationships.group.data.id).toBe(groups[0]!.id);
  expect(asc.calls.every(call => call.headers.authorization?.startsWith("Bearer "))).toBe(true);
  expect(JSON.stringify(committed.audits)).not.toContain("Example description");
  const count = asc.writes().length;
  expect((await run("commit")).body.outcome).toBe("no_changes"); expect(asc.writes()).toHaveLength(count);
});
