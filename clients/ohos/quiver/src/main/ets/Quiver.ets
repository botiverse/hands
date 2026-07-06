import { common } from '@kit.AbilityKit';
import { QuiverAnalytics } from './QuiverAnalytics';
import { QuiverCrashUploader } from './QuiverCrashUploader';
import { QuiverCrashReporter } from './QuiverCrashReporter';

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

  /**
   * Call once, as early as possible (UIAbility onCreate). Passing the
   * ability context also wires the internal launch logic — a throttled
   * device-analytics ping and upload of any pending crash reports — so the
   * app only calls this one method.
   */
  static install(config: QuiverConfig, context?: common.UIAbilityContext): void {
    const trimmed: QuiverConfig = {
      baseUrl: config.baseUrl.endsWith('/')
        ? config.baseUrl.substring(0, config.baseUrl.length - 1)
        : config.baseUrl,
      appSlug: config.appSlug,
      channel: config.channel,
      clientKey: config.clientKey,
    };
    Quiver.current = trimmed;
    if (context) {
      // Register the crash observer synchronously so a crash during startup
      // is still captured.
      QuiverCrashReporter.install(context);
      // Device ping + pending-crash upload off the launch critical path.
      setTimeout(() => {
        QuiverAnalytics.reportDevice(context).catch((): void => {});
        QuiverCrashUploader.enforceRetention(context);
        QuiverCrashUploader.uploadPending(context).catch((): void => {});
      }, 3000);
    }
  }

  static get config(): QuiverConfig {
    const config = Quiver.current;
    if (config === null) {
      throw new Error('Quiver.install(config) must be called before using the SDK');
    }
    return config;
  }

  static get started(): boolean {
    return Quiver.current !== null;
  }
}
