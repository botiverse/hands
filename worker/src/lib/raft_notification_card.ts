/** Build the display-only Raft card and the independently readable fallback.
 * Delivery and revision ordering are deliberately kept outside this renderer. */
import { formatRaftNotificationMessage, raftNotificationCurrentState } from "./raft_notification_content";

type Payload = Record<string, unknown>;
type App = { id: string; slug: string | null; name: string | null };
type CardElement =
  | { type: "Stack"; props: { direction: "column" }; children: string[] }
  | { type: "Text"; props: { text: string } }
  | { type: "Badge"; props: { text: string; tone: "neutral" } }
  | { type: "Button"; props: { label: string; action: { kind: "navigate"; url: string } } };
export interface RaftMessageCard {
  version: 1;
  root: string;
  elements: Record<string, CardElement>;
}

const MAX_CARD_BYTES = 8192;
const TEXT_LIMIT = 500;
// Leave room for the title, badge, footer and button within the 12-child limit.
const BODY_LIMIT = 3000;
const FOOTER_LIMIT = 1000;

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
  const content = formatRaftNotificationMessage(body, knownApp);
  const [heading = "Hands", ...lines] = content.split("\n");
  const title = shorten(plain(heading.replace(/\*\*/g, "")), 160);
  const url = reviewUrl(record(body.payload));
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
  // A canonical Apple URL is rendered as a navigate-only button. Never turn
  // another URL into a button or a raw link on the card. Bound each remaining
  // item so a long observation cannot displace the event time.
  const footer = shorten(footerLines.filter((line) => !line.startsWith("Review: ") && !line.startsWith("[Open App Store Connect]("))
    .map((line) => shorten(plain(line), line.startsWith("observation: ") || line.startsWith("Observation: ") ? 250
      : line.startsWith("occurred: ") || line.startsWith("At: ") ? 120 : 256)).join("\n"), FOOTER_LIMIT);
  const detail = plain(detailLines.join("\n"));

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
    const addText = (prefix: string, value: string) => {
      for (const [index, text] of pieces(value).entries()) {
        const id = `${prefix}${index}`;
        children.push(id);
        elements[id] = { type: "Text", props: { text } };
      }
    };
    if (limit > 0) addText("detail", shorten(detail, limit));
    if (footer) addText("footer", footer);
    if (url) {
      children.push("review");
      elements.review = { type: "Button", props: { label: "Open in App Store Connect", action: { kind: "navigate", url } } };
    }
    return { version: 1, root: "root", elements };
  };

  // JSON escaping and multibyte text make a character limit insufficient for
  // Raft's 8 KiB wire limit. Retain footer and title and fit the detail by bytes.
  let low = 0;
  let high = Math.min(BODY_LIMIT, Array.from(detail).length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const size = new TextEncoder().encode(JSON.stringify(build(middle))).byteLength;
    if (size <= MAX_CARD_BYTES) low = middle;
    else high = middle - 1;
  }
  return { card: build(low), content };
}
