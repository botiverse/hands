import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { jsonBodyLimit, MAX_JSON_BODY_BYTES } from "../src/middleware/json_body_limit";

function app() {
  const a = new Hono();
  a.use("*", jsonBodyLimit);
  a.post("/x", async (c) => {
    const type = c.req.header("content-type") ?? "";
    if (type.includes("json")) {
      const body = (await c.req.json()) as unknown[];
      return c.json({ items: body.length });
    }
    return c.json({ bytes: (await c.req.arrayBuffer()).byteLength });
  });
  return a;
}

const bigJson = () => `[${"1,".repeat(MAX_JSON_BODY_BYTES / 2)}1]`;

describe("jsonBodyLimit", () => {
  it("accepts a normal JSON body", async () => {
    const res = await app().request("/x", { method: "POST", headers: { "content-type": "application/json" }, body: "[1,2,3]" });
    expect(await res.json()).toEqual({ items: 3 });
  });

  it("refuses an oversized JSON body with 413 before parsing it", async () => {
    const res = await app().request("/x", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: bigJson() });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("refuses an oversized streamed JSON body without content-length", async () => {
    const chunk = new TextEncoder().encode("1,".repeat(1024 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_JSON_BODY_BYTES + chunk.length) { controller.close(); return; }
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const res = await app().request("/x", {
      method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
  });

  it("leaves binary uploads alone", async () => {
    const res = await app().request("/x", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(MAX_JSON_BODY_BYTES + 10) });
    expect(await res.json()).toEqual({ bytes: MAX_JSON_BODY_BYTES + 10 });
  });
});
