const messages = {
  en: {
    privacy: "Privacy Policy", terms: "Terms of Service", contact: "Contact us",
    product: "Product", resources: "Resources", sdks: "SDKs", company: "Company",
    features: "Features", integrations: "Integrations", docs: "Docs",
    cli: "CLI Reference", api: "API Explorer",
    tagline: "Ship client apps with humans and agents.", copyright: "All rights reserved.",
  },
  "zh-CN": {
    privacy: "隐私政策", terms: "服务条款", contact: "联系我们",
    product: "产品", resources: "资源", sdks: "SDK", company: "公司",
    features: "功能", integrations: "集成", docs: "文档",
    cli: "CLI 参考", api: "API 浏览器",
    tagline: "与人和智能体一起发布客户端应用。", copyright: "保留所有权利。",
  },
};

export function legalMessage(key: keyof typeof messages.en): string {
  const languages = typeof navigator === "undefined" ? ["en"] : navigator.languages;
  return messages[languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh-CN" : "en"][key];
}
