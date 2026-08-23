import { common } from '@kit.AbilityKit';
import { HandsAnalytics } from './HandsAnalytics';
import { HandsCrashUploader } from './HandsCrashUploader';
import { HandsCrashReporter } from './HandsCrashReporter';
import { HandsFaultWatcher } from './HandsFaultWatcher';
import { HandsFeedbackClient, HandsFeedbackExtras } from './HandsFeedbackClient';

/**
 * Hands SDK entry point for HarmonyOS. All configuration is runtime
 * parameters — the SDK ships nothing app-specific; the client key follows
 * the Sentry-DSN model (identifies the app, ships in the bundle, rotatable
 * from the Hands console).
 */
export interface HandsConfig {
  /** Hands server origin, e.g. https://your-hands-origin.example (no trailing /). */
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
        try {
          HandsCrashUploader.enforceRetention(context);
        } catch (_error) {
          // Retention is best-effort; it must never suppress upload of an
          // already-complete pending crash pair.
        }
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

  // --- Breadcrumbs & Error Capture (P0-1/P0-2) ---

  private static breadcrumbs: BreadcrumbEntry[] = [];
  private static readonly MAX_BREADCRUMBS: number = 100;

  /**
   * Record a breadcrumb (max 100, ring buffer). Attached to both
   * captureException submissions and fatal crash reports.
   */
  static addBreadcrumb(category: string, message: string, level: string = 'info'): void {
    Hands.breadcrumbs.push({
      timestamp: Date.now(),
      category,
      message,
      level,
    });
    while (Hands.breadcrumbs.length > Hands.MAX_BREADCRUMBS) {
      Hands.breadcrumbs.shift();
    }
  }

  /** Snapshot current breadcrumbs as a JSON string. */
  static snapshotBreadcrumbs(): string {
    return JSON.stringify(Hands.breadcrumbs);
  }

  /** Clear all breadcrumbs (e.g. on logout / session boundary). */
  static clearBreadcrumbs(): void {
    Hands.breadcrumbs = [];
  }

  /**
   * Capture a handled error and submit it as kind "error" with structured
   * metadata and the current breadcrumb trail.
   */
  static async captureException(
    context: common.UIAbilityContext,
    error: Error,
    message?: string,
  ): Promise<string> {
    const exceptionClass: string = error.name || 'Error';
    const exceptionMessage: string = error.message || exceptionClass;
    const stacktrace: string = (error.stack ?? '').substring(0, 50000);

    const extras: HandsFeedbackExtras[] = [
      { key: 'exception_class', value: exceptionClass },
      { key: 'exception_message', value: exceptionMessage },
      { key: 'stacktrace', value: stacktrace },
      { key: 'handled', value: 'true' },
      { key: 'breadcrumbs', value: Hands.snapshotBreadcrumbs() },
    ];

    const ticketMessage: string =
      (message ?? `${exceptionClass}: ${exceptionMessage}`).substring(0, 10000);

    return HandsFeedbackClient.submit(context, ticketMessage, 'error', [], extras);
  }
}

interface BreadcrumbEntry {
  timestamp: number;
  category: string;
  message: string;
  level: string;
}
