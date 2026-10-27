/**
 * Hands release changelog -> Google Play `releaseNotes` (LocalizedText[]).
 *
 * Deliberately NOT built on `normalizeReleaseNotesKey` (release_notes.ts): that
 * maps en -> "en" and ja -> "ja", which suits Hands' own update checks but is not
 * what Play lists ("en-US", "ja-JP"). zh-cn -> "zh-CN" happens to coincide, which
 * is exactly how the mismatch would hide. This table is explicit and closed: a
 * changelog key that is not listed fails closed instead of being guessed at or
 * silently dropped, because a dropped language means those users see no notes.
 */
export const PLAY_RELEASE_NOTES_LOCALES: Readonly<Record<string, string>> = Object.freeze({
  zh: "zh-CN",
  cn: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-hans-cn": "zh-CN",
  "zh-tw": "zh-TW",
  "zh-hant": "zh-TW",
  "zh-hant-tw": "zh-TW",
  "zh-hk": "zh-HK",
  "zh-hant-hk": "zh-HK",
  en: "en-US",
  "en-us": "en-US",
  "en-gb": "en-GB",
  ja: "ja-JP",
  "ja-jp": "ja-JP",
  ko: "ko-KR",
  "ko-kr": "ko-KR",
});

/** Google Play's per-language release notes limit. Exceeding it is an error, never a truncation. */
export const PLAY_RELEASE_NOTES_MAX_CHARS = 500;

export type PlayReleaseNotesErrorCode =
  | "play_release_notes_invalid"
  | "play_release_notes_locale_unsupported"
  | "play_release_notes_locale_duplicate"
  | "play_release_notes_too_long";

export class PlayReleaseNotesError extends Error {
  constructor(public readonly code: PlayReleaseNotesErrorCode, message: string) {
    super(message);
  }
}

export interface PlayReleaseNote {
  language: string;
  text: string;
}

export type PlayReleaseNotesResult =
  | { present: true; notes: PlayReleaseNote[] }
  | { present: false; reason: "no_changelog" | "changelog_not_localized" | "changelog_empty" };

/**
 * Play renders release notes as plain text, so Markdown bold markers would show
 * up literally ("🐛 **修复**"). Only `**` is removed: bullets ("- ") and line
 * breaks read fine as plain text and are kept. Line endings are normalised.
 */
export function playPlainText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\*\*/g, "").trim();
}

/** Unicode code points, so an emoji counts once rather than as two UTF-16 units. */
export function playCharCount(text: string): number {
  return [...text].length;
}

/**
 * Map a release's stored changelog to Play release notes.
 *
 * - null/blank changelog -> absent (promote proceeds without notes).
 * - plain-text (non-JSON) changelog -> absent: it carries no language, and
 *   guessing one would publish it under the wrong locale.
 * - JSON object -> every non-empty entry must map through the table, map to a
 *   distinct Play language and fit in 500 characters after plain-text conversion;
 *   otherwise PlayReleaseNotesError (fail closed, before any Play call).
 */
export function playReleaseNotesFromChangelog(raw: string | null | undefined): PlayReleaseNotesResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { present: false, reason: "no_changelog" };
  if (!trimmed.startsWith("{")) return { present: false, reason: "changelog_not_localized" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new PlayReleaseNotesError("play_release_notes_invalid", "release changelog looks like JSON but does not parse");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PlayReleaseNotesError("play_release_notes_invalid", "release changelog must be a JSON object of language -> text");
  }
  const notes: PlayReleaseNote[] = [];
  const sourceFor = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new PlayReleaseNotesError("play_release_notes_invalid", `release changelog entry "${key}" must be a string`);
    }
    const text = playPlainText(value);
    if (!text) continue;
    const language = PLAY_RELEASE_NOTES_LOCALES[key.trim().toLowerCase()];
    if (!language) {
      throw new PlayReleaseNotesError(
        "play_release_notes_locale_unsupported",
        `release changelog key "${key}" has no Google Play language mapping (supported: ${[...new Set(Object.values(PLAY_RELEASE_NOTES_LOCALES))].join(", ")})`,
      );
    }
    const previous = sourceFor.get(language);
    if (previous !== undefined) {
      throw new PlayReleaseNotesError(
        "play_release_notes_locale_duplicate",
        `release changelog keys "${previous}" and "${key}" both map to Google Play language ${language}`,
      );
    }
    const chars = playCharCount(text);
    if (chars > PLAY_RELEASE_NOTES_MAX_CHARS) {
      throw new PlayReleaseNotesError(
        "play_release_notes_too_long",
        `release notes for ${language} (changelog key "${key}") are ${chars} characters; Google Play allows at most ${PLAY_RELEASE_NOTES_MAX_CHARS}`,
      );
    }
    sourceFor.set(language, key);
    notes.push({ language, text });
  }
  return notes.length > 0 ? { present: true, notes } : { present: false, reason: "changelog_empty" };
}
