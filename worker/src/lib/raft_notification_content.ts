/** Safe presentation of Hands events for Raft. Transport and retries live in the route. */
import { isFeedbackThreadEvent } from "./raft_notification_identity";

type Payload = Record<string, unknown>;
type FieldRenderer = (payload: Payload) => string[];
interface Presentation {
  icon: string;
  leading?: FieldRenderer;
  details?: FieldRenderer;
  footer?: FieldRenderer;
}

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_FIELD_LENGTH = 500;
const MAX_FEEDBACK_PREVIEW_LENGTH = 180;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLI_APP_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

const SAFE_PAYLOAD_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["kind", "kind"], ["status", "status"], ["previous status", "previous_status"],
  ["state", "state"], ["previous state", "previous_state"],
  ["version", "version_string"], ["version", "version"], ["version name", "version_name"],
  ["build", "build_number"], ["version code", "version_code"], ["track", "track"],
  ["channel", "channel"], ["distribution", "distribution"], ["platform", "platform"],
  ["failure code", "failure_code"], ["reason code", "reason_code"], ["ticket", "ticket_id"],
  ["release", "release_id"], ["build id", "build_id"], ["package", "package_name"],
];

function record(value: unknown): Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Payload : {};
}

function safeValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value).replace(/[\r\n]+/g, " ").trim();
  return text.length > 0 ? text.slice(0, MAX_FIELD_LENGTH) : null;
}

// User-supplied text cannot create Raft mentions, links, or Markdown. This is
// a bounded preview, not a secret scrubber.
function safePreview(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/https?:\/\/[^\s]+/gi, "[link]").replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  const shortened = chars.length > limit ? `${chars.slice(0, limit).join("")}…` : cleaned;
  return shortened.replace(/[@#]/g, "$&\u200b").replace(/[\\`*_{}\[\]()<>!|]/g, "\\$&");
}

function feedbackPreview(payload: Payload): string[] {
  if (payload.kind !== "feedback" && payload.kind !== "bug") return [];
  const preview = safePreview(payload.message, MAX_FEEDBACK_PREVIEW_LENGTH);
  return preview ? [`Feedback: ${preview}`] : [];
}

function testflightDetails(payload: Payload): string[] {
  const lines: string[] = [];
  const notes = record(payload.what_to_test);
  const locales = Object.keys(notes).filter((locale) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)).sort();
  const locale = locales.includes("zh-Hans") ? "zh-Hans" : locales[0];
  const note = locale ? safePreview(notes[locale], MAX_FIELD_LENGTH) : null;
  if (locale && note) lines.push(`Test notes (${locale}): ${note}`);
  const commit = safeValue(payload.source_commit);
  if (commit && /^[0-9a-f]{7,64}$/i.test(commit)) lines.push(`source commit: ${commit}`);
  return lines;
}

function appleReviewFooter(payload: Payload): string[] {
  return payload.state === "REJECTED" ? ["Apple's review message is available in App Store Connect."] : [];
}

// Event-specific presentation is registered here; the common safe field and
// footer rules below apply consistently to every event.
const PRESENTATIONS = new Map<string, Presentation>([
  ["feedback:new", { icon: "📮", leading: feedbackPreview }],
  ["feedback:comment_created", { icon: "💬" }],
  ["feedback:status_changed", { icon: "🔄" }],
  ["app_store:version_state_changed", { icon: "🍎", footer: appleReviewFooter }],
  ["app_store:build_upload_state_changed", { icon: "📦" }],
  ["testflight:upload_processing", { icon: "📦" }],
  ["testflight:internal_distribution_ready", { icon: "✈️", details: testflightDetails }],
  ["testflight:external_state_changed", { icon: "✈️", details: testflightDetails }],
  ["google_play:release_state_changed", { icon: "▶️" }],
  ["google_play:submission_succeeded", { icon: "✅" }],
  ["google_play:submission_failed", { icon: "⚠️" }],
  ["appgallery:invitation_state_changed", { icon: "📱" }],
  ["appgallery:package_state_changed", { icon: "📦" }],
  ["release:published", { icon: "🚀" }],
  ["release:rolled_back", { icon: "↩️" }],
  ["release:channel_emptied", { icon: "🛑" }],
]);

const ROLLOUT_FIELDS = new Map<string, string>([
  ["release", "rollout"],
  ["google_play", "rollout_percent"],
]);

function standardFields(payload: Payload, build: Payload): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [label, key] of SAFE_PAYLOAD_FIELDS) {
    if (seen.has(label)) continue;
    const value = safePreview(safeValue(payload[key]) ?? safeValue(build[key]), MAX_FIELD_LENGTH);
    if (!value) continue;
    seen.add(label);
    lines.push(`${label}: ${value}`);
  }
  for (const [label, value] of [
    ["description", payload.state_label],
    ["version transition", payload.version_transition],
    ["version code transition", payload.version_code_transition],
    ["groups", payload.groups_display],
  ] as const) {
    const text = safePreview(value, MAX_FIELD_LENGTH);
    if (text) lines.push(`${label}: ${text}`);
  }
  return lines;
}

function rolloutField(event: string, payload: Payload): string[] {
  const separator = event.indexOf(":");
  const field = separator >= 0 ? ROLLOUT_FIELDS.get(event.slice(0, separator)) : undefined;
  const value = field ? payload[field] : null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? [`rollout: ${value}%`] : [];
}

function truncateMessage(value: string, limit: number): string {
  const clipped = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

interface NotificationApp {
  id: string;
  slug: string | null;
  name: string | null;
}

export function formatRaftNotificationMessage(body: Payload, knownApp?: NotificationApp): string {
  const event = safeValue(body.event) ?? "hands:event";
  const payload = record(body.payload);
  const app = record(payload.app);
  const build = record(payload.build);
  const presentation = PRESENTATIONS.get(event);
  const lines = [`${presentation ? `${presentation.icon} ` : ""}**Hands · ${event}**`];
  const footer: string[] = [];
  const appId = safeValue(knownApp?.id) ?? safeValue(body.app_id) ?? safeValue(app.id);
  const appSlug = safeValue(knownApp?.slug) ?? safeValue(payload.app_slug) ?? safeValue(app.slug);
  const appName = safePreview(knownApp?.name, 160) ?? safePreview(app.name, 160) ?? safePreview(appSlug, 160);
  const appIdDisplay = safePreview(appId, 160);
  if (appName && appIdDisplay) lines.push(`App: ${appName} (${appIdDisplay})`);
  else if (appName || appIdDisplay) lines.push(`App: ${appName ?? appIdDisplay}`);
  lines.push(...(presentation?.leading?.(payload) ?? []));
  lines.push(...standardFields(payload, build));

  const observation = safePreview(payload.observation_display, MAX_FIELD_LENGTH);
  if (observation) footer.push(`observation: ${observation}`);
  lines.push(...rolloutField(event, payload), ...(presentation?.details?.(payload) ?? []));
  const link = safeValue(payload.app_store_connect_url);
  if (link && /^https:\/\/appstoreconnect\.apple\.com\//.test(link)) footer.push(`Review: ${link}`);
  footer.push(...(presentation?.footer?.(payload) ?? []));

  // Hands delivery timestamps are milliseconds; preserve provider timestamps.
  const deliveredAt = typeof body.delivered_at === "number"
    && Number.isFinite(body.delivered_at) && Math.abs(body.delivered_at) <= 8.64e15
    ? new Date(body.delivered_at).toISOString()
    : safeValue(body.delivered_at);
  const occurred = safePreview(safeValue(payload.occurred_at) ?? deliveredAt, MAX_FIELD_LENGTH);
  if (occurred) footer.push(`occurred: ${occurred}`);
  const ticketId = typeof payload.ticket_id === "string" && UUID_RE.test(payload.ticket_id) ? payload.ticket_id : null;
  // The CLI treats a 36-character, five-part slug as an app id.
  const slugLooksLikeId = appSlug?.length === 36 && appSlug.split("-").length === 5;
  const cliApp = appSlug && CLI_APP_SLUG_RE.test(appSlug) && !slugLooksLikeId
    ? appSlug : appId && UUID_RE.test(appId) ? appId : null;
  if (isFeedbackThreadEvent(event) && ticketId && cliApp) {
    footer.push(`📖 View more: \`hands feedback show ${cliApp} ${ticketId}\``);
  }
  const content = lines.join("\n");
  if (footer.length === 0) return truncateMessage(content, MAX_MESSAGE_LENGTH);
  const tail = footer.join("\n");
  return `${truncateMessage(content, MAX_MESSAGE_LENGTH - tail.length - 1)}\n${tail}`;
}
