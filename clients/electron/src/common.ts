// Shared, electron-free helpers and types for the Hands Electron SDK. Kept
// pure so it can be unit-tested without an Electron runtime.

/** IPC channel renderers use to forward scope updates to the main process. */
export const CONTEXT_CHANNEL = "hands:context";
export const DEFAULT_HANDS_ENDPOINT = "https://hands.build";
// Preserve existing install identity and throttling across the Quiver -> Hands rename.
export const METRICS_STATE_FILENAME = "quiver-metrics.json";

export interface HandsBreadcrumb {
  message: string;
  category?: string;
  level?: "debug" | "info" | "warning" | "error";
  timestamp?: number;
  data?: Record<string, unknown>;
}

export interface CrashContext {
  tags: Record<string, string>;
  extra: Record<string, unknown>;
  user: Record<string, string> | null;
  breadcrumbs: HandsBreadcrumb[];
}

export interface HandsElectronOptions {
  /** Hands app slug (the distribution target). */
  appSlug: string;
  /** Public client key (Sentry-DSN model). Safe to ship in the app bundle. */
  clientKey: string;
  /** Hands business origin. Defaults to DEFAULT_HANDS_ENDPOINT. */
  endpoint?: string;
  /** Crashpad productName; defaults to appSlug. */
  productName?: string;
  /** App release / version (version_name). Defaults to app.getVersion(). */
  release?: string;
  /** Hands version_code (integer) — used to look up the breakpad-symbols asset. */
  versionCode?: number;
  /** Deployment environment / channel, e.g. "stable" | "beta". */
  environment?: string;
  /** Whether Crashpad uploads dumps. Defaults to true. */
  uploadToServer?: boolean;
  /** Static annotations attached to every crash (Crashpad globalExtra). */
  extra?: Record<string, string>;
  /** Called on renderer / child-process termination (incl. non-dump reasons). */
  onCrash?: (info: CrashInfo) => void;
}

export interface CrashInfo {
  processType: string;
  reason: string;
  exitCode: number;
}

/** Runtime facts the main process reads off `process` / `app`. */
export interface RuntimeInfo {
  platform: string;
  arch: string;
  versions: Record<string, string | undefined>;
}

/** Coerce any value to the string that Crashpad annotations require. */
export function toParam(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build the Sentry-electron-style annotation set sent with every minidump.
 * The server folds these into the crash ticket's metadata.
 */
export function buildGlobalExtra(
  options: HandsElectronOptions,
  runtime: RuntimeInfo,
  appVersion: string,
): Record<string, string> {
  const env = options.environment ?? "production";
  const extra: Record<string, string> = {
    product_type: "electron",
    version: options.release ?? appVersion,
    environment: env,
    channel: env,
    platform: runtime.platform,
    arch: runtime.arch,
    process_type: "main",
  };
  if (options.versionCode !== undefined) extra.version_code = String(options.versionCode);
  if (runtime.versions.electron) extra.electron_version = runtime.versions.electron;
  if (runtime.versions.chrome) extra.chrome_version = runtime.versions.chrome;
  if (runtime.versions.node) extra.node_version = runtime.versions.node;
  for (const [key, value] of Object.entries(options.extra ?? {})) extra[key] = toParam(value);
  return extra;
}

/** Build the minidump submit URL Crashpad POSTs to (client key in the query). */
export function buildSubmitURL(options: HandsElectronOptions): string {
  const endpoint = (options.endpoint ?? DEFAULT_HANDS_ENDPOINT).replace(/\/+$/, "");
  return (
    `${endpoint}/public/v2/apps/${encodeURIComponent(options.appSlug)}/minidump` +
    `?client_key=${encodeURIComponent(options.clientKey)}`
  );
}
