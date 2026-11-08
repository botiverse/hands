import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeInfoLocalization, writePrimaryCategory } from "../src/lib/app_store_app_info";
import { installAscFake, realCreds } from "./asc_fake";

let creds: Awaited<ReturnType<typeof realCreds>>;
beforeAll(async () => { creds = await realCreds(); });
afterEach(() => vi.unstubAllGlobals());

describe("App Information Apple write request contracts (mock provider)", () => {
  it("creates a localization with required locale, name and appInfo relationship", async () => {
    const asc = installAscFake(() => ({ status: 201, json: { data: { type: "appInfoLocalizations", id: "new-ja", attributes: { locale: "ja", name: "新しい名前", subtitle: "副題" } }, links: { self: "https://api.appstoreconnect.apple.com/v1/appInfoLocalizations/new-ja" } } }));
    expect(await writeInfoLocalization(creds, "info-1", "ja", null, { name: "新しい名前", subtitle: "副題" })).toBe("new-ja");
    expect(asc.writes().map(({ method, path, body }) => ({ method, path, body }))).toEqual([{ method: "POST", path: "/v1/appInfoLocalizations", body: { data: { type: "appInfoLocalizations", attributes: { locale: "ja", name: "新しい名前", subtitle: "副題" }, relationships: { appInfo: { data: { type: "appInfos", id: "info-1" } } } } } }]);
  });
  it("updates only requested localization fields, with encoded path and resource ID", async () => {
    const asc = installAscFake(() => ({ json: { data: { type: "appInfoLocalizations", id: "loc/1", attributes: { subtitle: "Chat" } }, links: { self: "https://api.appstoreconnect.apple.com/v1/appInfoLocalizations/loc%2F1" } } }));
    expect(await writeInfoLocalization(creds, "info-1", "en-US", "loc/1", { subtitle: "Chat" })).toBe("loc/1");
    expect(asc.writes().map(({ method, path, body }) => ({ method, path, body }))).toEqual([{ method: "PATCH", path: "/v1/appInfoLocalizations/loc%2F1", body: { data: { type: "appInfoLocalizations", id: "loc/1", attributes: { subtitle: "Chat" } } } }]);
  });
  it("updates the appInfo primaryCategory relationship without changing unrelated attributes", async () => {
    const asc = installAscFake(() => ({ json: { data: { type: "appInfos", id: "info/1" }, links: { self: "https://api.appstoreconnect.apple.com/v1/appInfos/info%2F1" } } }));
    await writePrimaryCategory(creds, "info/1", "PRODUCTIVITY");
    expect(asc.writes().map(({ method, path, body }) => ({ method, path, body }))).toEqual([{ method: "PATCH", path: "/v1/appInfos/info%2F1", body: { data: { type: "appInfos", id: "info/1", relationships: { primaryCategory: { data: { type: "appCategories", id: "PRODUCTIVITY" } } } } } }]);
  });
  it("treats a create response without the new resource ID as uncertain", async () => {
    const asc = installAscFake(() => ({ status: 201, json: { data: { type: "appInfoLocalizations" } } }));
    await expect(writeInfoLocalization(creds, "info-1", "ja", null, { name: "新しい名前" })).rejects.toMatchObject({ status: 502, message: "app_info_localization_create_malformed" });
    expect(asc.writes()).toHaveLength(1);
  });
});
