import { describe, expect, it, vi } from "vitest";
import { openApiDocument } from "../src/openapi";
import { localizeOpenApi, OPENAPI_TAG_ZH, OPENAPI_ZH } from "../src/openapi_locale";

vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: () => { throw new Error("unused"); } }));
import worker from "../src/index";

const env = {} as never;
const context = { waitUntil() {}, passThroughOnException() {} } as never;
const request = (path: string, headers?: Record<string, string>) =>
  worker.fetch(new Request(`https://hands.example${path}`, headers ? { headers } : {}), env, context);

describe("localized OpenAPI", () => {
  it("covers every reference description and preserves the rest of the contract", () => {
    const zh = localizeOpenApi(openApiDocument);
    let prose = 0;
    let operationTags = 0;
    const compare = (before: unknown, after: unknown, path = ""): void => {
      if (Array.isArray(before)) {
        expect(Array.isArray(after), path).toBe(true);
        expect((after as unknown[]).length, path).toBe(before.length);
        before.forEach((entry, i) => compare(entry, (after as unknown[])[i], `${path}/${i}`));
      } else if (before && typeof before === "object") {
        expect(after && typeof after === "object", path).toBeTruthy();
        const original = before as Record<string, unknown>;
        const localized = after as Record<string, unknown>;
        expect(Object.keys(localized).sort(), path).toEqual(Object.keys(original).sort());
        for (const [key, value] of Object.entries(original)) {
          const here = `${path}/${key}`;
          if (key === "example" || key === "examples" || key === "default" || key === "enum") {
            expect(localized[key], here).toEqual(value);
          } else if ((key === "summary" || key === "description") && typeof value === "string") {
            expect(OPENAPI_ZH[value], here).toBeDefined();
            expect(localized[key], here).toBe(OPENAPI_ZH[value]);
            expect(localized[key], here).not.toBe(value);
            // API identifiers, code and examples in backticks must survive translation.
            expect((localized[key] as string).match(/`[^`]+`/g) ?? [], here).toEqual(value.match(/`[^`]+`/g) ?? []);
            prose++;
          } else if (key === "tags" && Array.isArray(value) && value.every((tag) => typeof tag === "string")) {
            for (const tag of value) expect(OPENAPI_TAG_ZH[tag], `${here}/${tag}`).toBeDefined();
            expect(localized[key], here).toEqual(value.map((tag) => OPENAPI_TAG_ZH[tag]));
            operationTags++;
          } else if (/^\/tags\/\d+$/.test(path) && key === "name" && typeof value === "string") {
            expect(OPENAPI_TAG_ZH[value], here).toBeDefined();
            expect(localized[key], here).toBe(OPENAPI_TAG_ZH[value]);
          } else compare(value, localized[key], here);
        }
      } else expect(after, path).toEqual(before);
    };
    compare(openApiDocument, zh);
    expect(prose).toBeGreaterThan(1000);
    expect(operationTags).toBeGreaterThan(100);
  });

  it("does not translate example, default or enum data even when it resembles documentation", () => {
    const doc = { description: "Health status.", example: { description: "Health status." }, default: { description: "Health status." }, enum: ["Health status."] };
    expect(localizeOpenApi(doc)).toEqual({ ...doc, description: "健康状态。" });
    expect(doc.description).toBe("Health status.");
  });

  it("serves localized browser UI and leaves the default machine document English", async () => {
    const page = await request("/api-docs", { cookie: "hands_locale=zh-CN" });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect(page.headers.get("vary")).toContain("*");
    const html = await page.text();
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("/openapi.json?lang=zh-CN");
    expect(html).toContain("locale: 'zh-CN'");
    expect(html).toContain('/api-docs?lang=en');
    expect(html).toContain('/api-docs?lang=zh-CN');
    const enPage = await request("/api-docs?lang=en", { cookie: "hands_locale=zh-CN" });
    expect(await enPage.text()).toContain('<html lang="en">');
    const normal = await request("/openapi.json", { cookie: "hands_locale=zh-CN", "accept-language": "zh-CN" });
    const english = await normal.json() as typeof openApiDocument;
    expect(english.info.description).toBe(openApiDocument.info.description);
    const chineseResponse = await request("/openapi.json?lang=zh-CN");
    const chinese = await chineseResponse.json() as typeof openApiDocument;
    expect(chinese.info.description).toBe(OPENAPI_ZH[openApiDocument.info.description!]);
    expect(chinese.paths?.["/health"]?.get?.summary).toBe("Worker 健康检查");
    expect(chinese.servers?.[0]?.url).toBe("https://hands.example");
  });
});
