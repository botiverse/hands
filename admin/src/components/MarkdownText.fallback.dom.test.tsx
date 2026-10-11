// @vitest-environment jsdom

// Regression for the error-boundary fallback (gzj review note): when the
// markdown renderer throws, the component must fall back to plain text
// instead of blanking the page. The renderer module is mocked to throw.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-markdown", () => ({
  default: () => {
    throw new Error("renderer boom");
  },
}));

import { MarkdownText } from "./MarkdownText";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarkdownText fallback", () => {
  it("falls back to plain text when the renderer throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // React also logs the caught error to console.error; keep the output clean.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <MarkdownText source={"*still* readable\ntext"} />,
    );
    expect(container.textContent).toContain("*still* readable");
    expect(container.textContent).toContain("text");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
