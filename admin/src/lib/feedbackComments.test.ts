// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { addFeedbackComment } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feedback staff comment visibility", () => {
  it("sends an explicit internal flag for notes and reporter-visible replies", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "comment-1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await addFeedbackComment("app-1", "ticket-1", "private context", true);
    await addFeedbackComment("app-1", "ticket-1", "customer update", false);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      body: "private context",
      internal: true,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      body: "customer update",
      internal: false,
    });
  });
});
