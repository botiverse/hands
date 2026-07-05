/**
 * Quiver SDK entry point for HarmonyOS. All configuration is runtime
 * parameters — the SDK ships nothing app-specific; the client key follows
 * the Sentry-DSN model (identifies the app, ships in the bundle, rotatable
 * from the Quiver console).
 */
export interface QuiverConfig {
  /** Quiver server origin, e.g. https://quiver.example.com (no trailing /). */
  baseUrl: string;
  /** App slug in the Quiver console. */
  appSlug: string;
  /** Release channel this build reports under (Quiver routing/archival field). */
  channel: string;
  /** Per-app client key (qk_…) required by the feedback endpoint. */
  clientKey: string;
}

export class Quiver {
  private static current: QuiverConfig | null = null;

  /** Call once, as early as possible (ability onCreate). */
  static start(config: QuiverConfig): void {
    const trimmed: QuiverConfig = {
      baseUrl: config.baseUrl.endsWith('/')
        ? config.baseUrl.substring(0, config.baseUrl.length - 1)
        : config.baseUrl,
      appSlug: config.appSlug,
      channel: config.channel,
      clientKey: config.clientKey,
    };
    Quiver.current = trimmed;
  }

  static get config(): QuiverConfig {
    const config = Quiver.current;
    if (config === null) {
      throw new Error('Quiver.start(config) must be called before using the SDK');
    }
    return config;
  }

  static get started(): boolean {
    return Quiver.current !== null;
  }
}
