import { describe, expect, it } from "vitest";
import { AscApiError } from "../src/lib/asc_api";
import { normalizeAppleProduct, reconcileAppleProduct, type AscRequest, type AppleExecution } from "../src/lib/apple_subscription_products";

type Row = { type: string; id: string; attributes: Record<string, any>; relationships?: Record<string, any> };
const payload = { group: { referenceName: "Raft Pro", localizations: [{ locale: "en-US", name: "Raft Pro" }] }, productId: "raft.pro.tier4.monthly", name: "Tier 4 monthly", subscriptionPeriod: "ONE_MONTH", groupLevel: 1, localizations: [{ locale: "en-US", name: "Tier 4", description: "25 people, 100 agents" }] };
function fake() {
  const groups: Row[] = [], products: Row[] = [], groupLocs: Row[] = [], locs: Row[] = [], prices: Row[] = [], points: Row[] = [], screenshots: Row[] = [];
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let next = 1, claimed = false, rejectGroup = false, groupFailure = false, badReadback = false;
  const req: AscRequest = async (method, path, body: any = undefined) => {
    calls.push({ method, path, body });
    const pathname = path.split("?")[0]!;
    const rows = (data: Row[], included?: Row[]) => ({ data: structuredClone(data), ...(included ? { included: structuredClone(included) } : {}) });
    let result: any;
    if (method === "GET" && pathname === "/v1/apps/app1/subscriptionGroups") result = rows(groups);
    else if (method === "GET" && pathname.startsWith("/v1/subscriptionGroups/") && pathname.endsWith("/subscriptions")) result = rows(products.filter(p => p.relationships?.group?.data?.id === pathname.split("/")[3]));
    else if (method === "GET" && pathname.endsWith("/subscriptionGroupLocalizations")) result = rows(groupLocs);
    else if (method === "GET" && pathname.endsWith("/subscriptionLocalizations")) result = rows(locs.map(l => badReadback ? { ...l, attributes: { ...l.attributes, name: "wrong" } } : l));
    else if (method === "GET" && pathname.endsWith("/appStoreReviewScreenshot")) result = { data: screenshots[0] ? structuredClone(screenshots[0]) : null };
    else if (method === "GET" && pathname.endsWith("/prices")) result = rows(prices, points);
    else if (method === "GET" && pathname.endsWith("/pricePoints")) result = rows(points);
    else if (method === "POST") {
      if (pathname === "/v1/subscriptionGroups" && (rejectGroup || groupFailure)) throw new AscApiError(rejectGroup ? 422 : 503, "create_failed");
      const data = body.data as Row;
      const item = { ...structuredClone(data), id: String(next++) };
      const table = ({ subscriptionGroups: groups, subscriptions: products, subscriptionGroupLocalizations: groupLocs, subscriptionLocalizations: locs, subscriptionPrices: prices, subscriptionAppStoreReviewScreenshots: screenshots } as Record<string, Row[]>)[data.type];
      if (!table) throw new Error(`unexpected post ${pathname}`);
      if (data.type === "subscriptionPrices") { item.attributes.preserved = false; item.attributes.planType = "UPFRONT"; }
      if (data.type === "subscriptionAppStoreReviewScreenshots") { item.attributes.assetDeliveryState = { state: "AWAITING_UPLOAD" }; item.attributes.uploadOperations = [{ url: "https://apple.example/part", method: "PUT", offset: 0, length: data.attributes.fileSize, requestHeaders: [] }]; }
      table.push(item); result = { data: item };
    } else if (method === "PATCH") {
      const id = decodeURIComponent(pathname.split("/").at(-1)!);
      const row = [...groups, ...products, ...groupLocs, ...locs, ...screenshots].find(x => x.id === id);
      if (!row) throw new Error(`missing ${pathname}`);
      Object.assign(row.attributes, body.data.attributes); if (row.type === "subscriptionAppStoreReviewScreenshots" && body.data.attributes.uploaded) row.attributes.assetDeliveryState = { state: "UPLOAD_COMPLETE" }; result = { data: row };
    } else throw new Error(`unexpected ${method} ${path}`);
    return result;
  };
  const exec: AppleExecution = {
    claimGroupCreation: async () => { if (claimed) return false; claimed = true; return true; },
    confirmGroupVisible: async () => { claimed = false; },
    releaseRejectedGroup: async () => { claimed = false; },
    upload: async (ops, bytes) => { if (ops[0]?.length !== bytes.length) throw new Error("bad upload"); },
  };
  return { req, exec, groups, products, groupLocs, locs, prices, points, calls,
    writes: () => calls.filter(c => c.method !== "GET"),
    failGroup: (known: boolean) => { rejectGroup = known; groupFailure = !known; },
    badReadback: () => { badReadback = true; }, completeScreenshot: () => { screenshots[0]!.attributes.assetDeliveryState = { state: "COMPLETE" }; } };
}

describe("Apple subscription products", () => {
  it("validates before provider calls and requires explicit price-preservation choice", () => {
    expect(() => normalizeAppleProduct({ ...payload, prices: [{ territory: "USA", customerPrice: "4.99" }] })).toThrow(/preserveCurrentPrice/);
    expect(() => normalizeAppleProduct({ ...payload, groupLevel: 0 })).toThrow(/groupLevel/);
  });
  it("previews only GETs, and marks new product prices as deferred", async () => {
    const f = fake();
    const p = normalizeAppleProduct({ ...payload, prices: [{ territory: "USA", customerPrice: "4.99", preserveCurrentPrice: true }] });
    const result = await reconcileAppleProduct(f.req, "app1", p, "dry_run", f.exec);
    expect(result.outcome).toBe("planned");
    expect(result.changes).toEqual(expect.arrayContaining([expect.objectContaining({ resource: "price:USA", action: "deferred" })]));
    expect(f.writes()).toHaveLength(0);
  });
  it("creates scoped resources, reads back, then does nothing on retry", async () => {
    const f = fake(), p = normalizeAppleProduct(payload);
    const first = await reconcileAppleProduct(f.req, "app1", p, "commit", f.exec);
    expect(first.outcome).toBe("committed");
    expect(f.groups[0]!.relationships?.app.data.id).toBe("app1");
    expect(f.products[0]!.relationships?.group.data.id).toBe(f.groups[0]!.id);
    expect(f.locs[0]!.relationships?.subscription.data.id).toBe(f.products[0]!.id);
    const count = f.writes().length;
    const second = await reconcileAppleProduct(f.req, "app1", p, "commit", f.exec);
    expect(second.outcome).toBe("no_changes"); expect(f.writes()).toHaveLength(count);
  });
  it("rejects an existing product in a different group", async () => {
    const f = fake(); f.groups.push({ type: "subscriptionGroups", id: "other", attributes: { referenceName: "Other" } });
    f.products.push({ type: "subscriptions", id: "p", attributes: { productId: payload.productId, name: payload.name, subscriptionPeriod: payload.subscriptionPeriod, groupLevel: payload.groupLevel }, relationships: { group: { data: { id: "other" } } } });
    await expect(reconcileAppleProduct(f.req, "app1", normalizeAppleProduct(payload), "commit", f.exec)).rejects.toMatchObject({ status: 409, message: "subscription_in_other_group" });
    expect(f.writes()).toHaveLength(0);
  });
  it("fails closed on a readback mismatch after writes", async () => {
    const f = fake(); f.badReadback();
    const result = await reconcileAppleProduct(f.req, "app1", normalizeAppleProduct(payload), "commit", f.exec);
    expect(result.outcome).toBe("failed"); expect(result.completed).toContain("subscription:create");
    expect(result.error?.code).toBe("subscription_readback_mismatch");
  });
  it("does not duplicate an ambiguously created group on retry", async () => {
    const f = fake(); f.failGroup(false); const p = normalizeAppleProduct(payload);
    expect((await reconcileAppleProduct(f.req, "app1", p, "commit", f.exec)).outcome).toBe("failed");
    expect((await reconcileAppleProduct(f.req, "app1", p, "commit", f.exec)).error?.code).toBe("group_creation_unconfirmed");
    expect(f.writes().filter(c => c.path === "/v1/subscriptionGroups")).toHaveLength(1);
  });
  it("writes the exact territory price point and skips it on retry", async () => {
    const f = fake(), base = normalizeAppleProduct(payload);
    await reconcileAppleProduct(f.req, "app1", base, "commit", f.exec);
    f.points.push({ type: "subscriptionPricePoints", id: "pt", attributes: { customerPrice: "4.99" }, relationships: { territory: { data: { id: "USA" } } } });
    const priced = normalizeAppleProduct({ ...payload, prices: [{ territory: "USA", customerPrice: "4.990", preserveCurrentPrice: true }] });
    const result = await reconcileAppleProduct(f.req, "app1", priced, "commit", f.exec, "2026-11-02");
    expect(result.outcome).toBe("committed");
    const post = f.writes().find(c => c.path === "/v1/subscriptionPrices")!;
    expect(post.body.data).toMatchObject({ attributes: { startDate: null, preserveCurrentPrice: true, planType: "UPFRONT" }, relationships: { territory: { data: { id: "USA" } }, subscriptionPricePoint: { data: { id: "pt" } } } });
    const count = f.writes().length;
    expect((await reconcileAppleProduct(f.req, "app1", priced, "commit", f.exec, "2026-11-02")).outcome).toBe("no_changes");
    expect(f.writes()).toHaveLength(count);
  });
  it("treats an uploaded screenshot as pending until Apple reports COMPLETE", async () => {
    const f = fake();
    const image = { fileName: "review.png", md5: "a".repeat(32), sha256: "b".repeat(64), bytes: new Uint8Array([1,2,3]) };
    const desired = normalizeAppleProduct(payload, image);
    const result = await reconcileAppleProduct(f.req, "app1", desired, "commit", f.exec);
    expect(result.outcome).toBe("pending"); expect(result.completed).toContain("review-screenshot:uploaded");
    const count = f.writes().length;
    expect((await reconcileAppleProduct(f.req, "app1", desired, "commit", f.exec)).outcome).toBe("pending");
    expect(f.writes()).toHaveLength(count);
    f.completeScreenshot();
    expect((await reconcileAppleProduct(f.req, "app1", desired, "commit", f.exec)).outcome).toBe("no_changes");
  });
  it("rejects a provider price with missing territory rather than creating a duplicate", async () => {
    const f = fake(); await reconcileAppleProduct(f.req, "app1", normalizeAppleProduct(payload), "commit", f.exec);
    f.prices.push({ type: "subscriptionPrices", id: "bad", attributes: { preserved: false, planType: "UPFRONT" }, relationships: {} });
    const p = normalizeAppleProduct({ ...payload, prices: [{ territory: "USA", customerPrice: "4.99", preserveCurrentPrice: true }] });
    const count = f.writes().length;
    await expect(reconcileAppleProduct(f.req, "app1", p, "commit", f.exec)).rejects.toMatchObject({ status: 502 });
    expect(f.writes()).toHaveLength(count);
  });
  it("rejects a pagination link to an unrelated host", async () => {
    const f = fake();
    const req: AscRequest = async () => ({ data: [], links: { next: "https://evil.example/v1/apps/app1/subscriptionGroups?page=2" } }) as never;
    await expect(reconcileAppleProduct(req, "app1", normalizeAppleProduct(payload), "commit", f.exec)).rejects.toMatchObject({ status: 502 });
  });
  it("does not confuse an annual installment price with the upfront price", async () => {
    const f = fake(); await reconcileAppleProduct(f.req, "app1", normalizeAppleProduct(payload), "commit", f.exec);
    f.points.push({ type: "subscriptionPricePoints", id: "up", attributes: { customerPrice: "4.99" } }, { type: "subscriptionPricePoints", id: "monthly", attributes: { customerPrice: "1.00" } });
    for (const [id, planType, point] of [["a", "UPFRONT", "up"], ["b", "MONTHLY", "monthly"]]) f.prices.push({ type: "subscriptionPrices", id: id!, attributes: { startDate: null, preserved: false, planType }, relationships: { territory: { data: { id: "USA" } }, subscriptionPricePoint: { data: { id: point } } } });
    const p = normalizeAppleProduct({ ...payload, prices: [{ territory: "USA", customerPrice: "4.99", preserveCurrentPrice: true }] });
    expect((await reconcileAppleProduct(f.req, "app1", p, "commit", f.exec)).outcome).toBe("no_changes");
  });
  it("refuses to overwrite a scheduled price even if today's amount matches", async () => {
    const f = fake(), p = normalizeAppleProduct(payload);
    await reconcileAppleProduct(f.req, "app1", p, "commit", f.exec);
    f.points.push({ type: "subscriptionPricePoints", id: "pt", attributes: { customerPrice: "4.99" }, relationships: { territory: { data: { id: "USA" } } } });
    f.prices.push({ type: "subscriptionPrices", id: "now", attributes: { startDate: null, preserved: false, planType: "UPFRONT" }, relationships: { territory: { data: { id: "USA" } }, subscriptionPricePoint: { data: { id: "pt" } } } },
      { type: "subscriptionPrices", id: "later", attributes: { startDate: "2026-12-01", preserved: false, planType: "UPFRONT" }, relationships: { territory: { data: { id: "USA" } }, subscriptionPricePoint: { data: { id: "pt" } } } });
    const priced = normalizeAppleProduct({ ...payload, prices: [{ territory: "USA", customerPrice: "4.99", preserveCurrentPrice: true }] });
    const count = f.writes().length;
    await expect(reconcileAppleProduct(f.req, "app1", priced, "commit", f.exec, "2026-11-02")).rejects.toMatchObject({ status: 409 });
    expect(f.writes()).toHaveLength(count);
  });
});
