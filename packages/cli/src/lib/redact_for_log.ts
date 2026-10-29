/**
 * Strip anything credential-shaped from a raw error body before it reaches a log.
 *
 * This prints the bodies of 5xx responses that did not come from our Worker, so the
 * exact shape is unknown -- it could carry a signed URL (whose query string is the
 * credential), a bearer token, or a bearer-like query parameter. Redacting by pattern
 * rather than by expected field means an unexpected body still cannot leak.
 */
export function redactForLog(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s"'<>?]*)\?[^\s"'<>]*/g, "$1?<redacted>")
    .replace(/((?:token|secret|password|signature|credential|key)[A-Za-z0-9_-]*\s*[=:]\s*)("[^"]*"|[^\s,"&}]+)/gi, "$1<redacted>")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "<redacted>");
}

