export const GOOGLE_PLAY_MESSAGE_KEYS = [
  "title", "description", "configured", "enabled", "disabled", "verified", "stale", "serviceAccount",
  "packageName", "internalTrack", "closedTrack", "productionTrack", "credentialJson", "chooseFile",
  "saveEnable", "replace", "cancel", "test", "testing", "enable", "disable", "unbind",
  "saveSuccess", "verifySuccess", "enableSuccess", "disableSuccess", "unbindSuccess", "actionFailed",
  "confirmDisable", "confirmUnbind", "noPublish", "formHelp", "invalidJson",
] as const;

export type GooglePlayMessageKey = typeof GOOGLE_PLAY_MESSAGE_KEYS[number];

export const GOOGLE_PLAY_MESSAGES: Record<"en" | "zh-CN", Record<GooglePlayMessageKey, string>> = {
  en: {
    title: "Google Play",
    description: "Bind this app to its own Google Play service account. Credentials are encrypted and never shown again.",
    configured: "Configured", enabled: "Enabled", disabled: "Disabled", verified: "Verified", stale: "Needs verification",
    serviceAccount: "Service account", packageName: "Android package name", internalTrack: "Internal track",
    closedTrack: "Closed testing track", productionTrack: "Production track", credentialJson: "Service account JSON",
    chooseFile: "Choose JSON file", saveEnable: "Validate, save & enable", replace: "Replace credential", cancel: "Cancel",
    test: "Test connection", testing: "Testing…", enable: "Enable", disable: "Disable", unbind: "Unbind",
    saveSuccess: "Google Play binding saved", verifySuccess: "Google Play connection verified",
    enableSuccess: "Google Play enabled", disableSuccess: "Google Play disabled", unbindSuccess: "Google Play unbound",
    actionFailed: "Google Play action failed", confirmDisable: "Disable Google Play promotion for this app?",
    confirmUnbind: "Remove this app's encrypted Google Play credential and binding?",
    noPublish: "Connection testing creates and deletes a temporary Play edit; it never publishes a release.",
    formHelp: "Use a service account that can access this exact package and all three configured tracks.",
    invalidJson: "Choose the complete service-account JSON file downloaded from Google Cloud.",
  },
  "zh-CN": {
    title: "Google Play",
    description: "将此应用绑定到它自己的 Google Play 服务账号。凭据会加密保存，保存后不会再次显示。",
    configured: "已配置", enabled: "已启用", disabled: "已停用", verified: "已验证", stale: "需要重新验证",
    serviceAccount: "服务账号", packageName: "Android 包名", internalTrack: "内部测试轨道",
    closedTrack: "封闭测试轨道", productionTrack: "正式发布轨道", credentialJson: "服务账号 JSON",
    chooseFile: "选择 JSON 文件", saveEnable: "验证、保存并启用", replace: "更换凭据", cancel: "取消",
    test: "测试连接", testing: "测试中…", enable: "启用", disable: "停用", unbind: "解除绑定",
    saveSuccess: "Google Play 绑定已保存", verifySuccess: "Google Play 连接验证成功",
    enableSuccess: "Google Play 已启用", disableSuccess: "Google Play 已停用", unbindSuccess: "Google Play 已解除绑定",
    actionFailed: "Google Play 操作失败", confirmDisable: "停用此应用的 Google Play 发布功能？",
    confirmUnbind: "删除此应用加密保存的 Google Play 凭据并解除绑定？",
    noPublish: "连接测试只会创建并删除一个临时 Play edit，不会发布任何版本。",
    formHelp: "请使用能访问这个确切包名和下列三个轨道的服务账号。",
    invalidJson: "请选择从 Google Cloud 下载的完整服务账号 JSON 文件。",
  },
};

export function googlePlayMessage(
  key: GooglePlayMessageKey,
  languages: readonly string[] = typeof navigator === "undefined" ? ["en"] : navigator.languages,
) {
  const locale = languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
  return GOOGLE_PLAY_MESSAGES[locale][key] ?? GOOGLE_PLAY_MESSAGES.en[key];
}
