/**
 * Hidden secret entry for `hands login`.
 *
 * The previous prompt opened a readline interface on stdin with terminal:true,
 * so readline echoed every pasted character in clear text, while our own data
 * handler appended one '*' per data *chunk* (a paste arrives as a few chunks),
 * and only a chunk that was exactly "\r"/"\n" ended input — so newlines or
 * bracketed-paste markers inside a paste chunk were stored in the token and
 * later made fetch() throw "invalid authorization header" (surfaced as
 * "fetch failed").
 *
 * This module: raw mode with no readline (nothing is echoed), processes input
 * per character, strips bracketed-paste markers and control characters, ends on
 * the first Enter, and leaves validation to `normalizeToken`.
 */

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

export type SecretKeyResult =
  | { kind: "continue"; value: string }
  | { kind: "done"; value: string }
  | { kind: "cancel" };

/** Pure reducer: feed one data chunk, get the new buffer and whether input ended. */
export function feedSecretChunk(buffer: string, chunk: string): SecretKeyResult {
  let value = buffer;
  const text = chunk.split(PASTE_START).join("").split(PASTE_END).join("");
  for (const ch of text) {
    if (ch === "\u0003") return { kind: "cancel" };
    if (ch === "\r" || ch === "\n" || ch === "\u0004") return { kind: "done", value };
    if (ch === "\u007f" || ch === "\b") {
      value = value.slice(0, -1);
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // other control chars (incl. stray ESC)
    value += ch;
  }
  return { kind: "continue", value };
}

/**
 * Trim and validate a pasted Hands JWT. Returns the clean token or an error
 * message. Only characters legal in a compact JWS (base64url + two dots) pass,
 * so a mangled paste is rejected before it is saved or sent.
 */
export function normalizeToken(raw: string): { token: string } | { error: string } {
  const token = raw.replace(/\s+/g, "");
  if (token.length === 0) return { error: "No token entered." };
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return {
      error:
        "That doesn't look like a Hands JWT (expected three base64url parts separated by dots). " +
        "Copy it again from the browser callback page, or pass it with --token.",
    };
  }
  return { token };
}

/** Prompt for a secret without echoing it. Falls back to reading a line from piped stdin. */
export async function promptSecret(message: string): Promise<string> {
  const input = process.stdin;
  process.stdout.write(message);
  if (!input.isTTY) {
    // Piped: `printf %s "$JWT" | hands login`. Read everything, first line wins.
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    process.stdout.write("\n");
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  return new Promise((resolve, reject) => {
    let buffer = "";
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    const finish = () => {
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      const result = feedSecretChunk(buffer, chunk.toString());
      if (result.kind === "cancel") {
        finish();
        reject(new Error("cancelled"));
      } else if (result.kind === "done") {
        finish();
        resolve(result.value);
      } else {
        buffer = result.value;
      }
    };
    input.on("data", onData);
  });
}
