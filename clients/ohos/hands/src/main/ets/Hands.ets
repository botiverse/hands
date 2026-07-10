import { common } from '@kit.AbilityKit';
import { HandsAnalytics } from './HandsAnalytics';
import { HandsCrashUploader } from './HandsCrashUploader';
import { HandsCrashReporter } from './HandsCrashReporter';
import { HandsFaultWatcher } from './HandsFaultWatcher';

/**
 * Hands SDK entry point for HarmonyOS. All configuration is runtime
 * parameters — the SDK ships nothing app-specific; the client key follows
 * the Sentry-DSN model (identifies the app, ships in the bundle, rotatable
 * from the Hands console).
 */
export interface HandsConfig {
  /** Hands server origin, e.g. https://hands.build (no trailing /). */
  baseUrl: string;
  /** App slug in the Hands console. */
  appSlug: string;
  /** Release channel this build reports under (Hands routing/archival field). */
  channel: string;
  /** Per-app client key (qk_…) required by the feedback endpoint. */
  clientKey: string;
}

export class Hands {
  private static current: HandsConfig | null = null;

  /**
   * Call once, as early as possible (UIAbility onCreate). Passing the
   * ability context also wires the internal launch logic — a throttled
   * device-analytics ping and upload of any pending crash reports — so the
   * app only calls this one method.
   */
  static install(config: HandsConfig, context?: common.UIAbilityContext): void {
    const trimmed: HandsConfig = {
      baseUrl: config.baseUrl.endsWith('/')
        ? config.baseUrl.substring(0, config.baseUrl.length - 1)
        : config.baseUrl,
      appSlug: config.appSlug,
      channel: config.channel,
      clientKey: config.clientKey,
    };
    Hands.current = trimmed;
    if (context) {
      // Register the crash observer synchronously so a crash during startup
      // is still captured.
      HandsCrashReporter.install(context);
      // System-level fault watcher: native crashes + app freezes that never
      // reach errorManager (delivered by the OS, including on next launch).
      HandsFaultWatcher.install(context);
      // Device ping + pending-crash upload off the launch critical path.
      setTimeout(() => {
        HandsAnalytics.reportDevice(context).catch((): void => {});
        HandsCrashUploader.enforceRetention(context);
        HandsCrashUploader.uploadPending(context).catch((): void => {});
      }, 3000);
    }
  }

  static get config(): HandsConfig {
    const config = Hands.current;
    if (config === null) {
      throw new Error('Hands.install(config) must be called before using the SDK');
    }
    return config;
  }

  static get started(): boolean {
    return Hands.current !== null;
  }
}
