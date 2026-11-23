/**
 * What an upstream service (Google Play, Google OAuth, Cloud Storage, App Store
 * Connect, AppGallery Connect) said when it refused a request, in a shape every
 * Hands error response and receipt can carry: `upstream: { service, http_status,
 * message }`. The CLI and the admin UI print it under Hands' own explanation, so
 * an error Hands does not recognise still says what the upstream said.
 *
 * The message is upstream prose. The adapter already redacts it; it is redacted
 * again here because this is the boundary where it becomes durable (receipts)
 * and visible to every member who can read the app.
 */
export type UpstreamService =
  | "google_play"
  | "google_oauth"
  | "google_cloud_storage"
  | "app_store_connect"
  | "appgallery_connect";

export type UpstreamDetail = { service: UpstreamService; http_status?: number; message: string };

export const UPSTREAM_SERVICE_LABELS: Record<UpstreamService, string> = {
  google_play: "Google Play",
  google_oauth: "Google sign-in",
  google_cloud_storage: "Google Cloud Storage",
  app_store_connect: "App Store Connect",
  appgallery_connect: "AppGallery Connect",
};

/**
 * At most 300 characters (clipped after redaction), control characters
 * flattened, percent-encoding decoded, URL queries dropped, and OAuth tokens,
 * JWTs, refresh tokens, Google API keys and client secrets, PEM blocks, email
 * addresses and any long opaque run (32+ token characters) replaced by [redacted]. Same rule as the adapter's
 * redactProviderText; package names, version codes and track names stay.
 */
export function redactUpstreamText(value: string): string {
  // Redact BEFORE clipping, so a secret cut at the edge cannot survive as a short
  // tail; percent-encoded text is decoded first so an encoded token is matched too.
  let text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  try { text = decodeURIComponent(text); } catch { /* keep as is */ }
  return text
    // URLs: keep where they point, drop query and fragment (project numbers, keys).
    .replace(/https?:\/\/[^\s?#"'<>]+[^\s"'<>]*/g, (url) => url.replace(/[?#].*$/, ""))
    .replace(/-----BEGIN[^-]*-----[\s\S]*?(?:-----END[^-]*-----|$)/g, "[redacted]")
    .replace(/ya29\.[\w.-]+|1\/\/[\w.-]+|GOCSPX-[\w-]+|AIza[\w-]+|eyJ[\w-]{2,}(?:\.[\w.-]+)?|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]")
    .slice(0, 300);
}

export function upstreamDetail(service: UpstreamService, message: unknown, httpStatus?: unknown): UpstreamDetail | undefined {
  if (typeof message !== "string" || !message.trim()) return undefined;
  const status = typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
    ? httpStatus : undefined;
  return { service, ...(status !== undefined ? { http_status: status } : {}), message: redactUpstreamText(message) };
}

/** The upstream part of a Google Play adapter error cause (`provider_message`), if any. */
export function upstreamFromPlayCause(cause: unknown): UpstreamDetail | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const c = cause as Record<string, unknown>;
  const service: UpstreamService = c.stage === "oauth_token" ? "google_oauth"
    : c.stage === "reports_storage" ? "google_cloud_storage" : "google_play";
  return upstreamDetail(service, c.provider_message, c.provider_http_status);
}

/** `{ upstream }` to spread into an error body, or nothing. */
export function withPlayUpstream(error: { cause?: unknown } | null | undefined): { upstream?: UpstreamDetail } {
  const upstream = upstreamFromPlayCause(error?.cause);
  return upstream ? { upstream } : {};
}
