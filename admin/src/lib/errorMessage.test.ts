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

  it("localizes the Duo write safety error while preserving its diagnostic code", () => {
    const error = Object.assign(new Error("Duo screenshot writes are not verified"), {
      body: { code: "DUO_WRITE_UNVERIFIED" },
    });
    expect(errorMessage(error, "zh-CN")).toBe("尚未验证 iPhone Duo 截图写入操作（DUO_WRITE_UNVERIFIED）");
    expect(errorMessage(error, "en")).toBe("Duo screenshot writes are not verified");
    expect(error.body).toEqual({ code: "DUO_WRITE_UNVERIFIED" });
  });

  it("distinguishes lock recovery before and after an App Information write", () => {
    const before = Object.assign(new Error("no write was dispatched, but operation lock acquisition could not be confirmed; inspect the lock before retrying"), { body: { code: "APP_INFO_RECOVERY_REQUIRED" } });
    const after = Object.assign(new Error("a write was dispatched, but operation lock release could not be confirmed; inspect Apple and the lock before retrying"), { body: { code: "APP_INFO_RECOVERY_REQUIRED" } });
    expect(errorMessage(before, "zh-CN")).toBe("未发送写入请求，但无法确认是否取得操作锁；请先检查锁再重试（APP_INFO_RECOVERY_REQUIRED）");
    expect(errorMessage(after, "zh-CN")).toBe("已发送写入请求，但无法确认是否释放操作锁；请先检查 Apple 数据和锁再重试（APP_INFO_RECOVERY_REQUIRED）");
    expect(errorMessage(before, "en")).toBe(before.message);
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
