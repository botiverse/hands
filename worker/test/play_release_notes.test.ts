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
    expect(result).toEqual({ present: true, skipped: [], notes: [
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

  it("skips and reports unsupported keys instead of failing", () => {
    expect(playReleaseNotesFromChangelog(JSON.stringify({ "zh-cn": "修复", fr: "Corrections", en: "Fixes", "pt-BR": "Correções" })))
      .toEqual({ present: true, skipped: ["fr", "pt-BR"], notes: [
        { language: "zh-CN", text: "修复" },
        { language: "en-US", text: "Fixes" },
      ] });
    // All keys unsupported: still localized, nothing to send, every key recorded.
    expect(playReleaseNotesFromChangelog(JSON.stringify({ fr: "Corrections", de: "Fehlerbehebungen" })))
      .toEqual({ present: true, notes: [], skipped: ["fr", "de"] });
    // An unsupported key is not length-checked: it is never sent.
    expect(errorCode(JSON.stringify({ en: "ok", fr: "x".repeat(501) }))).toBeNull();
  });

  it("dedupes two keys for one Play language with identical text, and errors when they differ", () => {
    expect(playReleaseNotesFromChangelog(JSON.stringify({ zh: "**修复**", "zh-cn": "修复" })))
      .toEqual({ present: true, skipped: [], notes: [{ language: "zh-CN", text: "修复" }] });
    expect(errorCode(JSON.stringify({ zh: "a", "zh-cn": "b" }))).toBe("play_release_notes_locale_duplicate");
  });

  it("fails closed on malformed entries", () => {
    expect(errorCode(JSON.stringify({ en: 1 }))).toBe("play_release_notes_invalid");
    expect(errorCode("{oops")).toBe("play_release_notes_invalid");
    expect(errorCode("{}")).toBeNull();
  });
});
