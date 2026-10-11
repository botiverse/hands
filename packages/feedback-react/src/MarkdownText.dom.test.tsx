// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownText } from "./MarkdownText.js";

afterEach(cleanup);

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
    await waitFor(() => expect(container.querySelector("strong")).toBeTruthy());
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
    await waitFor(() => expect(container.querySelector("br")).toBeTruthy());
    expect(container.textContent).toContain("line one");
    expect(container.textContent).toContain("line two");
  });

  it("strips script tags and javascript: links", async () => {
    const { container } = render(
      <MarkdownText
        source={"<script>alert(1)</script>\n\n[boom](javascript:alert(1))"}
      />,
    );
    await waitFor(() => expect(container.textContent).toContain("boom"));
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
    await waitFor(() => expect(container.querySelector("a")).toBeTruthy());
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
    await waitFor(() => expect(container.querySelector("pre")).toBeTruthy());
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("const x = 1;");
    expect(pre?.querySelector("code")).toBeTruthy();
  });
});
