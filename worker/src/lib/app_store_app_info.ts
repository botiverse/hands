/** Conservative App Information reads. Apple shares this resource across platforms. */
import { AscApiError, ascRequest, sameOriginAscPath, type AscApiCredentials } from "./asc_api";

export type InfoField = "name" | "subtitle";
export interface InfoLocalization { id: string; locale: string; fields: Partial<Record<InfoField, string | null>> }
export interface AppInfo { id: string; state: string }
export interface StoreVersion { id: string; versionString: string; platform: string; state: string }

type Resource = { type?: unknown; id?: unknown; attributes?: Record<string, unknown> };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const malformed = (name: string) => new AscApiError(502, `${name}_malformed`, `App Store Connect returned incomplete or invalid ${name}`);

/** Do not decide from a partial, malformed, repeated, or foreign page. */
async function list(creds: AscApiCredentials, base: string, initial: string, type: string, name: string): Promise<Resource[]> {
  const items: Resource[] = [], ids = new Set<string>(), visited = new Set<string>();
  const origin = "https://api.appstoreconnect.apple.com";
  const isFilter = (key: string) => key.startsWith("filter[") || key.startsWith("exists[");
  const initialUrl = new URL(initial, origin);
  const filters = [...initialUrl.searchParams.entries()].filter(([key]) => isFilter(key)).sort();
  const sameFilters = (url: URL) => JSON.stringify([...url.searchParams.entries()].filter(([key]) => isFilter(key)).sort()) === JSON.stringify(filters);
  let path: string | null = initial;
  let total: number | undefined;
  for (let page = 0; path; page++) {
    if (page >= 5) throw new AscApiError(502, `${name}_too_long`, `App Store Connect ${name} exceeds five pages`);
    if (visited.has(path)) throw malformed(name);
    visited.add(path);
    const res: unknown = await ascRequest(creds, "GET", path);
    // Apple's collection response requires links.self. Without links we cannot
    // distinguish a complete collection from a truncated provider response.
    if (!object(res) || !Array.isArray(res.data) || !object(res.links) || typeof res.links.self !== "string") throw malformed(name);
    let self: URL;
    try { self = new URL(res.links.self, new URL(path, origin)); } catch { throw malformed(name); }
    if (!sameOriginAscPath(self.href) || self.pathname !== base || self.username || self.password || self.hash || !sameFilters(self)) throw malformed(name);
    if (res.meta !== undefined) {
      if (!object(res.meta) || !object(res.meta.paging) || !Number.isInteger(res.meta.paging.limit) || (res.meta.paging.limit as number) < 1) throw malformed(name);
      const count = res.meta.paging.total;
      if (count !== undefined) {
        if (!Number.isSafeInteger(count) || (count as number) < 0 || (total !== undefined && total !== count)) throw malformed(name);
        total = count as number;
      }
      if (res.meta.paging.nextCursor != null && (typeof res.meta.paging.nextCursor !== "string" || !res.meta.paging.nextCursor || res.links.next == null)) throw malformed(name);
    }
    for (const raw of res.data) {
      if (!object(raw) || raw.type !== type || typeof raw.id !== "string" || !raw.id || ids.has(raw.id)) throw malformed(name);
      ids.add(raw.id); items.push(raw);
    }
    const next = res.links.next;
    if (next == null) { path = null; continue; }
    if (typeof next !== "string" || !next) throw malformed(name);
    let nextUrl: URL;
    try { nextUrl = new URL(next, new URL(path, origin)); } catch { throw malformed(name); }
    const nextPath = sameOriginAscPath(nextUrl.href);
    if (!nextPath || nextUrl.pathname !== base || nextUrl.username || nextUrl.password || nextUrl.hash || !sameFilters(nextUrl)) throw malformed(name);
    path = nextPath;
  }
  if (total !== undefined && total !== items.length) throw malformed(name);
  return items.sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
}

export async function listOwnedVersions(creds: AscApiCredentials, appId: string): Promise<StoreVersion[]> {
  const base = `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions`;
  const raw = await list(creds, base, `${base}?limit=200`, "appStoreVersions", "app_store_versions");
  return raw.map((r) => {
    const a = r.attributes;
    const state = a?.appVersionState ?? a?.appStoreState;
    if (typeof r.id !== "string" || !a || typeof a.versionString !== "string" || !a.versionString || typeof a.platform !== "string" || !a.platform || typeof state !== "string" || !state) throw malformed("app_store_versions");
    return { id: r.id, versionString: a.versionString, platform: a.platform, state };
  });
}

export async function listAppInfos(creds: AscApiCredentials, appId: string): Promise<AppInfo[]> {
  const base = `/v1/apps/${encodeURIComponent(appId)}/appInfos`;
  return (await list(creds, base, `${base}?limit=200`, "appInfos", "app_infos")).map((r) => {
    const state = r.attributes?.state;
    // The deprecated appStoreState has a different enum; do not use it to infer editability.
    if (typeof r.id !== "string" || typeof state !== "string" || !state) throw malformed("app_infos");
    return { id: r.id, state };
  });
}

export async function listInfoLocalizations(creds: AscApiCredentials, infoId: string): Promise<InfoLocalization[]> {
  const base = `/v1/appInfos/${encodeURIComponent(infoId)}/appInfoLocalizations`;
  const locales = new Set<string>();
  return (await list(creds, base, `${base}?limit=200`, "appInfoLocalizations", "app_info_localizations")).map((r) => {
    const a = r.attributes;
    if (typeof r.id !== "string" || !a || typeof a.locale !== "string" || !a.locale || locales.has(a.locale)) throw malformed("app_info_localizations");
    locales.add(a.locale);
    const fields: InfoLocalization["fields"] = {};
    for (const field of ["name", "subtitle"] as const) {
      if (field in a) {
        if (a[field] !== null && typeof a[field] !== "string") throw malformed("app_info_localizations");
        fields[field] = a[field] as string | null;
      }
    }
    return { id: r.id, locale: a.locale, fields };
  });
}

export async function listVersionLocales(creds: AscApiCredentials, versionId: string): Promise<string[]> {
  const base = `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`;
  const rows = await list(creds, base, `${base}?limit=200`, "appStoreVersionLocalizations", "app_store_version_localizations");
  const locales = new Set<string>();
  for (const row of rows) {
    const locale = row.attributes?.locale;
    if (typeof locale !== "string" || !locale || locales.has(locale)) throw malformed("app_store_version_localizations");
    locales.add(locale);
  }
  return [...locales].sort();
}

export async function listPrimaryCategories(creds: AscApiCredentials, platform: string): Promise<string[]> {
  const base = "/v1/appCategories";
  const rows = await list(creds, base, `${base}?limit=200&exists[parent]=false&filter[platforms]=${encodeURIComponent(platform)}`, "appCategories", "app_categories");
  return rows.map((r) => r.id as string);
}

export async function categoryRelationship(creds: AscApiCredentials, infoId: string, relationship: "primaryCategory" | "primarySubcategoryOne" | "primarySubcategoryTwo"): Promise<string | null> {
  const res: unknown = await ascRequest(creds, "GET", `/v1/appInfos/${encodeURIComponent(infoId)}/relationships/${relationship}`);
  if (!object(res) || !("data" in res)) throw malformed("app_info_category");
  if (res.data === null) return null;
  if (!object(res.data) || res.data.type !== "appCategories" || typeof res.data.id !== "string" || !res.data.id) throw malformed("app_info_category");
  return res.data.id;
}

export async function writeInfoLocalization(creds: AscApiCredentials, infoId: string, locale: string, id: string | null, fields: Partial<Record<InfoField, string>>): Promise<string> {
  if (id) {
    await ascRequest(creds, "PATCH", `/v1/appInfoLocalizations/${encodeURIComponent(id)}`, { data: { type: "appInfoLocalizations", id, attributes: fields } });
    return id;
  }
  const result: unknown = await ascRequest(creds, "POST", "/v1/appInfoLocalizations", {
    data: { type: "appInfoLocalizations", attributes: { locale, ...fields }, relationships: { appInfo: { data: { type: "appInfos", id: infoId } } } },
  });
  if (!object(result) || !object(result.data) || result.data.type !== "appInfoLocalizations" || typeof result.data.id !== "string" || !result.data.id) throw malformed("app_info_localization_create");
  return result.data.id;
}

export async function writePrimaryCategory(creds: AscApiCredentials, infoId: string, category: string): Promise<void> {
  await ascRequest(creds, "PATCH", `/v1/appInfos/${encodeURIComponent(infoId)}`, {
    data: { type: "appInfos", id: infoId, relationships: { primaryCategory: { data: { type: "appCategories", id: category } } } },
  });
}
