const messages = {
  en: {
    loading: "Loading application…",
    invalid: "Invalid application link",
    uuidHint: "Open the application from the application list. Settings links use the full application UUID, not its name or slug.",
    unavailable: "Application unavailable",
    accessHint: "This application may no longer exist, or your account may not have access. Ask an application administrator to confirm your access.",
    loadFailed: "We could not load your applications. Return to the application list and try again.",
    back: "Back to applications",
  },
  "zh-CN": {
    loading: "正在加载应用…",
    invalid: "应用链接无效",
    uuidHint: "请从应用列表打开应用。设置链接使用完整的应用 UUID，而不是名称或 slug。",
    unavailable: "应用不可用",
    accessHint: "应用可能已被删除，或当前账号没有访问权限。请联系应用管理员确认权限。",
    loadFailed: "无法加载应用列表，请返回应用列表后重试。",
    back: "返回应用列表",
  },
};
export function appRouteMessage(key: keyof typeof messages.en): string {
  const languages = typeof navigator === "undefined" ? ["en"] : navigator.languages;
  return messages[languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en"][key];
}
