import { expect, it, vi } from "vitest";
import { createPlayAdapterService } from "../src/index";
const credential = { type: "authorized_user" as const, client_id: "client", client_secret: "hidden-secret", refresh_token: "hidden-refresh", client_email: "person@example.invalid" };

it.each([
  ["create_edit", { error: { message: "hidden-secret", details: [{ reason: "SERVICE_DISABLED", metadata: { consumer: "private-project" } }] } }, "SERVICE_DISABLED"],
  ["list_tracks", { error: { errors: [{ reason: "insufficientPermissions" }], message: "hidden-refresh" } }, "insufficientPermissions"],
  ["delete_edit", { error: { errors: [{ reason: "hidden-secret" }], message: "hidden-refresh" } }, "unspecified"],
])("reports safe Google reason and actual failed step: %s", async (stage, body, reason) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const calls: string[] = [];
  const service = createPlayAdapterService({ fetchImpl: vi.fn(async (url, init = {}) => {
    const path = String(url); const method = init.method ?? "GET"; calls.push(method);
    if (path.endsWith("/token")) return Response.json({ access_token: "access", token_type: "Bearer" });
    if ((stage === "create_edit" && method === "POST") || (stage === "list_tracks" && method === "GET") || (stage === "delete_edit" && method === "DELETE")) return Response.json(body, { status: 403 });
    if (method === "POST") return Response.json({ id: "edit" });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ tracks: [{ track: "internal" }] });
  }) });
  const result = await service.listTracks({ credential, packageName: "build.test.app" }, { MAX_AAB_SIZE_BYTES: "209715200" });
  expect(result).toMatchObject({ ok: false, error: { status: 403, code: "play_api_rejected", message: `Google Play API request failed with 403 (stage=${stage}; reason=${reason})` } });
  // The log now carries Google's diagnostic envelope alongside the sanitised reason.
  expect(warn).toHaveBeenCalledWith(
    "hands_play_rejection",
    expect.stringContaining(JSON.stringify({ stage, status: 403, reason }).slice(1, -1)),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/hidden-secret|hidden-refresh|private-project|person@example/);
  warn.mockRestore();
  expect(JSON.stringify(result)).not.toMatch(/hidden-secret|hidden-refresh|private-project|person@example/);
  if (stage === "list_tracks") expect(calls.at(-1)).toBe("DELETE");
  if (stage === "create_edit") expect(calls).toEqual(["POST", "POST"]);
});

it("logs Google's validation reasons, which is the case the whitelist drops", async () => {
  // A validation rejection is exactly what "reason=unspecified" hides: badRequest /
  // releaseValidationError are not in REASONS, so the operator gets nothing to act on.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const service = createPlayAdapterService({ fetchImpl: vi.fn(async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith("/token")) return Response.json({ access_token: "access", token_type: "Bearer" });
    if (path.endsWith("/edits")) {
      return Response.json({ error: {
        code: 400, status: "INVALID_ARGUMENT",
        message: "Track has more than one completed release",
        errors: [{ reason: "badRequest", message: "one completed per track" }],
        details: [{ reason: "releaseValidationError" }],
      } }, { status: 400 });
    }
    return Response.json({ id: "edit" });
  }) });
  const result = await service.listTracks({ credential, packageName: "build.test.app" }, { MAX_AAB_SIZE_BYTES: "209715200" });
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).toContain("badRequest");
  expect(logged).toContain("releaseValidationError");
  expect(logged).toContain("INVALID_ARGUMENT");
  // The caller's contract is unchanged: still the sanitised code and stage only.
  expect(result).toMatchObject({ ok: false, error: { code: "play_api_rejected" } });
  expect(JSON.stringify(result)).not.toContain("releaseValidationError");
  // Provider prose is never logged verbatim; only its length.
  expect(logged).not.toContain("Track has more than one completed release");
  expect(logged).not.toContain("one completed per track");
  // And no credential, even though this body could echo one.
  expect(logged).not.toMatch(/hidden-secret|hidden-refresh|private-project|person@example/);
  warn.mockRestore();
});

it("names the likely cause from Google's prose without echoing the prose", async () => {
  // A validation rejection's reason is only `badRequest`; the discriminating detail
  // lives in `message`, which must never be logged verbatim. Classifying it keeps the
  // investigation one-shot without turning the log into a credential channel.
  const cases: Array<[string, string]> = [
    ["Track 'internal' has more than one completed release.", "MULTIPLE_COMPLETED"],
    ["Only one completed release is allowed per track.", "MULTIPLE_COMPLETED"],
    ["Draft apps can only receive draft releases.", "DRAFT_APP_RESTRICTION"],
    ["Version code 11500010 has already been used.", "DUPLICATE_VERSION"],
    ["Unknown track: internal", "NOT_FOUND"],
    ["Something nobody has classified: hidden-secret-abc", "OTHER"],
  ];
  for (const [message, expected] of cases) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = createPlayAdapterService({ fetchImpl: vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith("/token")) return Response.json({ access_token: "access", token_type: "Bearer" });
      if (path.endsWith("/edits")) {
        return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message, errors: [{ reason: "badRequest", message }] } }, { status: 400 });
      }
      return Response.json({ id: "edit" });
    }) });
    const result = await service.listTracks({ credential, packageName: "build.test.app" }, { MAX_AAB_SIZE_BYTES: "209715200" });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain(expected);
    // The prose itself never reaches the log, in either position.
    expect(logged).not.toContain("hidden-secret-abc");
    expect(logged).not.toMatch(/Track '|Draft apps can|Version code 11500010|Unknown track:/);
    // And the caller still only sees the sanitised code.
    expect(result).toMatchObject({ ok: false, error: { code: "play_api_rejected" } });
    warn.mockRestore();
  }
});
