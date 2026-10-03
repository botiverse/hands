export const GOOGLE_PLAY_MESSAGE_KEYS = [
  "existingPackage", "manualPackage", "parsed", "declared", "channel", "googleMethod", "packageMissing", "authorize", "authorizedAccount", "oauthUnavailable", "oauthHelp", "oauthFailed", "oauthCancelled", "disconnectHelp", "title", "description", "configured", "enabled", "disabled", "verified", "stale", "serviceAccount",
  "packageName", "internalTrack", "closedTrack", "productionTrack", "credentialJson", "chooseFile",
  "saveEnable", "replace", "cancel", "test", "testing", "enable", "disable", "unbind",
  "connect", "connecting", "connected", "needsConfig", "needsConfigHelp", "expand", "collapse", "saveSuccess", "verifySuccess", "enableSuccess", "disableSuccess", "unbindSuccess", "actionFailed",
  "confirmDisable", "confirmUnbind", "noPublish", "formHelp", "invalidJson",
] as const;

export type GooglePlayMessageKey = typeof GOOGLE_PLAY_MESSAGE_KEYS[number];

export const GOOGLE_PLAY_MESSAGES: Record<"en" | "zh-CN", Record<GooglePlayMessageKey, string>> = {
  en: {
    existingPackage: "Choose an existing Android package", manualPackage: "Enter another package name", parsed: "From APK inspection", declared: "From upload details", channel: "From channel settings",
    googleMethod: "Google account",
    packageMissing: "Enter the package name of this app in Play Console. No APK or credential file is needed for Google authorization.",
    authorize: "Authorize with Google",
    authorizedAccount: "Google account",
    oauthUnavailable: "Google authorization is not configured on this server.",
    oauthHelp: "Sign in with a Google account that has Play access to this package and the configured tracks. No service-account key is needed.",
    oauthFailed: "Google authorization failed. Check Play permissions and try again.",
    oauthCancelled: "Google authorization was cancelled.",
    disconnectHelp: "Unbind deletes the credential stored by Hands. To revoke Google's grant as well, remove Hands in your Google account connections.",

    title: "Google Play",
    description: "Connect your Google account to this app’s Play Console entry.",
    configured: "Configured", enabled: "Enabled", disabled: "Disabled", verified: "Verified", stale: "Needs verification",
    serviceAccount: "Service account", packageName: "Android package name", internalTrack: "Internal track",
    closedTrack: "Closed testing track", productionTrack: "Production track", credentialJson: "Service account JSON",
    chooseFile: "Choose JSON file", saveEnable: "Validate, save & enable", replace: "Replace credential", cancel: "Cancel",
    connect: "Connect", connecting: "Connecting to Google…", connected: "Connected", needsConfig: "Needs configuration", needsConfigHelp: "The Google account is connected. Add the package name and the three tracks, then save to finish configuring.", expand: "Expand", collapse: "Collapse", test: "Test connection", testing: "Testing…", enable: "Enable", disable: "Disable", unbind: "Unbind",
    saveSuccess: "Google Play binding saved", verifySuccess: "Google Play connection verified",
    enableSuccess: "Google Play enabled", disableSuccess: "Google Play disabled", unbindSuccess: "Google Play unbound",
    actionFailed: "Google Play action failed", confirmDisable: "Disable Google Play promotion for this app?",
    confirmUnbind: "Remove this app's encrypted Google Play credential and binding?",
    noPublish: "Connection testing creates and deletes a temporary Play edit; it never publishes a release.",
    formHelp: "Use a service account that can access this exact package and all three configured tracks.",
    invalidJson: "Choose the complete service-account JSON file downloaded from Google Cloud.",
  },
  "zh-CN": {
    existingPackage: "选择已有 Android 包名", manualPackage: "手动填写其他包名", parsed: "APK 解析结果", declared: "上传时声明", channel: "渠道设置",
    googleMethod: "Google 账号授权",
    packageMissing: "请填写此应用在 Play Console 的包名。Google 授权无需选择 APK 或凭据文件。",
    authorize: "使用 Google 授权",
    authorizedAccount: "Google 账号",
    oauthUnavailable: "此服务器尚未配置 Google 授权。",
    oauthHelp: "请登录拥有此包名及所配轨道 Play 权限的 Google 账号，无需创建服务账号密钥。",
    oauthFailed: "Google 授权失败，请检查 Play 权限后重试。",
    oauthCancelled: "Google 授权已取消。",
    disconnectHelp: "解除绑定会删除 Hands 保存的凭据。若也要撤销 Google 的授权，请在 Google 账号的第三方连接中移除 Hands。",

    title: "Google Play",
    description: "授权 Google 账号，将此应用连接到对应的 Play Console 应用。",
    configured: "已配置", enabled: "已启用", disabled: "已停用", verified: "已验证", stale: "需要重新验证",
    serviceAccount: "服务账号", packageName: "Android 包名", internalTrack: "内部测试轨道",
    closedTrack: "封闭测试轨道", productionTrack: "正式发布轨道", credentialJson: "服务账号 JSON",
    chooseFile: "选择 JSON 文件", saveEnable: "验证、保存并启用", replace: "更换凭据", cancel: "取消",
    connect: "连接", connecting: "正在前往 Google 授权…", connected: "已连接", needsConfig: "待配置", needsConfigHelp: "授权已完成，填好包名和三个 track 后保存即可完成配置。", expand: "展开", collapse: "收起", test: "测试连接", testing: "测试中…", enable: "启用", disable: "停用", unbind: "解除绑定",
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
