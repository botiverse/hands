export const APP_PLATFORMS = ["android", "ios", "ohos", "electron", "node"] as const;

export type AppPlatform = (typeof APP_PLATFORMS)[number];

export function isAppPlatform(value: unknown): value is AppPlatform {
  return typeof value === "string" && (APP_PLATFORMS as readonly string[]).includes(value);
}
