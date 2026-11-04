import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import translations from "./apiError-zh.json";
import { errorMessage } from "./errorMessage";

const catalog: Readonly<Record<string, string>> = translations;

describe("error display localization", () => {
  it("translates known errors without changing their original message, body, or diagnostic code", () => {
    const error = Object.assign(new Error("release revision conflict"), {
      body: { code: "RELEASE_REVISION_CONFLICT", revision: 8 },
    });
    expect(errorMessage(error, "zh-CN")).toBe("发布修订号冲突（RELEASE_REVISION_CONFLICT）");
    expect(errorMessage(error, "en")).toBe("release revision conflict");
    expect(error.message).toBe("release revision conflict");
    expect(error.body).toEqual({ code: "RELEASE_REVISION_CONFLICT", revision: 8 });
  });

  it("preserves unknown provider diagnostics and localizes generic network failures", () => {
    const provider = "provider: request 123 could not be classified";
    expect(errorMessage(new Error(provider), "zh-CN")).toBe(provider);
    expect(errorMessage(new Error("Failed to fetch"), "zh-CN")).toBe("网络请求失败");
    expect(errorMessage(new Error("upload failed 503"), "zh-CN")).toBe("请求失败（HTTP 503）");
    expect(errorMessage("__proto__", "zh-CN")).toBe("__proto__");
    expect(errorMessage('{"error":"invite not found","code":"not_found"}', "zh-CN")).toBe("未找到邀请（not_found）");
    expect(errorMessage('{"error":"invite not found","detail":"raw"}', "zh-CN")).toBe('{"error":"invite not found","detail":"raw"}');
  });

  it("has translations for static server error strings", () => {
    const worker = fileURLToPath(new URL("../../../worker/src", import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
    const missing = new Set<string>();
    for (const path of files(worker)) {
      const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name.getText(file).replace(/["']/g, "") === "error" && ts.isStringLiteral(node.initializer)) {
          const value = node.initializer.text;
          if (/[a-zA-Z]/.test(value) && !Object.hasOwn(catalog, value)) missing.add(value);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect([...missing].sort()).toEqual([]);
  });
});
