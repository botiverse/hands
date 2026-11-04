import translations from "./openapi-zh.json";

/** Translate documentation text only. API paths, schemas, examples and values stay byte-for-byte equivalent. */
export const OPENAPI_ZH: Readonly<Record<string, string>> = translations;
export const OPENAPI_TAG_ZH: Readonly<Record<string, string>> = {
  System: "系统",
  Auth: "认证",
  "Public update": "公开更新",
  "Public feedback": "公开反馈",
  "Public metrics": "公开指标",
  "Reporter Feedback": "报告者反馈",
  "Apple webhooks": "Apple Webhook",
  "Public pages": "公开页面",
  "Public downloads": "公开下载",
  Apps: "应用",
  Analytics: "统计",
  Builds: "构建",
  "Android distribution": "Android 分发",
  TestFlight: "TestFlight",
  "App Store": "App Store",
  "QA artifacts": "测试文件",
  Releases: "发布",
  "Release shares": "发布分享",
  Feedback: "反馈",
  Organizations: "组织",
  Invites: "邀请",
  Webhooks: "Webhook",
  Channels: "渠道",
  "Product types": "产品类型",
  "Release types": "发布类型",
  "App access": "应用访问权限",
  Audit: "审计",
  Operations: "操作",
};

export function localizeOpenApi<T>(document: T): T {
  const result = structuredClone(document);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(object)) {
      // Example payloads are API data and must never be translated.
      if (key === "example" || key === "examples" || key === "default" || key === "enum") continue;
      if ((key === "summary" || key === "description") && typeof item === "string") {
        object[key] = OPENAPI_ZH[item] ?? item;
      } else if (key === "tags" && Array.isArray(item) && item.every((tag) => typeof tag === "string")) {
        object[key] = item.map((tag: string) => OPENAPI_TAG_ZH[tag] ?? tag);
      } else {
        visit(item);
      }
    }
  };
  visit(result);
  const root = result as { tags?: Array<{ name: string }> };
  for (const tag of root.tags ?? []) tag.name = OPENAPI_TAG_ZH[tag.name] ?? tag.name;
  return result;
}
