/** Read screenshot-set metadata for one app's version; no store writes. */
import { getScreenshotSetWithScreenshots, listScreenshotSets, listVersionLocalizations } from "../lib/asc_api";
import { ASC_LOCALE_RE } from "../lib/app_store_screenshots";
import { type AdminContext, AppStoreReleaseError, ascAppIdFor, assertOwnedVersion, fail, loadCredentials } from "./app_store_release";

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
    await assertOwnedVersion(creds, ascAppId, versionId);
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
