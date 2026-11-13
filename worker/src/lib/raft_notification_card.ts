/** Build the display-only Raft card and the independently readable fallback.
 * Delivery and revision ordering are deliberately kept outside this renderer. */
import { formatRaftNotificationMessage, raftNotificationCardTestNotes, raftNotificationCurrentState, raftNotificationRawState } from "./raft_notification_content";

type Payload = Record<string, unknown>;
type App = { id: string; slug: string | null; name: string | null };
type CardElement =
  | { type: "Stack"; props: { direction: "column" }; children: string[] }
  | { type: "Text"; props: { text: string; tone?: "default" | "muted" | "warning"; mono?: boolean } }
  | { type: "Badge"; props: { text: string; tone: "neutral" } }
  | { type: "Markdown"; props: { content: string } }
  | { type: "Fields"; props: { items: Array<{ label: string; value: string; mono?: boolean }> } }
  | { type: "Divider"; props: Record<string, never> }
  | { type: "RelativeTime"; props: { at: string } }
  | { type: "Button"; props: { label: string; action: { kind: "navigate"; url: string } } };
export interface RaftMessageCard {
  version: 1;
  header?: { title: string; subtitle?: string; tags?: Array<{ text: string; tone: "neutral" | "info" | "success" | "warning" | "danger" }> };
  root: string;
  elements: Record<string, CardElement>;
}

const MAX_CARD_BYTES = 8192;
const TEXT_LIMIT = 500;
// Reserve children and bytes for the headline, cause, metadata, time and link.
const BODY_LIMIT = 3000;
const METADATA_LIMIT = 500;
const FOOTER_LIMIT = 500;
const PLAY_CONSOLE_URL = "https://play.google.com/console/";
const PLAY_CONSOLE_FOOTER = `\n[Open Play Console](${PLAY_CONSOLE_URL})`;

/** The card's new button must also be readable in the message fallback.
 * Older Workers sent the same event without it; their exact text is needed
 * when replaying an uncertain request across a deployment. */
export function withoutPlayConsoleFooter(content: string): string {
  return content.endsWith(PLAY_CONSOLE_FOOTER) ? content.slice(0, -PLAY_CONSOLE_FOOTER.length) : content;
}

function record(value: unknown): Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Payload : {};
}

function shorten(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length <= limit ? value : `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

// The existing fallback escapes untrusted text for Markdown. Raft card Text is
// plain text, so remove those escapes while retaining its mention protection.
function plain(value: string): string {
  return value.replace(/\\([\\`*_{}\[\]()<>!|])/g, "$1");
}

// Keep the event label visible even if an application has a very long name.
function headerTitle(value: string): string {
  if (Array.from(value).length <= 100) return value;
  const split = value.lastIndexOf(" · ");
  if (split < 0) return shorten(value, 100);
  const suffix = value.slice(split + 3);
  const remaining = 100 - Array.from(suffix).length - 3;
  return remaining > 0 ? `${shorten(value.slice(0, split), remaining)} · ${suffix}` : shorten(suffix, 100);
}

type TagTone = "neutral" | "info" | "success" | "warning" | "danger";
type StateTag = { tone: TagTone; text?: string };

// A state is meaningful only within its provider/event family. Compact labels
// fit Raft's 24-code-point header limit; the full qualified status remains in
// the title and in the unchanged text fallback. Unknown states stay neutral.
const STORE_TAGS: Readonly<Record<string, Readonly<Record<string, StateTag>>>> = {
  "app_store:version_state_changed": {
    PREPARE_FOR_SUBMISSION: { tone: "neutral" },
    WAITING_FOR_REVIEW: { tone: "info" }, IN_REVIEW: { tone: "info" },
    PENDING_DEVELOPER_RELEASE: { tone: "success", text: "Approved; not released" },
    PENDING_APPLE_RELEASE: { tone: "success", text: "Apple release pending" },
    READY_FOR_SALE: { tone: "success" }, READY_FOR_DISTRIBUTION: { tone: "success", text: "Ready for distribution" },
    REJECTED: { tone: "danger" }, METADATA_REJECTED: { tone: "danger" },
    DEVELOPER_REJECTED: { tone: "warning" }, INVALID_BINARY: { tone: "danger" },
  },
  "google_play:release_state_changed": {
    RELEASE_LIFECYCLE_STATE_DRAFT: { tone: "neutral" },
    RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: { tone: "neutral" },
    RELEASE_LIFECYCLE_STATE_IN_REVIEW: { tone: "info" },
    RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: { tone: "success", text: "Approved; not released" },
    RELEASE_LIFECYCLE_STATE_NOT_APPROVED: { tone: "danger" },
    RELEASE_LIFECYCLE_STATE_PUBLISHED: { tone: "success", text: "Available on track" },
  },
  "google_play:submission_succeeded": { SUBMISSION_SUCCEEDED: { tone: "success", text: "Operation succeeded" } },
  "google_play:submission_failed": { SUBMISSION_FAILED: { tone: "danger" } },
  "testflight:external_state_changed": {
    READY_FOR_BETA_TESTING: { tone: "success" }, IN_BETA_TESTING: { tone: "success" },
    BETA_APPROVED: { tone: "success", text: "Beta approved" }, BETA_REJECTED: { tone: "danger" },
    EXPIRED: { tone: "warning" }, PROCESSING_EXCEPTION: { tone: "danger" },
    MISSING_EXPORT_COMPLIANCE: { tone: "warning", text: "Export info needed" },
    IN_EXPORT_COMPLIANCE_REVIEW: { tone: "info", text: "Export info in review" },
    READY_FOR_BETA_SUBMISSION: { tone: "neutral", text: "Ready to submit" },
    WAITING_FOR_BETA_REVIEW: { tone: "info" }, IN_BETA_REVIEW: { tone: "info" },
    NOT_APPLICABLE: { tone: "warning", text: "Beta testing unavailable" },
  },
  "app_store:build_upload_state_changed": {
    AWAITING_UPLOAD: { tone: "neutral" }, PROCESSING: { tone: "info" }, COMPLETE: { tone: "success" }, FAILED: { tone: "danger" },
  },
  "appgallery:invitation_state_changed": {
    uploading: { tone: "neutral", text: "Uploading build" }, processing: { tone: "info", text: "Processing build" },
    ready: { tone: "neutral", text: "Ready to submit" }, failed: { tone: "danger", text: "Processing failed" },
    testing_review: { tone: "info", text: "Invitation test review" },
    testing_scheduled: { tone: "success", text: "Approved; test pending" }, testing_active: { tone: "success" },
    rejected: { tone: "danger", text: "Test review rejected" }, stopped: { tone: "warning", text: "Invitation test stopped" },
  },
  "appgallery:package_state_changed": {
    uploading: { tone: "neutral", text: "Uploading package" }, processing: { tone: "info", text: "Package processing" },
    ready: { tone: "success", text: "Package processed" }, failed: { tone: "danger", text: "Package failed" },
  },
};

function cardStatus(event: string, payload: Payload, raw: string | null, label: string | null): { text: string; tone: TagTone } | null {
  // Build/release receipts are emitted only after the named operation has
  // succeeded or failed. Do not conflate a Hands channel with a public store.
  const receipt = event === "build:succeeded" ? { text: "Build succeeded", tone: "success" as const, state: "succeeded" }
    : event === "build:failed" ? { text: "Build failed", tone: "danger" as const, state: "failed" }
    : event === "release:new" ? { text: "Active on Hands", tone: "success" as const, state: "active" }
    : event === "release:published" ? { text: "Published on Hands", tone: "success" as const, state: "active" }
    : null;
  if (receipt && (!raw || raw === receipt.state)) return { text: receipt.text, tone: receipt.tone };
  if (!raw || !label) return null;
  // Internal TestFlight readiness shares the same state enum as external; an
  // upload-processing notification shares the Apple upload state enum.
  const family = event === "testflight:internal_distribution_ready" ? "testflight:external_state_changed"
    : event === "testflight:upload_processing" ? "app_store:build_upload_state_changed" : event;
  // The heading treats this producer label as a withdrawal even if an
  // inconsistent state arrives; never put a green tag on that heading.
  const spec = event === "appgallery:invitation_state_changed" && payload.state_label === "开发者撤回邀请测试审核"
    ? { text: "Review withdrawn", tone: "warning" as const } : STORE_TAGS[family]?.[raw];
  return { text: spec?.text ?? label, tone: spec?.tone ?? "neutral" };
}

function reviewUrl(payload: Payload): string | null {
  if (typeof payload.app_store_connect_url !== "string") return null;
  try {
    const url = new URL(payload.app_store_connect_url);
    if (url.origin !== "https://appstoreconnect.apple.com" || url.username || url.password
      || url.search || url.hash || !/^\/apps\/\d+\/?$/.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Raft RelativeTime accepts RFC 3339 UTC. Do not normalize an invalid date
 * into a different day; keep the existing textual timestamp when unsure. */
function relativeTime(body: Payload, payload: Payload): string | null {
  const value = payload.occurred_at ?? body.delivered_at;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15) {
    const at = new Date(value).toISOString();
    return /^\d{4}-/.test(at) ? at : null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const at = new Date(milliseconds).toISOString();
  return at.slice(0, 19) === value.slice(0, 19) ? at : null;
}

function isTechnicalLine(line: string): boolean {
  return /^(?:Package|Reason code|Play reason code|Version code|Build|Commit): /.test(line);
}

function isFooterLine(line: string): boolean {
  return line.startsWith("observation: ") || line.startsWith("occurred: ") || line.startsWith("At: ")
    || line.startsWith("Observation: ") || line.startsWith("First observation;") || line.startsWith("Observed by polling;")
    || line.startsWith("Review: ") || line.startsWith("📖 View more: ") || line.startsWith("[Open App Store Connect](")
    || line === "Apple's review message is available in App Store Connect.";
}

/** The card contract bounds each Text by Unicode code points, not UTF-16 units. */
/**
 * Split text into Text-element-sized pieces whose concatenation is exactly the
 * input. Cut after the last line break in the window when there is one, so a
 * piece boundary never lands inside a word or a line.
 */
export function pieces(value: string): string[] {
  const chars = Array.from(value);
  const result: string[] = [];
  let offset = 0;
  while (offset < chars.length) {
    let end = Math.min(chars.length, offset + TEXT_LIMIT);
    if (end < chars.length) {
      const newline = chars.lastIndexOf("\n", end - 1);
      if (newline >= offset) end = newline + 1;
    }
    result.push(chars.slice(offset, end).join(""));
    offset = end;
  }
  return result;
}

export function formatRaftNotificationCard(body: Payload, knownApp?: App): { card: RaftMessageCard; content: string } {
  const baseContent = formatRaftNotificationMessage(body, knownApp);
  const [heading = "Hands", ...lines] = baseContent.split("\n");
  const payload = record(body.payload);
  const event = typeof body.event === "string" ? body.event : "";
  const rawState = raftNotificationRawState(body);
  // Recognize the newer Apple enum in the card only; the card's `content` may
  // already be in flight under a Raft idempotency key. Note that text
  // destinations are sent the card's layout (renderRaftCardAsText), so a
  // visual change here also changes that text: keep the previous layout
  // accepted on replay (compatibleCardText) when making one.
  const visualHeading = event === "app_store:version_state_changed" && rawState === "READY_FOR_DISTRIBUTION"
    ? heading.replace(/ · Status changed\*\*$/, " · Ready for distribution**") : heading;
  const title = headerTitle(plain(visualHeading.replace(/\*\*/g, "").replace(/ failed or was blocked$/, " failed")));
  const isPlay = event.startsWith("google_play:");
  const appleUrl = isPlay ? null : reviewUrl(payload);
  const url = appleUrl ?? (isPlay ? PLAY_CONSOLE_URL : null);
  const content = isPlay ? baseContent + PLAY_CONSOLE_FOOTER : baseContent;
  const at = relativeTime(body, payload);
  const currentState = raftNotificationCurrentState(body);
  const state = currentState ? shorten(plain(currentState), 60) : null;
  // The fallback normalizes notes and adds a two-space fence prefix. Build
  // card-only notes from the same selected input instead, preserving intended
  // indentation without changing fallback/replay. Keep note provenance through
  // footer/metadata classification so note text cannot impersonate a field.
  let inTestNotes = false;
  const footerLines: string[] = [];
  const detailLines: Array<{ text: string; isTestNote: boolean }> = [];
  for (const [index, line] of lines.entries()) {
    if ((event === "testflight:external_state_changed" || event === "testflight:internal_distribution_ready")
      && line === "```text" && lines[index - 1] === "What to test:") {
      inTestNotes = true;
      const notes = raftNotificationCardTestNotes(body);
      if (notes) detailLines.push({ text: notes, isTestNote: true });
      continue;
    }
    if (inTestNotes && line === "```") { inTestNotes = false; continue; }
    if (inTestNotes) continue;
    if (isFooterLine(line)) { footerLines.push(line); continue; }
    if (line === "```text" || line === "```") continue;
    if (event === "app_store:version_state_changed" && rawState === "READY_FOR_DISTRIBUTION"
      && line === "Status: READY\\_FOR\\_DISTRIBUTION") continue;
    detailLines.push({ text: line, isTestNote: false });
  }
  // Apple uses its verified app URL; Play uses the fixed Console home.
  // Bound each remaining item so a long observation cannot displace time.
  const footer = shorten(footerLines.filter((line) => !line.startsWith("Review: ") && !line.startsWith("[Open App Store Connect](")
      && !(at && (line.startsWith("At: ") || line.startsWith("occurred: "))))
    .map((line) => shorten(plain(line), line.startsWith("observation: ") || line.startsWith("Observation: ") ? 250
      : line.startsWith("occurred: ") || line.startsWith("At: ") ? 120 : 256)).join("\n"), FOOTER_LIMIT);
  const reasonIndex = event === "google_play:submission_failed"
    ? detailLines.findIndex(({ text }) => /^(?:Reason|Possible reason \(inferred\)|Possible reason \(source unconfirmed\)): /.test(text)) : -1;
  // These labels and descriptions are the allowlisted Play diagnoses. Never
  // pass arbitrary provider prose through the Markdown element.
  const reasonLine = reasonIndex < 0 ? null : plain(detailLines.splice(reasonIndex, 1)[0]!.text);
  const reasonSeparator = reasonLine?.indexOf(": ") ?? -1;
  const reasonLabel = reasonLine && reasonSeparator >= 0 ? reasonLine.slice(0, reasonSeparator) : null;
  const reason = reasonLine && reasonSeparator >= 0 ? shorten(reasonLine.slice(reasonSeparator + 2), 200) : null;
  const technical: string[] = [];
  const ordinary: Array<{ text: string; isTestNote: boolean }> = [];
  for (const { text: line, isTestNote } of detailLines) {
    const identity = event === "google_play:submission_failed"
      ? /^(.*?) · version code (\d{1,16})( · track: .+)?$/.exec(line) : null;
    if (identity) {
      ordinary.push({ text: `${identity[1]}${identity[3] ?? ""}`, isTestNote: false });
      technical.push(`Version code: ${identity[2]}`);
    } else if (!isTestNote && isTechnicalLine(line)) technical.push(line);
    else ordinary.push({ text: line, isTestNote });
  }
  const metadata = shorten(plain(technical.join("\n")), METADATA_LIMIT);
  const fields: Array<{ label: string; value: string; mono: true }> = [];
  const extraMetadata: string[] = [];
  for (const line of metadata.split("\n").filter(Boolean)) {
    const separator = line.indexOf(": ");
    const label = separator > 0 ? line.slice(0, separator) : "";
    const value = separator > 0 ? line.slice(separator + 2) : "";
    if (label && value && Array.from(label).length <= 40 && Array.from(value).length <= 200 && fields.length < 8) {
      fields.push({ label, value, mono: true });
    } else extraMetadata.push(line);
  }
  // A short identity line works as the card subtitle; longer or multi-line
  // content stays in the body rather than being silently cut.
  const first = ordinary[0] && !ordinary[0].isTestNote ? plain(ordinary[0].text) : "";
  const subtitle = first && Array.from(first).length <= 100
    && !/[\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029]/.test(first)
    && !/^(?:Previously|Status|Reason|What to test|Test groups|Requested rollout|Reported rollout|Observation):/.test(first)
    ? first : null;
  if (subtitle) ordinary.shift();
  const detail = ordinary.map(({ text, isTestNote }) => isTestNote ? text : plain(text)).join("\n");
  const status = cardStatus(event, payload, rawState, state);
  const tag = status && Array.from(status.text).length <= 24 ? status : null;
  const badge = state && !tag ? state : null;
  // Reserve each non-body child before fitting text to the root's 12-child
  // bound. A title and tag live in the header, outside the element tree.
  const reservedChildren = Number(!!badge) + 2 * Number(!!reason) + Number(fields.length > 0)
    + Number(fields.length > 0) + Number(extraMetadata.length > 0) + Number(!!footer) + Number(!!at) + Number(!!url);
  const bodyLimit = Math.min(BODY_LIMIT, Math.max(0, 12 - reservedChildren) * TEXT_LIMIT);

  const build = (limit: number): RaftMessageCard => {
    const children: string[] = [];
    const elements: Record<string, CardElement> = {
      root: { type: "Stack", props: { direction: "column" }, children },
    };
    if (badge) {
      children.push("state");
      elements.state = { type: "Badge", props: { text: badge, tone: "neutral" } };
    }
    const addText = (prefix: string, value: string, style: { tone?: "default" | "muted" | "warning"; mono?: boolean } = {}) => {
      for (const [index, text] of pieces(value).entries()) {
        const id = `${prefix}${index}`;
        children.push(id);
        elements[id] = { type: "Text", props: { text, ...style } };
      }
    };
    if (reason && reasonLabel) {
      children.push("reasonLabel");
      elements.reasonLabel = { type: "Markdown", props: { content: `**${reasonLabel}:**` } };
      addText("reason", reason, { tone: "warning" });
    }
    if (limit > 0) addText("detail", shorten(detail, limit));
    if (fields.length) {
      children.push("divider", "fields");
      elements.divider = { type: "Divider", props: {} };
      elements.fields = { type: "Fields", props: { items: fields } };
    }
    if (extraMetadata.length) addText("metadata", extraMetadata.join("\n"), { tone: "muted", mono: true });
    if (footer) addText("footer", footer, { tone: "muted" });
    if (at) {
      children.push("time");
      elements.time = { type: "RelativeTime", props: { at } };
    }
    if (url) {
      children.push("review");
      elements.review = { type: "Button", props: { label: appleUrl ? "Open in App Store Connect" : "Open Play Console", action: { kind: "navigate", url } } };
    }
    return { version: 1, header: { title, ...(subtitle ? { subtitle } : {}), ...(tag ? { tags: [tag] } : {}) }, root: "root", elements };
  };

  // JSON escaping and multibyte text make a character limit insufficient for
  // Raft's 8 KiB wire limit. Retain footer and title and fit the detail by bytes.
  let low = 0;
  let high = Math.min(bodyLimit, Array.from(detail).length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const size = new TextEncoder().encode(JSON.stringify(build(middle))).byteLength;
    if (size <= MAX_CARD_BYTES) low = middle;
    else high = middle - 1;
  }
  return { card: build(low), content };
}
