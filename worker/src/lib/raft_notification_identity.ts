/** Stable notification identity shared by the renderer and delivery route. */
const FEEDBACK_THREAD_EVENTS = new Set([
  "feedback:new",
  "feedback:comment_created",
  "feedback:status_changed",
]);

export function isFeedbackThreadEvent(event: unknown): event is string {
  return typeof event === "string" && FEEDBACK_THREAD_EVENTS.has(event);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Keep state changes for the same logical object in a single Raft thread. */
export async function notificationObjectKey(body: Record<string, unknown>): Promise<string> {
  const payload = record(body.payload);
  const event = typeof body.event === "string" ? body.event : "event";
  if (event === "google_play:release_state_changed") {
    const packageName = typeof payload.package_name === "string" ? payload.package_name : "";
    const track = typeof payload.track === "string" ? payload.track : "";
    const version = typeof payload.version_code === "number" || typeof payload.version_code === "string"
      ? String(payload.version_code) : "";
    if (/^[A-Za-z0-9_.-]{1,255}$/.test(packageName)
      && /^[A-Za-z0-9_.:-]{1,120}$/.test(track) && /^\d{1,16}$/.test(version)) {
      return `${event}:${JSON.stringify([packageName, track, version])}`;
    }
  }
  // Preserve the original feedback:new key for existing ticket threads.
  if (isFeedbackThreadEvent(event) && typeof payload.ticket_id === "string" && payload.ticket_id.length > 0) {
    return `feedback:new:${payload.ticket_id.slice(0, 160)}`;
  }
  const resource = record(payload.resource);
  const candidates = [
    payload.ticket_id,
    payload.release_id,
    payload.build_id,
    payload.version_id,
    payload.submission_id,
    payload.app_store_version_id,
    resource.id,
    payload.version_string,
    payload.package_name,
  ];
  const first = candidates.find((value) => typeof value === "string" || typeof value === "number");
  if (first !== undefined) return `${String(body.event ?? "event")}:${String(first).slice(0, 160)}`;
  return `${String(body.event ?? "event")}:${(await sha256Hex(JSON.stringify(payload))).slice(0, 32)}`;
}
