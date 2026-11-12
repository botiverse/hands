/** Safe presentation of Hands events for Raft. Transport and retries live in the route. */
import { isFeedbackThreadEvent } from "./raft_notification_identity";
import { playFailureNotificationLines } from "./play_failure_notification";

type Payload = Record<string, unknown>;
interface Presentation {
  icon: string;
  title: string;
}

const MAX_MESSAGE_LENGTH = 4_000;
const MAX_FIELD_LENGTH = 500;
const MAX_TEST_NOTES_LENGTH = 1_000;
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

function safeNotes(value: unknown, limit: number, preserveFormatting = false): string | null {
  if (typeof value !== "string") return null;
  const lines = value.replace(/https?:\/\/[^\s]+/gi, "[link]")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .split("\n").map((line) => {
      if (!preserveFormatting) return line.replace(/[^\S\n]+/gu, " ").trim();
      // Cards use plain Text, so preserve intentional spaces and list nesting.
      // Normalize other whitespace to spaces and keep blank lines truly blank.
      return line.trim() ? line.replace(/[^\S\n]/gu, " ") : "";
    }).join("\n").replace(/\n{3,}/g, "\n\n");
  const cleaned = preserveFormatting ? lines.replace(/^\n+|\n+$/g, "") : lines.trim();
  if (!cleaned.trim()) return null;
  const chars = Array.from(cleaned);
  const shortened = chars.length > limit ? `${chars.slice(0, limit).join("")}…` : cleaned;
  // Fenced code is plain text: keep punctuation legible, but break backtick
  // runs so untrusted notes cannot close the fence or produce mentions.
  return shortened.replace(/[@#`]/g, "$&\u200b");
}

function feedbackPreview(payload: Payload): string[] {
  if (payload.kind !== "feedback" && payload.kind !== "bug") return [];
  const preview = safePreview(payload.message, MAX_FEEDBACK_PREVIEW_LENGTH);
  return preview ? [`Feedback: ${preview}`] : [];
}

function testflightNote(payload: Payload, preserveFormatting: boolean): { locale: string; note: string } | null {
  const notes = record(payload.what_to_test);
  const locales = Object.keys(notes).filter((locale) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)).sort();
  const locale = locales.includes("zh-Hans") ? "zh-Hans" : locales[0];
  const note = locale ? safeNotes(notes[locale], MAX_TEST_NOTES_LENGTH, preserveFormatting) : null;
  return locale && note ? { locale, note } : null;
}

/** The visual card can preserve indentation; the established text fallback cannot change. */
export function raftNotificationCardTestNotes(body: Payload): string | null {
  return testflightNote(record(body.payload), true)?.note ?? null;
}

function testflightDetails(payload: Payload): string[] {
  const lines: string[] = [];
  const selected = testflightNote(payload, false);
  if (selected) lines.push(`Test notes (${selected.locale}):\n\`\`\`text\n  ${selected.note.replace(/\n/g, "\n  ")}\n\`\`\``);
  const commit = safeValue(payload.source_commit);
  if (commit && /^[0-9a-f]{7,64}$/i.test(commit)) lines.push(`source commit: ${commit}`);
  return lines;
}

// Event-specific presentation is registered here; the common safe field and
// footer rules below apply consistently to every event.
const PRESENTATIONS = new Map<string, Presentation>([
  ["app_store:version_state_changed", { icon: "🍎", title: "App Store version status changed" }],
  ["app_store:build_upload_state_changed", { icon: "📦", title: "App Store build upload status changed" }],
  ["testflight:upload_processing", { icon: "📦", title: "TestFlight upload processing" }],
  ["testflight:internal_distribution_ready", { icon: "✈️", title: "TestFlight ready for internal testing" }],
  ["testflight:external_state_changed", { icon: "✈️", title: "TestFlight external testing status changed" }],
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
  ["release:new", { icon: "📦", title: "Release activated" }],
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

function standardFields(payload: Payload, build: Payload): string[] {
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

/** Use the same source field as the displayed market heading. */
export function raftNotificationRawState(body: Payload): string | null {
  const payload = record(body.payload);
  const build = record(payload.build);
  const event = safeValue(body.event) ?? "";
  return MARKET_EVENTS.has(event) ? safeValue(payload.state) ?? safeValue(build.state)
    : safeValue(payload.status) ?? safeValue(build.status) ?? safeValue(payload.state) ?? safeValue(build.state);
}

/** Current state for the card badge, independent of the formatted transition. */
export function raftNotificationCurrentState(body: Payload): string | null {
  const state = raftNotificationRawState(body);
  const event = safeValue(body.event) ?? "";
  return safePreview((state && marketStateLabel(event, state)) ?? state, MAX_FIELD_LENGTH);
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

function truncateMarketContent(value: string, limit: number): string {
  const clipped = truncateMessage(value, limit);
  if (clipped.length === value.length) return clipped;
  const open = clipped.lastIndexOf("\n```text\n");
  if (open < 0 || clipped.indexOf("\n```", open + "\n```text\n".length) >= 0) return clipped;
  const prefix = truncateMessage(value, Math.max(0, limit - 5));
  return prefix.includes("\n```text\n") ? `${prefix}\n\`\`\`` : prefix;
}

function humanTime(value: string): string {
  return value.replace(/^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d(?:\.\d+)?)Z$/, "$1 $2 UTC");
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

/** A deterministic, content-free root when a destination first sees a ticket update. */
export function formatExistingFeedbackRoot(body: Payload, appId: string): string | null {
  const ticketId = record(body.payload).ticket_id;
  if (!UUID_RE.test(appId) || typeof ticketId !== "string" || !UUID_RE.test(ticketId)) return null;
  // Only immutable IDs are used: a retry must reproduce the exact same body
  // even if the app name, slug, or dashboard origin changes in between.
  return `📮 **Existing feedback**\n📖 View more: \`hands feedback show ${appId} ${ticketId}\``;
}

const PLAY_STATES: Readonly<Record<string, string>> = {
  RELEASE_LIFECYCLE_STATE_DRAFT: "Draft",
  RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: "Not sent for review",
  RELEASE_LIFECYCLE_STATE_IN_REVIEW: "In review",
  RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: "Approved; waiting for release",
  RELEASE_LIFECYCLE_STATE_NOT_APPROVED: "Review rejected",
  RELEASE_LIFECYCLE_STATE_PUBLISHED: "Available on track (may be partially rolled out or paused)",
};
const TESTFLIGHT_STATES: Readonly<Record<string, string>> = {
  READY_FOR_BETA_TESTING: "Ready for beta testing",
  IN_BETA_TESTING: "Beta testing",
  BETA_APPROVED: "Approved for beta testing",
  BETA_REJECTED: "Beta review rejected",
  EXPIRED: "Build expired",
  PROCESSING_EXCEPTION: "Build processing failed",
  MISSING_EXPORT_COMPLIANCE: "Export compliance information needed",
  IN_EXPORT_COMPLIANCE_REVIEW: "Export compliance in review",
  READY_FOR_BETA_SUBMISSION: "Ready to submit for beta review",
  WAITING_FOR_BETA_REVIEW: "Waiting for beta review",
  IN_BETA_REVIEW: "In beta review",
  NOT_APPLICABLE: "External testing not available",
};
const APP_STORE_STATES: Readonly<Record<string, string>> = {
  PREPARE_FOR_SUBMISSION: "Preparing for submission",
  WAITING_FOR_REVIEW: "Waiting for review",
  IN_REVIEW: "In review",
  PENDING_DEVELOPER_RELEASE: "Approved; waiting for developer release",
  PENDING_APPLE_RELEASE: "Waiting for Apple release",
  READY_FOR_SALE: "Ready for distribution",
  REJECTED: "Review rejected",
  METADATA_REJECTED: "Metadata rejected",
  DEVELOPER_REJECTED: "Withdrawn by developer",
  INVALID_BINARY: "Build is invalid",
};
const UPLOAD_STATES: Readonly<Record<string, string>> = {
  AWAITING_UPLOAD: "Waiting for upload", PROCESSING: "Processing upload",
  COMPLETE: "Upload processed", FAILED: "Upload processing failed",
};
const AGC_TEST_STATES: Readonly<Record<string, string>> = {
  uploading: "Uploading invitation-test build", processing: "Processing invitation-test build",
  ready: "Ready to submit for invitation testing", failed: "Upload or processing failed",
  testing_review: "Invitation test in review", testing_scheduled: "Approved; waiting for testing to start",
  testing_active: "Invitation testing open", rejected: "Invitation test review rejected", stopped: "Invitation testing stopped",
};
const AGC_PACKAGE_STATES: Readonly<Record<string, string>> = {
  uploading: "Uploading market package", processing: "Market package uploaded; processing",
  ready: "Market package processed", failed: "Market package upload or processing failed",
};
const MARKET_EVENTS = new Set([
  "testflight:upload_processing", "testflight:internal_distribution_ready", "testflight:external_state_changed",
  "testflight:crash_submission_created", "app_store:version_state_changed", "app_store:build_upload_state_changed",
  "google_play:submission_succeeded", "google_play:submission_failed", "google_play:release_state_changed",
  "appgallery:invitation_state_changed", "appgallery:package_state_changed",
]);

function marketStateLabel(event: string, state: string): string | null {
  if (event === "google_play:submission_failed" && state === "SUBMISSION_FAILED") return "Failed";
  if (event === "google_play:release_state_changed") return PLAY_STATES[state] ?? null;
  if (event === "testflight:external_state_changed" || event === "testflight:internal_distribution_ready") return TESTFLIGHT_STATES[state] ?? null;
  if (event === "app_store:version_state_changed") return APP_STORE_STATES[state] ?? null;
  if (event === "testflight:upload_processing" || event === "app_store:build_upload_state_changed") return UPLOAD_STATES[state] ?? null;
  if (event === "appgallery:invitation_state_changed") return AGC_TEST_STATES[state] ?? null;
  if (event === "appgallery:package_state_changed") return AGC_PACKAGE_STATES[state] ?? null;
  return null;
}

function appleConsoleLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === "https://appstoreconnect.apple.com" && !url.username && !url.password
      && !url.search && !url.hash && /^\/apps\/\d+\/?$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

function marketMessage(event: string, payload: Payload, build: Payload, app: string | null,
  cliApp: string | null, ticketId: string | null, occurred: string | null): string {
  const state = safeValue(payload.state) ?? safeValue(build.state);
  const previous = safeValue(payload.previous_state);
  const status = state ? marketStateLabel(event, state) : null;
  const isPlay = event.startsWith("google_play:");
  const isAgc = event.startsWith("appgallery:");
  const isAppStore = event.startsWith("app_store:");
  const isCrash = event === "testflight:crash_submission_created";
  const isReceipt = event === "google_play:submission_succeeded" || event === "google_play:submission_failed";
  const service = isPlay ? "Google Play" : isAgc ? "AppGallery"
    : isAppStore ? "App Store" : "TestFlight";
  let label = status ?? "Status changed";
  let icon = isPlay ? "▶️" : isAgc ? "📱" : isAppStore ? "🍎" : "✈️";
  if (event === "testflight:upload_processing" || event === "app_store:build_upload_state_changed") icon = "📦";
  if (event === "testflight:internal_distribution_ready") label = "Ready for internal testing";
  if (isCrash) { icon = "💥"; label = "Crash report received"; }
  if (event === "appgallery:invitation_state_changed" && payload.state_label === "开发者撤回邀请测试审核") {
    label = "Invitation test review withdrawn by developer";
  }
  const action = safeValue(payload.action);
  if (isReceipt) {
    const success = event === "google_play:submission_succeeded";
    icon = success ? "✅" : "⚠️";
    label = action === "upload-symbols" ? (success ? "Symbols uploaded" : "Symbols upload failed or was blocked")
      : action === "send-for-review" ? (success ? "Review request sent" : "Review request failed or was blocked")
      : action === "release-notes" ? (success ? "Release notes updated" : "Release notes update failed or was blocked")
      : action && action !== "promote" ? (success ? "Operation completed" : "Operation failed or was blocked")
      : success && payload.review_requested === false ? "Release saved; not sent for review"
      : success ? "Release submitted" : "Release submission failed or was blocked";
  }
  const lines = [`${icon} **${app ? `${app} · ` : ""}${service} · ${label}**`];
  const version = safePreview(safeValue(payload.version_string) ?? safeValue(payload.version)
    ?? safeValue(payload.version_name) ?? safeValue(build.version), 160);
  const versionName = safePreview(safeValue(payload.version_name), 160);
  const buildNumber = safePreview(safeValue(payload.build_number), 160);
  const versionCode = safePreview(safeValue(payload.version_code) ?? safeValue(build.version_code), 160);
  const code = isPlay ? (versionCode ?? buildNumber) : (buildNumber ?? versionCode);
  const track = isPlay ? safePreview(safeValue(payload.track), 160) : null;
  const identity = [version, code && code !== version ? `${isPlay ? "version code" : "build"} ${code}` : null,
    track ? `track: ${track}` : null].filter(Boolean);
  if (identity.length) lines.push(identity.join(" · "));
  if (version && versionName && version !== versionName) lines.push(`Version name: ${versionName}`);
  if (buildNumber && versionCode && buildNumber !== versionCode) {
    lines.push(isPlay ? `Build: ${buildNumber}` : `Version code: ${versionCode}`);
  }
  const packageName = isPlay ? safePreview(safeValue(payload.package_name), 160) : null;
  if (packageName) lines.push(`Package: ${packageName}`);
  if (!isReceipt && !isCrash) {
    if (state && !status) lines.push(`Status: ${safePreview(state, 160)}`);
    if (previous && previous !== state) lines.push(`Previously: ${safePreview(marketStateLabel(event, previous) ?? previous, 160)}`);
  }
  if (isReceipt && action && action !== "promote" && action !== "send-for-review" && action !== "upload-symbols"
      && action !== "release-notes") {
    lines.push(`Action: ${safePreview(action, 160)}`);
  }
  if (isReceipt && event === "google_play:submission_succeeded" && (!action || action === "promote" || action === "send-for-review")
      && payload.review_requested !== false) lines.push("Review status is not yet confirmed; check Google Play.");
  if (isReceipt && event === "google_play:submission_failed") {
    const reason = safeValue(payload.reason) ?? safeValue(payload.failure_code);
    if (reason && /^[a-z0-9_]{1,80}$/i.test(reason)) lines.push(`Reason code: ${safePreview(reason, 80)}`);
    lines.push(...playFailureNotificationLines(payload));
  }
  if (isPlay && typeof payload.rollout_percent === "number" && Number.isFinite(payload.rollout_percent)
      && payload.rollout_percent >= 0 && payload.rollout_percent <= 100) {
    lines.push(`${isReceipt ? "Requested rollout" : "Reported rollout"}: ${payload.rollout_percent}%`);
  }
  const groups = safePreview(payload.groups_display, MAX_FIELD_LENGTH);
  if (groups) lines.push(`Test groups: ${groups.replace(/^测试组(?: ID)?[：:]\s*/, "")}`);
  if (event === "testflight:internal_distribution_ready" || event === "testflight:external_state_changed") {
    lines.push(...testflightDetails(payload).map((line) => line.replace(/^Test notes \([^)]*\):/, "What to test:").replace(/^source commit:/, "Commit:")));
  }
  if (event === "app_store:version_state_changed" && state === "REJECTED") lines.push("Review details are available in App Store Connect.");
  if (isCrash && ticketId && cliApp) lines.push(`📖 View more: \`hands feedback show ${cliApp} ${ticketId}\``);
  else if (isCrash) {
    const ticket = safePreview(safeValue(payload.ticket_id), 160);
    if (ticket) lines.push(`Ticket: ${ticket}`);
  }
  const footer: string[] = [];
  if (payload.observation === "initial_snapshot") footer.push("First observation; this may not be a recent change.");
  else if (isAgc && safeValue(payload.observation_display)) {
    footer.push(event === "appgallery:package_state_changed"
      ? "Observed by polling; this is not an app-store review result."
      : "Observed by polling; the change may have happened earlier.");
  } else {
    const observation = safePreview(payload.observation_display, 250);
    if (observation) footer.push(`Observation: ${observation}`);
  }
  const link = appleConsoleLink(payload.app_store_connect_url);
  if (link) footer.push(`[Open App Store Connect](${link})`);
  if (occurred) footer.push(`At: ${humanTime(occurred)}`);
  const content = lines.join("\n");
  if (!footer.length) return truncateMarketContent(content, MAX_MESSAGE_LENGTH);
  const tail = footer.join("\n");
  return `${truncateMarketContent(content, MAX_MESSAGE_LENGTH - tail.length - 1)}\n${tail}`;
}

function releaseBuildMessage(event: string, payload: Payload, build: Payload, app: string | null, occurred: string | null): string {
  const presentation = PRESENTATIONS.get(event);
  const lines = [`${presentation?.icon ?? "📦"} **${app ? `${app} · ` : ""}${presentation?.title ?? "Release updated"}**`];
  const value = (key: string) => safePreview(safeValue(payload[key]) ?? safeValue(build[key]), 160);
  const version = value("version_string") ?? value("version") ?? value("version_name");
  const versionName = value("version_name");
  const buildNumber = value("build_number");
  const versionCode = value("version_code");
  const code = buildNumber ?? versionCode;
  const channel = value("channel");
  const versionText = version && code && version !== code ? `${version} (${code})` : version ?? code;
  const identity = [versionText, channel ? `channel: ${channel}` : null].filter(Boolean).join(" · ");
  if (identity) lines.push(event === "release:rolled_back" ? `Restored: ${identity}`
    : event === "release:channel_emptied" || event === "release:cancelled" ? `Cancelled: ${identity}` : identity);
  if (version && versionName && version !== versionName) lines.push(`Version name: ${versionName}`);
  if (buildNumber && versionCode && buildNumber !== versionCode) lines.push(`Version code: ${versionCode}`);
  const previousVersion = value("previous_version");
  const previousCode = value("previous_version_code");
  const previous = previousVersion && previousCode && previousVersion !== previousCode
    ? `${previousVersion} (${previousCode})` : previousVersion ?? previousCode;
  if (previous && (event === "release:published" || event === "release:rolled_back")) lines.push(`Replaced: ${previous}`);
  else {
    const transition = value("version_transition");
    const codeTransition = value("version_code_transition");
    if (transition) lines.push(`Version change: ${transition}`);
    if (codeTransition) lines.push(`Build change: ${codeTransition}`);
  }
  if (!versionText) {
    const id = value(event.startsWith("build:") ? "build_id" : "release_id");
    if (id) lines.push(`${event.startsWith("build:") ? "Build" : "Release"}: ${id}`);
  }
  const status = value("status");
  const previousStatus = value("previous_status");
  if (status && !(event === `build:${status}` || (event === "release:new" && status === "active"))) {
    lines.push(`Status: ${previousStatus && previousStatus !== status ? `${previousStatus} → ` : ""}${status}`);
  }
  const reason = value("failure_code") ?? value("reason_code");
  if (reason) lines.push(`Reason code: ${reason}`);
  const rollout = payload.rollout;
  if (event.startsWith("release:") && typeof rollout === "number" && Number.isFinite(rollout)
      && rollout >= 0 && rollout <= 100) lines.push(`Rollout: ${rollout}%`);
  const footer = occurred ? `At: ${humanTime(occurred)}` : "";
  const content = lines.join("\n");
  return footer ? `${truncateMessage(content, MAX_MESSAGE_LENGTH - footer.length - 1)}\n${footer}`
    : truncateMessage(content, MAX_MESSAGE_LENGTH);
}

function issueAlertMessage(event: string, payload: Payload, app: string | null, appId: string | null,
  cliApp: string | null, ticketId: string | null, dashboardOrigin: string | null | undefined, occurred: string | null): string {
  const presentation = PRESENTATIONS.get(event);
  const link = feedbackLink(dashboardOrigin, appId, ticketId);
  const signature = safePreview(safeValue(payload.signature), 160);
  const alertReason = safeValue(payload.alert_reason);
  if (alertReason === "background_system_kill_daily_summary") {
    const day = safePreview(safeValue(payload.day), 32);
    const totalCount = typeof payload.total_count === "number" && Number.isSafeInteger(payload.total_count)
      ? payload.total_count : 0;
    const deviceCount = typeof payload.device_count === "number" && Number.isSafeInteger(payload.device_count)
      ? payload.device_count : 0;
    const lines = [
      `📊 **${app ? `${app} · ` : ""}后台被系统结束每日汇总 (${day ?? "最近 24h"})**`,
      `总次数: ${totalCount} · 涉及设备: ${deviceCount}`,
    ];
    const byVersion = Array.isArray(payload.by_version) ? payload.by_version : [];
    if (byVersion.length > 0) {
      lines.push("按版本统计:");
      for (const raw of byVersion.slice(0, 6)) {
        const entry = record(raw);
        const vName = safePreview(safeValue(entry.version_name), 80);
        const vCode = safePreview(safeValue(entry.version_code), 40);
        const vLabel = [vName, vCode && vCode !== vName ? `(${vCode})` : null].filter(Boolean).join(" ") || "unknown";
        const count = typeof entry.count === "number" ? entry.count : 0;
        const devices = typeof entry.device_count === "number" ? entry.device_count : 0;
        const prevName = safePreview(safeValue(entry.previous_version_name), 80);
        const prevCode = safePreview(safeValue(entry.previous_version_code), 40);
        const prevCount = typeof entry.previous_version_count === "number" ? entry.previous_version_count : null;
        const prevDevices = typeof entry.previous_version_device_count === "number" ? entry.previous_version_device_count : null;
        const prevLabel = [prevName, prevCode && prevCode !== prevName ? `(${prevCode})` : null].filter(Boolean).join(" ");
        const spike = entry.spike === true ? " ⚠️ 较上一版本显著上升" : "";
        const prevPart = prevCount !== null
          ? ` (对比上一版本 ${prevLabel || "prev"}: ${prevCount} 次 / ${prevDevices ?? 0} 台${spike})`
          : "";
        lines.push(`- ${vLabel}: ${count} 次 (${devices} 台设备)${prevPart}`);
      }
    }
    const topDevices = Array.isArray(payload.top_devices) ? payload.top_devices : [];
    if (topDevices.length > 0) {
      lines.push("次数最多的设备:");
      for (const raw of topDevices.slice(0, 5)) {
        const entry = record(raw);
        const dId = safePreview(safeValue(entry.device_id), 80) ?? "unknown";
        const dModel = safePreview(safeValue(entry.device_model), 80);
        const count = typeof entry.count === "number" ? entry.count : 0;
        const label = dModel ? `${dModel} (${dId})` : dId;
        lines.push(`- ${label}: ${count} 次`);
      }
    }
    const footer: string[] = [];
    if (cliApp) footer.push(`📖 View more: \`hands feedback crashes ${cliApp} --type system_kill\``);
    if (occurred) footer.push(`At: ${humanTime(occurred)}`);
    const content = lines.join("\n");
    if (!footer.length) return truncateMessage(content, MAX_MESSAGE_LENGTH);
    const tail = footer.join("\n");
    return `${truncateMessage(content, MAX_MESSAGE_LENGTH - tail.length - 1)}\n${tail}`;
  }
  const isBgKill = signature === "SystemKill@background"
    || alertReason === "device_daily_repeat"
    || alertReason === "version_spike";
  const title = isBgKill && event === "crash:spike"
    ? "Background system kill spike (后台被系统结束)"
    : (presentation?.title ?? "Issue report");
  const lines = [`${presentation?.icon ?? "⚠️"} **${app ? `${app} · ` : ""}${title}**${link ? ` · [View feedback](${link})` : ""}`];
  if (alertReason === "device_daily_repeat") {
    const deviceId = safePreview(safeValue(payload.device_id), 160);
    const count24h = typeof payload.count_last_24h === "number" && Number.isSafeInteger(payload.count_last_24h)
      ? payload.count_last_24h : null;
    lines.push(
      `Same device killed in background ${count24h ?? "multiple"} times in 24h${deviceId ? ` (device: ${deviceId})` : ""}`,
    );
  } else if (alertReason === "version_spike") {
    const curCount = typeof payload.version_count === "number" ? payload.version_count : null;
    const curDevices = typeof payload.version_device_count === "number" ? payload.version_device_count : null;
    const prevName = safePreview(safeValue(payload.previous_version_name), 160);
    const prevCode = safePreview(safeValue(payload.previous_version_code), 160);
    const prevCount = typeof payload.previous_version_count === "number" ? payload.previous_version_count : null;
    const prevDevices = typeof payload.previous_version_device_count === "number" ? payload.previous_version_device_count : null;
    const prevLabel = [prevName, prevCode && prevCode !== prevName ? `(${prevCode})` : null].filter(Boolean).join(" ") || "previous version";
    lines.push(
      `Version background kill spike: ${curCount ?? "?"} reports across ${curDevices ?? "?"} devices vs ${prevCount ?? "?"} reports (${prevDevices ?? "?"} devices) on ${prevLabel}`,
    );
  } else if (typeof payload.count_last_hour === "number" && Number.isSafeInteger(payload.count_last_hour) && payload.count_last_hour >= 0) {
    lines.push(`${payload.count_last_hour} reports in the last hour`);
  }
  const version = safePreview(safeValue(payload.version_name) ?? safeValue(payload.version), 160);
  const code = safePreview(safeValue(payload.version_code), 160);
  if (version || code) lines.push(`Version: ${version ?? code}${version && code && version !== code ? ` (${code})` : ""}`);
  const platform = safePreview(safeValue(payload.platform), 160);
  if (platform) lines.push(`Platform: ${platform}`);
  const footer: string[] = [];
  if (!link && ticketId && cliApp) footer.push(`📖 View more: \`hands feedback show ${cliApp} ${ticketId}\``);
  else if (!link) {
    const ticket = safePreview(safeValue(payload.ticket_id), 160);
    if (ticket) footer.push(`Ticket: ${ticket}`);
  }
  if (occurred) footer.push(`At: ${humanTime(occurred)}`);
  const content = lines.join("\n");
  if (!footer.length) return truncateMessage(content, MAX_MESSAGE_LENGTH);
  const tail = footer.join("\n");
  return `${truncateMessage(content, MAX_MESSAGE_LENGTH - tail.length - 1)}\n${tail}`;
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
  // A validated dashboard link keeps the details reachable even when a
  // comment or status change is the first event for a subscription.
  const link = feedbackLink(dashboardOrigin, appId, ticketId);
  const lines = [`${icon} **${title}${app ? ` · ${app}` : ""}**${link ? ` · [View feedback](${link})` : ""}`];
  if (event === "feedback:new") {
    lines.push(...feedbackPreview(payload));
    const version = safePreview(safeValue(payload.version_string) ?? safeValue(payload.version)
      ?? safeValue(payload.version_name) ?? safeValue(build.version), 160);
    const versionName = safePreview(safeValue(payload.version_name), 160);
    const buildNumber = safePreview(safeValue(payload.build_number), 160);
    const versionCode = safePreview(safeValue(payload.version_code) ?? safeValue(build.version_code), 160);
    const code = buildNumber ?? versionCode;
    if (version || code) lines.push(`Version: ${version ?? code}${version && code && code !== version ? ` (${code})` : ""}`);
    if (version && versionName && version !== versionName) lines.push(`Version name: ${versionName}`);
    if (buildNumber && versionCode && buildNumber !== versionCode) lines.push(`Version code: ${versionCode}`);
  }
  const status = safePreview(safeValue(payload.status), 160);
  const previous = safePreview(safeValue(payload.previous_status), 160);
  if (status) lines.push(`Status: ${previous && previous !== status ? `${previous} → ` : ""}${status}`);
  else if (previous) lines.push(`Previous status: ${previous}`);
  const footer: string[] = [];
  if (occurred) footer.push(`At: ${humanTime(occurred)}`);
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
  if (MARKET_EVENTS.has(event)) return marketMessage(event, payload, build, appName ?? appIdDisplay, cliApp, ticketId, occurred);
  if (PRESENTATIONS.has(event) && (event.startsWith("release:") || event.startsWith("build:"))) {
    return releaseBuildMessage(event, payload, build, appName ?? appIdDisplay, occurred);
  }
  const isIssueAlert = /^(crash|error):(new_group|spike)$/.test(event);
  if (isIssueAlert) return issueAlertMessage(event, payload, appName ?? appIdDisplay, appId, cliApp, ticketId, knownApp?.dashboardOrigin, occurred);
  if (appName || appIdDisplay) lines.push(`App: ${appName ?? appIdDisplay}`);
  lines.push(...standardFields(payload, build));

  const observation = safePreview(payload.observation_display, MAX_FIELD_LENGTH);
  if (observation) footer.push(`observation: ${observation}`);
  lines.push(...rolloutField(event, payload));
  const link = safeValue(payload.app_store_connect_url);
  if (link && /^https:\/\/appstoreconnect\.apple\.com\//.test(link)) footer.push(`Review: ${link}`);

  // Hands delivery timestamps are milliseconds; preserve provider timestamps.
  if (occurred) footer.push(`occurred: ${occurred}`);
  const content = lines.join("\n");
  if (footer.length === 0) return truncateMessage(content, MAX_MESSAGE_LENGTH);
  const tail = footer.join("\n");
  return `${truncateMessage(content, MAX_MESSAGE_LENGTH - tail.length - 1)}\n${tail}`;
}
