export const APP_PLATFORMS = ["android", "ios", "ohos", "electron", "node", "web", "desktop"] as const;

export type AppPlatform = (typeof APP_PLATFORMS)[number];

export function isAppPlatform(value: unknown): value is AppPlatform {
  return typeof value === "string" && (APP_PLATFORMS as readonly string[]).includes(value);
}

/**
 * What a desktop app is built with. Descriptive only: Hands stores and shows it,
 * nothing branches on it. A desktop app is released the same way whatever its runtime.
 */
export const APP_RUNTIMES = ["jvm", "electron", "native", "tauri", "other"] as const;

export type AppRuntime = (typeof APP_RUNTIMES)[number];

export function isAppRuntime(value: unknown): value is AppRuntime {
  return typeof value === "string" && (APP_RUNTIMES as readonly string[]).includes(value);
}
