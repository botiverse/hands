import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellArgument } from "./shell_argument.js";

describe("shellArgument", () => {
  it("round-trips unusual argument bytes in a POSIX shell without evaluating them", () => {
    const values = ["", "build1", "a b", "it's", 'a"b', "a\nb", "$(printf injected)", "semi;colon", "*", "-flag", "λ"];
    for (const value of values) {
      const actual = execFileSync("sh", ["-c", `printf %s ${shellArgument(value)}`], { encoding: "utf8" });
      expect(actual).toBe(value);
    }
    expect(shellArgument("build.example")).toBe("build.example");
  });
});
