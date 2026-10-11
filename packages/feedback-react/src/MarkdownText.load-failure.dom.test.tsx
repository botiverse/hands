// @vitest-environment jsdom

// Regression for the on-demand chunk failing to load: the dynamic import
// rejects, the boundary catches it, and the text still renders as plain
// text (never blank). The renderer module factory throws to simulate a
// failed chunk fetch.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./MarkdownRenderer.js", () => {
  throw new Error("chunk load failed");
});

import { MarkdownText } from "./MarkdownText.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownText load failure", () => {
  it("falls back to plain text when the chunk fails to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <MarkdownText source={"# still here\ntext"} />,
    );
    await waitFor(() => expect(container.textContent).toContain("still here"));
    expect(container.textContent).toContain("text");
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
    error.mockRestore();
  });
});
