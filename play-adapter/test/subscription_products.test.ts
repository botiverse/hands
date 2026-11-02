import { describe, expect, it } from "vitest";
import { normalizeProduct, reconcileProduct, type ProductClient } from "../src/subscription_products";

const product = () => normalizeProduct({
  productId: "raft.pro.tier1",
  listings: [{ languageCode: "en-US", title: "Raft Pro", description: "2 people" }],
  basePlans: [
    { basePlanId: "monthly", billingPeriodDuration: "P1M", activate: true,
      regionalConfigs: [{ regionCode: "US", newSubscriberAvailability: true, price: { currencyCode: "USD", units: "4", nanos: 990000000 } }] },
    { basePlanId: "annual", billingPeriodDuration: "P1Y", activate: true,
      regionalConfigs: [{ regionCode: "US", newSubscriberAvailability: true, price: { currencyCode: "USD", units: "40", nanos: 0 } }] },
  ],
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function fake(initial: Record<string, unknown>[] = []) {
  let rows = clone(initial);
  const calls: string[] = [];
  let failActivate: string | null = null;
  let dropWrites = false;
  const client: ProductClient = {
    async listSubscriptionProducts() { calls.push("list"); return clone(rows); },
    async createSubscriptionProduct(_package, id, body) {
      calls.push(`create:${id}`);
      if (!dropWrites) rows.push({ ...clone(body), basePlans: (body.basePlans as Record<string, unknown>[]).map(p => ({ ...p, state: "DRAFT" })) });
      return {};
    },
    async updateSubscriptionProduct(_package, id, body, mask) {
      calls.push(`patch:${id}:${mask.join(",")}`);
      const index = rows.findIndex(p => p.productId === id);
      if (!dropWrites) {
        const current = rows[index]!;
        const merged = { ...current };
        for (const key of mask) merged[key] = clone(body[key]);
        if (mask.includes("basePlans")) merged.basePlans = (merged.basePlans as Record<string, unknown>[]).map(plan => ({ ...plan,
          state: ((current.basePlans as Record<string, unknown>[]) ?? []).find(p => p.basePlanId === plan.basePlanId)?.state ?? "DRAFT" }));
        rows[index] = merged;
      }
      return {};
    },
    async activateSubscriptionBasePlan(_package, id, planId) {
      calls.push(`activate:${planId}`);
      if (failActivate === planId) throw new Error("temporary provider error");
      if (!dropWrites) {
        const row = rows.find(p => p.productId === id)!;
        const plan = (row.basePlans as Record<string, unknown>[]).find(p => p.basePlanId === planId)!;
        plan.state = "ACTIVE";
      }
      return {};
    },
  };
  return { client, calls, rows: () => clone(rows), failActivation: (id: string | null) => { failActivate = id; }, dropWrites: () => { dropWrites = true; } };
}

describe("Google subscription products", () => {
  it("rejects duplicate plans, unsupported fields, and prices for available regions that are missing", () => {
    const input = product();
    expect(() => normalizeProduct({ ...input, basePlans: [input.basePlans[0], input.basePlans[0]] })).toThrow(/duplicate/);
    expect(() => normalizeProduct({ ...input, arbitraryProviderPath: "/" })).toThrow(/unsupported/);
    expect(() => normalizeProduct({ ...input, basePlans: [{ ...input.basePlans[0], regionalConfigs: [{ regionCode: "US", newSubscriberAvailability: true }] }] })).toThrow(/requires a price/);
  });
  it("dry-run reads only and leaves plans without prices inactive", async () => {
    const f = fake();
    const input = product();
    input.basePlans = input.basePlans.map(({ regionalConfigs: _prices, ...plan }) => plan);
    const result = await reconcileProduct(f.client, "build.raft.app", input, "dry_run", "2022/02");
    expect(result.outcome).toBe("planned");
    expect(result.changes).toContainEqual(expect.objectContaining({ resource: "base-plan:monthly:activation", after: "awaiting_price" }));
    expect(f.calls).toEqual(["list"]);
    const committed = await reconcileProduct(f.client, "build.raft.app", input, "commit", "2022/02");
    expect(committed.outcome).toBe("pending");
    expect(f.calls.some(c => c.startsWith("activate:"))).toBe(false);
  });
  it("creates, activates, verifies, and a second apply sends no writes", async () => {
    const f = fake();
    const first = await reconcileProduct(f.client, "build.raft.app", product(), "commit", "2022/02");
    expect(first.outcome).toBe("committed");
    expect(first.completed).toEqual(["create", "activate:monthly", "activate:annual"]);
    f.calls.length = 0;
    const second = await reconcileProduct(f.client, "build.raft.app", product(), "commit", "2022/02");
    expect(second.outcome).toBe("no_changes");
    expect(f.calls).toEqual(["list", "list"]);
  });
  it("preserves unmanaged locales, plans, regions, tags and listing benefits", async () => {
    const existing = { packageName: "build.raft.app", productId: "raft.pro.tier1", taxAndComplianceSettings: { taxRateInfoByRegionCode: { US: { taxTier: "TAX_TIER_BOOKS_1" } } },
      listings: [{ languageCode: "en-US", title: "Old", description: "2 people", benefits: ["Benefit"] }, { languageCode: "ja-JP", title: "既存" }],
      basePlans: [{ basePlanId: "monthly", state: "ACTIVE", offerTags: [{ tag: "keep" }], autoRenewingBasePlanType: { billingPeriodDuration: "P1M", gracePeriodDuration: "P7D" },
        regionalConfigs: [{ regionCode: "US", newSubscriberAvailability: true, price: { currencyCode: "USD", units: "3", nanos: 0 } }, { regionCode: "JP", newSubscriberAvailability: true, price: { currencyCode: "JPY", units: "500", nanos: 0 } }] },
        { basePlanId: "legacy", state: "INACTIVE", prepaidBasePlanType: { billingPeriodDuration: "P1M" }, regionalConfigs: [] }] };
    const f = fake([existing]);
    const desired = product(); desired.basePlans = [desired.basePlans[0]!];
    expect((await reconcileProduct(f.client, "build.raft.app", desired, "commit", "2022/02")).outcome).toBe("committed");
    const row = f.rows()[0]!;
    expect(row.taxAndComplianceSettings).toEqual(existing.taxAndComplianceSettings);
    expect(row.listings).toContainEqual({ languageCode: "ja-JP", title: "既存" });
    expect((row.listings as Record<string, unknown>[])[0]).toMatchObject({ title: "Raft Pro", benefits: ["Benefit"] });
    const monthly = (row.basePlans as Record<string, unknown>[])[0]!;
    expect(monthly).toMatchObject({ offerTags: [{ tag: "keep" }], autoRenewingBasePlanType: { gracePeriodDuration: "P7D" } });
    expect(monthly.regionalConfigs).toContainEqual(existing.basePlans[0]!.regionalConfigs[1]);
    expect((row.basePlans as Record<string, unknown>[])[1]).toMatchObject({ basePlanId: "legacy", state: "INACTIVE" });
  });
  it("refuses to change an existing plan's immutable period before any write", async () => {
    const f = fake([{ packageName: "build.raft.app", productId: "raft.pro.tier1", listings: [], basePlans: [
      { basePlanId: "monthly", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1Y" } },
    ] }]);
    await expect(reconcileProduct(f.client, "build.raft.app", product(), "commit", "2022/02")).rejects.toMatchObject({ code: "base_plan_immutable_mismatch" });
    expect(f.calls).toEqual(["list"]);
  });
  it("reports partial activation failure and retries only the missing activation", async () => {
    const f = fake(); f.failActivation("annual");
    const first = await reconcileProduct(f.client, "build.raft.app", product(), "commit", "2022/02");
    expect(first).toMatchObject({ outcome: "failed", completed: ["create", "activate:monthly"] });
    f.failActivation(null); f.calls.length = 0;
    const second = await reconcileProduct(f.client, "build.raft.app", product(), "commit", "2022/02");
    expect(second.outcome).toBe("committed");
    expect(f.calls).toEqual(["list", "activate:annual", "list"]);
  });
  it("does not claim success when read-back is missing", async () => {
    const f = fake(); f.dropWrites();
    const desired = product(); desired.basePlans = desired.basePlans.map(p => ({ ...p, activate: false }));
    const result = await reconcileProduct(f.client, "build.raft.app", desired, "commit", "2022/02");
    expect(result).toMatchObject({ outcome: "failed", error: { code: "subscription_readback_mismatch" } });
  });
});
