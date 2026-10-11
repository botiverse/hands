// @vitest-environment jsdom

// Regression for the error-boundary fallback: when the markdown renderer
// throws, the component must fall back to plain text instead of blanking the
// page. The renderer module is mocked to throw while rendering.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./MarkdownRenderer.js", () => ({
  default: () => {
    throw new Error("renderer boom");
  },
}));

import { MarkdownText } from "./MarkdownText.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownText fallback", () => {
  it("falls back to plain text when the renderer throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // React also logs the caught error to console.error; keep the output clean.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <MarkdownText source={"*still* readable\ntext"} />,
    );
    await waitFor(() =>
      expect(container.textContent).toContain("*still* readable"),
    );
    expect(container.textContent).toContain("text");
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
    error.mockRestore();
  });
});
