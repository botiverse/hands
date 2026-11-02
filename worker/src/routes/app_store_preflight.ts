/**
 * GET /api/apps/:appId/app-store/versions/:versionId/preflight
 *
 * Read-only submission readiness for one App Store version. Every App Store Connect
 * call made here is a GET (see lib/app_store_preflight.ts); safe for viewers, CI and
 * agents. Submit is not blocked by it yet: the CLI's submit dry run prints it.
 */
import { evaluatePreflight, gatherPreflightSnapshot } from "../lib/app_store_preflight";
import { type AdminContext, ascAppIdFor, assertOwnedVersion, fail, loadCredentials } from "./app_store_release";

export async function handleGetAppStorePreflight(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  try {
    const creds = await loadCredentials(c, appId);
    const ascAppId = await ascAppIdFor(c, appId);
    await assertOwnedVersion(creds, ascAppId, versionId);
    const snapshot = await gatherPreflightSnapshot(creds, ascAppId, versionId);
    return c.json(evaluatePreflight(snapshot));
  } catch (error) {
    return fail(c, error);
  }
}
