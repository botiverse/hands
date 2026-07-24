import { describe, expect, it } from "vitest";
import {
  addChangelogLanguage,
  isValidChangelogLanguage,
  normalizeChangelogLanguage,
  parseChangelog,
  removeChangelogLanguage,
  serializeChangelog,
  updateChangelogEntry,
} from "./changelogFormat";

describe("changelog editor format", () => {
  it("keeps legacy plain Markdown as plain text", () => {
    const parsed = parseChangelog("## Changes\n- Fixed sync");
    expect(parsed).toEqual({
      localized: false,
      entries: [{ language: "default", markdown: "## Changes\n- Fixed sync" }],
    });
    expect(serializeChangelog(parsed)).toBe("## Changes\n- Fixed sync");
  });

  it("opens localized JSON as canonical language entries instead of raw JSON", () => {
    const parsed = parseChangelog(JSON.stringify({ en: "- Fixed sync", "zh-Hans": "- 修复同步" }));
    expect(parsed.localized).toBe(true);
    expect(parsed.entries).toEqual([
      { language: "zh-CN", markdown: "- 修复同步" },
      { language: "en", markdown: "- Fixed sync" },
    ]);
    expect(JSON.parse(serializeChangelog(parsed))).toEqual({
      "zh-CN": "- 修复同步",
      en: "- Fixed sync",
    });
  });

  it("canonicalizes aliases in storage order with Worker-compatible last-write-wins", () => {
    expect(parseChangelog('{"en-US":"US","en":"EN"}').entries).toEqual([
      { language: "en", markdown: "EN" },
    ]);
    expect(parseChangelog('{"en":"EN","en-US":"US"}').entries).toEqual([
      { language: "en", markdown: "US" },
    ]);
    expect(parseChangelog('{"en":"EN","en-US":"   "}').entries).toEqual([
      { language: "en", markdown: "EN" },
    ]);
    expect(parseChangelog('{"en-US":"   ","en":"EN"}').entries).toEqual([
      { language: "en", markdown: "EN" },
    ]);
    expect(parseChangelog('{"zh":"简体一","zh-Hans":"简体二","zh-Hant":"繁體"}').entries).toEqual([
      { language: "zh-CN", markdown: "简体二" },
      { language: "zh-TW", markdown: "繁體" },
    ]);
  });

  it("edits, adds and removes canonical languages without changing the storage contract", () => {
    let parsed = parseChangelog("- Initial note");
    parsed = addChangelogLanguage(parsed, "en-US");
    parsed = addChangelogLanguage(parsed, "zh-Hans");
    parsed = updateChangelogEntry(parsed, "zh-CN", "- 初始说明");
    expect(JSON.parse(serializeChangelog(parsed))).toEqual({
      "zh-CN": "- 初始说明",
      en: "- Initial note",
    });

    parsed = removeChangelogLanguage(parsed, "EN");
    expect(parsed).toEqual({
      localized: true,
      entries: [{ language: "zh-CN", markdown: "- 初始说明" }],
    });

    parsed = removeChangelogLanguage(parsed, "zh-CN");
    expect(parsed).toEqual({
      localized: true,
      entries: [{ language: "zh-CN", markdown: "- 初始说明" }],
    });
  });

  it("preserves legacy English/default meaning when the first added language is Chinese", () => {
    const localized = addChangelogLanguage(parseChangelog("- Existing English note"), "zh-CN");
    expect(localized.entries).toEqual([
      { language: "zh-CN", markdown: "" },
      { language: "en", markdown: "- Existing English note" },
    ]);
    expect(JSON.parse(serializeChangelog(localized))).toEqual({
      "zh-CN": "",
      en: "- Existing English note",
    });
  });

  it("rejects case and alias collisions after canonical normalization", () => {
    const localized = parseChangelog('{"en":"English","zh-CN":"中文"}');
    expect(addChangelogLanguage(localized, "EN")).toBe(localized);
    expect(addChangelogLanguage(localized, "en-US")).toBe(localized);
    expect(addChangelogLanguage(localized, "zh-Hans")).toBe(localized);
  });

  it("normalizes the same locale aliases as the Worker and validates canonical tags", () => {
    expect(normalizeChangelogLanguage("zh-Hans")).toBe("zh-CN");
    expect(normalizeChangelogLanguage("zh-Hant")).toBe("zh-TW");
    expect(normalizeChangelogLanguage("EN-us")).toBe("en");
    expect(isValidChangelogLanguage("zh-CN")).toBe(true);
    expect(isValidChangelogLanguage("en")).toBe(true);
    expect(isValidChangelogLanguage("pt-BR")).toBe(true);
    expect(isValidChangelogLanguage("default")).toBe(false);
    expect(isValidChangelogLanguage("__proto__")).toBe(false);
  });

  it("does not mistake arrays, scalar JSON or mixed objects for localized notes", () => {
    expect(parseChangelog('["one"]')).toMatchObject({ localized: false });
    expect(parseChangelog('"one"')).toMatchObject({ localized: false });
    expect(parseChangelog('{"en":"one","count":2}')).toMatchObject({ localized: false });
  });

  it("removing an alias-canonicalized entry preserves all remaining public values", () => {
    const before = parseChangelog('{"en-US":"English","zh-Hans":"简体","zh-Hant":"繁體"}');
    const after = removeChangelogLanguage(before, "zh-hans");
    expect(JSON.parse(serializeChangelog(before))).toEqual({
      "zh-CN": "简体",
      "zh-TW": "繁體",
      en: "English",
    });
    expect(JSON.parse(serializeChangelog(after))).toEqual({
      "zh-TW": "繁體",
      en: "English",
    });
  });
});
