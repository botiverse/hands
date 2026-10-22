import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const APP_ID = "11111111-2222-3333-4444-555555555555";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async () => ({
      token: "dt_secret_once",
      deploy_token: { id: "dt-1", name: "ci", app_role: "publisher", expires_at: null },
    }) as never,
  };
});

async function run(argv: string[]): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const { registerDeployTokenCommands } = await import("./deploy_tokens.js");
  const program = new Command();
  program.exitOverride();
  registerDeployTokenCommands(program);
  await program.parseAsync(["node", "hands", ...argv]);
  return lines;
}

describe("deploy-tokens create --json", () => {
  it("emits parseable JSON and nothing else on stdout", async () => {
    // #167 reported this flag being ignored in a published build. Whether it works
    // cannot be judged by reading the handler -- today a flag was declared, typed and
    // silently shadowed by a global registration (#793). So this asserts the OUTPUT.
    const lines = await run(["deploy-tokens", "create", APP_ID, "--name", "ci", "--json"]);
    const joined = lines.join("\n");
    expect(() => JSON.parse(joined)).not.toThrow();
    expect(JSON.parse(joined).deploy_token.id).toBe("dt-1");
    // A human-readable line mixed in would break every consumer that pipes stdout.
    expect(joined).not.toContain("Store it now");
    vi.restoreAllMocks();
  });

  it("still prints human text without --json", async () => {
    const lines = await run(["deploy-tokens", "create", APP_ID, "--name", "ci"]);
    const joined = lines.join("\n");
    expect(() => JSON.parse(joined)).toThrow();
    expect(joined.toLowerCase()).toContain("deploy token");
    vi.restoreAllMocks();
  });
});
