/** Build the display-only Raft card and the independently readable fallback.
 * Delivery and revision ordering are deliberately kept outside this renderer. */
import { formatRaftNotificationMessage, raftNotificationCurrentState } from "./raft_notification_content";

type Payload = Record<string, unknown>;
type App = { id: string; slug: string | null; name: string | null };
type CardElement =
  | { type: "Stack"; props: { direction: "column" }; children: string[] }
  | { type: "Text"; props: { text: string; tone?: "default" | "muted" | "warning"; mono?: boolean } }
  | { type: "Badge"; props: { text: string; tone: "neutral" } }
  | { type: "RelativeTime"; props: { at: string } }
  | { type: "Button"; props: { label: string; action: { kind: "navigate"; url: string } } };
export interface RaftMessageCard {
  version: 1;
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

/** The card contract bounds each Text by Unicode code points, not UTF-16 units. */
function pieces(value: string): string[] {
  const chars = Array.from(value);
  const result: string[] = [];
  for (let offset = 0; offset < chars.length; offset += TEXT_LIMIT) {
    result.push(chars.slice(offset, offset + TEXT_LIMIT).join(""));
  }
  return result;
}

export function formatRaftNotificationCard(body: Payload, knownApp?: App): { card: RaftMessageCard; content: string } {
  const baseContent = formatRaftNotificationMessage(body, knownApp);
  const [heading = "Hands", ...lines] = baseContent.split("\n");
  const payload = record(body.payload);
  const event = typeof body.event === "string" ? body.event : "";
  const title = shorten(plain(heading.replace(/\*\*/g, "").replace(/ failed or was blocked$/, " failed")), 160);
  const isPlay = event.startsWith("google_play:");
  const appleUrl = isPlay ? null : reviewUrl(payload);
  const url = appleUrl ?? (isPlay ? PLAY_CONSOLE_URL : null);
  const content = isPlay ? baseContent + PLAY_CONSOLE_FOOTER : baseContent;
  const at = relativeTime(body, payload);
  const currentState = raftNotificationCurrentState(body);
  const state = currentState ? shorten(plain(currentState), 60) : null;
  const footerLines = lines.filter((line) => line.startsWith("observation: ") || line.startsWith("occurred: ") || line.startsWith("At: ")
    || line.startsWith("Observation: ") || line.startsWith("First observation;") || line.startsWith("Observed by polling;")
    || line.startsWith("Review: ") || line.startsWith("📖 View more: ")
    || line.startsWith("[Open App Store Connect](")
    || line === "Apple's review message is available in App Store Connect.");
  // The fallback uses a Markdown code fence for What to test. Card Text is
  // already plain text, so retain the content without showing fence markers.
  const detailLines = lines.filter((line) => !footerLines.includes(line) && line !== "```text" && line !== "```");
  // Apple uses its verified app URL; Play uses the fixed Console home.
  // Bound each remaining item so a long observation cannot displace time.
  const footer = shorten(footerLines.filter((line) => !line.startsWith("Review: ") && !line.startsWith("[Open App Store Connect](")
      && !(at && (line.startsWith("At: ") || line.startsWith("occurred: "))))
    .map((line) => shorten(plain(line), line.startsWith("observation: ") || line.startsWith("Observation: ") ? 250
      : line.startsWith("occurred: ") || line.startsWith("At: ") ? 120 : 256)).join("\n"), FOOTER_LIMIT);
  const reasonIndex = event === "google_play:submission_failed"
    ? detailLines.findIndex((line) => /^(?:Reason|Possible reason \(inferred\)|Possible reason \(source unconfirmed\)): /.test(line)) : -1;
  // Only the already-whitelisted reason is promoted. Preserve the tentative
  // label when the provider's wording rather than structured data was used.
  const reason = reasonIndex < 0 ? null : shorten(plain(detailLines.splice(reasonIndex, 1)[0]!.replace(/^Reason: /, "")), 200);
  const technical: string[] = [];
  const ordinary: string[] = [];
  for (const line of detailLines) {
    const identity = event === "google_play:submission_failed"
      ? /^(.*?) · version code (\d{1,16})( · track: .+)?$/.exec(line) : null;
    if (identity) {
      ordinary.push(`${identity[1]}${identity[3] ?? ""}`);
      technical.push(`Version code: ${identity[2]}`);
    } else if (isTechnicalLine(line)) technical.push(line);
    else ordinary.push(line);
  }
  const detail = plain(ordinary.join("\n"));
  const metadata = shorten(plain(technical.join("\n")), METADATA_LIMIT);
  // Each reserved item uses one child; fit the body into the remaining
  // children as well as the JSON byte limit, rather than discarding notes
  // just because another kind of event needs more header elements.
  const reservedChildren = 1 + Number(!!state) + Number(!!reason) + Number(!!metadata)
    + Number(!!footer) + Number(!!at) + Number(!!url);
  const bodyLimit = Math.min(BODY_LIMIT, (12 - reservedChildren) * TEXT_LIMIT);

  const build = (limit: number): RaftMessageCard => {
    const children = ["title"];
    const elements: Record<string, CardElement> = {
      root: { type: "Stack", props: { direction: "column" }, children },
      title: { type: "Text", props: { text: title } },
    };
    if (state) {
      children.push("state");
      elements.state = { type: "Badge", props: { text: state, tone: "neutral" } };
    }
    const addText = (prefix: string, value: string, style: { tone?: "default" | "muted" | "warning"; mono?: boolean } = {}) => {
      for (const [index, text] of pieces(value).entries()) {
        const id = `${prefix}${index}`;
        children.push(id);
        elements[id] = { type: "Text", props: { text, ...style } };
      }
    };
    if (reason) addText("reason", reason, { tone: "warning" });
    if (limit > 0) addText("detail", shorten(detail, limit));
    if (metadata) addText("metadata", metadata, { tone: "muted", mono: true });
    if (footer) addText("footer", footer, { tone: "muted" });
    if (at) {
      children.push("time");
      elements.time = { type: "RelativeTime", props: { at } };
    }
    if (url) {
      children.push("review");
      elements.review = { type: "Button", props: { label: appleUrl ? "Open in App Store Connect" : "Open Play Console", action: { kind: "navigate", url } } };
    }
    return { version: 1, root: "root", elements };
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
