// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarkdownText } from "./MarkdownText.js";

afterEach(cleanup);

// Warm the lazily imported renderer once: on a cold CI cache the first
// transform of the markdown stack can take longer than the default 1s
// waitFor timeout, which made the first test flaky while the later tests
// (module cached) passed.
beforeAll(async () => {
  await import("./MarkdownRenderer.js");
}, 20_000);

const RICH = [
  "**bold** and _em_ and `inline`",
  "",
  "- one",
  "- two",
  "",
  "> quoted",
  "",
  "[link](https://example.com/docs)",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
].join("\n");

describe("MarkdownText", () => {
  it("renders the common markdown features once the chunk loads", async () => {
    const { container } = render(<MarkdownText source={RICH} />);
    await waitFor(() => expect(container.querySelector("strong")).toBeTruthy(), {
      timeout: 5_000,
    });
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("em");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelector("blockquote")).toBeTruthy();
    expect(container.querySelector("code")?.textContent).toBe("inline");
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll("table td")).toHaveLength(2);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noreferrer");
  });

  it("keeps single newlines (chat semantics)", async () => {
    const { container } = render(<MarkdownText source={"line one\nline two"} />);
    await waitFor(() => expect(container.querySelector("br")).toBeTruthy(), {
      timeout: 5_000,
    });
    expect(container.textContent).toContain("line one");
    expect(container.textContent).toContain("line two");
  });

  it("strips script tags and javascript: links", async () => {
    const { container } = render(
      <MarkdownText
        source={"<script>alert(1)</script>\n\n[boom](javascript:alert(1))"}
      />,
    );
    // Wait for a renderer-only marker (the anchor the markdown parser
    // produces): the plain-text fallback also contains "boom", so waiting on
    // the text alone would make the script/javascript: assertions run against
    // the fallback, which trivially has no script.
    await waitFor(() => expect(container.querySelector("div a")).toBeTruthy(), {
      timeout: 5_000,
    });
    expect(container.textContent).toContain("boom");
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.innerHTML).not.toContain("alert(1)");
  });

  it("does not pass raw HTML through", async () => {
    const { container } = render(
      <MarkdownText source={"<b>raw</b> <img src=x onerror=1>"} />,
    );
    await waitFor(() => expect(container.querySelector("div")).toBeTruthy());
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders markdown images as links (attachments own real images)", async () => {
    const { container } = render(
      <MarkdownText source={"![screenshot](https://example.com/shot.png)"} />,
    );
    await waitFor(() => expect(container.querySelector("a")).toBeTruthy(), {
      timeout: 5_000,
    });
    expect(container.querySelector("img")).toBeNull();
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("screenshot");
    expect(link?.getAttribute("href")).toBe("https://example.com/shot.png");
  });

  it("survives empty and CRLF input", async () => {
    const { container: empty } = render(<MarkdownText source={""} />);
    await waitFor(() => expect(empty.querySelector("div")).toBeTruthy());
    expect(empty.textContent).toBe("");
    const { container: crlf } = render(<MarkdownText source={"a\r\nb"} />);
    await waitFor(() => expect(crlf.querySelector("div")).toBeTruthy());
    expect(crlf.textContent).toContain("a");
    expect(crlf.textContent).toContain("b");
  });

  it("renders fenced code as a block", async () => {
    const { container } = render(
      <MarkdownText source={"```js\nconst x = 1;\n```"} />,
    );
    await waitFor(() => expect(container.querySelector("pre")).toBeTruthy(), {
      timeout: 5_000,
    });
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("const x = 1;");
    expect(pre?.querySelector("code")).toBeTruthy();
  });
});
