import { describe, expect, it } from "vitest";
import { normalizeReleaseNotesKey } from "../src/lib/release_notes";
import {
  PLAY_RELEASE_NOTES_LOCALES,
  PlayReleaseNotesError,
  playPlainText,
  playReleaseNotesFromChangelog,
} from "../src/lib/play_release_notes";

function errorCode(raw: string): string | null {
  try {
    playReleaseNotesFromChangelog(raw);
    return null;
  } catch (error) {
    return error instanceof PlayReleaseNotesError ? error.code : "unexpected";
  }
}

describe("Hands changelog -> Google Play releaseNotes", () => {
  it("maps Hands keys to Play BCP-47 tags, not the Hands update-check keys", () => {
    expect(PLAY_RELEASE_NOTES_LOCALES).toMatchObject({
      "zh-cn": "zh-CN", "zh-tw": "zh-TW", en: "en-US", ja: "ja-JP",
    });
    // The bug this table exists for: the Hands normaliser keeps en/ja bare.
    expect(normalizeReleaseNotesKey("en")).toBe("en");
    expect(normalizeReleaseNotesKey("ja")).toBe("ja");
    const result = playReleaseNotesFromChangelog(JSON.stringify({ "zh-cn": "修复", en: "Fixes", ja: "修正", "zh-TW": "修復" }));
    expect(result).toEqual({ present: true, notes: [
      { language: "zh-CN", text: "修复" },
      { language: "en-US", text: "Fixes" },
      { language: "ja-JP", text: "修正" },
      { language: "zh-TW", text: "修復" },
    ] });
  });

  it("strips Markdown bold markers and normalises line endings, keeping bullets", () => {
    expect(playPlainText("🐛 **修复**\r\n- **a** b\r- c  ")).toBe("🐛 修复\n- a b\n- c");
  });

  it("records absence instead of failing when there is nothing localized to send", () => {
    expect(playReleaseNotesFromChangelog(null)).toEqual({ present: false, reason: "no_changelog" });
    expect(playReleaseNotesFromChangelog("   ")).toEqual({ present: false, reason: "no_changelog" });
    expect(playReleaseNotesFromChangelog("Bug fixes")).toEqual({ present: false, reason: "changelog_not_localized" });
    expect(playReleaseNotesFromChangelog(JSON.stringify({ en: "  ", ja: "****" }))).toEqual({ present: false, reason: "changelog_empty" });
  });

  it("counts 500 characters in code points after conversion and errors above it", () => {
    expect(playReleaseNotesFromChangelog(JSON.stringify({ en: "🐛".repeat(500) }))).toMatchObject({ present: true });
    // Bold markers do not count: they are removed before measuring.
    expect(playReleaseNotesFromChangelog(JSON.stringify({ en: `**${"x".repeat(500)}**` }))).toMatchObject({ present: true });
    expect(errorCode(JSON.stringify({ en: "x".repeat(501) }))).toBe("play_release_notes_too_long");
  });

  it("fails closed on unknown, duplicate, or malformed entries", () => {
    expect(errorCode(JSON.stringify({ fr: "Corrections" }))).toBe("play_release_notes_locale_unsupported");
    expect(errorCode(JSON.stringify({ zh: "a", "zh-cn": "b" }))).toBe("play_release_notes_locale_duplicate");
    expect(errorCode(JSON.stringify({ en: 1 }))).toBe("play_release_notes_invalid");
    expect(errorCode("{oops")).toBe("play_release_notes_invalid");
    expect(errorCode("{}")).toBeNull();
  });
});
