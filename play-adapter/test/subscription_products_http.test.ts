import { describe, expect, it } from "vitest";
import { GooglePlayClient } from "../src/google_play";

const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
describe("Google subscription HTTP contract", () => {
  it("reads every page and uses package-scoped subscription endpoints and fields", async () => {
    const calls: Array<{ url: URL; method: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if ((init?.method ?? "GET") === "GET") return url.searchParams.has("pageToken")
        ? reply({ subscriptions: [{ productId: "two" }] }) : reply({ subscriptions: [{ productId: "one" }], nextPageToken: "next page" });
      return reply({ productId: "raft.pro.tier1" });
    };
    const client = new GooglePlayClient("redacted", fetchImpl, 1);
    expect((await client.listSubscriptionProducts("build.raft.app")).map(x => x.productId)).toEqual(["one", "two"]);
    await client.createSubscriptionProduct("build.raft.app", "raft.pro.tier1", { productId: "raft.pro.tier1" }, "2022/02");
    await client.updateSubscriptionProduct("build.raft.app", "raft.pro.tier1", { listings: [] }, ["listings"], "2022/02");
    await client.activateSubscriptionBasePlan("build.raft.app", "raft.pro.tier1", "monthly");
    expect(calls[1]!.url.searchParams.get("pageToken")).toBe("next page");
    expect(calls[2]).toMatchObject({ method: "POST", body: { productId: "raft.pro.tier1" } });
    expect(calls[2]!.url.searchParams.get("regionsVersion.version")).toBe("2022/02");
    expect(calls[2]!.url.searchParams.get("productId")).toBe("raft.pro.tier1");
    expect(calls[3]!.url.searchParams.get("updateMask")).toBe("listings");
    expect(calls[4]!.url.pathname).toMatch(/\/applications\/build\.raft\.app\/subscriptions\/raft\.pro\.tier1\/basePlans\/monthly:activate$/);
  });
  it("fails closed on repeated pagination tokens", async () => {
    const client = new GooglePlayClient("redacted", async () => reply({ subscriptions: [], nextPageToken: "repeat" }), 1);
    await expect(client.listSubscriptionProducts("build.raft.app")).rejects.toMatchObject({ code: "play_subscription_malformed" });
  });
});
