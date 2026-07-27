import { describe, expect, it } from "vitest";
import {
  FEEDBACK_MESSAGES,
  FEEDBACK_MESSAGE_KEYS,
  feedbackMessage,
} from "./feedbackMessages";

describe("feedback staff visibility messages", () => {
  it("keeps English and Simplified Chinese keys complete", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      expect(Object.keys(FEEDBACK_MESSAGES[locale]).sort()).toEqual(
        [...FEEDBACK_MESSAGE_KEYS].sort(),
      );
    }
  });

  it("selects Chinese aliases and falls back to English", () => {
    expect(feedbackMessage("sendToReporter", ["zh-Hans-CN"])).toBe("发送给用户");
    expect(feedbackMessage("sendToReporter", ["fr-FR"])).toBe("Send to reporter");
  });
});
