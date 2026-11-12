/**
 * Shared wording for BUNDLE_ID_NOT_CONFIGURED. Apple routes that resolve the
 * App Store Connect app from the main channel's bundle id (TestFlight crashes,
 * screenshot feedback, Beta App Description) answer with the exact command that
 * fixes it, so the caller does not have to search for it.
 *
 * There is deliberately no fallback to a build's bundle_id: build-metadata.json
 * is supplied by the uploader, and the bundle id selects which App Store
 * Connect app these routes read from and delete in. Only the channel setting,
 * an explicit app-level choice, decides that.
 */
export const BUNDLE_ID_NOT_CONFIGURED_MESSAGE = "the main channel has no App Store bundle id";

export function bundleIdNotConfiguredNextAction(appId: string): string {
  return `set it with: hands channels update ${appId} main --bundle-id <bundle id>`;
}
