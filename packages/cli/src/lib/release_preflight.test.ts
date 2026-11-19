import { describe, expect, it } from "vitest";
import { QuiverApiError } from "./api.js";
import { assertActiveReleaseAllowed } from "./release_preflight.js";

const answering = (result: unknown) => (async () => {
  if (result instanceof Error) throw result;
  return result;
}) as never;

describe("assertActiveReleaseAllowed", () => {
  it("never asks for a draft", async () => {
    let asked = false;
    await assertActiveReleaseAllowed(true, (async () => { asked = true; return {}; }) as never);
    expect(asked).toBe(false);
  });

  it("lets a signed-in person create an active release", async () => {
    await expect(assertActiveReleaseAllowed(false, answering({ account: { principal_type: "human" } }))).resolves.toBeUndefined();
  });

  it("stops an agent session before any upload", async () => {
    await expect(assertActiveReleaseAllowed(false, answering({ account: { principal_type: "agent" } })))
      .rejects.toThrow(/Re-run with --draft.*Nothing has been uploaded\.$/);
  });

  it("stops a deploy token or expired session (401 from /api/auth/me)", async () => {
    await expect(assertActiveReleaseAllowed(undefined, answering(new QuiverApiError(401, {}, "unauthorized"))))
      .rejects.toThrow(/run `hands login`/);
  });

  it("carries on when the server cannot answer; the server still enforces", async () => {
    await expect(assertActiveReleaseAllowed(false, answering(new QuiverApiError(503, {}, "down")))).resolves.toBeUndefined();
    await expect(assertActiveReleaseAllowed(false, answering(new Error("network")))).resolves.toBeUndefined();
  });
});
