import { describe, expect, it } from "vitest";
import { escapeCardText, renderRaftCardAsText } from "../src/lib/raft_card_text";

describe("renderRaftCardAsText follows Raft's card-to-markdown rules", () => {
  it("writes header, column blocks, row lines and every element kind", () => {
    const text = renderRaftCardAsText({
      header: { title: "Build 1.2 *beta*", subtitle: "main · 42", tags: [{ text: "Failed" }, { text: "CI" }] },
      root: "root",
      elements: {
        root: { type: "Stack", props: { direction: "column" }, children: ["warn", "row", "fields", "div", "md", "dur", "open"] },
        warn: { type: "Text", props: { text: "Check _this_", tone: "warning" } },
        row: { type: "Stack", props: { direction: "row" }, children: ["sha", "badge", "inrowmd", "time"] },
        sha: { type: "Text", props: { text: "abc`123", mono: true } },
        badge: { type: "Badge", props: { text: "Done", tone: "done" } },
        inrowmd: { type: "Markdown", props: { content: "**own block**" } },
        time: { type: "RelativeTime", props: { at: "2026-11-03T12:03:00.500Z" } },
        fields: { type: "Fields", props: { items: [{ label: "Version", value: "1.20.0 (12000003)", mono: true }, { label: "By", value: "@alice" }] } },
        div: { type: "Divider", props: {} },
        md: { type: "Markdown", props: { content: "- one\n- **two**" } },
        dur: { type: "Duration", props: { start: "2026-11-03T12:00:00Z" } },
        open: { type: "Button", props: { label: "Open [run]", action: { kind: "navigate", url: "https://example.test/run/1" } } },
      },
    });
    expect(text).toBe([
      "**Build 1.2 \\*beta\\***",
      "main · 42",
      "[Failed] [CI]",
      "",
      "⚠️ Check \\_this\\_",
      "",
      "``abc`123`` · [Done]",
      "",
      "**own block**",
      "",
      "2026-11-03 12:03:00Z",
      "",
      "**Version:** `1.20.0 (12000003)`",
      "**By:** `@alice`",
      "",
      "---",
      "",
      "- one\n- **two**",
      "",
      "2026-11-03 12:00:00Z –",
      "",
      "[Open \\[run\\]](https://example.test/run/1)",
    ].join("\n"));
  });

  it("pairs a single earlier state with the tag as [before] -> [after]", () => {
    const card = { header: { title: "T", tags: [{ text: "Upload processed" }] }, root: "r", elements: { r: { type: "Stack", children: [] } } };
    expect(renderRaftCardAsText(card, { transitionFrom: "Processing upload" })).toBe("**T**\n[Processing upload] -> [Upload processed]");
    expect(renderRaftCardAsText(card)).toBe("**T**\n[Upload processed]");
  });

  it("escapes markdown and defuses mentions in plain card text", () => {
    expect(escapeCardText("a_b *c* [d](e) <x> `f` ~g~ | @bob, mail@host")).toBe(
      "a\\_b \\*c\\* \\[d\\](e) \\<x\\> \\`f\\` \\~g\\~ \\| `@bob`, mail@host");
  });

  it("does not loop on a card that references itself", () => {
    const text = renderRaftCardAsText({ root: "r", elements: { r: { type: "Stack", children: ["r", "t"] }, t: { type: "Text", props: { text: "x" } } } });
    expect(text).toBe("x");
  });
});
