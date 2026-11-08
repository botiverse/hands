import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { recoveryGuidance } from "./recovery_guidance.js";

const app = "11111111-2222-3333-4444-555555555555";
const parts = (id: string) => ["--" as const, { field: "appId" as const, value: app }, { field: "submissionId" as const, value: id }];

describe("recoveryGuidance", () => {
  it("provides a literal, option-safe command for ordinary identifiers", () => {
    expect(recoveryGuidance("agc status", parts("submission_1-2"))).toBe(`hands agc status -- ${app} submission_1-2`);
    expect(recoveryGuidance("builds testflight-status", [
      "--distribution", { field: "distribution", value: "external" },
      "--bundle-id", { field: "bundleId", value: "build.example" },
      "--", { field: "appId", value: app }, { field: "buildId", value: "build1" },
    ])).toBe(`hands builds testflight-status --distribution external --bundle-id build.example -- ${app} build1`);
  });

  it("prints unsafe identifiers only as escaped JSON data, never as a copyable command", () => {
    const values = ["", "-flag", "build one", "it's", 'a"b', "a\nb", "\u001b[31m", "$(touch marker)", "`id`", "%PATH%", "a&b", "a;b", "a|b", "a/b", "*", "λ", "\u202E"];
    for (const value of values) {
      const guidance = recoveryGuidance("agc status", parts(value));
      expect(guidance).toContain("template only, not an executable command");
      expect(guidance).toContain("hands agc status -- {appId} {submissionId}");
      expect(guidance).toContain("JSON strings are data, not shell syntax");
      const data = JSON.parse(guidance.slice(guidance.lastIndexOf(": {") + 2));
      expect(data).toEqual({ appId: app, submissionId: value });
      expect(guidance).toMatch(/^[\x20-\x7e]*$/);
      if (value && value !== "-flag") expect(guidance).not.toContain(value);
    }
  });

  it.skipIf(process.platform === "win32")("passes ordinary values unchanged through a POSIX shell", () => {
    const command = recoveryGuidance("agc status", parts("submission_1-2"));
    const result = JSON.parse(execFileSync("sh", ["-c", `hands() { node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "$@"; }; ${command}`], { encoding: "utf8" }));
    expect(result).toEqual(["agc", "status", "--", app, "submission_1-2"]);
  });

  it.skipIf(process.platform !== "win32")("passes ordinary values unchanged through PowerShell and cmd.exe", () => {
    const command = recoveryGuidance("agc status", parts("submission_1-2"));
    const script = "console.log(JSON.stringify(process.argv.slice(1)))";
    const nativeCommand = command.replace(/^hands /, "& $env:NODE_EXE -e $env:TEST_SCRIPT ");
    const powershell = execFileSync("powershell.exe", ["-NoProfile", "-Command", nativeCommand], {
      encoding: "utf8", env: { ...process.env, NODE_EXE: process.execPath, TEST_SCRIPT: script },
    });
    expect(JSON.parse(powershell)).toEqual(["agc", "status", "--", app, "submission_1-2"]);
    const cmd = execFileSync("cmd.exe", ["/d", "/v:off", "/c", command.replace(/^hands /, "node -p process.argv.slice(1).join(',') ")], {
      encoding: "utf8", env: process.env,
    });
    expect(cmd.trim()).toBe(`agc,status,--,${app},submission_1-2`);
  });
});
