/** Safe presentation of Hands events for Raft. Transport and retries live in the route. */
import { isFeedbackThreadEvent } from "./raft_notification_identity";

type Payload = Record<string, unknown>;
type FieldRenderer = (payload: Payload) => string[];
interface Presentation {
  icon: string;
  title: string;
  details?: FieldRenderer;
  footer?: FieldRenderer;
}

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_FIELD_LENGTH = 500;
const MAX_FEEDBACK_PREVIEW_LENGTH = 180;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLI_APP_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

const SAFE_PAYLOAD_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["kind", "kind"], ["track", "track"],
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

function safeNotes(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/https?:\/\/[^\s]+/gi, "[link]")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .split("\n").map((line) => line.replace(/[^\S\n]+/gu, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  const shortened = chars.length > limit ? `${chars.slice(0, limit).join("")}…` : cleaned;
  return shortened.replace(/[@#]/g, "$&\u200b").replace(/[\\`*_{}\[\]()<>!|]/g, "\\$&");
}

function feedbackPreview(payload: Payload): string[] {
  if (payload.kind !== "feedback" && payload.kind !== "bug") return [];
  const preview = safePreview(payload.message, MAX_FEEDBACK_PREVIEW_LENGTH);
  return preview ? [preview] : [];
}

function testflightDetails(payload: Payload): string[] {
  const lines: string[] = [];
  const notes = record(payload.what_to_test);
  const locales = Object.keys(notes).filter((locale) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)).sort();
  const locale = locales.includes("zh-Hans") ? "zh-Hans" : locales[0];
  const note = locale ? safeNotes(notes[locale], MAX_FIELD_LENGTH) : null;
  if (locale && note) {
    lines.push(note.includes("\n")
      ? `Test notes (${locale}):\n  ${note.replace(/\n/g, "\n  ")}`
      : `Test notes (${locale}): ${note}`);
  }
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
  ["app_store:version_state_changed", { icon: "🍎", title: "App Store version status changed", footer: appleReviewFooter }],
  ["app_store:build_upload_state_changed", { icon: "📦", title: "App Store build upload status changed" }],
  ["testflight:upload_processing", { icon: "📦", title: "TestFlight upload processing" }],
  ["testflight:internal_distribution_ready", { icon: "✈️", title: "TestFlight ready for internal testing", details: testflightDetails }],
  ["testflight:external_state_changed", { icon: "✈️", title: "TestFlight external testing status changed", details: testflightDetails }],
  ["testflight:crash_submission_created", { icon: "💥", title: "TestFlight crash report received" }],
  ["crash:new_group", { icon: "💥", title: "New crash group" }],
  ["crash:spike", { icon: "📈", title: "Crash spike" }],
  ["error:new_group", { icon: "⚠️", title: "New error group" }],
  ["error:spike", { icon: "📈", title: "Error spike" }],
  ["google_play:release_state_changed", { icon: "▶️", title: "Google Play release status changed" }],
  ["google_play:submission_succeeded", { icon: "✅", title: "Google Play submission succeeded" }],
  ["google_play:submission_failed", { icon: "⚠️", title: "Google Play submission failed" }],
  ["appgallery:invitation_state_changed", { icon: "📱", title: "AppGallery test status changed" }],
  ["appgallery:package_state_changed", { icon: "📦", title: "AppGallery package status changed" }],
  ["release:new", { icon: "📦", title: "Release created" }],
  ["release:draft_created", { icon: "📝", title: "Release draft created" }],
  ["release:superseded", { icon: "🔄", title: "Release superseded" }],
  ["release:published", { icon: "🚀", title: "Release published" }],
  ["release:rolled_back", { icon: "↩️", title: "Release rolled back" }],
  ["release:channel_emptied", { icon: "🛑", title: "Release channel has no active release" }],
  ["release:cancelled", { icon: "🛑", title: "Release cancelled" }],
  ["build:succeeded", { icon: "✅", title: "Build succeeded" }],
  ["build:failed", { icon: "⚠️", title: "Build failed" }],
]);

const ROLLOUT_FIELDS = new Map<string, string>([
  ["release", "rollout"],
  ["google_play", "rollout_percent"],
]);

function standardFields(payload: Payload, build: Payload, omitTicket = false): string[] {
  const lines: string[] = [];
  const value = (key: string) => safePreview(safeValue(payload[key]) ?? safeValue(build[key]), MAX_FIELD_LENGTH);
  for (const label of ["status", "state"] as const) {
    const current = value(label);
    const previous = value(`previous_${label}`);
    if (current) lines.push(`${label}: ${previous && previous !== current ? `${previous} → ` : ""}${current}`);
    else if (previous) lines.push(`previous ${label}: ${previous}`);
  }
  const version = value("version_string") ?? value("version");
  const versionName = value("version_name");
  const buildNumber = value("build_number");
  const versionCode = value("version_code");
  if (version || versionName) lines.push(`version: ${version ?? versionName}`);
  if (version && versionName && version !== versionName) lines.push(`version name: ${versionName}`);
  if (buildNumber) lines.push(`build: ${buildNumber}`);
  if (versionCode && versionCode !== buildNumber) lines.push(`version code: ${versionCode}`);
  const seen = new Set<string>();
  for (const [label, key] of SAFE_PAYLOAD_FIELDS) {
    if (label === "ticket" && omitTicket) continue;
    if (seen.has(label)) continue;
    const rendered = value(key);
    if (!rendered) continue;
    seen.add(label);
    lines.push(`${label}: ${rendered}`);
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

/** Current state for the card badge, independent of the formatted transition. */
export function raftNotificationCurrentState(body: Payload): string | null {
  const payload = record(body.payload);
  const build = record(payload.build);
  return safePreview(safeValue(payload.status) ?? safeValue(build.status)
    ?? safeValue(payload.state) ?? safeValue(build.state), MAX_FIELD_LENGTH);
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
  dashboardOrigin?: string | null;
}

function feedbackLink(origin: string | null | undefined, appId: string | null, ticketId: string | null): string | null {
  if (!origin || !appId || !ticketId || !UUID_RE.test(appId)) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return `${url.origin}/apps/${appId}/feedback/${ticketId}`;
  } catch {
    return null;
  }
}

function feedbackMessage(
  event: string, payload: Payload, build: Payload, appName: string | null,
  appId: string | null, cliApp: string | null, ticketId: string | null, occurred: string | null,
  dashboardOrigin: string | null | undefined,
): string {
  const kind = safeValue(payload.kind);
  const names = new Map<string, string>([
    ["feedback", "New feedback"], ["bug", "New bug report"],
    ["crash", "New crash report"], ["error", "New error report"],
  ]);
  const title = event === "feedback:comment_created" ? "New comment"
    : event === "feedback:status_changed" ? "Feedback status changed"
    : names.get(kind ?? "") ?? "New feedback report";
  const icon = event === "feedback:comment_created" ? "💬" : event === "feedback:status_changed" ? "🔄" : "📮";
  const app = appName ?? safePreview(appId, 160);
  // Keep comment/status notifications compact even when they are the first
  // event for a subscription. A validated dashboard link is also useful when
  // there is no earlier parent message containing the CLI command.
  const link = event !== "feedback:new" ? feedbackLink(dashboardOrigin, appId, ticketId) : null;
  const lines = [`${icon} **${title}${app ? ` · ${app}` : ""}**${link ? ` · [View feedback](${link})` : ""}`];
  if (event === "feedback:new") {
    lines.push(...feedbackPreview(payload));
    const version = safePreview(safeValue(payload.version_name) ?? safeValue(payload.version_string)
      ?? safeValue(payload.version) ?? safeValue(build.version), 160);
    const code = safePreview(safeValue(payload.version_code) ?? safeValue(build.version_code), 160);
    if (version || code) lines.push(`Version: ${version ?? code}${version && code && code !== version ? ` (${code})` : ""}`);
  }
  const status = safePreview(safeValue(payload.status), 160);
  const previous = safePreview(safeValue(payload.previous_status), 160);
  if (status) lines.push(`Status: ${previous && previous !== status ? `${previous} → ` : ""}${status}`);
  else if (previous) lines.push(`Previous status: ${previous}`);
  const footer: string[] = [];
  if (occurred) footer.push(`occurred: ${occurred}`);
  if (!link && ticketId && cliApp) footer.push(`📖 View more: \`hands feedback show ${cliApp} ${ticketId}\``);
  else if (!link) {
    const displayTicket = safePreview(safeValue(payload.ticket_id), 160);
    if (displayTicket) footer.push(`ticket: ${displayTicket}`);
  }
  const content = lines.join("\n");
  if (footer.length === 0) return truncateMessage(content, MAX_MESSAGE_LENGTH);
  const tail = footer.join("\n");
  return `${truncateMessage(content, MAX_MESSAGE_LENGTH - tail.length - 1)}\n${tail}`;
}

export function formatRaftNotificationMessage(body: Payload, knownApp?: NotificationApp): string {
  const event = safeValue(body.event) ?? "hands:event";
  const payload = record(body.payload);
  const app = record(payload.app);
  const build = record(payload.build);
  const presentation = PRESENTATIONS.get(event);
  const lines = [presentation ? `${presentation.icon} **${presentation.title}**` : `**Hands · ${event}**`];
  const footer: string[] = [];
  const appId = safeValue(knownApp?.id) ?? safeValue(body.app_id) ?? safeValue(app.id);
  const appSlug = safeValue(knownApp?.slug) ?? safeValue(payload.app_slug) ?? safeValue(app.slug);
  const appName = safePreview(knownApp?.name, 160) ?? safePreview(app.name, 160) ?? safePreview(appSlug, 160);
  const appIdDisplay = safePreview(appId, 160);
  const deliveredAt = typeof body.delivered_at === "number"
    && Number.isFinite(body.delivered_at) && Math.abs(body.delivered_at) <= 8.64e15
    ? new Date(body.delivered_at).toISOString()
    : safeValue(body.delivered_at);
  const occurred = safePreview(safeValue(payload.occurred_at) ?? deliveredAt, MAX_FIELD_LENGTH);
  const ticketId = typeof payload.ticket_id === "string" && UUID_RE.test(payload.ticket_id) ? payload.ticket_id : null;
  // The CLI treats a 36-character, five-part slug as an app id.
  const slugLooksLikeId = appSlug?.length === 36 && appSlug.split("-").length === 5;
  const cliApp = appSlug && CLI_APP_SLUG_RE.test(appSlug) && !slugLooksLikeId
    ? appSlug : appId && UUID_RE.test(appId) ? appId : null;
  if (isFeedbackThreadEvent(event)) {
    return feedbackMessage(event, payload, build, appName, appId, cliApp, ticketId, occurred, knownApp?.dashboardOrigin);
  }
  const isIssueAlert = /^(crash|error):(new_group|spike)$/.test(event);
  const issueCommand = isIssueAlert && ticketId && cliApp
    ? `📖 View more: \`hands feedback show ${cliApp} ${ticketId}\`` : null;
  if (appName || appIdDisplay) lines.push(`App: ${appName ?? appIdDisplay}`);
  lines.push(...standardFields(payload, build, !!issueCommand));
  if (isIssueAlert && typeof payload.count_last_hour === "number"
    && Number.isSafeInteger(payload.count_last_hour) && payload.count_last_hour >= 0) {
    lines.push(`reports in the last hour: ${payload.count_last_hour}`);
  }

  const observation = safePreview(payload.observation_display, MAX_FIELD_LENGTH);
  if (observation) footer.push(`observation: ${observation}`);
  lines.push(...rolloutField(event, payload), ...(presentation?.details?.(payload) ?? []));
  const link = safeValue(payload.app_store_connect_url);
  if (link && /^https:\/\/appstoreconnect\.apple\.com\//.test(link)) footer.push(`Review: ${link}`);
  footer.push(...(presentation?.footer?.(payload) ?? []));

  // Hands delivery timestamps are milliseconds; preserve provider timestamps.
  if (occurred) footer.push(`occurred: ${occurred}`);
  if (issueCommand) footer.push(issueCommand);
  const content = lines.join("\n");
  if (footer.length === 0) return truncateMessage(content, MAX_MESSAGE_LENGTH);
  const tail = footer.join("\n");
  return `${truncateMessage(content, MAX_MESSAGE_LENGTH - tail.length - 1)}\n${tail}`;
}
