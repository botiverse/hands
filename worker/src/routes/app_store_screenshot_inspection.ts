/** Read screenshot-set metadata for one app's version; no store writes. */
import { AscApiError, ascRequest, getScreenshotSetWithScreenshots, listScreenshotSets, listVersionLocalizations, sameOriginAscPath, type AscApiCredentials } from "../lib/asc_api";
import { ASC_LOCALE_RE } from "../lib/app_store_screenshots";
import { type AdminContext, AppStoreReleaseError, ascAppIdFor, fail, loadCredentials } from "./app_store_release";

/** This read-only endpoint can examine later pages without changing write routes' ownership boundaries. */
async function assertOwnedInspectionVersion(creds: AscApiCredentials, ascAppId: string, versionId: string): Promise<void> {
  const basePath = `/v1/apps/${encodeURIComponent(ascAppId)}/appStoreVersions`;
  let path: string | null = `${basePath}?limit=200`;
  for (let page = 0; path; page++) {
    if (page >= 5) {
      throw new AscApiError(502, "app_store_version_list_too_long", "App Store Connect version list exceeded 5 pages");
    }
    const versions: { data?: Array<{ id?: unknown }>; links?: { next?: unknown } } = await ascRequest(creds, "GET", path);
    if (!Array.isArray(versions?.data) || versions.data.some((v) => !v || typeof v.id !== "string" || !v.id)) {
      throw new AscApiError(502, "app_store_version_list_malformed", "App Store Connect returned a malformed version list");
    }
    if (versions.data.some((v) => v.id === versionId)) return;
    const next = versions.links?.next;
    if (next == null) { path = null; continue; }
    if (typeof next !== "string") {
      throw new AscApiError(502, "app_store_version_list_malformed", "App Store Connect returned an invalid version next page");
    }
    const nextPath = sameOriginAscPath(next);
    if (!nextPath || new URL(next).pathname !== basePath) {
      throw new AscApiError(502, "app_store_version_list_malformed", "App Store Connect returned an unsafe version next page");
    }
    path = nextPath;
  }
  throw new AppStoreReleaseError(404, "VERSION_NOT_IN_APP", "app store version does not belong to this app");
}

export async function handleInspectAppStoreScreenshots(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  const locale = c.req.query("locale");
  try {
    if (locale !== undefined && !ASC_LOCALE_RE.test(locale)) {
      throw new AppStoreReleaseError(400, "INVALID_LOCALE", "locale must be an App Store Connect locale, for example en-US");
    }
    const creds = await loadCredentials(c, appId);
    const ascAppId = await ascAppIdFor(c, appId);
    // ASC team credentials are not app-scoped; do not accept arbitrary version IDs.
    await assertOwnedInspectionVersion(creds, ascAppId, versionId);
    const allLocales = await listVersionLocalizations(creds, versionId);
    const selected = locale ? allLocales.filter((item) => item.locale === locale) : allLocales;
    if (locale && selected.length === 0) {
      throw new AppStoreReleaseError(404, "LOCALIZATION_NOT_FOUND", "locale does not exist on this version");
    }
    const localizations = [];
    for (const item of selected) {
      const sets = [];
      for (const set of await listScreenshotSets(creds, item.id)) {
        const screenshots = await getScreenshotSetWithScreenshots(creds, set.id);
        sets.push({ id: set.id, display_type: set.displayType, screenshots: screenshots.map((shot) => ({
          id: shot.id, file_name: shot.fileName, width: shot.width, height: shot.height, state: shot.state,
        })) });
      }
      localizations.push({ locale: item.locale, sets });
    }
    return c.json({ version_id: versionId, localizations });
  } catch (error) {
    return fail(c, error);
  }
}
