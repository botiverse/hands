import { describe, expect, it, vi } from "vitest";
import { decodeJwt, exportPKCS8, generateKeyPair } from "jose";
import { createAccessToken, PLAY_REPORTS_SCOPE } from "../src/auth";
import { createPlayAdapterService } from "../src/index";
import { MAX_STATS_OBJECT_BYTES, statsObjectInput } from "../src/stats_reports";

const PKG = "build.raft.app";
const BUCKET = "pubsite_prod_8345658214806586934";
const OBJECT = `stats/installs/installs_${PKG}_202611_overview.csv`;
const oauth = { type: "authorized_user" as const, client_id: "client", client_secret: "private-client-secret",
  refresh_token: "private-refresh", client_email: "human@example.com" };

type Call = { method: string; url: URL; authorization: string | null; body: string };

function google(handler: (url: URL, call: Call) => Response | Promise<Response> = (url) =>
  url.pathname.endsWith("/o") ? Response.json({ items: [] }) : new Response("Date\n", { status: 200 })) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? "GET", url, authorization: new Headers(init.headers).get("authorization"), body: String(init.body ?? "") };
    calls.push(call);
    expect(init.redirect).toBe("manual");
    if (url.origin === "https://oauth2.googleapis.com") {
      return Response.json({ access_token: "reports-token", token_type: "Bearer", scope: PLAY_REPORTS_SCOPE });
    }
    return handler(url, call);
  });
  return { calls, service: createPlayAdapterService({ fetchImpl: fetchImpl as unknown as typeof fetch }) };
}

describe("Play statistics: token scope", () => {
  it("narrows an authorized_user refresh to devstorage.read_only and checks the granted scope", async () => {
    const { calls, service } = google();
    expect(await service.listStatsObjects({ credential: oauth, packageName: PKG, bucket: BUCKET, report: "installs" }))
      .toMatchObject({ ok: true });
    const token = calls.find((c) => c.url.origin === "https://oauth2.googleapis.com")!;
    const body = new URLSearchParams(token.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("scope")).toBe(PLAY_REPORTS_SCOPE);
    expect(token.authorization).toBeNull();
  });

  it("publishing tokens keep their original request (no scope parameter)", async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      expect(new URLSearchParams(String(init.body)).has("scope")).toBe(false);
      return Response.json({ access_token: "a", token_type: "Bearer" });
    });
    await createAccessToken(oauth, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reports a missing reports grant clearly: invalid_scope, or a token without the scope", async () => {
    for (const reply of [
      Response.json({ error: "invalid_scope" }, { status: 400 }),
      Response.json({ access_token: "a", token_type: "Bearer", scope: "https://www.googleapis.com/auth/androidpublisher" }),
      Response.json({ access_token: "a", token_type: "Bearer", scope: `${PLAY_REPORTS_SCOPE}.evil` }),
    ]) {
      await expect(createAccessToken(oauth, vi.fn(async () => reply.clone()) as unknown as typeof fetch, undefined, PLAY_REPORTS_SCOPE))
        .rejects.toMatchObject({ status: 403, code: "play_reports_scope_missing" });
    }
  });

  it("signs a service-account assertion for devstorage.read_only only", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const sa = { type: "service_account" as const, client_email: "sa@project.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey) };
    let assertion = "";
    await createAccessToken(sa, vi.fn(async (_u: unknown, init: RequestInit) => {
      assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
      return Response.json({ access_token: "a" });
    }) as unknown as typeof fetch, undefined, PLAY_REPORTS_SCOPE);
    expect(decodeJwt(assertion).scope).toBe(PLAY_REPORTS_SCOPE);
  });
});

describe("Play statistics: request restrictions", () => {
  it("lists only the bound package's report folder, paginating, and drops anything else Google returns", async () => {
    const { calls, service } = google((url) => {
      const page = url.searchParams.get("pageToken");
      if (!page) {
        return Response.json({ nextPageToken: "p2", items: [
          { name: OBJECT, generation: "17", md5Hash: "1B2M2Y8AsgTpgAmY7PhCfg==", size: "10", updated: "2026-11-12T00:00:00Z" },
          { name: `stats/installs/installs_build.raft.app.evil_202611_overview.csv`, generation: "1", size: "1" },
          { name: `stats/installs/installs_${PKG}_202611_overview.csv/../../secret`, generation: "1", size: "1" },
          { name: `stats/installs/installs_${PKG}_2026_overview.csv`, generation: "1", size: "1" },
        ] });
      }
      return Response.json({ items: [{ name: `stats/installs/installs_${PKG}_202610_country.csv`, generation: "18", size: "5", md5Hash: "not-base64" }] });
    });
    const result = await service.listStatsObjects({ credential: oauth, packageName: PKG, bucket: BUCKET, report: "installs" });
    expect(result).toEqual({ ok: true, value: { bucket: BUCKET, report: "installs", truncated: false, objects: [
      { name: OBJECT, generation: "17", md5_hash: "1B2M2Y8AsgTpgAmY7PhCfg==", size: 10, updated: "2026-11-12T00:00:00Z" },
      { name: `stats/installs/installs_${PKG}_202610_country.csv`, generation: "18", md5_hash: null, size: 5, updated: null },
    ] } });
    const gcs = calls.filter((c) => c.url.origin === "https://storage.googleapis.com");
    expect(gcs).toHaveLength(2);
    for (const c of gcs) {
      expect(c.method).toBe("GET");
      expect(c.authorization).toBe("Bearer reports-token");
      expect(c.url.pathname).toBe(`/storage/v1/b/${BUCKET}/o`);
      expect(c.url.searchParams.get("prefix")).toBe(`stats/installs/installs_${PKG}_`);
    }
    expect(gcs[1]!.url.searchParams.get("pageToken")).toBe("p2");
  });

  it.each([
    ["a non-Play bucket", { bucket: "my-bucket" }, "play_reports_bucket_invalid"],
    ["a bucket with a path", { bucket: `${BUCKET}/o/x` }, "play_reports_bucket_invalid"],
    ["a host-looking bucket", { bucket: "pubsite_prod_1.evil.com" }, "play_reports_bucket_invalid"],
    ["another report folder", { report: "earnings" }, "play_reports_request_invalid"],
    ["an invalid package", { packageName: "../x" }, "package_name_invalid"],
  ])("refuses %s before any token is minted", async (_label, override, code) => {
    const { calls, service } = google();
    const result = await service.listStatsObjects({ credential: oauth, packageName: PKG, bucket: BUCKET, report: "installs", ...override } as any);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["another package", `stats/installs/installs_build.other.app_202611_overview.csv`],
    ["a package-prefix look-alike", `stats/installs/installs_build.raft.app.evil_202611_overview.csv`],
    ["another folder", `stats/earnings/earnings_${PKG}_202611_overview.csv`],
    ["sales reports", `sales/salesreport_202611.zip`],
    ["path traversal", `stats/installs/../../sales/installs_${PKG}_202611_overview.csv`],
    ["a non-csv", `stats/installs/installs_${PKG}_202611_overview.zip`],
  ])("refuses to read %s", async (_label, name) => {
    const { calls, service } = google();
    const result = await service.readStatsObject({ credential: oauth, packageName: PKG, bucket: BUCKET, name, generation: "1", maxBytes: 100 });
    expect(result).toMatchObject({ ok: false, error: { status: 403, code: "play_reports_object_not_allowed" } });
    expect(calls).toHaveLength(0);
  });

  it("reads one pinned generation with GET, encoding the object name into the path", async () => {
    const { calls, service } = google(() => new Response(new Uint8Array([0xff, 0xfe, 0x41, 0x00]), { status: 200 }));
    const result = await service.readStatsObject({ credential: oauth, packageName: PKG, bucket: BUCKET, name: OBJECT, generation: "1762900000000001", maxBytes: 100 });
    expect(result).toEqual({ ok: true, value: { name: OBJECT, generation: "1762900000000001", size: 4, bytes: new Uint8Array([0xff, 0xfe, 0x41, 0x00]) } });
    const gcs = calls.filter((c) => c.url.origin === "https://storage.googleapis.com");
    expect(gcs).toHaveLength(1);
    expect(gcs[0]!.method).toBe("GET");
    expect(gcs[0]!.url.pathname).toBe(`/storage/v1/b/${BUCKET}/o/${encodeURIComponent(OBJECT)}`);
    expect(gcs[0]!.url.searchParams.get("alt")).toBe("media");
    expect(gcs[0]!.url.searchParams.get("generation")).toBe("1762900000000001");
    expect(statsObjectInput(PKG, OBJECT, "1").report).toBe("installs");
    expect(() => statsObjectInput(PKG, OBJECT, "1; drop")).toThrow();
  });

  it("bounds the read by the declared and the streamed size, and caps the caller's limit", async () => {
    const big = new Uint8Array(200);
    const declared = google(() => new Response(big, { status: 200, headers: { "content-length": "200" } }));
    expect(await declared.service.readStatsObject({ credential: oauth, packageName: PKG, bucket: BUCKET, name: OBJECT, generation: "1", maxBytes: 100 }))
      .toMatchObject({ ok: false, error: { status: 413, code: "play_reports_object_too_large" } });
    const streamed = google(() => new Response(new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }), { status: 200 }));
    expect(await streamed.service.readStatsObject({ credential: oauth, packageName: PKG, bucket: BUCKET, name: OBJECT, generation: "1", maxBytes: 100 }))
      .toMatchObject({ ok: false, error: { code: "play_reports_object_too_large" } });
    const capped = google(() => new Response(null, { status: 200, headers: { "content-length": String(MAX_STATS_OBJECT_BYTES + 1) } }));
    expect(await capped.service.readStatsObject({ credential: oauth, packageName: PKG, bucket: BUCKET, name: OBJECT, generation: "1", maxBytes: 10 ** 12 }))
      .toMatchObject({ ok: false, error: { code: "play_reports_object_too_large" } });
  });

  it("never follows a redirect, and maps 403/404 to bucket codes without Google's text", async () => {
    const redirect = google(() => new Response(null, { status: 302, headers: { location: "https://attacker.example/x" } }));
    expect(await redirect.service.listStatsObjects({ credential: oauth, packageName: PKG, bucket: BUCKET, report: "installs" }))
      .toMatchObject({ ok: false, error: { code: "play_reports_redirect_refused" } });
    expect(redirect.calls.map((c) => c.url.origin)).toEqual(["https://oauth2.googleapis.com", "https://storage.googleapis.com"]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [status, code] of [[403, "play_reports_bucket_forbidden"], [401, "play_reports_bucket_forbidden"], [404, "play_reports_bucket_not_found"]] as const) {
      const g = google(() => Response.json({ error: { message: "provider secret text" } }, { status }));
      const result = await g.service.listStatsObjects({ credential: oauth, packageName: PKG, bucket: BUCKET, report: "store_performance" });
      expect(result).toMatchObject({ ok: false, error: { status: 403, code } });
      expect(JSON.stringify(result)).not.toContain("provider secret text");
    }
  });
});
