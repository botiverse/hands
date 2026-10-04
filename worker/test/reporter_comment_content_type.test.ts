import { describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: () => { throw new Error("container not used"); } }));
const { default: worker } = await import("../src/index");

const path = "https://hands.test/api/apps/11111111-1111-4111-8111-111111111111/reporter-feedback/22222222-2222-4222-8222-222222222222/comments";
const submissionId = "33333333-3333-4333-8333-333333333333";
const ctx = { waitUntil() {}, passThroughOnException() {} };
const fetch = (body?: BodyInit, contentType?: string) => worker.fetch(new Request(path, {
  method: "POST", body: body ?? null,
  headers: { "X-Hands-Reporter-Id": "reporter-identity-123", ...(contentType ? { "content-type": contentType } : {}) },
}), {} as Env, ctx as any);

describe("reporter comment content-type routing", () => {
  it("routes a text-only multipart reply through reporter authentication", async () => {
    const form = new FormData();
    form.set("body", "普通中文回复 1.0.43");
    form.set("submission_id", submissionId);
    const result = await fetch(form);
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "invalid or missing bearer token" });
  });
  it("routes JSON replies through the same authentication boundary", async () => {
    const result = await fetch(JSON.stringify({ body: "reply", submission_id: submissionId }), "application/json");
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "invalid or missing bearer token" });
  });
});
