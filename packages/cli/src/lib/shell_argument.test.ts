import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellArgument } from "./shell_argument.js";

describe("shellArgument", () => {
  it("quotes shell metacharacters and leaves safe arguments unquoted", () => {
    expect(shellArgument("")).toBe("''");
    expect(shellArgument("a b")).toBe("'a b'");
    expect(shellArgument("it's")).toBe("'it'\\''s'");
    expect(shellArgument("$(printf injected)")).toBe("'$(printf injected)'");
    expect(shellArgument("build.example")).toBe("build.example");
  });

  it.skipIf(process.platform === "win32")("round-trips unusual arguments in a POSIX shell without evaluating them", () => {
    const values = ["", "build1", "a b", "it's", 'a"b', "a\nb", "$(printf injected)", "semi;colon", "*", "-flag", "λ"];
    for (const value of values) {
      const actual = execFileSync("sh", ["-c", `printf %s ${shellArgument(value)}`], { encoding: "utf8" });
      expect(actual).toBe(value);
    }
  });
});
