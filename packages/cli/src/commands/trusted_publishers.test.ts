import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { exchangeGithubOidcToken, registerTrustedPublisherCommands, requestGithubOidcToken } from "./trusted_publishers.js";
import { setApiBase } from "../lib/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("github-oidc-login", () => {
  it("requests a token for the Hands origin and exports the exchanged token masked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hands-oidc-"));
    const githubEnv = join(dir, "env");
    writeFileSync(githubEnv, "");
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://runtime.example/token?api-version=2.0");
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "runtime-secret");
    vi.stubEnv("GITHUB_ENV", githubEnv);
    setApiBase("https://hands.example.test/");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://runtime.example/")) {
        return new Response(JSON.stringify({ value: "github.jwt.value" }));
      }
      return new Response(JSON.stringify({
        token: "qvdt_abc_secret", token_prefix: "qvdt_abc", expires_at: 1_800_000_000_000,
        app_id: "app", app_slug: "raft-deck", app_role: "publisher",
      }), { status: 201 });
    }));
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => { out.push(line); });

    const program = new Command();
    program.exitOverride();
    registerTrustedPublisherCommands(program);
    await program.parseAsync(["node", "hands", "github-oidc-login", "--app", "raft-deck"]);

    const tokenRequest = new URL(calls[0]!.url);
    expect(tokenRequest.searchParams.get("audience")).toBe("https://hands.example.test");
    expect(tokenRequest.searchParams.get("api-version")).toBe("2.0");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("bearer runtime-secret");
    expect(calls[1]!.url).toBe("https://hands.example.test/public/v2/oidc/github/token");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ app: "raft-deck", token: "github.jwt.value" });
    // The mask comes before anything else that could echo the token.
    expect(out[0]).toBe("::add-mask::qvdt_abc_secret");
    expect(out.slice(1).join("\n")).not.toContain("qvdt_abc_secret");
    expect(readFileSync(githubEnv, "utf8")).toBe("HANDS_BEARER_TOKEN=qvdt_abc_secret\n");
  });

  it("explains a missing id-token permission and surfaces the server's mismatch", async () => {
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "");
    await expect(requestGithubOidcToken("https://hands.example.test")).rejects.toThrow(/id-token: write/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "no trusted publisher on this app matches this workflow run",
      code: "github_oidc_no_trusted_publisher",
      mismatch: ["ref"],
      workflow_ref: "o/r/.github/workflows/x.yml@refs/heads/dev",
    }), { status: 403 })));
    await expect(exchangeGithubOidcToken("raft-deck", "jwt", "https://hands.example.test"))
      .rejects.toThrow(/github_oidc_no_trusted_publisher.*mismatch: ref.*refs\/heads\/dev/);
  });
});
