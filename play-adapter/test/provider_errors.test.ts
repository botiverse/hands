import { expect, it, vi } from "vitest";
import { createPlayAdapterService } from "../src/index";
const credential = { type: "authorized_user" as const, client_id: "client", client_secret: "hidden-secret", refresh_token: "hidden-refresh", client_email: "person@example.invalid" };

it.each([
  ["create_edit", { error: { message: "hidden-secret", details: [{ reason: "SERVICE_DISABLED", metadata: { consumer: "private-project" } }] } }, "SERVICE_DISABLED"],
  ["list_tracks", { error: { errors: [{ reason: "insufficientPermissions" }], message: "hidden-refresh" } }, "insufficientPermissions"],
  ["delete_edit", { error: { errors: [{ reason: "hidden-secret" }], message: "hidden-refresh" } }, "unspecified"],
])("reports safe Google reason and actual failed step: %s", async (stage, body, reason) => {
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
  expect(JSON.stringify(result)).not.toMatch(/hidden-secret|hidden-refresh|private-project|person@example/);
  if (stage === "list_tracks") expect(calls.at(-1)).toBe("DELETE");
  if (stage === "create_edit") expect(calls).toEqual(["POST", "POST"]);
});
