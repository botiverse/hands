export const FEEDBACK_MESSAGE_KEYS = [
  "internalNote",
  "visibleToReporter",
  "addInternalNote",
  "sendToReporter",
] as const;

export type FeedbackMessageKey = typeof FEEDBACK_MESSAGE_KEYS[number];

export const FEEDBACK_MESSAGES: Record<"en" | "zh-CN", Record<FeedbackMessageKey, string>> = {
  en: {
    internalNote: "Internal note",
    visibleToReporter: "Visible to reporter",
    addInternalNote: "Add internal note",
    sendToReporter: "Send to reporter",
  },
  "zh-CN": {
    internalNote: "内部备注",
    visibleToReporter: "用户可见",
    addInternalNote: "添加内部备注",
    sendToReporter: "发送给用户",
  },
};

export function feedbackMessage(
  key: FeedbackMessageKey,
  languages: readonly string[] = typeof navigator === "undefined"
    ? ["en"]
    : navigator.languages,
): string {
  const locale = languages.some((language) => language.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
  return FEEDBACK_MESSAGES[locale][key] ?? FEEDBACK_MESSAGES.en[key];
}
