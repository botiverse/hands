import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const list = (source: string) => [...source.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

describe("team closure reasons", () => {
  it("are the same in the API schema as in the update handler", () => {
    const handler = read("../src/routes/feedback.ts").match(/const FEEDBACK_CLOSURE_REASONS = \[([^\]]*)\]/)?.[1] ?? "";
    const schema = read("../src/openapi/feedback.ts").match(/closure_reason: z\.enum\(\[([^\]]*)\]\)/)?.[1] ?? "";
    expect(list(handler)).toEqual(["cannot_reproduce", "completed", "duplicate", "not_planned"]);
    expect(list(schema)).toEqual(list(handler));
  });
});
