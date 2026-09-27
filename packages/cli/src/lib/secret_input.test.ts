import { describe, expect, it } from "vitest";
import { feedSecretChunk, normalizeToken } from "./secret_input.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig_part-1";

function feed(chunks: string[]) {
  let buf = "";
  for (const c of chunks) {
    const r = feedSecretChunk(buf, c);
    if (r.kind !== "continue") return r;
    buf = r.value;
  }
  return { kind: "continue" as const, value: buf };
}

describe("hidden secret input", () => {
  it("accepts a paste split across chunks and ends on Enter", () => {
    expect(feed([JWT.slice(0, 20), JWT.slice(20), "\r"])).toEqual({ kind: "done", value: JWT });
  });

  it("ends at the first newline inside a chunk instead of storing it", () => {
    expect(feed([`${JWT}\n`])).toEqual({ kind: "done", value: JWT });
    expect(feed([`${JWT}\r\ngarbage`])).toEqual({ kind: "done", value: JWT });
  });

  it("strips bracketed-paste markers and stray control characters", () => {
    expect(feed([`\u001b[200~${JWT}\u001b[201~`, "\r"])).toEqual({ kind: "done", value: JWT });
    expect(feed([`${JWT.slice(0, 5)}\u0001\u001b${JWT.slice(5)}`, "\n"])).toEqual({ kind: "done", value: JWT });
  });

  it("handles backspace and Ctrl+C", () => {
    expect(feed([`${JWT}x`, "\u007f", "\r"])).toEqual({ kind: "done", value: JWT });
    expect(feed(["abc", "\u0003"])).toEqual({ kind: "cancel" });
  });

  it("normalizes whitespace and rejects anything that is not a compact JWT", () => {
    expect(normalizeToken(`  ${JWT}\n`)).toEqual({ token: JWT });
    expect(normalizeToken(`${JWT.slice(0, 10)} ${JWT.slice(10)}`)).toEqual({ token: JWT });
    expect("error" in normalizeToken(`${JWT}*`)).toBe(true);
    expect("error" in normalizeToken("")).toBe(true);
    expect("error" in normalizeToken("not-a-jwt")).toBe(true);
  });
});

describe("config clearing", () => {
  it("clearConfig actually removes the saved credentials", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "hands-cfg-"));
    const prev = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const cfg = await import("./config.js");
      cfg.saveConfig({ apiBase: "https://hands.build", authToken: "a.b.c", sessionCookie: "s" });
      cfg.clearConfig();
      const onDisk = JSON.parse(readFileSync(cfg.configPath(), "utf8"));
      expect(onDisk).toEqual({ apiBase: "https://hands.build" });
      expect(cfg.getConfig().authToken).toBeUndefined();
    } finally {
      process.env.HOME = prev.HOME;
      if (prev.XDG !== undefined) process.env.XDG_CONFIG_HOME = prev.XDG;
    }
  });
});
