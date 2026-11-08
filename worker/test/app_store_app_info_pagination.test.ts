import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listAppInfos, listInfoLocalizations, listOwnedVersions, listPrimaryCategories, listVersionLocales } from "../src/lib/app_store_app_info";
import { ASC, installAscFake, realCreds, type AscCall } from "./asc_fake";

let creds: Awaited<ReturnType<typeof realCreds>>;
beforeAll(async () => { creds = await realCreds(); });
afterEach(() => vi.unstubAllGlobals());

const cases = [
  { name: "versions", base: "/v1/apps/app/appStoreVersions", read: () => listOwnedVersions(creds, "app"), row: (id: string) => ({ type: "appStoreVersions", id, attributes: { versionString: id, platform: "IOS", appVersionState: "PREPARE_FOR_SUBMISSION" } }) },
  { name: "app infos", base: "/v1/apps/app/appInfos", read: () => listAppInfos(creds, "app"), row: (id: string) => ({ type: "appInfos", id, attributes: { state: "PREPARE_FOR_SUBMISSION" } }) },
  { name: "localizations", base: "/v1/appInfos/info/appInfoLocalizations", read: () => listInfoLocalizations(creds, "info"), row: (id: string) => ({ type: "appInfoLocalizations", id, attributes: { locale: id, name: "Name" } }) },
  { name: "version locales", base: "/v1/appStoreVersions/ver/appStoreVersionLocalizations", read: () => listVersionLocales(creds, "ver"), row: (id: string) => ({ type: "appStoreVersionLocalizations", id, attributes: { locale: id } }) },
  { name: "categories", base: "/v1/appCategories", read: () => listPrimaryCategories(creds, "IOS"), row: (id: string) => ({ type: "appCategories", id }) },
] as const;

describe("App Information collection pagination", () => {
  it.each(cases)("reads every $name page with Apple's required links and optional paging metadata", async ({ read, row, base }) => {
    const fake = installAscFake((call: AscCall) => {
      const url = new URL(call.url);
      const cursor = url.searchParams.get("cursor");
      if (!cursor) {
        url.searchParams.set("cursor", "next");
        return { json: { data: [row("z")], links: { self: call.url, next: url.href }, meta: { paging: { limit: 200, total: 2, nextCursor: "next" } } } };
      }
      return { json: { data: [row("a")], links: { self: call.url }, meta: { paging: { limit: 200, total: 2 } } } };
    });
    const out = await read();
    expect(out.map((x: any) => typeof x === "string" ? x : x.id)).toEqual(["a", "z"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((c) => c.method === "GET" && new URL(c.url).pathname === base)).toBe(true);
  });

  it("resolves a relative next link against the current collection URL", async () => {
    const fake = installAscFake((call) => new URL(call.url).searchParams.has("cursor")
      ? { json: { data: [{ type: "appInfos", id: "two", attributes: { state: "READY_FOR_DISTRIBUTION" } }], links: { self: call.url } } }
      : { json: { data: [{ type: "appInfos", id: "one", attributes: { state: "PREPARE_FOR_SUBMISSION" } }], links: { self: call.url, next: "?limit=200&cursor=second" } } });
    expect((await listAppInfos(creds, "app")).map((i) => i.id)).toEqual(["one", "two"]);
    expect(fake.calls[1]!.path).toBe("/v1/apps/app/appInfos?limit=200&cursor=second");
  });

  it.each([
    ["missing links", () => ({ data: [] })],
    ["missing self", () => ({ data: [], links: {} })],
    ["non-string self", () => ({ data: [], links: { self: 5 } })],
    ["foreign self", () => ({ data: [], links: { self: "https://evil.invalid/v1/apps/app/appInfos" } })],
    ["foreign next", (c: AscCall) => ({ data: [], links: { self: c.url, next: "https://api.appstoreconnect.apple.com.evil.invalid/v1/apps/app/appInfos" } })],
    ["different path", (c: AscCall) => ({ data: [], links: { self: c.url, next: `${ASC}/v1/apps/other/appInfos` } })],
    ["user info", (c: AscCall) => ({ data: [], links: { self: c.url, next: "https://user@api.appstoreconnect.apple.com/v1/apps/app/appInfos" } })],
    ["fragment", (c: AscCall) => ({ data: [], links: { self: c.url, next: `${ASC}/v1/apps/app/appInfos#fragment` } })],
    ["malformed next", (c: AscCall) => ({ data: [], links: { self: c.url, next: {} } })],
    ["missing paging limit", (c: AscCall) => ({ data: [], links: { self: c.url }, meta: { paging: {} } })],
    ["cursor without next", (c: AscCall) => ({ data: [], links: { self: c.url }, meta: { paging: { limit: 200, nextCursor: "abc" } } })],
    ["incomplete total", (c: AscCall) => ({ data: [], links: { self: c.url }, meta: { paging: { limit: 200, total: 1 } } })],
    ["wrong row type", (c: AscCall) => ({ data: [{ type: "apps", id: "a" }], links: { self: c.url } })],
  ] as Array<[string, (call: AscCall) => unknown]>)("rejects %s", async (_name, response) => {
    const fake = installAscFake((call) => ({ json: response(call) }));
    await expect(listAppInfos(creds, "app")).rejects.toMatchObject({ status: 502, message: "app_infos_malformed" });
    expect(fake.writes()).toEqual([]);
  });

  it("rejects duplicate resource IDs across pages", async () => {
    const fake = installAscFake((call) => ({ json: { data: [{ type: "appInfos", id: "same", attributes: { state: "PREPARE_FOR_SUBMISSION" } }], links: { self: call.url, ...(new URL(call.url).searchParams.has("cursor") ? {} : { next: "?limit=200&cursor=2" }) } } }));
    await expect(listAppInfos(creds, "app")).rejects.toMatchObject({ status: 502, message: "app_infos_malformed" });
    expect(fake.calls).toHaveLength(2);
  });

  it("rejects repeated page links and has a hard five-page limit", async () => {
    let fake = installAscFake((call) => ({ json: { data: [], links: { self: call.url, next: call.url } } }));
    await expect(listAppInfos(creds, "app")).rejects.toMatchObject({ status: 502, message: "app_infos_malformed" });
    expect(fake.calls).toHaveLength(1);
    let i = 0;
    fake = installAscFake((call) => ({ json: { data: [], links: { self: call.url, next: `?limit=200&cursor=${++i}` } } }));
    await expect(listAppInfos(creds, "app")).rejects.toMatchObject({ status: 502, message: "app_infos_too_long" });
    expect(fake.calls).toHaveLength(5);
  });

  it("refuses next links that drop, change, duplicate or add category filters", async () => {
    for (const query of ["limit=200&cursor=2", "limit=200&cursor=2&exists[parent]=false&filter[platforms]=MAC_OS", "limit=200&cursor=2&exists[parent]=false&filter[platforms]=IOS&filter[platforms]=TV_OS", "limit=200&cursor=2&exists[parent]=false&filter[platforms]=IOS&filter[id]=PRODUCTIVITY"]) {
      const fake = installAscFake((call) => ({ json: { data: [], links: { self: call.url, next: `${ASC}/v1/appCategories?${query}` } } }));
      await expect(listPrimaryCategories(creds, "IOS")).rejects.toMatchObject({ status: 502, message: "app_categories_malformed" });
      expect(fake.calls).toHaveLength(1);
    }
  });
});
