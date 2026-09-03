import { describe, expect, it } from "vitest";
import { GOOGLE_PLAY_MESSAGES, GOOGLE_PLAY_MESSAGE_KEYS, googlePlayMessage } from "./googlePlayMessages";

describe("Google Play app binding messages", () => {
  it("keeps English and Simplified Chinese keys complete", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      expect(Object.keys(GOOGLE_PLAY_MESSAGES[locale]).sort()).toEqual([...GOOGLE_PLAY_MESSAGE_KEYS].sort());
    }
  });

  it("selects Chinese aliases and falls back to English", () => {
    expect(googlePlayMessage("enable", ["zh-Hans-CN"])).toBe("启用");
    expect(googlePlayMessage("enable", ["fr-FR"])).toBe("Enable");
  });
});
