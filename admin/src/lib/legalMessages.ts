const messages = {
  en: { privacy: "Privacy Policy", terms: "Terms of Service" },
  "zh-CN": { privacy: "隐私政策", terms: "服务条款" },
};

export function legalMessage(key: keyof typeof messages.en): string {
  const languages = typeof navigator === "undefined" ? ["en"] : navigator.languages;
  return messages[languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en"][key];
}
