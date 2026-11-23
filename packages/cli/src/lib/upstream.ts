/**
 * What an upstream service said, as Hands relays it (`upstream: { service,
 * http_status, message }`; worker/src/lib/upstream_error.ts). The message is
 * already redacted by Hands; the CLI only bounds and flattens it for a terminal.
 */
export type Upstream = { service?: string; http_status?: number; message?: string };

const LABELS: Record<string, string> = {
  google_play: "Google Play",
  google_oauth: "Google sign-in",
  google_cloud_storage: "Google Cloud Storage",
  app_store_connect: "App Store Connect",
  appgallery_connect: "AppGallery Connect",
};

export function upstreamLine(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Upstream;
  if (typeof u.message !== "string" || !u.message.trim()) return null;
  const who = (typeof u.service === "string" && LABELS[u.service]) || "The upstream service";
  const status = typeof u.http_status === "number" ? ` (HTTP ${u.http_status})` : "";
  const said = u.message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
  return `${who} said${status}: ${said}`;
}

/** `upstream` from a Hands error body: top level or under `error`. */
export function upstreamFromBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (b.upstream) return b.upstream;
  const error = b.error;
  return error && typeof error === "object" ? (error as Record<string, unknown>).upstream : undefined;
}
