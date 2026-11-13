/**
 * Render a Raft message card as plain message text, following the rules Raft
 * itself uses to write markdown from a card (the `card:` section agents read):
 *
 * - the header first: its title in bold, the subtitle on the next line, the
 *   tags as `[text]` on one line;
 * - a column's elements are blocks with a blank line between them; a row's are
 *   on one line, joined with ` · ` (a Markdown, Fields or Divider in a row is a
 *   block of its own);
 * - a Text as written (`⚠️ ` before a warning one; a `mono` one as `code`), a
 *   Badge as `[text]`, times in UTC (`2026-11-03 12:03:00Z`; a Duration as
 *   `start – end`, or `start –` while it runs);
 * - a Button as `[label](url)`; a Markdown element as written; Fields as one
 *   `**label:** value` line each (a `mono` value as `code`); a Divider as `---`;
 * - card text is plain text, so markdown in it is escaped (Markdown elements
 *   aside), and an `@name` shows as `` `@name` ``: it mentions no one.
 *
 * Used when a destination wants the card's layout without a card message.
 */
type Element = { type: string; props?: Record<string, any>; children?: string[] };
export interface RenderableCard {
  header?: { title: string; subtitle?: string; tags?: Array<{ text: string }> };
  root: string;
  elements: Record<string, Element>;
}

// After escaping, a backtick before `@` is the escaped "\`", so it does not protect the name.
const MENTION = /(^|[^\w])(@[A-Za-z0-9][\w.-]*)/g;
// A line that would start a list, quote, heading or rule (or underline the line
// above it into a heading) in a message; its first marker character is escaped.
const LINE_MARKER = /^([ \t]*)([-+*]|\d{1,9}[.)]|#{1,6}|>|=+|-{2,}|_{3,})(?=[ \t]|$)/;

/** Escape markdown in plain card text; `@name` becomes inline code so it mentions no one. */
export function escapeCardText(text: string): string {
  const escaped = text
    .replace(/([\\`*_~[\]<>|&])/g, "\\$1")
    .split("\n")
    .map((line) => line.replace(LINE_MARKER, (_m, indent: string, marker: string) => `${indent}\\${marker}`))
    .join("\n");
  return escaped.replace(MENTION, (_m, lead: string, name: string) => `${lead}\`${name}\``);
}

function code(text: string): string {
  if (!text) return "";
  // A code span cannot cross lines safely in a message; write each line as its own span.
  if (text.includes("\n")) return text.split("\n").map((line) => (line ? code(line) : "")).join("\n");
  // Inline code shows its content literally; use a longer fence if it contains backticks.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** `2026-11-03T12:03:00.000Z` → `2026-11-03 12:03:00Z`; anything unparseable as written. */
export function cardTime(at: unknown): string {
  if (typeof at !== "string") return "";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return escapeCardText(at);
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

const BLOCK_IN_ROW = new Set(["Markdown", "Fields", "Divider"]);

function inline(el: Element): string {
  const p = el.props ?? {};
  switch (el.type) {
    case "Text": {
      const body = p.mono ? code(String(p.text ?? "")) : escapeCardText(String(p.text ?? ""));
      return p.tone === "warning" ? `⚠️ ${body}` : body;
    }
    case "Badge":
      return `[${escapeCardText(String(p.text ?? ""))}]`;
    case "RelativeTime":
      return cardTime(p.at);
    case "Duration":
      return p.end ? `${cardTime(p.start)} – ${cardTime(p.end)}` : `${cardTime(p.start)} –`;
    case "Button": {
      const label = escapeCardText(String(p.label ?? ""));
      if (p.disabled) return `${label} (disabled: ${escapeCardText(String(p.disabledReason ?? p.reason ?? ""))})`;
      const url = p.action?.url;
      // Characters that would end the link destination early are percent-encoded.
      return typeof url === "string" ? `[${label}](${url.replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})` : label;
    }
    default:
      return "";
  }
}

function block(el: Element): string {
  const p = el.props ?? {};
  switch (el.type) {
    case "Markdown":
      return String(p.content ?? "");
    case "Fields":
      return (Array.isArray(p.items) ? p.items : [])
        .map((item: any) => `**${escapeCardText(String(item.label ?? ""))}:** ${
          item.mono ? code(String(item.value ?? "")) : escapeCardText(String(item.value ?? ""))}`)
        .join("\n");
    case "Divider":
      return "---";
    default:
      return inline(el);
  }
}

/**
 * `transitionFrom` is a Hands addition to Raft's rules: when a status card
 * says what the state was before, the tag line reads `[before] -> [after]`.
 */
export function renderRaftCardAsText(card: RenderableCard, options: { transitionFrom?: string } = {}): string {
  const out: string[] = [];
  if (card.header) {
    const head = [`**${escapeCardText(card.header.title)}**`];
    if (card.header.subtitle) head.push(escapeCardText(card.header.subtitle));
    const tags = (card.header.tags ?? []).map((t) => `[${escapeCardText(t.text)}]`).join(" ");
    if (tags && options.transitionFrom) head.push(`[${escapeCardText(options.transitionFrom)}] -> ${tags}`);
    else if (tags) head.push(tags);
    out.push(head.join("\n"));
  }
  const seen = new Set<string>();
  const walk = (id: string, depth: number): string[] => {
    const el = card.elements[id];
    if (!el || seen.has(id) || depth > 8) return [];
    seen.add(id);
    if (el.type !== "Stack") {
      const text = block(el);
      return text ? [text] : [];
    }
    const children = el.children ?? [];
    if ((el.props?.direction ?? "column") !== "row") return children.flatMap((child) => walk(child, depth + 1));
    // A row: inline elements joined on one line; Markdown/Fields/Divider (and
    // nested stacks) break out as blocks of their own, in order.
    const blocks: string[] = [];
    let line: string[] = [];
    const flush = () => { if (line.length) blocks.push(line.join(" · ")); line = []; };
    for (const child of children) {
      const c = card.elements[child];
      if (!c) continue;
      if (c.type === "Stack" || BLOCK_IN_ROW.has(c.type)) { flush(); blocks.push(...walk(child, depth + 1)); continue; }
      seen.add(child);
      const text = inline(c);
      if (text) line.push(text);
    }
    flush();
    return blocks;
  };
  out.push(...walk(card.root, 0));
  return out.join("\n\n");
}

/**
 * Hands' status-card text: when the card's first Text names the earlier state
 * ("Previously: X"), the single tag line reads `[X] -> [tag]` and that first
 * line is dropped; any later lines of that Text stay. Only the first Text may
 * carry it, so a later chunk of notes beginning "Previously:" is left alone.
 */
export function renderStatusCardAsText(card: RenderableCard): string {
  const root = card.elements[card.root];
  if (root?.type !== "Stack" || card.header?.tags?.length !== 1) return renderRaftCardAsText(card);
  const children = root.children ?? [];
  const firstTextId = children.find((id) => card.elements[id]?.type === "Text");
  const first = firstTextId ? card.elements[firstTextId] : undefined;
  const text = typeof first?.props?.text === "string" ? first.props.text : "";
  if (!firstTextId || !first || first.props?.mono || first.props?.tone === "warning" || !/^Previously: \S/.test(text)) {
    return renderRaftCardAsText(card);
  }
  const [line, ...rest] = text.split("\n");
  const remaining = rest.join("\n").trim();
  const shown: RenderableCard = remaining
    ? { ...card, elements: { ...card.elements, [firstTextId]: { ...first, props: { ...first.props, text: remaining } } } }
    : { ...card, elements: { ...card.elements, [card.root]: { ...root, children: children.filter((id) => id !== firstTextId) } } };
  return renderRaftCardAsText(shown, { transitionFrom: line.slice("Previously: ".length).trim() });
}
